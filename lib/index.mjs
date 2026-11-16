// The package's programmatic API: what a caller that runs the checks itself,
// or wraps the command, imports.

export {
  browserEnvironment,
  browserVersion,
  puppeteerBrowserRevision,
} from "./browser.mjs";
export { DEFAULT_DIAGNOSTICS_DIR, main, parseOptions } from "./cli.mjs";
export {
  buildCheckResult,
  buildFailureDiagnostics,
  captureHostSnapshot,
  mergeStateResults,
  printReport,
  runFailed,
} from "./report.mjs";
export {
  DEFAULT_CONFIG_PATH,
  DEFAULT_WWW_DIR,
  runChecks,
  runConfig,
} from "./run.mjs";
export {
  DEFAULT_ROUTING,
  ROUTINGS,
  findHtmlFiles,
  pagePath,
  resolveServedPath,
  startStaticServer,
} from "./site.mjs";
export { STATE_RULE, runStateChecks } from "./state-pass.mjs";
