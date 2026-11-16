# Contributing

Thanks for your interest in improving `static-a11y-check`. It is a focused
tool, so the bar for a change is "does this make the checks catch more real
accessibility failures, or report them more clearly, without letting a broken
run read as green". Bug fixes and clearer docs are
all welcome.

## Before a large change

Open an issue describing the problem first. The run's verdict rests on a few
invariants - a technical failure counts as a failure, a page that fails a state
stops counting as a pass, the state pass proves forcing works before trusting
any page - so a short discussion up front saves rework.

## Running the checks

These are the checks CI runs on every push and pull request:

```sh
npm ci
npm test            # unit tests, no browser
npm run test:e2e    # the command against fixture sites, in puppeteer's browser
```

If `npm ci` held back puppeteer's install script, fetch its browser with
`node node_modules/puppeteer/install.mjs` before the end-to-end suite.

## Conventions

- **Tests ship with the change.** A bug fix or feature includes a test in the
  same pull request.
- **Prove it in a browser.** Whether a state was forced, or a page was scored,
  only a real browser shows. A change to the state pass needs a fixture page
  that the change makes pass or fail in the end-to-end suite.
- **No change-detector tests.** A test that pins an exact log string or a whole
  record fails on every legitimate edit while catching nothing. Test the
  invariant instead.
- **Pin dependencies exactly.** `package.json` and the workflow pins are exact
  versions, and actions are pinned by commit. Match that when adding any.
- **Comments explain _why_, not _what_.**
- **Keep tracked text ASCII.** Use plain hyphens, `->`, and words instead of
  Unicode punctuation.

## Submitting

Keep each pull request focused on one change, make sure CI passes, and describe
the _why_ in the PR body.

## Releasing

Releases use fixed `vMAJOR.MINOR.PATCH` tags. The repository blocks updates and
deletions of those tags, and publishing the GitHub Release makes its tag and
release assets immutable. After merging the release commit to `main`, tag it,
build the package with `npm pack`, and create the release as a draft with the
tarball attached; check it, then publish it.
