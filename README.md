# Slider

The built product is a Python slider agent with the slideshow HTML, CSS, and JavaScript embedded in it. The agent syncs an anonymous SharePoint folder into local files, writes `manifest.json`, and serves everything from localhost so the browser never talks directly to SharePoint.

## Build

Use Node.js 22.13.0 or newer.

```sh
npm install
npm run build
```

This writes:

```text
build/slider_agent.py
```

## Configure

Create a local `slider_config.json` next to `package.json`:

```sh
cp slider_config.example.json slider_config.json
```

Edit `slider_config.json`. At minimum, set `folder_url` to an anonymous SharePoint/OneDrive folder link. This annotated example lists every supported setting:

```jsonc
{
  // Anonymous "Anyone with the link can view" SharePoint/OneDrive folder URL.
  "folder_url": "https://your-tenant.sharepoint.com/:f:/...",

  // Local HTTP server bind address and port.
  "host": "127.0.0.1",
  "port": 8788,

  // How often the agent checks SharePoint, and when successful syncs become stale.
  "sync_interval_seconds": 120,
  "stale_after_seconds": 1800,

  // On Windows, launch Chrome in kiosk mode after the first sync.
  "autolaunch": true,
  "chrome_path": "",

  // Optional updater manifest URL for the hidden dev menu's Update action.
  "update_url": "",

  // Local cache directory for synced files and manifest.json.
  "data_dir": "slider_data",

  // Browser app manifest URL. Usually leave this at the local agent default.
  "manifest_url": "/manifest.json",

  // Announcement and poster autoplay timing.
  "time_per_slide_seconds": 30,
  "poster_time_seconds": 60,

  // How long touch/mouse interaction pauses autoplay and keeps controls visible.
  "interactive_pause_seconds": 120,

  // Livestream timeout and menu entries.
  "live_stream_minutes": 20,
  "live_streams": {
    "Cats": "https://www.youtube.com/watch?v=e9C9K8ltDfk",
    "Puppies": "https://www.youtube.com/watch?v=h-Z0wCdD3dI",
    "Jellyfish": "https://www.youtube.com/watch?v=m1XcdxjVGos",
    "ISS": "https://www.youtube.com/watch?v=FuuC4dpSQ1M"
  },

  // true, false, or "auto"; auto enables four-up on estimated 4K displays.
  "four_up": "auto",

  // Poster display behavior.
  "pan_posters": true,
  "poster_slides_controls_always_visible": true,
  "pan_fraction": 0.75,

  // PDF rendering behavior.
  "pdf_cache_size": 200,
  "pdf_render_cache": true,
  "pdf_initial_render_scale": 2,
  "pdf_max_zoom_render_scale": 5,

  // Show debug status text and extra console diagnostics.
  "debug": false
}
```

`slider_config.json` is ignored by git so private or environment-specific folder URLs are not committed. Agent settings are read when the Python agent starts. App settings are embedded as defaults when you run `npm run build`, and a runtime `slider_config.json` next to the Python agent or packaged executable can override them when `slider.html` is served. URL parameters remain the final app override.

Some settings also have legacy aliases: `manifest`, `time`, `time_seconds`, `poster_time`, `interactive_pause`, `sync_stale_after_seconds`, `stale_after`, `four`, `pdf_cache`, `render_cache`, `pdf_initial_scale`, and `pdf_zoom_render_scale`. You can also provide core agent settings with command-line flags or environment variables, such as `--folder` or `SLIDER_FOLDER_URL`. The kiosk launch URL includes `kiosk=1` so the app hides its fullscreen menu option.

The `update_url` manifest should include `version`, `url`, and `sha256`. The Windows packaged executable always downloads the manifest's exe, verifies its SHA-256, closes Chrome, replaces itself with a helper script, and relaunches, even when the manifest version matches the running version. Update helper progress is written to `slider.update.log` next to the executable.

## Run Locally

```sh
python3 build/slider_agent.py
```

Then open:

```text
http://127.0.0.1:8788/slider.html
```

Useful options:

