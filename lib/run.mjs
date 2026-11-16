// One accessibility run over a built site: serve it, run pa11y-ci's resting
// pass and then the forced-state pass over every page, and return the merged
// report with the host load and timing around it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pa11yCi from "pa11y-ci";
import { captureHostSnapshot, mergeStateResults } from "./report.mjs";
import {
  DEFAULT_ROUTING,
  findHtmlFiles,
  pagePath,
  startStaticServer,
} from "./site.mjs";
import { runStateChecks } from "./state-pass.mjs";

export const DEFAULT_WWW_DIR = "www";
export const DEFAULT_CONFIG_PATH = ".pa11yci.json";

// The pa11y-ci configuration a run uses: the file's `defaults` (or the whole
// file when it has none), a launch timeout unless the file sets one, and a
// caller-supplied browser. A per-URL configuration is not read: every page is
// checked under the defaults, so `ignore` there is a global allowlist.
export function runConfig(
  configBase,
  { browserPath, browserEnv, profileDir } = {},
) {
  const config = structuredClone(configBase.defaults ?? configBase);
  // Chromium starts on CPUs other jobs share, and a saturated CI host kept it
  // from printing its endpoint within Puppeteer's default launch timeout. A
  // site's own config can still set its own.
  config.chromeLaunchConfig = {
    timeout: 120_000,
    ...(config.chromeLaunchConfig ?? {}),
  };
  if (browserPath) {
    config.chromeLaunchConfig = {
      ...config.chromeLaunchConfig,
      executablePath: browserPath,
      env: browserEnv,
      userDataDir: profileDir,
    };
  }
  return config;
}

export async function runChecks({
  wwwDir = DEFAULT_WWW_DIR,
  configPath = DEFAULT_CONFIG_PATH,
  routing = DEFAULT_ROUTING,
  browserPath,
  browserEnv,
  profileDir,
} = {}) {
  const siteDir = resolve(wwwDir);
  const config = runConfig(
    JSON.parse(readFileSync(resolve(configPath), "utf8")),
    { browserPath, browserEnv, profileDir },
  );
  const { server, baseUrl } = await startStaticServer(siteDir, { routing });
  try {
    const urls = findHtmlFiles(siteDir).map(
      (filepath) => baseUrl + pagePath(filepath, siteDir, routing),
    );
    const log = { info: console.log, error: console.error, debug: () => {} };
    const hostSnapshotStart = captureHostSnapshot();
    const startedAt = performance.now();
    const report = await pa11yCi(urls, config, { log });
    mergeStateResults(report, await runStateChecks(urls, config));
    const elapsedMs = Math.round(performance.now() - startedAt);
    const hostSnapshotEnd = captureHostSnapshot();
    return { report, baseUrl, hostSnapshotStart, hostSnapshotEnd, elapsedMs };
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
  }
}
