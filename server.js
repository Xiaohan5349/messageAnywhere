const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const UPLOADS_DIR = path.join(ROOT, 'uploads');
// Documents live apart from images on purpose: uploads/ is served statically, so
// anything placed there has a second reachable path. files/ has no static route
// and is only reachable through the download handler below.
const FILES_DIR = path.join(ROOT, 'files');
const HISTORY_DIR = path.join(ROOT, 'history');
const DB_PATH = path.join(ROOT, 'messages.db');

const MAX_IMAGES = 10;
const MAX_FILES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ORIGINAL_NAME = 255;
const RETENTION_DAYS = 7;
// Attachments outlive their message by this long so a download does not have to
// happen within the message's own 7-day life.
const ATTACHMENT_RETENTION_DAYS = 30;

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
    // multer's limits.fileSize is global and now has to accommodate 50 MB
    // documents, so the image cap is enforced here instead.
    if (file.size > MAX_IMAGE_BYTES) {
      removeFiles([file]);
      return null;
    }
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

// Documents are delivered with Content-Disposition: attachment, so the stored
// extension is cosmetic and never decides how a browser renders the response.
// It is still sanitized so nothing odd reaches the filesystem.
function safeExtension(name) {
  const ext = path.extname(String(name || '')).toLowerCase()
    .replace(/^\./, '').replace(/[^a-z0-9]/g, '').slice(0, 10);
  return ext ? '.' + ext : '';
}

function finalizeDocuments(files) {
  return files.map(file => ({
    path: file.path,
    filename: path.basename(file.path),
    original_name: String(file.originalname || '').slice(0, MAX_ORIGINAL_NAME),
    mime_type: file.mimetype || 'application/octet-stream',
    size: file.size,
  }));
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

// images -> attachments. The row has to outlive its message so it can remember
// when the file should leave disk, which the old NOT NULL / ON DELETE CASCADE
// made impossible. Idempotent: only runs when the old table is still present.
(function migrateAttachments() {
  const table = name => db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  if (!table('images') || table('attachments')) return;

  // VACUUM INTO, not a file copy: WAL mode keeps recent pages outside the main
  // DB file, so a copy would snapshot stale data.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(ROOT, 'messages.db.bak-' + stamp);
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);

  const before = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
  const txn = db.transaction(() => {
    db.exec(`
      CREATE TABLE attachments (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id     INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        kind           TEXT NOT NULL,
        filename       TEXT NOT NULL,
        original_name  TEXT NOT NULL,
        mime_type      TEXT NOT NULL,
        size           INTEGER NOT NULL,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        disk_expire_at TEXT
      )
    `);
    db.exec(`
      INSERT INTO attachments (id, message_id, kind, filename, original_name, mime_type, size, created_at, disk_expire_at)
      SELECT id, message_id, 'image', filename, original_name, mime_type, size, created_at, NULL FROM images
    `);
    db.exec('DROP TABLE images');
    db.exec('CREATE INDEX idx_attachments_message ON attachments(message_id)');
  });
  txn();

  const after = db.prepare('SELECT COUNT(*) AS c FROM attachments').get().c;
  if (before !== after) {
    throw new Error(`attachment migration lost rows: ${before} -> ${after}; backup at ${backup}`);
  }
  console.log(`Migrated ${after} image row(s) to attachments; backup at ${path.basename(backup)}`);
})();

