const { getDb } = require('./connection');

function runMigrations(db = getDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'succeeded', 'failed', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL,
      last_error TEXT,
      run_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      idempotency_key TEXT NOT NULL UNIQUE,
      result TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency_key ON jobs(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, run_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_stuck ON jobs(status, started_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  `);
}

if (require.main === module) {
  console.log('Running database migrations...');
  runMigrations();
  console.log('Migrations completed successfully.');
}

module.exports = { runMigrations };
