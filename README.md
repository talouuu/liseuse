# Liseuse — PDF Read-Aloud PWA

An Apple Books–inspired Progressive Web App that reads PDFs aloud using the Web Speech API. Fully client-side, installable on iPhone via "Add to Home Screen."

---

## A) Architecture

### Modules & Data Flow

```
┌──────────────────────────────────────────────────┐
│                  index.html                       │
│  (DOM structure, PDF.js CDN import, app.js load)  │
└──────────┬───────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────┐
│                   app.js                          │
│                                                   │
│  ┌─────────────┐   ┌──────────────┐              │
│  │ PDFManager   │   │ SpeechEngine │              │
│  │              │   │              │              │
│  │ • load(buf)  │──▶│ • play()     │              │
│  │ • render pg  │   │ • pause()    │              │
│  │ • extract    │   │ • stop()     │              │
│  │   segments   │   │ • playFrom() │              │
│  │ • build      │   │ • chunking   │              │
│  │   overlays   │   │ • iOS quirks │              │
│  └─────────────┘   └──────┬───────┘              │
│         │                  │                      │
│         ▼                  ▼                      │
│  ┌─────────────────────────────────┐             │
│  │         UIController            │             │
│  │  • DOM event wiring             │             │
│  │  • highlight/scroll             │             │
│  │  • voice menu                   │             │
│  │  • language toggle              │             │
│  └──────────┬──────────────────────┘             │
│             │                                     │
│             ▼                                     │
│  ┌─────────────────┐                             │
│  │   Persistence   │  localStorage               │
│  │  • speed, lang  │                             │
│  │  • voice prefs  │                             │
│  │  • file + pos   │                             │
│  └─────────────────┘                             │
└──────────────────────────────────────────────────┘

┌────────────┐   ┌──────────────┐
│ manifest.json │   │    sw.js      │  ← PWA shell
└────────────┘   └──────────────┘
```

### Data Flow

1. User taps "Open PDF" → `<input type="file">` opens iOS Files picker
2. File → `ArrayBuffer` → PDF.js `getDocument()`
3. Each page is rendered to a `<canvas>` at fit-to-width scale
4. Text items extracted via `getTextContent()`, grouped into line segments
5. Transparent `<div>` overlays positioned over each segment (tappable)
6. User taps Play → segments fed to `SpeechSynthesisUtterance` (chunked for iOS)
7. Current segment highlighted; reader area auto-scrolls
8. State persisted to `localStorage` on every segment change

---

## B) File Listing

| File            | Purpose                                    |
|-----------------|--------------------------------------------|
| `index.html`    | Main HTML shell, PDF.js CDN import         |
| `styles.css`    | Apple Books–inspired styling               |
| `app.js`        | Core logic (4 modules)                     |
| `manifest.json` | PWA manifest for installability            |
| `sw.js`         | Service worker (cache-first app shell)     |
| `README.md`     | This file                                  |

---

## C) PDF.js via CDN

This project uses PDF.js **4.4.168** from cdnjs:

```
https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs
https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs
```

**To bundle locally instead:**
1. Download both `.mjs` files
2. Place them in your project folder
3. Update the import in `index.html` and the `workerSrc` in `app.js`

---

## D) Running & Installing

### Run Locally (any computer)

You need a simple HTTPS or localhost server (file:// won't work for service workers).

**Option 1 — Python:**
```bash
cd /path/to/liseuse
python3 -m http.server 8080
# Open http://localhost:8080
```

**Option 2 — Node.js:**
```bash
npx serve .
# Open the URL shown
```

**Option 3 — PHP:**
```bash
php -S localhost:8080
```

### Add to Home Screen (iPhone)

1. Host the files on any HTTPS server (GitHub Pages, Netlify, Cloudflare Pages, etc.)
2. Open the URL in **Safari** on your iPhone
3. Tap the **Share** button (box with arrow)
4. Scroll down and tap **"Add to Home Screen"**
5. Tap **Add** — the app icon "L" appears on your Home Screen
6. Open it — it runs in standalone mode (no Safari chrome)

> **Note:** PWA "Add to Home Screen" only works from Safari, not Chrome/Firefox on iOS.

---

## E) Known iOS Limitations & Design Choices

### Speech

| Limitation | Our mitigation |
|---|---|
| iOS cuts off long utterances (~15–30s) | Chunk text to ≤200 chars, split on punctuation |
| `speechSynthesis.pause()/resume()` can be unreliable on iOS | We support it but if it fails, Stop + Play works |
| Voices load asynchronously (sometimes slowly) | We wait for `onvoiceschanged` with a 2s timeout fallback |
| iOS speech stops when screen locks | We persist position; user can resume after unlocking |
| First `speak()` must be user-initiated (gesture) | Play button is always user-triggered |
| No background audio for Web Speech API | Known platform limitation; not solvable client-side |

### PDF Rendering

| Choice | Reason |
|---|---|
| Fit-to-width, single scale | Avoids overlay coordinate drift at different zoom levels |
| Line-level segments (not word-level) | Larger tap targets, simpler mapping, more reliable |
| Canvas rendering (not text layer) | More predictable rendering; overlay divs handle interaction |
| 2× canvas resolution | Retina display support |

### PWA

| Item | Note |
|---|---|
| Can't auto-reopen files | iOS doesn't allow persistent file handles; we restore position by matching `file.name + file.size` |
| Service worker caches app shell | CDN resources (PDF.js) are network-first with cache fallback |
| `apple-mobile-web-app-capable` | Required for standalone mode on iOS |
| `viewport-fit=cover` + `env(safe-area-inset-*)` | Handles iPhone notch/Dynamic Island |

### General

- **No build tools required** — plain HTML/CSS/JS + CDN
- **No server backend** — everything runs in the browser
- **localStorage only** — no IndexedDB complexity (keeps it simple)
- The voice menu shows "Local" vs "Network" tags to help users pick voices that work offline
- Siri voices are preferred when available (best quality on iOS)
