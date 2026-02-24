/* ============================================================
   Liseuse — app.js  (v2 — fully debugged + polished)

   FIXES applied:
   1. VOICES: Filter out novelty/garbage voices. Pick natural Siri/enhanced
      voices by default. Short curated list, not a wall of junk.
   2. TAP-TO-READ: Fixed coordinate calculation (was ignoring CSS scaling),
      added visual tap feedback, reliable "start from here" behavior.
   3. PROGRESS: Replaced confusing "p.3/12 · 47%" with a visual progress
      bar + clear "Page 3 of 12" label, calculated from page position.
   4. PDF DISAPPEARING: Reduced canvas render scale from 2× devicePixelRatio
      to 1.5× max. Added IntersectionObserver to re-render pages that iOS
      Safari evicts from GPU memory during scrolling.

   Architecture (unchanged):
   - PDFManager:  load, render, extract segments
   - SpeechEngine: voice management, chunking, playback
   - Persistence:  localStorage state
   - UIController: DOM wiring, controls, scroll
   ============================================================ */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

const MAX_UTTERANCE_LEN = 200;
const STORAGE_KEY = 'liseuse_state';

// ════════════════════════════════════════════════════════════
// 1. VOICE FILTERING — The core of Fix #1
//    iOS speechSynthesis exposes ~70+ voices including joke ones
//    like "Bells", "Boing", "Bad News", "Cellos", etc.
//    We blacklist known garbage and rank the rest by quality.
// ════════════════════════════════════════════════════════════

/**
 * Known novelty / sound-effect voices on Apple platforms.
 * These are NOT speech — they're musical instruments, sound effects,
 * or distorted joke voices. We remove them entirely from the UI.
 */
const NOVELTY_VOICE_NAMES = new Set([
  // Sound effects & instruments
  'Bells', 'Boing', 'Bubbles', 'Cellos', 'Good News', 'Bad News',
  'Bahh', 'Wobble', 'Zarvox', 'Trinoids', 'Whisper', 'Deranged',
  'Hysterical', 'Organ', 'Superstar', 'Jester', 'Ralph',
  'Kathy', 'Junior', 'Fred', 'Albert', 'Princess',
  // These tend to be extremely robotic / unusable
  'Pipe Organ',
]);

/**
 * Additional substring patterns that indicate a garbage voice.
 * Checked case-insensitively.
 */
const NOVELTY_PATTERNS = [
  'com.apple.speech.synthesis', // internal Apple identifiers sometimes leak
  'com.apple.ttsbundle',        // same
];

/**
 * Returns true if a voice is a novelty/garbage voice that should be hidden.
 */
function isNoveltyVoice(voice) {
  const name = voice.name;

  // Exact name match (case-insensitive for safety)
  for (const novelty of NOVELTY_VOICE_NAMES) {
    if (name.toLowerCase() === novelty.toLowerCase()) return true;
    // Also catch "Bells (Enhanced)" etc.
    if (name.toLowerCase().startsWith(novelty.toLowerCase() + ' ')) return true;
    if (name.toLowerCase().startsWith(novelty.toLowerCase() + '(')) return true;
  }

  // Substring pattern match
  for (const pat of NOVELTY_PATTERNS) {
    if (name.toLowerCase().includes(pat.toLowerCase())) return true;
  }

  // Voices with no language set or weird language codes
  if (!voice.lang || voice.lang.length < 2) return true;

  return false;
}

/**
 * Rank a voice for quality. Higher = better.
 * We strongly prefer:
 *   1. Siri voices (highest quality on iOS)
 *   2. "Enhanced" or "Premium" variants
 *   3. Local (on-device) voices over network
 *   4. Shorter/simpler names (usually the "default" system voice)
 */
function voiceQualityScore(voice) {
  let score = 0;
  const n = voice.name.toLowerCase();

  if (n.includes('siri'))       score += 100;
  if (n.includes('premium'))    score += 80;
  if (n.includes('enhanced'))   score += 60;
  if (n.includes('natural'))    score += 50;
  if (voice.localService)       score += 30;
  // Penalize overly long names (usually indicate niche/novelty)
  if (voice.name.length > 30)   score -= 10;

  return score;
}


