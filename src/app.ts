type SlideKind = "image" | "pdf" | "html";
type SyncStatus = "ok" | "syncing" | "error";
type AutoplayMode = "announcements" | "posters";
type AppMode = AutoplayMode | "lab" | "poster" | "live-stream";
type BannerKind = "general" | "sync";

interface SliderGlobals {
  SLIDER_APP_VERSION?: string;
  SLIDER_MANIFEST_URL?: string;
  SLIDER_TIME_PER_SLIDE_SECONDS?: number;
  SLIDER_POSTER_TIME_SECONDS?: number;
  SLIDER_INTERACTIVE_PAUSE_SECONDS?: number;
  SLIDER_SYNC_STALE_AFTER_SECONDS?: number;
  SLIDER_LIVE_STREAM_MINUTES?: number;
  SLIDER_LIVE_STREAMS?: Record<string, string>;
  SLIDER_FOUR_UP?: boolean | "auto";
  SLIDER_PAN_POSTERS?: boolean;
  SLIDER_POSTER_SLIDES_CONTROLS_ALWAYS_VISIBLE?: boolean;
  SLIDER_PAN_FRACTION?: number;
  SLIDER_PDF_CACHE_SIZE?: number;
  SLIDER_PDF_RENDER_CACHE?: boolean;
  SLIDER_PDF_INITIAL_RENDER_SCALE?: number;
  SLIDER_PDF_MAX_ZOOM_RENDER_SCALE?: number;
  SLIDER_DEBUG?: boolean;
  SLIDER_PDF_WORKER_SOURCE?: string;
}

interface PdfJsGlobal {
  GlobalWorkerOptions: {
    workerSrc: string;
  };
  getDocument(source: { url: string }): {
    promise: Promise<PdfDocumentProxy>;
  };
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  cleanup(keepLoadedFonts?: boolean): Promise<void>;
}

interface PdfPageProxy {
  getViewport(options: { scale: number }): PdfViewport;
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): {
    promise: Promise<void>;
  };
}

interface PdfViewport {
  width: number;
  height: number;
}

interface SlideItem {
  id?: string;
  name: string;
  kind: SlideKind;
  url: string;
  modified?: string;
}

interface SyncState {
  status?: SyncStatus;
  error?: string;
  lastAttempt?: string;
  lastSuccess?: string;
  staleAfterSeconds?: number;
}

interface SlideManifest {
  generatedAt?: string;
  sync?: SyncState;
  slides?: SlideItem[];
  labs?: LabFolder[];
}

interface LabFolder {
  id?: string;
  name: string;
  path: string;
  index?: SlideItem | null;
  items?: SlideItem[];
  children?: LabFolder[];
}

interface SliderConfig {
  manifestUrl: string;
  timePerSlideSeconds: number;
  posterTimeSeconds: number;
  interactivePauseSeconds: number;
  syncStaleAfterSeconds: number;
  liveStreamMinutes: number;
  liveStreams: LiveStreamConfig[];
  fourUp: boolean;
  panPosters: boolean;
  posterSlidesControlsAlwaysVisible: boolean;
  panFraction: number;
  pdfCacheSize: number;
  pdfRenderCache: boolean;
  pdfInitialRenderScale: number;
  pdfMaxZoomRenderScale: number;
  debug: boolean;
}

interface PdfRenderResult {
  canvas: HTMLCanvasElement;
  fitWidth: number;
  fitHeight: number;
  renderWidth: number;
  renderHeight: number;
  outputScale: number;
}

interface PdfRenderSnapshot {
  bitmap: ImageBitmap;
  canvasWidth: number;
  canvasHeight: number;
  fitWidth: number;
  fitHeight: number;
  renderWidth: number;
  renderHeight: number;
  outputScale: number;
}

interface PdfRenderCacheEntry {
  key: string;
  promise: Promise<PdfRenderSnapshot>;
  activeUsers: number;
  evicted: boolean;
  released: boolean;
  snapshot?: PdfRenderSnapshot;
}

interface PdfRenderOptions {
  outputScale?: number;
  renderMode?: PdfRenderMode;
  useCache?: boolean;
}

type PdfRenderMode = "fit" | "width";

interface LiveStreamConfig {
  name: string;
  url: string;
}

interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

interface PointerState {
  id: number;
  x: number;
  y: number;
}

const stage = mustGetElement("stage");
const statusNode = mustGetElement("status");
const banner = mustGetElement("banner");
const menuToggle = mustGetElement("menu-toggle") as HTMLButtonElement;
const menuPanel = mustGetElement("menu-panel");
const devMenuPanel = mustGetElement("dev-menu-panel");
const devMenuVersion = mustGetElement("dev-menu-version");
const announcementsButton = mustGetElement("menu-announcements") as HTMLButtonElement;
const postersButton = mustGetElement("menu-posters") as HTMLButtonElement;
const liveStreamMenu = mustGetElement("live-stream-menu");
const fullscreenDivider = mustGetElement("fullscreen-divider");
const fullscreenButton = mustGetElement("menu-fullscreen") as HTMLButtonElement;
const updateButton = mustGetElement("menu-update") as HTMLButtonElement;
const manualSyncButton = mustGetElement("menu-manual-sync") as HTMLButtonElement;
const clearRenderCacheButton = mustGetElement("menu-clear-render-cache") as HTMLButtonElement;
const clearCachesButton = mustGetElement("menu-clear-caches") as HTMLButtonElement;
const quitButton = mustGetElement("menu-quit") as HTMLButtonElement;
const labsMenu = mustGetElement("labs-menu");
const previousButton = mustGetElement("previous-slide") as HTMLButtonElement;
const nextButton = mustGetElement("next-slide") as HTMLButtonElement;
const zoomInButton = mustGetElement("zoom-in") as HTMLButtonElement;
const zoomOutButton = mustGetElement("zoom-out") as HTMLButtonElement;
const liveStreamCountdown = mustGetElement("live-stream-countdown");
const liveStreamTime = mustGetElement("live-stream-time");
const liveStreamReset = mustGetElement("live-stream-reset") as HTMLButtonElement;
const maxPdfCanvasDimension = 16384;
const maxPdfCanvasPixels = 128 * 1024 * 1024;
const pdfThumbnailRenderScale = 2;
const devMenuLongPressMs = 5000;

class PdfCanvasTooLargeError extends Error {
  constructor(width: number, height: number) {
    super(`PDF render is too large for this browser canvas (${width}x${height}).`);
    this.name = "PdfCanvasTooLargeError";
  }
}

class PdfBlankRenderError extends Error {
  constructor(width: number, height: number) {
    super(`PDF render appears blank or all black (${width}x${height}).`);
    this.name = "PdfBlankRenderError";
  }
}

let slides: SlideItem[] = [];
let labs: LabFolder[] = [];
let slideIndex = -1;
let appMode: AppMode = "announcements";
let activeSlide: HTMLElement | null = null;
let activeFourSlides: HTMLElement[] = [];
let activeFourIndices: number[] = [];
let nextFourSlideIndex = 0;
let fourUpCycleWrapped = false;
let slideRenderToken = 0;
let activeTransformTarget: HTMLElement | null = null;
let activeTransform: ViewTransform = getDefaultTransform();
let transformByTarget = new WeakMap<HTMLElement, ViewTransform>();
let activePointers = new Map<number, PointerState>();
let gestureStartTransform: ViewTransform | null = null;
let gestureStartDistance = 0;
let gestureStartCenter: { x: number; y: number } | null = null;
let interactivePauseUntil = 0;
let controlsHideTimer = 0;
let posterItems: SlideItem[] = [];
let posterIndex = -1;
let posterSlideshowItems: SlideItem[] = [];
let posterSlideshowIndex = -1;
let cycleNeedsRefresh = true;
let running = false;
let config: SliderConfig;
let pdfWorkerUrl = "";
let pdfRenderCache = new Map<string, PdfRenderCacheEntry>();
let pdfZoomRenderTimer = 0;
let pdfZoomRenderToken = 0;
let pdfZoomRenderTarget: HTMLElement | null = null;
let pdfZoomRenderScale = 1;
let pdfZoomRenderFailedScale = Number.POSITIVE_INFINITY;
let pdfPrefetchIdleHandle = 0;
let pdfPrefetchTimer = 0;
let pdfPrefetchToken = 0;
let lastAutoplayMode: AutoplayMode = "announcements";
let liveStreamEndsAt = 0;
let liveStreamTimer = 0;
let sizingRefreshToken = 0;
let bannerKind: BannerKind | null = null;
let bannerHideTimer = 0;
let devMenuLongPressTimer = 0;
let devMenuLongPressTriggered = false;

const defaultLiveStreams: Record<string, string> = {
  Cats: "https://www.youtube.com/watch?v=e9C9K8ltDfk",
  Puppies: "https://www.youtube.com/watch?v=h-Z0wCdD3dI",
  Jellyfish: "https://www.youtube.com/watch?v=m1XcdxjVGos",
  ISS: "https://www.youtube.com/watch?v=FuuC4dpSQ1M"
};

start().catch((error: unknown) => {
  logCaughtException("slider startup failed", error);
  showBanner(`Slider failed to start: ${getErrorMessage(error)}`);
});

async function start(): Promise<void> {
  config = getConfig();
  configurePdfJs();
  renderDevMenuVersion();
  renderLiveStreamMenu();
  wireControls();
  document.body.classList.toggle("four-mode", config.fourUp && appMode === "announcements");
  running = true;
  await refreshSlides(config);

  // The slideshow loop advances announcement slides and the randomized poster
  // stream. Lab browsing and selected poster detail views are user-driven modes.
  while (running) {
    if (appMode === "lab" || appMode === "poster" || appMode === "live-stream") {
      await sleep(500);
      continue;
    }

    const autoplayItems = getAutoplayItems();
    if (autoplayItems.length === 0) {
      await sleep(5000);
      await refreshSlides(config);
      continue;
    }

    if (cycleNeedsRefresh) {
      await refreshSlides(config);
      cycleNeedsRefresh = false;
    }

    if (appMode === "posters") {
      posterSlideshowIndex = (posterSlideshowIndex + 1) % posterSlideshowItems.length;
      await showSlide(posterSlideshowItems[posterSlideshowIndex]);
    } else if (config.fourUp) {
      await advanceFourSlides();
    } else {
      slideIndex = (slideIndex + 1) % slides.length;
      await showSlide(slides[slideIndex]);
    }

    if (isAutoplayPassComplete()) {
      cycleNeedsRefresh = true;
    }

    await waitForAdvance(getAutoplayDelaySeconds() * 1000);
  }
}

function renderDevMenuVersion(): void {
  const globals = window as Window & SliderGlobals;
  const version = String(globals.SLIDER_APP_VERSION || "").trim();
  devMenuVersion.textContent = version ? `Version ${version}` : "Version unknown";
}

