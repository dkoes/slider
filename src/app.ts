type SlideKind = "image" | "pdf" | "html";
type SyncStatus = "ok" | "syncing" | "error";
type AutoplayMode = "announcements" | "posters";
type LiveStreamMode = "cats" | "puppies" | "jellyfish";
type AppMode = AutoplayMode | "lab" | "poster" | LiveStreamMode;
type BannerKind = "general" | "sync";

interface SliderGlobals {
  SLIDER_MANIFEST_URL?: string;
  SLIDER_TIME_PER_SLIDE_SECONDS?: number;
  SLIDER_POSTER_TIME_SECONDS?: number;
  SLIDER_INTERACTIVE_PAUSE_SECONDS?: number;
  SLIDER_SYNC_STALE_AFTER_SECONDS?: number;
  SLIDER_LIVE_STREAM_MINUTES?: number;
  SLIDER_FOUR_UP?: boolean;
  SLIDER_PAN_POSTERS?: boolean;
  SLIDER_PAN_FRACTION?: number;
  SLIDER_PDF_CACHE_SIZE?: number;
  SLIDER_PDF_RENDER_CACHE?: boolean;
  SLIDER_PDF_MAX_ZOOM_RENDER_SCALE?: number;
  SLIDER_DEBUG?: boolean;
  SLIDER_PDF_WORKER_SOURCE?: string;
}

interface PdfJsGlobal {
  GlobalWorkerOptions: {
    workerSrc: string;
  };
  getDocument(source: string | { url: string }): {
    promise: Promise<PdfDocumentProxy>;
  };
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
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
  index?: SlideItem;
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
  fourUp: boolean;
  panPosters: boolean;
  panFraction: number;
  pdfCacheSize: number;
  pdfRenderCache: boolean;
  pdfMaxZoomRenderScale: number;
  debug: boolean;
}

interface PdfRenderResult {
  canvas: HTMLCanvasElement;
  fitWidth: number;
  fitHeight: number;
  renderWidth: number;
  renderHeight: number;
}

interface PdfRenderCacheEntry {
  key: string;
  promise: Promise<PdfRenderResult>;
}

