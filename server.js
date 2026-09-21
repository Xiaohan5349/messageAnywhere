const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const HISTORY_DIR = path.join(ROOT, 'history');
const DB_PATH = path.join(ROOT, 'messages.db');

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ORIGINAL_NAME = 255;
const RETENTION_DAYS = 7;

// The stored filename must never derive from the client-supplied originalname:
// multer writes every file as <uuid>.bin, then we sniff the real format and
// rename to the matching extension. A spoofed image/png mimetype with an .html
// or .svg originalname therefore cannot become same-origin text/html or
// scriptable SVG, whatever the extension allowlist would have permitted.
const IMAGE_TYPES = [
  { ext: '.png',  mime: 'image/png',  test: b => b.length > 7 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: '.jpg',  mime: 'image/jpeg', test: b => b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.gif',  mime: 'image/gif',  test: b => b.length > 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { ext: '.webp', mime: 'image/webp', test: b => b.length > 11 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { ext: '.bmp',  mime: 'image/bmp',  test: b => b.length > 1 && b[0] === 0x42 && b[1] === 0x4d },
];

function sniffImageType(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    const head = buf.subarray(0, fs.readSync(fd, buf, 0, 16, 0));
    return IMAGE_TYPES.find(t => t.test(head)) || null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function removeFiles(files) {
  for (const file of files || []) {
    try { fs.unlinkSync(file.path); } catch {}
  }
}

// Renames each <uuid>.bin to <uuid>.<real-ext> and returns DB-ready records.
// Returns null when any file is not a real image (the offending file is removed).
function finalizeImages(files) {
  const out = [];
  for (const file of files) {
    const type = sniffImageType(file.path);
    if (!type) {
      removeFiles([file]);
      return null;
    }
    const filename = path.basename(file.path, '.bin') + type.ext;
    const finalPath = path.join(UPLOADS_DIR, filename);
    if (finalPath !== file.path) fs.renameSync(file.path, finalPath);
    out.push({
      path: finalPath,
      filename,
      original_name: String(file.originalname || '').slice(0, MAX_ORIGINAL_NAME),
      mime_type: type.mime,
      size: file.size,
    });
  }
  return out;
}

// Init database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT NOT NULL,
    device_name TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS images (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    filename      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size          INTEGER NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.bin')
  }),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// Message expiry cleanup: archive messages older than 7 days to history/ then delete from DB.
// created_at is stored as ISO-8601 with a 'T' separator, so the cutoff must use the
// same shape — comparing against datetime()'s space-separated form silently made
// every message created on the cutoff date survive for an extra day.
function cleanupExpired() {
  try {
    const cutoff = `strftime('%Y-%m-%dT%H:%M:%S','now','-${RETENTION_DAYS} days')`;
    // Query expired messages with their images
    const expired = db.prepare(`
      SELECT m.id, m.text, m.device_name, m.created_at,
             i.filename, i.original_name, i.mime_type, i.size
      FROM messages m
      LEFT JOIN images i ON i.message_id = m.id
      WHERE m.created_at < ${cutoff}
      ORDER BY m.id ASC, i.id ASC
    `).all();

    if (expired.length === 0) return;

    // Group images by message
    const byMsg = {};
    for (const row of expired) {
      if (!byMsg[row.id]) {
        byMsg[row.id] = { id: row.id, text: row.text, device_name: row.device_name, created_at: row.created_at, images: [] };
      }
      if (row.filename) {
        byMsg[row.id].images.push({ filename: row.filename, original_name: row.original_name, mime_type: row.mime_type, size: row.size });
      }
    }

    // Archive to history file (one file per day)
    const today = new Date().toISOString().slice(0, 10);
    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const logPath = path.join(HISTORY_DIR, today + '.log');
    const lines = [];
    for (const msg of Object.values(byMsg)) {
      lines.push('='.repeat(60));
      lines.push(`${msg.created_at} | ${msg.device_name}`);
      if (msg.text) lines.push(msg.text);
      for (const img of msg.images) {
        lines.push(`  [image: ${img.filename} — ${img.original_name}, ${img.mime_type}, ${img.size} bytes]`);
      }
      lines.push('='.repeat(60));
    }
    fs.appendFileSync(logPath, lines.join('\n') + '\n', 'utf-8');

    // Delete expired messages from DB (CASCADE removes image rows, files stay on disk)
    const ids = [...new Set(expired.map(r => r.id))];
    const placeholders = ids.map(() => '?').join(',');
    const result = db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);

    console.log(`Archived and removed ${result.changes} expired message(s) to ${logPath}`);
  } catch (err) {
    console.error('cleanupExpired failed:', err.message);
  }
}

