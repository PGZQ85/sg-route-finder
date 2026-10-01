// Minimal zero-dependency static server: node server.js [port]
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const port = +process.argv[2] || +process.env.PORT || 5173;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.normalize(path.join(root, url === "/" ? "index.html" : url));
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel) || /^(scripts|node_modules)([\\/]|$)/.test(rel)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  });
}).listen(port, () => console.log(`SG Route Finder on http://localhost:${port}`));
