# voicebrain server

Receives voice notes from the recorder app, turns them into a searchable, versioned knowledge base, and lets an assistant (ChatGPT, over MCP) read and extend it.

```
recorder app ──upload──▶  storage   audio + meta  (inbox/<id>/ on local disk)  (never edited)
                              │ transcribe   (Whisper, on this machine)
                              ▼
                          transcript.json                   (the permanent record)
                              │ digest       (language model: tasks, ideas, people, projects)
                              ▼
                          digest.json                       (regenerable)
                              │ file
                              ▼
   vault/  (git)   notes/ daily/ projects/ people/ tasks.md   generated, one file per note
                   wiki/                                      yours and the assistant's
   index.sqlite    full-text search + tasks                   disposable, rebuilt from the files
                              ▲
ChatGPT ◀──MCP over HTTPS──── brief · search · recent · get_note · open_loops · update_task · add_note · wiki
```

**The rule that makes this last:** audio and word-for-word transcripts are the asset. Everything else (the digest, the vault pages, the index) can be regenerated from them, so a better model in five years can rebuild the whole knowledge base.

## Honesty built in
- Every task, idea and decision carries the exact words it came from. The server checks those words against the transcript; items it cannot match are **dropped and counted** in the note ("2 extracted items left out because they could not be matched to spoken words"). A model cannot invent a task that never got said.
- If the recognizer returns only filler (Whisper often invents "Thank you." over silence), the note is flagged "Possibly no speech" instead of being summarized.
- If the language model is down, notes are still transcribed, filed and searchable. They are digested later.

## Run it on the VPS

Needs Docker with the compose plugin. If the machine already runs other services, read `deploy/AGENT_HANDOFF.md`: it deploys in stages and checks at each one that nothing else was disturbed.

```bash
git clone https://github.com/thekusaldarshana/voicebrain && cd voicebrain
cp .env.example .env && nano .env          # see the comments in the file
mkdir data && chown 1000:1000 data         # the user the container runs as (PUID / PGID in .env to change)
docker compose up -d --build
curl http://127.0.0.1:18787/health         # {"ok":true}   (host port 18787; set VOICEBRAIN_PORT to change it)
docker compose logs -f stt                 # the first start downloads the Whisper model (about 1.6 GB)
docker compose logs -f voicebrain          # shows what is configured and what is missing
```

The stack is isolated on purpose: its own compose project, network and volumes, one host port bound to `127.0.0.1`, and hard CPU and memory limits on the Whisper container (important on a machine without swap, where one runaway process makes the kernel kill something else). `docker compose down` removes it without touching anything else; add `-v` only if you also want the downloaded models gone (`./data` is never removed by compose).

**Public HTTPS.** Point a DNS A record at the server, then add the block from `Caddyfile.example` to the Caddyfile you already run and **reload** (never restart) Caddy:

- Caddy as a system service: `sudo systemctl reload caddy`.
- Caddy in Docker: `docker exec caddy caddy validate --config /etc/caddy/Caddyfile`, then `docker exec caddy caddy reload --config /etc/caddy/Caddyfile`. The upstream `127.0.0.1:18787` only works if that container uses host networking (`docker inspect caddy --format '{{.HostConfig.NetworkMode}}'` prints `host`); otherwise it needs a shared network or the host's address. Back up the Caddyfile first.

Check `https://brain.example.com/health`.

Connect the phone (or a computer): open the app, tap **Connect to voicebrain**. The app asks the server for a code, opens the server's approval page by itself, and waits. Sign in with Google there (once per browser) and tap Approve; the app connects on its own and keeps its own revocable token. Nothing is copied, pasted or sent in a link. It needs Google sign-in (see *Sign-in*) and `PUBLIC_URL` to be set. To add a second device from one that is already connected, the connected app can ask for a short code (8 characters, good for 2 minutes, once) and the new device types it in: `POST /v1/pair/offer` makes the code, `POST /v1/pair/claim` redeems it. For a server without them, or for scripts, the older way still works: `docker compose exec voicebrain node src/main.ts pair --app https://<your-app> --endpoint https://brain.example.com` prints a link that carries the upload token.

