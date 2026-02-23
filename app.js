/* ============================================================
   Liseuse — app.js
   PDF Read-Aloud PWA: Core Application Logic
   
   Architecture:
   1. PDFManager  — loads PDF via PDF.js, renders pages, extracts text segments
   2. SpeechEngine — manages Web Speech API, chunking, iOS quirks
   3. UIController — wires DOM, controls, overlays, scroll behavior
   4. Persistence  — localStorage for settings + position
   ============================================================ */

// ── PDF.js configuration ──
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

// ── Constants ──
const MAX_UTTERANCE_LEN = 200;   // iOS Safari cutoff safety
const SCROLL_MARGIN = 120;        // px above highlight when auto-scrolling
const STORAGE_KEY = 'liseuse_state';

// ════════════════════════════════════════════════════════════
// 1. PDFManager
// ════════════════════════════════════════════════════════════
const PDFManager = (() => {
  let pdfDoc = null;
  let pages = [];       // { pageNum, canvas, wrapper, viewport }
  let segments = [];    // global list: { text, pageIdx, rect:{x,y,w,h}, el }
  let renderScale = 1;
  let containerWidth = 0;

  /**
   * Load a PDF from an ArrayBuffer, render all pages, extract segments.
   * Returns { segments, pageCount }
   */
  async function load(arrayBuffer) {
    const readerArea = document.getElementById('reader-area');
    readerArea.innerHTML = '';
    pages = [];
    segments = [];

    pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    containerWidth = readerArea.clientWidth - 32; // 16px margin each side

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      await renderPage(i, readerArea);
    }

    return { segments, pageCount: pdfDoc.numPages };
  }

  /**
   * Render a single page: canvas + transparent segment overlay.
   */
  async function renderPage(pageNum, container) {
    const page = await pdfDoc.getPage(pageNum);

    // Fit to width
    const unscaledVP = page.getViewport({ scale: 1 });
    renderScale = containerWidth / unscaledVP.width;
    const viewport = page.getViewport({ scale: renderScale });

    // Create wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.style.width = viewport.width + 'px';
    wrapper.style.height = viewport.height + 'px';
    wrapper.dataset.pageNum = pageNum;

    // Canvas
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    // Render at 2x for retina
    const outputScale = window.devicePixelRatio || 2;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    ctx.scale(outputScale, outputScale);

    wrapper.appendChild(canvas);
    container.appendChild(wrapper);

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Extract text and build segments
    const textContent = await page.getTextContent();
    const overlay = document.createElement('div');
    overlay.className = 'segment-overlay';
    wrapper.appendChild(overlay);

    const pageIdx = pages.length;
    pages.push({ pageNum, canvas, wrapper, viewport });

    buildSegments(textContent, viewport, overlay, pageIdx);
  }

  /**
   * Build tappable segment rectangles from PDF.js text items.
   * Groups items into line-ish segments by Y proximity.
   */
  function buildSegments(textContent, viewport, overlay, pageIdx) {
    const items = textContent.items.filter(it => it.str.trim().length > 0);
    if (items.length === 0) return;

    // Group by approximate Y line (within 4px tolerance)
    const lines = [];
    let currentLine = null;

    for (const item of items) {
      const tx = item.transform;
      // PDF text transform: [scaleX, skewX, skewY, scaleY, translateX, translateY]
      const pdfX = tx[4];
      const pdfY = tx[5];
      const fontSize = Math.abs(tx[3]) || Math.abs(tx[0]) || 12;

      // Convert PDF coords → viewport coords
      const [vx, vy] = pdfjsLib.Util.transform(viewport.transform, [pdfX, pdfY]);

      // Width estimate: PDF.js provides item.width in PDF units
      const scaledW = item.width * renderScale;
      const scaledH = fontSize * renderScale;

      if (!currentLine || Math.abs(vy - currentLine.y) > scaledH * 0.4) {
        // New line
        currentLine = {
          text: item.str,
          x: vx,
          y: vy - scaledH,
          w: scaledW,
          h: scaledH,
          items: [item]
        };
        lines.push(currentLine);
      } else {
        // Same line: extend
        currentLine.text += ' ' + item.str;
        const newRight = Math.max(currentLine.x + currentLine.w, vx + scaledW);
        currentLine.x = Math.min(currentLine.x, vx);
        currentLine.w = newRight - currentLine.x;
        currentLine.h = Math.max(currentLine.h, scaledH);
        currentLine.items.push(item);
      }
    }

    // Create segment DOM elements
    const vpW = viewport.width;
    const vpH = viewport.height;

    for (const line of lines) {
      if (line.text.trim().length === 0) continue;

      const segIdx = segments.length;

      const el = document.createElement('div');
      el.className = 'segment-rect';
      // Position as percentage for responsiveness
      el.style.left = ((line.x / vpW) * 100) + '%';
      el.style.top = ((line.y / vpH) * 100) + '%';
      el.style.width = ((line.w / vpW) * 100) + '%';
      el.style.height = ((line.h / vpH) * 100) + '%';
      el.dataset.segIdx = segIdx;

      overlay.appendChild(el);

      segments.push({
        text: line.text.trim(),
        pageIdx,
        rect: { x: line.x, y: line.y, w: line.w, h: line.h },
        el
      });
    }
  }

  function getSegments() { return segments; }
  function getPageCount() { return pdfDoc ? pdfDoc.numPages : 0; }
  function getPages() { return pages; }

  return { load, getSegments, getPageCount, getPages };
})();


