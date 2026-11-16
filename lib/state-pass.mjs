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
    // A focused element matches :focus-within itself, not only its ancestors.
    element: ["focus", "focus-visible", "focus-within"],
    ancestor: ["focus-within"],
  },
];
// Every other axe rule scores structure a state does not change, so the
// resting pass already holds its verdict.
export const STATE_RULE = "color-contrast";
// DOM.Node.nodeType for an element; forcing a state on any other node fails.
const ELEMENT_NODE = 1;
// pa11y applies these itself after it is handed a page, so on a page this pass
// loads and forces first they would act on the page too late: an element an
// action adds would be scored unforced, and a header or user agent would not
// reach the load. They are refused rather than half applied.
export const UNSUPPORTED_SETTINGS = [
  "actions",
  "wait",
  "headers",
  "userAgent",
  "method",
  "postData",
];
// A state's own rule only takes effect once its transition finishes, and axe
// reads computed style at once; without this it would score the first frame
// of a fade, not where it lands.
const NO_TRANSITIONS_CSS =
  "*, *::before, *::after { transition: none !important; }";

// Every interactive element is forced at once rather than one at a time, in
// one axe run per state. An element's style keys on its own and its ancestors'
// state, so the union scores each element as its own hover would; the shape it
// misses is a sibling or :has() rule keyed on another element's state.
//
// The walk crosses shadow roots: a shadow root's children have its host as
// their element parent, so hovering inside a web component hovers the host and
// its ancestors, as a pointer does.
function forcedPseudoClasses(root, interactiveIds, state) {
  // The flat tree, which is where a state reaches: an element slotted into a
  // shadow root has its slot as parent, so hovering it hovers the slot's
  // wrappers inside the shadow tree before the host.
  const elementParent = new Map();
  const byBackendId = new Map();
  const slotted = [];
  const walk = (node, parent) => {
    byBackendId.set(node.backendNodeId, node.nodeId);
    const childParent = node.nodeType === ELEMENT_NODE ? node.nodeId : parent;
    for (const child of node.children ?? []) {
      if (childParent !== undefined)
        elementParent.set(child.nodeId, childParent);
      if (child.assignedSlot) slotted.push(child);
      walk(child, childParent);
    }
    for (const shadowRoot of node.shadowRoots ?? []) {
      walk(shadowRoot, node.nodeId);
    }
  };
  walk(root, undefined);
  for (const node of slotted) {
    const slot = byBackendId.get(node.assignedSlot.backendNodeId);
    if (slot !== undefined) elementParent.set(node.nodeId, slot);
  }
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

// Every shadow root in a pierced DOM tree, nested ones included.
function shadowRootsOf(node) {
  const roots = [];
  for (const root of node.shadowRoots ?? []) {
    roots.push(root, ...shadowRootsOf(root));
  }
  for (const child of node.children ?? []) roots.push(...shadowRootsOf(child));
  return roots;
}

async function interactiveNodeIds(cdp, root) {
  const ids = [];
  for (const scope of [root, ...shadowRootsOf(root)]) {
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
      nodeId: scope.nodeId,
      selector: INTERACTIVE_SELECTOR,
    });
    ids.push(...nodeIds);
  }
  return ids;
}

// A page's entries across both states: the issues each state found and the
// failure that stopped any of them, so a failure in one state does not hide
// what another already found.
export async function checkPageStates(browser, url, config, pa11y) {
  const entries = [];
  for (const state of FORCED_STATES) {
    const { issues, failure } = await checkPageState(
      browser,
      url,
      config,
      pa11y,
      state,
    );
    entries.push(...issues);
    if (failure) entries.push(failure);
  }
  return entries;
}

