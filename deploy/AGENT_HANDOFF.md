# Hand-off prompts for deploying on the VPS

Use these in a Claude Code session that can SSH to the VPS. Start every session by pasting the **Brief**, then the phase prompt. Do the phases in order, and only continue when the report from the previous one looks right to you.

Things you must decide or provide first:
- a **domain** whose DNS you control, with an A record for a subdomain (for example `brain.yourdomain.com`) pointing at `159.195.250.142` (needed from Phase 2)
- how the VPS may **read the GitHub repo** if it is private (a read-only deploy key or a token you create yourself; the agent must not create credentials on its own)
- your **Vercel app URL** (Phase 3)
- a **passphrase** you choose (12+ characters) for approving ChatGPT's access (Phase 2). You type it into `.env` yourself.
- an **LLM API key** for the document step (Gemini for now). You put it into `.env` yourself.

---

## Brief (paste first, every time)

```
You are deploying "voicebrain" on a VPS that already runs my production services. Your first duty is that nothing existing breaks.

THE MACHINE (from a read-only report taken 2026-11-01)
- SSH alias BMC-NetCup (user bmc, groups: sudo docker). Debian 13, 8 vCPU (generic QEMU CPU: AVX2 only, no AVX-512), 15 GiB RAM with about 12 GiB available and NO SWAP, about 240 GB free disk, load about 0.1.
- sudo asks for a password: never use sudo. Docker works without it. Docker 29, Compose v5.
- 7 containers are running that you must not touch, stop, restart, rebuild or reconfigure: spp-postgres (0.0.0.0:5433), hermes, hermes-dashboard, fables-room (127.0.0.1:8787), fables-tunnel (cloudflared), caddy (its compose file is /home/bmc/VIDU/caddy/docker-compose.yml), n8n (/home/bmc/VIDU/n8n/). In total 24 containers, 15 volumes and 15 GB of build cache exist.
- Ports already listening (never use): 22 80 443 2019 3000 5433 5678 5679 8090 8642 8645 8646 8650 8787 9119 plus a few high ones. voicebrain uses 127.0.0.1:18787 only.
- Caddy runs in Docker, almost certainly with host networking (no ports are published, yet it listens on *:80 and *:443). Verify, do not assume.
- The host has Node 20 and no ffmpeg; voicebrain runs entirely in containers, so install nothing on the host.
- Cron already runs 5 jobs. Do not edit the crontab without asking me.
- The server can reach Docker Hub, Hugging Face and PyPI.

THE PROJECT
Repo https://github.com/thekusaldarshana/voicebrain, branch main. Read README.md, server/README.md, compose.yaml and .env.example first. In short: recorder app -> upload -> Whisper (the stt container, model large-v3-turbo) -> a language model turns the transcript into tasks and a summary (Gemini for now, through its OpenAI-compatible endpoint) -> a markdown vault in git -> an MCP endpoint for ChatGPT. Everything runs from compose.yaml as the compose project "voicebrain" in /home/bmc/voicebrain.

RULES
1. Read-only first. Before any change, say what you will change and why. Changes go only inside /home/bmc/voicebrain, plus, in Phase 2 only, one block added to the Caddyfile.
2. Never run: docker system/image/volume/builder/container prune; docker stop/restart/rm/kill/exec on containers you did not create (the one exception is Phase 2: "docker exec caddy caddy validate" and "caddy reload"); any docker compose command in another project's directory; docker compose down -v; rm -rf outside /home/bmc/voicebrain; anything with sudo; edits to the crontab, ssh config, firewall or other projects' files.
3. Secrets: never print, log, commit or paste them. .env is chmod 600. Generate secrets with openssl and do not show the values. I type my own LLM key and my passphrase into .env myself; never echo them back. Read single values with grep/cut, never cat .env, and never source it (values contain spaces).
4. Before and after every phase capture: docker ps (names and status), uptime, free -h, and diff them. If any container that is not part of voicebrain changed status or restarted, or load or memory moved unexpectedly, stop and report.
5. Stop and ask me if: a port or name conflicts; free memory is under 6 GiB; free disk is under 40 GB; a build fails twice; anything in the repo contradicts what you see on the server (trust the server); or you are unsure.
6. Report with evidence: the commands you ran and the key output with secrets redacted, not just "done".
```

---

## Prompt 1: preflight, build, local-only run (nothing public, nothing existing touched)

