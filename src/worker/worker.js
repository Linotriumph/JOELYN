const { getDb } = require('../db/connection');
const { claimNextJob } = require('./claimJob');
const jobService = require('../services/jobService');
const pdfService = require('../services/pdfService');
const config = require('../config');

class Worker {
  constructor(options = {}) {
    this.workerId = options.workerId || `worker-${process.pid}-${Math.floor(Math.random() * 1000)}`;
    this.concurrency = options.concurrency || config.workerConcurrency;
    this.pollIntervalMs = options.pollIntervalMs || config.pollIntervalMs;
    this.recoveryIntervalMs = options.recoveryIntervalMs || config.recoveryIntervalMs;
    this.processingTimeoutMs = options.processingTimeoutMs || config.processingTimeoutMs;
    this.db = options.db || getDb();
    this.activeJobs = new Set();
    this.isRunning = false;
    this.pollTimer = null;
    this.recoveryTimer = null;
  }

  log(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    console.log(`[${timestamp}] [${level.toUpperCase()}] [${this.workerId}] ${message}${metaStr}`);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.log('info', `Worker started with concurrency limit = ${this.concurrency}`);

    this.scheduleNextPoll(0);
    this.scheduleRecoveryScan(1000);
  }

  stop() {
    this.isRunning = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.log('info', 'Worker stopped');
  }

  scheduleNextPoll(delayMs = this.pollIntervalMs) {
    if (!this.isRunning) return;
    this.pollTimer = setTimeout(() => this.poll(), delayMs);
  }

  scheduleRecoveryScan(delayMs = this.recoveryIntervalMs) {
    if (!this.isRunning) return;
    this.recoveryTimer = setTimeout(async () => {
      await this.runRecoveryScan();
      this.scheduleRecoveryScan(this.recoveryIntervalMs);
    }, delayMs);
  }

  async runRecoveryScan() {
    try {
      const recovered = jobService.recoverStuckJobs(this.processingTimeoutMs);
      if (recovered.length > 0) {
        this.log('warn', `Stuck job recovery triggered: recovered ${recovered.length} stuck jobs`, {
          jobIds: recovered.map((j) => j.id),
        });
      }
    } catch (err) {
      this.log('error', `Error during stuck job recovery scan: ${err.message}`);
    }
  }

  async poll() {
    if (!this.isRunning) return;

    try {
      // Keep claiming jobs while active count is under concurrency limit
      while (this.isRunning && this.activeJobs.size < this.concurrency) {
        const jobRow = claimNextJob(this.db);
        if (!jobRow) {
          // No pending jobs available at this moment
          break;
        }

        const job = jobService._formatJobRow(jobRow);
        this.activeJobs.add(job.id);
        this.log('info', `Claimed job '${job.id}' (${job.type}) [Active concurrency: ${this.activeJobs.size}/${this.concurrency}]`, {
          jobId: job.id,
          type: job.type,
          attempt: job.attempts + 1,
          maxAttempts: job.maxAttempts,
        });

        // Process job asynchronously
        this.executeJob(job).finally(() => {
          this.activeJobs.delete(job.id);
        });
      }
    } catch (err) {
      this.log('error', `Error in worker poll cycle: ${err.message}`);
    } finally {
      this.scheduleNextPoll(this.pollIntervalMs);
    }
  }

  async executeJob(job) {
    const startTime = Date.now();
    this.log('info', `Starting execution of job '${job.id}' (Attempt ${job.attempts + 1}/${job.maxAttempts})`, {
      jobId: job.id,
      type: job.type,
      payload: job.payload,
    });

    try {
      let result = null;

      if (job.type === 'generate_pdf' || job.type === 'report_generation') {
        result = await pdfService.generateReport(job.id, job.payload);
      } else {
        throw new Error(`Unknown job type: '${job.type}'`);
      }

      // Mark Job as Succeeded
      const finishedAt = Date.now();
      const updateStmt = this.db.prepare(`
        UPDATE jobs
        SET status = 'succeeded',
            finished_at = ?,
            result = ?,
            last_error = NULL,
            updated_at = ?
        WHERE id = ?
      `);
      updateStmt.run(finishedAt, JSON.stringify(result), finishedAt, job.id);

      const durationMs = finishedAt - startTime;
      this.log('info', `Job '${job.id}' completed successfully in ${durationMs}ms`, {
        jobId: job.id,
        status: 'succeeded',
        durationMs,
        result,
      });
    } catch (err) {
      const failedAt = Date.now();
      const newAttempts = job.attempts + 1;
      const isDead = newAttempts >= job.maxAttempts;

      if (isDead) {
        // Transition to DEAD (Exhausted retries)
        const updateStmt = this.db.prepare(`
          UPDATE jobs
          SET status = 'dead',
              attempts = ?,
              last_error = ?,
              finished_at = ?,
              updated_at = ?
          WHERE id = ?
        `);
        updateStmt.run(newAttempts, err.message, failedAt, failedAt, job.id);

        this.log('error', `Job '${job.id}' EXHAUSTED all ${job.maxAttempts} attempts -> Moved to DEAD-LETTER queue`, {
          jobId: job.id,
          status: 'dead',
          attempts: newAttempts,
          maxAttempts: job.maxAttempts,
          error: err.message,
        });
      } else {
        // Calculate Exponential Backoff + Jitter for retry
        const backoffDelay = jobService.calculateBackoffWithJitter(newAttempts);
        const nextRunAt = failedAt + backoffDelay;

        const updateStmt = this.db.prepare(`
          UPDATE jobs
          SET status = 'pending',
              attempts = ?,
              last_error = ?,
              run_at = ?,
              started_at = NULL,
              updated_at = ?
          WHERE id = ?
        `);
        updateStmt.run(newAttempts, err.message, nextRunAt, failedAt, job.id);

        this.log('warn', `Job '${job.id}' failed attempt ${newAttempts}/${job.maxAttempts}. Scheduled retry in ${backoffDelay}ms (Exponential Backoff + Jitter)`, {
          jobId: job.id,
          status: 'pending (retryable)',
          attempt: newAttempts,
          maxAttempts: job.maxAttempts,
          retryDelayMs: backoffDelay,
          nextRunAt: new Date(nextRunAt).toISOString(),
          error: err.message,
        });
      }
    }
  }
}

module.exports = Worker;
