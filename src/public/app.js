// JOELYN Background Jobs UI Logic

let activePollInterval = null;

function generateUUID() {
  return 'idem-' + Math.random().toString(36).substring(2, 9) + '-' + Date.now().toString(36);
}

document.addEventListener('DOMContentLoaded', () => {
  const keyInput = document.getElementById('idempotencyKey');
  const btnGenerateKey = document.getElementById('btnGenerateKey');
  const jobForm = document.getElementById('jobForm');
  const lookupInput = document.getElementById('lookupJobId');
  const btnLookup = document.getElementById('btnLookup');
  const btnRefreshJobs = document.getElementById('btnRefreshJobs');

  // Initialize random Idempotency Key
  keyInput.value = generateUUID();
  btnGenerateKey.addEventListener('click', () => {
    keyInput.value = generateUUID();
  });

  // Handle Form Submission
  jobForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const title = document.getElementById('reportTitle').value.trim();
    const department = document.getElementById('department').value.trim();
    const idempotencyKey = keyInput.value.trim();
    const maxAttempts = parseInt(document.getElementById('maxAttempts').value, 10);
    const forceFail = document.getElementById('forceFail').checked;

    const payload = {
      title,
      department,
      forceFail,
      requestedBy: 'Web Console User',
      renderDelayMs: 600, // genuine render duration
    };

    try {
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          type: 'generate_pdf',
          payload,
          maxAttempts,
        }),
      });

      const data = await response.json();

      if (response.status === 202) {
        showEnqueueBanner(data.data, data.message);
        lookupInput.value = data.data.jobId;
        startPollingJob(data.data.jobId);
        fetchStats();
        fetchRecentJobs();
      } else {
        alert(`Error enqueuing job: ${data.error || 'Unknown error'}`);
      }
    } catch (err) {
      alert(`Network error: ${err.message}`);
    }
  });

  // Lookup button handler
  btnLookup.addEventListener('click', () => {
    const jobId = lookupInput.value.trim();
    if (jobId) {
      startPollingJob(jobId);
    }
  });

  // Refresh Recent Jobs
  btnRefreshJobs.addEventListener('click', () => {
    fetchRecentJobs();
    fetchDeadJobs();
    fetchStats();
  });

  // Initial load
  fetchStats();
  fetchDeadJobs();
  fetchRecentJobs();

  // Periodic background refresh for dashboard data
  setInterval(() => {
    fetchStats();
    fetchDeadJobs();
    fetchRecentJobs();
  }, 3000);
});

function showEnqueueBanner(jobData, message) {
  const banner = document.getElementById('enqueueResult');
  const bannerTitle = document.getElementById('bannerTitleText');
  const bannerJobId = document.getElementById('bannerJobId');
  const bannerStatus = document.getElementById('bannerStatus');
  const bannerIdempotency = document.getElementById('bannerIdempotency');

  bannerTitle.textContent = message || 'Job Accepted (HTTP 202)';
  bannerJobId.textContent = jobData.jobId;
  bannerStatus.textContent = jobData.status;
  bannerStatus.className = `status-tag tag-${jobData.status}`;
  bannerIdempotency.textContent = jobData.isDuplicate
    ? `⚠️ Duplicate Key Matched Existing Job`
    : `✅ Unique Key Registered`;

  banner.classList.remove('hidden');
}

function startPollingJob(jobId) {
  if (activePollInterval) {
    clearInterval(activePollInterval);
  }

  fetchJobStatus(jobId);
  activePollInterval = setInterval(async () => {
    const job = await fetchJobStatus(jobId);
    if (job && (job.status === 'succeeded' || job.status === 'dead')) {
      clearInterval(activePollInterval);
    }
  }, 1000);
}