// Uploaded files are deliberately never deleted when a message expires — the
// history/ archive only records the filename, so the file has to stay for the
// archive reference to stay resolvable. That leaves two classes of file with no
// DB row: archive-retained (recorded in history/) and genuinely orphaned
// (rejected uploads that multer wrote before business validation failed).
// Only the second class is safe to reclaim.
function pruneOrphanUploads() {
  if (process.env.PRUNE_ORPHANS === '0') return;
  let archived;
  try {
    archived = new Set();
    if (fs.existsSync(HISTORY_DIR)) {
      for (const name of fs.readdirSync(HISTORY_DIR)) {
        const text = fs.readFileSync(path.join(HISTORY_DIR, name), 'utf8');
        for (const m of text.matchAll(/\[image: ([0-9a-fA-F-]{36}\.[a-z0-9]+)/g)) archived.add(m[1]);
      }
    }
  } catch (err) {
    console.error('pruneOrphanUploads skipped, archive unreadable:', err.message);
    return;
  }

  const referenced = new Set(db.prepare('SELECT filename FROM images').all().map(r => r.filename));
  let removed = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(UPLOADS_DIR)) {
    if (referenced.has(name) || archived.has(name)) continue;
    const filePath = path.join(UPLOADS_DIR, name);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      fs.unlinkSync(filePath);
      removed++;
      bytes += stat.size;
    } catch {}
  }
  if (removed > 0) console.log(`Pruned ${removed} orphaned upload(s), ${(bytes / 1048576).toFixed(1)} MB`);
}

// Run on startup (catch up after server was off)
cleanupExpired();
pruneOrphanUploads();

// Then every hour
setInterval(cleanupExpired, 60 * 60 * 1000);

// Serve static files from public/ and uploads/
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', (req, res, next) => {
  // Defense in depth: even a mis-stored file must not execute as a document.
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  next();
}, express.static(UPLOADS_DIR));

// Attach image metadata to message objects
function attachImages(messages) {
  if (messages.length === 0) return messages;
  const ids = messages.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const imgStmt = db.prepare(
    `SELECT id, message_id, filename, original_name, mime_type, size
     FROM images WHERE message_id IN (${placeholders}) ORDER BY id ASC`
  );
  const allImages = imgStmt.all(...ids);
  const byMsg = {};
  for (const img of allImages) {
    if (!byMsg[img.message_id]) byMsg[img.message_id] = [];
    byMsg[img.message_id].push({
      id: img.id,
      url: '/uploads/' + img.filename,
      original_name: img.original_name,
      mime_type: img.mime_type,
      size: img.size
    });
  }
  return messages.map(m => ({ ...m, images: byMsg[m.id] || [] }));
}

// Polling hits the same URLs every 3s; a cached response would freeze the feed.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/api/messages', (req, res) => {
  if (req.query.since !== undefined) {
    const raw = req.query.since;
    if (Array.isArray(raw) || !/^\d+$/.test(raw)) {
      return res.status(400).json({ error: 'since must be a positive integer' });
    }
  }
  if (req.query.device !== undefined && (Array.isArray(req.query.device) || typeof req.query.device !== 'string')) {
    return res.status(400).json({ error: 'device must be a single string' });
  }

  const since = req.query.since ? parseInt(req.query.since, 10) : 0;
  const device = req.query.device || null;

  let messages;
  if (since > 0) {
    if (device) {
      const stmt = db.prepare(
        'SELECT id, text, device_name, created_at FROM messages WHERE id > ? AND device_name = ? ORDER BY id ASC LIMIT 200'
      );
      messages = stmt.all(since, device);
    } else {
      const stmt = db.prepare(
        'SELECT id, text, device_name, created_at FROM messages WHERE id > ? ORDER BY id ASC LIMIT 200'
      );
      messages = stmt.all(since);
    }
  } else {
    if (device) {
      const stmt = db.prepare(
        'SELECT id, text, device_name, created_at FROM messages WHERE device_name = ? ORDER BY id DESC LIMIT 200'
      );
      messages = stmt.all(device).reverse();
    } else {
      const stmt = db.prepare(
        'SELECT id, text, device_name, created_at FROM messages ORDER BY id DESC LIMIT 200'
      );
      messages = stmt.all().reverse();
    }
  }

  res.json({ messages: attachImages(messages) });
});

