#!/usr/bin/env python3
"""Sync an anonymous SharePoint folder locally and serve the slider UI."""

from __future__ import annotations

import argparse
import contextlib
import http.cookiejar
import json
import mimetypes
import os
import posixpath
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from typing import Any


SUPPORTED_EXTENSIONS = {
    ".png": "image",
    ".pdf": "pdf",
    ".html": "html",
    ".htm": "html",
}

DEFAULT_FOLDER_URL = ""
DEFAULT_PORT = 8788
DEFAULT_SYNC_INTERVAL_SECONDS = 120
DEFAULT_STALE_AFTER_SECONDS = 600
EMBEDDED_SLIDER_HTML = None


@dataclass
class AgentConfig:
    folder_url: str
    host: str
    port: int
    web_root: Path
    data_dir: Path
    sync_interval_seconds: int
    stale_after_seconds: int
    once: bool

    @property
    def slides_dir(self) -> Path:
        return self.data_dir / "slides"

    @property
    def manifest_path(self) -> Path:
        return self.data_dir / "manifest.json"


def main() -> int:
    config = parse_args()
    config.data_dir.mkdir(parents=True, exist_ok=True)
    config.slides_dir.mkdir(parents=True, exist_ok=True)

    syncer = SharePointSyncer(config)
    if config.once:
        syncer.sync_once()
        return 0

    thread = threading.Thread(target=sync_loop, args=(syncer, config.sync_interval_seconds), daemon=True)
    thread.start()

    server = ThreadingHTTPServer((config.host, config.port), make_handler(config))
    print(f"Slider agent serving http://{config.host}:{config.port}/slider.html")
    print(f"Syncing {config.folder_url}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping slider agent.")
    finally:
        server.server_close()
    return 0


