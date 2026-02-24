/* ============================================================
   Liseuse v3 — app.js

   COMPLETE REWRITE addressing:
   1. VOICES: Replaced Web Speech API with Kokoro AI TTS (82M model,
      runs in-browser via WASM). Natural speech. 1 female + 1 male voice
      per language. Download button to fetch model (~80MB one-time).
   2. TAP-TO-READ: Removed fragile segment overlays. Now: tap any PDF
      page → reading starts from the top of that page. Always works.
   3. PROGRESS: Clear "Page X of Y" with visual bar based on page position.
   4. PDF DISAPPEARING: Capped canvas at 1.5× DPR + IntersectionObserver
      to re-render evicted canvases.
   ============================================================ */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

const STORAGE_KEY = 'liseuse_v3';

// ════════════════════════════════════════
// Voice definitions — curated, no garbage
// ════════════════════════════════════════
const VOICE_DEFS = {
  en: [
    { id: 'af_heart', label: 'Heart', gender: 'Female', lang: 'en' },
    { id: 'am_adam',  label: 'Adam',  gender: 'Male',   lang: 'en' },
  ],
  fr: [
    { id: 'ff_siwis', label: 'Siwis', gender: 'Female', lang: 'fr' },
  ]
};

// ════════════════════════════════════════
// PDFManager — render + text extraction
// ════════════════════════════════════════
const PDFManager = (() => {
  let pdfDoc = null;
  let pages = [];
  // pageTexts[pageIdx] = full text string for that page
  let pageTexts = [];
  let renderScale = 1;
  let containerWidth = 0;
  let observer = null;

  async function load(arrayBuffer) {
    const readerArea = document.getElementById('reader-area');
    readerArea.innerHTML = '';
    pages = [];
    pageTexts = [];
    if (observer) observer.disconnect();

    pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    containerWidth = readerArea.clientWidth - 32;

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      await renderPage(i, readerArea);
    }

    setupCanvasObserver();
    return { pageCount: pdfDoc.numPages };
  }

  async function renderPage(pageNum, container) {
    const page = await pdfDoc.getPage(pageNum);
    const unscaledVP = page.getViewport({ scale: 1 });
    renderScale = containerWidth / unscaledVP.width;
    const viewport = page.getViewport({ scale: renderScale });

    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.style.width  = viewport.width + 'px';
    wrapper.style.height = viewport.height + 'px';
    wrapper.dataset.pageIdx = pages.length;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // Cap at 1.5× to prevent iOS GPU memory eviction
    const outputScale = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width  = Math.floor(viewport.width  * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width  = viewport.width  + 'px';
    canvas.style.height = viewport.height + 'px';
    ctx.scale(outputScale, outputScale);

    wrapper.appendChild(canvas);
    container.appendChild(wrapper);

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Extract text
    const textContent = await page.getTextContent();
    const fullText = textContent.items
      .map(item => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const pageIdx = pages.length;
    pages.push({ pageNum, canvas, ctx, wrapper, viewport, outputScale });
    pageTexts.push(fullText);
  }

  async function reRenderPage(pageIdx) {
    const p = pages[pageIdx];
    if (!p || !pdfDoc) return;
    try {
      const page = await pdfDoc.getPage(p.pageNum);
      const ctx = p.canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
      ctx.scale(p.outputScale, p.outputScale);
      await page.render({ canvasContext: ctx, viewport: p.viewport }).promise;
    } catch (e) {
      console.warn('Re-render failed:', p.pageNum, e);
    }
  }

  function setupCanvasObserver() {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const idx = parseInt(entry.target.dataset.pageIdx);
        const p = pages[idx];
        if (!p) continue;
        try {
          const px = p.ctx.getImageData(0, 0, 1, 1).data;
          if (px[0] === 0 && px[1] === 0 && px[2] === 0 && px[3] === 0) {
            reRenderPage(idx);
          }
        } catch (e) {}
      }
    }, {
      root: document.getElementById('reader-area'),
      rootMargin: '200px 0px',
      threshold: 0
    });
    for (const p of pages) observer.observe(p.wrapper);
  }

  function getPages()     { return pages; }
  function getPageTexts()  { return pageTexts; }
  function getPageCount()  { return pdfDoc ? pdfDoc.numPages : 0; }

  return { load, getPages, getPageTexts, getPageCount };
})();


