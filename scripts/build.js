import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = resolve(root, "build");
const jsBuildDir = resolve(root, "build/js");

await rm(buildDir, { recursive: true, force: true });
await rm(resolve(root, "dist"), { recursive: true, force: true });
await mkdir(buildDir, { recursive: true });

const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
if (!configPath) {
  throw new Error("Could not find tsconfig.json");
}

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  reportDiagnostics([configFile.error]);
}

const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
const emitResult = program.emit();
const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);

if (diagnostics.length > 0) {
  reportDiagnostics(diagnostics);
}

const [template, css, js, agentSource, pdfJs, pdfWorkerJs] = await Promise.all([
  readFile(resolve(root, "src/template.html"), "utf8"),
  readFile(resolve(root, "src/styles.css"), "utf8"),
  readFile(resolve(jsBuildDir, "app.js"), "utf8"),
  readFile(resolve(root, "scripts/slider_agent.py"), "utf8"),
  readFile(resolve(root, "node_modules/pdfjs-dist/legacy/build/pdf.min.mjs"), "utf8"),
  readFile(resolve(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"), "utf8")
]);

const sliderConfig = await readOptionalJson(resolve(root, "slider_config.json"));
const sliderDefaults = getSliderDefaults(sliderConfig);
const agentDefaults = getAgentDefaults(sliderConfig);
const html = template
  .replace("__SLIDER_DEFAULTS__", () => formatSliderDefaults(sliderDefaults))
  .replace("__RUNTIME_SLIDER_DEFAULTS__", () => "      /* __RUNTIME_SLIDER_DEFAULTS__ */")
  .replace("__INLINE_PDF_JS__", () => pdfJs.trim())
  .replace("__PDF_WORKER_SOURCE__", () => formatPdfWorkerSource(pdfWorkerJs))
  .replace("__INLINE_CSS__", () => css.trim())
  .replace("__INLINE_JS__", () => js.trim());
const embeddedHtmlAssignment = `EMBEDDED_SLIDER_HTML = base64.b64decode(\n${formatPythonBase64String(html)}\n).decode("utf-8")`;
const agent = formatAgentDefaults(agentSource, agentDefaults)
  .replace(/^EMBEDDED_SLIDER_HTML = None$/m, embeddedHtmlAssignment);

if (agent === agentSource) {
  throw new Error("Could not find EMBEDDED_SLIDER_HTML assignment in slider_agent.py");
}

await writeFile(resolve(buildDir, "slider_agent.py"), agent, "utf8");
console.log("Built build/slider_agent.py");

function reportDiagnostics(diagnostics) {
  const message = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n"
  });
  console.error(message);
  process.exit(1);
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function getSliderDefaults(config) {
  const timePerSlideSeconds = positiveNumber(
    firstDefined(config.time_per_slide_seconds, config.time_seconds, config.time),
    30
  );

  return {
    manifestUrl: stringValue(firstDefined(config.manifest_url, config.manifest), "/manifest.json"),
    timePerSlideSeconds,
    posterTimeSeconds: positiveNumber(
      firstDefined(config.poster_time_seconds, config.poster_time),
      timePerSlideSeconds * 2
    ),
    interactivePauseSeconds: positiveNumber(
      firstDefined(config.interactive_pause_seconds, config.interactive_pause),
      120
    ),
    syncStaleAfterSeconds: positiveNumber(
      firstDefined(config.sync_stale_after_seconds, config.stale_after_seconds, config.stale_after),
      1800
    ),
    liveStreamMinutes: positiveNumber(config.live_stream_minutes, 30),
    fourUp: booleanValue(firstDefined(config.four_up, config.four), false),
    panPosters: booleanValue(config.pan_posters, true),
    panFraction: fractionValue(config.pan_fraction, 0.85),
    pdfCacheSize: positiveNumber(firstDefined(config.pdf_cache_size, config.pdf_cache), 200),
    pdfDocumentCache: booleanValue(firstDefined(config.pdf_document_cache, config.document_cache), true),
    pdfRenderCache: booleanValue(firstDefined(config.pdf_render_cache, config.render_cache), false),
    pdfMaxZoomRenderScale: positiveNumber(firstDefined(config.pdf_max_zoom_render_scale, config.pdf_zoom_render_scale), 5),
    debug: booleanValue(config.debug, false)
  };
}

function getAgentDefaults(config) {
  return {
    folderUrl: stringValue(config.folder_url, ""),
    host: stringValue(config.host, "127.0.0.1"),
    port: positiveInteger(config.port, 8788),
    syncIntervalSeconds: positiveInteger(config.sync_interval_seconds, 120),
    staleAfterSeconds: positiveInteger(
      firstDefined(config.stale_after_seconds, config.sync_stale_after_seconds, config.stale_after),
      1800
    ),
    dataDir: stringValue(config.data_dir, "slider_data"),
    autolaunch: booleanValue(firstDefined(config.autolaunch, config.launch_chrome_kiosk), true),
    chromePath: stringValue(config.chrome_path, "")
  };
}

function formatAgentDefaults(source, defaults) {
  return replacePythonConstant(source, "DEFAULT_FOLDER_URL", defaults.folderUrl)
    .replace(/^DEFAULT_HOST = .+$/m, `DEFAULT_HOST = ${JSON.stringify(defaults.host)}`)
    .replace(/^DEFAULT_PORT = .+$/m, `DEFAULT_PORT = ${JSON.stringify(defaults.port)}`)
    .replace(/^DEFAULT_SYNC_INTERVAL_SECONDS = .+$/m, `DEFAULT_SYNC_INTERVAL_SECONDS = ${JSON.stringify(defaults.syncIntervalSeconds)}`)
    .replace(/^DEFAULT_STALE_AFTER_SECONDS = .+$/m, `DEFAULT_STALE_AFTER_SECONDS = ${JSON.stringify(defaults.staleAfterSeconds)}`)
    .replace(/^DEFAULT_DATA_DIR = .+$/m, `DEFAULT_DATA_DIR = ${JSON.stringify(defaults.dataDir)}`)
    .replace(/^DEFAULT_AUTOLAUNCH = .+$/m, `DEFAULT_AUTOLAUNCH = ${defaults.autolaunch ? "True" : "False"}`)
    .replace(/^DEFAULT_CHROME_PATH = .+$/m, `DEFAULT_CHROME_PATH = ${JSON.stringify(defaults.chromePath)}`);
}

function replacePythonConstant(source, name, value) {
  return source.replace(new RegExp(`^${name} = .+$`, "m"), `${name} = ${JSON.stringify(value)}`);
}

function formatSliderDefaults(defaults) {
  // These are build-time defaults. Runtime URL parameters remain the final override.
  const assignments = [
    ["SLIDER_MANIFEST_URL", defaults.manifestUrl],
    ["SLIDER_TIME_PER_SLIDE_SECONDS", defaults.timePerSlideSeconds],
    ["SLIDER_POSTER_TIME_SECONDS", defaults.posterTimeSeconds],
    ["SLIDER_INTERACTIVE_PAUSE_SECONDS", defaults.interactivePauseSeconds],
    ["SLIDER_SYNC_STALE_AFTER_SECONDS", defaults.syncStaleAfterSeconds],
    ["SLIDER_LIVE_STREAM_MINUTES", defaults.liveStreamMinutes],
    ["SLIDER_FOUR_UP", defaults.fourUp],
    ["SLIDER_PAN_POSTERS", defaults.panPosters],
    ["SLIDER_PAN_FRACTION", defaults.panFraction],
    ["SLIDER_PDF_CACHE_SIZE", defaults.pdfCacheSize],
    ["SLIDER_PDF_DOCUMENT_CACHE", defaults.pdfDocumentCache],
    ["SLIDER_PDF_RENDER_CACHE", defaults.pdfRenderCache],
    ["SLIDER_PDF_MAX_ZOOM_RENDER_SCALE", defaults.pdfMaxZoomRenderScale],
    ["SLIDER_DEBUG", defaults.debug]
  ];

  return assignments
    .map(([name, value]) => `      window.${name} = ${JSON.stringify(value)};`)
    .join("\n");
}

function formatPdfWorkerSource(workerSource) {
  // PDF.js needs its worker as a URL. Store the source string in the self-contained
  // HTML and let the app create an object URL at runtime.
  return `      window.SLIDER_PDF_WORKER_SOURCE = ${JSON.stringify(workerSource)};`;
}

function formatPythonBase64String(value) {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  const chunks = encoded.match(/.{1,76}/g) || [""];
  return chunks.map((chunk) => `    ${JSON.stringify(chunk)}`).join("\n");
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function stringValue(value, fallback) {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function fractionValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1 ? number : fallback;
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}
