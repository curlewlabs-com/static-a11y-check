// The report: pa11y-ci's technical failures read as failures, the state pass
// merged into the same verdict, and the failure record split so a flake under
// host contention can be told from a real regression.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCheckResult,
  buildFailureDiagnostics,
  mergeStateResults,
  printReport,
  runFailed,
} from "../../lib/report.mjs";

function captureOutput(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    return { result: fn(), lines };
  } finally {
    console.log = orig;
  }
}

// pa11y-ci@4.1.0 lib/pa11y-ci.js (around lines 130-132) writes `[error]` into
// `report.results[url]` for any URL whose runner throws - server unreachable,
// page-load timeout, axe injection failure - WITHOUT incrementing
// `report.errors` or `report.passes`. printReport's pre-fix shape check
// (`Array.isArray(result)`) accepted the wrapped Error and the subsequent
// `i.type === "error"` filter dropped it (Error has no `type` property),
// so a totally crashed scan logged "PASS" for every URL and exit 0.
// These tests guard the failure-as-FAIL path so a future refactor can't
// silently restore that mask.
test("printReport: pa11y-ci technical failure (Error in results) is FAIL, not PASS", () => {
  const report = {
    total: 1,
    passes: 0,
    errors: 0,
    results: {
      "http://x/about": [new Error("net::ERR_CONNECTION_REFUSED")],
    },
  };
  const { result: nonPassing, lines } = captureOutput(() =>
    printReport(report, "http://x"),
  );
  assert.equal(nonPassing, 1);
  assert.ok(
    lines.some((l) => l.startsWith("FAIL  /about")),
    `expected FAIL line for /about; got: ${JSON.stringify(lines)}`,
  );
  assert.ok(
    lines.some((l) => l.includes("net::ERR_CONNECTION_REFUSED")),
    "FAIL line should surface the underlying technical-failure message",
  );
});

test("printReport: a clean report (zero issues) reports zero non-passing URLs", () => {
  const report = {
    total: 1,
    passes: 1,
    errors: 0,
    results: { "http://x/": [] },
  };
  const { result: nonPassing, lines } = captureOutput(() =>
    printReport(report, "http://x"),
  );
  assert.equal(nonPassing, 0);
  assert.ok(lines.some((l) => l.startsWith("PASS  /")));
});

test("printReport: a real axe error (object with type=error) is FAIL", () => {
  const report = {
    total: 1,
    passes: 0,
    errors: 1,
    results: {
      "http://x/about": [
        {
          type: "error",
          code: "color-contrast",
          message: "Low contrast",
          selector: "#a",
        },
      ],
    },
  };
  const { result: nonPassing, lines } = captureOutput(() =>
    printReport(report, "http://x"),
  );
  assert.equal(nonPassing, 1);
  assert.ok(lines.some((l) => l.startsWith("FAIL  /about")));
  assert.ok(lines.some((l) => l.includes("[color-contrast]")));
});

// Injected (not captured) so the transform is asserted deterministically; the
// real os.loadavg() values are runtime noise and not what this guards.
const FAKE_SNAPSHOT = {
  loadavg: [8.12, 6.4, 5.01],
  cpus: 8,
  freeMemMB: 512,
  totalMemMB: 16384,
  uptimeSec: 90000,
};

// A navigation timeout is the contention flake case: it lands as a technical
// failure, and the host snapshot must survive into the record - that snapshot
// is the whole reason the record exists (confirm contention vs a real fault
// after the fact).
test("buildFailureDiagnostics: a technical failure carries the host snapshot and is kept apart from a11y errors", () => {
  const report = {
    total: 2,
    passes: 1,
    errors: 0,
    results: {
      "http://x/": [],
      "http://x/apps/one/terms": [
        new Error("Navigation timeout of 60000 ms exceeded"),
      ],
    },
  };
  const diag = buildFailureDiagnostics({
    report,
    baseUrl: "http://x",
    hostSnapshotStart: FAKE_SNAPSHOT,
    hostSnapshotEnd: FAKE_SNAPSHOT,
    elapsedMs: 64210,
    timestamp: "2026-05-28T00:00:00.000Z",
    nodeVersion: "v24.0.0",
  });
  assert.equal(diag.technicalFailures.length, 1);
  assert.equal(diag.technicalFailures[0].path, "/apps/one/terms");
  assert.match(diag.technicalFailures[0].message, /Navigation timeout/);
  assert.equal(diag.a11yFailures.length, 0);
  assert.deepEqual(diag.host.end.loadavg, [8.12, 6.4, 5.01]);
  assert.equal(diag.urls.total, 2);
  assert.equal(diag.elapsedMs, 64210);
});

