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

Edit `slider_config.json`. The example file lists every supported setting and its default value. At minimum, set:

```json
{
  "folder_url": "https://your-tenant.sharepoint.com/:f:/..."
}
```

`slider_config.json` is ignored by git so private or environment-specific folder URLs are not committed. Agent settings are read when the Python agent starts. App settings, such as `time_per_slide_seconds`, `poster_time_seconds`, `interactive_pause_seconds`, `live_streams`, `four_up`, `pan_posters`, `poster_slides_controls_always_visible`, `pan_fraction`, `pdf_cache_size`, `pdf_document_cache`, `pdf_render_cache`, `pdf_initial_render_scale`, `pdf_max_zoom_render_scale`, and `debug`, are embedded as defaults when you run `npm run build`, and a runtime `slider_config.json` next to the Python agent or packaged executable can override them when `slider.html` is served. URL parameters remain the final override. `four_up` can be `true`, `false`, or `"auto"`; auto enables four-up mode only when the initial viewport is at least 3840x2160. Parsed PDF documents are cached by default; set `pdf_document_cache: false` to reload PDF.js documents for each render. Rendered PDF canvases are not cached by default; set `pdf_render_cache: true` to enable that cache. `pdf_initial_render_scale` controls the baseline PDF rasterization scale and defaults to `2`; oversized initial renders fall back to `1`. `pdf_max_zoom_render_scale` caps high-resolution PDF poster renders and defaults to `5`.

You can also provide core agent settings with command-line flags or environment variables, such as `--folder` or `SLIDER_FOLDER_URL`. On Windows, the agent launches Chrome in kiosk mode by default after the server starts. Set `chrome_path` or `SLIDER_CHROME_PATH` to use a specific Chrome executable, or disable it with `autolaunch: false` or `--no-autolaunch`. The kiosk launch URL includes `kiosk=1` so the app hides its fullscreen menu option.

Set `update_url` in `slider_config.json` to a JSON manifest URL to enable the menu's `Check for Updates` action. This value can be baked into `build/slider_agent.py` by `npm run build`, and a runtime `slider_config.json` next to the packaged executable can override it. It is not stored in checked-in source code and is not accepted from environment variables or command-line flags. The manifest should include `version`, `url`, and `sha256`; the Windows packaged executable downloads the new exe, verifies its SHA-256, closes Chrome, replaces itself with a helper script, and relaunches. Update helper progress is written to `slider.update.log` next to the executable.

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

- `Announcements`: the default slideshow from the root folder
- `Posters`: a randomized slideshow of all non-index PNG/PDF/HTML files under `Labs`
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