def parse_args() -> AgentConfig:
    root = Path(__file__).resolve().parents[1]
    default_data_dir = root / "slider_data"
    local_config = read_json(root / "slider_config.json")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folder", default=get_config_value(local_config, "folder_url", "SLIDER_FOLDER_URL", DEFAULT_FOLDER_URL))
    parser.add_argument("--host", default=get_config_value(local_config, "host", "SLIDER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(get_config_value(local_config, "port", "SLIDER_PORT", DEFAULT_PORT)))
    parser.add_argument("--web-root", type=Path, default=root / "dist")
    parser.add_argument("--data-dir", type=Path, default=Path(get_config_value(local_config, "data_dir", "SLIDER_DATA_DIR", default_data_dir)))
    parser.add_argument("--sync-interval", type=int, default=int(get_config_value(local_config, "sync_interval_seconds", "SLIDER_SYNC_INTERVAL_SECONDS", DEFAULT_SYNC_INTERVAL_SECONDS)))
    parser.add_argument("--stale-after", type=int, default=int(get_config_value(local_config, "stale_after_seconds", "SLIDER_STALE_AFTER_SECONDS", DEFAULT_STALE_AFTER_SECONDS)))
    parser.add_argument("--once", action="store_true", help="Run one sync and exit.")
    args = parser.parse_args()

    return AgentConfig(
        folder_url=args.folder,
        host=args.host,
        port=args.port,
        web_root=args.web_root.resolve(),
        data_dir=args.data_dir.resolve(),
        sync_interval_seconds=max(10, args.sync_interval),
        stale_after_seconds=max(30, args.stale_after),
        once=args.once,
    )


def get_config_value(config: dict[str, Any], key: str, env_name: str, fallback: Any) -> str:
    if os.environ.get(env_name):
        return os.environ[env_name]

    value = config.get(key)
    if value not in (None, ""):
        return str(value)

    return str(fallback)


def sync_loop(syncer: "SharePointSyncer", interval_seconds: int) -> None:
    while True:
        syncer.sync_once()
        time.sleep(interval_seconds)


class SharePointSyncer:
    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self.lock = threading.Lock()
        self.opener = build_opener()

    def sync_once(self) -> None:
        with self.lock:
            attempt = utc_now()
            try:
                slides = self.fetch_slides()
                self.remove_unlisted_files(slides)
                manifest = {
                    "generatedAt": attempt,
                    "source": self.config.folder_url,
                    "sync": {
                        "status": "ok",
                        "error": "",
                        "lastAttempt": attempt,
                        "lastSuccess": attempt,
                        "staleAfterSeconds": self.config.stale_after_seconds,
                    },
                    "slides": slides,
                }
                write_json_atomic(self.config.manifest_path, manifest)
                print(f"{attempt} synced {len(slides)} slides.")
            except Exception as error:  # noqa: BLE001 - keep the display alive on every sync failure.
                self.write_failure_manifest(attempt, str(error))
                print(f"{attempt} sync failed: {error}", file=sys.stderr)

    def fetch_slides(self) -> list[dict[str, str]]:
        if not self.config.folder_url:
            raise RuntimeError(
                "No SharePoint folder URL is configured. Set --folder, SLIDER_FOLDER_URL, or folder_url in slider_config.json."
            )

        page_response = self.fetch_text(self.config.folder_url)
        page_context = parse_page_metadata(page_response.text)
        drive_url, access_token = get_drive_api_credentials(page_context["driveInfo"])
        if not drive_url or not access_token:
            raise RuntimeError("SharePoint page did not expose anonymous drive metadata.")

        server_relative_path = page_context.get("rootFolder") or get_shared_folder_server_relative_path(
            page_response.final_url,
            page_response.text,
        )
        drive_relative_path = get_drive_relative_path(server_relative_path, page_context.get("listUrl", ""))
        children_url = make_children_url(drive_url, access_token, drive_relative_path)
        payload = self.fetch_json(children_url)
        children = payload.get("value")
        if not isinstance(children, list):
            raise RuntimeError("SharePoint children response did not contain a value list.")

        slides: list[dict[str, str]] = []
        used_names: set[str] = set()
        for child in children:
            if not isinstance(child, dict) or "file" not in child:
                continue

            slide = self.sync_child(child, used_names)
            if slide:
                slides.append(slide)

        return sorted(slides, key=lambda slide: slide["name"].lower())

    def sync_child(self, child: dict[str, Any], used_names: set[str]) -> dict[str, str] | None:
        name = str(child.get("name") or "")
        extension = Path(name).suffix.lower()
        kind = SUPPORTED_EXTENSIONS.get(extension)
        download_url = child.get("@content.downloadUrl") or child.get("@microsoft.graph.downloadUrl")
        if not name or not kind or not isinstance(download_url, str):
            return None

        local_name = unique_name(safe_filename(name), used_names)
        local_path = self.config.slides_dir / local_name
        modified = str(child.get("lastModifiedDateTime") or child.get("cTag") or child.get("eTag") or "")
        existing = find_existing_slide(self.config.manifest_path, str(child.get("id") or name))
        if (
            existing
            and existing.get("modified") == modified
            and isinstance(existing.get("url"), str)
            and (self.config.data_dir / existing["url"].lstrip("/")).exists()
        ):
            return {
                "id": str(child.get("id") or name),
                "name": name,
                "kind": kind,
                "url": existing["url"],
                "modified": modified,
            }

        download_atomic(self.opener, download_url, local_path)
        return {
            "id": str(child.get("id") or name),
            "name": name,
            "kind": kind,
            "url": f"/slides/{urllib.parse.quote(local_name)}",
            "modified": modified,
        }

    def remove_unlisted_files(self, slides: list[dict[str, str]]) -> None:
        wanted = {urllib.parse.unquote(Path(slide["url"]).name) for slide in slides}
        for path in self.config.slides_dir.iterdir():
            if path.is_file() and path.name not in wanted:
                with contextlib.suppress(OSError):
                    path.unlink()

    def write_failure_manifest(self, attempt: str, error: str) -> None:
        manifest = read_json(self.config.manifest_path) or {}
        sync = manifest.get("sync") if isinstance(manifest.get("sync"), dict) else {}
        manifest["generatedAt"] = attempt
        manifest["source"] = self.config.folder_url
        manifest["sync"] = {
            "status": "error",
            "error": error,
            "lastAttempt": attempt,
            "lastSuccess": sync.get("lastSuccess", ""),
            "staleAfterSeconds": self.config.stale_after_seconds,
        }
        manifest["slides"] = manifest.get("slides") if isinstance(manifest.get("slides"), list) else []
        write_json_atomic(self.config.manifest_path, manifest)

    def fetch_text(self, url: str) -> "TextResponse":
        request = urllib.request.Request(url, headers=default_headers("text/html,*/*"))
        try:
            with self.opener.open(request, timeout=45) as response:
                body = response.read()
                charset = response.headers.get_content_charset() or "utf-8"
                final_url = response.geturl()
                reject_auth_redirect(final_url)
                return TextResponse(final_url, body.decode(charset, errors="replace"))
        except urllib.error.HTTPError as error:
            raise_auth_error(error)
            raise

    def fetch_json(self, url: str) -> dict[str, Any]:
        request = urllib.request.Request(url, headers=default_headers("application/json,*/*"))
        try:
            with self.opener.open(request, timeout=45) as response:
                reject_auth_redirect(response.geturl())
                body = response.read()
                charset = response.headers.get_content_charset() or "utf-8"
                payload = json.loads(body.decode(charset, errors="replace"))
                if not isinstance(payload, dict):
                    raise RuntimeError("JSON response was not an object.")
                return payload
        except urllib.error.HTTPError as error:
            raise_auth_error(error)
            raise


@dataclass
class TextResponse:
    final_url: str
    text: str


def build_opener() -> urllib.request.OpenerDirector:
    cookie_jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))