Transcription runs on the VPS itself (the `stt` container, faster-whisper), so audio never leaves it and there is no per-minute cost. Gemini (or any model server) is used only for the document work: turning transcripts into tasks, ideas and summaries.

## Sign-in with Google

There is no owner passphrase to remember: who you are comes from Google, and devices are added with short codes.

1. In Google Cloud Console, create an OAuth client of type **Web application**. Add the authorized redirect URI `https://brain.example.com/auth/google/callback` (your `PUBLIC_URL` plus `/auth/google/callback`). The consent screen needs only the `openid`, `email` and `profile` scopes.
2. In `.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `ALLOWED_EMAILS=you@example.com`. Restart. The startup log says `on  sign-in with Google`.
3. The first time you approve a device or ChatGPT, you are sent to Google and back. Your browser then stays signed in for 14 days.

Already running with `OWNER_PASSPHRASE`? Nothing breaks: while `GOOGLE_CLIENT_ID` is empty the passphrase works exactly as before. Once Google is set, the passphrase is ignored. Devices and ChatGPT connections made before the switch keep working and belong to an internal `owner` identity, as do `INGEST_TOKEN` and `MCP_TOKEN`.

## Connect ChatGPT

1. In `.env` set `PUBLIC_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `ALLOWED_EMAILS` (see *Sign-in*), then `docker compose up -d`.
2. In ChatGPT, turn on Developer mode and add a custom MCP server. The menu names move around, so look for "Developer mode" / "custom connector". The URL is `https://brain.example.com/mcp`. Choose OAuth.
3. ChatGPT opens your server, which sends you to Google to sign in, then shows an approval page naming who is asking. Tap Approve. You do this once; the connection then refreshes itself for 90 days at a time.
4. Add this to ChatGPT's custom instructions so it uses the tools without being asked: *"I keep a personal knowledge base of my own voice notes. At the start of any task, plan or decision, call `brief` with the topic and mention anything relevant I said before, with the date. Before saying you cannot remember something about me, call `search`."*

Other clients (Claude Desktop, Cursor) can use the same `/mcp` URL with `MCP_TOKEN` as a bearer token.

**After updating the server, refresh the app in ChatGPT's settings** so it picks up changed tools and descriptions.

**About permission prompts.** According to OpenAI's documentation, ChatGPT asks you to confirm *write* actions by default, honors a tool's `readOnlyHint`, and treats any tool without that hint as a write. A remembered choice lasts for one conversation only. Every voicebrain tool now declares all of its hints, truthfully: the seven that only read are marked read-only and should never prompt; `add_note`, `update_task`, `rename_note` and `write_wiki` change data, so ChatGPT will ask before using them. That confirmation belongs to ChatGPT and cannot be turned off from the server. It is also what protects your notes from a note that contains hostile instructions, so the tools are deliberately **not** mislabeled as read-only to avoid it. If a read tool still prompts, that is worth reporting along with the exact wording.

## The tools

| Tool | What it does |
|---|---|
| `brief(topic)` | **Call first.** What you said about this, related open tasks, people and projects on record, wiki pages. Empty topic: what is overdue and recent |
| `search(query)` | Full-text search over notes and wiki |
| `recent(days)` | Latest notes with summaries |
| `get_note(note)` | The full note: tasks with their source quotes, marked moments, transcript. Say which note by title |
| `open_loops(project?)` | Tasks not done yet, soonest due first. With no project it lists every task |
| `update_task(task, status)` | Mark done, dismissed or open; say which task in your words ("call the bank") |
| `rename_note(note, title)` | Give a vague note a clear title. Never overrides a title you chose yourself |
| `add_note(text)` | Save something you told the assistant to remember |
| `list_wiki`, `read_wiki`, `write_wiki` | The assistant's own pages (weekly reviews, project and person summaries). Only `wiki/` is writable |

