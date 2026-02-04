<script lang="ts">
  import { onDestroy } from 'svelte';

  // Keep in sync with backend
  type SessionChannel = 'Phone' | 'Video Conference' | 'Email' | 'Chat';

  interface MemberBuckets {
    bucket_1: boolean;
    bucket_2: boolean;
    bucket_3: boolean;
    bucket_4: boolean;
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
    bucket_1: number;
    bucket_2: number;
    bucket_3: number;
    bucket_4: number;
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
    bucket_1: number;
    bucket_2: number;
    bucket_3: number;
    bucket_4: number;
  }

  interface CoachOption {
    id: string;
    name: string;
  }

  // -------- State --------

  // Active report currently being used for display
  let report: CaseloadReport | null = null;

  // In-memory cache for this browser session
  let cachedReport: CaseloadReport | null = null;
  let lastLoadedLookbackDays: number | null = null;

  let loading = false;
  let error: string | null = null;

  // Optional progress text for the button area
  let progressText: string | null = null;

  // Track the server-side job for cleanup
  let activeJobId: string | null = null;

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

  // -------- Helpers: filtering UI (unchanged) --------

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
          bucket_1: 0,
          bucket_2: 0,
          bucket_3: 0,
          bucket_4: 0
        });
      }

      const row = map.get(key)!;

      if (m.buckets.bucket_1) row.bucket_1 += 1;
      if (m.buckets.bucket_2) row.bucket_2 += 1;
      if (m.buckets.bucket_3) row.bucket_3 += 1;
      if (m.buckets.bucket_4) row.bucket_4 += 1;
    }

    bucketTable = Array.from(map.values()).sort((a, b) =>
      a.channelCombo.localeCompare(b.channelCombo)
    );
  }

  // -------- Helpers: job backend calls --------

  async function cleanupJob(jobId: string) {
    try {
      // keepalive helps cleanup on navigation/unload in many browsers
      await fetch('/API/engagement/caseload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'cleanup', jobId }),
        keepalive: true
      });
    } catch {
      // ignore cleanup failures
    }
  }

  async function createJob(lookbackDays: number): Promise<string> {
    const res = await fetch('/API/engagement/caseload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // backend defaults op to create if omitted; sending op explicitly is fine too
      body: JSON.stringify({ op: 'create', lookbackDays })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Create job failed (HTTP ${res.status}): ${text}`);
    }

    const data = await res.json();
    if (!data?.jobId) throw new Error('Create job failed: missing jobId');
    return String(data.jobId);
  }

  async function stepJob(jobId: string): Promise<any> {
    const res = await fetch('/API/engagement/caseload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'step', jobId })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Step failed (HTTP ${res.status}): ${text}`);
    }

    return res.json();
  }

  async function fetchSummary(jobId: string) {
    const res = await fetch(`/API/engagement/caseload?jobId=${encodeURIComponent(jobId)}&view=summary`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Summary fetch failed (HTTP ${res.status}): ${text}`);
    }
    return res.json();
  }

  async function fetchAllMembers(jobId: string): Promise<CaseloadMemberRow[]> {
    const members: CaseloadMemberRow[] = [];
    let offset = 0;

    // Your typical size (<500) means this usually completes in one request.
    const limit = 2000;

    while (true) {
      const url =
        `/API/engagement/caseload?jobId=${encodeURIComponent(jobId)}&view=members` +
        `&offset=${offset}&limit=${limit}`;

      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Members fetch failed (HTTP ${res.status}): ${text}`);
      }

      const page = await res.json();
      const items = (page.items ?? []) as CaseloadMemberRow[];
      members.push(...items);

      if (page.nextOffset == null) break;
      offset = Number(page.nextOffset);
      if (!Number.isFinite(offset)) break;
    }

    return members;
  }

  async function runJobAndBuildReport(lookbackDays: number): Promise<CaseloadReport> {
    if (activeJobId) {
      cleanupJob(activeJobId);
      activeJobId = null;
    }

    const jobId = await createJob(lookbackDays);
    activeJobId = jobId;

    let done = false;

    while (!done) {
      const prog = await stepJob(jobId);

      // ✅ If the job failed, stop and surface the real error
      if (prog?.status === 'error') {
        throw new Error(`Caseload job failed: ${prog?.error ?? 'Unknown error'}`);
      }
      if (prog?.status === 'cancelled') {
        throw new Error('Caseload job was cancelled.');
      }

      done = !!prog.done;

      // Optional progress text
      if (prog?.progress) {
        const p = prog.progress;
        progressText =
          `Pages ${p.pagesFetched ?? 0} · conv ${p.conversationsFetched ?? 0} · ` +
          `members ${p.uniqueMembers ?? 0} · missing contacts ${p.missingContacts ?? 0}`;
      }

      if (!done) await new Promise((r) => setTimeout(r, 150));
    }

    // ✅ At this point we expect it to be complete
    const summaryPayload = await fetchSummary(jobId);
    const members = await fetchAllMembers(jobId);

    return {
      lookbackDays: Number(summaryPayload.lookbackDays),
      generatedAt: String(summaryPayload.generatedAt),
      totalMembers: Number(summaryPayload.totalMembers ?? members.length),
      summary: summaryPayload.summary,
      members
    };
  }


  // cleanup on destroy (best effort)
  onDestroy(() => {
    if (activeJobId) cleanupJob(activeJobId);
  });

  /**
   * Main loader triggered by the button.
   * - No default lookback: user must supply a value.
   * - First call populates cache & report.
   * - Later calls reuse cache if requested <= cached window; otherwise fetch a new superset.
   */
  async function loadReport() {
    loading = true;
    error = null;
    progressText = null;

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

      // Fetch from backend (job + polling), then build full report object
      const data = await runJobAndBuildReport(requested);

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
      progressText = null;
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
  <h1>Caseload Dashboard</h1>
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
      {#if progressText}
        <div class="muted">{progressText}</div>
      {/if}
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
        &le; 7 days: {report.summary.bucket_1} ·
        8-28 days: {report.summary.bucket_2} ·
        29–56 days: {report.summary.bucket_3} ·
        &gt; 56 days: {report.summary.bucket_4}
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
            <th>&le; 7 days</th>
            <th>8-28 days</th>
            <th>29–56 days</th>
            <th>&gt; 56 days</th>
          </tr>
        </thead>
        <tbody>
          {#each bucketTable as row}
            <tr>
              <td>{row.channelCombo}</td>
              <td>{row.bucket_1}</td>
              <td>{row.bucket_2}</td>
              <td>{row.bucket_3}</td>
              <td>{row.bucket_4}</td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td>{bucketTable.reduce((sum, r) => sum + r.bucket_1, 0)}</td>
            <td>{bucketTable.reduce((sum, r) => sum + r.bucket_2, 0)}</td>
            <td>{bucketTable.reduce((sum, r) => sum + r.bucket_3, 0)}</td>
            <td>{bucketTable.reduce((sum, r) => sum + r.bucket_4, 0)}</td>
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
              {#if m.buckets.bucket_1}
                &le; 7 days
              {:else if m.buckets.bucket_2}
                 8-28 days                
              {:else if m.buckets.bucket_3}
                29–56 days
              {:else if m.buckets.bucket_4}
                &gt; 56 days

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