function wireControls(): void {
  menuToggle.addEventListener("pointerdown", (event) => {
    pauseForInteraction();
    devMenuLongPressTriggered = false;
    window.clearTimeout(devMenuLongPressTimer);
    devMenuLongPressTimer = window.setTimeout(() => {
      devMenuLongPressTriggered = true;
      setDevMenuOpen(true);
    }, devMenuLongPressMs);
    event.stopPropagation();
  });
  const cancelDevMenuLongPress = () => {
    window.clearTimeout(devMenuLongPressTimer);
  };
  menuToggle.addEventListener("pointerup", cancelDevMenuLongPress);
  menuToggle.addEventListener("pointercancel", cancelDevMenuLongPress);
  menuToggle.addEventListener("pointerleave", cancelDevMenuLongPress);
  menuToggle.addEventListener("contextmenu", (event) => event.preventDefault());
  menuToggle.addEventListener("click", (event) => {
    pauseForInteraction();
    if (devMenuLongPressTriggered) {
      devMenuLongPressTriggered = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    setMenuOpen(!menuPanel.classList.contains("open"));
    event.stopPropagation();
  });
  menuPanel.addEventListener("pointerdown", (event) => event.stopPropagation());
  menuPanel.addEventListener("click", (event) => event.stopPropagation());
  devMenuPanel.addEventListener("pointerdown", (event) => event.stopPropagation());
  devMenuPanel.addEventListener("click", (event) => event.stopPropagation());
  announcementsButton.addEventListener("click", () => showAnnouncements());
  postersButton.addEventListener("click", () => showPosters());
  fullscreenButton.addEventListener("click", () => {
    void enterFullscreen();
  });
  updateButton.addEventListener("click", () => {
    void checkForUpdates();
  });
  manualSyncButton.addEventListener("click", () => {
    void runManualSync();
  });
  clearRenderCacheButton.addEventListener("click", () => {
    clearRenderCache();
  });
  clearCachesButton.addEventListener("click", () => {
    void clearCaches();
  });
  quitButton.addEventListener("click", () => {
    void quitSlider();
  });
  banner.addEventListener("click", (event) => {
    event.stopPropagation();
    hideBanner();
  });
  liveStreamReset.addEventListener("click", (event) => {
    event.stopPropagation();
    resetLiveStreamCountdown();
  });
  previousButton.addEventListener("click", () => showPreviousSlide(previousButton));
  nextButton.addEventListener("click", () => showNextSlide(nextButton));
  zoomInButton.addEventListener("click", () => {
    pauseForInteraction();
    zoomAt(1.25);
  });
  zoomOutButton.addEventListener("click", () => {
    pauseForInteraction();
    zoomAt(0.8);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") {
      showPreviousSlide(previousButton);
    } else if (event.key === "ArrowRight") {
      showNextSlide(nextButton);
    } else if (event.key === "+" || event.key === "=") {
      pauseForInteraction();
      zoomAt(1.25);
    } else if (event.key === "-" || event.key === "_") {
      pauseForInteraction();
      zoomAt(0.8);
    }
  });
  document.addEventListener("fullscreenchange", () => {
    updateFullscreenMenu();
    void refreshCurrentSlideSizing();
  });
  document.addEventListener("pointerdown", () => {
    if (menuPanel.classList.contains("open")) {
      setMenuOpen(false);
    }
    if (devMenuPanel.classList.contains("open")) {
      setDevMenuOpen(false);
    }
  });
  updateFullscreenMenu();
}

function renderLiveStreamMenu(): void {
  liveStreamMenu.replaceChildren();
  for (const stream of config.liveStreams) {
    const button = document.createElement("button");
    button.className = "menu-item";
    button.type = "button";
    button.textContent = stream.name;
    button.addEventListener("click", () => showLiveStream(stream));
    liveStreamMenu.append(button);
  }
}

async function checkForUpdates(): Promise<void> {
  setMenuOpen(false);
  setDevMenuOpen(false);
  updateButton.disabled = true;
  showBanner("Installing latest version...");
  try {
    const response = await fetch("/update/check", { method: "POST", cache: "no-store" });
    const payload = await response.json() as { message?: string; status?: string };
    if (!response.ok) {
      throw new Error(payload.message || `Update failed (${response.status}).`);
    }
    showBanner(payload.message || "Update started.");
  } catch (error: unknown) {
    logCaughtException("update action failed", error);
    showBanner(`Update failed: ${getErrorMessage(error)}`);
  } finally {
    updateButton.disabled = false;
  }
}

async function runManualSync(): Promise<void> {
  setDevMenuOpen(false);
  manualSyncButton.disabled = true;
  showBanner("Syncing slides...");
  try {
    const response = await fetch("/sync/now", { method: "POST", cache: "no-store" });
    const payload = await response.json() as { message?: string; status?: string };
    if (!response.ok) {
      throw new Error(payload.message || `Manual sync failed (${response.status}).`);
    }

    await refreshSlides(config);
    cycleNeedsRefresh = true;
    showBanner(payload.message || "Manual sync complete.");
  } catch (error: unknown) {
    logCaughtException("manual sync failed", error);
    showBanner(`Manual sync failed: ${getErrorMessage(error)}`);
  } finally {
    manualSyncButton.disabled = false;
  }
}

async function clearCaches(): Promise<void> {
  setDevMenuOpen(false);
  clearCachesButton.disabled = true;
    showBanner("Clearing caches...");
  try {
    cancelScheduledPdfPrefetch();
    clearPdfRenderCache();
    transformByTarget = new WeakMap<HTMLElement, ViewTransform>();
    await clearBrowserCacheStorage();
    showBanner("Caches cleared.");
  } catch (error: unknown) {
    logCaughtException("clear caches failed", error);
    showBanner(`Unable to clear caches: ${getErrorMessage(error)}`);
  } finally {
    clearCachesButton.disabled = false;
  }
}

function clearRenderCache(): void {
  setDevMenuOpen(false);
  clearRenderCacheButton.disabled = true;
  showBanner("Clearing render cache...");
  try {
    cancelScheduledPdfPrefetch();
    clearPdfRenderCache();
    showBanner("Render cache cleared.");
  } catch (error: unknown) {
    logCaughtException("clear render cache failed", error);
    showBanner(`Unable to clear render cache: ${getErrorMessage(error)}`);
  } finally {
    clearRenderCacheButton.disabled = false;
  }
}

async function quitSlider(): Promise<void> {
  setDevMenuOpen(false);
  quitButton.disabled = true;
  showBanner("Quitting slider...");
  try {
    const response = await fetch("/quit", { method: "POST", cache: "no-store" });
    const payload = await response.json() as { message?: string; status?: string };
    if (!response.ok) {
      throw new Error(payload.message || `Quit failed (${response.status}).`);
    }

    running = false;
    showBanner(payload.message || "Slider is quitting.");
  } catch (error: unknown) {
    logCaughtException("quit failed", error);
    quitButton.disabled = false;
    showBanner(`Quit failed: ${getErrorMessage(error)}`);
  }
}

async function clearBrowserCacheStorage(): Promise<void> {
  if (!("caches" in window)) {
    return;
  }

  const names = await caches.keys();
  await Promise.all(names.map((name) => caches.delete(name)));
}

function setMenuOpen(open: boolean): void {
  menuPanel.classList.toggle("open", open);
  document.body.classList.toggle("menu-open", open);
  if (open) {
    setDevMenuOpen(false);
  }
  if (open) {
    updateFullscreenMenu();
  }
}

function setDevMenuOpen(open: boolean): void {
  devMenuPanel.classList.toggle("open", open);
  document.body.classList.toggle("dev-menu-open", open);
  if (open) {
    setMenuOpen(false);
  }
}

async function enterFullscreen(): Promise<void> {
  if (isKioskMode() || !document.fullscreenEnabled || document.fullscreenElement) {
    updateFullscreenMenu();
    return;
  }

  setMenuOpen(false);
  try {
    await document.documentElement.requestFullscreen();
  } catch (error: unknown) {
    logCaughtException("enter fullscreen failed", error);
    showBanner(`Unable to enter fullscreen: ${getErrorMessage(error)}`);
    updateFullscreenMenu();
  }
}

function updateFullscreenMenu(): void {
  const hidden = isKioskMode() || !document.fullscreenEnabled || Boolean(document.fullscreenElement);
  fullscreenDivider.hidden = hidden;
  fullscreenButton.hidden = hidden;
}

function isKioskMode(): boolean {
  const params = new URLSearchParams(window.location.search);
  return parseBooleanParam(params.get("kiosk"), false);
}

function getConfig(): SliderConfig {
  const globals = window as Window & SliderGlobals;
  const params = new URLSearchParams(window.location.search);
  const manifestUrl = params.get("manifest_url")?.trim()
    || globals.SLIDER_MANIFEST_URL?.trim()
    || "/manifest.json";
  const rawTime = params.get("time_per_slide_seconds");
  const parsedTime = rawTime ? Number(rawTime) : Number(globals.SLIDER_TIME_PER_SLIDE_SECONDS);
  const timePerSlideSeconds = Number.isFinite(parsedTime) && parsedTime > 0 ? parsedTime : 10;
  const rawPosterTime = params.get("poster_time_seconds");
  const parsedPosterTime = rawPosterTime ? Number(rawPosterTime) : Number(globals.SLIDER_POSTER_TIME_SECONDS);
  const rawInteractivePause = params.get("interactive_pause_seconds");
  const parsedInteractivePause = rawInteractivePause
    ? Number(rawInteractivePause)
    : Number(globals.SLIDER_INTERACTIVE_PAUSE_SECONDS);
  const rawStaleAfter = params.get("stale_after_seconds");
  const parsedStaleAfter = rawStaleAfter ? Number(rawStaleAfter) : Number(globals.SLIDER_SYNC_STALE_AFTER_SECONDS);
  const rawLiveStreamMinutes = params.get("live_stream_minutes");
  const parsedLiveStreamMinutes = rawLiveStreamMinutes
    ? Number(rawLiveStreamMinutes)
    : Number(globals.SLIDER_LIVE_STREAM_MINUTES);
  const liveStreams = normalizeLiveStreams(globals.SLIDER_LIVE_STREAMS || defaultLiveStreams);
  const rawPdfCacheSize = params.get("pdf_cache_size");
  const parsedPdfCacheSize = rawPdfCacheSize ? Number(rawPdfCacheSize) : Number(globals.SLIDER_PDF_CACHE_SIZE);
  const pdfRenderCache = parseBooleanParam(params.get("pdf_render_cache"), globals.SLIDER_PDF_RENDER_CACHE ?? false);
  const rawPdfInitialRenderScale = params.get("pdf_initial_render_scale");
  const parsedPdfInitialRenderScale = rawPdfInitialRenderScale
    ? Number(rawPdfInitialRenderScale)
    : Number(globals.SLIDER_PDF_INITIAL_RENDER_SCALE);
  const rawPdfMaxZoomRenderScale = params.get("pdf_max_zoom_render_scale");
  const parsedPdfMaxZoomRenderScale = rawPdfMaxZoomRenderScale
    ? Number(rawPdfMaxZoomRenderScale)
    : Number(globals.SLIDER_PDF_MAX_ZOOM_RENDER_SCALE);
  const fourUp = resolveFourUp(firstDefined(params.get("four_up"), globals.SLIDER_FOUR_UP, false));
  const panPosters = parseBooleanParam(params.get("pan_posters"), globals.SLIDER_PAN_POSTERS ?? true);
  const posterSlidesControlsAlwaysVisible = parseBooleanParam(
    params.get("poster_slides_controls_always_visible"),
    globals.SLIDER_POSTER_SLIDES_CONTROLS_ALWAYS_VISIBLE ?? false
  );
  const rawPanFraction = params.get("pan_fraction");
  const parsedPanFraction = rawPanFraction ? Number(rawPanFraction) : Number(globals.SLIDER_PAN_FRACTION);

  return {
    manifestUrl,
    timePerSlideSeconds,
    // Posters default to a slower cadence because dense poster content generally
    // needs more reading time than announcements.
    posterTimeSeconds: Number.isFinite(parsedPosterTime) && parsedPosterTime > 0 ? parsedPosterTime : timePerSlideSeconds * 2,
    interactivePauseSeconds: Number.isFinite(parsedInteractivePause) && parsedInteractivePause > 0 ? parsedInteractivePause : 120,
    syncStaleAfterSeconds: Number.isFinite(parsedStaleAfter) && parsedStaleAfter > 0 ? parsedStaleAfter : 1800,
    liveStreamMinutes: Number.isFinite(parsedLiveStreamMinutes) && parsedLiveStreamMinutes > 0 ? parsedLiveStreamMinutes : 30,
    liveStreams,
    fourUp,
    panPosters,
    posterSlidesControlsAlwaysVisible,
    panFraction: Number.isFinite(parsedPanFraction) && parsedPanFraction > 0 && parsedPanFraction <= 1 ? parsedPanFraction : 0.85,
    pdfCacheSize: Number.isFinite(parsedPdfCacheSize) && parsedPdfCacheSize >= 0 ? Math.floor(parsedPdfCacheSize) : 200,
    pdfRenderCache,
    pdfInitialRenderScale: Number.isFinite(parsedPdfInitialRenderScale) && parsedPdfInitialRenderScale > 0 ? parsedPdfInitialRenderScale : 2,
    pdfMaxZoomRenderScale: Number.isFinite(parsedPdfMaxZoomRenderScale) && parsedPdfMaxZoomRenderScale > 0 ? parsedPdfMaxZoomRenderScale : 5,
    debug: parseBooleanParam(params.get("debug"), Boolean(globals.SLIDER_DEBUG))
  };
}

