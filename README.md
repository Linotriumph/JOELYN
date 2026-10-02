# JOELYN — Background Jobs & Distributed Worker System

**Task 2: Background Jobs Done Properly**

---

## Overview

**JOELYN** is a production-grade background-job and worker execution system designed to move slow, compute-heavy, and unreliable tasks away from synchronous HTTP request cycles.

Clients submit requests to generate comprehensive PDF reports, receive an immediate **HTTP `202 Accepted`** response with a Job ID, and have dedicated worker processes execute, retry, and monitor tasks asynchronously.

---

## Key Features & Guarantees

* **Database-Backed Job Storage**: Every job is persisted in SQLite with WAL mode and strictly typed lifecycle states.
* **Non-Blocking API**: Enqueues jobs and responds in $<5\text{ms}$ with HTTP `202 Accepted`.
* **Atomic Job Claiming**: Uses SQLite `UPDATE ... RETURNING` with subqueries to guarantee two workers never claim the same job.
* **Configurable Worker Concurrency**: Worker concurrency pool limits parallel executions (default: 5 concurrent jobs).
* **Exponential Backoff & Full Jitter**: Intelligently spaces retries to prevent retry stampedes and thundering herd failures.
* **Failure Exhaustion & Dead-Letter Queue (DLQ)**: Jobs stop retrying when exceeding `MAX_JOB_ATTEMPTS` and transition to `dead` status.
* **Stuck-Job Recovery**: Detects orphaned jobs left in `processing` by killed/crashed workers and safely recovers or retires them.
* **Work Idempotency**: Detects deterministic output files (`storage/reports/report_{jobId}.pdf`) to safely tolerate duplicate execution without re-rendering or corrupting documents.
* **Enqueue Idempotency**: Database-enforced `UNIQUE INDEX` on `idempotency_key` guarantees that identical requests never spawn duplicate jobs.
* **Minimal Web Console**: Interactive dashboard to trigger jobs (with deliberate failure toggle), inspect live statuses, view dead jobs, and trigger 1-click manual retries.

---

## Architecture & Lifecycle

### Job Lifecycle State Flow
```text
  [ Client Request ]
         │
         ▼
    ┌─────────┐
    │ pending │ ◄─── (Manual Retry or Transient Failure Backoff)
    └────┬────┘
         │ (Atomic Claim by Worker)
         ▼
  ┌────────────┐
  │ processing │ ─── (Worker Crash / Timeout) ───► [ Stuck-Job Recovery ]
  └──────┬─────┘                                          │
         ├──────────────────────┬─────────────────────────┤
         ▼                      ▼                         ▼
   ┌───────────┐         ┌───────────┐              ┌───────────┐
   │ succeeded │         │  pending  │              │   dead    │
   └───────────┘         │ (retry)   │              │   (DLQ)   │
                         └───────────┘              └───────────┘
```

> **Important Distinction**: `failed` (transient, retryable with exponential backoff) $\neq$ `dead` (quarantined after exhausting maximum retry budget).

