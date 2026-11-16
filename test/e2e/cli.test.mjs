// The command end to end, in a real browser: a clean site passes, and a site
// that passes at rest but loses contrast under :hover fails, with the forced
// state named and a failure record written. The second is the reason the tool
// exists; nothing short of a browser shows that forcing took effect.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BIN = join(import.meta.dirname, "../../bin/static-a11y-check.mjs");
const FIXTURES = join(import.meta.dirname, "fixtures");
// Two browser passes over a fixture's pages take seconds; the bound is for a
// browser that hangs at launch, which would otherwise hold the job until the
// runner's own limit.
const RUN_MS = 240_000;

function check(site, extra = []) {
  const scratch = mkdtempSync(join(tmpdir(), "static-a11y-e2e-"));
  const result = spawnSync(
    process.execPath,
    [
      BIN,
      "--www-dir",
      join(FIXTURES, site, "www"),
      "--config",
      join(FIXTURES, "pa11yci.json"),
      "--diagnostics-dir",
      join(scratch, "diagnostics"),
      "--output",
      join(scratch, "result.json"),
      ...extra,
    ],
    { encoding: "utf8", timeout: RUN_MS },
  );
  return { ...result, scratch };
}

test(
  "a clean site passes and records every page",
  { timeout: RUN_MS + 10_000 },
  () => {
    const run = check("clean");
    try {
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      const result = JSON.parse(
        readFileSync(join(run.scratch, "result.json"), "utf8"),
      );
      assert.deepEqual(result.accessibility.urls, ["/", "/docs/"]);
      assert.equal(result.accessibility.passes, 2);
    } finally {
      rmSync(run.scratch, { recursive: true, force: true });
    }
  },
);

test(
  "a contrast loss only under :hover fails the run",
  { timeout: RUN_MS + 10_000 },
  () => {
    const run = check("hover-only");
    try {
      assert.notEqual(run.status, 0, run.stdout);
      assert.match(run.stdout, /FAIL {2}\/ - 1 error\(s\)/);
      assert.match(run.stdout, /\[color-contrast\] :hover: /);
      assert.doesNotMatch(run.stdout, /:focus-visible: /);
      const records = readdirSync(join(run.scratch, "diagnostics"));
      assert.equal(records.length, 1);
      const record = JSON.parse(
        readFileSync(join(run.scratch, "diagnostics", records[0]), "utf8"),
      );
      const [failure] = record.a11yFailures[0].errors;
      assert.equal(failure.code, "color-contrast");
      assert.match(failure.message, /^:hover: /);
    } finally {
      rmSync(run.scratch, { recursive: true, force: true });
    }
  },
);