function normalizeLiveStreams(streams: Record<string, string>): LiveStreamConfig[] {
  return Object.entries(streams)
    .map(([name, url]) => ({ name: name.trim(), url: String(url || "").trim() }))
    .filter((stream) => stream.name && stream.url);
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function resolveFourUp(value: unknown): boolean {
  if (String(value).trim().toLowerCase() === "auto") {
    const size = getAutoFourUpSize();
    return size.width >= 3840 && size.height >= 2160;
  }

  return parseBooleanParam(value == null ? null : String(value), false);
}

function getAutoFourUpSize(): { width: number; height: number } {
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const viewportWidth = window.innerWidth * pixelRatio;
  const viewportHeight = window.innerHeight * pixelRatio;
  const screenWidth = window.screen?.width ? window.screen.width * pixelRatio : 0;
  const screenHeight = window.screen?.height ? window.screen.height * pixelRatio : 0;

  return {
    width: Math.max(viewportWidth, screenWidth),
    height: Math.max(viewportHeight, screenHeight)
  };
}

function configurePdfJs(): void {
  const globals = window as Window & SliderGlobals;
  const pdfJs = getPdfJsLib();
  if (!pdfJs || !globals.SLIDER_PDF_WORKER_SOURCE) {
    return;
  }

  // The worker source is embedded at build time so the generated Python agent
  // remains a single deployable file with no CDN or sidecar PDF.js assets.
  const workerBlob = new Blob([globals.SLIDER_PDF_WORKER_SOURCE], { type: "text/javascript" });
  pdfWorkerUrl = URL.createObjectURL(workerBlob);
  pdfJs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

function getPdfJsLib(): PdfJsGlobal | undefined {
  return (globalThis as typeof globalThis & { pdfjsLib?: PdfJsGlobal }).pdfjsLib;
}

async function refreshSlides(config: SliderConfig): Promise<void> {
  try {
    const manifest = await fetchManifest(config.manifestUrl);
    const nextSlides = getManifestSlides(manifest);
    const slidesChanged = getSlideListSignature(slides) !== getSlideListSignature(nextSlides);
    labs = getManifestLabs(manifest);
    renderMenu();
    slides = nextSlides;
    slideIndex = normalizeSlideIndex(slideIndex, slides.length);

    // Poster mode is intentionally randomized once per pass. A manifest refresh
    // starts the next pass with a new flattened order from every lab folder.
    if (appMode === "posters" || posterSlideshowItems.length === 0) {
      posterSlideshowItems = shuffleSlides(collectLabPosters(labs));
      posterSlideshowIndex = -1;
    }

    // Four-up mode holds live DOM nodes for each quadrant; rebuild them when the
    // manifest changes so stale indices do not point at removed or updated slides.
    if (config.fourUp && slidesChanged) {
      activeFourSlides.forEach((node) => node.remove());
      activeFourSlides = [];
      activeFourIndices = [];
      nextFourSlideIndex = 0;
      fourUpCycleWrapped = false;
      if (appMode === "announcements" && slides.length > 0) {
        initializeFourSlides();
      }
    }
    updateSyncBanner(manifest, config);
    if (appMode === "announcements" && config.fourUp) {
      fourUpCycleWrapped = false;
    }

    if ((appMode === "announcements" || appMode === "posters") && getAutoplayItems().length === 0) {
      showStaticMessage(getEmptyAutoplayMessage());
    } else if (appMode === "announcements" || appMode === "posters") {
      clearStaticMessage();
    }
  } catch (error: unknown) {
    logCaughtException("refresh slides failed", error);
    showBanner(`Unable to read local slide manifest: ${getErrorMessage(error)}`);
  }
}

async function fetchManifest(manifestUrl: string): Promise<SlideManifest> {
  const response = await fetch(cacheBustedUrl(manifestUrl), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`.trim());
  }

  return (await response.json()) as SlideManifest;
}

function getAutoplayItems(): SlideItem[] {
  if (appMode === "posters") {
    return posterSlideshowItems;
  }

  if (appMode === "announcements") {
    return slides;
  }

  return [];
}

function isAutoplayPassComplete(): boolean {
  if (appMode === "announcements" && config.fourUp) {
    return fourUpCycleWrapped;
  }

  return appMode === "posters"
    ? posterSlideshowIndex === posterSlideshowItems.length - 1
    : slideIndex === slides.length - 1;
}

function getEmptyAutoplayMessage(): string {
  return appMode === "posters"
    ? "No lab poster content is available yet."
    : "No supported slides are available yet.";
}

function getAutoplayDelaySeconds(): number {
  return appMode === "posters" ? config.posterTimeSeconds : config.timePerSlideSeconds;
}

function updateSyncBanner(manifest: SlideManifest, config: SliderConfig): void {
  const sync = manifest.sync;
  const staleAfterSeconds = sync?.staleAfterSeconds || config.syncStaleAfterSeconds;
  const staleMessage = getStaleMessage(sync?.lastSuccess, staleAfterSeconds);

  if (sync?.status && sync.status !== "ok") {
    const detail = sync.error ? `: ${sync.error}` : "";
    showBanner(`Slide sync ${sync.status}${detail}`, "sync");
    return;
  }

  if (staleMessage) {
    showBanner(staleMessage, "sync");
    return;
  }

  hideBanner("sync");
}

function getStaleMessage(lastSuccess: string | undefined, staleAfterSeconds: number): string {
  if (!lastSuccess) {
    return "Slide sync has not completed yet.";
  }

  const lastSuccessMs = Date.parse(lastSuccess);
  if (!Number.isFinite(lastSuccessMs)) {
    return "Slide sync health is unknown.";
  }

  const ageSeconds = (Date.now() - lastSuccessMs) / 1000;
  return ageSeconds > staleAfterSeconds
    ? `Slide sync is stale; last successful sync was ${formatAge(ageSeconds)} ago.`
    : "";
}

function formatAge(ageSeconds: number): string {
  if (ageSeconds < 120) {
    return `${Math.max(1, Math.round(ageSeconds))} seconds`;
  }

  if (ageSeconds < 7200) {
    return `${Math.round(ageSeconds / 60)} minutes`;
  }

  return `${Math.round(ageSeconds / 3600)} hours`;
}

async function showSlide(slide: SlideItem, direction: "next" | "previous" = "next"): Promise<void> {
  const token = ++slideRenderToken;
  if (appMode === "announcements" || appMode === "posters" || appMode === "poster") {
    stage.querySelectorAll(".lab-view, .cat-stream").forEach((node) => node.remove());
  }
  activeFourSlides.forEach((node) => node.remove());
  activeFourSlides = [];

  // Append first, then wait one frame before toggling classes so CSS transitions
  // see a real "before" and "after" state.
  const next = document.createElement("article");
  next.className = "slide";
  next.classList.toggle("reverse-enter", direction === "previous");
  next.setAttribute("aria-label", slide.name);
  next.append(createInteractiveViewport(slide));
  stage.append(next);

  await waitForSlideReady(next);
  await waitForPaint();
  if (token !== slideRenderToken || !next.isConnected) {
    next.remove();
    return;
  }

  const previous = activeSlide;
  previous?.classList.remove("active");
  previous?.classList.toggle("reverse-exit", direction === "previous");
  previous?.classList.add("exiting");
  next.classList.remove("reverse-enter");
  next.classList.add("active");

  activeSlide = next;
  resetTransform();
  showDebugTitle(slide.name);
  preloadUpcomingPdfs();

  window.setTimeout(() => {
    previous?.remove();
  }, 700);
}

async function showSlideWithManualLoading(
  slide: SlideItem,
  direction: "next" | "previous",
  loadingButton?: HTMLButtonElement
): Promise<void> {
  const showLoading = slide.kind === "pdf" && loadingButton;
  if (showLoading) {
    setNavButtonLoading(loadingButton, true);
  }

  try {
    await showSlide(slide, direction);
  } finally {
    if (showLoading) {
      setNavButtonLoading(loadingButton, false);
    }
  }
}

function setNavButtonLoading(button: HTMLButtonElement, loading: boolean): void {
  button.classList.toggle("loading", loading);
  button.disabled = loading;
  button.setAttribute("aria-busy", String(loading));
}

async function waitForSlideReady(slideNode: HTMLElement): Promise<void> {
  const media = slideNode.querySelector(".slide-content > img, .slide-content > iframe, .pdfjs-page") as HTMLElement | null;
  if (!media) {
    return;
  }

  await withTimeout(waitForMediaReady(media), 5000);
}

function waitForMediaReady(media: HTMLElement): Promise<void> {
  if (media instanceof HTMLImageElement) {
    if (media.complete && media.naturalWidth > 0) {
      return Promise.resolve();
    }

    return waitForEvent(media, ["load", "error"]);
  }

  if (media instanceof HTMLIFrameElement) {
    try {
      if (media.contentDocument?.readyState === "complete") {
        return Promise.resolve();
      }
    } catch (error: unknown) {
      logCaughtException("iframe readiness check failed", error);
      // Cross-origin frames cannot expose readiness; wait for the frame load event.
    }

    return waitForEvent(media, ["load", "error"]);
  }

  if (media.classList.contains("pdfjs-page")) {
    if (media.dataset.renderHeight) {
      return Promise.resolve();
    }

    return waitForEvent(media, ["pdf-rendered"]);
  }

  return Promise.resolve();
}

function waitForEvent(target: EventTarget, names: string[]): Promise<void> {
  return new Promise((resolve) => {
    const cleanup = () => names.forEach((name) => target.removeEventListener(name, onEvent));
    const onEvent = () => {
      cleanup();
      resolve();
    };
    names.forEach((name) => target.addEventListener(name, onEvent, { once: true }));
  });
}

function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, timeoutMs);
    promise.then(resolve).catch((error: unknown) => {
      logCaughtException("media readiness wait failed", error);
      resolve();
    }).finally(() => window.clearTimeout(timeout));
  });
}

async function refreshCurrentSlideSizing(): Promise<void> {
  const token = ++sizingRefreshToken;
  await waitForPaint();
  if (token !== sizingRefreshToken) {
    return;
  }

  if (appMode === "announcements" && config.fourUp) {
    initializeFourSlides();
    return;
  }

  const slide = getCurrentSlideItem();
  if (slide) {
    await showSlide(slide);
  }
}

function getCurrentSlideItem(): SlideItem | null {
  if (appMode === "announcements") {
    return slides[slideIndex] || null;
  }

  if (appMode === "posters") {
    return posterSlideshowItems[posterSlideshowIndex] || null;
  }

  if (appMode === "poster") {
    return posterItems[posterIndex] || null;
  }

  return null;
}

function renderMenu(): void {
  labsMenu.replaceChildren();
  const menuLabs = getIndexedLabs(labs);
  labsMenu.classList.toggle("multi-column", menuLabs.length > 10);
  if (menuLabs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-empty";
    empty.textContent = "No labs available";
    labsMenu.append(empty);
    return;
  }

  labsMenu.append(createLabMenuList(menuLabs));
}

function createLabMenuList(items: LabFolder[]): HTMLElement {
  const list = document.createElement("ul");
  list.className = "lab-menu-list";
  list.classList.toggle("multi-column", items.length > 10);
  for (const lab of items) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "menu-item lab-menu-item";
    button.type = "button";
    button.textContent = lab.name;
    button.addEventListener("click", () => showLab(lab));
    item.append(button);
    const children = getIndexedLabs(lab.children || []);
    if (children.length > 0) {
      item.append(createLabMenuList(children));
    }
    list.append(item);
  }
  return list;
}

function getIndexedLabs(items: LabFolder[]): LabFolder[] {
  return items.filter((lab) => isSlideItem(lab.index));
}

function showAnnouncements(): void {
  setAppMode("announcements");
  lastAutoplayMode = "announcements";
  stopLiveStreamCountdown();
  posterItems = [];
  posterIndex = -1;
  setMenuOpen(false);
  exitInteractiveMode();
  stage.querySelectorAll(".lab-view, .cat-stream").forEach((node) => node.remove());
  activeFourSlides.forEach((node) => node.remove());
  activeFourSlides = [];
  activeFourIndices = [];
  activeSlide?.remove();
  activeSlide = null;
  if (slides.length > 0) {
    if (config.fourUp) {
      nextFourSlideIndex = 0;
      fourUpCycleWrapped = false;
      initializeFourSlides();
    } else {
      slideIndex = (normalizeSlideIndex(slideIndex, slides.length) + 1) % slides.length;
      void showSlide(slides[slideIndex]);
    }
  } else {
    showStaticMessage(getEmptyAutoplayMessage());
  }
}

function showPosters(): void {
  setAppMode("posters");
  lastAutoplayMode = "posters";
  stopLiveStreamCountdown();
  posterItems = [];
  posterIndex = -1;
  setMenuOpen(false);
  exitInteractiveMode();
  stage.querySelectorAll(".lab-view, .cat-stream").forEach((node) => node.remove());
  activeFourSlides.forEach((node) => node.remove());
  activeFourSlides = [];
  activeFourIndices = [];
  activeSlide?.remove();
  activeSlide = null;

  // Entering Posters starts a fresh randomized pass through non-index files in
  // each immediate Labs/* folder; later passes refresh the manifest first and
  // reshuffle again.
  posterSlideshowItems = shuffleSlides(collectLabPosters(labs));
  posterSlideshowIndex = -1;
  if (posterSlideshowItems.length > 0) {
    posterSlideshowIndex = 0;
    void showSlide(posterSlideshowItems[posterSlideshowIndex]);
  } else {
    showStaticMessage(getEmptyAutoplayMessage());
  }
}

function showLiveStream(stream: LiveStreamConfig): void {
  setMenuOpen(false);
  exitInteractiveMode();
  setAppMode("live-stream");
  activeSlide?.remove();
  activeSlide = null;
  activeFourSlides.forEach((node) => node.remove());
  activeFourSlides = [];
  activeFourIndices = [];
  stage.querySelectorAll(".slide, .lab-view, .cat-stream").forEach((node) => node.remove());

  const view = document.createElement("article");
  view.className = "cat-stream";
  view.setAttribute("aria-label", `${stream.name} live stream`);

  const frame = document.createElement("iframe");
  frame.src = getLiveStreamEmbedUrl(stream.url);
  frame.title = `${stream.name} live stream`;
  frame.tabIndex = -1;
  frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  frame.allowFullscreen = true;
  view.append(frame);
  stage.append(view);

  // Livestreams are interrupting modes. The timer owns the return path to whichever
  // autoplay mode was active most recently before the stream was opened.
  resetLiveStreamCountdown();
  showDebugTitle(stream.name);
}

function getLiveStreamEmbedUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    const host = parsed.hostname.replace(/^www\./, "");
    let videoId = "";
    if (host === "youtube.com" || host === "m.youtube.com") {
      if (parsed.pathname === "/watch") {
        videoId = parsed.searchParams.get("v") || "";
      } else if (parsed.pathname.startsWith("/embed/")) {
        videoId = parsed.pathname.split("/")[2] || "";
      }
    } else if (host === "youtu.be") {
      videoId = parsed.pathname.slice(1).split("/")[0] || "";
    }

    if (videoId) {
      return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&mute=1&playsinline=1&rel=0`;
    }
  } catch (error: unknown) {
    logCaughtException("live stream URL parsing failed", error);
    return url;
  }

  return url;
}

function resetLiveStreamCountdown(): void {
  liveStreamEndsAt = Date.now() + config.liveStreamMinutes * 60 * 1000;
  updateLiveStreamCountdown();
  window.clearInterval(liveStreamTimer);
  liveStreamTimer = window.setInterval(updateLiveStreamCountdown, 1000);
}

function stopLiveStreamCountdown(): void {
  liveStreamEndsAt = 0;
  window.clearInterval(liveStreamTimer);
}

function updateLiveStreamCountdown(): void {
  if (appMode !== "live-stream" || liveStreamEndsAt <= 0) {
    return;
  }

  const remainingMs = Math.max(0, liveStreamEndsAt - Date.now());
  liveStreamTime.textContent = formatCountdown(remainingMs);
  if (remainingMs <= 0) {
    stopLiveStreamCountdown();
    returnToLastAutoplayMode();
  }
}

function returnToLastAutoplayMode(): void {
  if (lastAutoplayMode === "posters") {
    showPosters();
  } else {
    showAnnouncements();
  }
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function showLab(lab: LabFolder): void {
  setAppMode("lab");
  stopLiveStreamCountdown();
  posterItems = (lab.items || []).filter(isSlideItem);
  posterIndex = -1;
  setMenuOpen(false);
  exitInteractiveMode();
  activeSlide?.remove();
  activeSlide = null;
  activeFourSlides.forEach((node) => node.remove());
  activeFourSlides = [];
  stage.querySelectorAll(".slide, .lab-view, .cat-stream").forEach((node) => node.remove());

  // Lab mode is a split browsing view: index.html on the left, poster chooser on
  // the right. Selecting a poster switches back to fullscreen slide rendering.
  const view = document.createElement("article");
  view.className = "lab-view active";
  view.classList.toggle("no-posters", posterItems.length === 0);
  view.setAttribute("aria-label", lab.name);

  const indexPane = document.createElement("section");
  indexPane.className = "lab-index";
  if (lab.index) {
    const frame = document.createElement("iframe");
    frame.src = lab.index.url;
    frame.title = lab.index.name;
    frame.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms", "allow-popups");
    indexPane.append(frame);
  } else {
    const message = document.createElement("div");
    message.className = "message";
    message.textContent = `${lab.name} does not have an index.html file.`;
    indexPane.append(message);
  }

  const selector = document.createElement("aside");
  selector.className = "poster-selector";
  for (let index = 0; index < posterItems.length; index += 1) {
    selector.append(createPosterSelectorButton(posterItems[index], index));
  }

  view.append(indexPane);
  if (posterItems.length > 0) {
    view.append(selector);
  }
  stage.append(view);
  activeSlide = view;
  activeTransformTarget = null;
  showDebugTitle(lab.name);
}

function createPosterSelectorButton(item: SlideItem, index: number): HTMLElement {
  const button = document.createElement("button");
  button.className = "poster-option";
  button.type = "button";
  button.addEventListener("click", () => showPoster(index));

  const preview = document.createElement("div");
  preview.className = "poster-preview";
  if (item.kind === "image") {
    const image = document.createElement("img");
    image.src = item.url;
    image.alt = "";
    preview.append(image);
  } else if (item.kind === "pdf") {
    preview.append(createPdfThumbnailContent(item));
  } else {
    const frame = document.createElement("iframe");
    frame.src = item.url;
    frame.title = item.name;
    preview.append(frame);
  }

  const label = document.createElement("span");
  label.textContent = item.name;
  button.append(preview, label);
  return button;
}

function showPoster(
  index: number,
  direction: "next" | "previous" = "next",
  loadingButton?: HTMLButtonElement
): void {
  const item = posterItems[index];
  if (!item) {
    return;
  }

  setAppMode("poster");
  posterIndex = index;
  pauseForInteraction();
  void showSlideWithManualLoading(item, direction, loadingButton);
}

async function advanceFourSlides(): Promise<void> {
  activeSlide?.remove();
  activeSlide = null;

  if (activeFourSlides.length !== Math.min(4, slides.length)) {
    initializeFourSlides();
    return;
  }

  if (activeFourSlides.length < 4) {
    initializeFourSlides();
    return;
  }

  const [topLeft, topRight, bottomRight, bottomLeft] = activeFourSlides;
  const [, topRightIndex] = activeFourIndices;
  const bottomLeftIndex = activeFourIndices[3];
  const welcomeIndex = getWelcomeSlideIndex();
  const wrapWelcome = bottomLeftIndex === welcomeIndex;
  const enteringIndex = wrapWelcome ? bottomLeftIndex : getNextFourSlideIndex();

  // Four-up advances in a serpentine path: new content enters top-left, the top
  // row shifts right, top-right wraps into bottom-right, and the bottom row
  // shifts left as bottom-left leaves.
  const entering = wrapWelcome ? bottomLeft : createFourSlideArticle(enteringIndex);
  if (!wrapWelcome) {
    entering.classList.add("quarter", "q0-enter", "active");
    stage.append(entering);
  }

  const wrapped = createFourSlideArticle(topRightIndex);
  wrapped.classList.add("quarter", "q2-enter", "active");
  stage.append(wrapped);

  await waitForPaint();
  if (!wrapWelcome) {
    bottomLeft.classList.add("q-exit");
  }
  topLeft && setQuarterClass(topLeft, 1);
  topRight.classList.add("q-wrap-exit");
  setQuarterClass(wrapped, 2);
  bottomRight && setQuarterClass(bottomRight, 3);
  setQuarterClass(entering, 0);

  activeFourSlides = [entering, topLeft, wrapped, bottomRight].filter(Boolean);
  activeFourIndices = [enteringIndex, activeFourIndices[0], topRightIndex, activeFourIndices[2]];

  window.setTimeout(() => {
    if (!wrapWelcome) {
      bottomLeft.remove();
    }
    topRight.remove();
  }, 700);

  showDebugTitle(getFourUpTitle());
  setDefaultFourUpTransformTarget();
  preloadUpcomingPdfs();
}

function initializeFourSlides(): void {
  activeSlide?.remove();
  activeSlide = null;
  clearStaticMessage();
  activeFourSlides.forEach((node) => node.remove());
  activeFourSlides = [];
  activeFourIndices = [];
  const indices = getInitialFourSlideIndices();
  for (let offset = 0; offset < indices.length; offset += 1) {
    const index = indices[offset];
    const tile = createFourSlideArticle(index);
    tile.classList.add("quarter", `q${offset}`, "active");
    stage.append(tile);
    activeFourSlides.push(tile);
    activeFourIndices.push(index);
  }
  setDefaultFourUpTransformTarget();
  showDebugTitle(getFourUpTitle());
  preloadUpcomingPdfs();
}

function getInitialFourSlideIndices(): number[] {
  const count = Math.min(4, slides.length);
  const welcomeIndex = getWelcomeSlideIndex();
  const indices: number[] = [];

  if (welcomeIndex >= 0) {
    indices.push(welcomeIndex);
  }

  while (indices.length < count) {
    const index = getNextFourSlideIndex();
    if (!indices.includes(index)) {
      indices.push(index);
    }
  }

  return indices;
}

function getNextFourSlideIndex(): number {
  const welcomeIndex = getWelcomeSlideIndex();
  const activeIndices = new Set(activeFourIndices);
  const fallbackStart = nextFourSlideIndex;
  for (let attempt = 0; attempt < slides.length; attempt += 1) {
    const index = nextFourSlideIndex;
    nextFourSlideIndex = (nextFourSlideIndex + 1) % slides.length;
    if (nextFourSlideIndex === 0) {
      fourUpCycleWrapped = true;
    }
    if (index !== welcomeIndex && !activeIndices.has(index)) {
      return index;
    }
  }

  for (let attempt = 0; attempt < slides.length; attempt += 1) {
    const index = (fallbackStart + attempt) % slides.length;
    if (index !== welcomeIndex) {
      nextFourSlideIndex = (index + 1) % slides.length;
      if (nextFourSlideIndex === 0) {
        fourUpCycleWrapped = true;
      }
      return index;
    }
  }

  return welcomeIndex >= 0 ? welcomeIndex : nextFourSlideIndex;
}

function getWelcomeSlideIndex(): number {
  return slides.findIndex((slide) => /^welcome\.(html?|png|pdf)$/i.test(slide.name));
}

function createSlideArticle(slide: SlideItem): HTMLElement {
  const node = document.createElement("article");
  node.className = "slide";
  node.setAttribute("aria-label", slide.name);
  node.append(createInteractiveViewport(slide));
  return node;
}

function createFourSlideArticle(index: number): HTMLElement {
  const node = createSlideArticle(slides[index]);
  node.dataset.slideIndex = String(index);
  return node;
}

function setQuarterClass(tile: HTMLElement, quarter: number): void {
  tile.classList.remove("q-1", "q0", "q1", "q2", "q3", "q4", "q0-enter", "q2-enter", "q-wrap-exit", "q-exit", "q-exit-reverse");
  tile.classList.add(`q${quarter}`);
}

function getFourUpTitle(): string {
  return activeFourIndices.map((index) => slides[index]?.name || "").filter(Boolean).join(" | ");
}

function createInteractiveViewport(slide: SlideItem): HTMLElement {
  const viewport = document.createElement("div");
  viewport.className = "slide-viewport";
  viewport.dataset.kind = slide.kind;

  const content = document.createElement("div");
  content.className = "slide-content";
  const media = createSlideContent(slide);
  content.append(media);
  viewport.append(content);
  if (slide.kind === "html" && media instanceof HTMLIFrameElement) {
    wireHtmlFrameInteractions(viewport, media);
  }
  setupPosterPan(viewport, media, slide);
  wireViewportInteractions(viewport);

  return viewport;
}

function createSlideContent(slide: SlideItem): HTMLElement {
  if (slide.kind === "image") {
    const image = document.createElement("img");
    image.src = slide.url;
    image.alt = slide.name;
    image.decoding = "async";
    image.addEventListener("error", () => {
      void handleSlideDisplayFailure(slide);
    });
    return image;
  }

  if (slide.kind === "pdf") {
    return createPdfContent(slide);
  }

  const frame = document.createElement("iframe");
  frame.src = slide.url;
  frame.title = slide.name;

  if (slide.kind === "html") {
    frame.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms", "allow-popups");
    disableIframeScrolling(frame);
  }

  return frame;
}

function disableIframeScrolling(frame: HTMLIFrameElement): void {
  frame.scrolling = "no";
  frame.addEventListener("load", () => {
    try {
      const frameDocument = frame.contentDocument;
      if (!frameDocument) {
        return;
      }

      frameDocument.documentElement.style.overflow = "hidden";
      if (frameDocument.body) {
        frameDocument.body.style.overflow = "hidden";
      }
    } catch (error: unknown) {
      logCaughtException("iframe scroll disabling failed", error);
      // Cross-origin HTML slides still get the iframe-level scrolling hint above.
    }
  });
}

function wireHtmlFrameInteractions(viewport: HTMLElement, frame: HTMLIFrameElement): void {
  const showParentControls = () => {
    pauseForInteraction();
    setActiveTransformTarget(viewport);
  };

  frame.addEventListener("load", () => {
    try {
      const frameDocument = frame.contentDocument;
      if (!frameDocument) {
        return;
      }

      frameDocument.addEventListener("pointerdown", showParentControls, { capture: true });
    } catch (error: unknown) {
      logCaughtException("iframe interaction wiring failed", error);
      // Cross-origin HTML slides can receive clicks, but the parent cannot observe
      // their document events without cooperation from the embedded page.
    }
  });
}

function createPdfContent(slide: SlideItem): HTMLElement {
  const container = document.createElement("div");
  container.className = "pdfjs-page";
  container.setAttribute("role", "img");
  container.setAttribute("aria-label", slide.name);

  const canvas = document.createElement("canvas");
  container.append(canvas);

  renderPdfPage(slide, container).catch(async (error: unknown) => {
    logCaughtException(`render PDF failed for ${slide.name}`, error);
    if (!container.isConnected) {
      return;
    }

    if (await handleSlideDisplayFailure(slide, getErrorMessage(error))) {
      return;
    }

    container.textContent = `Unable to display ${slide.name}.`;
  });

  return container;
}

function createPdfThumbnailContent(slide: SlideItem): HTMLElement {
  const container = document.createElement("div");
  container.className = "pdfjs-page pdfjs-thumbnail";
  container.setAttribute("role", "img");
  container.setAttribute("aria-label", slide.name);

  const canvas = document.createElement("canvas");
  container.append(canvas);

  renderPdfPage(slide, container, { outputScale: getPdfThumbnailRenderScale(), renderMode: "width" }).catch((error: unknown) => {
    logCaughtException(`render PDF thumbnail failed for ${slide.name}`, error);
    if (!container.isConnected) {
      return;
    }

    container.textContent = "Unable to preview PDF.";
  });

  return container;
}

async function renderPdfPage(
  slide: SlideItem,
  container: HTMLElement,
  options: PdfRenderOptions = {}
): Promise<void> {
  if (!getPdfJsLib()) {
    throw new Error("PDF.js is not available.");
  }

  const viewportSize = await getPdfViewportSize(container);
  if (!container.isConnected) {
    return;
  }

  const outputScale = options.outputScale || config.pdfInitialRenderScale;
  const rendered = options.useCache === false
    ? await renderPdfPageToCanvasWithScaleFallback(slide, viewportSize, outputScale, options.renderMode)
    : await getRenderedPdfPage(slide, viewportSize, outputScale, options.renderMode);

  if (!container.isConnected) {
    releaseCanvas(rendered.canvas);
    return;
  }

  applyRenderedPdfPage(rendered, container, {
    outputScale: rendered.outputScale,
    releaseSourceCanvas: true
  });
}

function applyRenderedPdfPage(
  rendered: PdfRenderResult,
  container: HTMLElement,
  options: { outputScale?: number; releaseSourceCanvas?: boolean } = {}
): void {
  const outputScale = options.outputScale || 1;
  const canvas = container.querySelector("canvas");
  if (!container.isConnected || !canvas) {
    if (options.releaseSourceCanvas) {
      releaseCanvas(rendered.canvas);
    }
    return;
  }

  const currentScale = Number(container.dataset.renderScale || "0");
  if (currentScale > outputScale + 0.05) {
    if (options.releaseSourceCanvas) {
      releaseCanvas(rendered.canvas);
    }
    return;
  }

  assertUsablePdfCanvasSize(rendered.canvas.width, rendered.canvas.height);

  const canvasSize = getVisiblePdfCanvasSize(rendered, outputScale, container);
  const nextCanvas = document.createElement("canvas");
  nextCanvas.width = canvasSize.width;
  nextCanvas.height = canvasSize.height;
  container.style.setProperty("--pdf-fit-width", `${rendered.fitWidth}px`);
  container.style.setProperty("--pdf-fit-height", `${rendered.fitHeight}px`);
  container.style.setProperty("--pdf-render-width", `${rendered.renderWidth}px`);
  container.style.setProperty("--pdf-render-height", `${rendered.renderHeight}px`);
  container.dataset.renderHeight = String(rendered.renderHeight);

  const context = nextCanvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas rendering is not available.");
  }

  try {
    drawCanvasResampled(rendered.canvas, nextCanvas, context);
    canvas.replaceWith(nextCanvas);
  } finally {
    if (options.releaseSourceCanvas) {
      releaseCanvas(rendered.canvas);
    }
  }
  container.dataset.renderScale = String(outputScale);
  container.dispatchEvent(new Event("pdf-rendered"));
}

function getVisiblePdfCanvasSize(
  rendered: PdfRenderResult,
  outputScale: number,
  container: HTMLElement
): { width: number; height: number } {
  const preserveZoomDetail = isPosterDisplayMode() && activeTransform.scale > 1.01;
  const preserveThumbnailDetail = container.classList.contains("pdfjs-thumbnail");
  const visibleOutputScale = preserveZoomDetail || preserveThumbnailDetail ? outputScale : 1;
  const cssWidth = isPosterDisplayMode() || preserveThumbnailDetail ? rendered.renderWidth : rendered.fitWidth;
  const cssHeight = isPosterDisplayMode() || preserveThumbnailDetail ? rendered.renderHeight : rendered.fitHeight;
  const width = Math.min(rendered.canvas.width, Math.max(1, Math.ceil(cssWidth * window.devicePixelRatio * visibleOutputScale)));
  const height = Math.min(rendered.canvas.height, Math.max(1, Math.ceil(cssHeight * window.devicePixelRatio * visibleOutputScale)));
  assertUsablePdfCanvasSize(width, height);
  return { width, height };
}

function getPdfThumbnailRenderScale(): number {
  return Math.max(pdfThumbnailRenderScale, config.pdfInitialRenderScale);
}

function drawCanvasResampled(
  source: HTMLCanvasElement,
  target: HTMLCanvasElement,
  targetContext: CanvasRenderingContext2D
): void {
  configureCanvasScaling(targetContext);
  targetContext.drawImage(source, 0, 0, target.width, target.height);
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

function configureCanvasScaling(context: CanvasRenderingContext2D): void {
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
}

function assertUsablePdfCanvasSize(width: number, height: number): void {
  if (width <= 0 || height <= 0) {
    throw new Error("PDF render produced an empty canvas.");
  }

  if (width > maxPdfCanvasDimension || height > maxPdfCanvasDimension || width * height > maxPdfCanvasPixels) {
    throw new PdfCanvasTooLargeError(width, height);
  }
}

function assertPdfCanvasHasVisibleContent(canvas: HTMLCanvasElement): void {
  assertUsablePdfCanvasSize(canvas.width, canvas.height);

  const sampleCanvas = document.createElement("canvas");
  const sampleWidth = Math.min(24, canvas.width);
  const sampleHeight = Math.min(24, canvas.height);
  sampleCanvas.width = sampleWidth;
  sampleCanvas.height = sampleHeight;

  const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
  if (!sampleContext) {
    return;
  }

  configureCanvasScaling(sampleContext);
  sampleContext.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);

  let data: Uint8ClampedArray;
  try {
    data = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight).data;
  } catch (error: unknown) {
    logCaughtException("PDF render content validation failed", error);
    return;
  } finally {
    releaseCanvas(sampleCanvas);
  }

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    const brightness = data[index] + data[index + 1] + data[index + 2];
    if (alpha > 8 && brightness > 24) {
      return;
    }
  }

  throw new PdfBlankRenderError(canvas.width, canvas.height);
}