```
[Brief pasted above.] Do Phase 1 only.

1. Read-only verification. Capture the before-snapshot (rule 4). Confirm with docker inspect (read-only) how the caddy container is networked and which host paths it mounts; tell me the Caddyfile's path but do not print the whole file. Confirm id -u / id -g for bmc, that /home/bmc/voicebrain does not exist (if it does, stop), and that nothing listens on 18787.
2. Get the code: git clone https://github.com/thekusaldarshana/voicebrain /home/bmc/voicebrain. If the repo is private and cloning fails, ask me how to authenticate. Do not create SSH keys or tokens yourself.
3. cp .env.example .env; chmod 600 .env. Set INGEST_TOKEN and MCP_TOKEN with openssl rand -hex 24 (write them straight into .env, do not display them). Set PUID and PGID to bmc's ids. Leave OWNER_PASSPHRASE empty for now (Phase 2). Create ./data owned by bmc. Tell me exactly which lines I must still fill in myself (the LLM key) and wait; do not guess or invent a key. If I have not added one yet, continue anyway: transcription and filing work without it and the digest simply waits.
4. Validate without starting anything: docker compose config -q, then check that the rendered config shows host port 127.0.0.1:18787, cpus 6, mem_limit on both services, and that the stt service has no API keys in its environment.
5. Build gently: nice -n 19 docker compose build (watch disk and memory). Known risk areas if it fails: the Python image pip install in whisper/ (requirements.txt pins PyAV below 19 on purpose, do not unpin it), and npm ci in server/. At most two fix attempts, minimal fixes, tell me what you changed; commit nothing to the repo, send me the proposed patch instead.
6. docker compose up -d. Follow docker compose logs -f stt until the first start finishes (it downloads about 1.6 GB of model; docker compose ps shows health). Confirm docker compose logs voicebrain prints which features are on and off.
7. Prove it works. curl http://127.0.0.1:18787/health. Download the 11-second public sample https://github.com/ggml-org/whisper.cpp/raw/master/samples/jfk.wav (if unreachable, tell me and suggest another). Upload it like the app does: multipart POST to /v1/notes with a field "meta" (JSON with a fresh UUID id, createdAt, durationMs 11000, mime audio/wav, device "vps-test", timezone Europe/Berlin, utcOffsetMinutes 60, source record) and a field "audio" (the file), headers Authorization: Bearer <INGEST_TOKEN read from .env without printing> and Idempotency-Key: <same UUID>. Then show: data/inbox/<id>/transcript.json (text and that segments with timestamps exist), data/vault/ contents and git log, and GET /v1/status.
8. Measure and report: seconds from upload to transcript, and so the speed as a multiple of real time; peak memory and CPU of the stt container (docker stats --no-stream while it works; do it again with the sample uploaded twice back to back); docker inspect --format '{{.State.OOMKilled}}' for both containers; whether load on the host stayed sane. This CPU has only AVX2, so I expect slower than my 3x-realtime benchmark. If large-v3-turbo transcribes slower than real time, do NOT change the model yourself: report the numbers and options (small.en, distil-large-v3) and let me choose.
9. After-snapshot and diff (rule 4). Confirm explicitly that no other container was touched and the Caddyfile is unchanged (compare its checksum and modification time before and after).

Final report: what is running, the evidence above, anything surprising, how to roll back (docker compose down in /home/bmc/voicebrain, no -v), and what I must provide for Phase 2 (domain, passphrase). Then stop and wait for my "go".
```

---

## Prompt 2: public HTTPS through the existing Caddy

