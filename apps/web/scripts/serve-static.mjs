// Plain static file server for out/, mimicking a Swarm manifest: exact paths and directory
// indexes only, no rewrites, 404.html as the error document.
//   node scripts/serve-static.mjs [port] [prefix]     e.g. 8080 /bzz/<ref>
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
const port = Number(process.argv[2] ?? 8080);
const prefix = (process.argv[3] ?? "").replace(/\/$/, "");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const send = (status, file) => {
    res.writeHead(status, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  };
  if (prefix && !path.startsWith(`${prefix}/`)) return send404();
  const rel = normalize(path.slice(prefix.length)).replace(/^(\.\.[/\\])+/, "");
  let file = join(out, rel);
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!path.endsWith("/")) {
      res.writeHead(301, { location: `${path}/` });
      return res.end();
    }
    file = join(file, "index.html");
  }
  if (existsSync(file) && statSync(file).isFile()) return send(200, file);
  send404();
  function send404() {
    send(404, join(out, "404.html"));
  }
}).listen(port, "127.0.0.1", () => console.log(`static out/ on http://127.0.0.1:${port}${prefix}/`));
