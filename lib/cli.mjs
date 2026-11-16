// The command line: reads the options, runs the checks, prints the report,
// writes the failure record or the check result, and fails the process for
// anything that did not pass.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  browserEnvironment,
  browserVersion,
  puppeteerBrowserRevision,
} from "./browser.mjs";
import {
  buildCheckResult,
  buildFailureDiagnostics,
  printReport,
  runFailed,
} from "./report.mjs";
import { runChecks } from "./run.mjs";

// Written only when a run fails, so green runs leave nothing behind.
export const DEFAULT_DIAGNOSTICS_DIR = "a11y-diagnostics";

export const USAGE = `Usage: static-a11y-check [options]

Checks every .html page under a built site with pa11y-ci (axe), then scores
color contrast again with :hover and :focus-visible forced on every
interactive element. Exits non-zero if any page has an error or could not be
checked.

Options:
  --www-dir <dir>          Site root to serve (default: www)
  --config <file>          pa11y-ci configuration (default: .pa11yci.json)
  --routing <name>         cloudflare (default): /foo serves foo.html, /foo/
                           serves foo/index.html, and pages are checked at
                           those URLs. files: pages are checked at their own
                           file paths.
  --diagnostics-dir <dir>  Where a failing run writes its record
                           (default: a11y-diagnostics)
  --output <file>          Write a JSON check result on a passing run
  --browser <path>         Run this browser instead of puppeteer's own
  --browser-manifest <file>
                           JSON whose "version" is the browser revision;
                           required with --browser, and must match puppeteer's
  --browser-runtime-mode <mode>
                           system_macos or declared_linux; required with
                           --browser
  --browser-library-dir <dir>
                           A library directory for declared_linux (repeatable)
  --browser-fontconfig <file>
                           The Fontconfig file for declared_linux
  --profile-dir <dir>      Browser profile directory for --browser
  -h, --help               Show this help
`;

// Persists the failure record, and echoes the host and timing headline to the
// log, which CI always keeps, so classifying a failure as a flake needs no
// diagnostic re-run. Keyed on the GitHub Actions run id and attempt, so a
// re-run's record sits beside the original rather than overwriting it.
function writeFailureDiagnostics(diagnostics, dir) {
  const runId = process.env.GITHUB_RUN_ID ?? "local";
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "0";
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `a11y-failure-${runId}-${attempt}.json`);
  writeFileSync(file, JSON.stringify(diagnostics, null, 2));
  const fmt = (la) => la.map((n) => n.toFixed(2)).join(" ");
  const { start, end } = diagnostics.host;
  console.log(
    `\nFailure diagnostics -> ${file}\n` +
      `  elapsed ${diagnostics.elapsedMs} ms over ${diagnostics.urls.total} URLs\n` +
      `  loadavg start [${fmt(start.loadavg)}] -> end [${fmt(end.loadavg)}] over ${end.cpus} CPUs\n` +
      `  free mem start ${start.freeMemMB} MB -> end ${end.freeMemMB} MB of ${end.totalMemMB} MB`,
  );
}

export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      "www-dir": { type: "string" },
      config: { type: "string" },
      routing: { type: "string" },
      browser: { type: "string" },
      "browser-manifest": { type: "string" },
      "browser-runtime-mode": { type: "string" },
      "browser-library-dir": { type: "string", multiple: true },
      "browser-fontconfig": { type: "string" },
      "profile-dir": { type: "string" },
      "diagnostics-dir": { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  const runtimeSupplied =
    values["browser-runtime-mode"] !== undefined ||
    values["browser-library-dir"] !== undefined ||
    values["browser-fontconfig"] !== undefined;
  if (values.browser && !values["browser-manifest"]) {
    throw new Error("--browser requires --browser-manifest");
  }
  if (values.browser && values["browser-runtime-mode"] === undefined) {
    throw new Error("--browser requires --browser-runtime-mode");
  }
  if (!values.browser && runtimeSupplied) {
    throw new Error("browser runtime inputs require --browser");
  }
  return values;
}

export async function main(argv = process.argv) {
  const values = parseOptions(argv.slice(2));
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const browserManifest = values["browser-manifest"]
    ? JSON.parse(readFileSync(values["browser-manifest"], "utf8"))
    : undefined;
  if (
    browserManifest &&
    browserManifest.version !== puppeteerBrowserRevision()
  ) {
    throw new Error(
      `browser manifest revision ${browserManifest.version} does not match Puppeteer ${puppeteerBrowserRevision()}`,
    );
  }
  const browserEnv = values.browser
    ? browserEnvironment({
        mode: values["browser-runtime-mode"],
        libraryDirs: values["browser-library-dir"],
        fontconfig: values["browser-fontconfig"],
      })
    : undefined;
  const reportedBrowserVersion = values.browser
    ? browserVersion(values.browser, browserManifest.version, browserEnv)
    : undefined;
  const { report, baseUrl, hostSnapshotStart, hostSnapshotEnd, elapsedMs } =
    await runChecks({
      wwwDir: values["www-dir"],
      configPath: values.config,
      routing: values.routing,
      browserPath: values.browser,
      browserEnv,
      profileDir: values["profile-dir"],
    });
  const nonPassingUrls = printReport(report, baseUrl);
  if (runFailed(report, nonPassingUrls)) {
    const diagnostics = buildFailureDiagnostics({
      report,
      baseUrl,
      hostSnapshotStart,
      hostSnapshotEnd,
      elapsedMs,
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
    });
    if (diagnostics) {
      writeFailureDiagnostics(
        diagnostics,
        resolve(values["diagnostics-dir"] ?? DEFAULT_DIAGNOSTICS_DIR),
      );
    }
    throw new Error("website accessibility checks failed");
  }
  if (values.output) {
    writeFileSync(
      values.output,
      JSON.stringify(
        buildCheckResult({
          report,
          baseUrl,
          browserRevision: browserManifest?.version,
          reportedBrowserVersion,
        }),
        null,
        2,
      ) + "\n",
    );
  }
}