// ════════════════════════════════════════════════════════════
// 2. SpeechEngine
// ════════════════════════════════════════════════════════════
const SpeechEngine = (() => {
  let voices = [];
  let currentLang = 'fr';      // 'fr' or 'en'
  let currentVoice = null;
  let rate = 1.0;
  let isPlaying = false;
  let isPaused = false;
  let currentSegIdx = 0;
  let onSegmentChange = null;  // callback(segIdx)
  let onStateChange = null;    // callback(isPlaying, isPaused)
  let onFinished = null;       // callback()
  let utteranceQueue = [];     // for chunked utterances
  let currentChunkIdx = 0;
  let chunkSegmentMap = [];    // maps chunk index → segment index

  // ── Voice loading ──
  function initVoices() {
    return new Promise((resolve) => {
      const loadVoices = () => {
        voices = speechSynthesis.getVoices();
        if (voices.length > 0) resolve(voices);
      };
      loadVoices();
      speechSynthesis.onvoiceschanged = () => {
        loadVoices();
        resolve(voices);
      };
      // Fallback timeout
      setTimeout(() => resolve(speechSynthesis.getVoices()), 2000);
    });
  }

  function getVoicesForLang(lang) {
    return voices.filter(v => v.lang.toLowerCase().startsWith(lang));
  }

  /**
   * Pick the "best" voice: prefer local, prefer Siri, else first match.
   */
  function pickBestVoice(lang) {
    const list = getVoicesForLang(lang);
    if (list.length === 0) return null;

    // Prefer local voices
    const local = list.filter(v => v.localService);
    const pool = local.length > 0 ? local : list;

    // Prefer Siri
    const siri = pool.find(v => v.name.toLowerCase().includes('siri'));
    if (siri) return siri;

    // Prefer "enhanced" or "premium"
    const enhanced = pool.find(v =>
      v.name.toLowerCase().includes('enhanced') ||
      v.name.toLowerCase().includes('premium')
    );
    if (enhanced) return enhanced;

    return pool[0];
  }

  function setLang(lang) {
    currentLang = lang;
    currentVoice = pickBestVoice(lang);
  }

  function setVoice(voice) {
    currentVoice = voice;
  }

  function setRate(r) {
    rate = r;
  }

  function setSegmentIndex(idx) {
    currentSegIdx = idx;
  }

  function getSegmentIndex() {
    return currentSegIdx;
  }

  // ── Chunking ──
  // Split text for iOS: max ~200 chars, prefer splitting on punctuation.
  function chunkText(text) {
    if (text.length <= MAX_UTTERANCE_LEN) return [text];

    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_UTTERANCE_LEN) {
        chunks.push(remaining);
        break;
      }

      // Find best split point
      let splitAt = MAX_UTTERANCE_LEN;
      const punctuation = ['. ', '! ', '? ', '; ', ', ', ' — ', ' – ', ': '];

      for (const p of punctuation) {
        const idx = remaining.lastIndexOf(p, MAX_UTTERANCE_LEN);
        if (idx > MAX_UTTERANCE_LEN * 0.3) {
          splitAt = idx + p.length;
          break;
        }
      }

      // Fallback: split on space
      if (splitAt === MAX_UTTERANCE_LEN) {
        const spaceIdx = remaining.lastIndexOf(' ', MAX_UTTERANCE_LEN);
        if (spaceIdx > MAX_UTTERANCE_LEN * 0.3) splitAt = spaceIdx + 1;
      }

      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }

    return chunks.filter(c => c.length > 0);
  }

  // ── Playback ──
  /**
   * Build the utterance queue from currentSegIdx onward.
   * Each segment may produce multiple chunks; we track the mapping.
   */
  function buildQueue(segments) {
    utteranceQueue = [];
    chunkSegmentMap = [];

    for (let i = currentSegIdx; i < segments.length; i++) {
      const chunks = chunkText(segments[i].text);
      for (const chunk of chunks) {
        utteranceQueue.push(chunk);
        chunkSegmentMap.push(i);
      }
    }
    currentChunkIdx = 0;
  }

  function speakNextChunk(segments) {
    if (currentChunkIdx >= utteranceQueue.length) {
      // Done
      isPlaying = false;
      isPaused = false;
      onStateChange?.(false, false);
      onFinished?.();
      return;
    }

    const text = utteranceQueue[currentChunkIdx];
    const segIdx = chunkSegmentMap[currentChunkIdx];

    // Update current segment and notify
    if (segIdx !== currentSegIdx) {
      currentSegIdx = segIdx;
    }
    onSegmentChange?.(currentSegIdx);

    const utt = new SpeechSynthesisUtterance(text);
    if (currentVoice) utt.voice = currentVoice;
    utt.lang = currentLang === 'fr' ? 'fr-FR' : 'en-US';
    utt.rate = rate;

    utt.onend = () => {
      currentChunkIdx++;
      // Update segIdx for next chunk
      if (currentChunkIdx < chunkSegmentMap.length) {
        currentSegIdx = chunkSegmentMap[currentChunkIdx];
      }
      if (isPlaying && !isPaused) {
        speakNextChunk(segments);
      }
    };

    utt.onerror = (e) => {
      // iOS sometimes fires 'interrupted' when cancelling; ignore
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      console.warn('Speech error:', e.error);
      // Try to continue
      currentChunkIdx++;
      if (isPlaying && !isPaused) {
        speakNextChunk(segments);
      }
    };

    speechSynthesis.speak(utt);
  }

  function play(segments) {
    if (isPaused) {
      // Resume
      isPaused = false;
      speechSynthesis.resume();
      onStateChange?.(true, false);
      return;
    }

    // Fresh play from currentSegIdx
    speechSynthesis.cancel();
    isPlaying = true;
    isPaused = false;
    buildQueue(segments);
    onStateChange?.(true, false);
    speakNextChunk(segments);
  }

  function pause() {
    if (!isPlaying) return;
    isPaused = true;
    speechSynthesis.pause();
    onStateChange?.(true, true);
  }

  function stop() {
    speechSynthesis.cancel();
    isPlaying = false;
    isPaused = false;
    // Keep currentSegIdx — don't reset!
    onStateChange?.(false, false);
  }

  /**
   * Restart from a specific segment (e.g., after speed change or tap).
   */
  function playFrom(segIdx, segments) {
    speechSynthesis.cancel();
    currentSegIdx = segIdx;
    isPlaying = true;
    isPaused = false;
    buildQueue(segments);
    onStateChange?.(true, false);
    speakNextChunk(segments);
  }

  return {
    initVoices,
    getVoicesForLang,
    pickBestVoice,
    setLang,
    setVoice,
    setRate,
    setSegmentIndex,
    getSegmentIndex,
    play,
    pause,
    stop,
    playFrom,
    get isPlaying() { return isPlaying; },
    get isPaused() { return isPaused; },
    get currentLang() { return currentLang; },
    get currentVoice() { return currentVoice; },
    get rate() { return rate; },
    set onSegmentChange(fn) { onSegmentChange = fn; },
    set onStateChange(fn) { onStateChange = fn; },
    set onFinished(fn) { onFinished = fn; },
  };
})();