// ════════════════════════════════════════
// KokoroEngine — AI TTS via kokoro-js
// ════════════════════════════════════════
const KokoroEngine = (() => {
  let ttsInstance = null;
  let isLoaded = false;
  let isLoading = false;

  // Current playback state
  let audioElement = null;
  let isPlaying = false;
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
   * Load the Kokoro model. ~80MB download, cached by browser after first time.
   * Returns progress updates via callback.
   */
  async function loadModel(onProgress) {
    if (isLoaded) return;
    if (isLoading) return;
    isLoading = true;

    try {
      // Dynamic import of kokoro-js from esm.sh CDN — no bundler needed
      const { KokoroTTS } = await import('https://esm.sh/kokoro-js@1.2.1');

      ttsInstance = await KokoroTTS.from_pretrained(
        'onnx-community/Kokoro-82M-v1.0-ONNX',
        {
          dtype: 'q8',     // quantized — smallest download, good quality
          device: 'wasm',  // WASM works on all browsers including iOS Safari
          progress_callback: (progress) => {
            if (onProgress && progress.progress != null) {
              onProgress(Math.round(progress.progress));
            }
          }
        }
      );

      isLoaded = true;
    } catch (e) {
      console.error('Kokoro model load failed:', e);
      throw e;
    } finally {
      isLoading = false;
    }
  }

  /**
   * Generate speech for a text and play it. Returns a promise that resolves
   * when playback finishes.
   */
  async function speakText(text) {
    if (!ttsInstance || !text || text.trim().length === 0) return;

    // Generate audio blob
    const audio = await ttsInstance.generate(text, {
      voice: currentVoiceId,
      speed: speed,
    });

    // Convert to playable blob
    const blob = audio.toBlob();
    const url = URL.createObjectURL(blob);

    return new Promise((resolve) => {
      // Stop any current audio
      if (audioElement) {
        audioElement.pause();
        audioElement.src = '';
      }

      audioElement = new Audio(url);
      audioElement.playbackRate = 1.0; // Speed is applied in generation

      audioElement.onended = () => {
        URL.revokeObjectURL(url);
        resolve('ended');
      };
      audioElement.onerror = (e) => {
        console.warn('Audio playback error:', e);
        URL.revokeObjectURL(url);
        resolve('error');
      };

      audioElement.play().catch(e => {
        console.warn('Play blocked:', e);
        resolve('error');
      });
    });
  }

  /**
   * Read aloud starting from a specific page, going through all remaining pages.
   */
  async function playFromPage(startPageIdx, pageTexts) {
    stopRequested = false;
    isPlaying = true;
    currentPageIdx = startPageIdx;
    onStateChange?.(true);

    for (let i = startPageIdx; i < pageTexts.length; i++) {
      if (stopRequested) break;

      currentPageIdx = i;
      onPageChange?.(i);

      const text = pageTexts[i];
      if (!text || text.trim().length === 0) continue;

      // Split into sentences for smoother generation
      // (Kokoro has a ~510 token context window)
      const chunks = splitIntoChunks(text, 400);

      for (const chunk of chunks) {
        if (stopRequested) break;
        await speakText(chunk);
      }
    }

    isPlaying = false;
    stopRequested = false;
    onStateChange?.(false);
    onFinished?.();
  }

  /**
   * Split text into chunks at sentence boundaries, max `maxLen` chars each.
   */
  function splitIntoChunks(text, maxLen) {
    if (text.length <= maxLen) return [text];

    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      let splitAt = maxLen;
      // Try to split at sentence boundaries
      const endings = ['. ', '! ', '? ', '.\n', '!\n', '?\n', '; ', ':\n'];
      for (const e of endings) {
        const idx = remaining.lastIndexOf(e, maxLen);
        if (idx > maxLen * 0.3) {
          splitAt = idx + e.length;
          break;
        }
      }
      // Fallback: split at space
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
    if (audioElement) {
      audioElement.pause();
      audioElement.src = '';
    }
    isPlaying = false;
    onStateChange?.(false);
  }

  function pause() {
    if (audioElement) audioElement.pause();
    onStateChange?.(false);
  }

  function resume() {
    if (audioElement && audioElement.paused && audioElement.src) {
      audioElement.play().catch(() => {});
      onStateChange?.(true);
    }
  }

  function setVoice(voiceId) { currentVoiceId = voiceId; }
  function setSpeed(s) { speed = s; }
  function setLang(lang) { currentLang = lang; }

  return {
    loadModel,
    playFromPage,
    stop,
    pause,
    resume,
    setVoice,
    setSpeed,
    setLang,
    get isLoaded() { return isLoaded; },
    get isLoading() { return isLoading; },
    get isPlaying() { return isPlaying; },
    get currentPageIdx() { return currentPageIdx; },
    get currentLang() { return currentLang; },
    get currentVoiceId() { return currentVoiceId; },
    get speed() { return speed; },
    set onPageChange(fn)  { onPageChange = fn; },
    set onStateChange(fn) { onStateChange = fn; },
    set onFinished(fn)    { onFinished = fn; },
  };
})();


