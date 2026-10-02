# JOELYN Background Jobs — Defence Questions & Answers

This document provides formal, precise answers to the 7 core defence questions specified in Section 33 of the task specification.

---

### Question 1: Exactly how do two workers avoid processing the same job?

**Answer:**
Atomic job claiming is implemented directly at the database engine level via SQLite's atomic `UPDATE ... RETURNING` statement with a prioritized subquery:

```sql
UPDATE jobs
SET status = 'processing',
    started_at = :now,
    updated_at = :now
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'pending'
    AND run_at <= :now
  ORDER BY run_at ASC, created_at ASC
  LIMIT 1
)
RETURNING *;
```

When two worker processes query for a job simultaneously:
1. SQLite's write transaction acquires an exclusive write lock for the mutation.
2. The inner subquery evaluates the first eligible pending job.
3. The row's status transitions atomically from `pending` to `processing` in the exact same database operation.
4. The database returns the claimed row exclusively to the worker that executed the update.
5. The second worker's claim query will see that the row is already in `processing` status (or will wait via `busy_timeout` and claim the next available pending job).

Because there is no separate `SELECT` followed by an unprotected application `UPDATE`, race conditions are mathematically impossible.

---

### Question 2: What happens if the worker crashes immediately after the actual work succeeds but before the job is marked `succeeded`?

**Answer:**
This is solved by **Work Idempotency**.

1. The background task (PDF generation) produces deterministic output identities based on the job ID (`storage/reports/report_{jobId}.pdf`).
2. If the worker crashes after writing the PDF to disk but before the database status update completes, the stuck-job recovery scanner will eventually detect that the job remained in `processing` beyond `PROCESSING_TIMEOUT_MS`.
3. The recovery scanner increments the attempt count and resets the job status to `pending`.
4. When a replacement worker claims the job again, `PdfService.generateReport(jobId)` checks if `report_{jobId}.pdf` already exists on disk and is non-empty.
5. If the file already exists, the service reuses the existing generated document instead of re-rendering or corrupting the output, and returns the deterministic metadata.
6. The replacement worker immediately transitions the job to `succeeded`.

This guarantees that duplicate execution does not create duplicate or corrupted output.

---

### Question 3: Why are jitter and exponential backoff necessary?

**Answer:**
When downstream dependencies or rendering services experience temporary outages (e.g., database connection saturation or third-party service degradation), multiple jobs fail at the same instant.

- **Exponential Backoff (`baseDelay * 2^(attempts - 1)`):** Progressively increases the delay between retry attempts (e.g., 2s → 4s → 8s → 16s). This gives downstream dependencies sufficient time to recover rather than hammering them with fixed-interval retries.
- **Randomized Jitter (`+ Math.random() * jitterRatio * exponentialDelay`):** Prevents the **Thundering Herd Problem** (stampede effect). Without jitter, 100 jobs failing at $T=0$ with a 2-second backoff would all wake up and retry simultaneously at exactly $T=2.000$, causing immediate re-congestion. Jitter distributes retry timestamps across a randomized interval window, smoothing out traffic spikes.

---

### Question 4: What happens if a job remains `processing` for one hour?

**Answer:**
A job remaining in `processing` for one hour is recognized as an orphaned/stuck job caused by an ungraceful worker termination (e.g., worker container crash, OOM kill, or network partition).

1. The system runs an automated recovery scan every `RECOVERY_INTERVAL_MS` (default 5s).
2. The scanner queries `SELECT * FROM jobs WHERE status = 'processing' AND started_at <= now - PROCESSING_TIMEOUT_MS`.
3. For any stuck job, the system increments `attempts`.
4. **If attempts < maxAttempts:** The job is transitioned back to `pending`, scheduled with exponential backoff and jitter (`runAt = now + delay`), and its `last_error` is recorded as a timeout recovery event.
5. **If attempts >= maxAttempts:** The job transitions to `dead` (Dead-Letter Queue), recording that it exhausted its maximum attempts while in a processing timeout.

---

### Question 5: Why does the API return HTTP `202 Accepted`?

**Answer:**
HTTP `202 Accepted` is the standard status code indicating that a request has been accepted for processing, but the processing has not been completed (RFC 9110 Section 15.3.3).

In JOELYN:
1. Generating a PDF report is a slow, multi-second asynchronous operation.
2. The API request handler validates input, persists the Job row with initial status `pending`, and immediately returns HTTP `202` with the `jobId` in under 5ms.
3. This prevents blocking web server threads, avoids HTTP gateway timeouts (e.g., 504 Gateway Timeout on proxies/CDNs), and allows the client to asynchronously poll `GET /api/jobs/:id` or receive webhooks.

---

### Question 6: Why does the system need both `failed` and `dead`?

**Answer:**
`failed` and `dead` represent fundamentally distinct states in the job lifecycle:

- **`failed` (or `pending` retryable):** Indicates an individual attempt failed, but the job has remaining retry attempts (`attempts < maxAttempts`). The job remains active in the queue and will be retried automatically after its exponential backoff delay expires.
- **`dead` (Dead-Letter Queue):** Indicates the job has exhausted all allowed retry attempts (`attempts >= maxAttempts`). The system will **never** automatically retry a `dead` job again, preventing infinite retry loops and wasted compute. A `dead` job requires human inspection and manual intervention (`POST /api/jobs/:id/retry`).

Collapsing these two states would either cause infinite retries or prematurely abandon retryable transient failures.

---

### Question 7: Why is the idempotency key enforced at the database level?

**Answer:**
If idempotency was enforced only at the application level (e.g., `SELECT WHERE idempotency_key = ?` followed by `INSERT`), two identical requests arriving simultaneously on different threads or API instances would both execute the `SELECT`, find no existing job, and both execute an `INSERT`, creating duplicate jobs.

By adding a `UNIQUE INDEX` on `jobs.idempotency_key` in the database schema:
1. The database engine enforces uniqueness at the storage engine level inside atomic write locks.
2. If two concurrent HTTP requests submit the same idempotency key simultaneously, the database permits only the first `INSERT` and rejects the second with a UNIQUE constraint violation (`SQLITE_CONSTRAINT`).
3. The API catches this violation and immediately returns the existing job with HTTP 202, guaranteeing strictly **one logical job row per idempotency key**.
