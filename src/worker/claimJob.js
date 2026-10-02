const { getDb } = require('../db/connection');

/**
 * Atomically claims a single pending job ready to be processed.
 * Uses SQLite UPDATE ... RETURNING with subquery to guarantee mutual exclusion.
 *
 * @param {object} db - DatabaseSync instance
 * @param {number} now - Current timestamp (epoch ms)
 * @returns {object|null} The claimed job row or null if none available
 */
function claimNextJob(db = getDb(), now = Date.now()) {
  try {
    const claimStmt = db.prepare(`
      UPDATE jobs
      SET status = 'processing',
          started_at = ?,
          updated_at = ?
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'pending'
          AND run_at <= ?
        ORDER BY run_at ASC, created_at ASC
        LIMIT 1
      )
      RETURNING *;
    `);

    const row = claimStmt.get(now, now, now);
    return row || null;
  } catch (err) {
    // If database is temporarily busy due to concurrent process write, return null for next cycle
    if (err.message && err.message.includes('busy')) {
      return null;
    }
    throw err;
  }
}

module.exports = { claimNextJob };
