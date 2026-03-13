// Liseuse – PDF → text → Kokoro AI voice reader
// Uses PDF.js (CDN) + kokoro-js (in-browser neural TTS, Apache 2.0)

(() => {
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) { console.error('PDF.js not loaded'); return; }

  const openBtn = document.getElementById('open-btn');
  const emptyOpenBtn = document.getElementById('empty-open-btn');
  const fileInput = document.getElementById('file-input');
  const pagesContainer = document.getElementById('pages-container');
  const emptyState = document.getElementById('empty-state');
  const playPauseBtn = document.getElementById('play-pause-btn');
  const stopBtn = document.getElementById('stop-btn');
  const speedSlider = document.getElementById('speed-slider');
  const speedDisplay = document.getElementById('speed-display');
  const statusText = document.getElementById('status-text');

  const words = [];
  let currentWordIndex = null;

  let ttsInstance = null;
  let isModelLoaded = false;
  let isModelLoading = false;
  let currentAudio = null;
  let stopRequested = false;
  let isPaused = false;
  let isPlaying = false;
  let rate = 1.0;

  function resetState() {
    words.length = 0;
    currentWordIndex = null;
    clearActiveWord();
    pagesContainer.innerHTML = '';
    statusText.textContent = 'No document loaded';
    playPauseBtn.disabled = true;
    stopBtn.disabled = true;
  }

  openBtn.addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
  emptyOpenBtn.addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    resetState();
    statusText.textContent = 'Loading PDF…';
    emptyState.style.display = 'none';
    try {
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        renderPage(tc, i - 1);
      }
      statusText.textContent = 'Tap a word to start reading';
      playPauseBtn.disabled = false;
      stopBtn.disabled = false;
    } catch (err) {
      console.error('PDF load error', err);
      statusText.textContent = 'Could not load PDF';
      emptyState.style.display = 'flex';
    }
  });

  function renderPage(textContent, pageIndex) {
    const div = document.createElement('div');
    div.className = 'page';
    const frag = document.createDocumentFragment();

    textContent.items.forEach((item, idx) => {
      const str = item.str || '';
      if (!str.trim()) return;
      str.split(/(\s+)/).forEach((part) => {
        if (!part) return;
        if (/\s+/.test(part)) {
          frag.appendChild(document.createTextNode(part));
        } else {
          const span = document.createElement('span');
          span.textContent = part;
          span.className = 'word';
          const wi = words.length;
          words.push({ text: part, span, pageIndex });
          span.dataset.index = String(wi);
          span.addEventListener('click', () => onWordClick(wi));
          frag.appendChild(span);
        }
      });
      if (idx < textContent.items.length - 1) {
        frag.appendChild(document.createTextNode(' '));
      }
    });

    div.appendChild(frag);
    const label = document.createElement('div');
    label.className = 'page-number';
    label.textContent = `Page ${pageIndex + 1}`;
    div.appendChild(label);
    pagesContainer.appendChild(div);
  }

  function clearActiveWord() {
    const prev = pagesContainer.querySelector('.word.active');
    if (prev) prev.classList.remove('active');
  }

  function onWordClick(index) {
    if (!words[index]) return;
    currentWordIndex = index;
    clearActiveWord();
    words[index].span.classList.add('active');
    words[index].span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    startReadingFrom(index);
  }

  function collectText(startIndex, maxChars) {
    let out = '';
    for (let i = startIndex; i < words.length; i++) {
      const next = out ? out + ' ' + words[i].text : words[i].text;
      if (next.length > maxChars) break;
      out = next;
    }
    return out;
  }

  function splitSentences(text, maxLen) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let rest = text;
    while (rest.length > 0) {
      if (rest.length <= maxLen) { chunks.push(rest); break; }
      let cut = -1;
      for (const sep of ['. ', '! ', '? ', '; ']) {
        const idx = rest.lastIndexOf(sep, maxLen);
        if (idx > 30) { cut = idx + sep.length; break; }
      }
      if (cut < 0) {
        const sp = rest.lastIndexOf(' ', maxLen);
        cut = sp > 30 ? sp + 1 : maxLen;
      }
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    return chunks.filter(Boolean);
  }

  async function loadModel() {
    if (isModelLoaded) return true;
    if (isModelLoading) {
      while (isModelLoading) await new Promise(r => setTimeout(r, 200));
      return isModelLoaded;
    }
    isModelLoading = true;
    statusText.textContent = 'Downloading AI voice model (~86 MB, one-time)…';

    try {
      const { KokoroTTS } = await import('https://esm.sh/kokoro-js@1.2.1');

      // Try WebGPU first for speed, fall back to WASM
      let device = 'wasm';
      let dtype = 'q8';
      if (typeof navigator !== 'undefined' && navigator.gpu) {
        try {
          const adapter = await navigator.gpu.requestAdapter();
          if (adapter) { device = 'webgpu'; dtype = 'fp32'; }
        } catch (e) {}
      }

      statusText.textContent = `Loading AI voice (${device})…`;
      ttsInstance = await KokoroTTS.from_pretrained(
        'onnx-community/Kokoro-82M-v1.0-ONNX',
        { dtype, device }
      );
      isModelLoaded = true;
      statusText.textContent = 'AI voice ready';
      return true;
    } catch (e) {
      console.error('Kokoro load failed:', e);
      statusText.textContent = 'Failed to load AI voice: ' + e.message;
      return false;
    } finally {
      isModelLoading = false;
    }
  }

  function playBlob(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (currentAudio === audio) currentAudio = null;
        resolve('ended');
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        if (currentAudio === audio) currentAudio = null;
        resolve('error');
      };
      audio.play().catch(() => {
        URL.revokeObjectURL(url);
        if (currentAudio === audio) currentAudio = null;
        resolve('play-failed');
      });
    });
  }

  async function startReadingFrom(startIndex) {
    if (!words.length) return;
    if (startIndex == null || startIndex < 0) startIndex = 0;
    if (startIndex >= words.length) return;

    // Cancel any current playback
    doStop();
    stopRequested = false;
    isPlaying = true;
    currentWordIndex = startIndex;

    // Load the model (first time only)
    const ok = await loadModel();
    if (!ok || stopRequested) { isPlaying = false; return; }

    // Collect text from the tapped word onward, split into short sentences
    const text = collectText(startIndex, 2000);
    if (!text) { isPlaying = false; return; }

    const sentences = splitSentences(text, 150);
    playPauseBtn.textContent = '⏸';

    for (let i = 0; i < sentences.length; i++) {
      if (stopRequested) break;

      // Wait while paused
      while (isPaused && !stopRequested) {
        await new Promise(r => setTimeout(r, 150));
      }
      if (stopRequested) break;

      statusText.textContent = `Generating… (${i + 1}/${sentences.length})`;

      try {
        const result = await ttsInstance.generate(sentences[i], {
          voice: 'af_heart',
          speed: rate,
        });
        if (stopRequested) break;

        const blob = result.toBlob();
        statusText.textContent = `Reading… (${i + 1}/${sentences.length})`;
        const outcome = await playBlob(blob);
        if (stopRequested) break;
      } catch (e) {
        console.warn('TTS generate/play error:', e);
        statusText.textContent = 'Generation error, skipping…';
      }
    }

    isPlaying = false;
    if (!stopRequested) {
      playPauseBtn.textContent = '▶';
      statusText.textContent = 'Finished';
    }
  }

  function doStop() {
    stopRequested = true;
    isPaused = false;
    if (currentAudio) {
      try { currentAudio.pause(); currentAudio.currentTime = 0; } catch (e) {}
      currentAudio = null;
    }
    isPlaying = false;
    playPauseBtn.textContent = '▶';
    statusText.textContent = 'Stopped';
  }

  playPauseBtn.addEventListener('click', () => {
    if (!words.length) return;

    if (isPlaying && !isPaused) {
      isPaused = true;
      if (currentAudio) currentAudio.pause();
      playPauseBtn.textContent = '▶';
      statusText.textContent = 'Paused';
      return;
    }

    if (isPlaying && isPaused) {
      isPaused = false;
      if (currentAudio) currentAudio.play().catch(() => {});
      playPauseBtn.textContent = '⏸';
      statusText.textContent = 'Reading…';
      return;
    }

    const idx = currentWordIndex != null ? currentWordIndex : 0;
    startReadingFrom(idx);
  });

  stopBtn.addEventListener('click', doStop);

  speedSlider.addEventListener('input', () => {
    rate = parseFloat(speedSlider.value) || 1.0;
    speedDisplay.textContent = rate.toFixed(1) + '×';
  });
})();