**Notes are named for people.** Tools show titles and friendly dates ("“Interview Preparation Plan”, Fri 30 Oct, 09:12"); the short reference code is there only so tools can be called precisely, and the server tells ChatGPT never to show it. Every tool also accepts a title, or part of one, and asks which note you mean if two match. A note's name is, in order: the title you typed, a title the assistant gave it, the title the language model wrote.

Ask ChatGPT "run my weekly review" and it can read the week's notes and write `wiki/review.md`, using your subscription for the heavy thinking.

## What the recorder app calls

| | |
|---|---|
| `POST /v1/pair/start`, `POST /v1/pair/poll` | Adding a device. No token yet; approval needs a Google sign-in on `GET /pair` |
| `POST /v1/pair/claim` | A new device redeems the code a connected app is showing. No token yet; wrong codes are throttled |
| `POST /v1/pair/offer`, `GET /v1/pair/offer/:id` | A connected app asks for a code to show (and whether it was used) |
| `GET /auth/google/start`, `GET /auth/google/callback`, `POST /auth/logout` | Google sign-in for the pages on this server |
| `POST /v1/notes` | Upload a recording |
| `PATCH /v1/notes/:id` | Rename or re-tag an uploaded note. The user's title wins over the model's |
| `DELETE /v1/notes/:id` | Delete for good: audio, transcript, digest, vault page, search entries, tasks |
| `GET /v1/me`, `GET /v1/devices`, `DELETE /v1/devices/:id` | Who this device is; connected devices; disconnect one (a device can disconnect only itself) |
| `GET /v1/ping`, `GET /v1/status` | Check the connection; what the pipeline is doing |

Each device gets its own token (`vbd_…`, stored on the server only as a hash) and belongs to the person who approved it (`GET /v1/me` shows `userId`). The original `INGEST_TOKEN` still works and counts as the owner's. Device tokens can upload, rename and delete notes; they cannot read note content and cannot open the assistant endpoint.

**What "delete" removes.** The note and everything derived from it, on the server. Not removed: copies the assistant wrote into `wiki/` (it may have quoted the note), anything already sent to the language model or ChatGPT, and any backup you made. Generated vault pages are kept out of git so that deleting a note leaves no copy in the version history; only `wiki/` and `state/` are versioned.

## Who can read your notes

"Private" depends on who runs the machine, so exactly:

- **On a server your team can log in to, the team can read everything.** An administrator, or anyone in the `docker` group (which is root-equivalent), can open every recording and transcript. Nothing in this software prevents that, because the server has to read your audio to transcribe it and your transcripts to answer ChatGPT. The tokens, the passphrase and HTTPS protect against outsiders, not against whoever administers the server.
- **Third parties see text.** Transcripts go to the language model you configure (Gemini, for now) and, when ChatGPT reads your notes, to OpenAI. Audio stays on the server.

If a person needs their notes to be reachable by nobody else, in order of strength:

1. **Their own host.** Run that person's voicebrain on a machine only they administer: their own small VPS, a home server, or an account the team has no access to. This is the only option that truly answers the question, and one-tap connecting makes pointing the app at it easy.
2. **Originals in their own Google Drive** (not built). The app would send the original audio to their Drive (the `drive.file` scope, which only sees files the app creates) as well as for transcription, and the server would drop the audio after transcribing. Administrators could still read the transcripts.
3. **Encryption at rest with a key only they hold** (not built). It protects disks, backups and casual browsing, but not an administrator who is willing to read the running server's memory.

The sensible combination is 1 plus an encrypted copy of the originals in their Drive as a backup. Until then, treat a shared server as suitable for test data.

## Local Whisper

