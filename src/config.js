const path = require('node:path');
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  databasePath: path.resolve(process.env.DATABASE_PATH || './data/joelyn.db'),
  storageDir: path.resolve(process.env.STORAGE_DIR || './storage/reports'),
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
  maxJobAttempts: parseInt(process.env.MAX_JOB_ATTEMPTS || '3', 10),
  retryBaseDelayMs: parseInt(process.env.RETRY_BASE_DELAY_MS || '2000', 10),
  retryMaxDelayMs: parseInt(process.env.RETRY_MAX_DELAY_MS || '30000', 10),
  retryJitterRatio: parseFloat(process.env.RETRY_JITTER_RATIO || '0.25'),
  processingTimeoutMs: parseInt(process.env.PROCESSING_TIMEOUT_MS || '15000', 10),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '500', 10),
  recoveryIntervalMs: parseInt(process.env.RECOVERY_INTERVAL_MS || '5000', 10),
};

module.exports = config;
