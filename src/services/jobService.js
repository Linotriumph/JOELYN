const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const config = require('../config');

class JobService {
  constructor(db = getDb()) {
    this.db = db;
  }

  /**
   * Calculate exponential backoff delay with random jitter.
   * delay = min(baseDelay * 2^(attempts - 1), maxDelay) + random_jitter
   */
  calculateBackoffWithJitter(attempts, baseDelay = config.retryBaseDelayMs, maxDelay = config.retryMaxDelayMs, jitterRatio = config.retryJitterRatio) {
    // attempts is 1 for the first retry, 2 for second, etc.
    const exponent = Math.max(0, attempts - 1);
    const exponentialDelay = Math.min(baseDelay * Math.pow(2, exponent), maxDelay);
    const jitter = Math.floor(Math.random() * jitterRatio * exponentialDelay);
    return exponentialDelay + jitter;
  }

  /**
   * Enqueue a new background job with an Idempotency Key.
   * If a job with the idempotency key already exists, returns the existing job.
   */
  enqueueJob({
    type = 'generate_pdf',
    payload = {},
    idempotencyKey,
    maxAttempts = config.maxJobAttempts,
    runAt = Date.now(),
  }) {
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      const error = new Error('Idempotency-Key is required');
      error.statusCode = 400;
      throw error;
    }

    const now = Date.now();
    const id = crypto.randomUUID();
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

    try {
      const insertStmt = this.db.prepare(`
        INSERT INTO jobs (
          id, type, payload, status, attempts, max_attempts,
          last_error, run_at, started_at, finished_at,
          idempotency_key, result, created_at, updated_at
        ) VALUES (
          ?, ?, ?, 'pending', 0, ?,
          NULL, ?, NULL, NULL,
          ?, NULL, ?, ?
        )
      `);

      insertStmt.run(id, type, payloadStr, maxAttempts, runAt, idempotencyKey, now, now);

      const job = this.getJobById(id);
      return { job, isDuplicate: false };
    } catch (err) {
      // Check for SQLite UNIQUE constraint violation
      if (err.message && (err.message.includes('UNIQUE constraint failed') || err.message.includes('idx_jobs_idempotency_key') || err.message.includes('jobs.idempotency_key'))) {
        const existingJobStmt = this.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?');
        const existingRow = existingJobStmt.get(idempotencyKey);
        if (existingRow) {
          return { job: this._formatJobRow(existingRow), isDuplicate: true };
        }
      }
      throw err;
    }
  }

  /**
   * Fetch a job by ID
   */
  getJobById(id) {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return null;
    return this._formatJobRow(row);
  }

  /**
   * List all dead jobs (Dead-Letter Queue)
   */
  listDeadJobs(limit = 100, offset = 0) {
    const stmt = this.db.prepare(`
      SELECT * FROM jobs
      WHERE status = 'dead'
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(limit, offset);
    return rows.map((r) => this._formatJobRow(r));
  }

  /**
   * List all recent jobs across any status
   */
  listRecentJobs(limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM jobs
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit);
    return rows.map((r) => this._formatJobRow(r));
  }

  /**
   * Manually retry a dead job.
   * Transitions from 'dead' back to 'pending', resets run_at to now, and resets attempts/errors.
   */
  retryDeadJob(id) {
    const job = this.getJobById(id);
    if (!job) {
      const err = new Error(`Job with ID '${id}' not found`);
      err.statusCode = 404;
      throw err;
    }

    if (job.status !== 'dead') {
      const err = new Error(`Job '${id}' is currently '${job.status}', only 'dead' jobs can be manually retried`);
      err.statusCode = 400;
      throw err;
    }

    const now = Date.now();
    const updateStmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'pending',
          attempts = 0,
          run_at = ?,
          started_at = NULL,
          finished_at = NULL,
          last_error = NULL,
          updated_at = ?
      WHERE id = ? AND status = 'dead'
    `);

    updateStmt.run(now, now, id);
    return this.getJobById(id);
  }

  /**
   * Recover stuck jobs in 'processing' state where started_at < now - timeout
   */
  recoverStuckJobs(timeoutMs = config.processingTimeoutMs) {
    const now = Date.now();
    const threshold = now - timeoutMs;

    const findStuckStmt = this.db.prepare(`
      SELECT * FROM jobs
      WHERE status = 'processing' AND started_at <= ?
    `);
    const stuckRows = findStuckStmt.all(threshold);
    const recovered = [];

    for (const row of stuckRows) {
      const nextAttempts = row.attempts + 1;
      const isDead = nextAttempts >= row.max_attempts;

      if (isDead) {
        const updateStmt = this.db.prepare(`
          UPDATE jobs
          SET status = 'dead',
              attempts = ?,
              last_error = ?,
              finished_at = ?,
              updated_at = ?
          WHERE id = ? AND status = 'processing'
        `);
        updateStmt.run(
          nextAttempts,
          'Job timed out in processing state (worker died or stalled)',
          now,
          now,
          row.id
        );
      } else {
        const delay = this.calculateBackoffWithJitter(nextAttempts);
        const nextRunAt = now + delay;
        const updateStmt = this.db.prepare(`
          UPDATE jobs
          SET status = 'pending',
              attempts = ?,
              run_at = ?,
              started_at = NULL,
              last_error = ?,
              updated_at = ?
          WHERE id = ? AND status = 'processing'
        `);
        updateStmt.run(
          nextAttempts,
          nextRunAt,
          `Recovered after processing timeout (${Math.round(timeoutMs / 1000)}s)`,
          now,
          row.id
        );
      }

      recovered.push(this.getJobById(row.id));
    }

    return recovered;
  }

  /**
   * Get aggregate statistics of jobs
   */
  getStats() {
    const stmt = this.db.prepare(`
      SELECT
        status,
        COUNT(*) as count
      FROM jobs
      GROUP BY status
    `);
    const rows = stmt.all();
    const stats = {
      pending: 0,
      processing: 0,
      succeeded: 0,
      failed: 0,
      dead: 0,
      total: 0,
    };

    for (const row of rows) {
      stats[row.status] = row.count;
      stats.total += row.count;
    }

    return stats;
  }

  _formatJobRow(row) {
    let payload = null;
    let result = null;

    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = row.payload;
    }

    try {
      result = row.result ? JSON.parse(row.result) : null;
    } catch {
      result = row.result;
    }

    return {
      id: row.id,
      type: row.type,
      payload,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error,
      runAt: row.run_at,
      runAtFormatted: new Date(row.run_at).toISOString(),
      startedAt: row.started_at,
      startedAtFormatted: row.started_at ? new Date(row.started_at).toISOString() : null,
      finishedAt: row.finished_at,
      finishedAtFormatted: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      idempotencyKey: row.idempotency_key,
      result,
      createdAt: row.created_at,
      createdAtFormatted: new Date(row.created_at).toISOString(),
      updatedAt: row.updated_at,
      updatedAtFormatted: new Date(row.updated_at).toISOString(),
    };
  }
}

module.exports = new JobService();