async function getRenderedPdfPage(
  slide: SlideItem,
  viewportSize: { width: number; height: number },
  outputScale: number,
  renderMode: PdfRenderMode = "fit"
): Promise<PdfRenderResult> {
  if (!config.pdfRenderCache) {
    return renderPdfPageToCanvasWithScaleFallback(slide, viewportSize, outputScale, renderMode);
  }

  const key = getPdfCacheKey(slide, viewportSize, outputScale, renderMode);
  const cached = pdfRenderCache.get(key);
  if (cached) {
    pdfRenderCache.delete(key);
    pdfRenderCache.set(key, cached);
    try {
      return await materializePdfRenderCacheEntry(cached);
    } catch (error: unknown) {
      logCaughtException("cached PDF render materialization failed", error);
      evictPdfRenderCacheEntry(key, cached);
      const replacement = pdfRenderCache.get(key);
      if (replacement && replacement !== cached) {
        return materializePdfRenderCacheEntry(replacement);
      }
    }
  }

  const entry: PdfRenderCacheEntry = {
    key,
    promise: renderPdfPageToCanvasWithScaleFallback(slide, viewportSize, outputScale, renderMode)
      .then(snapshotPdfRender),
    activeUsers: 0,
    evicted: false,
    released: false
  };
  pdfRenderCache.set(key, entry);
  trimPdfRenderCache();
  void entry.promise.then((snapshot) => {
    entry.snapshot = snapshot;
    releasePdfRenderCacheEntryIfUnused(entry);
    if (pdfRenderCache.get(key) === entry) {
      logCacheAddition("pdf-render", key, pdfRenderCache.size, getPdfRenderSnapshotDetails(snapshot));
    }
  }).catch((error: unknown) => logCaughtException("pdf render cache addition logging failed", error));
  entry.promise.catch((error: unknown) => {
    if (pdfRenderCache.get(key) === entry) {
      logCaughtException("pdf render cache entry failed", error);
      pdfRenderCache.delete(key);
    }
  });
  try {
    return await materializePdfRenderCacheEntry(entry);
  } catch (error: unknown) {
    logCaughtException("new PDF render cache materialization failed; re-rendering", error);
    evictPdfRenderCacheEntry(key, entry);
    return renderPdfPageToCanvasWithScaleFallback(slide, viewportSize, outputScale, renderMode);
  }
}

