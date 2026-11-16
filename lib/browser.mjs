// The browser the checks drive: the puppeteer and pa11y that pa11y-ci itself
// runs, the environment a caller-supplied browser starts in, and the check that
// a caller-supplied browser is the revision that puppeteer expects.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { delimiter, isAbsolute } from "node:path";

// The state pass drives the puppeteer and pa11y that pa11y-ci itself runs, so
// the resting and state passes share one browser revision and one axe-core.
const localRequire = createRequire(import.meta.url);
export const requireFromPa11yCi = createRequire(
  localRequire.resolve("pa11y-ci/package.json"),
);

export function puppeteerBrowserRevision() {
  const requireFromPuppeteer = createRequire(
    requireFromPa11yCi.resolve("puppeteer/package.json"),
  );
  const { PUPPETEER_REVISIONS } = requireFromPuppeteer(
    "puppeteer-core/internal/revisions.js",
  );
  return PUPPETEER_REVISIONS["chrome-headless-shell"];
}

// `system_macos` runs the browser on the host's own libraries. `declared_linux`
// puts exactly the library directories and Fontconfig file given on
// LD_LIBRARY_PATH and FONTCONFIG_FILE, so they are searched first; the dynamic
// loader's own cache and default directories still apply after them.
export function browserEnvironment(
  { mode, libraryDirs = [], fontconfig },
  baseEnvironment = process.env,
) {
  const env = { ...baseEnvironment };
  if (mode === "system_macos") {
    if (libraryDirs.length !== 0 || fontconfig !== undefined) {
      throw new Error("system_macos browser runtime cannot carry Linux inputs");
    }
    delete env.LD_LIBRARY_PATH;
    delete env.FONTCONFIG_FILE;
    return env;
  }
  if (mode !== "declared_linux") {
    throw new Error(`unsupported browser runtime mode: ${mode}`);
  }
  if (
    libraryDirs.length === 0 ||
    libraryDirs.some((path) => !isAbsolute(path)) ||
    typeof fontconfig !== "string" ||
    !isAbsolute(fontconfig)
  ) {
    throw new Error(
      "declared_linux browser runtime requires absolute libraries and Fontconfig",
    );
  }
  env.LD_LIBRARY_PATH = libraryDirs.join(delimiter);
  env.FONTCONFIG_FILE = fontconfig;
  return env;
}

export function browserVersion(browserPath, expectedRevision, browserEnv) {
  const result = spawnSync(browserPath, ["--version"], {
    encoding: "utf8",
    env: browserEnv,
  });
  if (result.error) {
    throw new Error(
      `declared browser failed to start: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.signal) {
    throw new Error(
      `declared browser version probe terminated by ${result.signal}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `declared browser version probe exited with status ${result.status}: ${result.stderr.trim()}`,
    );
  }
  const reportedVersion = result.stdout.trim();
  // A whole word of the output, not a substring: 140.0.7339.8 is a substring
  // of 140.0.7339.80.
  if (!reportedVersion.split(/\s+/).includes(expectedRevision)) {
    throw new Error(
      `declared browser reports ${reportedVersion}, expected ${expectedRevision}`,
    );
  }
  return reportedVersion;
}
