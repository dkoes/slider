import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";

const port = Number(process.env.PORT || 4173);
const root = resolve("dist");
const fallback = resolve(root, "slider.html");

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".pdf", "application/pdf"]
]);

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const filePath = url.pathname === "/" ? fallback : resolve(root, `.${url.pathname}`);
  const safePath = filePath.startsWith(root) ? filePath : fallback;
  const resolvedPath = existsSync(safePath) ? safePath : fallback;

  response.setHeader("Content-Type", contentTypes.get(extname(resolvedPath)) || "application/octet-stream");
  createReadStream(resolvedPath).pipe(response);
});

server.listen(port, () => {
  console.log(`Preview running at http://localhost:${port}`);
});
