// The site under test: which pages it has, the URL each is checked at, and the
// local static server that answers those URLs, under one routing convention.
//
// pa11y-ci loads pages by URL, so a directory of built HTML needs a server
// whose routing matches the host the site deploys to. A mismatch either 404s
// every canonical URL or serves a directory where a page was meant.

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

// `cloudflare` mirrors Cloudflare's static-asset routing (foo -> foo.html,
// foo/ -> foo/index.html), and pages are checked at their extensionless URLs.
// `files` checks each page at its own file path and serves only exact paths,
// plus index.html for a directory URL.
export const ROUTINGS = ["cloudflare", "files"];
export const DEFAULT_ROUTING = "cloudflare";

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

function checkRouting(routing) {
  if (!ROUTINGS.includes(routing)) {
    throw new Error(
      `unsupported routing ${JSON.stringify(routing)}; expected one of ${ROUTINGS.join(", ")}`,
    );
  }
}

export function findHtmlFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findHtmlFiles(full));
    else if (extname(entry.name) === ".html") results.push(full);
  }
  return results;
}

// The URL path a page is checked at.
export function pagePath(filePath, siteDir, routing = DEFAULT_ROUTING) {
  checkRouting(routing);
  const rel = relative(siteDir, filePath).split(sep).join("/");
  if (routing === "files") return `/${rel}`;
  if (basename(rel) === "index.html") {
    const dir = dirname(rel);
    if (dir === "." || dir === "") return "/";
    return `/${dir}/`;
  }
  return `/${rel.slice(0, -".html".length)}`;
}

export function resolveServedPath(siteDir, urlPath, routing = DEFAULT_ROUTING) {
  checkRouting(routing);
  const p = urlPath.split("?")[0].split("#")[0];
  if (p === "/" || p === "") return join(siteDir, "index.html");
  if (p.endsWith("/")) return join(siteDir, p, "index.html");
  const direct = join(siteDir, p);
  if (routing === "files") return direct;
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
  const rel = relative(siteDir, filePath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false;
  }
  return statSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false;
}

export function startStaticServer(siteDir, { routing = DEFAULT_ROUTING } = {}) {
  checkRouting(routing);
  return new Promise((resolveStart) => {
    const server = createServer((req, res) => {
      const filePath = resolveServedPath(siteDir, req.url, routing);
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
