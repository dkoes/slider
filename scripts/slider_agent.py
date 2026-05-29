#!/usr/bin/env python3
"""Sync an anonymous SharePoint folder locally and serve the slider UI."""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import http.cookiejar
import json
import mimetypes
import os
import posixpath
import re
import shutil
import subprocess
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
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8788
DEFAULT_SYNC_INTERVAL_SECONDS = 120
DEFAULT_STALE_AFTER_SECONDS = 1800
DEFAULT_DATA_DIR = "slider_data"
DEFAULT_AUTOLAUNCH = True
DEFAULT_CHROME_PATH = ""
DEFAULT_UPDATE_URL = ""
APP_VERSION = "0.1.0"
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
    autolaunch: bool
    chrome_path: str
    update_url: str
    once: bool
    config_path: Path

    @property
    def slides_dir(self) -> Path:
        return self.data_dir / "slides"

    @property
    def labs_dir(self) -> Path:
        return self.data_dir / "labs"

    @property
    def manifest_path(self) -> Path:
        return self.data_dir / "manifest.json"


def main() -> int:
    config = parse_args()
    config.data_dir.mkdir(parents=True, exist_ok=True)
    config.slides_dir.mkdir(parents=True, exist_ok=True)
    config.labs_dir.mkdir(parents=True, exist_ok=True)

    syncer = SharePointSyncer(config)
    if config.once:
        syncer.sync_once()
        return 0

    thread = threading.Thread(
        target=sync_loop,
        args=(syncer, config.sync_interval_seconds, lambda: launch_windows_chrome_kiosk(config)),
        daemon=True,
    )
    thread.start()

    server = ThreadingHTTPServer((config.host, config.port), make_handler(config, syncer))
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
    root = get_app_root()
    default_data_dir = resolve_config_path(DEFAULT_DATA_DIR, root)
    local_config = read_json(root / "slider_config.json")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folder", default=get_config_value(local_config, "folder_url", "SLIDER_FOLDER_URL", DEFAULT_FOLDER_URL))
    parser.add_argument("--host", default=get_config_value(local_config, "host", "SLIDER_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(get_config_value(local_config, "port", "SLIDER_PORT", DEFAULT_PORT)))
    parser.add_argument("--web-root", type=Path, default=root / "dist")
    parser.add_argument("--data-dir", type=Path, default=Path(get_config_value(local_config, "data_dir", "SLIDER_DATA_DIR", default_data_dir)))
    parser.add_argument("--sync-interval", type=int, default=int(get_config_value(local_config, "sync_interval_seconds", "SLIDER_SYNC_INTERVAL_SECONDS", DEFAULT_SYNC_INTERVAL_SECONDS)))
    parser.add_argument("--stale-after", type=int, default=int(get_config_value(local_config, "stale_after_seconds", "SLIDER_STALE_AFTER_SECONDS", DEFAULT_STALE_AFTER_SECONDS)))
    parser.add_argument("--autolaunch", action=argparse.BooleanOptionalAction, default=get_autolaunch_config(local_config), help="On Windows, launch Chrome in kiosk mode after the server starts.")
    parser.add_argument("--launch-chrome-kiosk", dest="autolaunch", action=argparse.BooleanOptionalAction, default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    parser.add_argument("--chrome-path", default=get_config_value(local_config, "chrome_path", "SLIDER_CHROME_PATH", DEFAULT_CHROME_PATH))
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
        autolaunch=args.autolaunch,
        chrome_path=args.chrome_path,
        update_url=get_config_string(local_config, "update_url", DEFAULT_UPDATE_URL),
        once=args.once,
        config_path=root / "slider_config.json",
    )


def get_app_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent

    return Path(__file__).resolve().parents[1]


def resolve_config_path(value: str, root: Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else root / path


def get_config_value(config: dict[str, Any], key: str, env_name: str, fallback: Any) -> str:
    if os.environ.get(env_name):
        return os.environ[env_name]

    value = config.get(key)
    if value not in (None, ""):
        return str(value)

    return str(fallback)


def get_config_string(config: dict[str, Any], key: str, fallback: str = "") -> str:
    value = config.get(key)
    if value not in (None, ""):
        return str(value)

    return fallback


def get_config_bool(config: dict[str, Any], key: str, env_name: str, fallback: bool) -> bool:
    value = os.environ.get(env_name)
    if value in (None, ""):
        value = config.get(key)

    if value in (None, ""):
        return fallback

    if isinstance(value, bool):
        return value

    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def get_autolaunch_config(config: dict[str, Any]) -> bool:
    if os.environ.get("SLIDER_AUTOLAUNCH") not in (None, ""):
        return parse_bool(os.environ["SLIDER_AUTOLAUNCH"])

    if config.get("autolaunch") not in (None, ""):
        return parse_bool(config["autolaunch"])

    return get_config_bool(config, "launch_chrome_kiosk", "SLIDER_LAUNCH_CHROME_KIOSK", DEFAULT_AUTOLAUNCH)


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value

    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def render_embedded_slider_html(config_path: Path) -> str:
    if EMBEDDED_SLIDER_HTML is None:
        return ""

    marker = "      /* __RUNTIME_SLIDER_DEFAULTS__ */"
    runtime_defaults = format_runtime_slider_defaults(read_json(config_path))
    if marker not in EMBEDDED_SLIDER_HTML:
        return EMBEDDED_SLIDER_HTML

    return EMBEDDED_SLIDER_HTML.replace(marker, runtime_defaults)


def format_runtime_slider_defaults(config: dict[str, Any]) -> str:
    assignments = []
    add_string_assignment(assignments, "SLIDER_MANIFEST_URL", first_config_value(config, "manifest_url", "manifest"))
    add_number_assignment(
        assignments,
        "SLIDER_TIME_PER_SLIDE_SECONDS",
        first_config_value(config, "time_per_slide_seconds", "time_seconds", "time"),
    )
    add_number_assignment(
        assignments,
        "SLIDER_POSTER_TIME_SECONDS",
        first_config_value(config, "poster_time_seconds", "poster_time"),
    )
    add_number_assignment(
        assignments,
        "SLIDER_INTERACTIVE_PAUSE_SECONDS",
        first_config_value(config, "interactive_pause_seconds", "interactive_pause"),
    )
    add_number_assignment(
        assignments,
        "SLIDER_SYNC_STALE_AFTER_SECONDS",
        first_config_value(config, "sync_stale_after_seconds", "stale_after_seconds", "stale_after"),
    )
    add_number_assignment(assignments, "SLIDER_LIVE_STREAM_MINUTES", config.get("live_stream_minutes"))
    add_object_assignment(assignments, "SLIDER_LIVE_STREAMS", config.get("live_streams"))
    add_four_up_assignment(assignments, "SLIDER_FOUR_UP", first_config_value(config, "four_up", "four"))
    add_bool_assignment(assignments, "SLIDER_PAN_POSTERS", config.get("pan_posters"))
    add_bool_assignment(
        assignments,
        "SLIDER_POSTER_SLIDES_CONTROLS_ALWAYS_VISIBLE",
        config.get("poster_slides_controls_always_visible"),
    )
    add_fraction_assignment(assignments, "SLIDER_PAN_FRACTION", config.get("pan_fraction"))
    add_number_assignment(assignments, "SLIDER_PDF_CACHE_SIZE", first_config_value(config, "pdf_cache_size", "pdf_cache"), minimum=0)
    add_bool_assignment(assignments, "SLIDER_PDF_DOCUMENT_CACHE", first_config_value(config, "pdf_document_cache", "document_cache"))
    add_bool_assignment(assignments, "SLIDER_PDF_RENDER_CACHE", first_config_value(config, "pdf_render_cache", "render_cache"))
    add_number_assignment(
        assignments,
        "SLIDER_PDF_INITIAL_RENDER_SCALE",
        first_config_value(config, "pdf_initial_render_scale", "pdf_initial_scale"),
    )
    add_number_assignment(
        assignments,
        "SLIDER_PDF_MAX_ZOOM_RENDER_SCALE",
        first_config_value(config, "pdf_max_zoom_render_scale", "pdf_zoom_render_scale"),
    )
    add_bool_assignment(assignments, "SLIDER_DEBUG", config.get("debug"))

    if not assignments:
        return "      /* no runtime slider defaults */"

    return "\n".join(assignments)


def first_config_value(config: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = config.get(key)
        if value not in (None, ""):
            return value

    return None


def add_string_assignment(assignments: list[str], name: str, value: Any) -> None:
    if value in (None, ""):
        return

    assignments.append(f"      window.{name} = {json.dumps(str(value))};")


def add_object_assignment(assignments: list[str], name: str, value: Any) -> None:
    if not isinstance(value, dict):
        return

    payload = {
        str(key).strip(): str(item).strip()
        for key, item in value.items()
        if str(key).strip() and str(item).strip()
    }
    if not payload:
        return

    assignments.append(f"      window.{name} = {json.dumps(payload)};")


def add_number_assignment(assignments: list[str], name: str, value: Any, minimum: float = 0) -> None:
    number = parse_number(value)
    if number is None or number < minimum or (minimum == 0 and number == 0 and name != "SLIDER_PDF_CACHE_SIZE"):
        return

    assignments.append(f"      window.{name} = {json.dumps(number)};")


def add_fraction_assignment(assignments: list[str], name: str, value: Any) -> None:
    number = parse_number(value)
    if number is None or number <= 0 or number > 1:
        return

    assignments.append(f"      window.{name} = {json.dumps(number)};")


def add_bool_assignment(assignments: list[str], name: str, value: Any) -> None:
    if value in (None, ""):
        return

    assignments.append(f"      window.{name} = {json.dumps(parse_bool(value))};")


def add_four_up_assignment(assignments: list[str], name: str, value: Any) -> None:
    if value in (None, ""):
        return

    if str(value).strip().lower() == "auto":
        assignments.append(f"      window.{name} = \"auto\";")
        return

    assignments.append(f"      window.{name} = {json.dumps(parse_bool(value))};")


def parse_number(value: Any) -> float | int | None:
    if value in (None, ""):
        return None

    try:
        number = float(value)
    except (TypeError, ValueError):
        return None

    if not number == number or number in (float("inf"), float("-inf")):
        return None

    return int(number) if number.is_integer() else number


def launch_windows_chrome_kiosk(config: AgentConfig) -> None:
    if sys.platform != "win32" or not config.autolaunch:
        return

    print("Attempting to launch Chrome kiosk.")
    chrome_path = find_windows_chrome_path(config.chrome_path)
    if not chrome_path:
        print("Chrome kiosk launch skipped: chrome.exe was not found.", file=sys.stderr)
        return

    url = get_slider_url(config, kiosk=True)
    try:
        subprocess.Popen(
            [
                chrome_path,
                "--kiosk",
                "--new-window",
                url,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print(f"Launched Chrome kiosk at {url}")
    except OSError as error:
        print(f"Chrome kiosk launch failed: {error}", file=sys.stderr)


def find_windows_chrome_path(configured_path: str) -> str:
    candidates = []
    if configured_path:
        candidates.append(configured_path)

    candidates.extend(
        [
            str(Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google" / "Chrome" / "Application" / "chrome.exe"),
            str(Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Google" / "Chrome" / "Application" / "chrome.exe"),
            str(Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "Application" / "chrome.exe"),
        ]
    )

    which_chrome = shutil.which("chrome") or shutil.which("chrome.exe")
    if which_chrome:
        candidates.append(which_chrome)

    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate

    return ""


def get_slider_url(config: AgentConfig, kiosk: bool = False) -> str:
    host = "127.0.0.1" if config.host in {"0.0.0.0", "::"} else config.host
    query = "?kiosk=1" if kiosk else ""
    return f"http://{host}:{config.port}/slider.html{query}"


def check_for_update(config: AgentConfig) -> dict[str, Any]:
    if not config.update_url:
        return {"status": "disabled", "message": "No update_url is configured.", "version": APP_VERSION}

    latest = fetch_update_manifest(config.update_url)
    latest_version = str(latest.get("version") or "").strip()
    download_url = str(latest.get("url") or "").strip()
    expected_sha256 = str(latest.get("sha256") or "").strip().lower()
    if not latest_version or not download_url or not expected_sha256:
        raise RuntimeError("Update manifest must include version, url, and sha256.")

    if compare_versions(latest_version, APP_VERSION) <= 0:
        return {
            "status": "current",
            "message": f"Slider is up to date ({APP_VERSION}).",
            "version": APP_VERSION,
            "latestVersion": latest_version,
        }

    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return {
            "status": "available",
            "message": f"Update {latest_version} is available, but automatic replacement is only supported by the Windows executable.",
            "version": APP_VERSION,
            "latestVersion": latest_version,
        }

    new_exe = Path(sys.executable).with_suffix(Path(sys.executable).suffix + ".new")
    download_update(download_url, new_exe)
    actual_sha256 = sha256_file(new_exe)
    if actual_sha256.lower() != expected_sha256:
        with contextlib.suppress(OSError):
            new_exe.unlink()
        raise RuntimeError("Downloaded update did not match the expected SHA-256.")

    remove_mark_of_the_web(new_exe)
    helper = write_update_helper(Path(sys.executable), new_exe)
    launch_update_helper(helper, os.getpid())
    threading.Timer(1.0, lambda: os._exit(0)).start()
    return {
        "status": "updating",
        "message": f"Installing slider {latest_version}; the app will restart.",
        "version": APP_VERSION,
        "latestVersion": latest_version,
    }


def fetch_update_manifest(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers=default_headers("application/json"))
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError("Update manifest was not a JSON object.")
    return payload


def download_update(url: str, target: Path) -> None:
    request = urllib.request.Request(url, headers=default_headers("application/octet-stream"))
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    os.close(fd)
    temp_path = Path(temp_name)
    try:
        with urllib.request.urlopen(request, timeout=300) as response, temp_path.open("wb") as output:
            shutil.copyfileobj(response, output)
        temp_path.replace(target)
    except Exception:
        with contextlib.suppress(OSError):
            temp_path.unlink()
        raise


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def remove_mark_of_the_web(path: Path) -> None:
    with contextlib.suppress(OSError):
        os.remove(str(path) + ":Zone.Identifier")


def write_update_helper(current_exe: Path, new_exe: Path) -> Path:
    helper = current_exe.with_suffix(".update.cmd")
    old_exe = current_exe.with_suffix(current_exe.suffix + ".old")
    log_path = current_exe.with_suffix(".update.log")
    cleanup_helper = helper.with_suffix(".cleanup.cmd")
    script = f"""@echo off
setlocal
set "PID=%~1"
set "CURRENT={current_exe}"
set "NEW={new_exe}"
set "OLD={old_exe}"
set "LOG={log_path}"
set "HELPER=%~f0"
set "CLEANUP={cleanup_helper}"
echo [%date% %time%] Waiting for slider PID %PID% to exit. > "%LOG%"
:wait
tasklist /FI "PID eq %PID%" | find "%PID%" >nul
if not errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto wait
)
echo [%date% %time%] Closing Chrome before replacement. >> "%LOG%"
taskkill /F /T /IM chrome.exe >> "%LOG%" 2>>&1
echo [%date% %time%] Replacing executable. >> "%LOG%"
move /Y "%CURRENT%" "%OLD%" >nul
if errorlevel 1 goto rollback
move /Y "%NEW%" "%CURRENT%" >nul
if errorlevel 1 goto rollback
echo [%date% %time%] Starting updated slider. >> "%LOG%"
start "Slider" /D "{current_exe.parent}" "%CURRENT%"
timeout /t 3 /nobreak >nul
del "%OLD%" >nul 2>nul
echo [%date% %time%] Update helper completed. >> "%LOG%"
call :schedule_cleanup
exit /b 0
:rollback
echo [%date% %time%] Update failed; rolling back. >> "%LOG%"
if exist "%OLD%" move /Y "%OLD%" "%CURRENT%" >nul
del "%NEW%" >nul 2>nul
start "Slider" /D "{current_exe.parent}" "%CURRENT%"
call :schedule_cleanup
exit /b 1
:schedule_cleanup
> "%CLEANUP%" echo @echo off
>> "%CLEANUP%" echo timeout /t 2 /nobreak ^>nul
>> "%CLEANUP%" echo del "%HELPER%" ^>nul 2^>nul
>> "%CLEANUP%" echo del "%%~f0" ^>nul 2^>nul
start "" /min "%COMSPEC%" /d /c call "%CLEANUP%"
exit /b 0
"""
    helper.write_text(script, encoding="utf-8")
    return helper


def launch_update_helper(helper: Path, pid: int) -> None:
    command = [
        os.environ.get("COMSPEC", "cmd.exe"),
        "/d",
        "/c",
        "call",
        str(helper),
        str(pid),
    ]
    creationflags = 0
    if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        creationflags |= subprocess.CREATE_NEW_PROCESS_GROUP
    if hasattr(subprocess, "DETACHED_PROCESS"):
        creationflags |= subprocess.DETACHED_PROCESS
    subprocess.Popen(command, cwd=str(helper.parent), close_fds=True, creationflags=creationflags)


def compare_versions(left: str, right: str) -> int:
    left_parts = parse_version(left)
    right_parts = parse_version(right)
    max_len = max(len(left_parts), len(right_parts))
    left_parts.extend([0] * (max_len - len(left_parts)))
    right_parts.extend([0] * (max_len - len(right_parts)))
    return (left_parts > right_parts) - (left_parts < right_parts)


def parse_version(value: str) -> list[int]:
    parts = re.findall(r"\d+", value)
    return [int(part) for part in parts] or [0]


def sync_loop(syncer: "SharePointSyncer", interval_seconds: int, after_first_sync: Any = None) -> None:
    first_sync = True
    while True:
        syncer.sync_once()
        if first_sync and after_first_sync:
            first_sync = False
            after_first_sync()
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
                # Keep sync atomic from the browser's perspective: download files,
                # prune old files, then replace the manifest in one filesystem move.
                content = self.fetch_content()
                slides = content["slides"]
                labs = content["labs"]
                self.remove_unlisted_files(slides, labs)
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
                    "labs": labs,
                }
                write_json_atomic(self.config.manifest_path, manifest)
                print(f"{attempt} synced {len(slides)} announcement slides and {count_lab_items(labs)} lab files.")
            except Exception as error:  # noqa: BLE001 - keep the display alive on every sync failure.
                self.write_failure_manifest(attempt, str(error))
                print(f"{attempt} sync failed: {error}", file=sys.stderr)

    def fetch_content(self) -> dict[str, list[dict[str, Any]]]:
        if not self.config.folder_url:
            raise RuntimeError(
                "No SharePoint folder URL is configured. Set --folder, SLIDER_FOLDER_URL, or folder_url in slider_config.json."
            )

        # Anonymous SharePoint links expose short-lived drive API URLs/tokens in
        # the rendered page. We scrape those rather than requiring Graph auth.
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
        children = self.fetch_all_children(children_url)

        slides: list[dict[str, str]] = []
        used_names: set[str] = set()
        labs: list[dict[str, Any]] = []
        for child in children:
            if not isinstance(child, dict):
                continue

            if "file" in child:
                slide = self.sync_child(child, self.config.slides_dir, "/slides", used_names)
                if slide:
                    slides.append(slide)
            elif "folder" in child and str(child.get("name") or "").lower() == "labs":
                labs = self.sync_labs_root(child, drive_url, access_token)

        return {
            "slides": sorted(slides, key=lambda slide: slide["name"].lower()),
            "labs": labs,
        }

    def sync_labs_root(self, labs_child: dict[str, Any], drive_url: str, access_token: str) -> list[dict[str, Any]]:
        children = self.fetch_folder_children(drive_url, access_token, str(labs_child.get("id") or ""))
        labs: list[dict[str, Any]] = []
        for child in children:
            if isinstance(child, dict) and "folder" in child:
                labs.append(self.sync_lab_folder(child, drive_url, access_token, []))
        return sorted(labs, key=lambda lab: lab["name"].lower())

    def sync_lab_folder(
        self,
        folder: dict[str, Any],
        drive_url: str,
        access_token: str,
        parent_parts: list[str],
    ) -> dict[str, Any]:
        # Lab folders are mirrored recursively under slider_data/labs. Their
        # manifest shape mirrors the folder tree so the browser can build flyouts.
        name = str(folder.get("name") or "Lab")
        safe_name = safe_filename(name)
        path_parts = parent_parts + [safe_name]
        lab_dir = self.config.labs_dir.joinpath(*path_parts)
        lab_url_prefix = "/" + "/".join(["labs", *[urllib.parse.quote(part) for part in path_parts]])
        children = self.fetch_folder_children(drive_url, access_token, str(folder.get("id") or ""))
        files: list[dict[str, str]] = []
        subfolders: list[dict[str, Any]] = []
        used_names: set[str] = set()

        for child in children:
            if not isinstance(child, dict):
                continue
            if "file" in child:
                item = self.sync_child(child, lab_dir, lab_url_prefix, used_names)
                if item:
                    files.append(item)
            elif "folder" in child:
                subfolders.append(self.sync_lab_folder(child, drive_url, access_token, path_parts))

        index_item = next((item for item in files if item["name"].lower() in ("index.html", "index.htm")), None)
        poster_items = [item for item in files if item is not index_item]
        return {
            "id": str(folder.get("id") or "/".join(path_parts)),
            "name": name,
            "path": "/".join(path_parts),
            "index": index_item,
            "items": sorted(poster_items, key=lambda item: item["name"].lower()),
            "children": sorted(subfolders, key=lambda lab: lab["name"].lower()),
        }

    def fetch_folder_children(self, drive_url: str, access_token: str, item_id: str) -> list[dict[str, Any]]:
        if not item_id:
            return []
        return self.fetch_all_children(make_item_children_url(drive_url, access_token, item_id))

    def fetch_all_children(self, url: str) -> list[dict[str, Any]]:
        # Large SharePoint folders are paged; @odata.nextLink may contain a new
        # pre-signed URL, so follow it exactly instead of rebuilding query params.
        children: list[dict[str, Any]] = []
        next_url = url
        while next_url:
            payload = self.fetch_json(next_url)
            value = payload.get("value")
            if not isinstance(value, list):
                raise RuntimeError("SharePoint children response did not contain a value list.")
            children.extend(child for child in value if isinstance(child, dict))
            next_link = payload.get("@odata.nextLink")
            next_url = next_link if isinstance(next_link, str) else ""
        return children

    def sync_child(
        self,
        child: dict[str, Any],
        directory: Path,
        url_prefix: str,
        used_names: set[str],
    ) -> dict[str, str] | None:
        name = str(child.get("name") or "")
        extension = Path(name).suffix.lower()
        kind = SUPPORTED_EXTENSIONS.get(extension)
        download_url = child.get("@content.downloadUrl") or child.get("@microsoft.graph.downloadUrl")
        if not name or not kind or not isinstance(download_url, str):
            return None

        # Reuse unchanged local files so routine syncs are cheap and the display
        # keeps working even when only manifest refreshes are happening.
        local_name = unique_name(safe_filename(name), used_names)
        local_path = directory / local_name
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
                "url": str(existing["url"]),
                "modified": modified,
            }

        download_atomic(self.opener, download_url, local_path)
        return {
            "id": str(child.get("id") or name),
            "name": name,
            "kind": kind,
            "url": f"{url_prefix}/{urllib.parse.quote(local_name)}",
            "modified": modified,
        }

    def remove_unlisted_files(self, slides: list[dict[str, str]], labs: list[dict[str, Any]]) -> None:
        # Manifest URLs are percent-encoded, but local filesystem paths are not.
        # Decode before comparing or files with spaces will be pruned incorrectly.
        wanted = {self.local_path_from_url(slide["url"]) for slide in slides}
        wanted.update(self.local_path_from_url(url) for url in collect_lab_urls(labs))
        for root in (self.config.slides_dir, self.config.labs_dir):
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if path.is_file() and path not in wanted:
                    with contextlib.suppress(OSError):
                        path.unlink()

    def local_path_from_url(self, url: str) -> Path:
        return self.config.data_dir / urllib.parse.unquote(url.lstrip("/"))

    def write_failure_manifest(self, attempt: str, error: str) -> None:
        # Preserve the previous slide list on failures so the browser can keep
        # showing cached local content while surfacing sync health in the banner.
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
        manifest["labs"] = manifest.get("labs") if isinstance(manifest.get("labs"), list) else []
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

    # Some anonymous pages put drive fields outside _spPageContextInfo. Merge in
    # those loose values so both personal OneDrive and group SharePoint links work.
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
    # Do not mix v2.0 and v2.1 fields; SharePoint tokens are tied to their drive
    # endpoint version and mismatched pairs fail with opaque 400/401 responses.
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
    # Folder links often redirect to onedrive.aspx?id=...; the id is the reliable
    # server-relative path when _spPageContextInfo.rootFolder is missing.
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


def make_item_children_url(drive_url: str, access_token: str, item_id: str) -> str:
    base_url = f"{drive_url}/items/{urllib.parse.quote(item_id, safe='')}/children"
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
    for slide in iter_manifest_items(manifest):
        if isinstance(slide, dict) and slide.get("id") == slide_id:
            return slide
    return None


def iter_manifest_items(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    slides = manifest.get("slides")
    if isinstance(slides, list):
        items.extend(item for item in slides if isinstance(item, dict))

    labs = manifest.get("labs")
    if isinstance(labs, list):
        for lab in labs:
            collect_lab_items(lab, items)
    return items


def collect_lab_items(lab: Any, items: list[dict[str, Any]]) -> None:
    if not isinstance(lab, dict):
        return
    index = lab.get("index")
    if isinstance(index, dict):
        items.append(index)
    lab_items = lab.get("items")
    if isinstance(lab_items, list):
        items.extend(item for item in lab_items if isinstance(item, dict))
    children = lab.get("children")
    if isinstance(children, list):
        for child in children:
            collect_lab_items(child, items)


def collect_lab_urls(labs: list[dict[str, Any]]) -> list[str]:
    urls: list[str] = []
    for item in iter_manifest_items({"labs": labs}):
        url = item.get("url")
        if isinstance(url, str):
            urls.append(url)
    return urls


def count_lab_items(labs: list[dict[str, Any]]) -> int:
    return len(collect_lab_urls(labs))


def download_atomic(opener: urllib.request.OpenerDirector, url: str, target: Path) -> None:
    # Write to a sibling temp file first so interrupted downloads never leave a
    # partial PDF/image at the URL currently advertised by the manifest.
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


def make_handler(config: AgentConfig, syncer: SharePointSyncer) -> type[SimpleHTTPRequestHandler]:
    class SliderHandler(SimpleHTTPRequestHandler):
        def send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            parsed_path = urllib.parse.urlparse(self.path).path
            clean_path = posixpath.normpath(urllib.parse.unquote(parsed_path)).lstrip("/")
            if clean_path in ("", "slider.html") and EMBEDDED_SLIDER_HTML is not None:
                html = render_embedded_slider_html(config.config_path)
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(html.encode("utf-8"))
                return

            super().do_GET()

        def do_POST(self) -> None:
            parsed_path = urllib.parse.urlparse(self.path).path
            clean_path = posixpath.normpath(urllib.parse.unquote(parsed_path)).lstrip("/")
            if clean_path == "update/check":
                try:
                    self.send_json(200, check_for_update(config))
                except Exception as error:  # noqa: BLE001 - report update failure to the menu action.
                    self.send_json(500, {"status": "error", "message": str(error), "version": APP_VERSION})
                return

            if clean_path == "sync/now":
                try:
                    syncer.sync_once()
                    manifest = read_json(config.manifest_path)
                    sync = manifest.get("sync") if isinstance(manifest.get("sync"), dict) else {}
                    if sync.get("status") == "ok":
                        self.send_json(200, {"status": "ok", "message": "Manual sync complete."})
                    else:
                        message = str(sync.get("error") or "Manual sync did not complete.")
                        self.send_json(500, {"status": "error", "message": message})
                except Exception as error:  # noqa: BLE001 - surface unexpected manual sync failures.
                    self.send_json(500, {"status": "error", "message": str(error)})
                return

            self.send_error(404, "Not found")

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
            if clean_path == "labs" or clean_path.startswith("labs/"):
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
