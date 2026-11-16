// The state pass's config refusals and how it keeps a page's findings. A
// browser is not needed for either: the refusal reads the config, and the
// fake browser below stands in only for what a page load returns.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNSUPPORTED_SETTINGS,
  checkPageStates,
  unsupportedConfig,
} from "../../lib/state-pass.mjs";

test("unsupportedConfig: a config the state pass can score is accepted", () => {
  assert.equal(unsupportedConfig({ runners: ["axe"], ignore: [] }), null);
});

// Without axe the state pass would read no color-contrast results and pass
// every page.
test("unsupportedConfig: a config without axe is refused", () => {
  assert.match(unsupportedConfig({ runners: ["htmlcs"] }), /must name axe/);
  assert.match(unsupportedConfig({}), /must name axe/);
});

// pa11y applies these only after it is handed the page, by which time the
// state pass has loaded and forced it, so an element an action adds would be
// scored unforced and pass.
test("unsupportedConfig: settings pa11y applies after the forcing are refused", () => {
  for (const key of UNSUPPORTED_SETTINGS) {
    assert.match(
      unsupportedConfig({ runners: ["axe"], [key]: [] }),
      new RegExp(`\`${key}\``),
    );
  }
});

// A browser whose first context scores one issue and whose second fails to
// open: a failure in the :focus-visible state must not hide what :hover found.
function fakeBrowser() {
  const cdp = {
    send: async (method) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelectorAll") return { nodeIds: [] };
      return {};
    },
  };
  const page = {
    setViewport: async () => {},
    goto: async () => {},
    evaluate: async () => {},
    createCDPSession: async () => cdp,
  };
  let contexts = 0;
  return {
    createBrowserContext: async () => {
      contexts += 1;
      if (contexts > 1) throw new Error("context refused");
      return { newPage: async () => page, close: async () => {} };
    },
  };
}

test("checkPageStates: a failing state keeps the issues another state found", async () => {
  const pa11y = async () => ({
    issues: [{ type: "error", code: "color-contrast", message: "low" }],
  });
  pa11y.defaults = { viewport: { width: 1, height: 1 } };
  const entries = await checkPageStates(fakeBrowser(), "http://x/", {}, pa11y);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].message, ":hover: low");
  assert.ok(entries[1] instanceof Error);
  assert.match(
    entries[1].message,
    /:focus-visible browser context: context refused/,
  );
});
