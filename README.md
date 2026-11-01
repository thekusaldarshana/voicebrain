# voicebrain (the recorder app)

Record a voice note. When you tap **Stop**, everything after that happens on its own: the note is saved on the device, then uploaded to your server, retried if the connection is bad, and finished even if you have closed the app.

It is a PWA (installable on Android, desktop and iPhone) built the same way as Trapper: Vite, React 19, TypeScript, the shared `tokens.css` design system, and a Tauri shell for desktop.

The other half is `server/`: it receives the uploads, transcribes them, extracts tasks and ideas, keeps a versioned markdown vault, and lets ChatGPT read it over MCP. See [`server/README.md`](server/README.md).

## What it does

**Recording**
- One big Record/Stop button, Pause/Resume, and **Mark** (bookmark a moment, `M` on a keyboard). `Space` starts and stops.
- Live level meter and `00:00:00` clock. Pause time is not counted.
- Audio is written to storage **every second**. If the tab dies, the phone restarts or the battery runs out, the next launch rebuilds the recording and uploads it (marked "recovered").
- Keeps the screen awake while recording, tells you if the system mutes the microphone, and stops cleanly if the microphone is unplugged.
- Quality (24–128 kbps Opus), microphone choice, noise suppression, auto gain, echo cancellation.
- Home-screen shortcut **Record a note** (`?record=1`) starts recording as soon as the app opens. An optional setting does it on every launch.

**Uploading**
- Starts the moment a note is saved. `POST {server}/v1/notes`, multipart (`meta` JSON + `audio`), bearer token, `Idempotency-Key` = note id, so retries never duplicate.
- Offline or server down: the note stays on the device and retries with exponential backoff (5 s up to 15 min, with jitter, honouring `Retry-After`). Coming back online retries immediately.
- **Closed app**: a service worker uploads waiting notes in the background when the browser reports a connection (Chromium on Android and desktop). Where Background Sync does not exist (iPhone, Firefox) uploads resume when you open the app.
- Wrong token or a rejected file stops retrying and asks for attention ("Needs attention"), then resumes by itself after you fix Settings.
- Only one uploader runs at a time (Web Locks), so the page and the service worker never double-send.

**Library**
- Notes grouped by day, search by title or tag, filters (All / Waiting / Uploaded / Needs attention).
- Every status is written out in words, never colour alone.
- Play back, jump to marked moments, rename, tag (renames and tags also update your server), download. **Remove from this device** has a 7-second Undo; **Delete everywhere** asks twice and erases the note from your server too. "Upload now" and "Retry" per note.
- **Import audio** adds existing recordings (m4a, mp3, wav, ogg, …) to the same queue.

**Settings**
- **Connect to voicebrain** is one tap: the app asks your server for a code, opens the server's approval page, and connects by itself after you type your passphrase there once. Nothing is copied or pasted, and each device gets its own token that can be revoked (**Disconnect this device** does it). Typing an address and token by hand is still there under *Advanced*, and so are pairing links.
- **Test connection**, auto-upload on/off, how long to keep audio on the device after upload (0 days to forever), storage use, "Keep my data" (persistent storage), install help.

**Works offline** from the first launch (the build output is precached).

## Run it

```bash
npm install
npm run dev                          # http://localhost:5173 (microphone works on localhost)

# the server to upload to, locally (Node 22.18+)
npm run server:install
INGEST_TOKEN=choose-a-long-random-token npm run receiver      # :8787, notes in server/data/inbox/<id>/
node server/src/main.ts pair --app https://voice.example.com --endpoint https://notes.example.com --token <token>
#   -> prints a link; open it on the phone and it configures itself
# production: docker compose up -d --build   (see server/README.md)
```

Production: `npm run build`, then serve `dist/` from any static host **over HTTPS** (browsers only allow the microphone on https or localhost). The build uses relative URLs, so it also works under a sub-path. Put the receiver behind HTTPS too (Caddy or nginx), or the phone cannot reach it from an https page.

The server stores each upload as `audio.<ext>` plus `meta.json` and runs it through transcription and digestion. Any server that follows the contract below works with the app.

### Upload contract (what any server must do)

| | |
|---|---|
| `GET /v1/ping` | `200` if the bearer token is valid (used by "Test connection") |
| `POST /v1/notes` | multipart: `meta` = JSON, `audio` = file; header `Idempotency-Key: <note id>` |
| `201` / `200` / `409` | stored (409 = already had it). The app treats all as done |
| `408 425 429 5xx`, network error | retried with backoff |
| other `4xx` | the note shows "Needs attention" |

`meta`: `id, createdAt (ISO), durationMs, mime, size, title, tags, marks (ms), recovered, source ("record"|"import"), device, timezone, utcOffsetMinutes, app`.

## Verify

```bash
npm test            # 38 app tests: formatting, upload rules, service-worker parity, connecting a device, server calls
npm run server:test # 155 backend tests: pipeline, search, vault, delete, edits, pairing, OAuth, MCP, providers
npm run lint
npm run build && npm run test:e2e
```

`test:e2e` drives the built app in real Chromium with a fake microphone against the real backend, in 20 steps: pairing link, record, mark, pause, auto-upload, offline, server outage, wrong token, remove from this device with Undo, crash recovery, import, offline launch, upload by the service worker with every tab closed, **one-tap connect (a wrong passphrase refused first, then approved)**, upload with the device's own token, **rename reaching the server**, **delete everywhere (two taps)**, **disconnecting a device**, layout at 320 px and accessible button names. Screenshots go to `artifacts/e2e/`.

No browser installed (a server, say)? Run it in Playwright's image: `docker run --rm --ipc=host -v "$PWD":/work -w /work -e CHROMIUM_PATH=/ms-playwright/chromium-1248/chrome-linux64/chrome mcr.microsoft.com/playwright:v1.64.1-noble node scripts/e2e.mjs` (the Chromium folder name changes with the Playwright version).

## Desktop and Android with Tauri

`src-tauri/` mirrors Trapper's setup (`npm run tauri dev`, `npm run tauri build`). **It has not been compiled or run yet**, because the machine this was built on lacks the Linux WebKit libraries. Two known gaps before it is useful:
- Desktop Linux (WebKitGTK) and Android (WebView) do not grant `getUserMedia` on their own. Each needs a few lines of native permission handling.
- A custom `tauri://` origin cannot register service workers, so background upload does not apply there.

The PWA is the supported way to run this today. If the phone needs recording with the screen off, or a Stop button in the notification shade, that needs a native recorder (Expo or Kotlin). The queue, protocol and receiver here carry over unchanged.

## Design

Colours, type, spacing and states come from Trapper's `src/styles/tokens.css` (copied verbatim) and `design.md`. See `design.md` here for the few Voice-specific decisions.