db.exec(`
  CREATE TABLE IF NOT EXISTS attachments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id     INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    kind           TEXT NOT NULL,
    filename       TEXT NOT NULL,
    original_name  TEXT NOT NULL,
    mime_type      TEXT NOT NULL,
    size           INTEGER NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    disk_expire_at TEXT
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id)');

for (const dir of [UPLOADS_DIR, FILES_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, file.fieldname === 'files' ? FILES_DIR : UPLOADS_DIR),
    filename: (req, file, cb) => {
      if (file.fieldname === 'files') cb(null, crypto.randomUUID() + safeExtension(file.originalname));
      else cb(null, crypto.randomUUID() + '.bin');
    }
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_IMAGES + MAX_FILES },
  fileFilter: (req, file, cb) => {
    // Documents accept any type: the download route forces attachment, so the
    // content never has to be a safely renderable format.
    if (file.fieldname === 'files') return cb(null, true);
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
    const expired = db.prepare(`
      SELECT m.id, m.text, m.device_name, m.created_at,
             a.kind, a.filename, a.original_name, a.mime_type, a.size
      FROM messages m
      LEFT JOIN attachments a ON a.message_id = m.id
      WHERE m.created_at < ${cutoff}
      ORDER BY m.id ASC, a.id ASC
    `).all();

    if (expired.length === 0) return;

    const byMsg = {};
    for (const row of expired) {
      if (!byMsg[row.id]) {
        byMsg[row.id] = { id: row.id, text: row.text, device_name: row.device_name, created_at: row.created_at, attachments: [] };
      }
      if (row.filename) byMsg[row.id].attachments.push(row);
    }

    const today = new Date().toISOString().slice(0, 10);
    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const logPath = path.join(HISTORY_DIR, today + '.log');
    const lines = [];
    for (const msg of Object.values(byMsg)) {
      lines.push('='.repeat(60));
      lines.push(`${msg.created_at} | ${msg.device_name}`);
      if (msg.text) lines.push(msg.text);
      for (const a of msg.attachments) {
        lines.push(`  [${a.kind}: ${a.filename} — ${a.original_name}, ${a.mime_type}, ${a.size} bytes]`);
      }
      lines.push('='.repeat(60));
    }
    fs.appendFileSync(logPath, lines.join('\n') + '\n', 'utf-8');

    // The attachment rows must survive the message so they can schedule their own
    // removal from disk. Must happen before the delete, because the FK's
    // ON DELETE SET NULL fires during it.
    const ids = [...new Set(expired.map(r => r.id))];
    const placeholders = ids.map(() => '?').join(',');
    const diskExpireAt = new Date(Date.now() + ATTACHMENT_RETENTION_DAYS * 86400000).toISOString();
    db.prepare(
      `UPDATE attachments SET disk_expire_at = ? WHERE message_id IN (${placeholders}) AND disk_expire_at IS NULL`
    ).run(diskExpireAt, ...ids);

    const result = db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);

    console.log(`Archived and removed ${result.changes} expired message(s) to ${logPath}`);
  } catch (err) {
    console.error('cleanupExpired failed:', err.message);
  }
}

// Second half of the lifecycle: once disk_expire_at has passed, the file is of no
// use to anyone and the archive only kept its metadata, so remove both.
function cleanupExpiredAttachments() {
  try {
    // Computed in JS rather than passed as a SQL expression: binding
    // strftime(...) as a parameter compares against the literal text
    // "strftime(...)", which every ISO timestamp sorts below.
    const cutoff = new Date().toISOString().slice(0, 19);
    const rows = db.prepare(
      'SELECT kind, filename FROM attachments WHERE disk_expire_at IS NOT NULL AND disk_expire_at < ?'
    ).all(cutoff);
    for (const row of rows) {
      const dir = row.kind === 'file' ? FILES_DIR : UPLOADS_DIR;
      try { fs.unlinkSync(path.join(dir, row.filename)); } catch {}
      db.prepare('DELETE FROM attachments WHERE filename = ?').run(row.filename);
    }
    if (rows.length > 0) console.log(`Removed ${rows.length} expired attachment file(s) from disk`);
  } catch (err) {
    console.error('cleanupExpiredAttachments failed:', err.message);
  }
}

// Attachments outlive their message by ATTACHMENT_RETENTION_DAYS, so the file
// stays resolvable for a while after the archive entry is written. Files with no
// DB row fall into two classes: still inside that window (they have a row, so
// they are not here) and genuinely orphaned — rejected uploads that multer wrote
// before business validation failed. Only the second class is safe to reclaim,
// and the history/ mention check protects archive-referenced names as a fallback.
function pruneOrphanAttachments() {
  if (process.env.PRUNE_ORPHANS === '0') return;
  let archived;
  try {
    archived = new Set();
    if (fs.existsSync(HISTORY_DIR)) {
      for (const name of fs.readdirSync(HISTORY_DIR)) {
        const text = fs.readFileSync(path.join(HISTORY_DIR, name), 'utf8');
        for (const m of text.matchAll(/\[(?:image|file): ([0-9a-fA-F-]{36}\.[a-z0-9]*)/g)) archived.add(m[1]);
      }
    }
  } catch (err) {
    console.error('pruneOrphanAttachments skipped, archive unreadable:', err.message);
    return;
  }

  const referenced = new Set(db.prepare('SELECT filename FROM attachments').all().map(r => r.filename));
  let removed = 0;
  let bytes = 0;
  for (const [dir, label] of [[UPLOADS_DIR, 'uploads'], [FILES_DIR, 'files']]) {
    for (const name of fs.readdirSync(dir)) {
      if (referenced.has(name) || archived.has(name)) continue;
      const filePath = path.join(dir, name);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        fs.unlinkSync(filePath);
        removed++;
        bytes += stat.size;
      } catch {}
    }
  }
  if (removed > 0) console.log(`Pruned ${removed} orphaned attachment(s) from disk, ${(bytes / 1048576).toFixed(1)} MB`);
}

// Run on startup (catch up after server was off)
cleanupExpired();
cleanupExpiredAttachments();
pruneOrphanAttachments();

// Then every hour
setInterval(cleanupExpired, 60 * 60 * 1000);
setInterval(cleanupExpiredAttachments, 60 * 60 * 1000);

// Serve static files from public/ and uploads/
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', (req, res, next) => {
  // Defense in depth: even a mis-stored file must not execute as a document.
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  next();
}, express.static(UPLOADS_DIR));

// Documents are never served statically. Content-Disposition: attachment is what
// keeps an uploaded .html or .svg from rendering in this origin — if this route
// ever changes to sendFile or a static mount appears for files/, that protection
// disappears silently.
app.get('/files/:filename', (req, res) => {
  const row = db.prepare(
    'SELECT kind, original_name FROM attachments WHERE filename = ?').get(req.params.filename);
  if (!row || row.kind !== 'file') return res.status(404).json({ error: 'not found' });

  // req.params is URL-decoded, so a traversal sequence has to be rejected here
  // even though the DB lookup above already fails to match one.
  const filePath = path.join(FILES_DIR, req.params.filename);
  if (path.resolve(filePath) !== path.join(FILES_DIR, req.params.filename)) {
    return res.status(404).json({ error: 'not found' });
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file missing' });

  // res.download builds Content-Disposition with the content-disposition package,
  // which escapes quotes and emits filename*=UTF-8''… for non-ASCII names.
  // dotfiles:'allow' because send inspects the whole resolved path: a project
  // installed under any dot-prefixed directory would otherwise 404 on download.
  // The filename half of that path is always a DB-validated stored name.
  res.download(filePath, row.original_name, {
    dotfiles: 'allow',
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'"
    }
  });
});

// Attach image and document metadata to message objects
function attachAttachments(messages) {
  if (messages.length === 0) return messages;
  const ids = messages.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, message_id, kind, filename, original_name, mime_type, size
     FROM attachments WHERE message_id IN (${placeholders}) ORDER BY id ASC`
  ).all(...ids);
  const byMsg = {};
  for (const row of rows) {
    if (!byMsg[row.message_id]) byMsg[row.message_id] = { images: [], files: [] };
    const record = {
      id: row.id,
      url: (row.kind === 'file' ? '/files/' : '/uploads/') + row.filename,
      original_name: row.original_name,
      mime_type: row.mime_type,
      size: row.size,
    };
    byMsg[row.message_id][row.kind === 'file' ? 'files' : 'images'].push(record);
  }
  return messages.map(m => ({
    ...m,
    images: (byMsg[m.id] || {}).images || [],
    files: (byMsg[m.id] || {}).files || [],
  }));
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

  res.json({ messages: attachAttachments(messages) });
});

