const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const { runMigrations } = require('../../src/db/migrations');
const jobService = require('../../src/services/jobService');
const Worker = require('../../src/worker/worker');

async function runConcurrencyTest() {
  console.log('====================================================');
  console.log('TEST 1: 50 JOBS CONCURRENCY LIMIT VERIFICATION');
  console.log('====================================================');

  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  const service = new (jobService.constructor)(db);

  const CONCURRENCY_LIMIT = 5;
  const TOTAL_JOBS = 50;

  console.log(`[Setup] Enqueueing ${TOTAL_JOBS} jobs into database...`);
  for (let i = 1; i <= TOTAL_JOBS; i++) {
    service.enqueueJob({
      type: 'generate_pdf',
      payload: {
        title: `Batch Performance Report #${i}`,
        renderDelayMs: 40, // Genuine work with short render delay
      },
      idempotencyKey: `bulk-job-${i}-${Date.now()}`,
    });
  }

  let peakConcurrency = 0;
  let currentActive = 0;
  const worker = new Worker({
    db,
    workerId: 'concurrency-worker-test',
    concurrency: CONCURRENCY_LIMIT,
    pollIntervalMs: 20,
  });

  // Wrap executeJob to accurately track concurrency peaks
  const originalExecute = worker.executeJob.bind(worker);
  worker.executeJob = async (job) => {
    currentActive++;
    if (currentActive > peakConcurrency) {
      peakConcurrency = currentActive;
    }

    if (currentActive > CONCURRENCY_LIMIT) {
      console.error(`[VIOLATION] Concurrency exceeded! Active: ${currentActive}, Limit: ${CONCURRENCY_LIMIT}`);
    }

    try {
      return await originalExecute(job);
    } finally {
      currentActive--;
    }
  };

  console.log(`[Worker] Starting worker with CONCURRENCY_LIMIT = ${CONCURRENCY_LIMIT}...`);
  worker.start();

  // Wait until all 50 jobs are completed
  const startTime = Date.now();
  while (Date.now() - startTime < 30000) {
    const stats = service.getStats();
    if (stats.succeeded === TOTAL_JOBS) {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  worker.stop();

  const finalStats = service.getStats();
  console.log('\n[Results]');
  console.log(`- Total Enqueued: ${TOTAL_JOBS}`);
  console.log(`- Succeeded:      ${finalStats.succeeded}`);
  console.log(`- Peak Observed:  ${peakConcurrency} concurrent jobs`);
  console.log(`- Max Allowed:    ${CONCURRENCY_LIMIT} concurrent jobs`);

  assert.equal(finalStats.succeeded, TOTAL_JOBS, 'All 50 jobs must succeed');
  assert.ok(
    peakConcurrency <= CONCURRENCY_LIMIT,
    `Peak concurrency (${peakConcurrency}) must never exceed limit (${CONCURRENCY_LIMIT})`
  );
  assert.ok(peakConcurrency > 1, 'Worker should utilize concurrency and process multiple jobs in parallel');

  console.log('✅ TEST 1 PASSED: Concurrency strictly respected without exceeding limit.\n');
}

if (require.main === module) {
  runConcurrencyTest().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { runConcurrencyTest };
