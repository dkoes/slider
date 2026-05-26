type SlideKind = "image" | "pdf" | "html";
type SyncStatus = "ok" | "syncing" | "error";
type AutoplayMode = "announcements" | "posters";
type AppMode = AutoplayMode | "lab" | "poster" | "cats";

interface SliderGlobals {
  SLIDER_MANIFEST_URL?: string;
  SLIDER_TIME_PER_SLIDE_SECONDS?: number;
  SLIDER_POSTER_TIME_SECONDS?: number;
  SLIDER_INTERACTIVE_PAUSE_SECONDS?: number;
  SLIDER_SYNC_STALE_AFTER_SECONDS?: number;
  SLIDER_LIVE_STREAM_MINUTES?: number;
  SLIDER_FOUR_UP?: boolean;
  SLIDER_PDF_CACHE_SIZE?: number;
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
  pdfCacheSize: number;
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
let lastAutoplayMode: AutoplayMode = "announcements";
let liveStreamEndsAt = 0;
let liveStreamTimer = 0;

declare const pdfjsLib: PdfJsGlobal | undefined;

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
    if (appMode === "lab" || appMode === "poster" || appMode === "cats") {
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
    menuPanel.classList.toggle("open");
    event.stopPropagation();
  });
  menuPanel.addEventListener("pointerdown", (event) => event.stopPropagation());
  menuPanel.addEventListener("click", (event) => event.stopPropagation());
  announcementsButton.addEventListener("click", () => showAnnouncements());
  postersButton.addEventListener("click", () => showPosters());
  catsButton.addEventListener("click", () => showCats());
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
  document.addEventListener("pointerdown", () => {
    if (menuPanel.classList.contains("open")) {
      menuPanel.classList.remove("open");
    }
  });
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
  const fourUp = parseBooleanParam(params.get("four_up"), Boolean(globals.SLIDER_FOUR_UP));

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
    pdfCacheSize: Number.isFinite(parsedPdfCacheSize) && parsedPdfCacheSize >= 0 ? Math.floor(parsedPdfCacheSize) : 200,
    debug: parseBooleanParam(params.get("debug"), Boolean(globals.SLIDER_DEBUG))
  };
}

function configurePdfJs(): void {
  const globals = window as Window & SliderGlobals;
  if (typeof pdfjsLib === "undefined" || !globals.SLIDER_PDF_WORKER_SOURCE) {
    return;
  }

  // The worker source is embedded at build time so the generated Python agent
  // remains a single deployable file with no CDN or sidecar PDF.js assets.
  const workerBlob = new Blob([globals.SLIDER_PDF_WORKER_SOURCE], { type: "text/javascript" });
  pdfWorkerUrl = URL.createObjectURL(workerBlob);
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
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
    showBanner(`Slide sync ${sync.status}${detail}`);
    return;
  }

  if (staleMessage) {
    showBanner(staleMessage);
    return;
  }

  hideBanner();
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

async function showSlide(slide: SlideItem): Promise<void> {
  if (appMode === "announcements" || appMode === "posters" || appMode === "poster") {
    stage.querySelectorAll(".lab-view, .cat-stream").forEach((node) => node.remove());
  }
  activeFourSlides.forEach((node) => node.remove());
  activeFourSlides = [];

  // Append first, then wait one frame before toggling classes so CSS transitions
  // see a real "before" and "after" state.
  const next = document.createElement("article");
  next.className = "slide";
  next.setAttribute("aria-label", slide.name);
  next.append(createInteractiveViewport(slide));
  stage.append(next);

  await waitForPaint();
  activeSlide?.classList.remove("active");
  activeSlide?.classList.add("exiting");
  next.classList.add("active");

  const previous = activeSlide;
  activeSlide = next;
  resetTransform();
  showDebugTitle(slide.name);
  preloadUpcomingPdfs();

  window.setTimeout(() => {
    previous?.remove();
  }, 700);
}

function renderMenu(): void {
  labsMenu.replaceChildren();
  if (labs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-empty";
    empty.textContent = "No labs available";
    labsMenu.append(empty);
    return;
  }

  labsMenu.append(createLabMenuList(labs));
}

function createLabMenuList(items: LabFolder[]): HTMLElement {
  const list = document.createElement("ul");
  list.className = "lab-menu-list";
  for (const lab of items) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "menu-item lab-menu-item";
    button.type = "button";
    button.textContent = lab.name;
    button.addEventListener("click", () => showLab(lab));
    item.append(button);
    if (lab.children?.length) {
      item.append(createLabMenuList(lab.children));
    }
    list.append(item);
  }
  return list;
}