def default_headers(accept: str) -> dict[str, str]:
    return {
        "Accept": accept,
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
    }


def reject_auth_redirect(final_url: str) -> None:
    host = urllib.parse.urlparse(final_url).hostname or ""
    if host.endswith("login.microsoftonline.com"):
        raise RuntimeError(get_auth_required_message())


def raise_auth_error(error: urllib.error.HTTPError) -> None:
    final_url = error.geturl()
    host = urllib.parse.urlparse(final_url).hostname or ""
    if error.code in (401, 403) or host.endswith("login.microsoftonline.com"):
        raise RuntimeError(get_auth_required_message()) from error


def get_auth_required_message() -> str:
    return (
        "SharePoint requires authentication for this link. "
        "Use an anonymous 'Anyone with the link can view' folder link."
    )


def parse_page_metadata(html: str) -> dict[str, Any]:
    marker = "var _spPageContextInfo="
    start = html.find(marker)
    if start < 0:
        raise RuntimeError("SharePoint page context was not found.")

    json_start = start + len(marker)
    json_end = html.find(";_spPageContextInfo", json_start)
    if json_end < 0:
        raise RuntimeError("SharePoint page context was incomplete.")

    context = json.loads(html[json_start:json_end])
    if not isinstance(context, dict):
        raise RuntimeError("SharePoint page context was not an object.")

    drive_info = context.get("driveInfo") if isinstance(context.get("driveInfo"), dict) else {}
    context["driveInfo"] = {
        **drive_info,
        **optional_value(".driveUrl", extract_loose_json_string(html, ".driveUrl")),
        **optional_value(".driveUrlV21", extract_loose_json_string(html, ".driveUrlV21")),
        **optional_value(".driveAccessToken", extract_loose_json_string(html, ".driveAccessToken")),
        **optional_value(".driveAccessTokenV21", extract_loose_json_string(html, ".driveAccessTokenV21")),
    }
    context["rootFolder"] = context.get("rootFolder") or extract_loose_json_string(html, "rootFolder")
    return context


def optional_value(key: str, value: str) -> dict[str, str]:
    return {key: value} if value else {}


def get_drive_api_credentials(drive_info: dict[str, str]) -> tuple[str, str]:
    if drive_info.get(".driveUrlV21") and drive_info.get(".driveAccessTokenV21"):
        return drive_info[".driveUrlV21"], drive_info[".driveAccessTokenV21"]

    if drive_info.get(".driveUrl") and drive_info.get(".driveAccessToken"):
        return drive_info[".driveUrl"], drive_info[".driveAccessToken"]

    return "", ""


def extract_loose_json_string(html: str, key: str) -> str:
    match = re.search(rf'"{re.escape(key)}"\s*:\s*"([^"]+)"', html)
    return parse_json_string_literal(match.group(1)) if match else ""


def parse_json_string_literal(value: str) -> str:
    return json.loads('"' + value.replace('"', '\\"') + '"')


def get_shared_folder_server_relative_path(response_url: str, html: str) -> str:
    parsed = urllib.parse.urlparse(response_url)
    query = urllib.parse.parse_qs(parsed.query)
    if query.get("id"):
        return query["id"][0]

    match = re.search(r"onedrive\.aspx\?id=([^\"'&<]+)", html, re.IGNORECASE)
    if match:
        return html_unescape(urllib.parse.unquote(match.group(1)))

    encoded_match = re.search(r"onedrive%2Easpx%3Fid%3D([^\"'&<]+)", html, re.IGNORECASE)
    if encoded_match:
        return html_unescape(urllib.parse.unquote(urllib.parse.unquote(encoded_match.group(1))))

    return ""


