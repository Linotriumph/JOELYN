const { runMigrations } = require('../db/migrations');
const Worker = require('./worker');
const config = require('../config');

// Ensure database tables exist
runMigrations();

const workerId = process.env.WORKER_ID || `worker-${process.pid}`;
const worker = new Worker({
  workerId,
  concurrency: config.workerConcurrency,
  pollIntervalMs: config.pollIntervalMs,
  recoveryIntervalMs: config.recoveryIntervalMs,
  processingTimeoutMs: config.processingTimeoutMs,
});

worker.start();

const shutdown = () => {
  console.log(`\nShutting down worker [${workerId}] gracefully...`);
  worker.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