function showAnnouncements(): void {
  setAppMode("announcements");
  lastAutoplayMode = "announcements";
  stopLiveStreamCountdown();
  posterItems = [];
  posterIndex = -1;
  menuPanel.classList.remove("open");
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
  menuPanel.classList.remove("open");
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

function showCats(): void {
  menuPanel.classList.remove("open");
  exitInteractiveMode();
  setAppMode("cats");
  activeSlide?.remove();
  activeSlide = null;
  activeFourSlides.forEach((node) => node.remove());
  activeFourSlides = [];
  activeFourIndices = [];
  stage.querySelectorAll(".slide, .lab-view, .cat-stream").forEach((node) => node.remove());

  const view = document.createElement("article");
  view.className = "cat-stream";
  view.setAttribute("aria-label", "Cats live stream");

  const frame = document.createElement("iframe");
  frame.src = "https://www.youtube.com/embed/e9C9K8ltDfk?autoplay=1&mute=1&playsinline=1&rel=0";
  frame.title = "Cats live stream";
  frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  frame.allowFullscreen = true;
  view.append(frame);
  stage.append(view);

  // Cats is an interrupting mode. The timer owns the return path to whichever
  // autoplay mode was active most recently before the stream was opened.
  resetLiveStreamCountdown();
  showDebugTitle("Cats");
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
  if (appMode !== "cats" || liveStreamEndsAt <= 0) {
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
  posterItems = (lab.items || []).filter(isSlideItem);
  posterIndex = -1;
  menuPanel.classList.remove("open");
  pauseForInteraction();
  activeSlide?.remove();
  activeSlide = null;
  activeFourSlides.forEach((node) => node.remove());
  activeFourSlides = [];
  stage.querySelectorAll(".slide, .lab-view").forEach((node) => node.remove());

  // Lab mode is a split browsing view: index.html on the left, poster chooser on
  // the right. Selecting a poster switches back to fullscreen slide rendering.
  const view = document.createElement("article");
  view.className = "lab-view active";
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
  for (const item of posterItems) {
    selector.append(createPosterSelectorButton(item, posterItems.indexOf(item)));
  }

  view.append(indexPane, selector);
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

function showPoster(index: number): void {
  const item = posterItems[index];
  if (!item) {
    return;
  }

  setAppMode("poster");
  posterIndex = index;
  pauseForInteraction();
  void showSlide(item);
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

  const [topRight, topLeft, bottomRight, bottomLeft] = activeFourSlides;
  const [, topLeftIndex] = activeFourIndices;
  const enteringIndex = nextFourSlideIndex;
  nextFourSlideIndex = (nextFourSlideIndex + 1) % slides.length;

  // The visual order is top-right, top-left, bottom-right, bottom-left. Each tick
  // moves left; the top-left tile exits left and reappears from the right as the
  // new bottom-right tile, avoiding any diagonal movement.
  const entering = createFourSlideArticle(enteringIndex);
  entering.classList.add("quarter", "q4", "active");
  stage.append(entering);

  const wrapped = createFourSlideArticle(topLeftIndex);
  wrapped.classList.add("quarter", "q2-enter", "active");
  stage.append(wrapped);

  await waitForPaint();
  bottomLeft.classList.add("q-exit");
  topRight && setQuarterClass(topRight, 1);
  topLeft.classList.add("q-wrap-exit");
  setQuarterClass(wrapped, 2);
  bottomRight && setQuarterClass(bottomRight, 3);
  setQuarterClass(entering, 0);

  activeFourSlides = [entering, topRight, wrapped, bottomRight].filter(Boolean);
  activeFourIndices = [enteringIndex, activeFourIndices[0], topLeftIndex, activeFourIndices[2]];

  window.setTimeout(() => {
    bottomLeft.remove();
    topLeft.remove();
  }, 700);

  showDebugTitle(getFourUpTitle());
  setDefaultFourUpTransformTarget();
  preloadUpcomingPdfs();
}

function initializeFourSlides(): void {
  activeFourSlides.forEach((node) => node.remove());
  activeFourSlides = [];
  activeFourIndices = [];
  const count = Math.min(4, slides.length);
  for (let offset = 0; offset < count; offset += 1) {
    const index = (nextFourSlideIndex + offset) % slides.length;
    const tile = createFourSlideArticle(index);
    tile.classList.add("quarter", `q${offset}`, "active");
    stage.append(tile);
    activeFourSlides.push(tile);
    activeFourIndices.push(index);
  }
  nextFourSlideIndex = (nextFourSlideIndex + count) % slides.length;
  setDefaultFourUpTransformTarget();
  showDebugTitle(getFourUpTitle());
  preloadUpcomingPdfs();
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
  tile.classList.remove("q-1", "q0", "q1", "q2", "q3", "q4", "q2-enter", "q-wrap-exit", "q-exit", "q-exit-reverse");
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

async function renderPdfPage(slide: SlideItem, container: HTMLElement, canvas: HTMLCanvasElement): Promise<void> {
  if (typeof pdfjsLib === "undefined") {
    throw new Error("PDF.js is not available.");
  }

  const viewportSize = await getPdfViewportSize(container);
  const rendered = await getRenderedPdfPage(slide, viewportSize);

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
  container.dispatchEvent(new Event("pdf-rendered"));
}

async function getRenderedPdfPage(slide: SlideItem, viewportSize: { width: number; height: number }): Promise<PdfRenderResult> {
  const key = getPdfCacheKey(slide, viewportSize);
  const cached = pdfRenderCache.get(key);
  if (cached) {
    pdfRenderCache.delete(key);
    pdfRenderCache.set(key, cached);
    return cached.promise;
  }

  const entry: PdfRenderCacheEntry = {
    key,
    promise: renderPdfPageToCache(slide, viewportSize)
  };
  pdfRenderCache.set(key, entry);
  trimPdfRenderCache();
  entry.promise.catch(() => {
    if (pdfRenderCache.get(key) === entry) {
      pdfRenderCache.delete(key);
    }
  });
  return entry.promise;
}

async function renderPdfPageToCache(slide: SlideItem, viewportSize: { width: number; height: number }): Promise<PdfRenderResult> {
  if (typeof pdfjsLib === "undefined") {
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
  const renderViewport = page.getViewport({ scale: renderScale * window.devicePixelRatio });
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

  const promise = pdfjsLib!.getDocument(slide.url).promise;
  pdfDocumentCache.set(key, promise);
  trimPdfDocumentCache();
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
  if (config.pdfCacheSize <= 0) {
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

function preloadUpcomingPdfs(): void {
  if (config.pdfCacheSize <= 0 || typeof pdfjsLib === "undefined") {
    return;
  }

  const nextPdf = getNextPdfToPreload();
  if (!nextPdf) {
    return;
  }

  void getRenderedPdfPage(nextPdf, getExpectedPdfViewportSize()).catch(() => {
    // The visible render path reports failures; background preloads should stay quiet.
  });
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
  if (!isPosterDisplayMode() || (slide.kind !== "image" && slide.kind !== "pdf")) {
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
  viewport.style.setProperty("--poster-pan-media-height", `${mediaHeight}px`);
  viewport.style.setProperty("--poster-pan-distance", `${distance}px`);
  viewport.dataset.panReady = distance > 1 ? "true" : "false";
  media.classList.toggle("poster-pan-media", distance > 1);
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
  document.body.classList.toggle("four-mode", config.fourUp && mode === "announcements");
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
  pauseForInteraction();
  if (appMode === "lab") {
    return;
  }

  if (appMode === "poster" && posterItems.length > 0) {
    showPoster((posterIndex - 1 + posterItems.length) % posterItems.length);
    return;
  }

  if (appMode === "posters" && posterSlideshowItems.length > 0) {
    posterSlideshowIndex = (posterSlideshowIndex - 1 + posterSlideshowItems.length) % posterSlideshowItems.length;
    void showSlide(posterSlideshowItems[posterSlideshowIndex]);
    return;
  }

  if (slides.length === 0) {
    return;
  }

  if (config.fourUp) {
    rewindFourSlides();
  } else {
    slideIndex = (slideIndex - 1 + slides.length) % slides.length;
    void showSlide(slides[slideIndex]);
  }
}

function showNextSlide(): void {
  pauseForInteraction();
  if (appMode === "lab") {
    return;
  }

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
  const end = Date.now() + durationMs;
  while (running) {
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

function showBanner(message: string): void {
  banner.textContent = message;
  banner.classList.add("visible");
}

function hideBanner(): void {
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