app.post('/api/messages', upload.fields([
  { name: 'images', maxCount: MAX_IMAGES },
  { name: 'files', maxCount: MAX_FILES },
]), (req, res, next) => {
  // upload.fields() groups by field name rather than returning a flat array.
  const uploaded = req.files || {};
  const imageFiles = uploaded.images || [];
  const docFiles = uploaded.files || [];
  const allFiles = [...imageFiles, ...docFiles];
  const isMultipart = allFiles.length > 0;
  const text = req.body ? (req.body.text || '') : '';
  const device_name = req.body ? (req.body.device_name || '') : '';

  // Multer already unlinks files when it fails on its own; these are the
  // business-validation paths where the bytes are already on disk.
  const fail = (status, message) => {
    removeFiles(allFiles);
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
    return res.status(201).json({ id: result.lastInsertRowid, created_at: now, images: [], files: [] });
  }

  // Multipart path (with images and/or documents)
  const trimmedText = text.trim();
  if (!trimmedText && allFiles.length === 0) {
    return fail(400, 'text, images or files is required');
  }
  if (trimmedText.length > 10000) {
    return fail(400, 'text exceeds 10,000 characters');
  }

  const images = finalizeImages(imageFiles);
  if (!images) {
    removeFiles(docFiles);
    return fail(400, 'uploaded files are not valid images');
  }
  const documents = finalizeDocuments(docFiles);
  const attachments = [
    ...images.map(a => ({ ...a, kind: 'image' })),
    ...documents.map(a => ({ ...a, kind: 'file' })),
  ];

  const now = new Date().toISOString();
  const insertMsg = db.prepare('INSERT INTO messages (text, device_name, created_at) VALUES (?, ?, ?)');
  const insertAtt = db.prepare(
    'INSERT INTO attachments (message_id, kind, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)');

  const txn = db.transaction(() => {
    const result = insertMsg.run(trimmedText, device_name.trim(), now);
    const messageId = result.lastInsertRowid;
    const records = { images: [], files: [] };
    for (const att of attachments) {
      const r = insertAtt.run(messageId, att.kind, att.filename, att.original_name, att.mime_type, att.size);
      records[att.kind === 'file' ? 'files' : 'images'].push({
        id: r.lastInsertRowid,
        url: (att.kind === 'file' ? '/files/' : '/uploads/') + att.filename,
        original_name: att.original_name,
        mime_type: att.mime_type,
        size: att.size,
      });
    }
    return { messageId, records };
  });

  try {
    const { messageId, records } = txn();
    res.status(201).json({ id: messageId, created_at: now, ...records });
  } catch (err) {
    removeFiles(attachments);
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

  // An attachment-only message is allowed to have empty text; a text-less,
  // attachment-less one is not.
  const attachmentCount = db.prepare('SELECT COUNT(*) AS c FROM attachments WHERE message_id = ?').get(id).c;
  if (text.trim().length === 0 && attachmentCount === 0) {
    return res.status(400).json({ error: 'text is required' });
  }

  const stmt = db.prepare('UPDATE messages SET text = ? WHERE id = ?');
  stmt.run(text.trim(), id);

  const updated = db.prepare('SELECT id, text, device_name, created_at FROM messages WHERE id = ?').get(id);
  res.json(attachAttachments([updated])[0]);
});

app.delete('/api/messages/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  // Schedule the attachments' removal before deleting the message, for the same
  // reason cleanupExpired does: the FK sets message_id to NULL during the delete,
  // and a row that is gone cannot remember when its file should leave disk.
  const diskExpireAt = new Date(Date.now() + ATTACHMENT_RETENTION_DAYS * 86400000).toISOString();
  db.prepare('UPDATE attachments SET disk_expire_at = ? WHERE message_id = ? AND disk_expire_at IS NULL')
    .run(diskExpireAt, id);

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
    const limit = err.field === 'files' ? MAX_FILE_BYTES : MAX_IMAGE_BYTES;
    return res.status(413).json({ error: `file exceeds ${limit / 1048576} MB limit` });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: `too many attachments (max ${MAX_IMAGES} images and ${MAX_FILES} files)` });
  }
  // multer raises this for a field whose maxCount is exhausted, not only for an
  // unknown field name, so err.field tells the two apart.
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    const known = err.field === 'images' || err.field === 'files';
    const max = err.field === 'images' ? MAX_IMAGES : MAX_FILES;
    return res.status(known ? 413 : 400).json({
      error: known
        ? `too many ${err.field} (max ${max})`
        : 'unexpected file field (use "images" or "files")'
    });
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
