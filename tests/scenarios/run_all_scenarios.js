const { runConcurrencyTest } = require('./test1_concurrency');
const { runForceFailureTest } = require('./test2_force_failure');
const { runWorkerCrashRecoveryTest } = require('./test3_worker_crash');
const { runIdempotencyTest } = require('./test4_idempotency');
const { runTwoWorkersTest } = require('./test5_two_workers');

async function main() {
  console.log('\n========================================================');
  console.log('JOELYN BACKGROUND JOBS — RUNNING ALL BREAK-IT SCENARIOS');
  console.log('========================================================\n');

  try {
    await runConcurrencyTest();
    await runForceFailureTest();
    await runWorkerCrashRecoveryTest();
    await runIdempotencyTest();
    await runTwoWorkersTest();

    console.log('========================================================');
    console.log('🎉 ALL 5 REQUIRED BREAK-IT SCENARIO TESTS PASSED!');
    console.log('========================================================\n');
  } catch (err) {
    console.error('\n❌ Scenario tests failed with error:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