async function materializePdfRenderCacheEntry(entry: PdfRenderCacheEntry): Promise<PdfRenderResult> {
  entry.activeUsers += 1;
  try {
    return materializePdfRenderSnapshot(await entry.promise);
  } finally {
    entry.activeUsers = Math.max(0, entry.activeUsers - 1);
    releasePdfRenderCacheEntryIfUnused(entry);
  }
}

function evictPdfRenderCacheEntry(key: string, entry: PdfRenderCacheEntry): void {
  if (pdfRenderCache.get(key) === entry) {
    pdfRenderCache.delete(key);
  }
  entry.evicted = true;
  releasePdfRenderCacheEntryIfUnused(entry);
}

function releasePdfRenderCacheEntryIfUnused(entry: PdfRenderCacheEntry): void {
  if (!entry.evicted || entry.activeUsers > 0 || entry.released || !entry.snapshot) {
    return;
  }

  releasePdfRenderSnapshot(entry.snapshot);
  entry.released = true;
}

async function renderPdfPageToCanvas(
  slide: SlideItem,
  viewportSize: { width: number; height: number },
  outputScale = 1,
  renderMode: PdfRenderMode = "fit"
): Promise<PdfRenderResult> {
  try {
    return await renderPdfPageToCanvasOnce(slide, viewportSize, outputScale, renderMode);
  } catch (error) {
    logCaughtException(`render PDF retrying after failure for ${slide.name}`, error);
    return renderPdfPageToCanvasOnce(slide, viewportSize, outputScale, renderMode);
  }
}

