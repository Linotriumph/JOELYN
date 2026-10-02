const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const config = require('../config');
const { runMigrations } = require('../db/migrations');
const jobService = require('../services/jobService');

// Ensure DB tables are initialized
runMigrations();

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Serve generated PDF reports safely
app.get('/api/reports/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(config.storageDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Report file not found' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  return fs.createReadStream(filePath).pipe(res);
});

/**
 * POST /api/jobs
 * Enqueues a background job. Returns HTTP 202 Accepted immediately.
 */
app.post('/api/jobs', (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotencyKey;

  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    return res.status(400).json({
      error: 'Missing required Idempotency-Key header or body parameter',
    });
  }

  const { type = 'generate_pdf', payload = {}, maxAttempts = config.maxJobAttempts } = req.body;

  try {
    const { job, isDuplicate } = jobService.enqueueJob({
      type,
      payload,
      idempotencyKey: idempotencyKey.trim(),
      maxAttempts,
    });

    return res.status(202).json({
      message: isDuplicate
        ? 'Job already exists for this idempotency key. Returned existing job.'
        : 'Job accepted for background execution.',
      data: {
        jobId: job.id,
        type: job.type,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        idempotencyKey: job.idempotencyKey,
        isDuplicate,
        createdAt: job.createdAtFormatted,
      },
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      error: err.message || 'Internal server error while enqueueing job',
    });
  }
});

/**
 * GET /api/jobs/stats
 * Aggregate job statistics
 */
app.get('/api/jobs/stats', (req, res) => {
  try {
    const stats = jobService.getStats();
    return res.json({ data: stats });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/jobs/dead
 * Returns dead-letter queue jobs
 */
app.get('/api/jobs/dead', (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    const deadJobs = jobService.listDeadJobs(limit, offset);
    return res.json({ data: deadJobs, count: deadJobs.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/jobs
 * Returns recent jobs across all statuses
 */
app.get('/api/jobs', (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const jobs = jobService.listRecentJobs(limit);
    return res.json({ data: jobs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/jobs/:id
 * Returns current status of a specific job
 */
app.get('/api/jobs/:id', (req, res) => {
  try {
    const job = jobService.getJobById(req.params.id);
    if (!job) {
      return res.status(404).json({ error: `Job with ID '${req.params.id}' not found` });
    }

    let downloadUrl = null;
    if (job.status === 'succeeded' && job.result && job.result.filename) {
      downloadUrl = `/api/reports/${job.result.filename}`;
    }

    return res.json({
      data: {
        ...job,
        downloadUrl,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/jobs/:id/retry
 * Manually retry a dead job
 */
app.post('/api/jobs/:id/retry', (req, res) => {
  try {
    const job = jobService.retryDeadJob(req.params.id);
    return res.json({
      message: 'Job successfully moved from dead to pending for retry',
      data: job,
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * POST /api/jobs/recover-stuck
 * Triggers stuck job recovery scan
 */
app.post('/api/jobs/recover-stuck', (req, res) => {
  try {
    const timeoutMs = req.body.timeoutMs || config.processingTimeoutMs;
    const recovered = jobService.recoverStuckJobs(timeoutMs);
    return res.json({
      message: `Stuck job recovery completed. Recovered ${recovered.length} jobs.`,
      data: recovered,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

if (require.main === module) {
  const server = app.listen(config.port, () => {
    console.log(`[API Server] JOELYN Background Job API running at http://localhost:${config.port}`);
  });

  const shutdown = () => {
    console.log('\nShutting down API server gracefully...');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = app;
