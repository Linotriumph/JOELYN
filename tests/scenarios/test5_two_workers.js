const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const { runMigrations } = require('../../src/db/migrations');
const jobService = require('../../src/services/jobService');
const Worker = require('../../src/worker/worker');

async function runTwoWorkersTest() {
  console.log('====================================================');
  console.log('TEST 5: TWO WORKERS SIMULTANEOUS ATOMIC EXECUTION');
  console.log('====================================================');

  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  const service = new (jobService.constructor)(db);

  const TOTAL_JOBS = 20;
  console.log(`[Setup] Enqueueing ${TOTAL_JOBS} jobs into shared database...`);
  for (let i = 1; i <= TOTAL_JOBS; i++) {
    service.enqueueJob({
      type: 'generate_pdf',
      payload: {
        title: `Parallel Execution Job #${i}`,
        renderDelayMs: 30,
      },
      idempotencyKey: `parallel-job-${i}-${Date.now()}`,
    });
  }

  const workerAProcessed = new Set();
  const workerBProcessed = new Set();

  const workerA = new Worker({
    db,
    workerId: 'WORKER-ALPHA',
    concurrency: 3,
    pollIntervalMs: 20,
  });

  const workerB = new Worker({
    db,
    workerId: 'WORKER-BRAVO',
    concurrency: 3,
    pollIntervalMs: 20,
  });

  // Track which worker executed each job
  const originalExecuteA = workerA.executeJob.bind(workerA);
  workerA.executeJob = async (job) => {
    workerAProcessed.add(job.id);
    return await originalExecuteA(job);
  };

  const originalExecuteB = workerB.executeJob.bind(workerB);
  workerB.executeJob = async (job) => {
    workerBProcessed.add(job.id);
    return await originalExecuteB(job);
  };

  console.log('[Workers] Starting WORKER-ALPHA and WORKER-BRAVO simultaneously...');
  workerA.start();
  workerB.start();

  // Wait for all 20 jobs to complete
  const startTime = Date.now();
  while (Date.now() - startTime < 15000) {
    const stats = service.getStats();
    if (stats.succeeded === TOTAL_JOBS) {
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  workerA.stop();
  workerB.stop();

  console.log('\n[Execution Distribution]');
  console.log(`- WORKER-ALPHA processed: ${workerAProcessed.size} jobs`);
  console.log(`- WORKER-BRAVO processed: ${workerBProcessed.size} jobs`);
  console.log(`- Total unique jobs processed: ${workerAProcessed.size + workerBProcessed.size}/${TOTAL_JOBS}`);

  // Check for any duplicate claims / intersections between Worker A and Worker B
  const duplicateClaims = [];
  for (const id of workerAProcessed) {
    if (workerBProcessed.has(id)) {
      duplicateClaims.push(id);
    }
  }

  console.log(`- Duplicate claims detected: ${duplicateClaims.length}`);

  assert.equal(duplicateClaims.length, 0, 'No job should be claimed by both workers!');
  assert.ok(workerAProcessed.size > 0, 'Worker A should process jobs');
  assert.ok(workerBProcessed.size > 0, 'Worker B should process jobs');
  assert.equal(workerAProcessed.size + workerBProcessed.size, TOTAL_JOBS, 'All 20 jobs must be processed exactly once');

  const finalStats = service.getStats();
  assert.equal(finalStats.succeeded, TOTAL_JOBS, 'All 20 jobs must have succeeded');

  console.log('✅ TEST 5 PASSED: Both workers processed jobs with atomic isolation (zero duplicate claims).\n');
}

if (require.main === module) {
  runTwoWorkersTest().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { runTwoWorkersTest };