def get_drive_relative_path(server_relative_path: str, list_url: str) -> str:
    if not list_url or not server_relative_path.startswith(list_url):
        return ""
    return server_relative_path[len(list_url):].lstrip("/")


def make_children_url(drive_url: str, access_token: str, drive_relative_path: str) -> str:
    if drive_relative_path:
        encoded_path = "/".join(urllib.parse.quote(part) for part in drive_relative_path.split("/") if part)
        base_url = f"{drive_url}/root:/{encoded_path}:/children"
    else:
        base_url = f"{drive_url}/root/children"
    separator = "&" if "?" in base_url else "?"
    return f"{base_url}{separator}{access_token.lstrip('?')}"


def safe_filename(name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip().strip(".")
    return cleaned or "slide"


def unique_name(name: str, used_names: set[str]) -> str:
    stem = Path(name).stem
    suffix = Path(name).suffix
    candidate = name
    index = 2
    while candidate.lower() in used_names:
        candidate = f"{stem}-{index}{suffix}"
        index += 1
    used_names.add(candidate.lower())
    return candidate


def find_existing_slide(manifest_path: Path, slide_id: str) -> dict[str, Any] | None:
    manifest = read_json(manifest_path)
    slides = manifest.get("slides") if isinstance(manifest, dict) else None
    if not isinstance(slides, list):
        return None
    for slide in slides:
        if isinstance(slide, dict) and slide.get("id") == slide_id:
            return slide
    return None


def download_atomic(opener: urllib.request.OpenerDirector, url: str, target: Path) -> None:
    request = urllib.request.Request(url, headers=default_headers("*/*"))
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    os.close(fd)
    temp_path = Path(temp_name)
    try:
        with opener.open(request, timeout=120) as response, temp_path.open("wb") as output:
            shutil.copyfileobj(response, output)
        temp_path.replace(target)
    except Exception:
        with contextlib.suppress(OSError):
            temp_path.unlink()
        raise


def read_json(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
            return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    os.close(fd)
    temp_path = Path(temp_name)
    try:
        with temp_path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
        temp_path.replace(path)
    except Exception:
        with contextlib.suppress(OSError):
            temp_path.unlink()
        raise


def make_handler(config: AgentConfig) -> type[SimpleHTTPRequestHandler]:
    class SliderHandler(SimpleHTTPRequestHandler):
        def do_GET(self) -> None:
            parsed_path = urllib.parse.urlparse(self.path).path
            clean_path = posixpath.normpath(urllib.parse.unquote(parsed_path)).lstrip("/")
            if clean_path in ("", "slider.html") and EMBEDDED_SLIDER_HTML is not None:
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(EMBEDDED_SLIDER_HTML.encode("utf-8"))
                return

            super().do_GET()

        def do_HEAD(self) -> None:
            parsed_path = urllib.parse.urlparse(self.path).path
            clean_path = posixpath.normpath(urllib.parse.unquote(parsed_path)).lstrip("/")
            if clean_path in ("", "slider.html") and EMBEDDED_SLIDER_HTML is not None:
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                return

            super().do_HEAD()

        def translate_path(self, path: str) -> str:
            parsed_path = urllib.parse.urlparse(path).path
            clean_path = posixpath.normpath(urllib.parse.unquote(parsed_path)).lstrip("/")

            if clean_path in ("", "slider.html"):
                return str(config.web_root / "slider.html")
            if clean_path == "manifest.json":
                return str(config.manifest_path)
            if clean_path == "slides" or clean_path.startswith("slides/"):
                return str(safe_join(config.data_dir, clean_path))
            return str(safe_join(config.web_root, clean_path))

        def end_headers(self) -> None:
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, format: str, *args: Any) -> None:
            sys.stdout.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), format % args))

    return SliderHandler


def safe_join(root: Path, relative_path: str) -> Path:
    candidate = (root / relative_path).resolve()
    if candidate == root or root in candidate.parents:
        return candidate
    return root


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def html_unescape(value: str) -> str:
    return (
        value.replace("&amp;", "&")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
    )


mimetypes.add_type("text/html", ".html")
mimetypes.add_type("application/pdf", ".pdf")
mimetypes.add_type("image/png", ".png")


if __name__ == "__main__":
    raise SystemExit(main())
