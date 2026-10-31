# voicebrain server

Receives voice notes from the recorder app, turns them into a searchable, versioned knowledge base, and lets an assistant (ChatGPT, over MCP) read and extend it.

```
recorder app ──upload──▶  inbox/<id>/  audio + meta        (never edited)
                              │ transcribe   (Whisper, local or hosted)
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

Needs Docker and your existing Caddy.

```bash
git clone https://github.com/thekusaldarshana/voicebrain && cd voicebrain
cp .env.example .env && nano .env          # see the comments in the file
mkdir data && sudo chown 1000:1000 data    # the user the container runs as
docker compose up -d --build
curl http://127.0.0.1:8787/health          # {"ok":true}
docker compose logs -f voicebrain          # shows what is configured and what is missing
```

Add `Caddyfile.example` to your Caddyfile with your own domain, reload Caddy, and check `https://brain.example.com/health`.

Pair the phone: `node server/src/main.ts pair --app https://<your-vercel-app> --endpoint https://brain.example.com --token <INGEST_TOKEN> --name "Pixel"` prints a link. Open it on the phone and the recorder configures itself. In the app, **Settings → Test connection** should say it is connected.

Choose transcription in `.env`: Groq (hosted, free tier) or `docker compose --profile local-stt up -d` for Whisper on this machine. See the notes under "Not verified yet".

## Connect ChatGPT

1. In `.env` set `PUBLIC_URL` and `OWNER_PASSPHRASE`, then `docker compose up -d`.
2. In ChatGPT, turn on Developer mode and add a custom MCP server. The menu names move around, so look for "Developer mode" / "custom connector". The URL is `https://brain.example.com/mcp`. Choose OAuth.
3. ChatGPT opens your server's approval page. Type the owner passphrase and approve. You do this once; the connection then refreshes itself for 90 days at a time.
4. Add this to ChatGPT's custom instructions so it uses the tools without being asked: *"I keep a personal knowledge base of my own voice notes. At the start of any task, plan or decision, call `brief` with the topic and mention anything relevant I said before, with the date. Before saying you cannot remember something about me, call `search`."*

Other clients (Claude Desktop, Cursor) can use the same `/mcp` URL with `MCP_TOKEN` as a bearer token.

## The tools

| Tool | What it does |
|---|---|
| `brief(topic)` | **Call first.** What you said about this, related open tasks, people and projects on record, wiki pages. Empty topic: what is overdue and recent |
| `search(query)` | Full-text search over notes and wiki |
| `recent(days)` | Latest notes with summaries |
| `get_note(id)` | The full note: tasks with their source quotes, marked moments, transcript |
| `open_loops(project?)` | Tasks not done yet, soonest due first |
| `update_task(task_id, status)` | Mark done, dismissed or open |
| `add_note(text)` | Save something you told the assistant to remember |
| `list_wiki`, `read_wiki`, `write_wiki` | The assistant's own pages (weekly reviews, project and person summaries). Only `wiki/` is writable |

Ask ChatGPT "run my weekly review" and it can read the week's notes and write `wiki/review.md`, using your subscription for the heavy thinking.

## Configuration

| Variable | |
|---|---|
| `INGEST_TOKEN` | **Required.** 16+ characters. The recorder app's bearer token |
| `PUBLIC_URL`, `OWNER_PASSPHRASE` | Turn on OAuth for ChatGPT. Passphrase 12+ characters |
| `MCP_TOKEN` | Optional fixed bearer token for clients without OAuth |
| `OWNER_TIMEZONE` | IANA zone for "today" and "overdue" (default UTC) |
| `STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL`, `STT_LANGUAGE`, `STT_PROMPT`, `STT_MAX_MB` | Any OpenAI-compatible `/audio/transcriptions` server |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_MAX_INPUT_CHARS` | Any OpenAI-compatible `/chat/completions` server |
| `ALLOWED_ORIGIN` | CORS origin for the recorder app (default `*`) |
| `DATA_DIR`, `PORT`, `HOST`, `MAX_UPLOAD_MB`, `MAX_ATTEMPTS`, `GIT`, `WORKER`, `REINDEX` | Defaults are fine |

Without `STT_BASE_URL` or `LLM_BASE_URL` the server still accepts and stores notes; `GET /v1/status` (and the startup log) says what is missing.

## Backups

Everything lives in `data/`:
- `data/inbox/` audio, transcripts, digests. **The irreplaceable part.** Back this up.
- `data/vault/` is a git repository. Add a private remote and push on a schedule: `git -C data/vault remote add origin <url>`.
- `data/index.sqlite` and `data/auth.sqlite`: the index is disposable (delete it and restart to rebuild); `auth.sqlite` holds the ChatGPT sign-in (delete it and approve again).

## Security notes

- Two separate secrets: `INGEST_TOKEN` can only upload; the assistant endpoint rejects it. Neither is the owner passphrase.
- The approval page accepts 5 wrong passphrases per address per 10 minutes and 20 per hour overall, then locks.
- OAuth codes work once, tokens are stored only as SHA-256 hashes, refresh tokens rotate.
- Notes and wiki pages are your own words, but the assistant treats them as data, not instructions (the server says so in its MCP instructions). Still, do not paste untrusted text into a note and then ask the assistant to act on "what the notes say".
- Run behind HTTPS only. `PUBLIC_URL` must be the https address.

## Develop

```bash
cd server && npm install
npm test           # 83 tests: pipeline, search, vault, OAuth, MCP, upload contract
npm run typecheck
INGEST_TOKEN=local-development-token npm start     # needs Node 22.18+ (24 recommended)
```

Tests run the whole pipeline against fake transcription and language-model servers, and the MCP tests drive the real SDK client through the OAuth flow.

## Not verified yet

- **Real providers.** Tests use fakes that follow the OpenAI-compatible request shapes. Nothing has run against real Groq, a real language model, or Speaches. Expect to adjust a model name or two on first contact.
- **Local transcription (Speaches).** The compose service and the model name `Systran/faster-whisper-small.en` come from the project's README as I found it; I did not run it. Speaches may need the model downloaded first, and its image tags change. If it misbehaves, start with Groq.
- **Docker build and Caddy.** No Docker daemon was available where this was built, so the `Dockerfile` and `compose.yaml` have not been built. They are short; `docker compose build` will tell you quickly.
- **ChatGPT.** The OAuth and MCP flow is tested with the official SDK client and a hand-driven PKCE flow, not with ChatGPT itself. ChatGPT's connector feature is in beta and its menus move.
