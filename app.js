/* ============================================================
   Liseuse v4 — app.js  (fully debugged)

   Bug fixes:
   1. MODEL CACHING: Removed SW interception of CDN/HuggingFace
      requests. transformers.js has its own Cache API layer — the
      SW was interfering with it, causing re-downloads. Now the SW
      only caches the app shell. Model downloads are cached natively
      by transformers.js in the browser's Cache Storage.

   2. NO SOUND ON iOS: iOS Safari blocks Audio.play() unless it's
      in the direct call stack of a user gesture. Our async chain
      (tap → generate TTS → play) broke that chain. Fix: create &
      unlock an AudioContext on the very first user tap, then play
      all generated audio through that context.

   3. SHOWS PLAYING BUT SILENT: The UI showed "playing" instantly
      while Kokoro was still generating audio (~5-10s). Fix: added
      a "Generating…" state with a spinner on the play button while
      TTS inference runs. Only shows "playing" when audio starts.

   4. PDF CRASH ON LARGE FILES: Rendering ALL pages at once into
      canvas elements uses enormous memory on iOS. Fix: lazy
      rendering — only render pages near the viewport. Use
      placeholder divs for far-away pages, render on scroll.

   5. PAUSE/RESUME BROKEN: The async playback loop and Audio
      element pause were out of sync — pausing the audio left the
      loop promise dangling. Fix: proper pause/resume using a
      shared flag + promise resolution.

   6. STOP RACE CONDITION: stop() cleared audio src but the
      pending speakText promise could hang. Fix: resolve promise
      immediately on stop via an abort mechanism.
   ============================================================ */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

const STORAGE_KEY = 'liseuse_v4';

const VOICE_DEFS = {
  en: [
    { id: 'af_heart', label: 'Heart', gender: 'Female' },
    { id: 'am_adam',  label: 'Adam',  gender: 'Male'   },
  ],
  fr: [
    { id: 'ff_siwis', label: 'Siwis', gender: 'Female' },
  ]
};


