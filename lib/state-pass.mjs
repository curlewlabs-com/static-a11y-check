// The forced-state pass: scores color contrast on each page under :hover and
// :focus-visible, which axe alone never sees, after first proving on a
// built-in page that forcing still takes effect.
//
// axe scores a page only as it renders at rest, so a style active only under a
// state (a hover fade that drops a button's ink below AA) passes unseen. This
// pass loads each page again once per state, forces that state through the
// DevTools protocol (CSS.forcePseudoState), and re-runs pa11y's axe on the
// forced page, keeping only its color-contrast results.

import { requireFromPa11yCi } from "./browser.mjs";

// What a pointer or keyboard user can put into a state: hovering an element
// hovers every ancestor, and focusing one puts every ancestor in :focus-within,
// so a rule keyed on a wrapper's state (`.card:hover a`) applies too.
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  'input:not([type="hidden"])',
  "select",
  "textarea",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");
const FORCED_STATES = [
  { name: ":hover", element: ["hover"], ancestor: ["hover"] },
  {
    name: ":focus-visible",
    element: ["focus", "focus-visible"],
    ancestor: ["focus-within"],
  },
];
// Every other axe rule scores structure a state does not change, so the
// resting pass already holds its verdict.
export const STATE_RULE = "color-contrast";
// DOM.Node.nodeType for an element; forcing a state on any other node fails.
const ELEMENT_NODE = 1;
// A state's own rule only takes effect once its transition finishes, and axe
// reads computed style at once; without this it would score the first frame
// of a fade, not where it lands.
const NO_TRANSITIONS_CSS =
  "*, *::before, *::after { transition: none !important; }";

// Every interactive element is forced at once rather than one at a time, in
// one axe run per state. An element's style keys on its own and its ancestors'
// state, so the union scores each element as its own hover would; the shape it
// misses is a sibling or :has() rule keyed on another element's state.
function forcedPseudoClasses(root, interactiveIds, state) {
  const elementParent = new Map();
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (node.nodeType === ELEMENT_NODE) {
        elementParent.set(child.nodeId, node.nodeId);
      }
      walk(child);
    }
  };
  walk(root);
  const forced = new Map();
  const add = (nodeId, classes) => {
    const merged = new Set([...(forced.get(nodeId) ?? []), ...classes]);
    forced.set(nodeId, [...merged]);
  };
  for (const nodeId of interactiveIds) {
    add(nodeId, state.element);
    for (
      let parent = elementParent.get(nodeId);
      parent !== undefined;
      parent = elementParent.get(parent)
    ) {
      add(parent, state.ancestor);
    }
  }
  return forced;
}

async function forceStates(cdp, forced) {
  for (const [nodeId, classes] of forced) {
    await cdp.send("CSS.forcePseudoState", {
      nodeId,
      forcedPseudoClasses: classes,
    });
  }
}

function stateFailure(phase, error) {
  return new Error(`state pass, ${phase}: ${error.message}`, { cause: error });
}

async function checkPageStates(browser, url, config, pa11y) {
  const issues = [];
  for (const state of FORCED_STATES) {
    issues.push(...(await checkPageState(browser, url, config, pa11y, state)));
  }
  return issues;
}

// One state per fresh page: pa11y binds listeners to a supplied page on every
// run and documents that a page cannot be reused between runs. Each state also
// gets its own browser context, so no cookie or storage a page sets reaches
// the next state's load.
async function checkPageState(browser, url, config, pa11y, state) {
  let phase = "browser context";
  let context;
  let primaryFailure;
  try {
    context = await browser.createBrowserContext();
    phase = "page load";
    const page = await context.newPage();
    await page.setViewport(config.viewport ?? pa11y.defaults.viewport);
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: config.timeout,
    });
    await page.addStyleTag({ content: NO_TRANSITIONS_CSS });
    phase = "forcing";
    const cdp = await page.createCDPSession();
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: INTERACTIVE_SELECTOR,
    });
    await forceStates(cdp, forcedPseudoClasses(root, nodeIds, state));
    phase = "axe";
    const result = await pa11y(url, {
      ...config,
      browser,
      page,
      ignoreUrl: true,
    });
    return result.issues
      .filter((issue) => issue.code === STATE_RULE)
      .map((issue) => ({
        ...issue,
        message: `${state.name}: ${issue.message}`,
      }));
  } catch (error) {
    primaryFailure = stateFailure(`${state.name} ${phase}`, error);
    throw primaryFailure;
  } finally {
    await closeContext(context, state, primaryFailure);
  }
}

