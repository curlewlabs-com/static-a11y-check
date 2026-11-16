// The environment a caller-supplied browser starts in: a declared Linux
// runtime replaces the host's LD_LIBRARY_PATH and FONTCONFIG_FILE with its own,
// rather than adding to them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { browserEnvironment } from "../../lib/browser.mjs";

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