async function snapshotPdfRender(rendered: PdfRenderResult): Promise<PdfRenderSnapshot> {
  const snapshot = {
    canvasWidth: rendered.canvas.width,
    canvasHeight: rendered.canvas.height,
    fitWidth: rendered.fitWidth,
    fitHeight: rendered.fitHeight,
    renderWidth: rendered.renderWidth,
    renderHeight: rendered.renderHeight,
    outputScale: rendered.outputScale
  };

  try {
    assertPdfCanvasHasVisibleContent(rendered.canvas);
    const bitmap = await createImageBitmap(rendered.canvas);
    releaseCanvas(rendered.canvas);
    return { ...snapshot, bitmap };
  } catch (error: unknown) {
    releaseCanvas(rendered.canvas);
    logCaughtException("PDF render bitmap snapshot failed", error);
    throw error;
  }
}

function materializePdfRenderSnapshot(snapshot: PdfRenderSnapshot): PdfRenderResult {
  assertUsablePdfCanvasSize(snapshot.canvasWidth, snapshot.canvasHeight);
  const canvas = document.createElement("canvas");
  canvas.width = snapshot.canvasWidth;
  canvas.height = snapshot.canvasHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas rendering is not available.");
  }

  configureCanvasScaling(context);
  context.drawImage(snapshot.bitmap, 0, 0);
  assertPdfCanvasHasVisibleContent(canvas);
  return {
    canvas,
    fitWidth: snapshot.fitWidth,
    fitHeight: snapshot.fitHeight,
    renderWidth: snapshot.renderWidth,
    renderHeight: snapshot.renderHeight,
    outputScale: snapshot.outputScale
  };
}

function releasePdfRenderSnapshot(snapshot: PdfRenderSnapshot): void {
  snapshot.bitmap.close();
}

async function renderPdfPageToCanvasWithScaleFallback(
  slide: SlideItem,
  viewportSize: { width: number; height: number },
  outputScale: number,
  renderMode: PdfRenderMode = "fit"
): Promise<PdfRenderResult> {
  try {
    return await renderPdfPageToCanvas(slide, viewportSize, outputScale, renderMode);
  } catch (error) {
    if (outputScale <= 1 || !(error instanceof PdfCanvasTooLargeError)) {
      throw error;
    }

    logCaughtException(`PDF render scale fallback for ${slide.name}`, error);
    if (config.debug) {
      console.warn(`[slider pdf] initial render scale ${outputScale} is too large for ${slide.name}; falling back to 1x`);
    }
    return renderPdfPageToCanvas(slide, viewportSize, 1, renderMode);
  }
}

async function renderPdfPageToCanvasOnce(
  slide: SlideItem,
  viewportSize: { width: number; height: number },
  outputScale = 1,
  renderMode: PdfRenderMode = "fit"
): Promise<PdfRenderResult> {
  if (!getPdfJsLib()) {
    throw new Error("PDF.js is not available.");
  }

  const documentProxy = await loadPdfDocument(slide);
  try {
    const page = await documentProxy.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const viewportWidth = viewportSize.width;
    const viewportHeight = viewportSize.height;
    const fitScale = Math.min(viewportWidth / baseViewport.width, viewportHeight / baseViewport.height);
    const fullWidthScale = viewportWidth / baseViewport.width;
    const renderScale = renderMode === "width" || isPosterDisplayMode() ? fullWidthScale : fitScale;
    const renderViewport = page.getViewport({ scale: renderScale * window.devicePixelRatio * outputScale });
    const cssWidth = baseViewport.width * renderScale;
    const cssHeight = baseViewport.height * renderScale;
    const fitWidth = baseViewport.width * fitScale;
    const fitHeight = baseViewport.height * fitScale;
    const renderCanvas = document.createElement("canvas");
    const canvasWidth = Math.ceil(renderViewport.width);
    const canvasHeight = Math.ceil(renderViewport.height);

    assertUsablePdfCanvasSize(canvasWidth, canvasHeight);
    renderCanvas.width = canvasWidth;
    renderCanvas.height = canvasHeight;

    const context = renderCanvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas rendering is not available.");
    }

    configureCanvasScaling(context);
    await page.render({ canvasContext: context, viewport: renderViewport }).promise;
    assertPdfCanvasHasVisibleContent(renderCanvas);
    return {
      canvas: renderCanvas,
      fitWidth,
      fitHeight,
      renderWidth: cssWidth,
      renderHeight: cssHeight,
      outputScale
    };
  } finally {
    await cleanupPdfDocument(documentProxy);
  }
}

function loadPdfDocument(slide: SlideItem): Promise<PdfDocumentProxy> {
  const pdfJs = getPdfJsLib();
  if (!pdfJs) {
    return Promise.reject(new Error("PDF.js is not available."));
  }

  return pdfJs.getDocument({ url: slide.url }).promise;
}

async function cleanupPdfDocument(documentProxy: PdfDocumentProxy): Promise<void> {
  try {
    await documentProxy.cleanup();
  } catch (error) {
    logCaughtException("PDF document cleanup failed", error);
    if (config.debug) {
      console.warn("[slider pdf] document cleanup failed", error);
    }
  }
}

function getPdfCacheKey(
  slide: SlideItem,
  viewportSize: { width: number; height: number },
  outputScale: number,
  renderMode: PdfRenderMode
): string {
  return [
    slide.url,
    slide.modified || "",
    Math.round(viewportSize.width),
    Math.round(viewportSize.height),
    window.devicePixelRatio,
    outputScale,
    isPosterDisplayMode() ? "poster" : renderMode
  ].join("|");
}

function trimPdfRenderCache(): void {
  if (!config.pdfRenderCache || config.pdfCacheSize <= 0) {
    if (pdfRenderCache.size > 0) {
      logCacheEvent("clearing pdf-render cache", { entries: pdfRenderCache.size, reason: "disabled-or-zero-size" });
    }
    clearPdfRenderCache();
    return;
  }

  while (pdfRenderCache.size > config.pdfCacheSize) {
    const oldestKey = pdfRenderCache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    const cached = pdfRenderCache.get(oldestKey);
    if (cached) {
      evictPdfRenderCacheEntry(oldestKey, cached);
      logCacheEvent("evicted pdf-render", { key: oldestKey, entries: pdfRenderCache.size, limit: config.pdfCacheSize });
    }
  }
}

function clearPdfRenderCache(): void {
  const entries = pdfRenderCache.size;
  pdfRenderCache.forEach((cached, key) => {
    evictPdfRenderCacheEntry(key, cached);
  });
  pdfRenderCache.clear();
  if (entries > 0) {
    logCacheEvent("cleared pdf-render cache", { entries });
  }
}

function getPdfRenderSnapshotDetails(snapshot: PdfRenderSnapshot): Record<string, string | number> {
  const estimatedBytes = snapshot.canvasWidth * snapshot.canvasHeight * 4;
  return {
    canvasPixels: `${snapshot.canvasWidth}x${snapshot.canvasHeight}`,
    cssPixels: `${Math.round(snapshot.renderWidth)}x${Math.round(snapshot.renderHeight)}`,
    estimatedBytes,
    estimatedSize: formatBytes(estimatedBytes)
  };
}

function logCacheAddition(
  cacheName: string,
  key: string,
  entries: number,
  details: Record<string, string | number>
): void {
  logCacheEvent(`added ${cacheName}`, {
    key,
    entries,
    ...details
  });
}

function logCacheEvent(message: string, details: Record<string, string | number> = {}): void {
  const payload = {
    timestamp: new Date().toISOString(),
    message: `[slider cache] ${message}`,
    ...details
  };
  console.log(payload.message, details);
  sendAgentLog(`${payload.timestamp} ${payload.message} ${JSON.stringify(details)}`);
}

function logCaughtException(context: string, error: unknown): void {
  const details = getErrorDetails(error);
  console.error(`[slider exception] ${context}`, error);
  sendAgentLog(`${new Date().toISOString()} [slider exception] ${context} ${JSON.stringify(details)}`);
}

function getErrorDetails(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || ""
    };
  }

  return { message: String(error) };
}

function sendAgentLog(message: string): void {
  const body = JSON.stringify({ message });
  if (navigator.sendBeacon) {
    navigator.sendBeacon("/log", new Blob([body], { type: "application/json" }));
    return;
  }

  void fetch("/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true
  }).catch(() => undefined);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }

  return `${(kib / 1024).toFixed(1)} MiB`;
}

function preloadUpcomingPdfs(): void {
  if (!config.pdfRenderCache || config.pdfCacheSize <= 0 || !getPdfJsLib()) {
    return;
  }

  const nextPdf = getNextPdfToPreload();
  if (!nextPdf) {
    return;
  }

  const token = ++pdfPrefetchToken;
  cancelScheduledPdfPrefetch();
  scheduleIdlePdfPrefetch(() => {
    if (token !== pdfPrefetchToken) {
      return;
    }

    void prefetchPdf(nextPdf).catch((error: unknown) => {
      logCaughtException(`PDF prefetch failed for ${nextPdf.name}`, error);
      // The visible render path reports failures; background preloads should stay quiet.
    });
  });
}