For deep technical details, see [docs/ARCHITECTURE.md](file:///c:/Users/HP/Desktop/JOELYN/docs/ARCHITECTURE.md).

---

## Configuration Reference

All settings can be customized via environment variables or a `.env` file:

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | Integer | `3000` | HTTP port for the API server |
| `DATABASE_PATH` | Path | `./data/joelyn.db` | SQLite database file location |
| `STORAGE_DIR` | Path | `./storage/reports` | Directory where generated PDF reports are stored |
| `WORKER_CONCURRENCY` | Integer | `5` | Maximum simultaneous jobs a single worker processes |
| `MAX_JOB_ATTEMPTS` | Integer | `3` | Number of retry attempts before moving a job to `dead` |
| `RETRY_BASE_DELAY_MS`| Integer | `2000` | Initial exponential backoff base delay ($2000\text{ms}$) |
| `RETRY_MAX_DELAY_MS` | Integer | `30000`| Maximum cap for exponential backoff delay ($30000\text{ms}$) |
| `RETRY_JITTER_RATIO` | Float | `0.25` | Random jitter proportion ($0.0 - 1.0$) |
| `PROCESSING_TIMEOUT_MS` | Integer | `15000` | Inactivity threshold to consider a processing job stuck |
| `POLL_INTERVAL_MS` | Integer | `500` | Worker queue polling frequency |
| `RECOVERY_INTERVAL_MS` | Integer | `5000` | Periodic stuck-job recovery scanner interval |

---

## Getting Started

### 1. Installation
```bash
npm install
```

### 2. Database Migrations
```bash
npm run migrate
```

### 3. Running the System

Open two separate terminal windows to demonstrate the independent worker process:

#### Terminal 1 — Start the API Server:
```bash
npm start
```
*API Server runs at: `http://localhost:3000`*
*Web Console is accessible at: `http://localhost:3000`*

#### Terminal 2 — Start the Background Worker:
```bash
npm run worker
```

---

## Break-the-System Failure Testing

The test suite includes dedicated scripts to prove system resilience under critical failure scenarios:

| Command | Purpose & Verification |
| :--- | :--- |
| `npm test` | Runs the automated 14-point unit/integration test suite |
| `npm run test:concurrency` | **Test 1 — 50 Jobs**: Enqueues 50 jobs, verifies concurrency limit ($\le 5$) is strictly respected |
| `npm run test:failure` | **Test 2 — 100% Failure**: Deliberately fails jobs, verifies attempts increment, exponential backoff delays grow, jitter is applied, and job moves to `dead` |
| `npm run test:kill-worker` | **Test 3 — Kill Worker**: Simulates worker crash mid-execution, verifies stuck-job recovery, and replacement worker completion |
| `npm run test:idempotency` | **Test 4 — Duplicate Idempotency**: Submits duplicate keys, verifies DB uniqueness and single-job creation |
| `npm run test:two-workers` | **Test 5 — Two Workers**: Runs 2 simultaneous workers, verifies mutual exclusion and 0 duplicate claims |
| `npm run test:all-scenarios`| Runs all 5 break-it scenarios consecutively with complete logging |

---

## API Specification

### `POST /api/jobs`
Enqueues a background job. Returns HTTP `202 Accepted` immediately.
- **Headers:** `Idempotency-Key: <unique-uuid>` (Required)
- **Body:**
  ```json
  {
    "type": "generate_pdf",
    "payload": {
      "title": "Quarterly Performance Audit",
      "department": "Finance",
      "forceFail": false
    },
    "maxAttempts": 3
  }
  ```
- **Response (HTTP 202):**
  ```json
  {
    "message": "Job accepted for background execution.",
    "data": {
      "jobId": "e0321a42-7a54-46c5-8499-4c8d5046c251",
      "type": "generate_pdf",
      "status": "pending",
      "attempts": 0,
      "maxAttempts": 3,
      "idempotencyKey": "idem-key-123",
      "isDuplicate": false
    }
  }
  ```

### `GET /api/jobs/:id`
Retrieves live status, attempts, error log, and output download link.

### `GET /api/jobs/dead`
Lists all dead jobs currently in the Dead-Letter Queue.

### `POST /api/jobs/:id/retry`
Manually moves a dead job back to `pending` status with a fresh attempt budget.

### `POST /api/jobs/recover-stuck`
Triggers an immediate stuck-job recovery scan.

---

## Documentation Index

- **[Architecture & State Machine Design](file:///c:/Users/HP/Desktop/JOELYN/docs/ARCHITECTURE.md)**
- **[Evidence & Test Run Logs](file:///c:/Users/HP/Desktop/JOELYN/docs/EVIDENCE.md)**
- **[Answers to Defence Questions (Section 33)](file:///c:/Users/HP/Desktop/JOELYN/docs/DEFENCE_ANSWERS.md)**