// ════════════════════════════════════════
// PDFManager — LAZY rendering to fix crashes
// ════════════════════════════════════════
const PDFManager = (() => {
  let pdfDoc = null;
  let pages = [];      // { pageNum, wrapper, viewport, outputScale, canvas?, rendered }
  let pageTexts = [];
  let renderScale = 1;
  let containerWidth = 0;
  let scrollObserver = null;

  async function load(arrayBuffer) {
    const readerArea = document.getElementById('reader-area');
    readerArea.innerHTML = '';
    pages = [];
    pageTexts = [];
    if (scrollObserver) scrollObserver.disconnect();

    pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    containerWidth = readerArea.clientWidth - 32;

    // Phase 1: Create placeholder wrappers for ALL pages (cheap — no canvas)
    // and extract text. Only render the first few pages.
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      await preparePage(i, readerArea);
    }

    // Phase 2: Set up lazy rendering via IntersectionObserver
    setupLazyRenderer();

    return { pageCount: pdfDoc.numPages };
  }

  /**
   * Create a placeholder wrapper and extract text, but DON'T render canvas
   * unless it's one of the first 3 pages.
   */
  async function preparePage(pageNum, container) {
    const page = await pdfDoc.getPage(pageNum);
    const unscaledVP = page.getViewport({ scale: 1 });
    renderScale = containerWidth / unscaledVP.width;
    const viewport = page.getViewport({ scale: renderScale });
    const outputScale = Math.min(window.devicePixelRatio || 1, 1.5);

    // Create wrapper with correct dimensions (so scrolling works)
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.style.width  = viewport.width + 'px';
    wrapper.style.height = viewport.height + 'px';
    wrapper.dataset.pageIdx = pages.length;

    container.appendChild(wrapper);

    // Extract text (cheap, no rendering needed)
    const textContent = await page.getTextContent();
    const fullText = textContent.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();

    const pageIdx = pages.length;
    pages.push({
      pageNum, wrapper, viewport, outputScale,
      canvas: null, rendered: false
    });
    pageTexts.push(fullText);

    // Render first 3 pages immediately so user sees content
    if (pageNum <= 3) {
      await renderPageCanvas(pageIdx);
    }
  }

  /**
   * Actually render a page's canvas. Called lazily.
   */
  async function renderPageCanvas(pageIdx) {
    const p = pages[pageIdx];
    if (!p || p.rendered || !pdfDoc) return;

    try {
      const page = await pdfDoc.getPage(p.pageNum);

      // Create canvas
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width  = Math.floor(p.viewport.width  * p.outputScale);
      canvas.height = Math.floor(p.viewport.height * p.outputScale);
      canvas.style.width  = p.viewport.width  + 'px';
      canvas.style.height = p.viewport.height + 'px';
      ctx.scale(p.outputScale, p.outputScale);

      // Insert canvas into wrapper
      p.wrapper.appendChild(canvas);
      p.canvas = canvas;

      await page.render({ canvasContext: ctx, viewport: p.viewport }).promise;
      p.rendered = true;
    } catch (e) {
      console.warn('Render failed for page', p.pageNum, e);
    }
  }

  /**
   * Re-render a page whose canvas was evicted by iOS.
   */
  async function reRenderPageCanvas(pageIdx) {
    const p = pages[pageIdx];
    if (!p || !p.canvas || !pdfDoc) return;

    try {
      const page = await pdfDoc.getPage(p.pageNum);
      const ctx = p.canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
      ctx.scale(p.outputScale, p.outputScale);
      await page.render({ canvasContext: ctx, viewport: p.viewport }).promise;
    } catch (e) {
      console.warn('Re-render failed for page', p.pageNum, e);
    }
  }

  /**
   * Lazy renderer: observe which pages are near the viewport.
   * When a page enters the viewport area, render its canvas.
   * Also checks for iOS canvas eviction on already-rendered pages.
   */
  function setupLazyRenderer() {
    scrollObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const idx = parseInt(entry.target.dataset.pageIdx);
        const p = pages[idx];
        if (!p) continue;

        if (!p.rendered) {
          // First time in viewport — render it
          renderPageCanvas(idx);
        } else if (p.canvas) {
          // Already rendered — check for iOS eviction
          try {
            const ctx = p.canvas.getContext('2d');
            const px = ctx.getImageData(0, 0, 1, 1).data;
            if (px[0] === 0 && px[1] === 0 && px[2] === 0 && px[3] === 0) {
              reRenderPageCanvas(idx);
            }
          } catch (e) {}
        }
      }
    }, {
      root: document.getElementById('reader-area'),
      rootMargin: '600px 0px',  // render 600px ahead
      threshold: 0
    });

    for (const p of pages) {
      scrollObserver.observe(p.wrapper);
    }
  }

  return {
    load,
    getPages:     () => pages,
    getPageTexts:  () => pageTexts,
    getPageCount:  () => pdfDoc ? pdfDoc.numPages : 0,
  };
})();


