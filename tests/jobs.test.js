const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../src/db/migrations');
const jobService = require('../src/services/jobService');
const pdfService = require('../src/services/pdfService');
const { claimNextJob } = require('../src/worker/claimJob');
const Worker = require('../src/worker/worker');

// Isolated in-memory database for automated tests
function setupTestDb() {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return db;
}

test('1 & 2. Job creation and enqueue returns pending status and job ID', async () => {
  const db = setupTestDb();
  const service = new (jobService.constructor)(db);

  const { job, isDuplicate } = service.enqueueJob({
    type: 'generate_pdf',
    payload: { title: 'Test Report' },
    idempotencyKey: 'test-key-1',
    maxAttempts: 3,
  });

  assert.ok(job.id, 'Job should have an ID');
  assert.equal(job.status, 'pending', 'Initial status must be pending');
  assert.equal(job.attempts, 0, 'Initial attempts must be 0');
  assert.equal(job.maxAttempts, 3, 'maxAttempts should match');
  assert.equal(isDuplicate, false, 'Should not be marked duplicate');
});

test('3. Idempotency key prevents duplicate jobs at the database level', async () => {
  const db = setupTestDb();
  const service = new (jobService.constructor)(db);

  const res1 = service.enqueueJob({
    type: 'generate_pdf',
    payload: { title: 'First Request' },
    idempotencyKey: 'same-key-123',
  });

  const res2 = service.enqueueJob({
    type: 'generate_pdf',
    payload: { title: 'Second Duplicate Request' },
    idempotencyKey: 'same-key-123',
  });

  assert.equal(res1.isDuplicate, false);
  assert.equal(res2.isDuplicate, true);
  assert.equal(res1.job.id, res2.job.id, 'Both calls must return the same job ID');

  // Verify exactly 1 row exists in DB
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM jobs');
  const { count } = countStmt.get();
  assert.equal(count, 1, 'Only one row must exist in the database');
});

test('4. Successful processing marks job succeeded and records finishedAt & result', async () => {
  const db = setupTestDb();
  const service = new (jobService.constructor)(db);

  const { job } = service.enqueueJob({
    type: 'generate_pdf',
    payload: { title: 'Success PDF' },
    idempotencyKey: 'key-success-1',
  });

  const worker = new Worker({ db, workerId: 'test-worker-1' });
  const claimedRow = claimNextJob(db);
  assert.ok(claimedRow, 'Worker should claim pending job');
  assert.equal(claimedRow.status, 'processing');

  const formattedJob = service._formatJobRow(claimedRow);
  await worker.executeJob(formattedJob);

  const updatedJob = service.getJobById(job.id);
  assert.equal(updatedJob.status, 'succeeded');
  assert.ok(updatedJob.finishedAt, 'finishedAt should be populated');
  assert.ok(updatedJob.result, 'result should be populated');
  assert.equal(updatedJob.result.filename, `report_${job.id}.pdf`);
});

test('5 & 6. Failed processing increments attempts and schedules retry in pending state', async () => {
  const db = setupTestDb();
  const service = new (jobService.constructor)(db);

  const { job } = service.enqueueJob({
    type: 'generate_pdf',
    payload: { title: 'Fail PDF', forceFail: true },
    idempotencyKey: 'key-fail-1',
    maxAttempts: 3,
  });

  const worker = new Worker({ db, workerId: 'test-worker-1' });
  const claimedRow = claimNextJob(db);
  const formattedJob = service._formatJobRow(claimedRow);

  await worker.executeJob(formattedJob);

  const updatedJob = service.getJobById(job.id);
  assert.equal(updatedJob.status, 'pending', 'Job with remaining retries must return to pending');
  assert.equal(updatedJob.attempts, 1, 'Attempts must increment to 1');
  assert.ok(updatedJob.lastError.includes('Simulated generation failure'));
  assert.ok(updatedJob.runAt > Date.now() - 100, 'runAt should be in the future');
});

test('7 & 8. Exponential backoff and jitter produce growing, spread delays', () => {
  const service = jobService;
  const baseDelay = 1000;
  const maxDelay = 30000;
  const jitterRatio = 0.25;

  const delay1 = service.calculateBackoffWithJitter(1, baseDelay, maxDelay, jitterRatio);
  const delay2 = service.calculateBackoffWithJitter(2, baseDelay, maxDelay, jitterRatio);
  const delay3 = service.calculateBackoffWithJitter(3, baseDelay, maxDelay, jitterRatio);

  // Attempt 1: base = 1000, delay in [1000, 1250]
  assert.ok(delay1 >= 1000 && delay1 <= 1250, `Delay 1 (${delay1}) out of expected range`);
  // Attempt 2: base = 2000, delay in [2000, 2500]
  assert.ok(delay2 >= 2000 && delay2 <= 2500, `Delay 2 (${delay2}) out of expected range`);
  // Attempt 3: base = 4000, delay in [4000, 5000]
  assert.ok(delay3 >= 4000 && delay3 <= 5000, `Delay 3 (${delay3}) out of expected range`);

  assert.ok(delay2 > delay1, 'Delay 2 must be greater than Delay 1');
  assert.ok(delay3 > delay2, 'Delay 3 must be greater than Delay 2');
});

