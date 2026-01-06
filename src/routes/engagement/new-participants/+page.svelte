<!-- src/routes/intercom/new-participants/+page.svelte -->
<script lang="ts">
  type SessionChannel = 'Phone' | 'Video Conference' | 'Email' | 'Chat';

  interface ParticipantBuckets {
    gt_14_to_21: boolean;
    gt_21_to_28: boolean;
    gt_28: boolean; // Unengaged for this report
  }

  interface ParticipantRow {
    memberId: string;
    memberName: string | null;
    memberEmail: string | null;
    client: string | null;
    participantAt: number | null; // Enrolled Date (unix seconds)
    daysSinceParticipant: number | null;

    hasSession: boolean;
    firstSessionAt: number | null;
    lastSessionAt: number | null;
    daysSinceLastSession: number | null;

    coachIds: string[];
    coachNames: string[];
    channelsUsed: SessionChannel[];

    // metric for buckets: days since last session, or since Enrolled Date if no sessions
    daysWithoutSession: number | null;
    buckets: ParticipantBuckets;
  }

  interface NewParticipantsSummary {
    gt_14_to_21: number;
    gt_21_to_28: number;
    gt_28: number;
  }

  interface NewParticipantsReport {
    generatedAt: string;
    lookbackDays: number;
    totalParticipants: number;
    summary: NewParticipantsSummary;
    participants: ParticipantRow[];
  }

  interface CoachOption {
    id: string;
    name: string;
  }

  const PARTICIPANT_DATE_ATTR_LABEL = 'Enrolled Date';

  // Raw report & cache
  let report: NewParticipantsReport | null = null;
  let cachedReport: NewParticipantsReport | null = null;
  let lastLoadedLookbackDays: number | null = null;

  // UI / control state
  let loading = false;
  let error: string | null = null;

  let selectedLookbackDays: string = ''; // user enters before first load
  let selectedCoachId = '';
  let selectedClient = '';

  // Enrolled date range filters (YYYY-MM-DD)
  let rangeStart = '';
  let rangeEnd = '';

  // Derived filter options
  let uniqueCoaches: CoachOption[] = [];
  let uniqueClients: string[] = [];

  // Filtered participants for display
  let filteredParticipants: ParticipantRow[] = [];
  let sortedParticipants: ParticipantRow[] = [];
  let sortDescendingByDays = true;

  // Bucket counts for filtered cohort
  let countGt14To21 = 0;
  let countGt21To28 = 0;
  let countGt28 = 0;

  function toDateInputValue(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function fromUnixToDateInput(unix: number | null): string {
    if (!unix) return '';
    const d = new Date(unix * 1000);
    if (Number.isNaN(d.getTime())) return '';
    return toDateInputValue(d);
  }

  function formatUnixDate(unix: number | null): string {
    if (!unix) return '';
    const d = new Date(unix * 1000);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString();
  }

  function bucketLabel(b: ParticipantBuckets): string {
    if (b.gt_28) return '> 28 days (Unengaged)';
    if (b.gt_21_to_28) return '22–28 days';
    if (b.gt_14_to_21) return '15–21 days';
    return '≤ 14 days';
  }

  function escapeCsv(value: string): string {
    if (value.includes('"') || value.includes(',') || value.includes('\n')) {
      return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
  }

  function exportCsv() {
    if (!filteredParticipants.length) {
      alert('No rows to export. Load data and/or adjust filters first.');
      return;
    }

    const header = [
      'Member ID',
      'Name',
      'Email',
      'Client',
      'Enrolled date',
      'Has session',
      'First session date',
      'Last session date',
      'Days since last session',
      'Days without session',
      'Bucket',
      'Coaches',
      'Channels'
    ];

    const lines: string[] = [];
    lines.push(header.map(escapeCsv).join(','));

    for (const p of filteredParticipants) {
      const row = [
        p.memberId,
        p.memberName ?? '',
        p.memberEmail ?? '',
        p.client ?? '',
        p.participantAt ? fromUnixToDateInput(p.participantAt) : '',
        p.hasSession ? 'Yes' : 'No',
        formatUnixDate(p.firstSessionAt),
        formatUnixDate(p.lastSessionAt),
        p.daysSinceLastSession != null ? p.daysSinceLastSession.toFixed(1) : '',
        p.daysWithoutSession != null ? p.daysWithoutSession.toFixed(1) : '',
        bucketLabel(p.buckets),
        p.coachNames.join('; '),
        p.channelsUsed.join('; ')
      ].map((v) => escapeCsv(String(v)));

      lines.push(row.join(','));
    }

    const csvContent = lines.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'enrolled-participants-report.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function buildDerivedFilters(source: NewParticipantsReport | null) {
    if (!source) return;

    const coachMap = new Map<string, string>();
    const clientSet = new Set<string>();

    for (const p of source.participants) {
      p.coachIds.forEach((id, index) => {
        const rawName = p.coachNames[index] ?? p.coachNames[0] ?? id;
        const name = String(rawName);
        if (!coachMap.has(id)) {
          coachMap.set(id, name);
        }
      });

      if (p.client) {
        clientSet.add(p.client);
      }
    }

    uniqueCoaches = Array.from(coachMap.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    uniqueClients = Array.from(clientSet).sort((a, b) => a.localeCompare(b));
  }

  function applyFilters() {
    if (!report) {
      filteredParticipants = [];
      countGt14To21 = 0;
      countGt21To28 = 0;
      countGt28 = 0;
      return;
    }

    let subset = report.participants;

    // Coach filter
    if (selectedCoachId) {
      subset = subset.filter((p) => p.coachIds.includes(selectedCoachId));
    }

    // Client filter
    if (selectedClient) {
      subset = subset.filter((p) => p.client === selectedClient);
    }

    // Enrolled Date range
    if (rangeStart) {
      const startTs = Date.parse(rangeStart) / 1000;
      subset = subset.filter(
        (p) => p.participantAt != null && p.participantAt >= startTs
      );
    }

    if (rangeEnd) {
      const endTs = Date.parse(rangeEnd) / 1000;
      const nextDay = endTs + 24 * 60 * 60; // inclusive end-of-day
      subset = subset.filter(
        (p) => p.participantAt != null && p.participantAt < nextDay
      );
    }

    filteredParticipants = subset;

    // Recompute bucket counts for filtered subset (additive / exclusive)
    countGt14To21 = subset.filter((p) => p.buckets.gt_14_to_21).length;
    countGt21To28 = subset.filter((p) => p.buckets.gt_21_to_28).length;
    countGt28 = subset.filter((p) => p.buckets.gt_28).length;
  }

  // Re-run filters whenever report or filter state changes
  $: if (report) {
    applyFilters();
  }

  async function loadReport() {
    loading = true;
    error = null;

    try {
      const parsed = Number(selectedLookbackDays || '0');
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new Error(
          'Please enter a positive lookback window in days (e.g., 60, 90, 180).'
        );
      }

      let requested = parsed;
      if (requested > 365) requested = 365;
      selectedLookbackDays = String(requested);

      // Reuse cache if we already loaded a superset window
      if (cachedReport && lastLoadedLookbackDays !== null && requested <= lastLoadedLookbackDays) {
        report = cachedReport;
        buildDerivedFilters(report);
        // Do NOT overwrite user-edited date range if they’ve set one
        if (!rangeStart || !rangeEnd) {
          if (report.participants.length > 0) {
            const timestamps = report.participants
              .map((p) => p.participantAt)
              .filter((x): x is number => typeof x === 'number');

            if (timestamps.length) {
              const minTs = Math.min(...timestamps);
              const maxTs = Math.max(...timestamps);
              if (!rangeStart) rangeStart = fromUnixToDateInput(minTs);
              if (!rangeEnd) rangeEnd = fromUnixToDateInput(maxTs);
            }
          }
        }
        applyFilters();
        return;
      }

      const res = await fetch('/API/intercom/new-participants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lookbackDays: requested })
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const data: NewParticipantsReport = await res.json();
      report = data;
      cachedReport = data;
      lastLoadedLookbackDays = requested;

      buildDerivedFilters(report);

      // Default participant range to full loaded set if user hasn't chosen yet
      if (report.participants.length > 0 && (!rangeStart || !rangeEnd)) {
        const timestamps = report.participants
          .map((p) => p.participantAt)
          .filter((x): x is number => typeof x === 'number');

        if (timestamps.length) {
          const minTs = Math.min(...timestamps);
          const maxTs = Math.max(...timestamps);
          rangeStart = fromUnixToDateInput(minTs);
          rangeEnd = fromUnixToDateInput(maxTs);
        }
      }

      applyFilters();
    } catch (e: any) {
      console.error(e);
      error = e?.message ?? String(e);
    } finally {
      loading = false;
    }
  }
  // Sort filtered participants by daysWithoutSession
  $: if (filteredParticipants) {
  // Copy first to avoid mutating filteredParticipants in place
  sortedParticipants = [...filteredParticipants].sort((a, b) => {
    const aVal = a.daysWithoutSession ?? -Infinity;
    const bVal = b.daysWithoutSession ?? -Infinity;

    // Descending: highest daysWithoutSession first
    return sortDescendingByDays ? bVal - aVal : aVal - bVal;
  });
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

  input[type='number'],
  select,
  input[type='date'] {
    padding: 0.3rem 0.45rem;
    border-radius: 0.25rem;
    border: 1px solid #ccc;
    font-size: 0.85rem;
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

  button.secondary {
    margin-top: 0.5rem;
    align-self: flex-start;
    padding: 0.4rem 0.9rem;
    border-radius: 0.25rem;
    border: 1px solid #555;
    background: #fff;
    color: #333;
    font-size: 0.9rem;
    cursor: pointer;
  }

  button.secondary:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .metric-card {
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid #ddd;
    background: #fdfdfd;
  }

  .metric-label {
    font-size: 0.8rem;
    color: #555;
    margin-bottom: 0.25rem;
  }

  .metric-value {
    font-size: 1.3rem;
    font-weight: 600;
    margin-bottom: 0.1rem;
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

  tbody tr:nth-child(even) {
    background: #fafafa;
  }

  .pill {
    display: inline-block;
    padding: 0.1rem 0.35rem;
    border-radius: 999px;
    background: #eee;
    font-size: 0.75rem;
    margin-right: 0.25rem;
  }
</style>

<div class="page">
  <h1>Enrolled Participants Report</h1>
  <div class="subtitle">
    Enrolled participants bucketed by days without a coaching session, filterable by coach, client,
    and participant start date.
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
        Data is cached during this session; increasing the window (up to 365) may trigger a new
        fetch.
      </div>
    </div>

    <div class="filter-group">
      <label>Export</label>
      <button class="secondary" on:click={exportCsv} disabled={!filteredParticipants.length}>
        Export CSV (current filters)
      </button>
      <div class="muted">
        Exports all enrolled participants that match the current filters.
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
      <label for="client">Client (Employer)</label>
      <select id="client" bind:value={selectedClient}>
        <option value="">All clients</option>
        {#each uniqueClients as client}
          <option value={client}>{client}</option>
        {/each}
      </select>
    </div>

    <div class="filter-group">
      <label>Enrolled Date range</label>
      <div>
        <input type="date" bind:value={rangeStart} />
        <input type="date" bind:value={rangeEnd} style="margin-left: 0.25rem;" />
      </div>
      <div class="muted">
        Uses {PARTICIPANT_DATE_ATTR_LABEL} as the participant start date.
      </div>
    </div>
  </div>

  {#if report}
    <div class="metrics">
      <div class="metric-card">
        <div class="metric-label">Participants &gt; 14–21 days without a session</div>
        <div class="metric-value">{countGt14To21}</div>
        <div class="muted">Filtered view</div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Participants 22–28 days without a session</div>
        <div class="metric-value">{countGt21To28}</div>
        <div class="muted">Filtered view</div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Participants &gt; 28 days without a session (Unengaged)</div>
        <div class="metric-value">{countGt28}</div>
        <div class="muted">
          Report-local definition; does not change global engagement status.
        </div>
      </div>
    </div>

    <p class="muted">
      Loaded {report.totalParticipants} enrolled participants in the last {report.lookbackDays} days
      (before filters). Showing {filteredParticipants.length} after filters.
    </p>

    <h2>Participants (filtered)</h2>
    <table>
      <thead>
        <tr>
          <th>Participant</th>
          <th>Client</th>
          <th>Enrolled date</th>
          <th>Has session</th>
          <th>First session</th>
          <th>Last session</th>
          <th>Days without session</th>
          <th>Bucket</th>
          <th>Coaches</th>
          <th>Channels</th>
        </tr>
      </thead>
      <tbody>
        {#each sortedParticipants.slice(0, 500) as p}
          <tr>
            <td>
              {p.memberName || '(no name)'}
              <div class="muted">{p.memberEmail}</div>
            </td>
            <td>{p.client || '—'}</td>
            <td>{formatUnixDate(p.participantAt)}</td>
            <td>{p.hasSession ? 'Yes' : 'No'}</td>
            <td>{formatUnixDate(p.firstSessionAt)}</td>
            <td>{formatUnixDate(p.lastSessionAt)}</td>
            <td>
              {#if p.daysWithoutSession != null}
                {p.daysWithoutSession.toFixed(1)}
              {:else}
                —
              {/if}
            </td>
            <td>{bucketLabel(p.buckets)}</td>
            <td>
              {#if p.coachNames.length}
                {p.coachNames.join(', ')}
              {:else}
                <span class="muted">Unassigned</span>
              {/if}
            </td>
            <td>
              {#each p.channelsUsed as ch}
                <span class="pill">{ch}</span>
              {/each}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <div class="muted">
      Showing up to 500 participants. Use filters to narrow the view if more are loaded.
    </div>
  {/if}
</div>
