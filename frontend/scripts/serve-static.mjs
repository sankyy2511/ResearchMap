// Serves out/ the way Firebase Hosting does (clean URLs and the rewrites in firebase.json), to test the static
// build on this computer before deploying.  Run: node scripts/serve-static.mjs  (then open http://localhost:5050)
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../out", import.meta.url));
const config = JSON.parse(readFileSync(fileURLToPath(new URL("../firebase.json", import.meta.url)), "utf8")).hosting;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".txt": "text/plain",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".zip": "application/zip",
  ".woff2": "font/woff2", ".webp": "image/webp", ".jpg": "image/jpeg" };
const asRegex = (glob) => new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/]+").replace(/§/g, ".*") + "$");
const rewrites = config.rewrites.map((r) => ({ re: asRegex(r.source), to: r.destination }));
const file = (p) => existsSync(p) && statSync(p).isFile() ? p : null;

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let hit = file(join(root, path)) || file(join(root, path + ".html")) || file(join(root, path, "index.html"));
  if (!hit) {
    const r = rewrites.find((x) => x.re.test(path));
    if (r) hit = file(join(root, r.to));
  }
  if (!hit) {
    res.writeHead(404, { "Content-Type": types[".html"] });
    return res.end(readFileSync(join(root, "404.html")));
  }
  res.writeHead(200, { "Content-Type": types[extname(hit)] || "application/octet-stream" });
  res.end(readFileSync(hit));
}).listen(5050, () => console.log("Static site on http://localhost:5050"));
