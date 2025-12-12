<!-- src/routes/intercom/sessions/+page.svelte -->
<script lang="ts">
  type SessionChannel = 'Phone' | 'Video Conference' | 'Email' | 'Chat';

  interface SessionDetailRow {
    memberId: string;
    memberName: string | null;
    memberEmail: string | null;
    client: string | null;
    coachId: string | null;
    coachName: string | null;
    channel: SessionChannel;
    time: number;      // unix seconds
    daysSince: number; // days since session at time of report generation
  }

  interface CaseloadSummary {
    last_8_days: number;
    last_29_days: number;
    days_29_to_56: number;
    over_56_days: number;
  }

  interface CaseloadMemberRow {
    memberId: string;
    memberName: string | null;
    memberEmail: string | null;
    client: string | null;
    coachIds: string[];
    coachNames: string[];
    channelsUsed: SessionChannel[];
    channelCombo: string;
    lastSessionAt: number;
    daysSinceLastSession: number;
    buckets: {
      last_8_days: boolean;
      last_29_days: boolean;
      days_29_to_56: boolean;
      over_56_days: boolean;
    };
  }

  interface CaseloadReport {
    lookbackDays: number;
    generatedAt: string;
    totalMembers: number;
    summary: CaseloadSummary;
    members: CaseloadMemberRow[];
    sessions: SessionDetailRow[];
  }

  interface CoachOption {
    id: string;
    name: string;
  }

  // Active report for this page
  let report: CaseloadReport | null = null;

  // Cached report in memory for this browser session
  let cachedReport: CaseloadReport | null = null;
  let lastLoadedLookbackDays: number | null = null;

  let loading = false;
  let error: string | null = null;

  // Controls
  let selectedLookbackDays: string = ''; // user must set before first load
  let selectedCoachId = '';
  let selectedClient = '';
  const allChannels: SessionChannel[] = ['Phone', 'Video Conference', 'Email', 'Chat'];
  let selectedChannels: Record<SessionChannel, boolean> = {
    Phone: true,
    'Video Conference': true,
    Email: true,
    Chat: true
  };

  // Custom date range (for the "adjustable date range" metric)
  let rangeStart = ''; // 'YYYY-MM-DD'
  let rangeEnd = '';   // 'YYYY-MM-DD'

  // Derived filters
  let uniqueCoaches: CoachOption[] = [];
  let uniqueClients: string[] = [];

  // Sessions to display after coach/client/channel filters
  let filteredSessions: SessionDetailRow[] = [];

  // Metrics
  let totalLast8Days = 0;
  let totalLast28Days = 0;
  let totalLast57Days = 0;
  let totalInCustomRange = 0;

  function buildDerivedFiltersFrom(source: CaseloadReport | null) {
    if (!source) return;

    const coachMap = new Map<string, string>();
    const clientSet = new Set<string>();

    for (const s of source.sessions) {
      if (s.coachId) {
        const name = String(s.coachName ?? s.coachId);
        if (!coachMap.has(s.coachId)) {
          coachMap.set(s.coachId, name);
        }
      }
      if (s.client != null) {
        clientSet.add(String(s.client));
      }
    }

    uniqueCoaches = Array.from(coachMap.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    uniqueClients = Array.from(clientSet).sort();
  }

  function ensureRangeDefaults() {
    if (!report || !report.sessions.length) return;
    if (rangeStart && rangeEnd) return; // user already set

    const timesMs = report.sessions.map((s) => s.time * 1000);
    const minMs = Math.min(...timesMs);
    const maxMs = Math.max(...timesMs);

    const startDate = new Date(minMs);
    const endDate = new Date(maxMs);

    rangeStart = toDateInputValue(startDate);
    rangeEnd = toDateInputValue(endDate);
  }

  function toDateInputValue(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function applyFiltersAndMetrics() {
    if (!report) {
      filteredSessions = [];
      totalLast8Days = totalLast28Days = totalLast57Days = totalInCustomRange = 0;
      return;
    }

    let sessions = report.sessions;

    // Coach filter
    if (selectedCoachId) {
      sessions = sessions.filter((s) => s.coachId === selectedCoachId);
    }

    // Client filter
    if (selectedClient) {
      sessions = sessions.filter((s) => s.client === selectedClient);
    }

    // Channel filter
    const activeChannels = new Set(
      allChannels.filter((ch) => selectedChannels[ch])
    );
    if (activeChannels.size > 0 && activeChannels.size < allChannels.length) {
      sessions = sessions.filter((s) => activeChannels.has(s.channel));
    }

    filteredSessions = sessions;

    // Metrics: last 8/28/56 days (relative to "now" from backend)
    totalLast8Days = filteredSessions.filter((s) => s.daysSince <= 7).length;
    totalLast28Days = filteredSessions.filter((s) => s.daysSince <= 28).length;
    totalLast57Days = filteredSessions.filter((s) => s.daysSince <= 56).length;

    // Custom date range metric
    if (!report.sessions.length) {
      totalInCustomRange = 0;
      return;
    }

    const allTimesMs = report.sessions.map((s) => s.time * 1000);
    let minMs = Math.min(...allTimesMs);
    let maxMs = Math.max(...allTimesMs);

    // Use user-specified dates if present; otherwise full loaded window
    if (rangeStart) {
      const d = new Date(rangeStart);
      if (!Number.isNaN(d.getTime())) {
        minMs = d.getTime();
      }
    }
    if (rangeEnd) {
      const d = new Date(rangeEnd);
      if (!Number.isNaN(d.getTime())) {
        // inclusive end-of-day
        maxMs = d.getTime() + 24 * 60 * 60 * 1000 - 1;
      }
    }

    totalInCustomRange = filteredSessions.filter((s) => {
      const ms = s.time * 1000;
      return ms >= minMs && ms <= maxMs;
    }).length;
  }

  /**
   * Main loader triggered by the button.
   * - uses lookbackDays only to control how far back we fetch
   * - no default; user must provide it
   * - cache is reused if requested ≤ lastLoadedLookbackDays
   */
  async function loadReport() {
    loading = true;
    error = null;

    try {
      const parsed = Number(selectedLookbackDays);
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new Error('Please enter a lookback window in days (e.g., 30, 90, 365).');
      }

      let requested = parsed;
      if (requested > 365) requested = 365;
      selectedLookbackDays = String(requested);

      // Reuse cached data if we already loaded a larger/equal window
      if (cachedReport && lastLoadedLookbackDays !== null && requested <= lastLoadedLookbackDays) {
        report = cachedReport;
        ensureRangeDefaults();
        buildDerivedFiltersFrom(report);
        applyFiltersAndMetrics();
        return;
      }

      const res = await fetch('/API/intercom/caseload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lookbackDays: requested })
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const data: CaseloadReport = await res.json();

      cachedReport = data;
      lastLoadedLookbackDays = data.lookbackDays;
      report = data;

      ensureRangeDefaults();
      buildDerivedFiltersFrom(report);
      applyFiltersAndMetrics();
    } catch (e: any) {
      console.error(e);
      error = e?.message ?? String(e);
    } finally {
      loading = false;
    }
  }

  // Recompute whenever report or filter controls change
  $: if (report) {
    applyFiltersAndMetrics();
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

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    padding: 1rem;
    margin-bottom: 1.5rem;
    border-radius: 0.5rem;
    border: 1px solid #ddd;
    background: #fafafa;
  }

  .filter-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 220px;
  }

  .filter-group label {
    font-size: 0.8rem;
    font-weight: 600;
    color: #444;
  }

  select,
  input[type='number'],
  input[type='date'] {
    padding: 0.35rem 0.5rem;
    border-radius: 0.25rem;
    border: 1px solid #ccc;
    font-size: 0.9rem;
  }

  .channel-checkboxes {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .channel-checkboxes label {
    font-weight: 400;
  }

  button.reload {
    margin-top: 0.5rem;
    align-self: flex-start;
    padding: 0.4rem 0.9rem;
    border-radius: 0.25rem;
    border: 1px solid #0077cc;
    background: #0077cc;
    color: white;
    font-size: 0.9rem;
    cursor: pointer;
  }

  button.reload:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }

  .metric-card {
    padding: 0.75rem 0.9rem;
    border-radius: 0.5rem;
    border: 1px solid #ddd;
    background: #fafafa;
  }

  .metric-label {
    font-size: 0.8rem;
    color: #555;
    margin-bottom: 0.25rem;
  }

  .metric-value {
    font-size: 1.2rem;
    font-weight: 600;
  }

  .muted {
    color: #777;
    font-size: 0.8rem;
  }

  .error {
    color: #b00020;
    margin-bottom: 1rem;
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

  .pill {
    display: inline-block;
    padding: 0.1rem 0.35rem;
    border-radius: 999px;
    background: #eee;
    font-size: 0.75rem;
    margin-right: 0.25rem;
    margin-bottom: 0.1rem;
  }
</style>

<div class="page">
  <h1>Intercom Coaching Sessions Report</h1>
  <div class="subtitle">
    Total coaching sessions by time window, coach, client, and channel.
  </div>

  {#if error}
    <div class="error">Error: {error}</div>
  {/if}

  <div class="filters">
    <div class="filter-group">
      <label for="lookback">Lookback window for data (days, max 365)</label>
      <input
        id="lookback"
        type="number"
        min="1"
        max="365"
        bind:value={selectedLookbackDays}
      />
      <button class="reload" on:click={loadReport} disabled={loading}>
        {#if loading}
          Loading…
        {:else if report}
          Reload data
        {:else}
          Load data
        {/if}
      </button>
      <div class="muted">
        This controls how far back we load sessions from Intercom.
      </div>
    </div>

    <div class="filter-group">
      <label for="coach">Coach</label>
      <select id="coach" bind:value={selectedCoachId}>
        <option value="">All coaches</option>
        {#each uniqueCoaches as coach}
          <option value={coach.id}>{coach.name} ({coach.id})</option>
        {/each}
      </select>
    </div>

    <div class="filter-group">
      <label for="client">Client</label>
      <select id="client" bind:value={selectedClient}>
        <option value="">All clients</option>
        {#each uniqueClients as c}
          <option value={c}>{c}</option>
        {/each}
      </select>
    </div>

    <div class="filter-group">
      <label>Channels</label>
      <div class="channel-checkboxes">
        {#each allChannels as ch}
          <label>
            <input
              type="checkbox"
              bind:checked={selectedChannels[ch]}
            />
            {ch}
          </label>
        {/each}
      </div>
      <div class="muted">
        Session must match one of the selected channels.
      </div>
    </div>

    <div class="filter-group">
      <label>Custom date range (for "total sessions" metric)</label>
      <div>
        <input type="date" bind:value={rangeStart} />
        <input type="date" bind:value={rangeEnd} style="margin-left: 0.25rem;" />
      </div>
      <div class="muted">
        Defaults to full loaded window. Adjust to see total sessions in any range.
      </div>
    </div>
  </div>

  {#if loading && !report}
    <p>Loading sessions…</p>
  {:else if report}
    <div class="metrics">
      <div class="metric-card">
        <div class="metric-label">Sessions last ≤ 7 days</div>
        <div class="metric-value">{totalLast8Days}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Sessions last ≤ 28 days</div>
        <div class="metric-value">{totalLast28Days}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Sessions last ≤ 56 days</div>
        <div class="metric-value">{totalLast57Days}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Sessions in custom date range</div>
        <div class="metric-value">{totalInCustomRange}</div>
        <div class="muted">
          Range: {rangeStart || 'min'} → {rangeEnd || 'max'}
        </div>
      </div>
    </div>

    <p class="muted">
      Loaded {report.sessions.length} sessions in the last {report.lookbackDays} days
      (before filters). Showing {filteredSessions.length} after filters.
    </p>

    <h2>Sessions (filtered)</h2>
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Member</th>
          <th>Client</th>
          <th>Coach</th>
          <th>Channel</th>
          <th>Days since</th>
        </tr>
      </thead>
      <tbody>
        {#each filteredSessions.slice(0, 500) as s}
          <tr>
            <td>{new Date(s.time * 1000).toLocaleString()}</td>
            <td>
              {s.memberName || '(no name)'}
              <div class="muted">{s.memberEmail}</div>
            </td>
            <td>{s.client || '—'}</td>
            <td>{s.coachName || s.coachId || 'Unassigned'}</td>
            <td><span class="pill">{s.channel}</span></td>
            <td>{s.daysSince.toFixed(1)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