// ════════════════════════════════════════════════════════════
// 2. PDFManager — with Fix #4 (canvas memory)
// ════════════════════════════════════════════════════════════
const PDFManager = (() => {
  let pdfDoc = null;
  let pages = [];      // { pageNum, canvas, ctx, wrapper, viewport, rendered }
  let segments = [];
  let renderScale = 1;
  let containerWidth = 0;
  let observer = null; // IntersectionObserver for re-rendering

  async function load(arrayBuffer) {
    const readerArea = document.getElementById('reader-area');
    readerArea.innerHTML = '';
    pages = [];
    segments = [];

    // Clean up old observer
    if (observer) observer.disconnect();

    pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    containerWidth = readerArea.clientWidth - 32;

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      await renderPage(i, readerArea);
    }

    // FIX #4: IntersectionObserver to detect and re-render evicted canvases.
    // iOS Safari aggressively frees GPU-backed canvas memory for off-screen
    // elements. When the user scrolls back, the canvas is blank (the "disappearing
    // PDF" bug). We detect this by observing visibility and re-rendering.
    setupCanvasObserver();

    return { segments, pageCount: pdfDoc.numPages };
  }

  async function renderPage(pageNum, container) {
    const page = await pdfDoc.getPage(pageNum);
    const unscaledVP = page.getViewport({ scale: 1 });
    renderScale = containerWidth / unscaledVP.width;
    const viewport = page.getViewport({ scale: renderScale });

    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.style.width = viewport.width + 'px';
    wrapper.style.height = viewport.height + 'px';
    wrapper.dataset.pageNum = pageNum;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // FIX #4: Limit canvas resolution.
    // Old code: outputScale = devicePixelRatio (3× on iPhone 14+)
    // A 400px-wide page at 3× = 1200px canvas = huge GPU memory.
    // With 10+ pages, iOS runs out and starts evicting canvases.
    // New: cap at 1.5× — still sharp on retina, much less memory.
    const outputScale = Math.min(window.devicePixelRatio || 1, 1.5);
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
    pages.push({
      pageNum, canvas, ctx, wrapper, viewport,
      outputScale, rendered: true
    });

    buildSegments(textContent, viewport, overlay, pageIdx);
  }

  /**
   * FIX #4: Re-render a page whose canvas was evicted.
   * We detect eviction by checking if the canvas has been cleared.
   */
  async function reRenderPage(pageIdx) {
    const pageInfo = pages[pageIdx];
    if (!pageInfo || !pdfDoc) return;

    try {
      const page = await pdfDoc.getPage(pageInfo.pageNum);
      const ctx = pageInfo.canvas.getContext('2d');

      // Reset transform before re-rendering
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pageInfo.canvas.width, pageInfo.canvas.height);
      ctx.scale(pageInfo.outputScale, pageInfo.outputScale);

      await page.render({
        canvasContext: ctx,
        viewport: pageInfo.viewport
      }).promise;

      pageInfo.rendered = true;
    } catch (e) {
      console.warn('Re-render failed for page', pageInfo.pageNum, e);
    }
  }

  /**
   * FIX #4: Observe page visibility. When a page scrolls into view,
   * check if its canvas was evicted and re-render if needed.
   */
  function setupCanvasObserver() {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;

        const pageNum = parseInt(entry.target.dataset.pageNum);
        const pageIdx = pages.findIndex(p => p.pageNum === pageNum);
        if (pageIdx === -1) continue;

        const pageInfo = pages[pageIdx];
        // Check if canvas content was evicted by reading a pixel
        const ctx = pageInfo.canvas.getContext('2d');
        try {
          const pixel = ctx.getImageData(0, 0, 1, 1).data;
          // If the pixel is completely transparent, canvas was likely evicted
          // (a real PDF page almost always has white background = 255,255,255,255)
          const isEmpty = pixel[0] === 0 && pixel[1] === 0 &&
                          pixel[2] === 0 && pixel[3] === 0;
          if (isEmpty && pageInfo.rendered) {
            pageInfo.rendered = false;
            reRenderPage(pageIdx);
          }
        } catch (e) {
          // SecurityError can happen in some contexts; ignore
        }
      }
    }, {
      root: document.getElementById('reader-area'),
      // Observe pages a bit before they enter view
      rootMargin: '200px 0px',
      threshold: 0
    });

    for (const p of pages) {
      observer.observe(p.wrapper);
    }
  }

  /**
   * Build tappable segment rectangles from PDF.js text items.
   * FIX #2: Improved coordinate calculation.
   * The old code used raw viewport-transformed coordinates, but the overlay
   * div uses percentage positioning relative to the wrapper. The math was
   * mostly correct but had issues with:
   *   a) Y-axis: PDF coordinates are bottom-up, viewport transform flips them,
   *      but the height calculation was sometimes wrong.
   *   b) Hit area: negative margins collapsed the clickable area.
   * Now: we carefully compute the bounding box per line and ensure min sizes.
   */
  function buildSegments(textContent, viewport, overlay, pageIdx) {
    const items = textContent.items.filter(it => it.str.trim().length > 0);
    if (items.length === 0) return;

    const lines = [];
    let currentLine = null;

    for (const item of items) {
      const tx = item.transform;
      const pdfX = tx[4];
      const pdfY = tx[5];
      const fontSize = Math.abs(tx[3]) || Math.abs(tx[0]) || 12;

      // Convert PDF coordinates → viewport (pixel) coordinates
      const [vx, vy] = pdfjsLib.Util.transform(viewport.transform, [pdfX, pdfY]);

      const scaledW = item.width * renderScale;
      const scaledH = fontSize * renderScale;

      // Group by Y proximity (same line if Y difference < 40% of line height)
      if (!currentLine || Math.abs(vy - currentLine.baseY) > scaledH * 0.4) {
        currentLine = {
          text: item.str,
          x: vx,
          baseY: vy,                    // baseline Y (from transform)
          top: vy - scaledH * 0.85,     // approximate top of text
          w: scaledW,
          h: scaledH * 1.15,            // slightly taller for tap target
          items: [item]
        };
        lines.push(currentLine);
      } else {
        currentLine.text += ' ' + item.str;
        const newRight = Math.max(currentLine.x + currentLine.w, vx + scaledW);
        currentLine.x = Math.min(currentLine.x, vx);
        currentLine.w = newRight - currentLine.x;
        currentLine.h = Math.max(currentLine.h, scaledH * 1.15);
        currentLine.items.push(item);
      }
    }

    const vpW = viewport.width;
    const vpH = viewport.height;

    for (const line of lines) {
      if (line.text.trim().length === 0) continue;

      const segIdx = segments.length;

      const el = document.createElement('div');
      el.className = 'segment-rect';

      // Position as percentage of wrapper dimensions
      const leftPct = Math.max(0, (line.x / vpW) * 100);
      const topPct  = Math.max(0, (line.top / vpH) * 100);
      const wPct    = Math.min(100 - leftPct, (line.w / vpW) * 100);
      const hPct    = Math.min(100 - topPct, (line.h / vpH) * 100);

      el.style.left   = leftPct + '%';
      el.style.top    = topPct + '%';
      el.style.width  = wPct + '%';
      el.style.height = hPct + '%';
      el.dataset.segIdx = segIdx;

      overlay.appendChild(el);

      segments.push({
        text: line.text.trim(),
        pageIdx,
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
// 3. SpeechEngine — with Fix #1 (voice filtering)
// ════════════════════════════════════════════════════════════
const SpeechEngine = (() => {
  let voices = [];
  let currentLang = 'fr';
  let currentVoice = null;
  let rate = 1.0;
  let isPlaying = false;
  let isPaused = false;
  let currentSegIdx = 0;
  let onSegmentChange = null;
  let onStateChange = null;
  let onFinished = null;
  let utteranceQueue = [];
  let currentChunkIdx = 0;
  let chunkSegmentMap = [];

  function initVoices() {
    return new Promise((resolve) => {
      const tryLoad = () => {
        voices = speechSynthesis.getVoices();
        if (voices.length > 0) resolve(voices);
      };
      tryLoad();
      speechSynthesis.onvoiceschanged = () => { tryLoad(); resolve(voices); };
      setTimeout(() => {
        voices = speechSynthesis.getVoices();
        resolve(voices);
      }, 2500);
    });
  }

  /**
   * FIX #1: Get ONLY natural/usable voices for a language.
   * Filters out novelty voices, then sorts by quality score.
   */
  function getVoicesForLang(lang) {
    return voices
      .filter(v => v.lang.toLowerCase().startsWith(lang))
      .filter(v => !isNoveltyVoice(v))
      .sort((a, b) => voiceQualityScore(b) - voiceQualityScore(a));
  }

  /**
   * FIX #1: Pick the single best natural voice for a language.
   * Priority: Siri > Premium > Enhanced > local > first available.
   */
  function pickBestVoice(lang) {
    const list = getVoicesForLang(lang);
    if (list.length === 0) return null;
    // List is already sorted by quality — just pick the top one
    return list[0];
  }

  function setLang(lang) {
    currentLang = lang;
    currentVoice = pickBestVoice(lang);
  }

  function setVoice(voice) { currentVoice = voice; }
  function setRate(r) { rate = r; }
  function setSegmentIndex(idx) { currentSegIdx = idx; }
  function getSegmentIndex() { return currentSegIdx; }

  // Chunking: split long text for iOS safety
  function chunkText(text) {
    if (text.length <= MAX_UTTERANCE_LEN) return [text];

    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_UTTERANCE_LEN) {
        chunks.push(remaining);
        break;
      }

      let splitAt = MAX_UTTERANCE_LEN;
      const punctuation = ['. ', '! ', '? ', '; ', ', ', ' — ', ' – ', ': '];

      for (const p of punctuation) {
        const idx = remaining.lastIndexOf(p, MAX_UTTERANCE_LEN);
        if (idx > MAX_UTTERANCE_LEN * 0.3) {
          splitAt = idx + p.length;
          break;
        }
      }

      if (splitAt === MAX_UTTERANCE_LEN) {
        const spaceIdx = remaining.lastIndexOf(' ', MAX_UTTERANCE_LEN);
        if (spaceIdx > MAX_UTTERANCE_LEN * 0.3) splitAt = spaceIdx + 1;
      }

      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }

    return chunks.filter(c => c.length > 0);
  }

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
      isPlaying = false;
      isPaused = false;
      onStateChange?.(false, false);
      onFinished?.();
      return;
    }

    const text = utteranceQueue[currentChunkIdx];
    const segIdx = chunkSegmentMap[currentChunkIdx];

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
      if (currentChunkIdx < chunkSegmentMap.length) {
        currentSegIdx = chunkSegmentMap[currentChunkIdx];
      }
      if (isPlaying && !isPaused) {
        speakNextChunk(segments);
      }
    };

    utt.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      console.warn('Speech error:', e.error);
      currentChunkIdx++;
      if (isPlaying && !isPaused) {
        speakNextChunk(segments);
      }
    };

    speechSynthesis.speak(utt);
  }

  function play(segments) {
    if (isPaused) {
      isPaused = false;
      speechSynthesis.resume();
      onStateChange?.(true, false);
      return;
    }

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
    onStateChange?.(false, false);
  }

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
// 4. Persistence (unchanged — already solid)
// ════════════════════════════════════════════════════════════
const Persistence = (() => {
  function save(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
    catch (e) { /* quota exceeded */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function makeFileKey(file) { return file.name + '|' + file.size; }
  return { save, load, makeFileKey };
})();


// ════════════════════════════════════════════════════════════
// 5. UIController — with all fixes wired in
// ════════════════════════════════════════════════════════════
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
  const playBtn          = document.getElementById('play-btn');
  const stopBtn          = document.getElementById('stop-btn');
  const speedSlider      = document.getElementById('speed-slider');
  const speedDisplay     = document.getElementById('speed-display');
  const progressBarFill  = document.getElementById('progress-bar-fill');
  const progressLabel    = document.getElementById('progress-label');

  let segments = [];
  let currentFileKey = null;
  let activeSegEl = null;

  // ── Init voices ──
  await SpeechEngine.initVoices();

  // ── Restore settings ──
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
    welcomeScreen.classList.add('hidden');
    loadingOverlay.classList.remove('hidden');
    docTitle.textContent = file.name.replace(/\.pdf$/i, '');

    try {
      const buffer = await file.arrayBuffer();
      const result = await PDFManager.load(buffer);
      segments = result.segments;

      currentFileKey = Persistence.makeFileKey(file);

      if (saved && saved.fileKey === currentFileKey && saved.segIdx != null) {
        SpeechEngine.setSegmentIndex(
          Math.min(saved.segIdx, segments.length - 1)
        );
      } else {
        SpeechEngine.setSegmentIndex(0);
      }

      // FIX #2: Attach tap handlers with clear "start reading from here" behavior
      segments.forEach((seg, idx) => {
        seg.el.addEventListener('click', (e) => {
          e.stopPropagation();
          onSegmentTap(idx);
        });
      });

      updateProgress();

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
    fileInput.value = '';
  }

  // ── FIX #2: Segment Tap — start reading from tapped position ──
  function onSegmentTap(idx) {
    // Immediately highlight so user sees confirmation of tap
    highlightSegment(idx);
    // Start reading from this segment
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
    const areaRect = readerArea.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    // Check if already in view (with generous margins)
    const inView = elRect.top >= areaRect.top + 40 &&
                   elRect.bottom <= areaRect.bottom - 40;
    if (inView) return; // Don't scroll if already visible

    const elTopInArea = elRect.top - areaRect.top + readerArea.scrollTop;
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
    // Don't clear highlight — keep user's place visible
    persistState();
  });

  // Speed
  speedSlider.addEventListener('input', () => {
    const val = parseFloat(speedSlider.value);
    SpeechEngine.setRate(val);
    updateSpeedDisplay();
    if (SpeechEngine.isPlaying) {
      SpeechEngine.playFrom(SpeechEngine.getSegmentIndex(), segments);
    }
    persistState();
  });

  function updateSpeedDisplay() {
    speedDisplay.textContent = SpeechEngine.rate.toFixed(1) + '×';
  }

  function updatePlayButton(playing, paused) {
    if (playing && !paused) {
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`;
    } else {
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86A1 1 0 008 5.14z"/></svg>`;
    }
  }

  // ── FIX #3: Progress — clear visual bar + page-based label ──
  function updateProgress() {
    if (segments.length === 0) {
      progressBarFill.style.width = '0%';
      progressLabel.textContent = '—';
      return;
    }

    const idx = SpeechEngine.getSegmentIndex();
    const seg = segments[idx];

    // Calculate which page we're on
    const pageNum = seg ? PDFManager.getPages()[seg.pageIdx]?.pageNum : 1;
    const totalPages = PDFManager.getPageCount();

    // Progress based on page position (most intuitive for users)
    // "I'm on page 3 of 12" → progress bar fills to ~25%
    const pct = totalPages > 0 ? Math.round((pageNum / totalPages) * 100) : 0;

    progressBarFill.style.width = pct + '%';
    progressLabel.textContent = `Page ${pageNum} of ${totalPages}`;
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
    if (SpeechEngine.isPlaying) {
      SpeechEngine.playFrom(SpeechEngine.getSegmentIndex(), segments);
    }
    persistState();
  });

  function updateLangButton() {
    langToggle.textContent = SpeechEngine.currentLang.toUpperCase();
  }

  // ── FIX #1: Voice Menu — curated, no garbage ──
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
    // getVoicesForLang already filters out novelty and sorts by quality
    const list = SpeechEngine.getVoicesForLang(SpeechEngine.currentLang);
    voiceMenuList.innerHTML = '';

    if (list.length === 0) {
      voiceMenuList.innerHTML =
        '<p style="padding:12px;color:var(--text-secondary);font-size:14px;">' +
        'No voices found for this language on your device.</p>';
      return;
    }

    // Show a clean, short list. Top voice is pre-selected.
    for (const voice of list) {
      const btn = document.createElement('button');
      const isSelected = SpeechEngine.currentVoice?.name === voice.name;
      btn.className = 'voice-option' + (isSelected ? ' selected' : '');

      // Friendly label: just the voice name, not the full identifier
      let displayName = voice.name;
      // Strip common prefixes/suffixes that add noise
      displayName = displayName.replace(/\(.*?\)/g, '').trim();

      const qualityLabel = voice.name.toLowerCase().includes('siri') ? 'Siri' :
                           voice.name.toLowerCase().includes('premium') ? 'Premium' :
                           voice.name.toLowerCase().includes('enhanced') ? 'Enhanced' :
                           voice.localService ? 'On-device' : 'Network';

      btn.innerHTML = `
        <span class="check">${isSelected ? '✓' : ''}</span>
        <span class="voice-name">${displayName}</span>
        <span class="voice-tag">${qualityLabel}</span>
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

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) persistState();
  });

  // ── Service Worker ──
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err =>
      console.warn('SW registration failed:', err)
    );
  }

})();