async function fetchJobStatus(jobId) {
  const viewer = document.getElementById('statusViewer');
  try {
    const res = await fetch(`/api/jobs/${jobId}`);
    if (!res.ok) {
      viewer.classList.add('hidden');
      return null;
    }

    const { data: job } = await res.json();
    viewer.classList.remove('hidden');

    document.getElementById('viewStatus').textContent = job.status;
    document.getElementById('viewStatus').className = `status-tag tag-${job.status}`;
    document.getElementById('viewJobId').textContent = job.id;
    document.getElementById('viewAttempts').textContent = `${job.attempts} / ${job.maxAttempts}`;
    document.getElementById('viewIdempotencyKey').textContent = job.idempotencyKey;
    document.getElementById('viewRunAt').textContent = job.runAtFormatted || '-';
    document.getElementById('viewCreatedAt').textContent = job.createdAtFormatted || '-';
    document.getElementById('viewFinishedAt').textContent = job.finishedAtFormatted || '-';

    // Download Button
    const downloadContainer = document.getElementById('downloadContainer');
    const downloadBtn = document.getElementById('btnDownloadReport');
    if (job.status === 'succeeded' && job.downloadUrl) {
      downloadBtn.href = job.downloadUrl;
      downloadContainer.classList.remove('hidden');
    } else {
      downloadContainer.classList.add('hidden');
    }

    // Error box
    const errorBox = document.getElementById('errorBox');
    const viewLastError = document.getElementById('viewLastError');
    if (job.lastError) {
      viewLastError.textContent = job.lastError;
      errorBox.classList.remove('hidden');
    } else {
      errorBox.classList.add('hidden');
    }

    // Result box
    const resultBox = document.getElementById('resultBox');
    const viewResult = document.getElementById('viewResult');
    if (job.result) {
      viewResult.textContent = JSON.stringify(job.result, null, 2);
      resultBox.classList.remove('hidden');
    } else {
      resultBox.classList.add('hidden');
    }

    return job;
  } catch (err) {
    console.error('Error fetching job status:', err);
    return null;
  }
}

async function fetchStats() {
  try {
    const res = await fetch('/api/jobs/stats');
    const { data } = await res.json();
    document.getElementById('statTotal').textContent = data.total;
    document.getElementById('statPending').textContent = data.pending;
    document.getElementById('statProcessing').textContent = data.processing;
    document.getElementById('statSucceeded').textContent = data.succeeded;
    document.getElementById('statDead').textContent = data.dead;
  } catch (e) {
    // Ignore fetch error
  }
}

async function fetchDeadJobs() {
  try {
    const res = await fetch('/api/jobs/dead');
    const { data } = await res.json();
    const tbody = document.getElementById('deadTableBody');

    if (!data || data.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No dead jobs in queue. System is healthy!</td></tr>`;
      return;
    }

    tbody.innerHTML = data
      .map(
        (job) => `
      <tr>
        <td><code>${job.id.substring(0, 8)}...</code></td>
        <td>${job.type}</td>
        <td><span class="status-tag tag-dead">${job.attempts}/${job.maxAttempts}</span></td>
        <td style="color:#F87171; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${escapeHtml(job.lastError || 'Unknown')}
        </td>
        <td>${new Date(job.createdAt).toLocaleTimeString()}</td>
        <td>
          <button class="btn-retry" onclick="retryJob('${job.id}')">Retry</button>
        </td>
      </tr>
    `
      )
      .join('');
  } catch (e) {
    // Ignore fetch error
  }
}

async function fetchRecentJobs() {
  try {
    const res = await fetch('/api/jobs?limit=10');
    const { data } = await res.json();
    const tbody = document.getElementById('recentTableBody');

    if (!data || data.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No recent jobs found.</td></tr>`;
      return;
    }

    tbody.innerHTML = data
      .map(
        (job) => `
      <tr>
        <td><code>${job.id.substring(0, 8)}...</code></td>
        <td><span class="status-tag tag-${job.status}">${job.status}</span></td>
        <td>${job.attempts}/${job.maxAttempts}</td>
        <td><code>${escapeHtml(job.idempotencyKey.substring(0, 16))}...</code></td>
        <td>${new Date(job.createdAt).toLocaleTimeString()}</td>
        <td>
          <button class="btn-secondary btn-xs" onclick="inspectJob('${job.id}')">Inspect</button>
        </td>
      </tr>
    `
      )
      .join('');
  } catch (e) {
    // Ignore fetch error
  }
}

window.retryJob = async function (id) {
  try {
    const res = await fetch(`/api/jobs/${id}/retry`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      alert(`Job ${id.substring(0, 8)}... has been reset to pending!`);
      fetchDeadJobs();
      fetchStats();
      fetchRecentJobs();
      inspectJob(id);
    } else {
      alert(`Failed to retry job: ${data.error}`);
    }
  } catch (err) {
    alert(`Retry error: ${err.message}`);
  }
};

window.inspectJob = function (id) {
  document.getElementById('lookupJobId').value = id;
  startPollingJob(id);
  window.scrollTo({ top: document.getElementById('statusSection').offsetTop - 80, behavior: 'smooth' });
};

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