app.post('/api/messages', upload.array('images', MAX_IMAGES), (req, res, next) => {
  const files = req.files || [];
  const isMultipart = files.length > 0;
  const text = req.body ? (req.body.text || '') : '';
  const device_name = req.body ? (req.body.device_name || '') : '';

  // Multer already unlinks files when it fails on its own; these are the
  // business-validation paths where the bytes are already on disk.
  const fail = (status, message) => {
    removeFiles(files);
    return res.status(status).json({ error: message });
  };

  // Validate device_name (required for both paths)
  if (typeof device_name !== 'string' || device_name.trim().length === 0) {
    return fail(400, 'device_name is required');
  }
  if (device_name.length > 50) {
    return fail(400, 'device_name exceeds 50 characters');
  }
  if (typeof text !== 'string') {
    return fail(400, 'text must be a string');
  }

  // JSON path (text-only, backward compat — no files attached)
  if (!isMultipart) {
    if (text.trim().length === 0) {
      return fail(400, 'text is required');
    }
    if (text.length > 10000) {
      return fail(400, 'text exceeds 10,000 characters');
    }
    const now = new Date().toISOString();
    const stmt = db.prepare('INSERT INTO messages (text, device_name, created_at) VALUES (?, ?, ?)');
    const result = stmt.run(text.trim(), device_name.trim(), now);
    return res.status(201).json({ id: result.lastInsertRowid, created_at: now, images: [] });
  }

  // Multipart path (with images)
  const trimmedText = text.trim();
  if (!trimmedText && files.length === 0) {
    return fail(400, 'text or images is required');
  }
  if (trimmedText.length > 10000) {
    return fail(400, 'text exceeds 10,000 characters');
  }

  const images = finalizeImages(files);
  if (!images) {
    return fail(400, 'uploaded files are not valid images');
  }

  const now = new Date().toISOString();
  const insertMsg = db.prepare('INSERT INTO messages (text, device_name, created_at) VALUES (?, ?, ?)');
  const insertImg = db.prepare('INSERT INTO images (message_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)');

  const txn = db.transaction(() => {
    const result = insertMsg.run(trimmedText, device_name.trim(), now);
    const messageId = result.lastInsertRowid;
    const imageRecords = [];
    for (const img of images) {
      const imgResult = insertImg.run(messageId, img.filename, img.original_name, img.mime_type, img.size);
      imageRecords.push({
        id: imgResult.lastInsertRowid,
        url: '/uploads/' + img.filename,
        original_name: img.original_name,
        mime_type: img.mime_type,
        size: img.size
      });
    }
    return { messageId, imageRecords };
  });

  try {
    const { messageId, imageRecords } = txn();
    res.status(201).json({ id: messageId, created_at: now, images: imageRecords });
  } catch (err) {
    removeFiles(images);
    next(err);
  }
});

app.put('/api/messages/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  if (!req.body) {
    return res.status(400).json({ error: 'request body required' });
  }

  const { text } = req.body;

  if (typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }
  if (text.length > 10000) {
    return res.status(400).json({ error: 'text exceeds 10,000 characters' });
  }

  const existing = db.prepare('SELECT id FROM messages WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'not found' });
  }

  // An image-only message is allowed to have empty text; a text-less, image-less
  // one is not.
  const imageCount = db.prepare('SELECT COUNT(*) AS c FROM images WHERE message_id = ?').get(id).c;
  if (text.trim().length === 0 && imageCount === 0) {
    return res.status(400).json({ error: 'text is required' });
  }

  const stmt = db.prepare('UPDATE messages SET text = ? WHERE id = ?');
  stmt.run(text.trim(), id);

  const updated = db.prepare('SELECT id, text, device_name, created_at FROM messages WHERE id = ?').get(id);
  res.json(attachImages([updated])[0]);
});

app.delete('/api/messages/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const stmt = db.prepare('DELETE FROM messages WHERE id = ?');
  const result = stmt.run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'not found' });
  }

  res.status(204).send();
});

// Multer error handler
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `image exceeds ${MAX_IMAGE_BYTES / 1048576} MB limit` });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: `too many images (max ${MAX_IMAGES})` });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: `unexpected file field (use "images", max ${MAX_IMAGES})` });
  }
  if (err.message === 'Only image files are allowed') {
    return res.status(400).json({ error: 'only image files are allowed' });
  }
  next(err);
});

// Error handler
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON' });
  }
  console.error(err.stack);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`MessageAnywhere server running on http://localhost:${PORT}`);
});