// One state per fresh page: pa11y binds listeners to a supplied page on every
// run and documents that a page cannot be reused between runs. Each state also
// gets its own browser context, so no cookie or storage a page sets reaches
// the next state's load. Returns the issues it scored and the failure that
// stopped or followed it, if any.
async function checkPageState(browser, url, config, pa11y, state) {
  let phase = "browser context";
  let context;
  let issues = [];
  let failure;
  try {
    context = await browser.createBrowserContext();
    phase = "page load";
    const page = await context.newPage();
    await page.setViewport(config.viewport ?? pa11y.defaults.viewport);
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: config.timeout,
    });
    // A document stylesheet does not reach into a shadow root, so each open
    // root adopts its own; a closed one axe cannot score anyway. Adopted, not
    // appended as a <style>, which would change which element is a root's
    // :last-child.
    await page.evaluate((css) => {
      const adopt = (scope) => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        scope.adoptedStyleSheets = [...scope.adoptedStyleSheets, sheet];
      };
      const visit = (scope) => {
        for (const element of scope.querySelectorAll("*")) {
          if (element.shadowRoot) {
            adopt(element.shadowRoot);
            visit(element.shadowRoot);
          }
        }
      };
      adopt(document);
      visit(document);
    }, NO_TRANSITIONS_CSS);
    phase = "forcing";
    const cdp = await page.createCDPSession();
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const nodeIds = await interactiveNodeIds(cdp, root);
    await forceStates(cdp, forcedPseudoClasses(root, nodeIds, state));
    phase = "axe";
    const result = await pa11y(url, {
      ...config,
      browser,
      page,
      ignoreUrl: true,
    });
    issues = result.issues
      .filter((issue) => issue.code === STATE_RULE)
      .map((issue) => ({
        ...issue,
        message: `${state.name}: ${issue.message}`,
      }));
  } catch (error) {
    failure = stateFailure(`${state.name} ${phase}`, error);
  }
  const closeFailure = await closeContext(context, state);
  if (closeFailure) {
    // Behind a failure already recorded it is logged, so the record keeps the
    // failure that stopped the page.
    if (failure)
      console.error(`${closeFailure.message} (after ${failure.message})`);
    else failure = closeFailure;
  }
  return { issues, failure };
}

// A context that will not close leaves the browser in doubt for every page
// after it, so on its own it fails the page.
async function closeContext(context, state) {
  if (!context) return undefined;
  try {
    await context.close();
    return undefined;
  } catch (error) {
    return stateFailure(`${state.name} closing the context`, error);
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
  #own-hover:hover, .wrapper:hover #wrapper-hover, #focus:focus-visible,
  #own-focus-within:focus-within {
    color: #bbb;
  }
</style></head><body><main>
  <p><a id="own-hover" href="#a">own hover</a></p>
  <div class="wrapper"><p><a id="wrapper-hover" href="#b">wrapper hover</a></p></div>
  <p><a id="focus" href="#c">focus</a></p>
  <p><a id="own-focus-within" href="#d">own focus-within</a></p>
  <p><shadow-control></shadow-control></p>
  <p><slot-control><a id="slotted-hover" href="#f">slotted hover</a></slot-control></p>
</main>
<script>
  customElements.define("shadow-control", class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML =
        '<style>a { color: #000; transition: color 5s; } a:last-child:hover { color: #bbb; }</style>' +
        '<a id="shadow-hover" href="#e">shadow hover</a>';
    }
  });
  customElements.define("slot-control", class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML =
        '<style>.wrapper:hover ::slotted(a) { color: #bbb !important; }</style>' +
        '<div class="wrapper"><slot></slot></div>';
    }
  });
</script></body></html>`;
// Each [state, selector] the control must fail. axe names an issue inside a
// shadow root by its host's selector, and cannot see into a closed one at all,
// at rest or forced, so the control's is open. The slotted rule is
// `!important` because the document's own `a` rule outranks a shadow tree's
// `::slotted` one otherwise, whatever state either is in.
const POSITIVE_CONTROL_EXPECTED = [
  [":hover", "#own-hover"],
  [":hover", "#wrapper-hover"],
  [":focus-visible", "#focus"],
  [":focus-visible", "#own-focus-within"],
  [":hover", "shadow-control"],
  [":hover", "#slotted-hover"],
];
// The control is scored under these settings and not the site's, so a site's
// `ignore`, `rootElement`, `hideElements` or `standard` cannot make its known
// failures pass.
function controlConfig(config) {
  return {
    runners: ["axe"],
    timeout: config.timeout,
    viewport: config.viewport,
  };
}

// A config the state pass cannot score as written, or null when it can.
export function unsupportedConfig(config) {
  if (!(config.runners ?? []).includes("axe")) {
    return "the state pass reads axe's results, so `runners` must name axe";
  }
  const set = UNSUPPORTED_SETTINGS.filter((key) => config[key] !== undefined);
  if (set.length > 0) {
    return `the state pass cannot apply ${set.map((key) => `\`${key}\``).join(", ")} before it forces states`;
  }
  return null;
}

async function checkPositiveControl(browser, config, pa11y) {
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(POSITIVE_CONTROL_HTML)}`;
  const entries = await checkPageStates(
    browser,
    url,
    controlConfig(config),
    pa11y,
  );
  const failure = entries.find((entry) => entry instanceof Error);
  if (failure) throw failure;
  const missed = POSITIVE_CONTROL_EXPECTED.filter(
    ([state, selector]) =>
      !entries.some(
        (issue) =>
          (issue.selector ?? "").split(/[\s,>]+/).includes(selector) &&
          issue.message.startsWith(`${state}:`),
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
  const unsupported = unsupportedConfig(config);
  if (unsupported)
    return failEveryPage(new Error(`state pass: ${unsupported}`));
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
