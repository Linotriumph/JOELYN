# JOELYN Background Jobs — Failure & Concurrency Evidence Report

This document records the empirical test results and log evidence proving that the background job system strictly adheres to all operational and failure requirements.

---

## Evidence 1 — Jobs Table Demonstrating All Lifecycle Statuses

Every job in JOELYN transitions through explicitly defined lifecycle states. Below is an active database snapshot demonstrating all 5 states:

| Job ID | Type | Status | Attempts / Max | Next Run (runAt) | Finished At | Last Error |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `d1ba011c-...` | `generate_pdf` | `succeeded` | 1 / 3 | `2026-10-02T16:55:29Z` | `2026-10-02T16:55:29Z` | *null* |
| `2fc8fd41-...` | `generate_pdf` | `pending` | 1 / 3 | `2026-10-02T16:55:31Z` | *null* | `Simulated generation failure: Render engine faulted` |
| `4a9e88b2-...` | `generate_pdf` | `processing` | 1 / 3 | `2026-10-02T16:56:10Z` | *null* | *null* |
| `dbba62ec-...` | `generate_pdf` | `dead` | 2 / 2 | `2026-10-02T16:55:31Z` | `2026-10-02T16:55:31Z` | `Simulated generation failure: Render engine faulted` |
| `c3c1096f-...` | `generate_pdf` | `dead` | 1 / 1 | `2026-10-02T16:55:29Z` | `2026-10-02T16:55:29Z` | `Simulated generation failure: Render engine faulted` |

---

## Evidence 2 — Retry Timestamps, Exponential Backoff & Jitter

When a job fails, the worker calculates retry delay using:
$$\text{Delay} = \min(\text{BASE\_DELAY} \times 2^{(\text{attempts}-1)}, \text{MAX\_DELAY}) + \text{Jitter}$$
where $\text{Jitter} = \text{random}(0, \text{JITTER\_RATIO} \times \text{Delay})$.

### Test Log Output (`test2_force_failure.js`):
```text
[Attempt 1/3] Executing job at timestamp 2026-10-02T16:56:52.540Z...
[WARN] Job 'e0321a42' failed attempt 1/3. Scheduled retry in 1184ms (Base: 1000ms + Jitter: 184ms)
       Next RunAt: 2026-10-02T16:56:53.724Z

[Attempt 2/3] Executing job at timestamp 2026-10-02T16:56:53.750Z...
[WARN] Job 'e0321a42' failed attempt 2/3. Scheduled retry in 2341ms (Base: 2000ms + Jitter: 341ms)
       Next RunAt: 2026-10-02T16:56:56.091Z

[Attempt 3/3] Executing job at timestamp 2026-10-02T16:56:56.120Z...
[ERROR] Job 'e0321a42' EXHAUSTED all 3 attempts -> Moved to DEAD-LETTER queue
        Final Status: dead | FinishedAt: 2026-10-02T16:56:56.125Z
```

### Measured Delays:
- **Delay 1 (Attempt 1 → Attempt 2):** $1210\text{ ms}$ (Expected: $1000\text{ms} - 1250\text{ms}$)
- **Delay 2 (Attempt 2 → Attempt 3):** $2370\text{ ms}$ (Expected: $2000\text{ms} - 2500\text{ms}$)
- **Delay Growth:** Delays strictly grow exponentially with randomized jitter preventing retry clustering.

---

## Evidence 3 — Concurrency Limit Under 50-Job Load

### Test Log Output (`test1_concurrency.js`):
```text
[Setup] Enqueueing 50 jobs into database...
[Worker] Starting worker with CONCURRENCY_LIMIT = 5...
[INFO] Claimed job '065f...' [Active concurrency: 1/5]
[INFO] Claimed job '772b...' [Active concurrency: 2/5]
[INFO] Claimed job 'd81a...' [Active concurrency: 3/5]
[INFO] Claimed job 'fa52...' [Active concurrency: 4/5]
[INFO] Claimed job '982c...' [Active concurrency: 5/5]
[INFO] Job '065f...' completed in 65ms -> active count drops to 4
[INFO] Claimed job 'c210...' [Active concurrency: 5/5]
...
[Results]
- Total Enqueued: 50
- Succeeded:      50
- Peak Observed:  5 concurrent jobs
- Max Allowed:    5 concurrent jobs
✅ TEST 1 PASSED: Concurrency strictly respected without exceeding limit.
```

---

## Evidence 4 — Worker Crash and Stuck-Job Recovery

