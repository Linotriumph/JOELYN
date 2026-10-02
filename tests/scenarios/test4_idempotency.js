const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const { runMigrations } = require('../../src/db/migrations');
const jobService = require('../../src/services/jobService');

async function runIdempotencyTest() {
  console.log('====================================================');
  console.log('TEST 4: DUPLICATE IDEMPOTENCY KEY ENFORCEMENT');
  console.log('====================================================');

  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  const service = new (jobService.constructor)(db);

  const IDEMPOTENCY_KEY = `order-checkout-uuid-abc-123`;

  console.log(`[Request 1] Submitting enqueue with Idempotency-Key: "${IDEMPOTENCY_KEY}"...`);
  const res1 = service.enqueueJob({
    type: 'generate_pdf',
    payload: { title: 'First Submission' },
    idempotencyKey: IDEMPOTENCY_KEY,
  });

  console.log(`- Request 1 Response: Job ID: ${res1.job.id}, IsDuplicate: ${res1.isDuplicate}`);
  assert.equal(res1.isDuplicate, false, 'First submission should create a new job');

  console.log(`\n[Request 2] Submitting duplicate enqueue with SAME Idempotency-Key: "${IDEMPOTENCY_KEY}"...`);
  const res2 = service.enqueueJob({
    type: 'generate_pdf',
    payload: { title: 'Second Identical Submission' },
    idempotencyKey: IDEMPOTENCY_KEY,
  });

  console.log(`- Request 2 Response: Job ID: ${res2.job.id}, IsDuplicate: ${res2.isDuplicate}`);
  assert.equal(res2.isDuplicate, true, 'Second submission must be recognized as duplicate');
  assert.equal(res1.job.id, res2.job.id, 'Both requests must refer to the exact same Job ID');

  // Verify Database Level Row Count
  const countRow = db.prepare('SELECT COUNT(*) as count FROM jobs').get();
  console.log(`\n[Database Verification] Total rows in jobs table: ${countRow.count}`);
  assert.equal(countRow.count, 1, 'Database must contain EXACTLY 1 row, not 2');

  // Direct DB insertion attempt bypassing service to verify UNIQUE constraint
  console.log('[Constraint Verification] Attempting raw SQL direct insert with duplicate key...');
  let constraintViolated = false;
  try {
    db.prepare(`
      INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, run_at, idempotency_key, created_at, updated_at)
      VALUES ('fake-id', 'generate_pdf', '{}', 'pending', 0, 3, ${Date.now()}, '${IDEMPOTENCY_KEY}', ${Date.now()}, ${Date.now()})
    `).run();
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed') || err.message.includes('idx_jobs_idempotency_key')) {
      constraintViolated = true;
      console.log(`  Expected SQLite error caught: "${err.message}"`);
    }
  }

  assert.equal(constraintViolated, true, 'Database level UNIQUE constraint must reject duplicate keys');

  console.log('✅ TEST 4 PASSED: Database-level idempotency enforced without duplicate jobs.\n');
}

if (require.main === module) {
  runIdempotencyTest().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { runIdempotencyTest };