// Real axe errors are deterministic regressions, not flakes: they must be
// recorded as a11y failures (with code/selector) so the record never blames
// a genuine violation on host pressure.
test("buildFailureDiagnostics: a real axe error is recorded as an a11y failure, not technical", () => {
  const report = {
    total: 1,
    passes: 0,
    errors: 1,
    results: {
      "http://x/about": [
        {
          type: "error",
          code: "color-contrast",
          message: "Low contrast",
          selector: "#a",
        },
      ],
    },
  };
  const diag = buildFailureDiagnostics({
    report,
    baseUrl: "http://x",
    hostSnapshotStart: FAKE_SNAPSHOT,
    hostSnapshotEnd: FAKE_SNAPSHOT,
    elapsedMs: 100,
    timestamp: "t",
    nodeVersion: "v24",
  });
  assert.equal(diag.technicalFailures.length, 0);
  assert.equal(diag.a11yFailures.length, 1);
  assert.equal(diag.a11yFailures[0].path, "/about");
  assert.equal(diag.a11yFailures[0].errors[0].code, "color-contrast");
  assert.equal(diag.a11yFailures[0].errors[0].selector, "#a");
});

// Null on a clean run is the contract that keeps green runs from writing (and
// CI from uploading) anything.
test("buildFailureDiagnostics: a clean report produces no record (null)", () => {
  const report = {
    total: 1,
    passes: 1,
    errors: 0,
    results: { "http://x/": [] },
  };
  const diag = buildFailureDiagnostics({
    report,
    baseUrl: "http://x",
    hostSnapshotStart: FAKE_SNAPSHOT,
    hostSnapshotEnd: FAKE_SNAPSHOT,
    elapsedMs: 100,
    timestamp: "t",
    nodeVersion: "v24",
  });
  assert.equal(diag, null);
});

test("buildCheckResult: records the acquired browser and canonical URL sweep", () => {
  const result = buildCheckResult({
    report: {
      total: 2,
      passes: 2,
      errors: 0,
      results: {
        "http://x/about": [],
        "http://x/": [],
      },
    },
    baseUrl: "http://x",
    browserRevision: "147.0.7727.57",
    reportedBrowserVersion: "HeadlessChrome 147.0.7727.57",
  });
  assert.deepEqual(result, {
    format: 1,
    browser: {
      revision: "147.0.7727.57",
      reportedVersion: "HeadlessChrome 147.0.7727.57",
    },
    accessibility: {
      total: 2,
      passes: 2,
      errors: 0,
      urls: ["/", "/about"],
    },
  });
});

// mergeStateResults is what turns a hover- or focus-only contrast failure into
// a red run: the run fails on report.passes !== report.total, so a page that
// passed at rest must stop counting as a pass when a state fails on it.
const stateIssue = {
  code: "color-contrast",
  type: "error",
  message: ":hover: Elements must meet minimum color contrast ratio thresholds",
  selector: "a.btn",
};
const restingIssue = {
  code: "image-alt",
  type: "error",
  message: "Images must have alternative text",
  selector: "img",
};

test("mergeStateResults: a state failure on a page that passed at rest fails the page", () => {
  const report = {
    total: 2,
    passes: 2,
    errors: 0,
    results: { "http://x/": [], "http://x/about": [] },
  };
  mergeStateResults(report, {
    "http://x/": [stateIssue],
    "http://x/about": [],
  });
  assert.equal(report.passes, 1);
  assert.equal(report.errors, 1);
  assert.deepEqual(report.results["http://x/"], [stateIssue]);
  assert.deepEqual(report.results["http://x/about"], []);
});

