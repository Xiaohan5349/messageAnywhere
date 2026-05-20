# MessageAnywhere

Self-hosted, local-WiFi web app for sharing text messages across all your devices. No internet, no accounts, no setup — just open a browser.

## How it works

A single Node.js server runs on your Windows PC. All devices on the same WiFi open the page in their browser. Messages sync in real time via polling, with 7-day auto-expiry.

## Features

- Send text messages from any device on the same network
- Real-time sync across all open browsers (3-second polling)
- Tap to copy any message to clipboard
- Swipe left to delete
- Custom device name with auto-detection (iPhone, Android, Mac, Windows PC)
- Messages auto-expire after 7 days
- Auto-starts on Windows login via Scheduled Task

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) (18+)
- Windows PC (server host)
- Any device with a browser + same WiFi

### Install

```bash
git clone https://github.com/MessageAnywhere/messageAnywhere.git
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
.\setup-task.ps1 -Port 3000 -ProjectPath "C:\path\to\messageAnywhere"
```

Requires Administrator privileges. Creates a Scheduled Task that launches the server hidden at login.

## Tech stack

- Node.js + Express
- better-sqlite3 (WAL mode)
- Vanilla HTML/CSS/JS (no frameworks, no build step)
- Windows Scheduled Task

## License

MIT
