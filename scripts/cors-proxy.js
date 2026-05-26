import { createServer } from "node:http";

const port = Number(process.env.PORT || 8787);
const allowedHosts = [
  ".sharepoint.com",
  "api.onedrive.com",
  "graph.microsoft.com"
];

const server = createServer(async (request, response) => {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const target = requestUrl.searchParams.get("url");

    if (!target) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Missing url parameter.");
      return;
    }

    const targetUrl = new URL(target);
    if (!isAllowedHost(targetUrl.hostname)) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Target host is not allowed.");
      return;
    }

    const upstream = await fetchWithCookieRedirects(targetUrl, request.headers.accept || "*/*");

    response.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Final-Url": upstream.url
    });

    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`CORS fallback proxy running at http://127.0.0.1:${port}?url={encoded-url}`);
});

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  response.setHeader("Access-Control-Expose-Headers", "X-Final-Url");
}

async function fetchWithCookieRedirects(targetUrl, accept, maxRedirects = 8) {
  let currentUrl = targetUrl;
  const cookies = new Map();

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const upstream = await fetch(currentUrl, {
      headers: {
        Accept: accept,
        Cookie: serializeCookies(cookies),
        "User-Agent": "Mozilla/5.0 SliderCorsProxy/1.0"
      },
      redirect: "manual"
    });

    storeCookies(cookies, upstream.headers);

    if (![301, 302, 303, 307, 308].includes(upstream.status)) {
      return upstream;
    }

    const location = upstream.headers.get("location");
    if (!location) {
      return upstream;
    }

    currentUrl = new URL(location, currentUrl);
    if (!isAllowedHost(currentUrl.hostname)) {
      throw new Error(`Redirect target host is not allowed: ${currentUrl.hostname}`);
    }
  }

  throw new Error("Too many redirects.");
}

function storeCookies(cookies, headers) {
  const rawCookies = getSetCookieHeaders(headers);
  for (const rawCookie of rawCookies) {
    const [pair] = rawCookie.split(";");
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex > 0) {
      cookies.set(pair.slice(0, separatorIndex).trim(), pair.slice(separatorIndex + 1).trim());
    }
  }
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const raw = headers.get("set-cookie");
  return raw ? splitCombinedSetCookieHeader(raw) : [];
}

function splitCombinedSetCookieHeader(header) {
  return header.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g).map((cookie) => cookie.trim());
}

function serializeCookies(cookies) {
  return Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; ");
}

function isAllowedHost(hostname) {
  return allowedHosts.some((allowedHost) => (
    allowedHost.startsWith(".")
      ? hostname.endsWith(allowedHost)
      : hostname === allowedHost
  ));
}