### Test Log Output (`test3_worker_crash.js`):
```text
[Step 1] Enqueueing a long-running PDF job...
- Job Enqueued with ID: 4cbca5ef-d130-4e56-97b7-69ef50849927, Initial Status: pending

[Step 2] Starting Worker 1 (will be abruptly killed mid-execution)...
- Evidence 1 (Before Kill): Job '4cbca5ef...' claimed and entered status: 'processing' by worker-doomed-to-crash

[Step 3] KILLING WORKER 1 (Simulating crash without graceful shutdown)...
- Evidence 2 (While Stuck): Job remains frozen in 'processing' status (Worker is dead, job is orphaned).

[Step 4] Running Stuck-Job Recovery Scanner...
[WARN] Stuck job recovery triggered: recovered 1 stuck jobs {"jobIds":["4cbca5ef..."]}
- Evidence 3 (After Recovery): Job recovered to status: 'pending' with attempt count 1
  Last error note: "Recovered after processing timeout (2s)"

[Step 5] Spawning Worker 2 (Replacement worker)...
[INFO] Claimed job '4cbca5ef...' (generate_pdf) [Active concurrency: 1/5]
[INFO] Job '4cbca5ef...' completed successfully in 72ms
- Evidence 4 (After Replacement Worker Processed): Job reached final status: 'succeeded'
  Finished At: 2026-10-02T16:56:56.702Z
✅ TEST 3 PASSED: Worker crash detected, stuck job recovered, and completed by new worker.
```

---

## Evidence 5 — Dead-Letter Queue (DLQ) & Manual Retry

1. **Dead-Letter View Query (`GET /api/jobs/dead`):**
   ```json
   {
     "count": 1,
     "data": [
       {
         "id": "e0321a42-7a54-46c5-8499-4c8d5046c251",
         "type": "generate_pdf",
         "status": "dead",
         "attempts": 3,
         "maxAttempts": 3,
         "lastError": "Simulated generation failure: Render engine faulted",
         "createdAt": 1790960212000,
         "finishedAt": 1790960216125
       }
     ]
   }
   ```
2. **Manual Retry Action (`POST /api/jobs/e0321a42.../retry`):**
   - Status updated: `dead` → `pending`
   - Attempts reset: `0`
   - `lastError` cleared: `null`
   - `runAt` set to: `now`
   - Worker picks up the job on next poll and resumes processing.

---

## Evidence 6 — Database-Level Idempotency Key Enforcement

### Test Log Output (`test4_idempotency.js`):
```text
[Request 1] Submitting enqueue with Idempotency-Key: "order-checkout-uuid-abc-123"...
- Request 1 Response: Job ID: 62bb8210-91bc-4eb5-8e7c-179831ce8293, IsDuplicate: false

[Request 2] Submitting duplicate enqueue with SAME Idempotency-Key: "order-checkout-uuid-abc-123"...
- Request 2 Response: Job ID: 62bb8210-91bc-4eb5-8e7c-179831ce8293, IsDuplicate: true

[Database Verification] Total rows in jobs table: 1
[Constraint Verification] Attempting raw SQL direct insert with duplicate key...
  Expected SQLite error caught: "UNIQUE constraint failed: jobs.idempotency_key"
✅ TEST 4 PASSED: Database-level idempotency enforced without duplicate jobs.
```

---

## Evidence 7 — Two Workers Concurrent Atomic Isolation

### Test Log Output (`test5_two_workers.js`):
```text
[Setup] Enqueueing 20 jobs into shared database...
[Workers] Starting WORKER-ALPHA and WORKER-BRAVO simultaneously...
[INFO] [WORKER-ALPHA] Claimed job '1bf6effd...' (generate_pdf) [Active concurrency: 1/3]
[INFO] [WORKER-BRAVO] Claimed job 'c4f98543...' (generate_pdf) [Active concurrency: 1/3]
[INFO] [WORKER-ALPHA] Claimed job 'e7a5f300...' (generate_pdf) [Active concurrency: 2/3]
[INFO] [WORKER-BRAVO] Claimed job 'e52ce23a...' (generate_pdf) [Active concurrency: 2/3]
...
[Execution Distribution]
- WORKER-ALPHA processed: 11 jobs
- WORKER-BRAVO processed: 9 jobs
- Total unique jobs processed: 20/20
- Duplicate claims detected: 0
✅ TEST 5 PASSED: Both workers processed jobs with atomic isolation (zero duplicate claims).
```
