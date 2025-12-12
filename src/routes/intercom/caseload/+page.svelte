<script lang="ts">
  // Keep in sync with backend
  type SessionChannel = 'Phone' | 'Video Conference' | 'Email' | 'Chat';

  interface MemberBuckets {
    last_8_days: boolean;
    last_31_days: boolean;
    days_31_to_61: boolean;
    over_61_days: boolean;
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
    buckets: MemberBuckets;
  }

  interface CaseloadSummary {
    last_8_days: number;
    last_31_days: number;
    days_31_to_61: number;
    over_61_days: number;
  }

  interface CaseloadReport {
    lookbackDays: number;
    generatedAt: string;
    totalMembers: number;
    summary: CaseloadSummary;
    members: CaseloadMemberRow[];
  }

  interface BucketRow {
    channelCombo: string;
    last_8_days: number;
    last_31_days: number;
    days_31_to_61: number;
    over_61_days: number;
  }

  interface CoachOption {
    id: string;
    name: string;
  }

  // Active report currently being used for display
  let report: CaseloadReport | null = null;

  // In-memory cache for this browser session
  let cachedReport: CaseloadReport | null = null;
  let lastLoadedLookbackDays: number | null = null;

  let loading = false;
  let error: string | null = null;

  // Filters
  let selectedLookbackDays: string = ''; // user must set this before first load
  let selectedCoachId = '';
  let selectedClient = '';
  const allChannels: SessionChannel[] = ['Phone', 'Video Conference', 'Email', 'Chat'];
  let selectedChannels: Record<SessionChannel, boolean> = {
    Phone: true,
    'Video Conference': true,
    Email: true,
    Chat: true
  };

  // Derived filter options
  let uniqueCoaches: CoachOption[] = [];
  let uniqueClients: string[] = [];

  // Derived display data
  let filteredMembers: CaseloadMemberRow[] = [];
  let bucketTable: BucketRow[] = [];

  function getSelectedChannels(): SessionChannel[] {
    return allChannels.filter((ch) => selectedChannels[ch]);
  }

  function buildDerivedFiltersFrom(source: CaseloadReport | null) {
    if (!source) return;

    const coachMap = new Map<string, string>();
    const clientSet = new Set<string>();

    for (const m of source.members) {
      m.coachIds.forEach((id, index) => {
        const rawName = m.coachNames[index] ?? m.coachNames[0] ?? id;
        // 👇 Force name to a string so localeCompare is always valid
        const name = String(rawName);
        if (!coachMap.has(id)) {
          coachMap.set(id, name);
        }
      });

      if (m.client != null) {
        clientSet.add(String(m.client));
      }
    }

    uniqueCoaches = Array.from(coachMap.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    uniqueClients = Array.from(clientSet).sort();
  }

  function buildDerivedFilters() {
    buildDerivedFiltersFrom(report);
  }

  function applyFilters() {
    if (!report) {
      filteredMembers = [];
      bucketTable = [];
      return;
    }

    let members = report.members;

    // Coach filter
    if (selectedCoachId) {
      members = members.filter((m) => m.coachIds.includes(selectedCoachId));
    }

    // Client filter
    if (selectedClient) {
      members = members.filter((m) => m.client === selectedClient);
    }

    // Channel filter — member must have at least one selected channel
    const selected = new Set(getSelectedChannels());
    if (selected.size > 0 && selected.size < allChannels.length) {
      members = members.filter((m) => m.channelsUsed.some((ch) => selected.has(ch)));
    }

    // Lookback filter (view-level) — only if user set a valid number
    const lookback = Number(selectedLookbackDays);
    if (!Number.isNaN(lookback) && lookback > 0 && lookback <= 365) {
      members = members.filter((m) => m.daysSinceLastSession <= lookback);
    }

    filteredMembers = members;

    // Build bucket matrix by channelCombo
    const map = new Map<string, BucketRow>();

    for (const m of filteredMembers) {
      const key = m.channelCombo || '(none)';
      if (!map.has(key)) {
        map.set(key, {
          channelCombo: key,
          last_8_days: 0,
          last_31_days: 0,
          days_31_to_61: 0,
          over_61_days: 0
        });
      }

      const row = map.get(key)!;

      if (m.buckets.last_8_days) row.last_8_days += 1;
      if (m.buckets.last_31_days) row.last_31_days += 1;
      if (m.buckets.days_31_to_61) row.days_31_to_61 += 1;
      if (m.buckets.over_61_days) row.over_61_days += 1;
    }

    bucketTable = Array.from(map.values()).sort((a, b) =>
      a.channelCombo.localeCompare(b.channelCombo)
    );
  }

  /**
   * Main loader triggered by the button.
   * - No default lookback: user must supply a value.
   * - First call populates cache & report.
   * - Later calls reuse cache if requested <= cached window; otherwise fetch a new superset.
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
      if (requested > 365) requested = 365; // hard cap
      selectedLookbackDays = String(requested);

      // Reuse cached data if we already loaded a larger/equal window this session
      if (cachedReport && lastLoadedLookbackDays !== null && requested <= lastLoadedLookbackDays) {
        report = cachedReport;
        buildDerivedFilters();
        applyFilters();
        return;
      }

      // Otherwise, fetch from backend with the requested window
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

      buildDerivedFilters();
      applyFilters();
    } catch (e: any) {
      console.error(e);
      error = e?.message ?? String(e);
    } finally {
      loading = false;
    }
  }

  // Re-apply filters whenever the active report or filter state changes
  $: if (report) {
    applyFilters();
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
    min-width: 200px;
  }

  .filter-group label {
    font-size: 0.8rem;
    font-weight: 600;
    color: #444;
  }

  select,
  input[type='number'] {
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

  .summary {
    margin-bottom: 1rem;
    font-size: 0.9rem;
  }

  .summary strong {
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
    text-align: right;
  }

  th:first-child,
  td:first-child {
    text-align: left;
  }

  thead {
    background: #f3f3f3;
  }

  tfoot td {
    font-weight: 600;
    background: #fafafa;
  }

  .members-table {
    margin-top: 1rem;
  }

  .members-table th,
  .members-table td {
    font-size: 0.85rem;
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

  .error {
    color: #b00020;
    margin-bottom: 1rem;
  }

  .muted {
    color: #777;
    font-size: 0.8rem;
  }
</style>

<div class="page">
  <h1>Intercom Caseload Dashboard</h1>
  <div class="subtitle">
    Unique members by <strong>channel combination</strong> and <strong>time since last coaching session</strong>.
  </div>

  {#if error}
    <div class="error">Error: {error}</div>
  {/if}

  <div class="filters">
    <div class="filter-group">
      <label for="lookback">Lookback window (days, max 365)</label>
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
        Data is cached during this session; increasing the window (up to 365) may trigger a new fetch.
      </div>
    </div>

    <div class="filter-group">
      <label for="coach">Assigned coach</label>
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
      <label>Session types</label>
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
        Member is included if they’ve used <em>any</em> of the selected channels.
      </div>
    </div>
  </div>

  {#if loading && !report}
    <p>Loading caseload report…</p>
  {:else if report}
    <div class="summary">
      <div>
        <strong>Total members (after filters & lookback):</strong> {filteredMembers.length}
        {#if report.totalMembers !== filteredMembers.length}
          <span class="muted">
            (raw loaded report has {report.totalMembers} members)
          </span>
        {/if}
      </div>
      <div>
        <strong>Raw summary (all members, loaded window):</strong>
        &lt; 8 days: {report.summary.last_8_days} ·
        &lt; 31 days: {report.summary.last_31_days} ·
        31–61 days: {report.summary.days_31_to_61} ·
        &gt; 61 days: {report.summary.over_61_days}
      </div>
      <div class="muted">
        Generated at {new Date(report.generatedAt).toLocaleString()} · Loaded lookback = {report.lookbackDays} days
      </div>
    </div>

    <h2>By Channel Combination</h2>
    {#if bucketTable.length === 0}
      <p>No members match the current filters.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>Channel combination</th>
            <th>&lt; 8 days</th>
            <th>&lt; 31 days</th>
            <th>31–61 days</th>
            <th>&gt; 61 days</th>
          </tr>
        </thead>
        <tbody>
          {#each bucketTable as row}
            <tr>
              <td>{row.channelCombo}</td>
              <td>{row.last_8_days}</td>
              <td>{row.last_31_days}</td>
              <td>{row.days_31_to_61}</td>
              <td>{row.over_61_days}</td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td>{bucketTable.reduce((sum, r) => sum + r.last_8_days, 0)}</td>
            <td>{bucketTable.reduce((sum, r) => sum + r.last_31_days, 0)}</td>
            <td>{bucketTable.reduce((sum, r) => sum + r.days_31_to_61, 0)}</td>
            <td>{bucketTable.reduce((sum, r) => sum + r.over_61_days, 0)}</td>
          </tr>
        </tfoot>
      </table>
    {/if}

    <h2>Members (Current Filters)</h2>
    <p class="muted">
      Showing up to the first 500 members with their name, client, coaches, channels, and bucket.
    </p>

    <table class="members-table">
      <thead>
        <tr>
          <th>Member</th>
          <th>Client</th>
          <th>Coaches</th>
          <th>Channels</th>
          <th>Last session</th>
          <th>Days since</th>
          <th>Bucket</th>
        </tr>
      </thead>
      <tbody>
        {#each filteredMembers.slice(0, 500) as m}
          <tr>
            <td>
              {m.memberName || '(no name)'}
              <div class="muted">{m.memberEmail}</div>
            </td>
            <td>{m.client || '—'}</td>
            <td>
              {#if m.coachNames.length === 0}
                <span class="muted">Unassigned</span>
              {:else}
                {#each m.coachNames as name}
                  <span class="pill">{name}</span>
                {/each}
              {/if}
            </td>
            <td>
              {#each m.channelsUsed as ch}
                <span class="pill">{ch}</span>
              {/each}
            </td>
            <td>{new Date(m.lastSessionAt * 1000).toLocaleDateString()}</td>
            <td>{m.daysSinceLastSession.toFixed(1)}</td>
            <td>
              {#if m.buckets.last_8_days}
                &lt; 8 days
              {:else if m.buckets.days_31_to_61}
                31–61 days
              {:else if m.buckets.over_61_days}
                &gt; 61 days
              {:else if m.buckets.last_31_days}
                &lt; 31 days
              {:else}
                —
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
