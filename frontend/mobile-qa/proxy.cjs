// 巡检用的本地静态服务器 + API 反代：直接读 frontend/dist，静态资源秒开；
// API / WebSocket 原样转发到 8086 后端。只为提速巡检，不参与部署，也不改任何业务代码。
// 用法： node proxy.js   然后  BASE=http://127.0.0.1:5199 node scan.js
const http = require("http"), fs = require("fs"), path = require("path"), net = require("net");
const DIST = require("path").join(__dirname, "..", "dist");
const PREFIX = ["/api", "/score-api", "/rollcall-api", "/downloads-api"];
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon", ".webp": "image/webp" };
const server = http.createServer((req, res) => {
  let u; try { u = decodeURIComponent(req.url.split("?")[0]); } catch (e) { u = req.url.split("?")[0]; }
  if (PREFIX.some((p) => u === p || u.startsWith(p + "/"))) {
    const pr = http.request({ host: "127.0.0.1", port: 8086, path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: "localhost:8086" }) }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
    pr.on("error", () => { res.writeHead(502, { "content-type": "text/plain" }); res.end("proxy error"); });
    req.pipe(pr); return;
  }
  const fp = path.join(DIST, u === "/" ? "index.html" : u);
  if (!fp.startsWith(path.resolve(DIST))) { res.writeHead(403); return res.end("forbidden"); }
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); return fs.createReadStream(path.join(fp, "index.html")).pipe(res); }
  if (!fs.existsSync(fp)) { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); return fs.createReadStream(path.join(DIST, "index.html")).pipe(res); }
  res.writeHead(200, { "content-type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream", "cache-control": "no-store", "content-length": fs.statSync(fp).size });
  fs.createReadStream(fp).pipe(res);
}).on("upgrade", (req, socket, head) => {
  const t = net.connect(8086, "127.0.0.1", () => {
    const lines = [req.method + " " + req.url + " HTTP/1.1"];
    for (let i = 0; i < req.rawHeaders.length; i += 2) { const k = req.rawHeaders[i]; if (/^host$/i.test(k)) continue; lines.push(k + ": " + req.rawHeaders[i + 1]); }
    lines.push("Host: localhost:8086");
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) socket.write(head);
    socket.pipe(t); t.pipe(socket);
  });
  t.on("error", () => socket.destroy()); socket.on("error", () => t.destroy());
});
server.listen(5199, "127.0.0.1", () => console.log("static proxy on http://127.0.0.1:5199"));