`whisper/` is a small server (about 70 lines) around [faster-whisper](https://github.com/SYSTRAN/faster-whisper) with the OpenAI transcription API shape, so the voicebrain server treats it like any other transcription service. It decodes WebM/Opus, MP4/AAC, Ogg and WAV, skips silence instead of inventing words over it, returns timed segments (so marked moments show the words spoken there), and handles one recording at a time.

Measured here on 4 shared vCPUs with int8 (your 8 vCPUs should be faster). The test audio is one spoken note (55 words) degraded four ways: a noisy room, a phone call (8 kHz, 10 kbps), a far-away microphone with echo, and a phone call in traffic. Word errors against the script:

| Model | Memory | Clean | Echo | Noisy room | Phone call | **Phone in traffic** | Speed |
|---|---|---|---|---|---|---|---|
| `small.en` | ~1 GB | 0% | 0% | 0% | 0% | **28%** | 3.3x realtime |
| `distil-large-v3` | ~2 GB | 2% | 5% | 2% | 2% | **20%** | 3.2x |
| `large-v3-turbo` (default) | ~3 GB | 0% | 0% | 0% | 0% | **14%** | 2.9x |
| `large-v3` | ~4 GB | 2% | 2% | 2% | 2% | **12%** | 1.0x |

Read it carefully: this is one synthetic voice and 55 words, so a single word is about 2%. The differences between 0% and 2% are noise. What is real is the last column: on bad audio the larger models are clearly better, and `large-v3-turbo` gets nearly all of `large-v3`'s accuracy at about three times the speed. That is why it is the default. `large-v3` is the choice if you only care about accuracy and can wait: a 10-minute note takes about 10 minutes on 4 shared vCPUs. Your own voice, microphone and rooms are the real test.

**Names are the weak spot.** Whisper guesses at names it has not seen. `STT_PROMPT=Nimal, Trapper, voicebrain` fixed "Nemo" to "Nimal" in testing. Add the names and terms you use.

Check it is alive: `docker compose exec stt python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/health').read())"`.

## Configuration

| Variable | |
|---|---|
| `INGEST_TOKEN` | **Required.** 16+ characters. The recorder app's bearer token |
| `PUBLIC_URL` | The public https address. Required for sign-in and for ChatGPT |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Turn on Google sign-in (both or neither) |
| `ALLOWED_EMAILS` | Comma-separated Google emails that may sign in. Empty: the first person to sign in claims the server |
| `OWNER_PASSPHRASE` | **Legacy.** Only used while Google sign-in is not configured. 12+ characters |
| `MCP_TOKEN` | Optional fixed bearer token for clients without OAuth |
| `OWNER_TIMEZONE` | IANA zone for "today" and "overdue" (default UTC) |
| `STT_PROVIDER`, `STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL`, `STT_LANGUAGE`, `STT_PROMPT`, `STT_MAX_MB` | `gemini` (Google's API) or any OpenAI-compatible `/audio/transcriptions` server. `*_API_KEY` may list several keys, comma separated |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_MAX_INPUT_CHARS` | Any OpenAI-compatible `/chat/completions` server |
| `ALLOWED_ORIGIN` | CORS origin for the recorder app (default `*`) |
| `STORAGE_BACKEND`, `DRIVE_RETAIN_AUDIO` | Where the notes (audio, transcripts, digests) are kept: `local` (default, files under `DATA_DIR/inbox/`) or `drive` (each user's own Google Drive). `DRIVE_RETAIN_AUDIO` is `keep` (default) or `drop-after-digest`. See *Storage* below |
| `DATA_DIR`, `PORT`, `HOST`, `MAX_UPLOAD_MB`, `MAX_ATTEMPTS`, `GIT`, `WORKER`, `REINDEX` | Defaults are fine |

Without `STT_BASE_URL` or `LLM_BASE_URL` the server still accepts and stores notes; `GET /v1/status` (and the startup log) says what is missing.

## Backups

Everything lives in `data/`:
- `data/inbox/` audio, transcripts, digests. **The irreplaceable part.** Back this up.
- `data/vault/` is a git repository. Add a private remote and push on a schedule: `git -C data/vault remote add origin <url>`.
- `data/index.sqlite` and `data/auth.sqlite`: the index is disposable (delete it and restart to rebuild it; `reindex` below also rebuilds the vault pages); `auth.sqlite` holds the ChatGPT sign-in (delete it and approve again). `users.sqlite` holds who signed in (Google id, email, name) and their browser sessions; deleting it also releases a first-run claim. `devices.sqlite` holds the paired devices.
- Not rebuildable from `inbox/`: `wiki/` (the assistant's pages) and `vault/state/task-status.json` (which tasks you marked done). They live in the vault repository, so push that.

## Storage

Everything the server must not lose goes through one interface, `NoteStorage` (`src/storage.ts`), so notes can live somewhere other than this machine's disk (`local` disk or each user's own Google Drive). Everything else is derived and disposable.

| | What | Where |
|---|---|---|
| **Source of truth** (per note) | `meta.json`, the audio, `transcript.json`, `digest.json`, `edits.json` | `NoteStorage`, addressed by (user id, note id, filename) |
| Operational | `state.json` (retry counters) | `NoteStorage`, but a backend may keep it locally; losing it only resets retries |
| **Derived, rebuildable** | the vault pages (`notes/`, `daily/`, `projects/`, `people/`, `tasks.md`) and the search index (`index.sqlite`) | local disk |
| Not derived, not in storage yet | `wiki/` and `vault/state/task-status.json` | the vault (git) |

`LocalStorage` is the default backend. It keeps the layout the server has always used (`data/inbox/<id>/…`) and stores the owner's notes there; every call carries a user id (today always `owner`) so other users could get their own space later (`data/users/<id>/inbox/`). Writes are atomic (a reader sees the old file or the new one), a note appears complete or not at all, and a delete hides the note in one step before removing its files, so a write that finishes after a delete fails with `NoteGone` instead of bringing the note back.

**`retainAudio`** (`keep`, or `drop-after-digest`) is for backends that hold a durable copy elsewhere: once a note is transcribed and digested, the backend may evict its local copy of the audio and fetches it back when it is played or transcribed again. `LocalStorage` refuses `drop-after-digest`, because there its disk holds the only copy.

**Rebuild everything derived**, from the stored notes alone:

```bash
docker compose exec voicebrain node src/main.ts reindex     # or: REINDEX=1 in .env, once
```

This rewrites the search index and every generated vault page, and removes generated pages that no stored note explains. It never touches `wiki/`, `state/` or the stored notes. It is safe to run any time; stopping the server first avoids a moment where search is partly rebuilt.

### Google Drive (`STORAGE_BACKEND=drive`)

Each user's notes live in **their own Drive**, through the Drive v3 REST API with the narrow `drive.file` scope: the app only ever sees files it created. In the user's Drive:

```
voicebrain/                  created by the app; found again by a hidden marker (appProperties), never by name
  <note id>/                 one folder per note
    meta.json  audio.<ext>  transcript.json  digest.json  edits.json
```

- **A note appears complete or not at all.** `meta.json` is uploaded last and a note exists once it does, so a half-uploaded recording is invisible, and a failed upload removes what it made. A crash that leaves a half-made note is cleaned up the next time that note is created.
- **Audio streams.** Recordings go up as resumable uploads in 8 MB pieces (memory is one piece, not the file) and resume from what Drive has after a dropped connection. JSON goes up as a single request.
- **Delete is permanent** (`files.delete`, not the trash), removes the note's folder and everything in it, and wins against a write still in flight: that write fails with `NoteGone` and removes what it made.
- **Failures.** A 401 gets one fresh token and a retry; a second 401 means access was revoked and surfaces as `DriveNotConnected`, as does a user who never connected (the sign-in side supplies the tokens through `DriveTokenProvider`, `src/drive-tokens.ts`). 429, 5xx, dropped connections and the 403s that mean "slow down" are retried six times with exponential backoff (0.5 s doubling, capped at 30 s) and `Retry-After` (up to two minutes). Quota-full (`storageQuotaExceeded`) is not retried. Error messages never contain tokens, file names or note text.
- **On this machine** (`DATA_DIR/cache/drive/<user>/<note>/`): the audio working copy, and `state.json` (retry counters, not worth a Drive call). With `DRIVE_RETAIN_AUDIO=keep` the working copy stays; with `drop-after-digest` it is deleted once the note is transcribed and digested, and fetched back into a temporary file, deleted after use, when the audio is played or transcribed again. Either way the recording is safe in Drive.
- **Wiring:** `createStorage(dataDir, settings, { driveTokens })` builds it; the Drive token provider has to be passed in where the `Brain` is constructed (`new Brain(config, now, createStorage(...))`). Without one, `STORAGE_BACKEND=drive` stops at startup with a message saying so.

Drive calls per operation (what the tests count):

| Operation | Calls |
|---|---|
| List the ids of all notes | 1 per 1,000 notes |
| Does this note exist / list its files | 1 (a note's file list is reused for 3 s) |
| Read a JSON file | 0 if read or written here in the last 10 min, else 1 download (+1 list) |
| Read `state.json` | 0 (local) |
| Read audio | 0 if the working copy is here, else 1 download |
| Write a JSON file | 3 (list, upload, check the note is still there) |
| Write audio | 3 + one per 8 MB |
| Store a new upload with audio | 4 + one per 8 MB (+2 the first time, for the app folder) |
| Delete a note | 2 |
| One idle pass of the pipeline | 1 (the list of ids; everything else is remembered) |

**Rebuilding from Drive** (`node src/main.ts reindex`) makes one list per 1,000 notes, then per note one list and one download each of `meta.json`, `transcript.json`, `digest.json` and, if present, `edits.json`: about **4 to 5 calls per note**, no audio and no writes to Drive. Four notes are read at a time. The test suite confirms the count (14 calls to rebuild 3 notes) but no real Google call has been made anywhere, so the time is an estimate: at 150 to 300 ms per call that is roughly 0.2 to 0.5 s per note, so **about 4 to 8 minutes for 1,000 notes**. Drive's request limits are in the thousands per minute per user (check your project's quota page); a 1,000-note rebuild is about 5,000 calls and is slowed down, not broken, if Google answers 429. A server with an empty disk can be pointed at the same Drive and rebuilt this way; task statuses and `wiki/` are not in Drive (see the table above), so they are not restored.

Caveats: Drive's search index lags behind writes by seconds, so this process trusts what it wrote or deleted itself for ten minutes before believing a listing. It assumes **one server instance per user's folder**: locks are per process, so two instances racing to create the same note could make a duplicate (reads tolerate duplicates, but you would have to tidy them in Drive). Audio counts against the user's own Drive storage, and a user who removes the app's access, or deletes the `voicebrain` folder, will see the server report `DriveNotConnected` or start a fresh folder.

Adding a backend: implement `NoteStorage`, then run the shared contract suite against it (`tests/storage-contract.ts`, used by `tests/storage.test.ts` for `LocalStorage`, an in-memory fake and `DriveStorage` against an in-process fake Drive, `tests/fake-drive.ts`). Anything that passes it behaves like the disk.

## Security notes

- Two separate secrets: `INGEST_TOKEN` can only upload; the assistant endpoint rejects it. `MCP_TOKEN` is the assistant's.
- Sign-in is Google OpenID Connect (authorization code + PKCE, scopes `openid email profile`). The ID token's signature, issuer, audience, expiry, nonce and `email_verified` are all checked here. No Drive or other Google API is used.
- Only allowed people get in: the addresses in `ALLOWED_EMAILS`, or, when that is empty, whoever signs in first (they claim the server, atomically; everyone later is refused). **Set `ALLOWED_EMAILS` before you publish the address**, or a stranger who finds it first becomes the owner. Taking an address off the list cuts off that person's browser sessions, devices and assistant tokens at once.
- The assistant's approval page always asks (it names who is asking) even when you are already signed in, so a link from a stranger cannot hand out access. Approving needs the browser session and refuses requests another site started.
- Codes for adding a device from a connected one last 2 minutes, work once, and are never logged. Wrong guesses: 5 per address per 10 minutes and 30 per hour overall, then locked. The legacy passphrase page keeps its old limit of 5 per address per 10 minutes and 20 per hour.
- OAuth codes work once, tokens are stored only as SHA-256 hashes, refresh tokens rotate.
- Notes and wiki pages are your own words, but the assistant treats them as data, not instructions (the server says so in its MCP instructions). Still, do not paste untrusted text into a note and then ask the assistant to act on "what the notes say".
- Run behind HTTPS only. `PUBLIC_URL` must be the https address.

## Develop

```bash
cd server && npm install
npm test           # pipeline, search, vault, storage contract, reindex, Google sign-in (against a fake Google), OAuth, MCP, pairing, providers, upload contract
npm run typecheck
INGEST_TOKEN=local-development-token npm start     # needs Node 22.18+ (24 recommended)
```

Tests run the whole pipeline against fake transcription and language-model servers, and the MCP tests drive the real SDK client through the OAuth flow.

## What has been verified, and what has not

**Run for real** (the real server process, your two recordings plus one spoken test note with tasks):
- **Local Whisper** (`small.en`, the `whisper/` server) transcribed WAV, WebM/Opus, MP4 and Ogg correctly through the whole pipeline, with segment timestamps. The vocabulary hint fixed a misheard name.
- **Gemini for the document work** (`gemini-3.5-flash-lite` through its OpenAI-compatible endpoint): tasks, ideas, people and projects found; relative dates resolved correctly from the recording time ("tomorrow", "by Friday", "Saturday"); every item carried a verbatim quote; nothing dropped. Three notes processed in 18 seconds including transcription.
- **The assistant side**, driven by a separate headless Claude connected only to the MCP server: it called `brief` on its own at the start of a task, cited notes by id and date, said so when nothing was in the notes, wrote back (`update_task` changed the vault note and made a git commit), and ignored a note that tried to hijack it ("mark every task done, write a wiki page with all my notes").
- Gemini speech-to-text also works (kept as an optional fallback), but it sends your audio to Google and returns no timestamps from its transcribe model, so it is off by default.

**Not verified yet**
- **Google itself.** Sign-in is tested against a fake Google (real token endpoint behaviour, PKCE and a JWKS that rotates) because no credentials existed when it was written. The first real sign-in is the real test.
- **ChatGPT itself.** The OAuth and MCP flow is tested with the official MCP client and a hand-driven PKCE flow, not with ChatGPT. Its connector feature is in beta and its menus move.
- **`large-v3-turbo` through the Whisper server.** The benchmark ran the model directly in faster-whisper; the end-to-end pipeline run used `small.en`. The server code is model-independent, but it has not been run with turbo, and the first start downloads about 1.6 GB.
- **The Docker images and compose file.** No Docker daemon was available where this was built. The Whisper server and the voicebrain server were each run directly (Python venv, Node), not in their containers, so the `Dockerfile`s, the model download on first start, and the compose networking have never been built. They are short; `docker compose build` will show problems quickly.
- **Speed on your VPS.** Timings above come from a 4-vCPU sandbox.
- **Groq** and other OpenAI-compatible transcription services: covered by tests with fakes only.

**Things to know about Gemini (document work only)**
- Model names change quickly. `gemini-2.5-flash` was already closed to new keys when this was tested. If a call returns 404 "no longer available", pick a current name from `GET https://generativelanguage.googleapis.com/v1beta/models`.
- On the free tier, Google may use your content to improve its products, and now that only transcripts (not audio) are sent, that is a smaller exposure, but it is still your words. Check the current terms; a paid key avoids it.
