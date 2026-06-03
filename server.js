const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const PORT = process.env.PORT || 3000;

// Init database
const db = new Database('messages.db');
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
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads'),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.bin';
      cb(null, crypto.randomUUID() + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// Message expiry cleanup: delete messages older than 7 days
function cleanupExpired() {
  try {
    const result = db.prepare(
      "DELETE FROM messages WHERE created_at < datetime('now', '-7 days')"
    ).run();
    if (result.changes > 0) {
      console.log(`Expired ${result.changes} message(s)`);
    }
  } catch (err) {
    console.error('cleanupExpired failed:', err.message);
  }
}

// Run on startup (catch up after server was off)
cleanupExpired();

// Then every hour
setInterval(cleanupExpired, 60 * 60 * 1000);

// Serve static files from public/ and uploads/
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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

app.get('/api/messages', (req, res) => {
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

app.post('/api/messages', upload.any(), (req, res, next) => {
  const isMultipart = req.files && req.files.length > 0;
  const text = req.body ? (req.body.text || '') : '';
  const device_name = req.body ? (req.body.device_name || '') : '';

  // Validate device_name (required for both paths)
  if (!device_name || typeof device_name !== 'string' || device_name.trim().length === 0) {
    return res.status(400).json({ error: 'device_name is required' });
  }
  if (device_name.length > 50) {
    return res.status(400).json({ error: 'device_name exceeds 50 characters' });
  }

  // JSON path (text-only, backward compat — no files attached)
  if (!isMultipart) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'text is required' });
    }
    if (text.length > 10000) {
      return res.status(400).json({ error: 'text exceeds 10,000 characters' });
    }
    const now = new Date().toISOString();
    const stmt = db.prepare('INSERT INTO messages (text, device_name, created_at) VALUES (?, ?, ?)');
    const result = stmt.run(text.trim(), device_name.trim(), now);
    return res.status(201).json({ id: result.lastInsertRowid, created_at: now, images: [] });
  }

  // Multipart path (with images)
  const trimmedText = text.trim();
  if (!trimmedText && req.files.length === 0) {
    return res.status(400).json({ error: 'text or images is required' });
  }
  if (trimmedText.length > 10000) {
    return res.status(400).json({ error: 'text exceeds 10,000 characters' });
  }

  const now = new Date().toISOString();
  const insertMsg = db.prepare('INSERT INTO messages (text, device_name, created_at) VALUES (?, ?, ?)');
  const insertImg = db.prepare('INSERT INTO images (message_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)');

  const txn = db.transaction(() => {
    const result = insertMsg.run(trimmedText, device_name.trim(), now);
    const messageId = result.lastInsertRowid;
    const imageRecords = [];
    for (const file of req.files) {
      const imgResult = insertImg.run(messageId, file.filename, file.originalname, file.mimetype, file.size);
      imageRecords.push({
        id: imgResult.lastInsertRowid,
        url: '/uploads/' + file.filename,
        original_name: file.originalname,
        mime_type: file.mimetype,
        size: file.size
      });
    }
    return { messageId, imageRecords };
  });

  try {
    const { messageId, imageRecords } = txn();
    res.status(201).json({ id: messageId, created_at: now, images: imageRecords });
  } catch (err) {
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

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (text.length > 10000) {
    return res.status(400).json({ error: 'text exceeds 10,000 characters' });
  }

  const stmt = db.prepare('UPDATE messages SET text = ? WHERE id = ?');
  const result = stmt.run(text.trim(), id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'not found' });
  }

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
    return res.status(413).json({ error: 'image exceeds 5 MB limit' });
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