```sh
python3 build/slider_agent.py --folder "https://your-tenant.sharepoint.com/:f:/s/..." --port 8788 --sync-interval 300
python3 build/slider_agent.py --once --data-dir ./slider_data
python3 build/slider_agent.py --no-autolaunch
```

The agent keeps the last successfully synced slides if SharePoint becomes unreachable. The manifest records sync health, and the slideshow displays a banner when sync fails or becomes stale.

The slideshow pauses for touch/mouse interaction and shows navigation plus zoom controls. The default interactive pause is 120 seconds. Override it with:

```text
http://127.0.0.1:8788/slider.html?interactive_pause_seconds=180
```

Announcement slides use `time_per_slide_seconds` seconds per slide. Posters use `poster_time_seconds`; when it is not set, posters stay up for twice the announcement time.

```text
http://127.0.0.1:8788/slider.html?time_per_slide_seconds=30&poster_time_seconds=90
```

Poster panning is enabled by default. Disable it with:

```text
http://127.0.0.1:8788/slider.html?pan_posters=0
```

Poster controls hide until interaction by default. Keep them visible at reduced opacity during poster autoplay with:

```text
http://127.0.0.1:8788/slider.html?poster_slides_controls_always_visible=1
```

Posters only pan when less than `pan_fraction` of the full-width content height would be visible; the default is `0.85`.

```text
http://127.0.0.1:8788/slider.html?pan_fraction=0.75
```

To show four slides at once in equal quarters, add:

```text
http://127.0.0.1:8788/slider.html?four_up=1
```

In four-up mode, each advance shifts the visible slides forward by one quarter and introduces one new slide.

If the shared folder contains a `Labs` folder, the agent recursively syncs its subfolders. During interactive mode, use the top-left menu to switch between:

- `Announcements`: the default slideshow from PNG/PDF/HTML files in the root folder; root subfolders are synced for HTML assets but are not shown as announcements
- `Posters`: a randomized slideshow of non-index PNG/PDF/HTML files directly inside each `Labs/*` folder
- `Labs`: a hierarchical list of lab folders
- Livestream menu items from `live_streams`: fullscreen video streams with a countdown timer

Each lab folder can include an `index.html` file plus PNG/PDF/HTML poster files. Selecting a lab shows `index.html` on the left two-thirds of the screen and a scrollable poster selector on the right. Selecting a poster opens it full-screen with the normal interactive navigation and zoom controls.

Livestreams run for `live_stream_minutes` before returning to whichever autoplay mode, `Announcements` or `Posters`, was running most recently. Configure livestream menu items with a `live_streams` object mapping menu names to URLs; YouTube watch URLs are converted to embeds automatically.

## Development

For autorebuild and agent restart while editing TypeScript, CSS, HTML, or Python:

```sh
npm run dev
```

Then open:

```text
http://127.0.0.1:8788/slider.html
```

Refresh the browser after a rebuild to pick up embedded HTML/JS/CSS changes.

## Windows Packaging

The agent uses only the Python standard library. For a Windows deployment that does not require installing Python, package it with PyInstaller:

```sh
npm run build
py -m PyInstaller --onefile build/slider_agent.py
```

No separate `slider.html` is needed. The `npm run build` step embeds both the slider UI and the current `slider_config.json` defaults into `build/slider_agent.py`. A `slider_config.json` next to the executable can override embedded agent and app defaults at runtime; environment variables and command-line flags can also override agent settings. The executable creates and updates `slider_data/` next to where it runs unless `--data-dir` is provided.

To package and publish an updater release from Windows Git Bash:

```sh
scripts/package_release.sh user@bits.csb.pitt.edu:/path/to/slider_updates https://bits.csb.pitt.edu/slider_updates
```

The app version is derived from Git with `git describe --tags --dirty --always`; this same version is baked into the executable and written to `release/latest.json`. Tag the commit you want to publish, for example `git tag v1.2.0`, before packaging. The script runs `npm run build`, packages `dist/slider.exe` with PyInstaller, copies it to `release/slider-<git-version>.exe`, writes `release/latest.json`, and uploads both files with `scp`. The manifest points at the public base URL you pass as the second argument. Dirty worktrees are refused by default; set `ALLOW_DIRTY_RELEASE=1` only for a test upload.
