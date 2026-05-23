const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Init database
const db = new Database('messages.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT NOT NULL,
    device_name TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const app = express();
app.use(express.json());

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

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

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

  res.json({ messages });
});

app.post('/api/messages', (req, res) => {
  if (!req.body) {
    return res.status(400).json({ error: 'request body required' });
  }

  const { text, device_name } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (text.length > 10000) {
    return res.status(400).json({ error: 'text exceeds 10,000 characters' });
  }
  if (!device_name || typeof device_name !== 'string' || device_name.trim().length === 0) {
    return res.status(400).json({ error: 'device_name is required' });
  }
  if (device_name.length > 50) {
    return res.status(400).json({ error: 'device_name exceeds 50 characters' });
  }

  const now = new Date().toISOString();
  const stmt = db.prepare('INSERT INTO messages (text, device_name, created_at) VALUES (?, ?, ?)');
  const result = stmt.run(text.trim(), device_name.trim(), now);

  res.status(201).json({
    id: result.lastInsertRowid,
    created_at: now
  });
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

  res.json({ id, text: text.trim() });
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
