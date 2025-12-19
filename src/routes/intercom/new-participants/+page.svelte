<!-- src/routes/intercom/new-participants/+page.svelte -->
<script lang="ts">
  type SessionChannel = 'Phone' | 'Video Conference' | 'Email' | 'Chat';

  interface ParticipantRow {
    memberId: string;
    memberName: string | null;
    memberEmail: string | null;
    client: string | null;
    registrationAt: number;
    daysSinceRegistration: number;
    hasSession: boolean;
    lastSessionAt: number | null;
    daysSinceLastSession: number | null;
    coachIds: string[];
    coachNames: string[];
    channelsUsed: SessionChannel[];
  }

  interface NewParticipantsReport {
    lookbackDays: number;
    generatedAt: string;
    totalParticipants: number;
    participants: ParticipantRow[];
  }

  interface CoachOption {
    id: string;
    name: string;
  }

  const allChannels: SessionChannel[] = ['Phone', 'Video Conference', 'Email', 'Chat'];

  // Active report
  let report: NewParticipantsReport | null = null;

  // Cached (per-page) report
  let cachedReport: NewParticipantsReport | null = null;
  let lastLoadedLookbackDays: number | null = null;

  let loading = false;
  let error: string | null = null;

  // Controls
  let selectedLookbackDays: string = ''; // user enters how far back to look for registration (usually 28)
  let selectedCoachId = '';
  let selectedClient = '';

  let selectedChannels: Record<SessionChannel, boolean> = {
    Phone: true,
    'Video Conference': true,
    Email: true,
    Chat: true
  };

  // Participant Date range (by registration date)
  let rangeStart = ''; // YYYY-MM-DD
  let rangeEnd = '';   // YYYY-MM-DD

  // Derived filters
  let uniqueCoaches: CoachOption[] = [];
  let uniqueClients: string[] = [];

  // Filtered participants + metrics
  let filteredParticipants: ParticipantRow[] = [];

  let countNoSession_0 = 0;
  let countNoSession_1 = 0;
  let countNoSession_2 = 0;
  let countNoSession_3 = 0;

  function toDateInputValue(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function ensureRangeDefaults() {
    if (!report || !report.participants.length) return;
    if (rangeStart && rangeEnd) return;

    const msList = report.participants.map((p) => p.registrationAt * 1000);
    const minMs = Math.min(...msList);
    const maxMs = Math.max(...msList);

    rangeStart = toDateInputValue(new Date(minMs));
    rangeEnd = toDateInputValue(new Date(maxMs));
  }

  function buildDerivedFiltersFrom(source: NewParticipantsReport | null) {
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

      if (p.client != null) {
        clientSet.add(String(p.client));
      }
    }

    uniqueCoaches = Array.from(coachMap.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    uniqueClients = Array.from(clientSet).sort();
  }

  function applyFiltersAndMetrics() {
    if (!report) {
      filteredParticipants = [];
      countNoSession_0 = countNoSession_1 = countNoSession_2 = countNoSession_3 = 0;
      return;
    }

    let rows = report.participants;

    // Coach filter
    if (selectedCoachId) {
      rows = rows.filter((p) => p.coachIds.includes(selectedCoachId));
    }

    // Client filter
    if (selectedClient) {
      rows = rows.filter((p) => p.client === selectedClient);
    }

    // Channel filter – participants must have at least one selected channel to be included
    // when a proper subset of channels is selected.
    const activeChannels = allChannels.filter((ch) => selectedChannels[ch]);
    const activeSet = new Set(activeChannels);
    if (activeSet.size > 0 && activeSet.size < allChannels.length) {
      rows = rows.filter((p) =>
        p.channelsUsed.length === 0
          ? false // if you narrow channels, drop participants with no sessions
          : p.channelsUsed.some((ch) => activeSet.has(ch))
      );
    }

    // Participant Date filter (registration date)
    if (rows.length > 0) {
      let minMs = Math.min(...rows.map((p) => p.registrationAt * 1000));
      let maxMs = Math.max(...rows.map((p) => p.registrationAt * 1000));

      if (rangeStart) {
        const d = new Date(rangeStart);
        if (!Number.isNaN(d.getTime())) {
          minMs = d.getTime();
        }
      }

      if (rangeEnd) {
        const d = new Date(rangeEnd);
        if (!Number.isNaN(d.getTime())) {
          maxMs = d.getTime() + 24 * 60 * 60 * 1000 - 1; // inclusive end-of-day
        }
      }

      rows = rows.filter((p) => {
        const ms = p.registrationAt * 1000;
        return ms >= minMs && ms <= maxMs;
      });
    }

    filteredParticipants = rows;

    const noSessionRows = filteredParticipants.filter((p) => !p.hasSession);

    countNoSession_0 = noSessionRows.length;
    countNoSession_1 = noSessionRows.filter(
      (p) => p.daysSinceRegistration > 14
    ).length;
    countNoSession_2 = noSessionRows.filter(
      (p) => p.daysSinceRegistration > 28
    ).length;
    countNoSession_3 = noSessionRows.filter(
      (p) => p.daysSinceRegistration > 56
    ).length;
  }

  async function loadReport() {
    loading = true;
    error = null;

    try {
      const parsed = Number(selectedLookbackDays || '28');
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new Error('Please enter a positive lookback window in days (e.g., 28, 60, 90).');
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

  // Re-run filters when report or controls change
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
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
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
  <h1>New Participants Report</h1>
  <div class="subtitle">
    New participants by registration date and whether they’ve had a coaching session.
  </div>

  {#if error}
    <div class="error">Error: {error}</div>
  {/if}

  <div class="filters">
    <div class="filter-group">
      <label for="lookback">Registration lookback (days, max 365)</label>
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
        This controls how far back we look for <em>Registration date</em>. Use 28 to match your current definition.
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
      <div class="muted">
        For participants with no sessions, no coach is shown.
      </div>
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
      <label>Channels (based on sessions)</label>
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
        If you narrow channels, participants with no sessions are excluded.
      </div>
    </div>

    <div class="filter-group">
      <label>Participant Date range (Registration date)</label>
      <div>
        <input type="date" bind:value={rangeStart} />
        <input type="date" bind:value={rangeEnd} style="margin-left: 0.25rem;" />
      </div>
      <div class="muted">
        Defaults to the full registration window; adjust to focus on specific cohorts.
      </div>
    </div>
  </div>

  {#if loading && !report}
    <p>Loading new participants…</p>
  {:else if report}
    <div class="metrics">
      <div class="metric-card">
        <div class="metric-label">New participants with no session</div>
        <div class="metric-value">{countNoSession_0}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">No session &gt; 14 days</div>
        <div class="metric-value">{countNoSession_1}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">No session &gt; 28 days</div>
        <div class="metric-value">{countNoSession_2}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">No session &gt; 56 days (Unengaged)</div>
        <div class="metric-value">{countNoSession_3}</div>
      </div>
    </div>

    <p class="muted">
      Loaded {report.totalParticipants} participants (before filters, lookback = {report.lookbackDays} days).
      Showing {filteredParticipants.length} after filters.
    </p>

    <h2>Participants (filtered)</h2>
    <table>
      <thead>
        <tr>
          <th>Participant</th>
          <th>Client</th>
          <th>Registration date</th>
          <th>Days since registration</th>
          <th>Has session?</th>
          <th>Last session</th>
          <th>Days since last session</th>
          <th>Coaches</th>
          <th>Channels used</th>
        </tr>
      </thead>
      <tbody>
        {#each filteredParticipants.slice(0, 500) as p}
          <tr>
            <td>
              {p.memberName || '(no name)'}
              <div class="muted">{p.memberEmail}</div>
            </td>
            <td>{p.client || '—'}</td>
            <td>{new Date(p.registrationAt * 1000).toLocaleDateString()}</td>
            <td>{p.daysSinceRegistration.toFixed(1)}</td>
            <td>{p.hasSession ? 'Yes' : 'No'}</td>
            <td>
              {#if p.lastSessionAt}
                {new Date(p.lastSessionAt * 1000).toLocaleDateString()}
              {:else}
                —
              {/if}
            </td>
            <td>
              {#if p.daysSinceLastSession != null}
                {p.daysSinceLastSession.toFixed(1)}
              {:else}
                —
              {/if}
            </td>
            <td>
              {#if p.coachNames.length === 0}
                <span class="muted">Unassigned</span>
              {:else}
                {#each p.coachNames as name}
                  <span class="pill">{name}</span>
                {/each}
              {/if}
            </td>
            <td>
              {#if p.channelsUsed.length === 0}
                <span class="muted">None yet</span>
              {:else}
                {#each p.channelsUsed as ch}
                  <span class="pill">{ch}</span>
                {/each}
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
