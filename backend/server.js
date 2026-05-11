const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { initDb, prepare } = require('./database');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const verify = crypto.scryptSync(password, salt, 64).toString('hex');
    return verify === hash;
  } catch { return false; }
}

initDb().then(() => {

  // Standard-Admin anlegen wenn kein lokaler Admin mit Passwort existiert
  const hasLocalAdmin = prepare("SELECT id FROM users WHERE password LIKE '%:%' AND rolle = 'Admin' AND aktiv = 1").get();
  const adminUserExists = prepare("SELECT id FROM users WHERE username = 'admin'").get();
  if (!hasLocalAdmin && !adminUserExists) {
    prepare('INSERT INTO users (username, password, rolle) VALUES (?, ?, ?)').run(
      'admin', hashPassword('admin123'), 'Admin'
    );
    console.log('Standard-Admin angelegt: Benutzer "admin", Passwort "admin123"');
    console.log('Bitte nach dem ersten Login das Passwort ändern!');
  }

  // ── USER-SYNC (von Canify gespiegelt) ─────────────────
  app.post('/api/sync-user', (req, res) => {
    const { canify_id, username, password, rolle } = req.body;
    if (!canify_id || !username) return res.status(400).json({ error: 'Pflichtfelder fehlen' });

    const existing = prepare('SELECT * FROM users WHERE canify_id = ?').get(canify_id);
    if (existing) {
      const neueRolle = rolle === 'pruefer' ? 'Admin' : existing.rolle || 'Mitarbeiter';
      prepare('UPDATE users SET username=?, aktiv=1, rolle=?, sync_am=datetime("now") WHERE canify_id=?')
        .run(username, neueRolle, canify_id);
    } else {
      const steckbriefRolle = rolle === 'pruefer' ? 'Admin' : 'Mitarbeiter';
      prepare('INSERT INTO users (canify_id, username, password, rolle) VALUES (?, ?, ?, ?)')
        .run(canify_id, username, password || '', steckbriefRolle);
    }
    const user = prepare('SELECT * FROM users WHERE canify_id = ?').get(canify_id);
    res.json({ id: user.id, username: user.username, rolle: user.rolle });
  });

  // ── AUTH ──────────────────────────────────────────────
  app.post('/api/login', (req, res) => {
    const { canify_id } = req.body;
    const user = prepare('SELECT * FROM users WHERE canify_id = ? AND aktiv = 1').get(canify_id);
    if (!user) return res.status(401).json({ error: 'Nicht autorisiert' });
    res.json({ id: user.id, username: user.username, rolle: user.rolle });
  });

  app.post('/api/login-local', (req, res) => {
    const { username, password } = req.body;
    if (!username || password === undefined) return res.status(400).json({ error: 'Felder fehlen' });
    const user = prepare('SELECT * FROM users WHERE username = ? AND aktiv = 1').get(username);
    if (!user || !verifyPassword(password, user.password))
      return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });
    res.json({ id: user.id, username: user.username, rolle: user.rolle });
  });

  // ── USERS ─────────────────────────────────────────────
  app.get('/api/users', (req, res) => {
    res.json(prepare('SELECT id, canify_id, username, rolle, aktiv FROM users ORDER BY username').all());
  });

  app.post('/api/users', (req, res) => {
    const { username, password, rolle } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Pflichtfelder fehlen' });
    const existing = prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(409).json({ error: 'Benutzername bereits vergeben' });
    const result = prepare('INSERT INTO users (username, password, rolle) VALUES (?, ?, ?)').run(
      username, hashPassword(password), rolle || 'Mitarbeiter'
    );
    res.json({ id: result.lastInsertRowid });
  });

  app.patch('/api/users/:id', (req, res) => {
    const user = prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
    if (req.body.username) {
      const conflict = prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(req.body.username, req.params.id);
      if (conflict) return res.status(409).json({ error: 'Benutzername bereits vergeben' });
    }
    const username = req.body.username ?? user.username;
    const rolle = req.body.rolle ?? user.rolle;
    const aktiv = req.body.aktiv !== undefined ? (req.body.aktiv ? 1 : 0) : user.aktiv;
    prepare('UPDATE users SET username=?, rolle=?, aktiv=? WHERE id=?').run(username, rolle, aktiv, req.params.id);
    res.json({ ok: true });
  });

  app.patch('/api/users/:id/password', (req, res) => {
    const { oldPassword, newPassword, adminReset } = req.body;
    if (!newPassword) return res.status(400).json({ error: 'Neues Passwort fehlt' });
    const user = prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
    if (!adminReset) {
      if (!verifyPassword(oldPassword || '', user.password))
        return res.status(401).json({ error: 'Altes Passwort falsch' });
    }
    prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(newPassword), req.params.id);
    res.json({ ok: true });
  });

  // ── STAMMDATEN ────────────────────────────────────────
  app.get('/api/stammdaten/:typ', (req, res) => {
    res.json(prepare('SELECT id, wert FROM stammdaten WHERE typ = ? AND aktiv = 1 ORDER BY wert').all(req.params.typ));
  });
  app.post('/api/stammdaten/:typ', (req, res) => {
    const { wert } = req.body;
    if (!wert) return res.status(400).json({ error: 'Wert fehlt' });
    const result = prepare('INSERT INTO stammdaten (typ, wert) VALUES (?, ?)').run(req.params.typ, wert);
    res.json({ id: result.lastInsertRowid });
  });
  app.delete('/api/stammdaten/:id', (req, res) => {
    prepare('UPDATE stammdaten SET aktiv = 0 WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── FRAGEN ────────────────────────────────────────────
  app.get('/api/fragen/inaktiv', (req, res) => {
    res.json(prepare('SELECT * FROM fragen WHERE aktiv = 0 ORDER BY reihenfolge').all());
  });
  app.get('/api/fragen', (req, res) => {
    res.json(prepare('SELECT * FROM fragen WHERE aktiv = 1 ORDER BY reihenfolge').all());
  });
  app.post('/api/fragen', (req, res) => {
    const { typ, frage, einheit, optionen, pflicht, reihenfolge, erstellt_von } = req.body;
    if (!typ || !frage) return res.status(400).json({ error: 'Pflichtfelder fehlen' });
    const result = prepare('INSERT INTO fragen (typ, frage, einheit, optionen, pflicht, reihenfolge, erstellt_von) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(typ, frage, einheit || null, optionen ? JSON.stringify(optionen) : null, pflicht !== false ? 1 : 0,
        reihenfolge || 999, erstellt_von || null);
    res.json({ id: result.lastInsertRowid });
  });
  app.patch('/api/fragen/:id', (req, res) => {
    const f = prepare('SELECT * FROM fragen WHERE id = ?').get(req.params.id);
    if (!f) return res.status(404).json({ error: 'Nicht gefunden' });
    prepare('UPDATE fragen SET typ=?, frage=?, einheit=?, optionen=?, pflicht=?, reihenfolge=?, aktiv=? WHERE id=?')
      .run(req.body.typ ?? f.typ, req.body.frage ?? f.frage, req.body.einheit ?? f.einheit,
        req.body.optionen ? JSON.stringify(req.body.optionen) : f.optionen,
        req.body.pflicht !== undefined ? (req.body.pflicht ? 1 : 0) : f.pflicht,
        req.body.reihenfolge ?? f.reihenfolge,
        req.body.aktiv !== undefined ? (req.body.aktiv ? 1 : 0) : f.aktiv,
        req.params.id);
    res.json({ ok: true });
  });
  app.delete('/api/fragen/:id', (req, res) => {
    prepare('UPDATE fragen SET aktiv = 0 WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── EINTRÄGE ──────────────────────────────────────────
  app.get('/api/eintraege', (req, res) => {
    const eintraege = prepare(`
      SELECT e.*, u.username FROM eintraege e
      LEFT JOIN users u ON e.user_id = u.id
      WHERE e.abgeschlossen = 1
      ORDER BY e.erstellt_am DESC
    `).all();
    res.json(eintraege);
  });

  app.get('/api/eintraege/:id', (req, res) => {
    const eintrag = prepare(`
      SELECT e.*, u.username FROM eintraege e
      LEFT JOIN users u ON e.user_id = u.id
      WHERE e.id = ?
    `).get(req.params.id);
    if (!eintrag) return res.status(404).json({ error: 'Nicht gefunden' });
    const antworten = prepare(`
      SELECT a.*, f.frage, f.typ, f.einheit FROM antworten a
      JOIN fragen f ON a.frage_id = f.id
      WHERE a.eintrag_id = ?
      ORDER BY f.reihenfolge
    `).all(req.params.id);
    res.json({ ...eintrag, antworten });
  });

  app.post('/api/eintraege', (req, res) => {
    const { user_id, anbauer, sorte, thc_klasse, interne_nr } = req.body;
    if (!user_id || !interne_nr)
      return res.status(400).json({ error: 'Interne Nummer fehlt' });
    const result = prepare('INSERT INTO eintraege (user_id, anbauer, sorte, thc_klasse, interne_nr) VALUES (?, ?, ?, ?, ?)')
      .run(user_id, anbauer || null, sorte || null, thc_klasse || null, interne_nr);
    res.json({ id: result.lastInsertRowid });
  });

  app.post('/api/eintraege/:id/antworten', (req, res) => {
    const { antworten } = req.body;
    if (!antworten?.length) return res.status(400).json({ error: 'Keine Antworten' });
    antworten.forEach(a => {
      const existing = prepare('SELECT id FROM antworten WHERE eintrag_id = ? AND frage_id = ?').get(req.params.id, a.frage_id);
      if (existing) {
        prepare('UPDATE antworten SET wert = ? WHERE id = ?').run(String(a.wert ?? ''), existing.id);
      } else {
        prepare('INSERT INTO antworten (eintrag_id, frage_id, wert) VALUES (?, ?, ?)').run(req.params.id, a.frage_id, String(a.wert ?? ''));
      }
    });
    res.json({ ok: true });
  });

  app.patch('/api/eintraege/:id/abschliessen', (req, res) => {
    prepare("UPDATE eintraege SET abgeschlossen = 1, abgeschlossen_am = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  });

  app.delete('/api/eintraege/:id', (req, res) => {
    prepare('DELETE FROM antworten WHERE eintrag_id = ?').run(req.params.id);
    prepare('DELETE FROM eintraege WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── EXPORT ────────────────────────────────────────────
  function buildExportData() {
    const eintraege = prepare(`SELECT e.*, u.username FROM eintraege e LEFT JOIN users u ON e.user_id = u.id WHERE e.abgeschlossen = 1 ORDER BY e.erstellt_am DESC`).all();
    const fragen = prepare('SELECT * FROM fragen WHERE aktiv = 1 ORDER BY reihenfolge').all();
    const headers = ['ID', 'Mitarbeiter', 'Datum', 'Anbauer', 'Sorte', 'THC-Klasse', 'Interne Nr.', ...fragen.map(f => f.frage)];
    const rows = eintraege.map(e => {
      const antworten = prepare('SELECT * FROM antworten WHERE eintrag_id = ?').all(e.id);
      const antwortMap = Object.fromEntries(antworten.map(a => [a.frage_id, a.wert]));
      return [e.id, e.username, e.erstellt_am, e.anbauer || '', e.sorte || '', e.thc_klasse || '', e.interne_nr || '', ...fragen.map(f => antwortMap[f.id] || '')];
    });
    return { headers, rows };
  }

  app.get('/api/export/csv', (req, res) => {
    const { headers, rows } = buildExportData();
    let csv = headers.join(';') + '\n';
    rows.forEach(row => {
      csv += row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="steckbrief-export.csv"');
    res.send('﻿' + csv);
  });

  app.get('/api/export/xlsx', (req, res) => {
    const { headers, rows } = buildExportData();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Steckbriefe');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="steckbrief-export.xlsx"');
    res.send(buf);
  });

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
  });

  const PORT = process.env.STECKBRIEF_PORT || 3002;
  const server = app.listen(PORT, () => console.log(`Steckbrief läuft auf http://localhost:${PORT}`));
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${PORT} belegt - beende alten Prozess...`);
      const { exec } = require('child_process');
      exec(`netstat -ano | findstr :${PORT}`, (e, stdout) => {
        const lines = (stdout || '').trim().split('\n');
        lines.forEach(line => {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && !isNaN(pid)) exec(`taskkill /PID ${pid} /F`, () => {});
        });
        setTimeout(() => app.listen(PORT, () => console.log(`Steckbrief läuft auf http://localhost:${PORT}`)), 800);
      });
    }
  });

}).catch(err => { console.error('Steckbrief DB Fehler:', err); process.exit(1); });
