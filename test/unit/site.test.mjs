// The static server and page URLs. Its URL-to-path resolution must mirror the
// host's routing exactly: a divergence makes pa11y-ci either 404 or read a
// directory - /apps returning the apps/ directory instead of apps.html.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findHtmlFiles, pagePath, startStaticServer } from "../../lib/site.mjs";

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), "static-a11y-site-"));
  writeFileSync(join(root, "index.html"), "<html><body>root</body></html>");
  writeFileSync(join(root, "about.html"), "<html><body>about</body></html>");
  writeFileSync(join(root, "apps.html"), "<html><body>apps</body></html>");
  mkdirSync(join(root, "apps"));
  writeFileSync(
    join(root, "apps", "one.html"),
    "<html><body>one</body></html>",
  );
  mkdirSync(join(root, "apps", "one"));
  writeFileSync(
    join(root, "apps", "one", "index.html"),
    "<html><body>one-index</body></html>",
  );
  writeFileSync(
    join(root, "apps", "one", "privacy.html"),
    "<html><body>privacy</body></html>",
  );
  mkdirSync(join(root, "empty"));
  writeFileSync(join(root, "style.css"), "body { color: red; }");
  writeFileSync(join(root, "module.mjs"), "export const x = 1;");
  return root;
}

async function withServer(routing, fn) {
  const root = makeTree();
  const { server, baseUrl } = await startStaticServer(root, { routing });
  try {
    await fn(baseUrl, root);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function get(baseUrl, path) {
  const res = await fetch(baseUrl + path);
  const text = await res.text();
  return { status: res.status, text, type: res.headers.get("content-type") };
}

// fetch normalizes `..` away before sending, as a browser does; a raw client
// sends the path as written.
function rawGet(baseUrl, path) {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolveGet, rejectGet) => {
    const req = request({ hostname, port, path, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolveGet(res.statusCode));
    });
    req.on("error", rejectGet);
    req.end();
  });
}

test("cloudflare routing: routes match Cloudflare static-asset rules", async () => {
  await withServer("cloudflare", async (baseUrl) => {
    let r = await get(baseUrl, "/");
    assert.equal(r.status, 200);
    assert.match(r.text, /root/);
    assert.match(r.type, /text\/html/);

    r = await get(baseUrl, "/about");
    assert.equal(r.status, 200);
    assert.match(r.text, /about/);

    // /apps must return apps.html, not the apps/ directory, even though the
    // directory exists; reading the directory failed with EISDIR.
    r = await get(baseUrl, "/apps");
    assert.equal(r.status, 200);
    assert.match(r.text, /apps/);

    r = await get(baseUrl, "/apps/one/");
    assert.equal(r.status, 200);
    assert.match(r.text, /one-index/);

    // Cloudflare prefers the sibling .html when both forms exist; so does
    // this server.
    r = await get(baseUrl, "/apps/one");
    assert.equal(r.status, 200);
    assert.match(r.text, /^<html><body>one<\/body>/);

    r = await get(baseUrl, "/apps/one/privacy");
    assert.equal(r.status, 200);
    assert.match(r.text, /privacy/);

    r = await get(baseUrl, "/style.css");
    assert.equal(r.status, 200);
    assert.match(r.text, /color: red/);
    assert.match(r.type, /text\/css/);

    r = await get(baseUrl, "/no-such-page");
    assert.equal(r.status, 404);
  });
});

// Chrome refuses a module script served without a JavaScript MIME type, so a
// page importing an .mjs would be scanned with none of its script run, and
// state the script sets would never be scored.
test("static server: serves .mjs as JavaScript", async () => {
  await withServer("cloudflare", async (baseUrl) => {
    const r = await get(baseUrl, "/module.mjs");
    assert.equal(r.status, 200);
    assert.match(r.type, /^application\/javascript/);
  });
});

// A directory with no page in it is not a file to send; reading it would
// throw inside the request handler and take the run down with it.
test("static server: a directory without a page is 404, not a crash", async () => {
  await withServer("cloudflare", async (baseUrl) => {
    assert.equal((await get(baseUrl, "/empty")).status, 404);
    assert.equal((await get(baseUrl, "/about")).status, 200);
  });
});

test("static server: a raw path that climbs out of the site is 404", async () => {
  await withServer("files", async (baseUrl) => {
    assert.equal(await rawGet(baseUrl, "/../../../../etc/hosts"), 404);
    assert.equal(await rawGet(baseUrl, "/about.html"), 200);
  });
});

test("files routing: serves exact paths and index.html for a directory", async () => {
  await withServer("files", async (baseUrl) => {
    assert.equal((await get(baseUrl, "/about.html")).status, 200);
    assert.equal((await get(baseUrl, "/about")).status, 404);
    assert.match((await get(baseUrl, "/")).text, /root/);
    assert.match((await get(baseUrl, "/apps/one/")).text, /one-index/);
    assert.match((await get(baseUrl, "/apps/one.html")).text, /one<\/body>/);
  });
});

// Each page must be checked at a URL its routing serves that page at, or the
// run scores a 404 page in its place.
test("pagePath: each page's URL serves that page under both routings", async () => {
  for (const routing of ["cloudflare", "files"]) {
    await withServer(routing, async (baseUrl, root) => {
      for (const file of findHtmlFiles(root)) {
        const path = pagePath(file, root, routing);
        const served = await get(baseUrl, path);
        assert.equal(served.status, 200, `${routing} ${path}`);
        assert.equal(
          served.text,
          readFileSync(file, "utf8"),
          `${routing} ${path}`,
        );
      }
    });
  }
});

test("pagePath: cloudflare URLs drop .html and index.html", () => {
  assert.equal(pagePath("/s/index.html", "/s"), "/");
  assert.equal(pagePath("/s/about.html", "/s"), "/about");
  assert.equal(pagePath("/s/a/b/index.html", "/s"), "/a/b/");
  assert.equal(pagePath("/s/a/b/index.html", "/s", "files"), "/a/b/index.html");
});

test("an unknown routing is refused rather than read as the default", async () => {
  assert.throws(
    () => pagePath("/s/index.html", "/s", "netlify"),
    /unsupported routing/,
  );
  assert.throws(
    () => startStaticServer("/s", { routing: "netlify" }),
    /unsupported routing/,
  );
});
