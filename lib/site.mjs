// The site under test: which pages it has, the URL each is checked at, and the
// local static server that answers those URLs.
//
// pa11y-ci loads pages by URL, so a directory of built HTML needs a server.
// Its routing is the extensionless convention static hosts share (foo ->
// foo.html, foo/ -> foo/index.html), and it also serves every file at its own
// path, so a site whose links name .html files is answered too. Pages are
// checked at their extensionless URLs.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function findHtmlFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findHtmlFiles(full));
    else if (extname(entry.name) === ".html") results.push(full);
  }
  return results;
}

// The URL path a page is checked at. Each segment is percent-encoded, so a
// file name holding `#`, `?`, `%` or a space names that file rather than a
// fragment, a query or an escape.
export function pagePath(filePath, siteDir) {
  const rel = relative(siteDir, filePath).split(sep).join("/");
  let path;
  if (basename(rel) === "index.html") {
    const dir = dirname(rel);
    path = dir === "." || dir === "" ? "" : `${dir}/`;
  } else {
    path = rel.slice(0, -".html".length);
  }
  return `/${path.split("/").map(encodeURIComponent).join("/")}`;
}

// The file a request path names, or null for one that does not decode.
export function resolveServedPath(siteDir, urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
  if (p === "/" || p === "") return join(siteDir, "index.html");
  if (p.endsWith("/")) return join(siteDir, p, "index.html");
  const direct = join(siteDir, p);
  // foo.html before foo/index.html before foo itself, so an extensionless URL
  // like /apps, where apps/ is a directory but apps.html is the page, does not
  // fall through to reading a directory.
  if (existsSync(direct + ".html")) return direct + ".html";
  if (existsSync(join(direct, "index.html"))) {
    return join(direct, "index.html");
  }
  return direct;
}

// A file inside the site: a raw request path can climb out of it through `..`,
// which a browser normalizes away but a client sending the path as is does not.
function isServableFile(siteDir, filePath) {
  if (filePath === null) return false;
  const rel = relative(siteDir, filePath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false;
  }
  return statSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false;
}

export function startStaticServer(siteDir) {
  return new Promise((resolveStart) => {
    const server = createServer((req, res) => {
      const filePath = resolveServedPath(siteDir, req.url);
      if (!isServableFile(siteDir, filePath)) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const type = MIME[extname(filePath)] || "application/octet-stream";
      res.setHeader("Content-Type", type);
      res.end(readFileSync(filePath));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveStart({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}