function scheduleIdlePdfPrefetch(callback: () => void): void {
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (idleWindow.requestIdleCallback) {
    pdfPrefetchIdleHandle = idleWindow.requestIdleCallback(() => {
      pdfPrefetchIdleHandle = 0;
      callback();
    }, { timeout: 2500 });
    return;
  }

  pdfPrefetchTimer = globalThis.setTimeout(callback, 500);
}

function cancelScheduledPdfPrefetch(): void {
  if (pdfPrefetchIdleHandle) {
    const idleWindow = window as Window & { cancelIdleCallback?: (handle: number) => void };
    idleWindow.cancelIdleCallback?.(pdfPrefetchIdleHandle);
    pdfPrefetchIdleHandle = 0;
  }

  if (pdfPrefetchTimer) {
    globalThis.clearTimeout(pdfPrefetchTimer);
    pdfPrefetchTimer = 0;
  }
}

async function prefetchPdf(slide: SlideItem): Promise<void> {
  await getRenderedPdfPage(slide, getExpectedPdfViewportSize(), config.pdfInitialRenderScale);
}

function getNextPdfToPreload(): SlideItem | null {
  if (appMode === "poster" && posterItems.length > 0) {
    return findNextPdf(posterItems, posterIndex);
  }

  if (appMode === "posters" && posterSlideshowItems.length > 0) {
    return findNextPdf(posterSlideshowItems, posterSlideshowIndex);
  }

  if (appMode === "announcements" && slides.length > 0) {
    const startIndex = config.fourUp ? nextFourSlideIndex - 1 : slideIndex;
    return findNextPdf(slides, startIndex);
  }

  return null;
}

function findNextPdf(items: SlideItem[], currentIndex: number): SlideItem | null {
  if (items.length === 0) {
    return null;
  }

  for (let offset = 1; offset <= items.length; offset += 1) {
    const item = items[(currentIndex + offset + items.length) % items.length];
    if (item.kind === "pdf") {
      return item;
    }
  }

  return null;
}

function getExpectedPdfViewportSize(): { width: number; height: number } {
  if (appMode === "announcements" && config.fourUp) {
    return { width: window.innerWidth / 2, height: window.innerHeight / 2 };
  }

  return { width: window.innerWidth, height: window.innerHeight };
}

async function getPdfViewportSize(container: HTMLElement): Promise<{ width: number; height: number }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const viewport = container.closest(".slide-viewport") as HTMLElement | null;
    const rect = (viewport || container).getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
      return { width: rect.width, height: rect.height };
    }

    await nextAnimationFrame();
  }

  return { width: window.innerWidth, height: window.innerHeight };
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function setupPosterPan(viewport: HTMLElement, media: HTMLElement, slide: SlideItem): void {
  if (!config.panPosters || !isPosterDisplayMode() || (slide.kind !== "image" && slide.kind !== "pdf")) {
    return;
  }

  viewport.dataset.posterPan = "true";
  media.classList.add("poster-pan-media");
  viewport.style.setProperty("--poster-pan-duration", `${Math.max(6, getAutoplayDelaySeconds() - 1)}s`);

  if (slide.kind === "image" && media instanceof HTMLImageElement) {
    const updateImagePan = () => {
      const naturalAspect = media.naturalWidth / media.naturalHeight;
      const fullWidthHeight = window.innerWidth / naturalAspect;
      updatePosterPanState(viewport, media, fullWidthHeight);
    };

    if (media.complete && media.naturalWidth > 0) {
      updateImagePan();
    } else {
      media.addEventListener("load", updateImagePan, { once: true });
    }
    return;
  }

  if (slide.kind === "pdf") {
    waitForPdfRender(media).then(() => {
      updatePosterPanState(viewport, media, Number(media.dataset.renderHeight) || media.getBoundingClientRect().height);
    });
  }
}

function waitForPdfRender(media: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    if (media.dataset.renderHeight) {
      resolve();
      return;
    }

    media.addEventListener("pdf-rendered", () => resolve(), { once: true });
  });
}

function updatePosterPanState(viewport: HTMLElement, media: HTMLElement, mediaHeight: number): void {
  // Pan exactly the overflow. Short content keeps the centered fit layout, while
  // tall posters stop with their bottom edge aligned to the viewport bottom.
  const distance = Math.max(0, mediaHeight - window.innerHeight);
  const visibleFraction = mediaHeight > 0 ? Math.min(1, window.innerHeight / mediaHeight) : 1;
  const shouldPan = distance > 1 && visibleFraction < config.panFraction;
  viewport.style.setProperty("--poster-pan-media-height", `${mediaHeight}px`);
  viewport.style.setProperty("--poster-pan-distance", `${distance}px`);
  viewport.dataset.panReady = shouldPan ? "true" : "false";
  media.classList.toggle("poster-pan-media", shouldPan);
}

function isPosterDisplayMode(): boolean {
  return appMode === "posters" || appMode === "poster";
}

function wireViewportInteractions(viewport: HTMLElement): void {
  // Pointer events drive both mouse dragging and touch gestures. Each active slide
  // keeps its own transform so zoom/pan survives brief focus changes in four-up.
  viewport.addEventListener("pointerdown", (event) => {
    pauseForInteraction();
    setActiveTransformTarget(viewport);
    viewport.setPointerCapture(event.pointerId);
    activePointers.set(event.pointerId, { id: event.pointerId, x: event.clientX, y: event.clientY });
    startGesture();
    event.preventDefault();
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!activePointers.has(event.pointerId)) {
      return;
    }

    activePointers.set(event.pointerId, { id: event.pointerId, x: event.clientX, y: event.clientY });
    updateGesture();
    event.preventDefault();
  });

  const endPointer = (event: PointerEvent) => {
    activePointers.delete(event.pointerId);
    startGesture();
  };
  viewport.addEventListener("pointerup", endPointer);
  viewport.addEventListener("pointercancel", endPointer);

  viewport.addEventListener("wheel", (event) => {
    pauseForInteraction();
    zoomAt(event.deltaY < 0 ? 1.12 : 0.88, event.clientX, event.clientY);
    event.preventDefault();
  }, { passive: false });
}

function startGesture(): void {
  const pointers = Array.from(activePointers.values());
  gestureStartTransform = { ...activeTransform };

  if (pointers.length >= 2) {
    gestureStartDistance = getDistance(pointers[0], pointers[1]);
    gestureStartCenter = getCenter(pointers[0], pointers[1]);
  } else if (pointers.length === 1) {
    gestureStartDistance = 0;
    gestureStartCenter = { x: pointers[0].x, y: pointers[0].y };
  } else {
    gestureStartDistance = 0;
    gestureStartCenter = null;
    gestureStartTransform = null;
  }
}

function updateGesture(): void {
  if (!gestureStartTransform || !gestureStartCenter) {
    return;
  }

  pauseForInteraction();
  const pointers = Array.from(activePointers.values());
  if (pointers.length >= 2) {
    const center = getCenter(pointers[0], pointers[1]);
    const distance = getDistance(pointers[0], pointers[1]);
    const scaleChange = gestureStartDistance > 0 ? distance / gestureStartDistance : 1;
    activeTransform = clampTransform({
      scale: gestureStartTransform.scale * scaleChange,
      x: gestureStartTransform.x + center.x - gestureStartCenter.x,
      y: gestureStartTransform.y + center.y - gestureStartCenter.y
    });
  } else if (pointers.length === 1) {
    activeTransform = clampTransform({
      ...gestureStartTransform,
      x: gestureStartTransform.x + pointers[0].x - gestureStartCenter.x,
      y: gestureStartTransform.y + pointers[0].y - gestureStartCenter.y
    });
  }

  applyTransform();
  schedulePosterPdfZoomRender();
}

function getDistance(a: PointerState, b: PointerState): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getCenter(a: PointerState, b: PointerState): { x: number; y: number } {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2
  };
}

function pauseForInteraction(): void {
  interactivePauseUntil = Date.now() + config.interactivePauseSeconds * 1000;
  showControls();
}

function showControls(): void {
  document.body.classList.add("interactive");
  window.clearTimeout(controlsHideTimer);
  controlsHideTimer = window.setTimeout(() => {
    if (Date.now() >= interactivePauseUntil) {
      document.body.classList.remove("interactive");
    }
  }, config.interactivePauseSeconds * 1000 + 150);
}

function setAppMode(mode: AppMode): void {
  if (appMode !== mode) {
    slideRenderToken += 1;
  }
  appMode = mode;
  document.body.classList.toggle("lab-mode", mode === "lab");
  document.body.classList.toggle("live-stream-mode", mode === "live-stream");
  document.body.classList.toggle("four-mode", config.fourUp && mode === "announcements");
  document.body.classList.toggle(
    "poster-controls-always-visible",
    config.posterSlidesControlsAlwaysVisible && isPosterDisplayMode()
  );
}

function exitInteractiveMode(): void {
  // Menu navigation into autoplay modes should not inherit the paused, overlayed
  // state that was only needed to operate the menu.
  interactivePauseUntil = 0;
  window.clearTimeout(controlsHideTimer);
  document.body.classList.remove("interactive");
}

function resetTransform(): void {
  activePointers = new Map();
  gestureStartTransform = null;
  gestureStartCenter = null;
  gestureStartDistance = 0;
  activeTransform = getDefaultTransform();
  activeTransformTarget = activeSlide?.querySelector(".slide-content") || null;
  resetPdfZoomRenderLimit(activeTransformTarget);
  if (activeTransformTarget) {
    transformByTarget.set(activeTransformTarget, activeTransform);
  }
  applyTransform();
}

function getDefaultTransform(): ViewTransform {
  return { scale: 1, x: 0, y: 0 };
}

function zoomAt(factor: number, clientX: number = window.innerWidth / 2, clientY: number = window.innerHeight / 2): void {
  if (appMode === "lab") {
    return;
  }

  if (!activeTransformTarget) {
    return;
  }

  const previousScale = activeTransform.scale;
  const nextScale = Math.min(getActiveZoomLimit(), Math.max(1, previousScale * factor));
  if (Math.abs(nextScale - previousScale) < 0.001) {
    return;
  }

  const scaleChange = nextScale / previousScale;
  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;

  // Keep the point under the cursor/finger stationary while scaling around the
  // viewport center, then clamp so blank space cannot dominate the screen.
  activeTransform = clampTransform({
    scale: nextScale,
    x: (activeTransform.x - (clientX - centerX)) * scaleChange + (clientX - centerX),
    y: (activeTransform.y - (clientY - centerY)) * scaleChange + (clientY - centerY)
  });
  applyTransform();
  schedulePosterPdfZoomRender();
}

function clampTransform(transform: ViewTransform): ViewTransform {
  const scale = Math.min(getActiveZoomLimit(), Math.max(1, transform.scale));
  if (scale === 1) {
    return { scale, x: 0, y: 0 };
  }

  const maxX = window.innerWidth * (scale - 1) * 0.5;
  const maxY = window.innerHeight * (scale - 1) * 0.5;
  return {
    scale,
    x: Math.min(maxX, Math.max(-maxX, transform.x)),
    y: Math.min(maxY, Math.max(-maxY, transform.y))
  };
}

function getActiveZoomLimit(): number {
  return Math.max(1, Math.min(5, pdfZoomRenderFailedScale));
}

function applyTransform(): void {
  if (!activeTransformTarget) {
    return;
  }

  transformByTarget.set(activeTransformTarget, activeTransform);
  activeTransformTarget.style.transform = `translate3d(${activeTransform.x}px, ${activeTransform.y}px, 0) scale(${activeTransform.scale})`;
}

