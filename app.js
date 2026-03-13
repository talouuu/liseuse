// Liseuse v2 – PDF → text → AI voice reader
// - Uses PDF.js from CDN (already loaded on window.pdfjsLib)
// - Uses kokoro-js (ONNX in browser) for natural AI TTS
// - Renders pages as text blocks; tap a word to start reading from there

(() => {
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) {
    console.error('PDF.js not loaded');
    return;
  }

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

  // Flattened list of all words with references to DOM spans
  const words = []; // { text, span, pageIndex }
  let currentWordIndex = null;

  // Kokoro TTS state
  let ttsInstance = null;
  let isModelLoaded = false;
  let isModelLoading = false;
  let audioCtx = null;
  let currentSource = null;
  let stopRequested = false;
  let isPaused = false;
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

  function openFilePicker() {
    fileInput.value = '';
    fileInput.click();
  }

  openBtn.addEventListener('click', openFilePicker);
  emptyOpenBtn.addEventListener('click', openFilePicker);

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    resetState();
    statusText.textContent = 'Loading PDF…';
    emptyState.style.display = 'none';

    try {
      const arrayBuffer = await file.arrayBuffer();
      await loadPdf(arrayBuffer);
      statusText.textContent = 'Tap a word to start reading';
      playPauseBtn.disabled = false;
      stopBtn.disabled = false;
    } catch (err) {
      console.error('Failed to load PDF', err);
      statusText.textContent = 'Could not load PDF';
      emptyState.style.display = 'flex';
    }
  });

  async function loadPdf(arrayBuffer) {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      renderPage(textContent, pageNum - 1);
    }
  }

  function renderPage(textContent, pageIndex) {
    const pageDiv = document.createElement('div');
    pageDiv.className = 'page';

    const frag = document.createDocumentFragment();

    textContent.items.forEach((item, itemIdx) => {
      const str = item.str || '';
      if (!str.trim()) return;

      const parts = str.split(/(\s+)/);
      parts.forEach((part) => {
        if (!part) return;
        if (/\s+/.test(part)) {
          frag.appendChild(document.createTextNode(part));
        } else {
          const span = document.createElement('span');
          span.textContent = part;
          span.className = 'word';
          const index = words.length;
          words.push({ text: part, span, pageIndex });
          span.dataset.index = String(index);
          span.addEventListener('click', () => {
            onWordClick(index);
          });
          frag.appendChild(span);
        }
      });

      // Try to keep item boundaries roughly as line breaks for readability
      if (itemIdx < textContent.items.length - 1) {
        frag.appendChild(document.createTextNode(' '));
      }
    });

    pageDiv.appendChild(frag);

    const pageNumLabel = document.createElement('div');
    pageNumLabel.className = 'page-number';
    pageNumLabel.textContent = `Page ${pageIndex + 1}`;
    pageDiv.appendChild(pageNumLabel);

    pagesContainer.appendChild(pageDiv);
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

    // Immediately start reading from this word with AI voice
    startReadingFrom(index);
  }

  function buildTextFromIndex(startIndex, maxChars = 8000) {
    let collected = '';
    for (let i = startIndex; i < words.length; i++) {
      const w = words[i];
      if (!w) continue;
      const candidate = collected ? collected + ' ' + w.text : w.text;
      if (candidate.length > maxChars) break;
      collected = candidate;
    }
    return collected;
  }

  function ensureAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  async function loadKokoroModel() {
    if (isModelLoaded || isModelLoading) return;
    isModelLoading = true;
    statusText.textContent = 'Downloading AI voice model…';
    try {
      const { KokoroTTS } = await import('https://esm.sh/kokoro-js@1.2.1');
      ttsInstance = await KokoroTTS.from_pretrained(
        'onnx-community/Kokoro-82M-v1.0-ONNX',
        { dtype: 'q8', device: 'wasm' }
      );
      isModelLoaded = true;
      statusText.textContent = 'AI voice ready. Tap a word.';
    } catch (e) {
      console.error('Kokoro load failed', e);
      statusText.textContent = 'Failed to load AI voice';
    } finally {
      isModelLoading = false;
    }
  }

  async function speakChunk(text) {
    if (!ttsInstance || !text || text.trim().length === 0) return;
    stopRequested = false;

    // Generate audio
    const result = await ttsInstance.generate(text, {
      voice: 'af_heart',
      speed: rate,
    });
    if (stopRequested) return;

    const blob = result.toBlob();
    const arrayBuf = await blob.arrayBuffer();
    if (stopRequested) return;

    const audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
    if (stopRequested) return;

    return new Promise((resolve) => {
      currentSource = audioCtx.createBufferSource();
      currentSource.buffer = audioBuffer;
      currentSource.connect(audioCtx.destination);
      currentSource.onended = () => {
        currentSource = null;
        resolve();
      };
      currentSource.start(0);
    });
  }

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
      const puncts = ['. ', '! ', '? ', '; ', ', '];
      for (const p of puncts) {
        const idx = remaining.lastIndexOf(p, maxLen);
        if (idx > maxLen * 0.3) {
          splitAt = idx + p.length;
          break;
        }
      }
      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }
    return chunks.filter(Boolean);
  }

  async function startReadingFrom(startIndex) {
    if (!words.length) return;
    if (startIndex == null || startIndex < 0 || startIndex >= words.length) {
      startIndex = 0;
    }
    currentWordIndex = startIndex;

    const text = buildTextFromIndex(startIndex, 8000);
    if (!text) return;

    ensureAudioContext();
    await loadKokoroModel();
    if (!isModelLoaded) return;

    isPaused = false;
    playPauseBtn.textContent = '⏸';
    statusText.textContent = 'Reading with AI voice…';

    const chunks = splitIntoChunks(text, 400);
    for (const chunk of chunks) {
      if (stopRequested) break;
      // Respect pause by polling
      while (isPaused && !stopRequested) {
        await new Promise(r => setTimeout(r, 150));
      }
      if (stopRequested) break;
      await speakChunk(chunk);
    }

    if (!stopRequested) {
      playPauseBtn.textContent = '▶';
      statusText.textContent = 'Finished';
    }
  }

  playPauseBtn.addEventListener('click', async () => {
    if (!words.length) return;

    // If currently playing, toggle pause
    if (currentSource && !isPaused) {
      isPaused = true;
      playPauseBtn.textContent = '▶';
      statusText.textContent = 'Paused';
      return;
    }

    // Resume
    if (currentSource && isPaused) {
      isPaused = false;
      playPauseBtn.textContent = '⏸';
      statusText.textContent = 'Reading…';
      return;
    }

    // Start fresh from last tapped word or from beginning
    const startIndex = currentWordIndex != null ? currentWordIndex : 0;
    stopRequested = false;
    await startReadingFrom(startIndex);
  });

  stopBtn.addEventListener('click', () => {
    stopRequested = true;
    if (currentSource) {
      try { currentSource.stop(); } catch (e) {}
      currentSource = null;
    }
    isPaused = false;
    playPauseBtn.textContent = '▶';
    statusText.textContent = 'Stopped';
  });

  speedSlider.addEventListener('input', () => {
    rate = parseFloat(speedSlider.value) || 1.0;
    speedDisplay.textContent = rate.toFixed(1) + '×';
  });
})();