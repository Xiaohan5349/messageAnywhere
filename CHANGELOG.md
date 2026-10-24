# Changelog

## Unreleased

### Added
- Star messages to keep them, with their photos and files, forever. Tap ☆ on any message; a Starred view (sidebar on desktop, ☆ in the header on phones) has its own sections and search
- Select mode to star or unstar many messages at once (⋯ → Select messages, or hold a message → Select)
- 5-second Undo after deleting a message
- Time left before expiry on each message, highlighted in the last day
- "Open on phone…" QR code for this PC's network address
- Right-hand rail on wide desktop windows: starred items, recent photos and files, and the QR code
- API: `?starred=1` on `GET /api/messages`, `PUT /api/messages/:id/star`, `PUT /api/stars`, `GET /api/qr`

### Changed
- Unstarring a message restarts its 7 days
- Downloads ask for confirmation first
- Wide desktop windows centre the message column

### Removed
- Expired messages are no longer archived to `history/`; star what you want to keep. Existing logs are left in place

### Security
- Starred messages cannot be deleted until unstarred (`DELETE` returns 409)