test('9 & 10. Maximum attempts transition job to dead state (failed != dead)', async () => {
  const db = setupTestDb();
  const service = new (jobService.constructor)(db);

  const { job } = service.enqueueJob({
    type: 'generate_pdf',
    payload: { forceFail: true },
    idempotencyKey: 'key-exhaust-1',
    maxAttempts: 2,
  });

  const worker = new Worker({ db, workerId: 'test-worker-1' });

  // Attempt 1
  let claimed = claimNextJob(db);
  await worker.executeJob(service._formatJobRow(claimed));
  let current = service.getJobById(job.id);
  assert.equal(current.status, 'pending', 'After 1st failure with maxAttempts=2, status must be pending');
  assert.equal(current.attempts, 1);

  // Force runAt to now so it can be claimed again immediately
  db.prepare('UPDATE jobs SET run_at = ? WHERE id = ?').run(Date.now() - 10, job.id);

  // Attempt 2 (Exhaustion)
  claimed = claimNextJob(db);
  await worker.executeJob(service._formatJobRow(claimed));
  current = service.getJobById(job.id);

  assert.equal(current.status, 'dead', 'Job must transition to dead after exhausting max attempts');
  assert.equal(current.attempts, 2);
  assert.ok(current.finishedAt, 'finishedAt should be set on dead job');
});

test('11. Atomic claim prevents two workers from claiming the same job', async () => {
  const db = setupTestDb();
  const service = new (jobService.constructor)(db);

  service.enqueueJob({
    type: 'generate_pdf',
    payload: { title: 'Single Job' },
    idempotencyKey: 'key-single-1',
  });

  // Worker 1 claims
  const claim1 = claimNextJob(db);
  // Worker 2 tries to claim at the same time
  const claim2 = claimNextJob(db);

  assert.ok(claim1, 'Worker 1 should claim the job');
  assert.equal(claim1.status, 'processing');
  assert.equal(claim2, null, 'Worker 2 must receive null (cannot double-claim)');
});

test('12. Stuck-job recovery detects timed out processing jobs and recovers them', async () => {
  const db = setupTestDb();
  const service = new (jobService.constructor)(db);

  const { job } = service.enqueueJob({
    type: 'generate_pdf',
    payload: { title: 'Stuck Job' },
    idempotencyKey: 'key-stuck-1',
    maxAttempts: 3,
  });

  // Manually simulate a job being in 'processing' since 30 seconds ago (worker crashed)
  const thirtySecondsAgo = Date.now() - 30000;
  db.prepare(`
    UPDATE jobs
    SET status = 'processing', started_at = ?
    WHERE id = ?
  `).run(thirtySecondsAgo, job.id);

  // Run recovery with a 10-second timeout threshold
  const recovered = service.recoverStuckJobs(10000);
  assert.equal(recovered.length, 1, 'Should recover 1 stuck job');
  assert.equal(recovered[0].id, job.id);
  assert.equal(recovered[0].status, 'pending', 'Stuck job with remaining attempts should become pending');
  assert.equal(recovered[0].attempts, 1, 'Attempts should be incremented');
});

test('13. Job status lookup returns full job details and safe representation', async () => {
  const db = setupTestDb();
  const service = new (jobService.constructor)(db);

  const { job } = service.enqueueJob({
    type: 'generate_pdf',
    payload: { title: 'Audit Report', sensitiveToken: 'hidden_val' },
    idempotencyKey: 'key-lookup-1',
  });

  const fetched = service.getJobById(job.id);
  assert.equal(fetched.id, job.id);
  assert.equal(fetched.type, 'generate_pdf');
  assert.equal(fetched.status, 'pending');
  assert.equal(fetched.payload.title, 'Audit Report');
});

test('14. Manual dead-job retry resets status to pending and clears error', async () => {
  const db = setupTestDb();
  const service = new (jobService.constructor)(db);

  const { job } = service.enqueueJob({
    type: 'generate_pdf',
    payload: { forceFail: true },
    idempotencyKey: 'key-dlq-1',
    maxAttempts: 1,
  });

  const worker = new Worker({ db, workerId: 'test-worker-1' });
  const claimed = claimNextJob(db);
  await worker.executeJob(service._formatJobRow(claimed));

  let deadJob = service.getJobById(job.id);
  assert.equal(deadJob.status, 'dead');

  // Perform manual retry
  const retriedJob = service.retryDeadJob(job.id);
  assert.equal(retriedJob.status, 'pending');
  assert.equal(retriedJob.attempts, 0);
  assert.equal(retriedJob.lastError, null);
  assert.ok(retriedJob.runAt <= Date.now());
});
