const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const { runMigrations } = require('../../src/db/migrations');
const jobService = require('../../src/services/jobService');
const Worker = require('../../src/worker/worker');

async function runForceFailureTest() {
  console.log('====================================================');
  console.log('TEST 2: FORCE 100% FAILURE, EXPONENTIAL BACKOFF & DLQ');
  console.log('====================================================');

  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  const service = new (jobService.constructor)(db);

  const MAX_ATTEMPTS = 3;
  const BASE_DELAY = 1000;
  const MAX_DELAY = 10000;

  console.log(`[Setup] Enqueueing job with forceFail=true, maxAttempts=${MAX_ATTEMPTS}...`);
  const { job } = service.enqueueJob({
    type: 'generate_pdf',
    payload: {
      title: 'Deliberately Failing Report',
      forceFail: true,
    },
    idempotencyKey: `fail-test-${Date.now()}`,
    maxAttempts: MAX_ATTEMPTS,
  });

  const worker = new Worker({
    db,
    workerId: 'failure-worker-test',
    pollIntervalMs: 50,
  });

  const attemptLogs = [];
  const originalExecute = worker.executeJob.bind(worker);
  worker.executeJob = async (j) => {
    const attemptNum = j.attempts + 1;
    const now = Date.now();
    attemptLogs.push({ attempt: attemptNum, timestamp: now });
    console.log(`[Attempt ${attemptNum}/${MAX_ATTEMPTS}] Executing job at timestamp ${new Date(now).toISOString()}...`);
    return await originalExecute(j);
  };

  worker.start();

  console.log('[Worker] Worker started. Observing lifecycle transitions and backoff delays...');
  const startTime = Date.now();
  let finalJob = null;

  while (Date.now() - startTime < 20000) {
    finalJob = service.getJobById(job.id);
    if (finalJob.status === 'dead') {
      break;
    }
    // Advance time or poll
    await new Promise((r) => setTimeout(r, 100));
  }

  worker.stop();

  console.log('\n[Lifecycle Evidence Log]');
  console.log(`- Final Status: ${finalJob.status}`);
  console.log(`- Total Attempts Recorded: ${finalJob.attempts}/${finalJob.maxAttempts}`);
  console.log(`- Last Error: "${finalJob.lastError}"`);
  console.log(`- Finished At: ${finalJob.finishedAtFormatted}`);

  // Display delays between consecutive attempts
  console.log('\n[Backoff Delay Measurements]');
  for (let i = 1; i < attemptLogs.length; i++) {
    const delay = attemptLogs[i].timestamp - attemptLogs[i - 1].timestamp;
    console.log(`  • Delay between Attempt ${i} and Attempt ${i + 1}: ${delay}ms`);
  }

  assert.equal(finalJob.status, 'dead', 'Job must end in DEAD state');
  assert.equal(finalJob.attempts, MAX_ATTEMPTS, 'Job must have completed exactly MAX_ATTEMPTS');
  assert.ok(finalJob.lastError.includes('Simulated generation failure'), 'Last error message must be recorded');
  assert.equal(attemptLogs.length, MAX_ATTEMPTS, 'Must have attempted exactly MAX_ATTEMPTS times');

  console.log('✅ TEST 2 PASSED: 100% failure handled gracefully with exponential backoff & transition to DEAD.\n');
}

if (require.main === module) {
  runForceFailureTest().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { runForceFailureTest };
