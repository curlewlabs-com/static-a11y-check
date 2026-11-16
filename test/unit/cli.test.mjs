// The command's option rules and the pa11y-ci configuration a run is given.
// A caller-supplied browser must arrive with what proves which browser it is
// and how it starts; half of that set would run an unverified browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOptions } from "../../lib/cli.mjs";
import { runConfig } from "../../lib/run.mjs";

test("parseOptions: --browser needs its manifest and runtime mode", () => {
  assert.throws(
    () =>
      parseOptions([
        "--browser",
        "/b",
        "--browser-runtime-mode",
        "system_macos",
      ]),
    /--browser requires --browser-manifest/,
  );
  assert.throws(
    () => parseOptions(["--browser", "/b", "--browser-manifest", "m.json"]),
    /--browser requires --browser-runtime-mode/,
  );
  assert.doesNotThrow(() =>
    parseOptions([
      "--browser",
      "/b",
      "--browser-manifest",
      "m.json",
      "--browser-runtime-mode",
      "system_macos",
    ]),
  );
});

test("parseOptions: runtime inputs without --browser are refused", () => {
  for (const args of [
    ["--browser-runtime-mode", "system_macos"],
    ["--browser-library-dir", "/lib"],
    ["--browser-fontconfig", "/fonts.conf"],
  ]) {
    assert.throws(
      () => parseOptions(args),
      /browser runtime inputs require --browser/,
    );
  }
});

test("parseOptions: an unknown option is refused", () => {
  assert.throws(() => parseOptions(["--site", "www"]), /Unknown option/);
});

// A saturated CI host has kept Chromium from printing its endpoint within
// Puppeteer's default launch timeout; a site's own value still wins.
test("runConfig: a launch timeout by default, the site's own when it sets one", () => {
  const plain = runConfig({ defaults: { timeout: 1 } });
  assert.equal(plain.chromeLaunchConfig.timeout, 120_000);
  assert.equal(plain.timeout, 1);
  const own = runConfig({ chromeLaunchConfig: { timeout: 5, args: ["--x"] } });
  assert.deepEqual(own.chromeLaunchConfig, { timeout: 5, args: ["--x"] });
});

test("runConfig: a supplied browser keeps the site's launch arguments", () => {
  const config = runConfig(
    { defaults: { chromeLaunchConfig: { args: ["--no-sandbox"] } } },
    { browserPath: "/b", browserEnv: { A: "1" }, profileDir: "/p" },
  );
  assert.deepEqual(config.chromeLaunchConfig, {
    timeout: 120_000,
    args: ["--no-sandbox"],
    executablePath: "/b",
    env: { A: "1" },
    userDataDir: "/p",
  });
});

test("runConfig: does not modify the configuration it was given", () => {
  const base = { defaults: { chromeLaunchConfig: { args: [] } } };
  runConfig(base, { browserPath: "/b" });
  assert.deepEqual(base, { defaults: { chromeLaunchConfig: { args: [] } } });
});