interface PdfRenderOptions {
  outputScale?: number;
  useCache?: boolean;
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
const announcementsButton = mustGetElement("menu-announcements") as HTMLButtonElement;
const postersButton = mustGetElement("menu-posters") as HTMLButtonElement;
const catsButton = mustGetElement("menu-cats") as HTMLButtonElement;
const puppiesButton = mustGetElement("menu-puppies") as HTMLButtonElement;
const jellyfishButton = mustGetElement("menu-jellyfish") as HTMLButtonElement;
const fullscreenDivider = mustGetElement("fullscreen-divider");
const fullscreenButton = mustGetElement("menu-fullscreen") as HTMLButtonElement;
const labsMenu = mustGetElement("labs-menu");
const previousButton = mustGetElement("previous-slide") as HTMLButtonElement;
const nextButton = mustGetElement("next-slide") as HTMLButtonElement;
const zoomInButton = mustGetElement("zoom-in") as HTMLButtonElement;
const zoomOutButton = mustGetElement("zoom-out") as HTMLButtonElement;
const liveStreamCountdown = mustGetElement("live-stream-countdown");
const liveStreamTime = mustGetElement("live-stream-time");
const liveStreamReset = mustGetElement("live-stream-reset") as HTMLButtonElement;

let slides: SlideItem[] = [];
let labs: LabFolder[] = [];
let slideIndex = -1;
let appMode: AppMode = "announcements";
let activeSlide: HTMLElement | null = null;
let activeFourSlides: HTMLElement[] = [];
let activeFourIndices: number[] = [];
let nextFourSlideIndex = 0;
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
let pdfDocumentCache = new Map<string, Promise<PdfDocumentProxy>>();
let pdfZoomRenderTimer = 0;
let pdfZoomRenderToken = 0;
let pdfZoomRenderTarget: HTMLElement | null = null;
let pdfZoomRenderScale = 1;
let pdfPrefetchIdleHandle = 0;
let pdfPrefetchTimer = 0;
let pdfPrefetchToken = 0;
let lastAutoplayMode: AutoplayMode = "announcements";
let liveStreamEndsAt = 0;
let liveStreamTimer = 0;
let sizingRefreshToken = 0;
let bannerKind: BannerKind | null = null;

const liveStreams: Record<LiveStreamMode, { title: string; embedUrl: string }> = {
  cats: {
    title: "Cats",
    embedUrl: "https://www.youtube.com/embed/e9C9K8ltDfk?autoplay=1&mute=1&playsinline=1&rel=0"
  },
  puppies: {
    title: "Puppies",
    embedUrl: "https://www.youtube.com/embed/h-Z0wCdD3dI?autoplay=1&mute=1&playsinline=1&rel=0"
  },
  jellyfish: {
    title: "Jellyfish",
    embedUrl: "https://www.youtube.com/embed/m1XcdxjVGos?autoplay=1&mute=1&playsinline=1&rel=0"
  }
};

start().catch((error: unknown) => {
  showBanner(`Slider failed to start: ${getErrorMessage(error)}`);
});

async function start(): Promise<void> {
  config = getConfig();
  configurePdfJs();
  wireControls();
  document.body.classList.toggle("four-mode", config.fourUp && appMode === "announcements");
  running = true;
  await refreshSlides(config);

  // The slideshow loop advances announcement slides and the randomized poster
  // stream. Lab browsing and selected poster detail views are user-driven modes.
  while (running) {
    if (appMode === "lab" || appMode === "poster" || isLiveStreamMode(appMode)) {
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

function wireControls(): void {
  menuToggle.addEventListener("click", (event) => {
    pauseForInteraction();
    setMenuOpen(!menuPanel.classList.contains("open"));
    event.stopPropagation();
  });
  menuPanel.addEventListener("pointerdown", (event) => event.stopPropagation());
  menuPanel.addEventListener("click", (event) => event.stopPropagation());
  announcementsButton.addEventListener("click", () => showAnnouncements());
  postersButton.addEventListener("click", () => showPosters());
  catsButton.addEventListener("click", () => showLiveStream("cats"));
  puppiesButton.addEventListener("click", () => showLiveStream("puppies"));
  jellyfishButton.addEventListener("click", () => showLiveStream("jellyfish"));
  fullscreenButton.addEventListener("click", () => {
    void enterFullscreen();
  });
  liveStreamReset.addEventListener("click", (event) => {
    event.stopPropagation();
    resetLiveStreamCountdown();
  });
  previousButton.addEventListener("click", () => showPreviousSlide());
  nextButton.addEventListener("click", () => showNextSlide());
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
      showPreviousSlide();
    } else if (event.key === "ArrowRight") {
      showNextSlide();
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
  });
  updateFullscreenMenu();
}

function setMenuOpen(open: boolean): void {
  menuPanel.classList.toggle("open", open);
  document.body.classList.toggle("menu-open", open);
  if (open) {
    updateFullscreenMenu();
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
  const rawPdfCacheSize = params.get("pdf_cache_size");
  const parsedPdfCacheSize = rawPdfCacheSize ? Number(rawPdfCacheSize) : Number(globals.SLIDER_PDF_CACHE_SIZE);
  const pdfRenderCache = parseBooleanParam(params.get("pdf_render_cache"), globals.SLIDER_PDF_RENDER_CACHE ?? false);
  const rawPdfMaxZoomRenderScale = params.get("pdf_max_zoom_render_scale");
  const parsedPdfMaxZoomRenderScale = rawPdfMaxZoomRenderScale
    ? Number(rawPdfMaxZoomRenderScale)
    : Number(globals.SLIDER_PDF_MAX_ZOOM_RENDER_SCALE);
  const fourUp = parseBooleanParam(params.get("four_up"), Boolean(globals.SLIDER_FOUR_UP));
  const panPosters = parseBooleanParam(params.get("pan_posters"), globals.SLIDER_PAN_POSTERS ?? true);
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
    fourUp,
    panPosters,
    panFraction: Number.isFinite(parsedPanFraction) && parsedPanFraction > 0 && parsedPanFraction <= 1 ? parsedPanFraction : 0.85,
    pdfCacheSize: Number.isFinite(parsedPdfCacheSize) && parsedPdfCacheSize >= 0 ? Math.floor(parsedPdfCacheSize) : 200,
    pdfRenderCache,
    pdfMaxZoomRenderScale: Number.isFinite(parsedPdfMaxZoomRenderScale) && parsedPdfMaxZoomRenderScale > 0 ? parsedPdfMaxZoomRenderScale : 5,
    debug: parseBooleanParam(params.get("debug"), Boolean(globals.SLIDER_DEBUG))
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
    const nextSlides = (manifest.slides || []).filter(isSlideItem);
    labs = (manifest.labs || []).filter(isLabFolder);
    renderMenu();
    const slideCountChanged = slides.length !== nextSlides.length;
    slides = nextSlides;
    slideIndex = normalizeSlideIndex(slideIndex, slides.length);

    // Poster mode is intentionally randomized once per pass. A manifest refresh
    // starts the next pass with a new flattened order from every lab folder.
    if (appMode === "posters" || posterSlideshowItems.length === 0) {
      posterSlideshowItems = shuffleSlides(collectLabPosters(labs));
      posterSlideshowIndex = -1;
    }

    // Four-up mode holds live DOM nodes for each quadrant; rebuild them when the
    // manifest changes so stale indices do not point at removed slides.
    if (config.fourUp && slideCountChanged) {
      activeFourSlides.forEach((node) => node.remove());
      activeFourSlides = [];
      activeFourIndices = [];
      nextFourSlideIndex = 0;
    }
    updateSyncBanner(manifest, config);

    if ((appMode === "announcements" || appMode === "posters") && getAutoplayItems().length === 0) {
      showStaticMessage(getEmptyAutoplayMessage());
    } else if (appMode === "announcements" || appMode === "posters") {
      clearStaticMessage();
    }
  } catch (error: unknown) {
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
    } catch {
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
    promise.then(resolve).catch(resolve).finally(() => window.clearTimeout(timeout));
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
  stage.querySelectorAll(".lab-view").forEach((node) => node.remove());
  activeFourSlides.forEach((node) => node.remove());
  activeFourSlides = [];
  activeFourIndices = [];
  activeSlide?.remove();
  activeSlide = null;
  if (slides.length > 0) {
    slideIndex = (normalizeSlideIndex(slideIndex, slides.length) + 1) % slides.length;
    void showSlide(slides[slideIndex]);
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
  stage.querySelectorAll(".lab-view").forEach((node) => node.remove());
  activeFourSlides.forEach((node) => node.remove());
  activeFourSlides = [];
  activeFourIndices = [];
  activeSlide?.remove();
  activeSlide = null;

  // Entering Posters starts a fresh randomized pass through every non-index file
  // under Labs; later passes refresh the manifest first and reshuffle again.
  posterSlideshowItems = shuffleSlides(collectLabPosters(labs));
  posterSlideshowIndex = -1;
  if (posterSlideshowItems.length > 0) {
    posterSlideshowIndex = 0;
    void showSlide(posterSlideshowItems[posterSlideshowIndex]);
  } else {
    showStaticMessage(getEmptyAutoplayMessage());
  }
}

function showLiveStream(mode: LiveStreamMode): void {
  const stream = liveStreams[mode];
  setMenuOpen(false);
  exitInteractiveMode();
  setAppMode(mode);
  activeSlide?.remove();
  activeSlide = null;
  activeFourSlides.forEach((node) => node.remove());
  activeFourSlides = [];
  activeFourIndices = [];
  stage.querySelectorAll(".slide, .lab-view, .cat-stream").forEach((node) => node.remove());

  const view = document.createElement("article");
  view.className = "cat-stream";
  view.setAttribute("aria-label", `${stream.title} live stream`);

  const frame = document.createElement("iframe");
  frame.src = stream.embedUrl;
  frame.title = `${stream.title} live stream`;
  frame.tabIndex = -1;
  frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  frame.allowFullscreen = true;
  view.append(frame);
  stage.append(view);

  // Livestreams are interrupting modes. The timer owns the return path to whichever
  // autoplay mode was active most recently before the stream was opened.
  resetLiveStreamCountdown();
  showDebugTitle(stream.title);
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
  if (!isLiveStreamMode(appMode) || liveStreamEndsAt <= 0) {
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
  } else {
    const frame = document.createElement("iframe");
    frame.src = item.kind === "pdf" ? `${item.url}#toolbar=0&navpanes=0&scrollbar=0&view=Fit` : item.url;
    frame.title = item.name;
    preview.append(frame);
  }

  const label = document.createElement("span");
  label.textContent = item.name;
  button.append(preview, label);
  return button;
}

function showPoster(index: number, direction: "next" | "previous" = "next"): void {
  const item = posterItems[index];
  if (!item) {
    return;
  }

  setAppMode("poster");
  posterIndex = index;
  pauseForInteraction();
  void showSlide(item, direction);
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
  const enteringIndex = bottomLeftIndex === welcomeIndex
    ? bottomLeftIndex
    : getNextFourSlideIndex();

  // Four-up advances in a serpentine path: new content enters top-left, the top
  // row shifts right, top-right wraps into bottom-right, and the bottom row
  // shifts left as bottom-left leaves.
  const entering = createFourSlideArticle(enteringIndex);
  entering.classList.add("quarter", "q0-enter", "active");
  stage.append(entering);

  const wrapped = createFourSlideArticle(topRightIndex);
  wrapped.classList.add("quarter", "q2-enter", "active");
  stage.append(wrapped);

  await waitForPaint();
  bottomLeft.classList.add("q-exit");
  topLeft && setQuarterClass(topLeft, 1);
  topRight.classList.add("q-wrap-exit");
  setQuarterClass(wrapped, 2);
  bottomRight && setQuarterClass(bottomRight, 3);
  setQuarterClass(entering, 0);

  activeFourSlides = [entering, topLeft, wrapped, bottomRight].filter(Boolean);
  activeFourIndices = [enteringIndex, activeFourIndices[0], topRightIndex, activeFourIndices[2]];

  window.setTimeout(() => {
    bottomLeft.remove();
    topRight.remove();
  }, 700);

  showDebugTitle(getFourUpTitle());
  setDefaultFourUpTransformTarget();
  preloadUpcomingPdfs();
}

function initializeFourSlides(): void {
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
    if (index !== welcomeIndex && !activeIndices.has(index)) {
      return index;
    }
  }

  for (let attempt = 0; attempt < slides.length; attempt += 1) {
    const index = (fallbackStart + attempt) % slides.length;
    if (index !== welcomeIndex) {
      nextFourSlideIndex = (index + 1) % slides.length;
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
    image.addEventListener("error", () => showBanner(`Unable to display ${slide.name}.`));
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
    } catch {
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
    } catch {
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

  renderPdfPage(slide, container, canvas).catch((error: unknown) => {
    container.textContent = `Unable to display ${slide.name}.`;
    showBanner(`Unable to display ${slide.name}: ${getErrorMessage(error)}`);
  });

  return container;
}

async function renderPdfPage(
  slide: SlideItem,
  container: HTMLElement,
  canvas: HTMLCanvasElement,
  options: PdfRenderOptions = {}
): Promise<void> {
  if (!getPdfJsLib()) {
    throw new Error("PDF.js is not available.");
  }

  const viewportSize = await getPdfViewportSize(container);
  const shouldUseRenderCache = options.useCache !== false && config.pdfRenderCache;
  const rendered = options.useCache === false
    ? await renderPdfPageToCanvas(slide, viewportSize, options.outputScale || 1)
    : await getRenderedPdfPage(slide, viewportSize);

  applyRenderedPdfPage(rendered, container, canvas, {
    outputScale: options.outputScale || 1,
    releaseSourceCanvas: !shouldUseRenderCache
  });
}

function applyRenderedPdfPage(
  rendered: PdfRenderResult,
  container: HTMLElement,
  canvas: HTMLCanvasElement,
  options: { outputScale?: number; releaseSourceCanvas?: boolean } = {}
): void {
  const outputScale = options.outputScale || 1;
  const currentScale = Number(container.dataset.renderScale || "0");
  if (currentScale > outputScale + 0.05) {
    if (options.releaseSourceCanvas) {
      releaseCanvas(rendered.canvas);
    }
    return;
  }

  canvas.width = rendered.canvas.width;
  canvas.height = rendered.canvas.height;
  container.style.setProperty("--pdf-fit-width", `${rendered.fitWidth}px`);
  container.style.setProperty("--pdf-fit-height", `${rendered.fitHeight}px`);
  container.style.setProperty("--pdf-render-width", `${rendered.renderWidth}px`);
  container.style.setProperty("--pdf-render-height", `${rendered.renderHeight}px`);
  container.dataset.renderHeight = String(rendered.renderHeight);

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas rendering is not available.");
  }

  context.drawImage(rendered.canvas, 0, 0);
  if (options.releaseSourceCanvas) {
    releaseCanvas(rendered.canvas);
  }
  container.dataset.renderScale = String(outputScale);
  container.dispatchEvent(new Event("pdf-rendered"));
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

async function getRenderedPdfPage(slide: SlideItem, viewportSize: { width: number; height: number }): Promise<PdfRenderResult> {
  if (!config.pdfRenderCache) {
    return renderPdfPageToCanvas(slide, viewportSize);
  }

  const key = getPdfCacheKey(slide, viewportSize);
  const cached = pdfRenderCache.get(key);
  if (cached) {
    pdfRenderCache.delete(key);
    pdfRenderCache.set(key, cached);
    return cached.promise;
  }

  const entry: PdfRenderCacheEntry = {
    key,
    promise: renderPdfPageToCanvas(slide, viewportSize)
  };
  pdfRenderCache.set(key, entry);
  trimPdfRenderCache();
  void entry.promise.then((rendered) => {
    if (pdfRenderCache.get(key) === entry) {
      logDebugCacheAddition("pdf-render", key, pdfRenderCache.size, getRenderedPdfPageDebugDetails(rendered));
    }
  }).catch(() => undefined);
  entry.promise.catch(() => {
    if (pdfRenderCache.get(key) === entry) {
      pdfRenderCache.delete(key);
    }
  });
  return entry.promise;
}

async function renderPdfPageToCanvas(
  slide: SlideItem,
  viewportSize: { width: number; height: number },
  outputScale = 1
): Promise<PdfRenderResult> {
  if (!getPdfJsLib()) {
    throw new Error("PDF.js is not available.");
  }

  const documentProxy = await getPdfDocument(slide);
  const page = await documentProxy.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const viewportWidth = viewportSize.width;
  const viewportHeight = viewportSize.height;
  const fitScale = Math.min(viewportWidth / baseViewport.width, viewportHeight / baseViewport.height);
  const fullWidthScale = viewportWidth / baseViewport.width;
  const renderScale = Math.max(fitScale, isPosterDisplayMode() ? fullWidthScale : fitScale);
  const renderViewport = page.getViewport({ scale: renderScale * window.devicePixelRatio * outputScale });
  const cssWidth = baseViewport.width * renderScale;
  const cssHeight = baseViewport.height * renderScale;
  const fitWidth = baseViewport.width * fitScale;
  const fitHeight = baseViewport.height * fitScale;
  const renderCanvas = document.createElement("canvas");

  renderCanvas.width = Math.ceil(renderViewport.width);
  renderCanvas.height = Math.ceil(renderViewport.height);

  const context = renderCanvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas rendering is not available.");
  }

  await page.render({ canvasContext: context, viewport: renderViewport }).promise;
  return {
    canvas: renderCanvas,
    fitWidth,
    fitHeight,
    renderWidth: cssWidth,
    renderHeight: cssHeight
  };
}

function getPdfDocument(slide: SlideItem): Promise<PdfDocumentProxy> {
  const key = `${slide.url}|${slide.modified || ""}`;
  const cached = pdfDocumentCache.get(key);
  if (cached) {
    pdfDocumentCache.delete(key);
    pdfDocumentCache.set(key, cached);
    return cached;
  }

  const pdfJs = getPdfJsLib();
  if (!pdfJs) {
    return Promise.reject(new Error("PDF.js is not available."));
  }

  const promise = pdfJs.getDocument(slide.url).promise;
  pdfDocumentCache.set(key, promise);
  trimPdfDocumentCache();
  void promise.then((documentProxy) => {
    if (pdfDocumentCache.get(key) === promise) {
      logDebugCacheAddition("pdf-document", key, pdfDocumentCache.size, {
        pages: documentProxy.numPages,
        size: "unknown"
      });
    }
  }).catch(() => undefined);
  promise.catch(() => {
    if (pdfDocumentCache.get(key) === promise) {
      pdfDocumentCache.delete(key);
    }
  });
  return promise;
}

function getPdfCacheKey(slide: SlideItem, viewportSize: { width: number; height: number }): string {
  return [
    slide.url,
    slide.modified || "",
    Math.round(viewportSize.width),
    Math.round(viewportSize.height),
    window.devicePixelRatio,
    isPosterDisplayMode() ? "poster" : "fit"
  ].join("|");
}

function trimPdfRenderCache(): void {
  if (!config.pdfRenderCache || config.pdfCacheSize <= 0) {
    pdfRenderCache.clear();
    return;
  }

  while (pdfRenderCache.size > config.pdfCacheSize) {
    const oldestKey = pdfRenderCache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    pdfRenderCache.delete(oldestKey);
  }
}

function trimPdfDocumentCache(): void {
  if (config.pdfCacheSize <= 0) {
    pdfDocumentCache.clear();
    return;
  }

  while (pdfDocumentCache.size > config.pdfCacheSize) {
    const oldestKey = pdfDocumentCache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    pdfDocumentCache.delete(oldestKey);
  }
}

function getRenderedPdfPageDebugDetails(rendered: PdfRenderResult): Record<string, string | number> {
  const estimatedBytes = rendered.canvas.width * rendered.canvas.height * 4;
  return {
    canvasPixels: `${rendered.canvas.width}x${rendered.canvas.height}`,
    cssPixels: `${Math.round(rendered.renderWidth)}x${Math.round(rendered.renderHeight)}`,
    estimatedBytes,
    estimatedSize: formatBytes(estimatedBytes)
  };
}

function logDebugCacheAddition(
  cacheName: string,
  key: string,
  entries: number,
  details: Record<string, string | number>
): void {
  if (!config.debug) {
    return;
  }

  console.log(`[slider cache] added ${cacheName}`, {
    key,
    entries,
    ...details
  });
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
  if (config.pdfCacheSize <= 0 || !getPdfJsLib()) {
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

    void prefetchPdf(nextPdf).catch(() => {
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
  await getPdfDocument(slide);
  if (!config.pdfRenderCache) {
    return;
  }

  await getRenderedPdfPage(slide, getExpectedPdfViewportSize());
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
    const rect = viewport?.getBoundingClientRect();
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
  appMode = mode;
  document.body.classList.toggle("lab-mode", mode === "lab");
  document.body.classList.toggle("cat-mode", mode === "cats");
  document.body.classList.toggle("live-stream-mode", isLiveStreamMode(mode));
  document.body.classList.toggle("four-mode", config.fourUp && mode === "announcements");
}

function isLiveStreamMode(mode: AppMode): mode is LiveStreamMode {
  return mode === "cats" || mode === "puppies" || mode === "jellyfish";
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
  const nextScale = Math.min(5, Math.max(1, previousScale * factor));
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
  const scale = Math.min(5, Math.max(1, transform.scale));
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
  const canvas = container?.querySelector("canvas") as HTMLCanvasElement | null;
  const slide = getCurrentSlideItem();
  if (!target || !container || !canvas || slide?.kind !== "pdf") {
    return;
  }

  const requestedScale = Number(Math.min(activeTransform.scale, config.pdfMaxZoomRenderScale).toFixed(2));
  if (target !== pdfZoomRenderTarget) {
    pdfZoomRenderTarget = target;
    pdfZoomRenderScale = 1;
  }

  pdfZoomRenderScale = Math.max(pdfZoomRenderScale, requestedScale);
  const renderedScale = Number(container.dataset.renderScale || "1");
  if (renderedScale >= pdfZoomRenderScale - 0.05) {
    return;
  }

  window.clearTimeout(pdfZoomRenderTimer);
  const renderScale = pdfZoomRenderScale;
  pdfZoomRenderTimer = window.setTimeout(() => {
    void renderPosterPdfForZoom(slide, target, container, canvas, renderScale);
  }, 120);
}

async function renderPosterPdfForZoom(
  slide: SlideItem,
  target: HTMLElement,
  container: HTMLElement,
  canvas: HTMLCanvasElement,
  scale: number
): Promise<void> {
  const token = ++pdfZoomRenderToken;
  try {
    const viewportSize = await getPdfViewportSize(container);
    const rendered = await renderPdfPageToCanvas(slide, viewportSize, scale);
    if (token !== pdfZoomRenderToken || target !== activeTransformTarget) {
      return;
    }
    applyRenderedPdfPage(rendered, container, canvas, { outputScale: scale, releaseSourceCanvas: true });
  } catch (error: unknown) {
    showBanner(`Unable to sharpen ${slide.name}: ${getErrorMessage(error)}`);
  }
}

function setActiveTransformTarget(viewport: HTMLElement): void {
  const target = viewport.querySelector(".slide-content") as HTMLElement | null;
  if (!target || target === activeTransformTarget) {
    return;
  }

  activeTransformTarget = target;
  activeTransform = transformByTarget.get(target) || getDefaultTransform();
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

function showPreviousSlide(): void {
  if (appMode === "lab") {
    return;
  }

  pauseForInteraction();

  if (appMode === "poster" && posterItems.length > 0) {
    showPoster((posterIndex - 1 + posterItems.length) % posterItems.length, "previous");
    return;
  }

  if (appMode === "posters" && posterSlideshowItems.length > 0) {
    posterSlideshowIndex = (posterSlideshowIndex - 1 + posterSlideshowItems.length) % posterSlideshowItems.length;
    void showSlide(posterSlideshowItems[posterSlideshowIndex], "previous");
    return;
  }

  if (slides.length === 0) {
    return;
  }

  if (config.fourUp) {
    rewindFourSlides();
  } else {
    slideIndex = (slideIndex - 1 + slides.length) % slides.length;
    void showSlide(slides[slideIndex], "previous");
  }
}

function showNextSlide(): void {
  if (appMode === "lab") {
    return;
  }

  pauseForInteraction();

  if (appMode === "poster" && posterItems.length > 0) {
    showPoster((posterIndex + 1) % posterItems.length);
    return;
  }

  if (appMode === "posters" && posterSlideshowItems.length > 0) {
    posterSlideshowIndex = (posterSlideshowIndex + 1) % posterSlideshowItems.length;
    void showSlide(posterSlideshowItems[posterSlideshowIndex]);
    return;
  }

  if (slides.length === 0) {
    return;
  }

  if (config.fourUp) {
    void advanceFourSlides();
  } else {
    slideIndex = (slideIndex + 1) % slides.length;
    void showSlide(slides[slideIndex]);
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
      if (appMode === "lab" || appMode === "poster" || isLiveStreamMode(appMode)) {
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
  const slide = value as Partial<SlideItem>;
  return Boolean(
    slide.name &&
    slide.url &&
    (slide.kind === "image" || slide.kind === "pdf" || slide.kind === "html")
  );
}

function isLabFolder(value: unknown): value is LabFolder {
  const lab = value as Partial<LabFolder>;
  return Boolean(lab.name && lab.path);
}

function collectLabPosters(folders: LabFolder[]): SlideItem[] {
  const items: SlideItem[] = [];
  for (const folder of folders) {
    items.push(...(folder.items || []).filter(isSlideItem));
    items.push(...collectLabPosters((folder.children || []).filter(isLabFolder)));
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
  bannerKind = kind;
  banner.textContent = message;
  banner.classList.add("visible");
}

function hideBanner(kind?: BannerKind): void {
  if (kind && bannerKind !== kind) {
    return;
  }

  bannerKind = null;
  banner.textContent = "";
  banner.classList.remove("visible");
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