// ════════════════════════════════════════
// KokoroEngine — fully debugged TTS
// ════════════════════════════════════════
const KokoroEngine = (() => {
  let ttsInstance = null;
  let isModelLoaded = false;
  let isModelLoading = false;

  // Audio playback via Web Audio API (more reliable on iOS than <audio>)
  let audioCtx = null;
  let currentSource = null;  // AudioBufferSourceNode
  let currentResolve = null; // resolve fn for the current playback promise

  // State
  let _isPlaying = false;
  let _isGenerating = false;
  let _isPaused = false;
  let currentPageIdx = 0;
  let currentLang = 'en';
  let currentVoiceId = 'af_heart';
  let speed = 1.0;
  let stopRequested = false;

  // Callbacks
  let onPageChange = null;
  let onStateChange = null;
  let onFinished = null;

  /**
   * Ensure AudioContext exists and is unlocked.
   * MUST be called from a direct user gesture handler.
   */
  function ensureAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // iOS requires resume() from a user gesture to unlock
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  /**
   * Load the Kokoro model.
   * transformers.js caches model files itself via Cache API.
   */
  async function loadModel(onProgress) {
    if (isModelLoaded) return;
    if (isModelLoading) return;
    isModelLoading = true;

    try {
      const { KokoroTTS } = await import('https://esm.sh/kokoro-js@1.2.1');

      ttsInstance = await KokoroTTS.from_pretrained(
        'onnx-community/Kokoro-82M-v1.0-ONNX',
        {
          dtype: 'q8',
          device: 'wasm',
          progress_callback: (progress) => {
            if (onProgress && progress.progress != null) {
              onProgress(Math.round(progress.progress));
            }
          }
        }
      );

      isModelLoaded = true;
    } catch (e) {
      console.error('Kokoro load failed:', e);
      throw e;
    } finally {
      isModelLoading = false;
    }
  }

  /**
   * Generate audio for text and play it through AudioContext.
   * Returns promise that resolves when playback ends, or immediately on stop.
   */
  function speakText(text) {
    if (!ttsInstance || !text || text.trim().length === 0) {
      return Promise.resolve();
    }

    return new Promise(async (resolve) => {
      // Store resolve so stop() can call it
      currentResolve = resolve;

      if (stopRequested) { resolve(); return; }

      try {
        // Generate audio (this is the slow part — WASM inference)
        const result = await ttsInstance.generate(text, {
          voice: currentVoiceId,
          speed: speed,
        });

        if (stopRequested) { resolve(); return; }

        // Decode the WAV blob into an AudioBuffer
        const blob = result.toBlob();
        const arrayBuf = await blob.arrayBuffer();

        if (stopRequested) { resolve(); return; }

        const audioBuffer = await audioCtx.decodeAudioData(arrayBuf);

        if (stopRequested) { resolve(); return; }

        // Wait if paused
        while (_isPaused && !stopRequested) {
          await new Promise(r => setTimeout(r, 200));
        }
        if (stopRequested) { resolve(); return; }

        // Play through AudioContext
        currentSource = audioCtx.createBufferSource();
        currentSource.buffer = audioBuffer;
        currentSource.connect(audioCtx.destination);

        currentSource.onended = () => {
          currentSource = null;
          currentResolve = null;
          resolve();
        };

        // Mark as actually playing now (audio will be audible)
        _isGenerating = false;
        _isPlaying = true;
        onStateChange?.('playing');

        currentSource.start(0);

      } catch (e) {
        console.warn('speakText error:', e);
        currentResolve = null;
        resolve();
      }
    });
  }

  /**
   * Main playback loop: read page by page.
   */
  async function playFromPage(startPageIdx, pageTexts) {
    // Ensure AudioContext is alive (called from user gesture context)
    ensureAudioContext();

    stopRequested = false;
    _isPaused = false;
    _isPlaying = true;
    _isGenerating = true;
    currentPageIdx = startPageIdx;
    onStateChange?.('generating');

    for (let i = startPageIdx; i < pageTexts.length; i++) {
      if (stopRequested) break;

      currentPageIdx = i;
      onPageChange?.(i);

      const text = pageTexts[i];
      if (!text || text.trim().length === 0) continue;

      // Split into chunks (Kokoro context ~510 tokens ≈ ~400 chars safe)
      const chunks = splitIntoChunks(text, 400);

      for (let c = 0; c < chunks.length; c++) {
        if (stopRequested) break;

        // Show generating state for the first chunk of each page
        if (c === 0) {
          _isGenerating = true;
          onStateChange?.('generating');
        }

        await speakText(chunks[c]);
      }
    }

    _isPlaying = false;
    _isGenerating = false;
    _isPaused = false;
    stopRequested = false;
    onStateChange?.('stopped');
    onFinished?.();
  }

  function splitIntoChunks(text, maxLen) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) { chunks.push(remaining); break; }
      let splitAt = maxLen;
      for (const e of ['. ', '! ', '? ', '; ', ', ', ': ']) {
        const idx = remaining.lastIndexOf(e, maxLen);
        if (idx > maxLen * 0.3) { splitAt = idx + e.length; break; }
      }
      if (splitAt === maxLen) {
        const sp = remaining.lastIndexOf(' ', maxLen);
        if (sp > maxLen * 0.3) splitAt = sp + 1;
      }
      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }
    return chunks.filter(c => c.length > 0);
  }

  function stop() {
    stopRequested = true;
    _isPaused = false;

    // Stop any playing audio immediately
    if (currentSource) {
      try { currentSource.stop(); } catch (e) {}
      currentSource = null;
    }

    // Resolve any pending promise so the loop can exit
    if (currentResolve) {
      currentResolve();
      currentResolve = null;
    }

    _isPlaying = false;
    _isGenerating = false;
    onStateChange?.('stopped');
  }

  function pause() {
    if (!_isPlaying) return;
    _isPaused = true;
    // Suspend AudioContext to actually pause audio output
    if (audioCtx && audioCtx.state === 'running') {
      audioCtx.suspend();
    }
    onStateChange?.('paused');
  }

  function resume() {
    if (!_isPaused) return;
    _isPaused = false;
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    onStateChange?.('playing');
  }

  function setVoice(id)  { currentVoiceId = id; }
  function setSpeed(s)   { speed = s; }
  function setLang(lang) { currentLang = lang; }

  return {
    loadModel,
    ensureAudioContext,
    playFromPage,
    stop,
    pause,
    resume,
    setVoice,
    setSpeed,
    setLang,
    get isLoaded()     { return isModelLoaded; },
    get isLoading()    { return isModelLoading; },
    get isPlaying()    { return _isPlaying; },
    get isGenerating() { return _isGenerating; },
    get isPaused()     { return _isPaused; },
    get currentPageIdx() { return currentPageIdx; },
    get currentLang()    { return currentLang; },
    get currentVoiceId() { return currentVoiceId; },
    get speed()          { return speed; },
    set onPageChange(fn)  { onPageChange = fn; },
    set onStateChange(fn) { onStateChange = fn; },
    set onFinished(fn)    { onFinished = fn; },
  };
})();