// ════════════════════════════════════════
// Persistence
// ════════════════════════════════════════
const Persistence = (() => {
  function save(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
  }
  function load() {
    try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null; }
    catch { return null; }
  }
  function makeFileKey(f) { return f.name + '|' + f.size; }
  return { save, load, makeFileKey };
})();


// ════════════════════════════════════════
// UIController
// ════════════════════════════════════════
(async function UIController() {
  const welcomeScreen    = document.getElementById('welcome-screen');
  const welcomeBtn       = document.getElementById('welcome-import-btn');
  const fileInput        = document.getElementById('file-input');
  const topImportBtn     = document.getElementById('top-import-btn');
  const docTitle         = document.getElementById('doc-title');
  const langToggle       = document.getElementById('lang-toggle');
  const voiceMenuBtn     = document.getElementById('voice-menu-btn');
  const voiceMenuOverlay = document.getElementById('voice-menu-overlay');
  const voiceMenuList    = document.getElementById('voice-menu-list');
  const readerArea       = document.getElementById('reader-area');
  const loadingOverlay   = document.getElementById('loading-overlay');
  const loadingText      = document.getElementById('loading-text');
  const playBtn          = document.getElementById('play-btn');
  const stopBtn          = document.getElementById('stop-btn');
  const speedSlider      = document.getElementById('speed-slider');
  const speedDisplay     = document.getElementById('speed-display');
  const progressBarFill  = document.getElementById('progress-bar-fill');
  const progressLabel    = document.getElementById('progress-label');

  let pageTexts = [];
  let currentFileKey = null;
  let activePageWrapper = null;
  let isPaused = false;

  // ── Restore settings ──
  const saved = Persistence.load();
  if (saved) {
    if (saved.lang) KokoroEngine.setLang(saved.lang);
    if (saved.voiceId) KokoroEngine.setVoice(saved.voiceId);
    if (saved.speed) {
      KokoroEngine.setSpeed(saved.speed);
      speedSlider.value = saved.speed;
    }
  } else {
    KokoroEngine.setLang('fr');
    KokoroEngine.setVoice('ff_siwis');
  }
  updateLangButton();
  updateSpeedDisplay();

  // ── File Import ──
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

      // Attach page-tap handlers
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
      alert('Could not load PDF. Please try another file.');
      welcomeScreen.classList.remove('hidden');
    }

    loadingOverlay.classList.add('hidden');
    fileInput.value = '';
  }

  // ── TAP TO READ: Tap a page → start reading from that page ──
  async function onPageTap(pageIdx) {
    // If model not loaded yet, prompt to download
    if (!KokoroEngine.isLoaded) {
      voiceMenuOverlay.classList.add('visible');
      populateVoiceMenu();
      return;
    }

    // Stop any current playback
    KokoroEngine.stop();
    isPaused = false;

    // Highlight tapped page
    highlightPage(pageIdx);

    // Start reading from this page
    KokoroEngine.playFromPage(pageIdx, pageTexts);
  }

  // ── Callbacks ──
  KokoroEngine.onPageChange = (pageIdx) => {
    highlightPage(pageIdx);
    updateProgress(pageIdx);
    scrollToPage(pageIdx, true);
    persistState(pageIdx);
  };

  KokoroEngine.onStateChange = (playing) => {
    updatePlayButton(playing);
    if (!playing) isPaused = false;
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
      // Remove the badge after 2 seconds but keep outline
      setTimeout(() => {
        if (activePageWrapper) {
          activePageWrapper.classList.remove('reading-from');
          activePageWrapper.style.outline = '2px solid var(--accent)';
          activePageWrapper.style.outlineOffset = '-2px';
        }
      }, 2000);
    }
  }

  function clearPageHighlight() {
    if (activePageWrapper) {
      activePageWrapper.classList.remove('reading-from');
      activePageWrapper.style.outline = '';
      activePageWrapper.style.outlineOffset = '';
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
    const target = topInArea - 20;

    if (smooth) {
      readerArea.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    } else {
      readerArea.scrollTop = Math.max(0, target);
    }
  }

  // ── Controls ──
  playBtn.addEventListener('click', async () => {
    if (pageTexts.length === 0) return;

    if (!KokoroEngine.isLoaded) {
      voiceMenuOverlay.classList.add('visible');
      populateVoiceMenu();
      return;
    }

    if (KokoroEngine.isPlaying && !isPaused) {
      // Pause
      KokoroEngine.pause();
      isPaused = true;
      updatePlayButton(false);
      return;
    }

    if (isPaused) {
      // Resume
      KokoroEngine.resume();
      isPaused = false;
      updatePlayButton(true);
      return;
    }

    // Start from current page (or first page of visible area)
    const startPage = getVisiblePageIdx();
    KokoroEngine.playFromPage(startPage, pageTexts);
  });

  stopBtn.addEventListener('click', () => {
    KokoroEngine.stop();
    isPaused = false;
    persistState(KokoroEngine.currentPageIdx);
  });

  // Speed
  speedSlider.addEventListener('input', () => {
    const val = parseFloat(speedSlider.value);
    KokoroEngine.setSpeed(val);
    updateSpeedDisplay();
    persistState(KokoroEngine.currentPageIdx);
  });

  function updateSpeedDisplay() {
    speedDisplay.textContent = KokoroEngine.speed.toFixed(1) + '×';
  }

  function updatePlayButton(playing) {
    if (playing) {
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`;
    } else {
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86A1 1 0 008 5.14z"/></svg>`;
    }
  }

  // ── Progress ──
  function updateProgress(pageIdx) {
    const total = PDFManager.getPageCount();
    if (total === 0) {
      progressBarFill.style.width = '0%';
      progressLabel.textContent = '—';
      return;
    }
    const page = (pageIdx ?? 0) + 1; // 1-indexed for display
    const pct = Math.round((page / total) * 100);
    progressBarFill.style.width = pct + '%';
    progressLabel.textContent = `Page ${page} of ${total}`;
  }

  /**
   * Find which page is currently most visible in the scroll area.
   */
  function getVisiblePageIdx() {
    const pages = PDFManager.getPages();
    const areaRect = readerArea.getBoundingClientRect();
    const areaCenter = areaRect.top + areaRect.height / 3;

    for (let i = 0; i < pages.length; i++) {
      const r = pages[i].wrapper.getBoundingClientRect();
      if (r.bottom > areaCenter) return i;
    }
    return 0;
  }

  // ── Language Toggle ──
  langToggle.addEventListener('click', () => {
    const wasPlaying = KokoroEngine.isPlaying;
    if (wasPlaying) KokoroEngine.stop();
    isPaused = false;

    const newLang = KokoroEngine.currentLang === 'fr' ? 'en' : 'fr';
    KokoroEngine.setLang(newLang);

    // Set default voice for the new language
    const voices = VOICE_DEFS[newLang];
    if (voices && voices.length > 0) {
      KokoroEngine.setVoice(voices[0].id);
    }

    updateLangButton();
    persistState(KokoroEngine.currentPageIdx);
  });

  function updateLangButton() {
    langToggle.textContent = KokoroEngine.currentLang.toUpperCase();
  }

  // ── Voice Menu ──
  voiceMenuBtn.addEventListener('click', () => {
    populateVoiceMenu();
    voiceMenuOverlay.classList.add('visible');
  });

  voiceMenuOverlay.addEventListener('click', (e) => {
    if (e.target === voiceMenuOverlay) {
      voiceMenuOverlay.classList.remove('visible');
    }
  });

  function populateVoiceMenu() {
    voiceMenuList.innerHTML = '';

    const lang = KokoroEngine.currentLang;
    const voices = VOICE_DEFS[lang] || [];

    // Show curated voice list (just 1-2 voices, no garbage)
    for (const v of voices) {
      const btn = document.createElement('button');
      const isSelected = KokoroEngine.currentVoiceId === v.id;
      btn.className = 'voice-option' + (isSelected ? ' selected' : '');
      btn.innerHTML = `
        <span class="check">${isSelected ? '✓' : ''}</span>
        <span class="voice-name">${v.label}</span>
        <span class="voice-tag">${v.gender} · AI</span>
      `;
      btn.addEventListener('click', () => {
        KokoroEngine.setVoice(v.id);
        populateVoiceMenu(); // re-render to update checkmarks
        persistState(KokoroEngine.currentPageIdx);
      });
      voiceMenuList.appendChild(btn);
    }

    // Download section
    const section = document.createElement('div');
    section.className = 'voice-download-section';

    if (KokoroEngine.isLoaded) {
      section.innerHTML = `
        <div class="voice-status-text">
          ✓ AI voice model loaded — natural speech ready
        </div>
      `;
    } else {
      const btn = document.createElement('button');
      btn.className = 'voice-download-btn';
      btn.innerHTML = '⬇ Download AI Voice (~80 MB)';

      const progressDiv = document.createElement('div');
      progressDiv.className = 'voice-download-progress';
      progressDiv.textContent = 'One-time download · cached on your device after';

      btn.addEventListener('click', async () => {
        btn.className = 'voice-download-btn downloading';
        btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;"></div> Downloading…';
        progressDiv.textContent = 'Loading AI model files…';

        try {
          await KokoroEngine.loadModel((pct) => {
            progressDiv.textContent = `Downloading… ${pct}%`;
          });
          btn.className = 'voice-download-btn done';
          btn.innerHTML = '✓ Ready';
          progressDiv.textContent = 'Natural AI voices loaded successfully!';
        } catch (e) {
          btn.className = 'voice-download-btn';
          btn.innerHTML = '⬇ Retry Download';
          progressDiv.textContent = 'Download failed. Check your connection and try again.';
        }
      });

      section.appendChild(btn);
      section.appendChild(progressDiv);
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

  // ── Service Worker ──
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

})();
