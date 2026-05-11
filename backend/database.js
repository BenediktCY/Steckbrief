const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'steckbrief.db');
let db;

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canify_id INTEGER UNIQUE,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      rolle TEXT NOT NULL DEFAULT 'Mitarbeiter',
      aktiv INTEGER NOT NULL DEFAULT 1,
      sync_am TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fragen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reihenfolge INTEGER NOT NULL DEFAULT 0,
      typ TEXT NOT NULL,
      frage TEXT NOT NULL,
      einheit TEXT,
      optionen TEXT,
      pflicht INTEGER NOT NULL DEFAULT 1,
      aktiv INTEGER NOT NULL DEFAULT 1,
      erstellt_von INTEGER,
      erstellt_am TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (erstellt_von) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS stammdaten (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL,
      wert TEXT NOT NULL,
      aktiv INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS eintraege (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      lieferant TEXT NOT NULL,
      sorte TEXT NOT NULL,
      thc_klasse TEXT NOT NULL,
      interne_nr TEXT NOT NULL,
      abgeschlossen INTEGER NOT NULL DEFAULT 0,
      erstellt_am TEXT NOT NULL DEFAULT (datetime('now')),
      abgeschlossen_am TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS antworten (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eintrag_id INTEGER NOT NULL,
      frage_id INTEGER NOT NULL,
      wert TEXT,
      erstellt_am TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (eintrag_id) REFERENCES eintraege(id),
      FOREIGN KEY (frage_id) REFERENCES fragen(id)
    );
  `);

  // Standardfragen anlegen wenn leer
  const fragenCount = db.exec('SELECT COUNT(*) FROM fragen')[0];
  if (!fragenCount || fragenCount.values[0][0] === 0) {
    const defaultFragen = [
      { reihenfolge: 1, typ: 'rating', frage: 'Visuelle Prüfung: Farbe & Erscheinungsbild der Blüten', optionen: JSON.stringify(['Mangelhaft','Ausreichend','Gut','Sehr gut']) },
      { reihenfolge: 2, typ: 'rating', frage: 'Geruchsprüfung: Aroma & Terpenprofil', optionen: JSON.stringify(['Mangelhaft','Ausreichend','Gut','Sehr gut']) },
      { reihenfolge: 3, typ: 'select', frage: 'Sind Verunreinigungen oder Fremdkörper erkennbar?', optionen: JSON.stringify(['Keine','Geringfügig','Deutlich']) },
      { reihenfolge: 4, typ: 'rating', frage: 'Feuchtigkeit / Trocknungsgrad', optionen: JSON.stringify(['Zu feucht','Leicht feucht','Optimal','Leicht trocken','Zu trocken']) },
      { reihenfolge: 5, typ: 'select', frage: 'Trichom-Zustand (unter Lupe/Mikroskop)', optionen: JSON.stringify(['Klar','Milchig','Bernstein','Gemischt']) },
      { reihenfolge: 6, typ: 'yesno', frage: 'Verpackung unbeschädigt und korrekt beschriftet?', optionen: null },
      { reihenfolge: 7, typ: 'yesno', frage: 'Gewicht innerhalb der Toleranz?', optionen: null },
      { reihenfolge: 8, typ: 'yesno', frage: 'Stimmen Chargennummer auf Verpackung und Lieferschein überein?', optionen: null },
      { reihenfolge: 9, typ: 'number', frage: 'Gemessene Restfeuchte', einheit: '%', optionen: null },
      { reihenfolge: 10, typ: 'textarea', frage: 'Bemerkungen / Auffälligkeiten', optionen: null, pflicht: 0 },
    ];
    defaultFragen.forEach(f => {
      db.run('INSERT INTO fragen (reihenfolge, typ, frage, einheit, optionen, pflicht) VALUES (?, ?, ?, ?, ?, ?)',
        [f.reihenfolge, f.typ, f.frage, f.einheit || null, f.optionen || null, f.pflicht !== undefined ? f.pflicht : 1]);
    });
  }

  // Standardstammdaten
  const stammdatenCount = db.exec('SELECT COUNT(*) FROM stammdaten')[0];
  if (!stammdatenCount || stammdatenCount.values[0][0] === 0) {
    const defaults = {
      anbauer: ['Aurora Cannabis','Tilray','Bedrocan','Canopy Growth','Demecan'],
      sorte: ['Bedrocan','Bedrobinol','Bediol','Bedica','Pedanios 22/1','Pedanios 20/1','Red No 4'],
      thc_klasse: ['18/1','20/1','22/1','25/1','10/10','1/20','5/8'],
    };
    Object.entries(defaults).forEach(([typ, werte]) => {
      werte.forEach(w => db.run('INSERT INTO stammdaten (typ, wert) VALUES (?, ?)', [typ, w]));
    });
  }

  // Migrationen für bestehende Datenbanken
  try { db.run("ALTER TABLE eintraege ADD COLUMN interne_nr TEXT"); } catch(e) {}
  try { db.run("UPDATE eintraege SET interne_nr = charge WHERE interne_nr IS NULL AND charge IS NOT NULL"); } catch(e) {}
  try { db.run("UPDATE stammdaten SET typ = 'anbauer' WHERE typ = 'lieferant'"); } catch(e) {}
  // Tabelle bereinigen: NOT NULL entfernen, charge-Spalte konsolidieren
  try {
    const info = db.exec("PRAGMA table_info(eintraege)")[0];
    if (info) {
      const cols = info.values.map(r => r[1]);
      if (cols.includes('charge')) {
        db.run(`CREATE TABLE eintraege_clean (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          anbauer TEXT, sorte TEXT, thc_klasse TEXT, interne_nr TEXT,
          abgeschlossen INTEGER NOT NULL DEFAULT 0,
          erstellt_am TEXT NOT NULL DEFAULT (datetime('now')),
          abgeschlossen_am TEXT
        )`);
        const src = cols.includes('anbauer') ? 'anbauer' : 'lieferant';
        const nr  = cols.includes('interne_nr') ? 'COALESCE(interne_nr, charge)' : 'charge';
        db.run(`INSERT INTO eintraege_clean SELECT id, user_id, ${src}, sorte, thc_klasse, ${nr}, abgeschlossen, erstellt_am, abgeschlossen_am FROM eintraege`);
        db.run('DROP TABLE eintraege');
        db.run('ALTER TABLE eintraege_clean RENAME TO eintraege');
        console.log('Migration eintraege: NOT NULL + charge bereinigt.');
      }
    }
  } catch(e) { console.log('Migration eintraege:', e.message); }
  try { db.run("UPDATE users SET rolle = 'Admin' WHERE rolle = 'admin'"); } catch(e) {}
  try { db.run("UPDATE users SET rolle = 'Experte' WHERE rolle = 'experte'"); } catch(e) {}
  try { db.run("UPDATE users SET rolle = 'Mitarbeiter' WHERE rolle IN ('mitarbeiter','mitarbeiterin')"); } catch(e) {}

  save();
  return db;
}

function save() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function prepare(sql) {
  return {
    get: (...params) => {
      const flat = params.flat();
      const result = db.exec(sql, flat.length ? flat : undefined);
      if (!result[0]) return undefined;
      const row = result[0].values[0];
      if (!row) return undefined;
      return Object.fromEntries(result[0].columns.map((c, i) => [c, row[i]]));
    },
    all: (...params) => {
      const flat = params.flat();
      const result = db.exec(sql, flat.length ? flat : undefined);
      if (!result[0]) return [];
      return result[0].values.map(row => Object.fromEntries(result[0].columns.map((c, i) => [c, row[i]])));
    },
    run: (...params) => {
      const flat = params.flat();
      db.run(sql, flat.length ? flat : undefined);
      const lastId = db.exec('SELECT last_insert_rowid()')[0];
      save();
      return { lastInsertRowid: lastId ? lastId.values[0][0] : null };
    }
  };
}

module.exports = { initDb, prepare };
