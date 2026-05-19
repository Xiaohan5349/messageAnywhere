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

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// Placeholder API routes (filled in later tasks)
app.get('/api/messages', (req, res) => {
  res.json({ messages: [] });
});

app.post('/api/messages', (req, res) => {
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

  const stmt = db.prepare('INSERT INTO messages (text, device_name) VALUES (?, ?)');
  const result = stmt.run(text.trim(), device_name.trim());

  res.status(201).json({
    id: result.lastInsertRowid,
    created_at: new Date().toISOString()
  });
});

app.delete('/api/messages/:id', (req, res) => {
  res.status(501).json({ error: 'not implemented' });
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