// ════════════════════════════════════════════════════════════
// 3. Persistence
// ════════════════════════════════════════════════════════════
const Persistence = (() => {
  function save(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* quota exceeded — ignore */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function makeFileKey(file) {
    return file.name + '|' + file.size;
  }

  return { save, load, makeFileKey };
})();


// ════════════════════════════════════════════════════════════
// 4. UIController — Main Wiring
// ════════════════════════════════════════════════════════════
(async function UIController() {
  // ── DOM refs ──
  const welcomeScreen = document.getElementById('welcome-screen');
  const welcomeBtn = document.getElementById('welcome-import-btn');
  const fileInput = document.getElementById('file-input');
  const topImportBtn = document.getElementById('top-import-btn');
  const docTitle = document.getElementById('doc-title');
  const langToggle = document.getElementById('lang-toggle');
  const voiceMenuBtn = document.getElementById('voice-menu-btn');
  const voiceMenuOverlay = document.getElementById('voice-menu-overlay');
  const voiceMenuList = document.getElementById('voice-menu-list');
  const readerArea = document.getElementById('reader-area');
  const loadingOverlay = document.getElementById('loading-overlay');
  const playBtn = document.getElementById('play-btn');
  const stopBtn = document.getElementById('stop-btn');
  const speedSlider = document.getElementById('speed-slider');
  const speedDisplay = document.getElementById('speed-display');
  const progressInfo = document.getElementById('progress-info');

  let segments = [];
  let currentFileKey = null;
  let activeSegEl = null;

  // ── Initialize voices ──
  await SpeechEngine.initVoices();

  // ── Restore settings from persistence ──
  const saved = Persistence.load();
  if (saved) {
    if (saved.lang) SpeechEngine.setLang(saved.lang);
    if (saved.rate) {
      SpeechEngine.setRate(saved.rate);
      speedSlider.value = saved.rate;
    }
    if (saved.voiceNames && saved.voiceNames[SpeechEngine.currentLang]) {
      const vName = saved.voiceNames[SpeechEngine.currentLang];
      const match = SpeechEngine.getVoicesForLang(SpeechEngine.currentLang)
        .find(v => v.name === vName);
      if (match) SpeechEngine.setVoice(match);
    }
  } else {
    SpeechEngine.setLang('fr');
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
    // Show loading
    welcomeScreen.classList.add('hidden');
    loadingOverlay.classList.remove('hidden');
    docTitle.textContent = file.name.replace(/\.pdf$/i, '');

    try {
      const buffer = await file.arrayBuffer();
      const result = await PDFManager.load(buffer);
      segments = result.segments;

      currentFileKey = Persistence.makeFileKey(file);

      // Restore position if same file
      if (saved && saved.fileKey === currentFileKey && saved.segIdx != null) {
        SpeechEngine.setSegmentIndex(
          Math.min(saved.segIdx, segments.length - 1)
        );
      } else {
        SpeechEngine.setSegmentIndex(0);
      }

      // Attach tap handlers
      segments.forEach((seg, idx) => {
        seg.el.addEventListener('click', () => onSegmentTap(idx));
      });

      updateProgress();

      // Scroll to saved position
      const segIdx = SpeechEngine.getSegmentIndex();
      if (segIdx > 0 && segments[segIdx]) {
        setTimeout(() => scrollToSegment(segIdx, false), 300);
      }

    } catch (err) {
      console.error('PDF load error:', err);
      alert('Could not load PDF. Please try another file.');
      welcomeScreen.classList.remove('hidden');
    }

    loadingOverlay.classList.add('hidden');
    // Reset file input so same file can be re-imported
    fileInput.value = '';
  }

  // ── Segment Tap ──
  function onSegmentTap(idx) {
    SpeechEngine.playFrom(idx, segments);
  }

  // ── Speech callbacks ──
  SpeechEngine.onSegmentChange = (segIdx) => {
    highlightSegment(segIdx);
    updateProgress();
    scrollToSegment(segIdx, true);
    persistState();
  };

  SpeechEngine.onStateChange = (playing, paused) => {
    updatePlayButton(playing, paused);
  };

  SpeechEngine.onFinished = () => {
    clearHighlight();
  };

  // ── Highlight ──
  function highlightSegment(idx) {
    if (activeSegEl) activeSegEl.classList.remove('active');
    if (segments[idx]) {
      activeSegEl = segments[idx].el;
      activeSegEl.classList.add('active');
    }
  }

  function clearHighlight() {
    if (activeSegEl) {
      activeSegEl.classList.remove('active');
      activeSegEl = null;
    }
  }

  // ── Scroll ──
  function scrollToSegment(idx, smooth) {
    const seg = segments[idx];
    if (!seg) return;

    const el = seg.el;
    const wrapper = PDFManager.getPages()[seg.pageIdx]?.wrapper;
    if (!wrapper) return;

    // Get el position relative to reader area
    const elRect = el.getBoundingClientRect();
    const areaRect = readerArea.getBoundingClientRect();
    const elTopInArea = elRect.top - areaRect.top + readerArea.scrollTop;

    // Target: place segment ~1/3 from top
    const target = elTopInArea - readerArea.clientHeight / 3;

    if (smooth) {
      readerArea.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    } else {
      readerArea.scrollTop = Math.max(0, target);
    }
  }

  // ── Controls ──
  playBtn.addEventListener('click', () => {
    if (segments.length === 0) return;

    if (SpeechEngine.isPlaying && !SpeechEngine.isPaused) {
      SpeechEngine.pause();
    } else {
      SpeechEngine.play(segments);
    }
  });

  stopBtn.addEventListener('click', () => {
    SpeechEngine.stop();
    clearHighlight();
    persistState();
  });

  // Speed
  speedSlider.addEventListener('input', () => {
    const val = parseFloat(speedSlider.value);
    SpeechEngine.setRate(val);
    updateSpeedDisplay();

    // If playing, restart from current segment at new speed
    if (SpeechEngine.isPlaying) {
      SpeechEngine.playFrom(SpeechEngine.getSegmentIndex(), segments);
    }
    persistState();
  });

  function updateSpeedDisplay() {
    speedDisplay.textContent = SpeechEngine.rate.toFixed(1) + '×';
  }

  function updatePlayButton(playing, paused) {
    const svg = playBtn.querySelector('svg use') || playBtn.querySelector('svg');
    if (playing && !paused) {
      // Show pause icon
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`;
    } else {
      // Show play icon
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86A1 1 0 008 5.14z"/></svg>`;
    }
  }

  // ── Progress ──
  function updateProgress() {
    if (segments.length === 0) {
      progressInfo.textContent = '';
      return;
    }
    const idx = SpeechEngine.getSegmentIndex();
    const seg = segments[idx];
    const pageNum = seg ? PDFManager.getPages()[seg.pageIdx]?.pageNum : 1;
    const total = PDFManager.getPageCount();
    const pct = Math.round((idx / segments.length) * 100);
    progressInfo.textContent = `p.${pageNum}/${total} · ${pct}%`;
  }

  // ── Language Toggle ──
  langToggle.addEventListener('click', () => {
    const newLang = SpeechEngine.currentLang === 'fr' ? 'en' : 'fr';
    SpeechEngine.setLang(newLang);

    // Try to restore saved voice for this language
    const s = Persistence.load();
    if (s?.voiceNames?.[newLang]) {
      const match = SpeechEngine.getVoicesForLang(newLang)
        .find(v => v.name === s.voiceNames[newLang]);
      if (match) SpeechEngine.setVoice(match);
    }

    updateLangButton();

    // If playing, restart from current segment with new voice
    if (SpeechEngine.isPlaying) {
      SpeechEngine.playFrom(SpeechEngine.getSegmentIndex(), segments);
    }
    persistState();
  });

  function updateLangButton() {
    langToggle.textContent = SpeechEngine.currentLang.toUpperCase();
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
    const list = SpeechEngine.getVoicesForLang(SpeechEngine.currentLang);
    voiceMenuList.innerHTML = '';

    if (list.length === 0) {
      voiceMenuList.innerHTML = '<p style="padding:12px;color:var(--text-secondary);font-size:14px;">No voices found for this language.</p>';
      return;
    }

    // Sort: local first, then alphabetical
    const sorted = [...list].sort((a, b) => {
      if (a.localService !== b.localService) return a.localService ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const voice of sorted) {
      const btn = document.createElement('button');
      btn.className = 'voice-option' +
        (SpeechEngine.currentVoice?.name === voice.name ? ' selected' : '');

      const isLocal = voice.localService;
      btn.innerHTML = `
        <span class="check">${SpeechEngine.currentVoice?.name === voice.name ? '✓' : ''}</span>
        <span class="voice-name">${voice.name}</span>
        ${isLocal ? '<span class="voice-tag">Local</span>' : '<span class="voice-tag">Network</span>'}
      `;

      btn.addEventListener('click', () => {
        SpeechEngine.setVoice(voice);
        voiceMenuOverlay.classList.remove('visible');

        if (SpeechEngine.isPlaying) {
          SpeechEngine.playFrom(SpeechEngine.getSegmentIndex(), segments);
        }
        persistState();
      });

      voiceMenuList.appendChild(btn);
    }
  }

  // ── Persistence ──
  function persistState() {
    const s = Persistence.load() || {};
    const voiceNames = s.voiceNames || {};
    if (SpeechEngine.currentVoice) {
      voiceNames[SpeechEngine.currentLang] = SpeechEngine.currentVoice.name;
    }

    Persistence.save({
      lang: SpeechEngine.currentLang,
      rate: SpeechEngine.rate,
      voiceNames,
      fileKey: currentFileKey,
      segIdx: SpeechEngine.getSegmentIndex()
    });
  }

  // ── iOS Safari: keep speech alive ──
  // iOS pauses speech when the screen locks. We can't prevent it,
  // but we persist state so the user can resume.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      persistState();
    }
  });

  // ── Service Worker Registration ──
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err =>
      console.warn('SW registration failed:', err)
    );
  }

})();