// A context that will not close leaves the browser in doubt for every page
// after it, so on its own it fails the page; behind a failure already thrown it
// is logged, so the record keeps the failure that stopped the page.
async function closeContext(context, state, primaryFailure) {
  if (!context) return;
  try {
    await context.close();
  } catch (error) {
    const failure = stateFailure(`${state.name} closing the context`, error);
    if (!primaryFailure) throw failure;
    console.error(`${failure.message} (after ${primaryFailure.message})`);
  }
}

// A known-bad page the state pass must fail before any real page's green
// counts: if forcing stopped taking effect (a Chrome or puppeteer change to
// CSS.forcePseudoState, a refactor that drops a state), every real page would
// pass and nothing else would notice. Each [state, selector] below is a rule
// that only that state breaks - its own hover behind a transition, a wrapper's
// hover, and keyboard focus - over text that passes at rest.
const POSITIVE_CONTROL_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>state pass control</title>
<style>
  body { background: #fff; color: #000; }
  a { color: #000; }
  #own-hover { transition: color 5s; }
  #own-hover:hover, .wrapper:hover #wrapper-hover, #focus:focus-visible {
    color: #bbb;
  }
</style></head><body><main>
  <p><a id="own-hover" href="#a">own hover</a></p>
  <div class="wrapper"><p><a id="wrapper-hover" href="#b">wrapper hover</a></p></div>
  <p><a id="focus" href="#c">focus</a></p>
</main></body></html>`;
const POSITIVE_CONTROL_EXPECTED = [
  [":hover", "#own-hover"],
  [":hover", "#wrapper-hover"],
  [":focus-visible", "#focus"],
];

async function checkPositiveControl(browser, config, pa11y) {
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(POSITIVE_CONTROL_HTML)}`;
  const issues = await checkPageStates(browser, url, config, pa11y);
  const missed = POSITIVE_CONTROL_EXPECTED.filter(
    ([state, selector]) =>
      !issues.some(
        (issue) =>
          issue.selector === selector && issue.message.startsWith(`${state}:`),
      ),
  );
  if (missed.length > 0) {
    const names = missed.map(([state, selector]) => `${selector} ${state}`);
    throw new Error(`forcing did not fail ${names.join(", ")}`);
  }
}

// Keyed like pa11y-ci's report.results: an issue list per URL, or `[error]`
// when the pass could not score that page.
export async function runStateChecks(urls, config) {
  const puppeteer = requireFromPa11yCi("puppeteer");
  const pa11y = requireFromPa11yCi("pa11y");
  const states = FORCED_STATES.map((state) => state.name).join(", ");
  console.log(`Scoring ${STATE_RULE} under ${states} on ${urls.length} URLs`);
  // A failure that stops the whole pass is recorded against every page rather
  // than thrown, so it reaches the failure record with its host snapshot.
  const failEveryPage = (error) =>
    Object.fromEntries(urls.map((url) => [url, [error]]));
  let browser;
  try {
    browser = await puppeteer.launch(config.chromeLaunchConfig);
  } catch (error) {
    return failEveryPage(stateFailure("browser launch", error));
  }
  try {
    try {
      await checkPositiveControl(browser, config, pa11y);
    } catch (error) {
      return failEveryPage(stateFailure("positive control", error));
    }
    const results = {};
    for (const url of urls) {
      try {
        results[url] = await checkPageStates(browser, url, config, pa11y);
      } catch (error) {
        results[url] = [error];
      }
    }
    return results;
  } finally {
    // Every page's verdict is already in hand; a browser that will not close
    // changes none of them, so it is logged rather than failing the run.
    await browser.close().catch((error) => {
      console.error("state pass: closing the browser failed", error);
    });
  }
}
