import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

function openUniqueIndex(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS ids (panoid TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, firstFile TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]', payload TEXT NOT NULL DEFAULT '') WITHOUT ROWID; CREATE TABLE IF NOT EXISTS conflicts (id INTEGER PRIMARY KEY, panoid TEXT NOT NULL, fingerprint TEXT NOT NULL, sourceFile TEXT NOT NULL, firstFile TEXT NOT NULL)");
  const get = db.prepare("SELECT panoid,fingerprint,firstFile,sources,payload FROM ids WHERE panoid = ?");
  const insert = db.prepare("INSERT INTO ids(panoid,fingerprint,firstFile,sources,payload) VALUES(?,?,?,?,?)");
  const update = db.prepare("UPDATE ids SET sources=? WHERE panoid=?");
  const conflict = db.prepare("INSERT INTO conflicts(panoid,fingerprint,sourceFile,firstFile) VALUES(?,?,?,?)");
  return {
    get(panoid) { const row = get.get(String(panoid)); return row ? { ...row, sources: JSON.parse(row.sources) } : null; },
    put({ panoid, fingerprint, sourceFile, payload }) {
      const id = String(panoid); const fp = String(fingerprint); const previous = get.get(id);
      if (!previous) { insert.run(id, fp, String(sourceFile), JSON.stringify([String(sourceFile)]), payload ? JSON.stringify(payload) : ""); return { status: "unique", firstFile: String(sourceFile) }; }
      const sources = JSON.parse(previous.sources); if (!sources.includes(String(sourceFile))) { sources.push(String(sourceFile)); update.run(JSON.stringify(sources), id); }
      if (previous.fingerprint === fp) return { status: "identical", firstFile: previous.firstFile, sources };
      conflict.run(id, fp, String(sourceFile), previous.firstFile);
      return { status: "conflict", firstFile: previous.firstFile, sources, previousPayload: previous.payload ? JSON.parse(previous.payload) : null };
    },
    stats() { return { uniquePanoids: Number(db.prepare("SELECT count(*) AS n FROM ids").get().n), exactDuplicates: Number(db.prepare("SELECT count(*) AS n FROM (SELECT panoid FROM conflicts WHERE fingerprint IN (SELECT fingerprint FROM ids) GROUP BY panoid)").get().n), differingDuplicates: Number(db.prepare("SELECT count(*) AS n FROM conflicts").get().n) }; },
    close() { db.close(); },
    db
  };
}

export { openUniqueIndex };
