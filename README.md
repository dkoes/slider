# Slider

The built product is a Python slider agent with the slideshow HTML, CSS, and JavaScript embedded in it. The agent syncs an anonymous SharePoint folder into local files, writes `manifest.json`, and serves everything from localhost so the browser never talks directly to SharePoint.

## Build

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

`slider_config.json` is ignored by git so private or environment-specific folder URLs are not committed. Agent settings are read when the Python agent starts. App settings, such as `time_per_slide_seconds`, `poster_time_seconds`, `interactive_pause_seconds`, `four_up`, `pan_posters`, `pdf_cache_size`, and `debug`, are embedded as defaults when you run `npm run build`; URL parameters still override them at runtime.

You can also provide core agent settings with command-line flags or environment variables, such as `--folder` or `SLIDER_FOLDER_URL`.

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

To show four slides at once in equal quarters, add:

```text
http://127.0.0.1:8788/slider.html?four_up=1
```

In four-up mode, each advance shifts the visible slides forward by one quarter and introduces one new slide.

If the shared folder contains a `Labs` folder, the agent recursively syncs its subfolders. During interactive mode, use the top-left menu to switch between:

- `Announcements`: the default slideshow from the root folder
- `Posters`: a randomized slideshow of all non-index PNG/PDF/HTML files under `Labs`
- `Labs`: a hierarchical list of lab folders
- `Cats`, `Puppies`, and `Jellyfish`: fullscreen YouTube livestreams with a countdown timer

Each lab folder can include an `index.html` file plus PNG/PDF/HTML poster files. Selecting a lab shows `index.html` on the left two-thirds of the screen and a scrollable poster selector on the right. Selecting a poster opens it full-screen with the normal interactive navigation and zoom controls.

Livestreams run for `live_stream_minutes` before returning to whichever autoplay mode, `Announcements` or `Posters`, was running most recently.

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
pyinstaller --onefile build/slider_agent.py
```

No separate `slider.html` is needed. The executable creates and updates `slider_data/` next to where it runs unless `--data-dir` is provided.
