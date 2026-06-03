# MessageAnywhere

Self-hosted local-WiFi web app for sharing text messages across devices. Single Node.js server, vanilla frontend, SQLite, no internet dependency.

## Run

```bash
node server.js        # http://localhost:3000
```

## Test

```powershell
# Start server, then:
Invoke-RestMethod -Uri http://localhost:3000/api/messages                    # GET
Invoke-RestMethod -Uri http://localhost:3000/api/messages -Method Post -Body '{"text":"hi","device_name":"test"}' -ContentType "application/json"  # POST
Invoke-RestMethod -Uri http://localhost:3000/api/messages/1 -Method Delete   # DELETE
```

## Architecture

```
server.js          Express 5.x + better-sqlite3 (WAL mode) + multer, 4 API routes (GET/POST/PUT/DELETE), image uploads
public/index.html  Single-file vanilla HTML/CSS/JS (~900 lines, pastel theme, no sidebar, image support)
launch.vbs         Windowless launcher for Windows Scheduled Task
setup-task.ps1     Registers Scheduled Task (AtLogOn, wscript.exe launch.vbs)
```

### API

- `GET  /api/messages` — newest 200 oldest-first; `?since=<id>` returns only newer; `?device=<name>` filters by device
- `POST /api/messages` — `{text, device_name}`, validates both required, text ≤10000, name ≤50
- `PUT /api/messages/:id` — `{text}`, validates text required, ≤10000
- `DELETE /api/messages/:id` — 204 on success, 404 if missing, 400 if NaN
- `POST /api/messages` also accepts `multipart/form-data` with optional `images` field (max 10 files, 5 MB each, image/* only)
- Images stored in `uploads/`, served at `/uploads/<filename>`, metadata in SQLite `images` table, files persist on disk
- 7-day expiry archives messages to `history/YYYY-MM-DD.log` before DB deletion; image files never deleted

### Frontend

- Pastel light theme with CSS custom properties, alternating card backgrounds by device name hash
- Single-column centered layout at all sizes (no sidebar); max-width 440px→920px responsive
- Hero header: gradient background, device avatars pill, animated waveform bars, online status
- Three views: Messages (all messages + send), Devices (device cards grid + recent activity + quick actions), Device Detail (per-device messages)
- Segmented tab bar (Chats | Devices) in content sheet; hero/tabs hide on device detail
- 3s polling with `?since=` incremental fetch, concurrency guard (`let polling = false`)
- Clipboard API with execCommand fallback, visual "copied!" flash on tap
- Swipe-left-to-delete (touch events, 80px threshold)
- Long-press to edit (mobile, 500ms), right-click to edit (desktop), double-click to delete
- Device name: UA auto-detect → localStorage override → modal edit
- Long message truncation (280 chars) with gradient fade + Show more/less
- Client-side search filtering (messages and device messages)
- Image upload: attach button (clipboard), thumbnail preview strip with remove, FormData multipart send (backward-compatible JSON text-only)
- Image display: thumbnails in message bubbles (single full-width or 2-column grid), lightbox with arrow keyboard navigation
- Edit mode preserves images; copy includes image URLs alongside text

## Conventions

- No comments in code unless the WHY is non-obvious
- Single-file frontend (all CSS in `<style>`, all JS in `<script>`)
- Error handling: try/catch on DB ops in setInterval (crashes won't route through Express middleware)
- Input validation at API boundary (server.js), no client-side validation beyond HTML5 `maxlength`
- Git user: MessageAnywhere <lixia@messageanywhere.local>

## Current State

- 28 commits on `main`, pushed to `https://github.com/Xiaohan5349/messageAnywhere`
- Server running via Windows Scheduled Task "MessageAnywhere" (wscript.exe → launch.vbs → node)
- All 11 implementation plan tasks complete
- API: GET, GET ?since=, GET ?device=, POST, PUT, DELETE all working
- UI: 6 major redesign iterations complete; current = pastel single-column with hero + content sheet
- Smoke test: API tests pass; manual browser/mobile tests recommended

## Gotchas

- `cleanupExpired()` runs in `setInterval` — must wrap in try/catch or DB error crashes process
- `relativeTime()`: `new Date(iso).getTime()` NOT `new Date(iso + 'Z')` (ISO string already has Z)
- `new Date().toISOString()` in POST already ends with Z — don't double-append
- `better-sqlite3` is synchronous; Express 5.x handles async route errors natively
- Task Scheduler RunLevel: use `Limited` not `LeastPrivilege` on some Windows/PowerShell versions
- `wscript.exe` launches node without console window; never execute `node.exe` directly from Task Scheduler

## .gitignore

```
node_modules/
messages.db*
.claude/
.superpowers/
docs/
```

CLAUDE.md and launch.vbs are public; docs/ and .claude/ are local-only.

## Read More

- `docs/HUMAN_HANDOFF.md` — human-readable project summary
- `docs/PROJECT_JOURNEY.md` — full chronological history and decisions
- `docs/RETROSPECTIVE.md` — AI collaboration lessons

## Change Log

- [2026-06-03] - Image support: multer uploads, images table, FormData multipart POST, image rendering, lightbox, history/ archiving on 7-day expiry, backward-compatible JSON text-only POST - server.js, public/index.html, .gitignore
- [2026-05-23] - UI redesign to HUD/tactical aesthetic + Devices page with per-device filtering + `?device=` API filter - server.js, public/index.html
- [2026-05-23] - Device detail as full page with search bar, all message interactions preserved - public/index.html
- [2026-05-23] - Pastel gradient light theme with avatars, responsive breakpoints (phone/tablet/desktop) - public/index.html
- [2026-05-23] - Refined pastel UI: compact cards, pastel-colored bubbles/cards, overlapping avatars, waveform icons, floating app shell, smaller scale - public/index.html
- [2026-05-23] - Fixed send-message bug on device detail page (added input bar), hero section with device avatars, desktop two-column sidebar layout (960px+) - public/index.html
- [2026-05-23] - Fixed view switching bug (removed !important CSS that overrode JS), redesigned Devices page with CSS grid + featured card, removed sidebar send input - public/index.html
- [2026-05-23] - Fixed disappearing tabs: lifted header out of views, toggle between main header and device detail header, back button returns to previous view - public/index.html
- [2026-05-23] - Removed sidebar, redesigned main page as single-column centered layout with gradient hero, device avatars pill, animated waveform, white content sheet, segmented tabs, recent activity section, quick actions - public/index.html
- [2026-06-03] - Image support: attach button, preview strip, FormData send, image rendering, lightbox, edit mode with images - public/index.html
- [2026-06-03] - Task 3: attachImages() helper, GET/PUT endpoints include image metadata - server.js
- [2026-06-03] - Task 4: cleanupExpired archives expired messages to history/YYYY-MM-DD.log before deleting from DB, images persist on disk - server.js
