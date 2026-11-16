# static-a11y-check

## What it is

A command that checks every page of a built static site for accessibility
errors, including color contrast that fails only while an element is hovered or
keyboard-focused.

It serves the site's directory on a local port, runs
[pa11y-ci](https://github.com/pa11y/pa11y-ci) (axe-core) over every `.html`
page, and then runs a second pass that loads each page again with `:hover` and
`:focus-visible` forced on every interactive element and scores color contrast
there too. Both passes land in one report, and the command exits non-zero if any
page has an error or could not be checked at all (pa11y-ci's `threshold`, zero
unless set, loosens the resting pass; see Limits).

## Why it exists

axe scores a page as it renders at rest. A button whose text fades to a pale
grey on hover, or a link whose focus style drops below the WCAG AA contrast
ratio, passes every axe run, because nothing hovers or focuses anything during
the scan. Triggering the state in a browser and scanning again is a known manual
technique; this packages it for a whole site, in CI.

It also closes three gaps in running pa11y-ci by hand over a static build:

- **URLs for a directory of files.** pa11y-ci needs URLs. The built-in server
  can mirror Cloudflare's static-asset routing (`/about` serves `about.html`,
  `/docs/` serves `docs/index.html`), so each page is checked at the URL it
  deploys at, or serve each file at its own path.
- **Technical failures fail the run.** pa11y-ci records a page it could not
  load (a navigation timeout, a crashed renderer) as an `Error` without counting
  it in `report.errors`. This command counts anything short of a pass as a
  failure.
- **A record of a flake.** A failing run writes a JSON record with the host's
  load average and memory before and after the run, its duration, and every
  failure with its stack, so a navigation timeout on an overloaded CI machine
  can be told from a real regression without re-running.

The forced-state pass checks itself first: it scores a built-in page that only
a forced state breaks, and if that page comes back clean (a browser change that
stopped forcing from taking effect, say), every real page fails instead of
reading green.

## How to use it

Node 24 or later. Install it from a release's package tarball:

```sh
npm install --save-dev https://github.com/curlewlabs-com/static-a11y-check/releases/download/v0.1.0/static-a11y-check-0.1.0.tgz
```

Its one dependency, pa11y-ci, brings puppeteer, which downloads the browser it
pins when it installs. If your package manager holds back dependency install
scripts, run `node node_modules/puppeteer/install.mjs` once.

Put a pa11y-ci configuration beside the site, for example `.pa11yci.json`. It
must name `axe` in `runners`: pa11y's default runner is HTML_CodeSniffer, whose
results the state pass does not read, so without axe its self-check fails every
page.

```json
{
  "defaults": {
    "runners": ["axe"],
    "standard": "WCAG2AA",
    "timeout": 60000,
    "ignore": []
  }
}
```

Then, from the directory holding `www/` and `.pa11yci.json`:

```sh
npx static-a11y-check
```

or name them:

```sh
npx static-a11y-check --www-dir dist --config a11y.json --routing files
```

A failing page prints like this:

```text
FAIL  / - 1 error(s)
  [color-contrast] :hover: Elements must meet minimum color contrast ratio thresholds
    selector: html > body > main > p > a
```

### Options