function schedulePosterPdfZoomRender(): void {
  if (!isPosterDisplayMode() || activeTransform.scale <= 1.01) {
    return;
  }

  const target = activeTransformTarget;
  const container = target?.querySelector(".pdfjs-page") as HTMLElement | null;
  const slide = getCurrentSlideItem();
  if (!target || !container || slide?.kind !== "pdf") {
    return;
  }

  const requestedScale = Number(Math.min(activeTransform.scale, config.pdfMaxZoomRenderScale).toFixed(2));
  if (target !== pdfZoomRenderTarget) {
    resetPdfZoomRenderLimit(target);
  }

  pdfZoomRenderScale = Math.max(pdfZoomRenderScale, requestedScale);
  const renderedScale = Number(container.dataset.renderScale || "1");
  if (renderedScale >= pdfZoomRenderScale - 0.05) {
    return;
  }

  if (pdfZoomRenderScale >= pdfZoomRenderFailedScale - 0.05) {
    return;
  }

  window.clearTimeout(pdfZoomRenderTimer);
  const renderScale = pdfZoomRenderScale;
  pdfZoomRenderTimer = window.setTimeout(() => {
    void renderPosterPdfForZoom(slide, target, container, renderScale);
  }, 120);
}

async function renderPosterPdfForZoom(
  slide: SlideItem,
  target: HTMLElement,
  container: HTMLElement,
  scale: number
): Promise<void> {
  const token = ++pdfZoomRenderToken;
  try {
    const viewportSize = await getPdfViewportSize(container);
    if (token !== pdfZoomRenderToken || target !== activeTransformTarget || !container.isConnected) {
      return;
    }

    const rendered = await renderPdfPageToCanvas(slide, viewportSize, scale);
    if (token !== pdfZoomRenderToken || target !== activeTransformTarget || !container.isConnected) {
      releaseCanvas(rendered.canvas);
      return;
    }
    applyRenderedPdfPage(rendered, container, { outputScale: scale, releaseSourceCanvas: true });
  } catch (error: unknown) {
    if (error instanceof PdfCanvasTooLargeError && target === activeTransformTarget) {
      logCaughtException(`poster PDF zoom render too large for ${slide.name}`, error);
      stopPdfZoomingPastCurrentScale();
      return;
    }

    logCaughtException(`poster PDF zoom render failed for ${slide.name}`, error);
    if (config.debug) {
      console.warn(`[slider pdf] unable to sharpen ${slide.name}`, error);
    }
  }
}

function stopPdfZoomingPastCurrentScale(): void {
  pdfZoomRenderFailedScale = Math.min(pdfZoomRenderFailedScale, Math.max(1, activeTransform.scale));
  pdfZoomRenderScale = Math.min(pdfZoomRenderScale, pdfZoomRenderFailedScale);
}

function resetPdfZoomRenderLimit(target: HTMLElement | null): void {
  pdfZoomRenderTarget = target;
  pdfZoomRenderScale = 1;
  pdfZoomRenderFailedScale = Number.POSITIVE_INFINITY;
}

function setActiveTransformTarget(viewport: HTMLElement): void {
  const target = viewport.querySelector(".slide-content") as HTMLElement | null;
  if (!target || target === activeTransformTarget) {
    return;
  }

  activeTransformTarget = target;
  activeTransform = transformByTarget.get(target) || getDefaultTransform();
  resetPdfZoomRenderLimit(target);
  applyTransform();
}

function setDefaultFourUpTransformTarget(): void {
  if (!config.fourUp || activeTransformTarget?.isConnected) {
    return;
  }

  const target = activeFourSlides[0]?.querySelector(".slide-content") as HTMLElement | null;
  if (target) {
    activeTransformTarget = target;
    activeTransform = transformByTarget.get(target) || getDefaultTransform();
    applyTransform();
  }
}

function showPreviousSlide(loadingButton?: HTMLButtonElement): void {
  if (appMode === "lab") {
    return;
  }

  pauseForInteraction();

  if (appMode === "poster" && posterItems.length > 0) {
    showPoster((posterIndex - 1 + posterItems.length) % posterItems.length, "previous", loadingButton);
    return;
  }

  if (appMode === "posters" && posterSlideshowItems.length > 0) {
    posterSlideshowIndex = (posterSlideshowIndex - 1 + posterSlideshowItems.length) % posterSlideshowItems.length;
    void showSlideWithManualLoading(posterSlideshowItems[posterSlideshowIndex], "previous", loadingButton);
    return;
  }

  if (slides.length === 0) {
    return;
  }

  if (config.fourUp) {
    rewindFourSlides();
  } else {
    slideIndex = (slideIndex - 1 + slides.length) % slides.length;
    void showSlideWithManualLoading(slides[slideIndex], "previous", loadingButton);
  }
}

function showNextSlide(loadingButton?: HTMLButtonElement): void {
  if (appMode === "lab") {
    return;
  }

  pauseForInteraction();

  if (appMode === "poster" && posterItems.length > 0) {
    showPoster((posterIndex + 1) % posterItems.length, "next", loadingButton);
    return;
  }

  if (appMode === "posters" && posterSlideshowItems.length > 0) {
    posterSlideshowIndex = (posterSlideshowIndex + 1) % posterSlideshowItems.length;
    void showSlideWithManualLoading(posterSlideshowItems[posterSlideshowIndex], "next", loadingButton);
    return;
  }

  if (slides.length === 0) {
    return;
  }

  if (config.fourUp) {
    void advanceFourSlides();
  } else {
    slideIndex = (slideIndex + 1) % slides.length;
    void showSlideWithManualLoading(slides[slideIndex], "next", loadingButton);
  }
}

function rewindFourSlides(): void {
  const count = Math.min(4, slides.length);
  nextFourSlideIndex = (nextFourSlideIndex - count - 1 + slides.length * 2) % slides.length;
  activeFourSlides = [];
  activeFourIndices = [];
  initializeFourSlides();
}

async function waitForAdvance(durationMs: number): Promise<void> {
  let waitMode = appMode;
  let end = Date.now() + durationMs;
  while (running) {
    if (appMode !== waitMode) {
      if (appMode === "lab" || appMode === "poster" || appMode === "live-stream") {
        return;
      }

      waitMode = appMode;
      end = Date.now() + getAutoplayDelaySeconds() * 1000;
    }

    const remaining = Math.max(end - Date.now(), interactivePauseUntil - Date.now());
    if (remaining <= 0) {
      document.body.classList.remove("interactive");
      return;
    }
    await sleep(Math.min(remaining, 250));
  }
}

function cacheBustedUrl(url: string): string {
  const parsed = new URL(url, window.location.href);
  parsed.searchParams.set("_", String(Date.now()));
  return parsed.href;
}

function isSlideItem(value: unknown): value is SlideItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const slide = value as Partial<SlideItem>;
  return Boolean(
    slide.name &&
    slide.url &&
    (slide.kind === "image" || slide.kind === "pdf" || slide.kind === "html")
  );
}

function isLabFolder(value: unknown): value is LabFolder {
  if (!value || typeof value !== "object") {
    return false;
  }

  const lab = value as Partial<LabFolder>;
  return Boolean(lab.name && lab.path);
}

async function handleSlideDisplayFailure(slide: SlideItem, detail = ""): Promise<boolean> {
  await refreshSlides(config);
  if (!isSlideStillListed(slide)) {
    hideBanner("general");
    if (appMode === "announcements" && config.fourUp) {
      return true;
    }

    advanceAfterRemovedSlide();
    return true;
  }

  const suffix = detail ? `: ${detail}` : "";
  showBanner(`Unable to display ${slide.name}${suffix}.`);
  return false;
}

function advanceAfterRemovedSlide(): void {
  const autoplayItems = getAutoplayItems();
  if ((appMode === "announcements" || appMode === "posters") && autoplayItems.length > 0) {
    if (appMode === "posters") {
      posterSlideshowIndex = (posterSlideshowIndex + 1) % posterSlideshowItems.length;
      void showSlide(posterSlideshowItems[posterSlideshowIndex]);
      return;
    }

    slideIndex = (slideIndex + 1) % slides.length;
    void showSlide(slides[slideIndex]);
  }
}

function isSlideStillListed(slide: SlideItem): boolean {
  return getCurrentManifestItems().some((item) => isSameSlideItem(item, slide));
}

function getCurrentManifestItems(): SlideItem[] {
  const items = [...slides, ...collectLabPosters(labs)];
  for (const lab of labs) {
    collectLabIndexes(lab, items);
  }
  return items;
}

function collectLabIndexes(lab: LabFolder, items: SlideItem[]): void {
  if (isSlideItem(lab.index)) {
    items.push(lab.index);
  }
  for (const child of lab.children || []) {
    collectLabIndexes(child, items);
  }
}

function isSameSlideItem(left: SlideItem, right: SlideItem): boolean {
  if (left.id && right.id) {
    return left.id === right.id;
  }

  return left.url === right.url && left.name === right.name && left.kind === right.kind;
}

function getManifestSlides(manifest: SlideManifest): SlideItem[] {
  return Array.isArray(manifest.slides) ? manifest.slides.filter(isSlideItem) : [];
}

function getManifestLabs(manifest: SlideManifest): LabFolder[] {
  return Array.isArray(manifest.labs) ? manifest.labs.map(normalizeLabFolder).filter(isLabFolder) : [];
}

function normalizeLabFolder(value: unknown): LabFolder | null {
  if (!isLabFolder(value)) {
    return null;
  }

  const lab = value as LabFolder;
  const index = isSlideItem(lab.index) ? lab.index : undefined;
  const items = Array.isArray(lab.items) ? lab.items.filter(isSlideItem) : [];
  const children = Array.isArray(lab.children) ? lab.children.map(normalizeLabFolder).filter(isLabFolder) : [];

  return {
    id: lab.id,
    name: lab.name,
    path: lab.path,
    ...(index ? { index } : {}),
    items,
    children
  };
}

function getSlideListSignature(items: SlideItem[]): string {
  return items
    .map((item) => [item.id || "", item.name, item.kind, item.url, item.modified || ""].join("\u001f"))
    .join("\u001e");
}

function collectLabPosters(folders: LabFolder[]): SlideItem[] {
  const items: SlideItem[] = [];
  for (const folder of folders) {
    items.push(...(folder.items || []).filter(isSlideItem));
  }
  return items;
}

function shuffleSlides(items: SlideItem[]): SlideItem[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function showStaticMessage(message: string): void {
  clearStaticMessage();
  const slide = document.createElement("article");
  slide.className = "slide active";
  slide.dataset.staticMessage = "true";

  const box = document.createElement("div");
  box.className = "message";
  box.textContent = message;
  slide.append(box);
  stage.append(slide);
  activeSlide = slide;
}

function clearStaticMessage(): void {
  stage.querySelectorAll("[data-static-message='true']").forEach((node) => node.remove());
}

function showBanner(message: string, kind: BannerKind = "general"): void {
  clearBannerHideTimer();
  bannerKind = kind;
  banner.textContent = message;
  banner.classList.add("visible");
  if (kind === "general" && appMode === "announcements") {
    bannerHideTimer = window.setTimeout(() => hideBanner("general"), 30000);
  }
}

function hideBanner(kind?: BannerKind): void {
  if (kind && bannerKind !== kind) {
    return;
  }

  clearBannerHideTimer();
  bannerKind = null;
  banner.textContent = "";
  banner.classList.remove("visible");
}

function clearBannerHideTimer(): void {
  if (bannerHideTimer) {
    window.clearTimeout(bannerHideTimer);
    bannerHideTimer = 0;
  }
}

function showDebugTitle(name: string): void {
  if (!config.debug) {
    statusNode.classList.remove("visible");
    statusNode.textContent = "";
    return;
  }

  statusNode.textContent = name;
  statusNode.classList.add("visible");
}

function normalizeSlideIndex(current: number, length: number): number {
  if (length <= 0) {
    return -1;
  }

  return current >= length ? -1 : current;
}

function mustGetElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing #${id}`);
  }
  return element;
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function parseBooleanParam(value: string | null, fallback: boolean): boolean {
  if (value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
