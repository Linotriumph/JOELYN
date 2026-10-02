const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

let dbInstance = null;

function getDb(dbPath = config.databasePath) {
  if (dbInstance && dbPath === config.databasePath) {
    return dbInstance;
  }

  // Ensure parent directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // WAL mode for high concurrency read/writes across processes
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 10000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  if (dbPath === config.databasePath) {
    dbInstance = db;
  }

  return db;
}

module.exports = { getDb };