```
[Brief pasted above.] Phase 1 passed. Do Phase 2 only. My domain is <DOMAIN, for example brain.example.com> and its DNS A record points to 159.195.250.142.

1. Before-snapshot (rule 4). Also record the baseline of every existing site: list the site addresses in the Caddyfile (addresses only, never secrets) and for each run curl -sS -o /dev/null -m 10 -w "%{http_code}" https://<site>/ and save the results.
2. Check DNS: dig +short <DOMAIN> must return 159.195.250.142. If the domain sits behind a Cloudflare proxy (orange cloud) or the answer differs, stop and tell me; do not change anything.
3. Understand the Caddy setup: network mode, the Caddyfile path inside and outside the container, whether it has global options and imports, whether the admin API on 127.0.0.1:2019 is enabled. Confirm 127.0.0.1:18787 is reachable from Caddy's point of view (host networking). If Caddy is NOT on host networking, stop and propose options (a shared Docker network, or the host gateway address); do not rewire anything on your own.
4. Back up the Caddyfile next to itself with a timestamp. Show me the exact block you will add and a diff, then wait for my OK:

   <DOMAIN> {
       encode zstd gzip
       request_body {
           max_size 250MB
       }
       reverse_proxy 127.0.0.1:18787
   }

5. After my OK: add only that block. docker exec caddy caddy validate --config <path inside container>. Only if valid: docker exec caddy caddy reload --config <path inside container> (a graceful reload, never a restart). If validate fails, restore the backup immediately and report.
6. Verify: re-run the baseline from step 1 and compare every site (all must give the same status as before); curl -sS https://<DOMAIN>/health returns {"ok":true}; show the certificate issuer and expiry (openssl s_client or curl -v) to confirm HTTPS works. Watch docker logs caddy --tail 50 for errors.
7. Turn on the assistant sign-in. Tell me to put my passphrase (12+ characters, chosen by me) into .env as OWNER_PASSPHRASE myself and to confirm; never ask me to paste it into chat. Set PUBLIC_URL=https://<DOMAIN> (no trailing slash) in .env. Then docker compose up -d voicebrain (this recreates only voicebrain; the stt container must not restart; confirm with docker ps).
8. Verify the assistant endpoints over HTTPS:
   - GET https://<DOMAIN>/.well-known/oauth-protected-resource/mcp returns JSON whose "resource" is https://<DOMAIN>/mcp
   - GET https://<DOMAIN>/.well-known/oauth-authorization-server returns JSON with authorization_endpoint, token_endpoint and registration_endpoint on <DOMAIN>
   - POST https://<DOMAIN>/mcp with no token returns 401 and a WWW-Authenticate header containing resource_metadata
   - POST https://<DOMAIN>/mcp with Authorization: Bearer <MCP_TOKEN read from .env without printing>, header Accept: application/json, text/event-stream, first {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}} then {"jsonrpc":"2.0","id":2,"method":"tools/list"} returns the 10 tools (brief, search, recent, get_note, open_loops, update_task, add_note, list_wiki, read_wiki, write_wiki)
9. After-snapshot and diff (rule 4). Report.

Rollback: restore the Caddyfile backup and reload Caddy the same graceful way; remove PUBLIC_URL and OWNER_PASSPHRASE from .env and docker compose up -d voicebrain. Stop and wait for my "go".
```

---

## Prompt 3: pair the phone, verify end to end, backups

```
[Brief pasted above.] Phases 1 and 2 passed. Do Phase 3 only. The recorder app is at https://<MY VERCEL APP URL>. The server is https://<DOMAIN>.

1. Before-snapshot (rule 4).
2. Make the pairing link: docker compose exec voicebrain node src/main.ts pair --app https://<MY VERCEL APP URL> --endpoint https://<DOMAIN> --name "Pixel". The link contains the upload token. Show it to me ONCE, tell me to open it on my phone only and not to paste it anywhere else, and do not write it into any file or log.
3. I will record two real voice notes in the app (one with a task and a date, for example "tomorrow I need to call the bank"). Watch docker compose logs -f voicebrain and tell me when each note is transcribed and digested. Then show the vault note for each (data/vault/notes/...): the summary, the tasks with their quotes, the marked moments if I used Mark, and git -C data/vault log. Check that the transcript is word-accurate to what I say (I will tell you what I said), and report the real time from tapping Stop to the finished note. If the digest does not run, check that I added the LLM key (do not read it) and that the model name is current by listing models from the provider without printing the key.
4. If a name is transcribed wrongly, tell me; the fix is adding it to STT_PROMPT in .env (then docker compose up -d voicebrain).
5. Backups. Propose (do not install yet) a script /home/bmc/voicebrain/backup.sh that writes a dated archive of data/inbox and data/vault into /home/bmc/backups/voicebrain/, keeps the newest 14, and exits non-zero on failure. Show me the script and the exact crontab line you would add (the crontab already has 5 jobs; show the full before and after). Install it only after I say yes.
6. Resource check after real use: docker stats --no-stream, free -h, uptime, docker inspect OOMKilled for both containers, and that every other container is unchanged. Remind me to rotate any API key that was ever pasted into a chat.
7. Final report: URLs, what runs, versions, resource use, the rollback for the whole thing (docker compose down in /home/bmc/voicebrain, restore the Caddyfile backup and reload, remove the cron line), and the one thing I still do by hand: connecting ChatGPT (Developer mode, add a custom MCP server at https://<DOMAIN>/mcp, choose OAuth, approve with my passphrase, then the custom instruction in server/README.md).
```
