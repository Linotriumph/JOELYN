const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const { runMigrations } = require('../../src/db/migrations');
const jobService = require('../../src/services/jobService');
const Worker = require('../../src/worker/worker');

async function runWorkerCrashRecoveryTest() {
  console.log('====================================================');
  console.log('TEST 3: WORKER CRASH & STUCK JOB RECOVERY');
  console.log('====================================================');

  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  const service = new (jobService.constructor)(db);

  console.log('[Step 1] Enqueueing a long-running PDF job...');
  const { job } = service.enqueueJob({
    type: 'generate_pdf',
    payload: {
      title: 'Crash Recovery Audit Document',
      renderDelayMs: 2000,
    },
    idempotencyKey: `crash-test-${Date.now()}`,
    maxAttempts: 3,
  });

  console.log(`- Job Enqueued with ID: ${job.id}, Initial Status: ${job.status}`);

  console.log('\n[Step 2] Starting Worker 1 (will be abruptly killed mid-execution)...');
  const worker1 = new Worker({
    db,
    workerId: 'worker-doomed-to-crash',
    pollIntervalMs: 50,
  });

  worker1.start();

  // Wait for worker1 to claim the job and enter 'processing'
  let claimedJob = null;
  while (!claimedJob || claimedJob.status !== 'processing') {
    claimedJob = service.getJobById(job.id);
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`- Evidence 1 (Before Kill): Job '${job.id}' claimed and entered status: '${claimedJob.status}' by ${worker1.workerId}`);
  assert.equal(claimedJob.status, 'processing');

  // Abruptly kill Worker 1 (simulate process crash / SIGKILL)
  console.log('\n[Step 3] KILLING WORKER 1 (Simulating crash without graceful shutdown)...');
  worker1.stop();

  // Simulate time passing beyond the processing timeout threshold
  const STUCK_TIMEOUT_MS = 2000;
  console.log(`- Evidence 2 (While Stuck): Job remains frozen in 'processing' status.`);
  const frozenJob = service.getJobById(job.id);
  console.log(`  Current Job Status: '${frozenJob.status}' (Worker is dead, job is orphaned)`);
  assert.equal(frozenJob.status, 'processing');

  // Artificially age started_at so recovery threshold is crossed
  db.prepare('UPDATE jobs SET started_at = ? WHERE id = ?').run(Date.now() - (STUCK_TIMEOUT_MS + 1000), job.id);

  console.log('\n[Step 4] Running Stuck-Job Recovery Scanner...');
  const recovered = service.recoverStuckJobs(STUCK_TIMEOUT_MS);
  assert.equal(recovered.length, 1, 'Recovery scanner must find the orphaned job');

  const afterRecoveryJob = service.getJobById(job.id);
  console.log(`- Evidence 3 (After Recovery): Job recovered to status: '${afterRecoveryJob.status}' with attempt count ${afterRecoveryJob.attempts}`);
  console.log(`  Last error note: "${afterRecoveryJob.lastError}"`);
  assert.equal(afterRecoveryJob.status, 'pending');
  assert.equal(afterRecoveryJob.attempts, 1);

  // Set run_at to now so the replacement worker can pick it up immediately
  db.prepare('UPDATE jobs SET run_at = ? WHERE id = ?').run(Date.now() - 100, job.id);

  console.log('\n[Step 5] Spawning Worker 2 (Replacement worker)...');
  const worker2 = new Worker({
    db,
    workerId: 'worker-replacement-survivor',
    pollIntervalMs: 50,
  });

  worker2.start();

  // Wait for worker2 to complete the recovered job
  let completedJob = null;
  const startTime = Date.now();
  while (Date.now() - startTime < 10000) {
    completedJob = service.getJobById(job.id);
    if (completedJob.status === 'succeeded') {
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  worker2.stop();

  console.log(`- Evidence 4 (After Replacement Worker Processed): Job reached final status: '${completedJob.status}'`);
  console.log(`  Finished At: ${completedJob.finishedAtFormatted}`);
  console.log(`  Output Result: ${JSON.stringify(completedJob.result)}`);

  assert.equal(completedJob.status, 'succeeded');
  assert.ok(completedJob.result);

  console.log('✅ TEST 3 PASSED: Worker crash detected, stuck job recovered, and completed by new worker.\n');
}

if (require.main === module) {
  runWorkerCrashRecoveryTest().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { runWorkerCrashRecoveryTest };