// ════════════════════════════════════════
// Persistence
// ════════════════════════════════════════
const Persistence = (() => {
  function save(data) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {} }
  function load() { try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null; } catch { return null; } }
  function makeFileKey(f) { return f.name + '|' + f.size; }
  return { save, load, makeFileKey };
})();


// ════════════════════════════════════════
// UIController
// ════════════════════════════════════════
(async function UIController() {
  const $ = (id) => document.getElementById(id);
  const welcomeScreen    = $('welcome-screen');
  const welcomeBtn       = $('welcome-import-btn');
  const fileInput        = $('file-input');
  const topImportBtn     = $('top-import-btn');
  const docTitle         = $('doc-title');
  const langToggle       = $('lang-toggle');
  const voiceMenuBtn     = $('voice-menu-btn');
  const voiceMenuOverlay = $('voice-menu-overlay');
  const voiceMenuList    = $('voice-menu-list');
  const readerArea       = $('reader-area');
  const loadingOverlay   = $('loading-overlay');
  const loadingText      = $('loading-text');
  const playBtn          = $('play-btn');
  const stopBtn          = $('stop-btn');
  const speedSlider      = $('speed-slider');
  const speedDisplay     = $('speed-display');
  const progressBarFill  = $('progress-bar-fill');
  const progressLabel    = $('progress-label');

  let pageTexts = [];
  let currentFileKey = null;
  let activePageWrapper = null;

  // Restore settings
  const saved = Persistence.load();
  if (saved) {
    if (saved.lang) KokoroEngine.setLang(saved.lang);
    if (saved.voiceId) KokoroEngine.setVoice(saved.voiceId);
    if (saved.speed) { KokoroEngine.setSpeed(saved.speed); speedSlider.value = saved.speed; }
  } else {
    KokoroEngine.setLang('fr');
    KokoroEngine.setVoice('ff_siwis');
  }
  updateLangButton();
  updateSpeedDisplay();

  // ── File import ──
  welcomeBtn.addEventListener('click', () => fileInput.click());
  topImportBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await loadPDF(file);
  });

  async function loadPDF(file) {
    welcomeScreen.classList.add('hidden');
    loadingOverlay.classList.remove('hidden');
    loadingText.textContent = 'Loading PDF…';
    docTitle.textContent = file.name.replace(/\.pdf$/i, '');

    try {
      const buffer = await file.arrayBuffer();
      await PDFManager.load(buffer);
      pageTexts = PDFManager.getPageTexts();
      currentFileKey = Persistence.makeFileKey(file);

      // Page tap handlers
      PDFManager.getPages().forEach((page, idx) => {
        page.wrapper.addEventListener('click', () => onPageTap(idx));
      });

      // Restore position
      let startPage = 0;
      if (saved && saved.fileKey === currentFileKey && saved.pageIdx != null) {
        startPage = Math.min(saved.pageIdx, pageTexts.length - 1);
      }
      updateProgress(startPage);
      if (startPage > 0) {
        setTimeout(() => scrollToPage(startPage, false), 300);
      }
    } catch (err) {
      console.error('PDF load error:', err);
      alert('Could not load this PDF. Try a smaller file or a different PDF.');
      welcomeScreen.classList.remove('hidden');
    }

    loadingOverlay.classList.add('hidden');
    fileInput.value = '';
  }

  // ── Tap to read from page ──
  function onPageTap(pageIdx) {
    // Unlock AudioContext on user gesture (critical for iOS)
    KokoroEngine.ensureAudioContext();

    if (!KokoroEngine.isLoaded) {
      populateVoiceMenu();
      voiceMenuOverlay.classList.add('visible');
      return;
    }

    KokoroEngine.stop();
    highlightPage(pageIdx);
    KokoroEngine.playFromPage(pageIdx, pageTexts);
  }

  // ── Engine callbacks ──
  KokoroEngine.onPageChange = (pageIdx) => {
    highlightPage(pageIdx);
    updateProgress(pageIdx);
    scrollToPage(pageIdx, true);
    persistState(pageIdx);
  };

  KokoroEngine.onStateChange = (state) => {
    // state: 'generating' | 'playing' | 'paused' | 'stopped'
    updatePlayButton(state);
  };

  KokoroEngine.onFinished = () => {
    clearPageHighlight();
  };

  // ── Page highlight ──
  function highlightPage(idx) {
    clearPageHighlight();
    const pages = PDFManager.getPages();
    if (pages[idx]) {
      activePageWrapper = pages[idx].wrapper;
      activePageWrapper.classList.add('reading-from');
    }
  }

  function clearPageHighlight() {
    if (activePageWrapper) {
      activePageWrapper.classList.remove('reading-from');
      activePageWrapper = null;
    }
  }

  // ── Scroll ──
  function scrollToPage(idx, smooth) {
    const pages = PDFManager.getPages();
    if (!pages[idx]) return;
    const wrapper = pages[idx].wrapper;
    const areaRect = readerArea.getBoundingClientRect();
    const wrapRect = wrapper.getBoundingClientRect();

    const inView = wrapRect.top >= areaRect.top - 20 &&
                   wrapRect.top <= areaRect.top + areaRect.height * 0.5;
    if (inView) return;

    const topInArea = wrapRect.top - areaRect.top + readerArea.scrollTop;
    if (smooth) {
      readerArea.scrollTo({ top: Math.max(0, topInArea - 20), behavior: 'smooth' });
    } else {
      readerArea.scrollTop = Math.max(0, topInArea - 20);
    }
  }

  // ── Play / Pause / Stop ──
  playBtn.addEventListener('click', () => {
    // Always unlock AudioContext on tap
    KokoroEngine.ensureAudioContext();

    if (pageTexts.length === 0) return;

    if (!KokoroEngine.isLoaded) {
      populateVoiceMenu();
      voiceMenuOverlay.classList.add('visible');
      return;
    }

    if (KokoroEngine.isPaused) {
      KokoroEngine.resume();
      return;
    }

    if (KokoroEngine.isPlaying || KokoroEngine.isGenerating) {
      KokoroEngine.pause();
      return;
    }

    // Start fresh from visible page
    const startPage = getVisiblePageIdx();
    KokoroEngine.playFromPage(startPage, pageTexts);
  });

  stopBtn.addEventListener('click', () => {
    KokoroEngine.stop();
    persistState(KokoroEngine.currentPageIdx);
  });

  // Speed
  speedSlider.addEventListener('input', () => {
    KokoroEngine.setSpeed(parseFloat(speedSlider.value));
    updateSpeedDisplay();
    persistState(KokoroEngine.currentPageIdx);
  });

  function updateSpeedDisplay() {
    speedDisplay.textContent = KokoroEngine.speed.toFixed(1) + '×';
  }

  /**
   * Play button shows 4 states:
   * - 'stopped':     ▶ play icon
   * - 'generating':  spinner (AI is thinking)
   * - 'playing':     ‖ pause icon
   * - 'paused':      ▶ play icon
   */
  function updatePlayButton(state) {
    if (state === 'generating') {
      playBtn.innerHTML = `<div class="btn-spinner"></div>`;
      playBtn.style.background = 'var(--control-bg)';
      playBtn.style.color = 'var(--text-secondary)';
    } else if (state === 'playing') {
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`;
      playBtn.style.background = 'var(--accent)';
      playBtn.style.color = 'white';
    } else {
      // stopped or paused
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86A1 1 0 008 5.14z"/></svg>`;
      playBtn.style.background = 'var(--accent)';
      playBtn.style.color = 'white';
    }
  }

  // ── Progress ──
  function updateProgress(pageIdx) {
    const total = PDFManager.getPageCount();
    if (total === 0) { progressBarFill.style.width = '0%'; progressLabel.textContent = '—'; return; }
    const page = (pageIdx ?? 0) + 1;
    progressBarFill.style.width = Math.round((page / total) * 100) + '%';
    progressLabel.textContent = `Page ${page} of ${total}`;
  }

  function getVisiblePageIdx() {
    const pages = PDFManager.getPages();
    const areaRect = readerArea.getBoundingClientRect();
    const cutoff = areaRect.top + areaRect.height / 3;
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].wrapper.getBoundingClientRect().bottom > cutoff) return i;
    }
    return 0;
  }

  // ── Language toggle ──
  langToggle.addEventListener('click', () => {
    KokoroEngine.stop();
    const newLang = KokoroEngine.currentLang === 'fr' ? 'en' : 'fr';
    KokoroEngine.setLang(newLang);
    const voices = VOICE_DEFS[newLang];
    if (voices?.length) KokoroEngine.setVoice(voices[0].id);
    updateLangButton();
    persistState(KokoroEngine.currentPageIdx);
  });

  function updateLangButton() {
    langToggle.textContent = KokoroEngine.currentLang.toUpperCase();
  }

  // ── Voice menu ──
  voiceMenuBtn.addEventListener('click', () => {
    populateVoiceMenu();
    voiceMenuOverlay.classList.add('visible');
  });

  voiceMenuOverlay.addEventListener('click', (e) => {
    if (e.target === voiceMenuOverlay) voiceMenuOverlay.classList.remove('visible');
  });

  function populateVoiceMenu() {
    voiceMenuList.innerHTML = '';

    const lang = KokoroEngine.currentLang;
    const voices = VOICE_DEFS[lang] || [];

    for (const v of voices) {
      const btn = document.createElement('button');
      const sel = KokoroEngine.currentVoiceId === v.id;
      btn.className = 'voice-option' + (sel ? ' selected' : '');
      btn.innerHTML = `
        <span class="check">${sel ? '✓' : ''}</span>
        <span class="voice-name">${v.label}</span>
        <span class="voice-tag">${v.gender} · AI</span>
      `;
      btn.addEventListener('click', () => {
        KokoroEngine.setVoice(v.id);
        populateVoiceMenu();
        persistState(KokoroEngine.currentPageIdx);
      });
      voiceMenuList.appendChild(btn);
    }

    // Download section
    const section = document.createElement('div');
    section.className = 'voice-download-section';

    if (KokoroEngine.isLoaded) {
      section.innerHTML = `<div class="voice-status-text">✓ AI voice model loaded</div>`;
    } else {
      const dlBtn = document.createElement('button');
      dlBtn.className = 'voice-download-btn';
      dlBtn.textContent = '⬇ Download AI Voice (~80 MB)';

      const info = document.createElement('div');
      info.className = 'voice-download-progress';
      info.textContent = 'One-time download, cached on your device';

      dlBtn.addEventListener('click', async () => {
        dlBtn.className = 'voice-download-btn downloading';
        dlBtn.textContent = 'Downloading…';
        info.textContent = 'Loading AI model files…';

        try {
          await KokoroEngine.loadModel((pct) => {
            info.textContent = `Downloading… ${pct}%`;
          });
          dlBtn.className = 'voice-download-btn done';
          dlBtn.textContent = '✓ Ready';
          info.textContent = 'AI voices loaded! Tap a page to start reading.';
        } catch (e) {
          dlBtn.className = 'voice-download-btn';
          dlBtn.textContent = '⬇ Retry Download';
          info.textContent = 'Failed — check your connection and try again.';
        }
      });

      section.appendChild(dlBtn);
      section.appendChild(info);
    }
    voiceMenuList.appendChild(section);
  }

  // ── Persistence ──
  function persistState(pageIdx) {
    Persistence.save({
      lang: KokoroEngine.currentLang,
      voiceId: KokoroEngine.currentVoiceId,
      speed: KokoroEngine.speed,
      fileKey: currentFileKey,
      pageIdx: pageIdx ?? 0,
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) persistState(KokoroEngine.currentPageIdx);
  });

  // Service Worker — only cache app shell, NOT CDN/model requests
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