test("mergeStateResults: state issues on a page already failing at rest are appended, not double-counted as a lost pass", () => {
  const report = {
    total: 1,
    passes: 0,
    errors: 1,
    results: { "http://x/": [restingIssue] },
  };
  mergeStateResults(report, { "http://x/": [stateIssue] });
  assert.equal(report.passes, 0);
  assert.equal(report.errors, 2);
  assert.deepEqual(report.results["http://x/"], [restingIssue, stateIssue]);
});

// A state pass that could not score a page (navigation timeout, crashed
// renderer) must not let that page read as green, the same way pa11y-ci's own
// technical failures are not trusted to bump report.errors.
test("mergeStateResults: a state-pass technical failure on a resting pass fails the page", () => {
  const failure = new Error("Navigation timeout of 60000 ms exceeded");
  const report = {
    total: 1,
    passes: 1,
    errors: 0,
    results: { "http://x/": [] },
  };
  mergeStateResults(report, { "http://x/": [failure] });
  assert.equal(report.passes, 0);
  assert.equal(report.errors, 0);
  assert.deepEqual(report.results["http://x/"], [failure]);
});

// A page can fail at rest and in the state pass at once; dropping either
// would hide the state pass's failure behind the resting issue or the reverse,
// and the failure record exists to tell a flake from a regression.
test("mergeStateResults: a state-pass technical failure on a page failing at rest keeps the resting issue and the failure", () => {
  const failure = new Error("state pass, :hover: Target closed");
  const report = {
    total: 1,
    passes: 0,
    errors: 1,
    results: { "http://x/": [restingIssue] },
  };
  mergeStateResults(report, { "http://x/": [failure] });
  assert.equal(report.passes, 0);
  assert.equal(report.errors, 1);
  assert.deepEqual(report.results["http://x/"], [restingIssue, failure]);

  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  let nonPassing;
  try {
    nonPassing = printReport(report, "http://x");
  } finally {
    console.log = log;
  }
  assert.equal(nonPassing, 1);
  assert.ok(lines.some((l) => l.includes("technical failure: state pass")));
  assert.ok(lines.some((l) => l.includes(restingIssue.message)));

  const diag = buildFailureDiagnostics({
    report,
    baseUrl: "http://x",
    hostSnapshotStart: {},
    hostSnapshotEnd: {},
    elapsedMs: 1,
    timestamp: "2026-10-24T00:00:00.000Z",
    nodeVersion: "v24.0.0",
  });
  assert.equal(diag.technicalFailures.length, 1);
  assert.equal(diag.technicalFailures[0].path, "/");
  assert.equal(diag.a11yFailures.length, 1);
  assert.equal(diag.a11yFailures[0].errors[0].code, "image-alt");
});

// pa11y-ci can leave a page out of results entirely; a run whose passes fall
// short of its total fails even with no error and no non-passing URL printed.
test("runFailed: any page short of a pass fails the run", () => {
  assert.equal(runFailed({ errors: 0, passes: 2, total: 2 }, 0), false);
  assert.equal(runFailed({ errors: 0, passes: 1, total: 2 }, 0), true);
  assert.equal(runFailed({ errors: 0, passes: 2, total: 2 }, 1), true);
  assert.equal(runFailed({ errors: 1, passes: 2, total: 2 }, 0), true);
});

// A run with puppeteer's own browser has no declared revision to record; the
// result says so rather than failing after a green run.
test("buildCheckResult: without a declared browser records null revisions", () => {
  const result = buildCheckResult({
    report: { total: 1, passes: 1, errors: 0, results: { "http://x/": [] } },
    baseUrl: "http://x",
  });
  assert.deepEqual(result.browser, { revision: null, reportedVersion: null });
  assert.deepEqual(result.accessibility.urls, ["/"]);
});
