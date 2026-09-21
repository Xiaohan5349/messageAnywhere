# MessageAnywhere

Self-hosted, local-WiFi web app for sharing text messages across all your devices. No internet, no accounts, no setup — just open a browser.

## How it works

A single Node.js server runs on your Windows PC. All devices on the same WiFi open the page in their browser. Messages sync in real time via polling, with 7-day auto-expiry.

## Features

- Send text messages from any device on the same network
- Attach up to 10 images per message (PNG, JPEG, GIF, WebP, BMP)
- Real-time sync across all open browsers (3-second polling)
- Tap to copy any message to clipboard
- Swipe left to delete
- Custom device name with auto-detection (iPhone, Android, Mac, Windows PC)
- Messages auto-expire after 7 days, archived to `history/YYYY-MM-DD.log`
- Auto-starts on Windows login via Scheduled Task

## Working with images

Images start collapsed so the message list stays compact.

| Gesture | Result |
|---|---|
| Tap the message | Expand thumbnails and full text; tap again to collapse |
| Double-click a thumbnail | Open the lightbox |
| Copy button (top-left of the lightbox) | Copy the image to the clipboard |
| Long-press a thumbnail (mobile) | The phone's own save / copy menu |
| Right-click a thumbnail (desktop) | The browser's own save / copy menu |
| Swipe left | Delete |
| Long-press the message body | Edit |

Copying an image to the clipboard needs the async Clipboard API, which browsers
only expose over HTTPS or `localhost`. On `http://<local-ip>:3000` the button
falls back to opening the image, and the long-press menu above is the way to save
or copy it.

## Security model

There is no authentication. Anyone who can reach `http://<local-ip>:3000` can read,
edit and delete every message and pick any device name. That is fine on a trusted
home network and is not fine on a shared or public one — put it behind a trusted
network or a reverse proxy with auth if that matters to you.

Uploads are checked by content, not by the name or MIME type the client claims, and
are always stored under a server-generated filename with an extension derived from
the verified format. An uploaded file therefore cannot be served from this origin
as HTML or SVG.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) (18+)
- Windows PC (server host)
- Any device with a browser + same WiFi

### Install

```bash
git clone https://github.com/Xiaohan5349/messageAnywhere.git
cd messageAnywhere
npm install
```

### Run

```bash
node server.js
```

Open `http://localhost:3000` on the host PC, or `http://<local-ip>:3000` from other devices.

### Auto-start on Windows login

```powershell
.\setup-task.ps1 -ProjectPath "C:\path\to\messageAnywhere"
```

Requires Administrator privileges. Creates a Scheduled Task that launches the server
hidden at login. The server listens on port 3000 unless the `PORT` environment
variable is set before the task runs.

## Tech stack

- Node.js + Express
- better-sqlite3 (WAL mode)
- Vanilla HTML/CSS/JS (no frameworks, no build step)
- Windows Scheduled Task

## License

MIT
