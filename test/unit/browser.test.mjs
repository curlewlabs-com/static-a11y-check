// The environment a caller-supplied browser starts in: a declared Linux
// runtime replaces the host's LD_LIBRARY_PATH and FONTCONFIG_FILE with its own,
// rather than adding to them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserEnvironment, browserVersion } from "../../lib/browser.mjs";

test("browserEnvironment: declared Linux uses only provider runtime paths", () => {
  const env = browserEnvironment(
    {
      mode: "declared_linux",
      libraryDirs: ["/declared/lib", "/declared/extra"],
      fontconfig: "/declared/fonts.conf",
    },
    {
      LANG: "C",
      LD_LIBRARY_PATH: "/host/lib",
      FONTCONFIG_FILE: "/host/fonts.conf",
    },
  );

  assert.deepEqual(env, {
    LANG: "C",
    LD_LIBRARY_PATH: "/declared/lib:/declared/extra",
    FONTCONFIG_FILE: "/declared/fonts.conf",
  });
});

test("browserEnvironment: system macOS removes Linux runtime settings", () => {
  const env = browserEnvironment(
    { mode: "system_macos" },
    {
      LANG: "C",
      LD_LIBRARY_PATH: "/host/lib",
      FONTCONFIG_FILE: "/host/fonts.conf",
    },
  );

  assert.deepEqual(env, { LANG: "C" });
});

test("browserEnvironment: declared Linux rejects an incomplete closure", () => {
  assert.throws(
    () => browserEnvironment({ mode: "declared_linux" }, {}),
    /requires absolute libraries and Fontconfig/,
  );
});

// A revision that is a prefix of the reported one names a different browser:
// matched as a substring, 140.0.7339.8 accepted a browser reporting
// 140.0.7339.80.
test("browserVersion: the revision must be a whole word of the reported version", () => {
  const dir = mkdtempSync(join(tmpdir(), "static-a11y-browser-"));
  try {
    const browser = join(dir, "browser");
    writeFileSync(
      browser,
      "#!/bin/sh\necho 'Chrome-Headless-Shell 140.0.7339.80'\n",
    );
    chmodSync(browser, 0o755);
    assert.equal(
      browserVersion(browser, "140.0.7339.80", process.env),
      "Chrome-Headless-Shell 140.0.7339.80",
    );
    assert.throws(
      () => browserVersion(browser, "140.0.7339.8", process.env),
      /expected 140\.0\.7339\.8$/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
