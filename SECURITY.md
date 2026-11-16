# Security Policy

`static-a11y-check` runs a browser over a site you point it at and serves that
site's directory on a loopback port for the length of the run. Its security
surface is that server - it answers only on `127.0.0.1`, only with regular
files, and refuses a request path whose `..` segments climb out of the site
directory - and the browser it launches, which loads the site's own pages and
whatever they load. A symlink inside the site directory is followed, wherever
it points, so a site directory should not hold links to files you would not
serve.

## Supported versions

This is a pre-1.0 project: fixes land on `main` and in the latest tagged
release. There are no maintained older release branches.

## Reporting a vulnerability

Report security issues **privately** - do not open a public issue. Use GitHub's
private vulnerability reporting: open the repository's **Security** tab and
choose **"Report a vulnerability"**, which opens a private advisory visible only
to the maintainers.

Helpful details to include:

- Node version and operating system
- The exact command and configuration
- What you observed versus expected
- A minimal reproduction, if you have one

This is a small project, so responses are best-effort rather than on a fixed
SLA; we will acknowledge and work toward a fix as soon as we reasonably can.

## Scope

In scope: the static server answering on another interface, or serving a path
outside the site directory other than through a symlink the site holds; and a
run that reports a pass for a page it did not check.

Out of scope: what the site's own pages do in the browser. The checks run the
pages you give them; run them only on sites you trust to execute on that host.