| Option                        | Default            | Meaning                                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--www-dir <dir>`             | `www`              | The built site to serve.                                                                                                                                                                                                                                               |
| `--config <file>`             | `.pa11yci.json`    | The pa11y-ci configuration. Its `defaults` (or the whole file, if it has none) apply to every page, so `ignore` there is a site-wide allowlist.                                                                                                                        |
| `--routing <name>`            | `cloudflare`       | `cloudflare`: `/foo` serves `foo.html`, then `foo/index.html`; `/foo/` serves `foo/index.html`. `files`: each page is checked at its own file path.                                                                                                                    |
| `--diagnostics-dir <dir>`     | `a11y-diagnostics` | Where a failing run writes its record. A passing run writes nothing there.                                                                                                                                                                                             |
| `--output <file>`             |                    | On a passing run, write a JSON summary: the pages checked and, with `--browser`, the browser's revision.                                                                                                                                                               |
| `--browser <path>`            |                    | Run this browser instead of puppeteer's download. Needs `--browser-manifest` and `--browser-runtime-mode`.                                                                                                                                                             |
| `--browser-manifest <file>`   |                    | JSON whose `version` is the browser's revision. It must equal the revision puppeteer pins, and the browser's `--version` must report it.                                                                                                                               |
| `--browser-runtime-mode <m>`  |                    | `system_macos`: the host's libraries. `declared_linux`: the `--browser-library-dir` directories and the `--browser-fontconfig` file replace the host's `LD_LIBRARY_PATH` and `FONTCONFIG_FILE`. The loader's own cache and default directories still apply after them. |
| `--browser-library-dir <dir>` |                    | A library directory for `declared_linux`; repeat for more.                                                                                                                                                                                                             |
| `--browser-fontconfig <file>` |                    | The Fontconfig file for `declared_linux`.                                                                                                                                                                                                                              |
| `--profile-dir <dir>`         |                    | The browser profile directory for `--browser`.                                                                                                                                                                                                                         |

Running as root, or on a Linux CI image that restricts unprivileged user
namespaces (Ubuntu 24.04 does), Chrome needs
`"chromeLaunchConfig": { "args": ["--no-sandbox"] }` in the configuration.

### What the state pass covers

Each interactive element (links, buttons, form controls, `summary`, and
anything with a non-negative `tabindex`) is put in the state, and its ancestors
in `:hover` or `:focus-within`, so a rule keyed on a wrapper's state, such as
`.card:hover a`, applies. All of a page's elements are forced at once, in one
axe run per state. That scores each element as its own hover would, except for
a rule keyed on a sibling's state or on `:has()`. Transitions are switched off
first, so the score is where a fade ends, not its first frame. Only
`color-contrast` is kept from the forced runs: the other axe rules score
structure that a state does not change, and the resting pass already has their
verdict.

### From code

```js
import { runChecks, printReport, runFailed } from "static-a11y-check";

const { report, baseUrl } = await runChecks({ wwwDir: "dist" });
if (runFailed(report, printReport(report, baseUrl))) process.exitCode = 1;
```

## Limits

- WCAG 2.1 AA, not 2.2: pa11y's axe runner fixes its tag list to the WCAG 2.0
  and 2.1 A and AA tags plus best practice. The other new 2.2 AA criteria are
  behavioral and need a manual audit on any tool.
- One configuration for every page: pa11y-ci's per-URL configuration is not
  read.
- Diagnostics records are named after `GITHUB_RUN_ID` and
  `GITHUB_RUN_ATTEMPT` when they are set, and `local-0` otherwise.
- pa11y-ci's `threshold` applies to the resting pass only: a page with no
  more resting errors than the threshold reads as a pass there, while every
  contrast error the state pass finds still fails the page.

## Known issues

These are open in the issue tracker. Each makes a run miss a failure, or report
one less fully, in a narrow case; none lets anything outside the run trigger
it.

- The state pass finds and forces elements before pa11y applies the page
  settings it applies after navigation (`actions`, `wait`, `headers`,
  `userAgent`), so an element those add or change is scored unforced. The
  forced-state self-check also inherits the site's scoring settings
  (`actions`, `rootElement`, `hideElements`, `ignore`, `standard`), and can
  fail on a page they do not fit.
- Elements inside shadow roots are not forced.
- With `includeWarnings` or `includeNotices`, a contrast warning from the state
  pass fails the page but prints as `PASS` and is left out of the failure
  record.
- A page file whose name holds a character with a meaning in a URL (`#`, `?`,
  `%`, a space) is requested at a URL that does not reach it, and with `#` can
  be scored as another page.
- A site directory with no `.html` pages passes, with `0/0`.
- An element's own `:focus-within` rule is not forced; only its ancestors'
  are.
- When one state's pass fails on a page, the issues the other state found on
  it are dropped, leaving only the technical failure in the record.
- `--browser-manifest`'s revision is matched as a substring of the browser's
  reported version.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE), copyright Curlew Labs.
