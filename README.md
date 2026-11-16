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
  answers the extensionless URLs static hosts serve (`/about` serves
  `about.html`, `/docs/` serves `docs/index.html`), and every file at its own
  path too, so each page is checked at the URL it deploys at. A site with no
  pages fails rather than passing 0 of 0.
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
npm install --save-dev https://github.com/curlewlabs-com/static-a11y-check/releases/download/v0.2.0/static-a11y-check-0.2.0.tgz
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
npx static-a11y-check --www-dir dist --config a11y.json
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
`.card:hover a`, applies. A focused element is in `:focus-within` itself as
well. Elements inside open shadow roots are forced too, with each host as an
ancestor. All of a page's elements are forced at once, in one
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
- The configuration must name `axe` in `runners`, and may not set `actions`,
  `wait`, `headers`, `userAgent`, `method` or `postData`. pa11y applies those
  only after it is handed a page the state pass has already loaded and forced,
  so they would act too late; a run that sets one fails every page and says
  which.
- A closed shadow root is not scored at all: axe cannot see into one, at rest
  or forced. Nor is a page inside an `iframe` forced.
- A rule keyed on a sibling's state or on `:has()` is not scored, as above.

## Known issues

None open.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE), copyright Curlew Labs.
