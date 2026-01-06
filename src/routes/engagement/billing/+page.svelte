<script lang="ts">
  interface BillingRow {
    memberId: string;
    memberName: string | null;
    memberEmail: string | null;
    employer: string | null;
    registrationAt: number | null; // unix seconds
    lastSessionAt: number | null;  // unix seconds
    isNewParticipant: boolean;
    engagedDuringMonth: boolean;
  }

  interface BillingReport {
    year: number;
    month: number; // 1-12
    monthYearLabel: string;
    monthStart: string;
    monthEnd: string;
    generatedAt: string;
    totalRows: number;
    rows: BillingRow[];
  }

  let report: BillingReport | null = null;
  let cachedReport: BillingReport | null = null;
  let lastLoadedMonthLabel: string | null = null;
  let selectedMonthLabel: string = getCurrentPreviousMonthLabel(); // YYYY-MM


  let loading = false;
  let error: string | null = null;
  let loadingStage: string = '';

  // Employer filter
  let uniqueEmployers: string[] = [];
  let selectedEmployer: string = '';

  // Filtered rows (used for metrics, table, and CSV export)
  let filteredRows: BillingRow[] = [];

  // Derived metrics (based on filteredRows)
  let totalBillable = 0;
  let totalNewParticipants = 0;
  let totalEngaged = 0;
  let totalBoth = 0;
  let totalEngagedOnly = 0;

  function getCurrentPreviousMonthLabel(): string {
    const now = new Date();
    let year = now.getFullYear();
    let monthIndex = now.getMonth(); // 0-11 (current month)

    // previous month
    if (monthIndex === 0) {
      year -= 1;
      monthIndex = 11;
    } else {
      monthIndex -= 1;
    }

    const month = monthIndex + 1;
    return `${year}-${String(month).padStart(2, '0')}`;
  }

  function buildUniqueEmployers() {
    if (!report) {
      uniqueEmployers = [];
      return;
    }

    const set = new Set<string>();
    for (const row of report.rows) {
      if (row.employer != null) {
        set.add(String(row.employer));
      }
    }
    uniqueEmployers = Array.from(set).sort();
  }

  async function runReport() {
    loading = true;
    error = null;
    loadingStage = 'Starting report…';

    try {
      const requestedMonth = selectedMonthLabel || getCurrentPreviousMonthLabel();
      loadingStage = 'Requesting billing report from server…';

      // Reuse cached report if it’s for the same selected month
      if (cachedReport && lastLoadedMonthLabel === requestedMonth) {
        report = cachedReport;
        selectedEmployer = '';
        buildUniqueEmployers();
        return;
      }

      const res = await fetch('/API/intercom/billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthYearLabel: requestedMonth })
      });

      loadingStage = 'Parsing results…';

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const data: BillingReport = await res.json();
      report = data;
      cachedReport = data;
      lastLoadedMonthLabel = data.monthYearLabel;

      selectedEmployer = '';
      buildUniqueEmployers();
      loadingStage = 'Done.';
    } catch (e: any) {
      console.error(e);
      error = e?.message ?? String(e);
    } finally {
      loading = false;
    }
  }


  function formatDateFromUnix(unix: number | null): string {
    if (unix == null) return '';
    const d = new Date(unix * 1000);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString();
  }

  function escapeCsv(value: string): string {
    if (value.includes('"') || value.includes(',') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  function exportCsv() {
    if (!report) return;

    const rows = filteredRows;
    const headers = [
      'User ID',
      'Name',
      'Email',
      'Employer',
      'Registration Date',
      'Last Coaching Call',
      'Is New Participant',
      'Engaged During Month'
    ];

    const lines: string[] = [];
    lines.push(headers.map(escapeCsv).join(','));

    for (const row of rows) {
      const regDate = formatDateFromUnix(row.registrationAt);
      const lastCall = formatDateFromUnix(row.lastSessionAt);

      const values = [
        row.memberId,
        row.memberName ?? '',
        row.memberEmail ?? '',
        row.employer ?? '',
        regDate,
        lastCall,
        row.isNewParticipant ? 'Yes' : 'No',
        row.engagedDuringMonth ? 'Yes' : 'No'
      ];

      lines.push(values.map((v) => escapeCsv(String(v))).join(','));
    }

    const csvContent = lines.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const monthStr = report.month.toString().padStart(2, '0');
    const suffix = selectedEmployer ? `_${selectedEmployer.replace(/[^a-zA-Z0-9_-]/g, '_')}` : '';
    const filename = `billing_${report.year}-${monthStr}${suffix}.csv`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // --- REACTIVE FILTERING & METRICS ---

  // filteredRows depends on both report and selectedEmployer
  $: filteredRows = report
    ? (selectedEmployer
        ? report.rows.filter((r) => r.employer === selectedEmployer)
        : report.rows)
    : [];

  // metrics depend on filteredRows
  $: {
    totalBillable = filteredRows.length;
    totalNewParticipants = filteredRows.filter((r) => r.isNewParticipant).length;
    totalEngaged = filteredRows.filter((r) => r.engagedDuringMonth).length;
    totalBoth = filteredRows.filter(
      (r) => r.isNewParticipant && r.engagedDuringMonth
    ).length;
    totalEngagedOnly = totalEngaged - totalBoth;
  }
</script>

<style>
  .page {
    padding: 1.5rem;
    max-width: 1200px;
    margin: 0 auto;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  h1 {
    font-size: 1.6rem;
    margin-bottom: 0.5rem;
  }

  .subtitle {
    color: #666;
    font-size: 0.9rem;
    margin-bottom: 1rem;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    margin-bottom: 1rem;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    margin-bottom: 1rem;
  }

  .filter-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 240px;
  }

  .filter-group label {
    font-size: 0.8rem;
    font-weight: 600;
    color: #444;
  }

  select,
  input[type='month'] {
    padding: 0.35rem 0.5rem;
    border-radius: 0.25rem;
    border: 1px solid #ccc;
    font-size: 0.9rem;
  }

  button.primary {
    padding: 0.45rem 0.9rem;
    border-radius: 0.3rem;
    border: 1px solid #0077cc;
    background: #0077cc;
    color: white;
    font-size: 0.9rem;
    cursor: pointer;
  }

  button.primary:disabled {
    opacity: 0.5;
    cursor: default;
  }

  button.secondary {
    padding: 0.4rem 0.8rem;
    border-radius: 0.3rem;
    border: 1px solid #555;
    background: #fff;
    color: #333;
    font-size: 0.85rem;
    cursor: pointer;
  }

  button.secondary:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .muted {
    color: #777;
    font-size: 0.8rem;
  }

  .error {
    color: #b00020;
    margin-bottom: 1rem;
  }

  .summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }

  .card {
    padding: 0.75rem 0.9rem;
    border-radius: 0.5rem;
    border: 1px solid #ddd;
    background: #fafafa;
  }

  .card-label {
    font-size: 0.8rem;
    color: #555;
    margin-bottom: 0.15rem;
  }

  .card-value {
    font-size: 1.1rem;
    font-weight: 600;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 1.5rem;
    font-size: 0.9rem;
  }

  th,
  td {
    padding: 0.5rem 0.6rem;
    border: 1px solid #ddd;
    text-align: left;
  }

  thead {
    background: #f3f3f3;
  }

  .chip {
    display: inline-block;
    padding: 0.1rem 0.35rem;
    border-radius: 999px;
    font-size: 0.75rem;
    margin-right: 0.25rem;
  }

  .chip-new {
    background: #e0f7ff;
    color: #005a99;
  }

  .chip-engaged {
    background: #e7ffe0;
    color: #2f7a00;
  }
</style>

<div class="page">
  <h1>Billing Report</h1>
  <div class="subtitle">
    Users who became new participants in the previous calendar month or met the engaged criteria
    (coaching session &le; 56 days ago) for at least one day during that month.
  </div>

  {#if error}
    <div class="error">Error: {error}</div>
  {/if}

  <div class="controls">
    <button class="primary" on:click={runReport} disabled={loading}>
      {#if loading}
        Running billing report…
      {:else if report}
        Reload from cache / Intercom
      {:else}
        Run billing report
      {/if}
    </button>

    </div>
      <div class="filter-group" style="min-width: 180px;">
      <label for="month">Month</label>
      <input id="month" type="month" bind:value={selectedMonthLabel} />
      <div class="muted">Select the calendar month to generate billing for.</div>
    </div>

    {#if report}
      <button class="secondary" on:click={exportCsv}>
        Export CSV (filtered)
      </button>
      <div class="muted">
        Month: {report.monthYearLabel} (from
        {new Date(report.monthStart).toLocaleDateString()} to
        {new Date(report.monthEnd).toLocaleDateString()}) · Generated at
        {new Date(report.generatedAt).toLocaleString()}
      </div>
    {/if}

  {#if report}
    <div class="filters">
      <div class="filter-group">
        <label for="employer">Filter by Employer (Client)</label>
        <select id="employer" bind:value={selectedEmployer}>
          <option value="">All employers</option>
          {#each uniqueEmployers as emp}
            <option value={emp}>{emp}</option>
          {/each}
        </select>
        <div class="muted">
          Filter applies to metrics, table, and CSV export.
        </div>
      </div>
    </div>
  {/if}

  {#if loading && !report}
    <p>Preparing billing report…</p>
  {:else if report}
    <div class="summary">
      <div class="card">
        <div class="card-label">Total billable users (filtered)</div>
        <div class="card-value">{totalBillable}</div>
      </div>
      <div class="card">
        <div class="card-label">New participants (filtered)</div>
        <div class="card-value">{totalNewParticipants}</div>
      </div>
      <div class="card">
        <div class="card-label">Engaged during month (filtered)</div>
        <div class="card-value">{totalEngaged}</div>
      </div>
      <div class="card">
        <div class="card-label">Both new &amp; engaged (filtered)</div>
        <div class="card-value">{totalBoth}</div>
        <div class="muted">Engaged only: {totalEngagedOnly}</div>
      </div>
    </div>

    <h2>Billable Users (top 500 rows)</h2>
    <p class="muted">
      Showing first {Math.min(filteredRows.length, 500)} of {filteredRows.length} filtered rows.
      Use CSV export for the full set.
    </p>

    <table>
      <thead>
        <tr>
          <th>User ID</th>
          <th>Name</th>
          <th>Email</th>
          <th>Employer</th>
          <th>Registration Date</th>
          <th>Last Coaching Call</th>
          <th>Flags</th>
        </tr>
      </thead>
      <tbody>
        {#each filteredRows.slice(0, 500) as row}
          <tr>
            <td>{row.memberId}</td>
            <td>{row.memberName || '(no name)'}</td>
            <td>{row.memberEmail || ''}</td>
            <td>{row.employer || '—'}</td>
            <td>{formatDateFromUnix(row.registrationAt)}</td>
            <td>{formatDateFromUnix(row.lastSessionAt)}</td>
            <td>
              {#if row.isNewParticipant}
                <span class="chip chip-new">New</span>
              {/if}
              {#if row.engagedDuringMonth}
                <span class="chip chip-engaged">Engaged</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
