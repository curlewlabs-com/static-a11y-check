// The run's report: folding the state pass into pa11y-ci's report, printing
// it, and the two records a run can leave - the failure diagnostics and the
// check result.
//
// pa11y-ci stores an Error, not an issue object, in `report.results[url]` for a
// page it could not score (an unreachable server, a page-load timeout, an axe
// injection failure), without counting it in `report.errors` or
// `report.passes`. Everything here reads the result arrays themselves, so a
// runner crash cannot read as a green run.

import { cpus, freemem, loadavg, totalmem, uptime } from "node:os";

// Folds the state pass into pa11y-ci's report in place, so printReport, the
// failure diagnostics, and the exit predicate judge one report. A page that
// passed at rest and fails a state stops counting as a pass. The state pass's
// entries go after the resting ones, so a page carries every resting issue,
// state issue, and technical failure either pass recorded for it; like
// pa11y-ci, report.errors counts issues and not technical failures.
export function mergeStateResults(report, stateResults) {
  for (const [url, stateResult] of Object.entries(stateResults)) {
    if (stateResult.length === 0) continue;
    const resting = entriesOf(report.results[url]);
    if (resting.length === 0) report.passes -= 1;
    report.results[url] = [...resting, ...stateResult];
    report.errors += stateResult.filter((e) => !(e instanceof Error)).length;
  }
}

// pa11y-ci stores `[error]` for a page it could not score, and a page the
// state pass merged into can hold Errors beside its issues.
function entriesOf(result) {
  if (result instanceof Error) return [result];
  return Array.isArray(result) ? result : [];
}

function splitResult(result) {
  const entries = entriesOf(result);
  return {
    technicalFailures: entries.filter((entry) => entry instanceof Error),
    errors: entries.filter(
      (entry) => !(entry instanceof Error) && entry.type === "error",
    ),
  };
}

function pathOf(url, baseUrl) {
  return url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url;
}

// Anything that did not pass, for any reason, fails the run.
export function runFailed(report, nonPassingUrls) {
  return (
    report.errors > 0 || nonPassingUrls > 0 || report.passes !== report.total
  );
}

// The record `--output` writes on a passing run: what was checked and which
// browser checked it, for a build to keep as the check's output.
export function buildCheckResult({
  report,
  baseUrl,
  browserRevision,
  reportedBrowserVersion,
}) {
  return {
    format: 1,
    browser: {
      revision: browserRevision ?? null,
      reportedVersion: reportedBrowserVersion ?? null,
    },
    accessibility: {
      total: report.total,
      passes: report.passes,
      errors: report.errors,
      urls: Object.keys(report.results)
        .map((url) => pathOf(url, baseUrl))
        .sort(),
    },
  };
}

// Renders the report so a CI log names the page, the WCAG criterion, and the
// offending selector - enough to act on without re-running locally. pa11y-ci's
// programmatic API returns the report silently.
//
// Returns the count of URLs that did not pass (axe errors or technical
// failures), so the caller decides the exit status.
export function printReport(report, baseUrl) {
  let nonPassingUrls = 0;
  for (const [url, result] of Object.entries(report.results)) {
    const path = pathOf(url, baseUrl);
    const { technicalFailures, errors } = splitResult(result);
    if (technicalFailures.length === 0 && errors.length === 0) {
      console.log(`PASS  ${path}`);
      continue;
    }
    nonPassingUrls += 1;
    for (const err of technicalFailures) {
      console.log(`FAIL  ${path} - technical failure: ${err.message}`);
    }
    if (errors.length === 0) continue;
    console.log(`FAIL  ${path} - ${errors.length} error(s)`);
    for (const issue of errors) {
      console.log(`  [${issue.code}] ${issue.message}`);
      if (issue.selector) console.log(`    selector: ${issue.selector}`);
    }
  }
  console.log(
    `\n${report.passes}/${report.total} URLs passed, ${report.errors} error(s) total`,
  );
  return nonPassingUrls;
}

// Host pressure at one instant. A navigation timeout against the in-process
// static server is nearly always renderer starvation on a shared CI host, not
// an accessibility fault, and a high load average bracketing the failure is
// its fingerprint. loadavg reports [0, 0, 0] on platforms with no run-queue
// metric (Windows).
export function captureHostSnapshot() {
  return {
    loadavg: loadavg(),
    cpus: cpus().length,
    freeMemMB: Math.round(freemem() / 1024 / 1024),
    totalMemMB: Math.round(totalmem() / 1024 / 1024),
    uptimeSec: Math.round(uptime()),
  };
}

// The failure record, or null for a clean run so a green run writes nothing.
// Technical failures are kept apart from axe errors: with the host snapshot,
// they let a reader tell a navigation-timeout flake under contention from a
// real fault without a re-run. Pure (no clock, no IO): the caller supplies the
// timestamp and snapshots.
export function buildFailureDiagnostics({
  report,
  baseUrl,
  hostSnapshotStart,
  hostSnapshotEnd,
  elapsedMs,
  timestamp,
  nodeVersion,
}) {
  const technicalFailures = [];
  const a11yFailures = [];
  for (const [url, result] of Object.entries(report.results)) {
    const path = pathOf(url, baseUrl);
    const { technicalFailures: failures, errors } = splitResult(result);
    for (const err of failures) {
      // A state-pass failure wraps the error that stopped it to name the
      // phase; the frames worth reading are the innermost error's.
      let root = err;
      while (root.cause instanceof Error) root = root.cause;
      technicalFailures.push({ path, message: err.message, stack: root.stack });
    }
    if (errors.length > 0) {
      a11yFailures.push({
        path,
        errors: errors.map((i) => ({
          code: i.code,
          message: i.message,
          selector: i.selector,
        })),
      });
    }
  }
  if (technicalFailures.length === 0 && a11yFailures.length === 0) return null;
  return {
    timestamp,
    nodeVersion,
    elapsedMs,
    urls: { total: report.total, passes: report.passes },
    host: { start: hostSnapshotStart, end: hostSnapshotEnd },
    technicalFailures,
    a11yFailures,
  };
}
