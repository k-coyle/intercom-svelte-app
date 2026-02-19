<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    cleanupCaseloadJob,
    createCaseloadJob,
    fetchCaseloadViewPage,
    stepCaseloadJob
  } from '$lib/client/caseload-job';
  import {
    MAX_LOOKBACK_DAYS,
    parseLookbackDays
  } from '$lib/client/report-utils';

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



  const SECONDS_PER_DAY = 60 * 60 * 24;

  function computeBuckets(daysSinceLastSession: number): MemberBuckets {
    return {
      bucket_1: daysSinceLastSession <= 7,
      bucket_2: daysSinceLastSession > 7 && daysSinceLastSession <= 28,
      bucket_3: daysSinceLastSession > 28 && daysSinceLastSession <= 56,
      bucket_4: daysSinceLastSession > 56
    };
  }

  function normalizeChannelCombo(channels: SessionChannel[]): string {
    const order: SessionChannel[] = ['Phone', 'Video Conference', 'Email', 'Chat'];
    const set = new Set(channels);
    return order.filter((c) => set.has(c)).join(' + ') || '(none)';
  }

  /**
   * Merge an "older window" delta report into an existing cached report.
   * - Unions channels/coaches
   * - Adds newly-discovered members
   * - Recomputes derived fields (daysSince/buckets/channelCombo/summary)
   */
  function mergeReports(base: CaseloadReport, delta: CaseloadReport, newLookbackDays: number): CaseloadReport {
    const nowUnix = Math.floor(Date.now() / 1000);

    const byId = new Map<string, CaseloadMemberRow>();
    const coachNameById = new Map<string, string>();

    for (const m of base.members) {
      byId.set(m.memberId, {
        ...m,
        coachIds: [...m.coachIds],
        coachNames: [...m.coachNames],
        channelsUsed: [...m.channelsUsed]
      });
      m.coachIds.forEach((id, i) => coachNameById.set(id, String(m.coachNames[i] ?? id)));
    }

    for (const m of delta.members) {
      m.coachIds.forEach((id, i) => coachNameById.set(id, String(m.coachNames[i] ?? id)));

      const existing = byId.get(m.memberId);
      if (!existing) {
        byId.set(m.memberId, {
          ...m,
          coachIds: [...m.coachIds],
          coachNames: [...m.coachNames],
          channelsUsed: [...m.channelsUsed]
        });
        continue;
      }

      // Prefer non-null identity fields
      if (!existing.memberName && m.memberName) existing.memberName = m.memberName;
      if (!existing.memberEmail && m.memberEmail) existing.memberEmail = m.memberEmail;
      if (!existing.client && m.client) existing.client = m.client;

      // Union coaches
      existing.coachIds = Array.from(new Set([...existing.coachIds, ...m.coachIds]));

      // Union channels
      existing.channelsUsed = Array.from(new Set([...existing.channelsUsed, ...m.channelsUsed]));

      // Last session is the max timestamp
      existing.lastSessionAt = Math.max(existing.lastSessionAt, m.lastSessionAt);
    }

    // Rebuild coachNames + derived fields consistently
    const members: CaseloadMemberRow[] = [];
    for (const m of byId.values()) {
      // Stable coach names aligned to coachIds
      const coachIds = [...m.coachIds];
      const coachNames = coachIds.map((id) => coachNameById.get(id) ?? id);

      const daysSinceLastSession = (nowUnix - m.lastSessionAt) / SECONDS_PER_DAY;
      const buckets = computeBuckets(daysSinceLastSession);
      const channelCombo = normalizeChannelCombo(m.channelsUsed);

      members.push({
        ...m,
        coachIds,
        coachNames,
        daysSinceLastSession,
        buckets,
        channelCombo
      });
    }

    const summary: CaseloadSummary = { bucket_1: 0, bucket_2: 0, bucket_3: 0, bucket_4: 0 };
    for (const m of members) {
      if (m.buckets.bucket_1) summary.bucket_1 += 1;
      if (m.buckets.bucket_2) summary.bucket_2 += 1;
      if (m.buckets.bucket_3) summary.bucket_3 += 1;
      if (m.buckets.bucket_4) summary.bucket_4 += 1;
    }

    return {
      lookbackDays: newLookbackDays,
      generatedAt: new Date().toISOString(),
      totalMembers: members.length,
      summary,
      members
    };
  }

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

  // Prevent parallel loads in a single tab
  let runController: AbortController | null = null;


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
    if (!Number.isNaN(lookback) && lookback > 0 && lookback <= MAX_LOOKBACK_DAYS) {
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

  async function fetchAllMembers(
    jobId: string,
    signal?: AbortSignal
  ): Promise<CaseloadMemberRow[]> {
    const members: CaseloadMemberRow[] = [];
    let offset = 0;

    // Your typical size (<500) means this usually completes in one request.
    const limit = 2000;

    while (true) {
      const page = await fetchCaseloadViewPage<any>(
        jobId,
        'members',
        offset,
        limit,
        signal
      );
      const items = (page.items ?? []) as CaseloadMemberRow[];
      members.push(...items);

      if (page.nextOffset == null) break;
      offset = Number(page.nextOffset);
      if (!Number.isFinite(offset)) break;
    }

    return members;
  }

  async function runJobAndBuildReport(
    lookbackDays: number,
    untilLookbackDays?: number,
    signal?: AbortSignal
  ): Promise<CaseloadReport> {
    // 1) Clean up any prior job, but do it safely + await it.
    //    (capture into a local var so it can't shift under us)
    const previousJobId = activeJobId;
    activeJobId = null;

    if (previousJobId) {
      await cleanupCaseloadJob(previousJobId, true);
    }

    // 2) Track THIS run's jobId locally so we never accidentally clean up a newer run.
    let myJobId: string | null = null;

    try {
      myJobId = await createCaseloadJob(lookbackDays, untilLookbackDays, signal);
      activeJobId = myJobId;

      let done = false;

      while (!done) {
        const prog = await stepCaseloadJob(myJobId, signal);

        if (prog?.status === 'error') {
          throw new Error(`Caseload job failed: ${prog?.error ?? 'Unknown error'}`);
        }
        if (prog?.status === 'cancelled') {
          throw new Error('Caseload job was cancelled.');
        }

        done = !!prog.done;

        if (prog?.progress) {
          const p = prog.progress;
          progressText =
            `Pages ${p.pagesFetched ?? 0} · conv ${p.conversationsFetched ?? 0} · ` +
            `members ${p.uniqueMembers ?? 0} · missing contacts ${p.missingContacts ?? 0}`;
        }

        if (!done) await new Promise((r) => setTimeout(r, 150));
      }

      const summaryPayload = await fetchCaseloadViewPage<any>(myJobId, 'summary');
      const members = await fetchAllMembers(myJobId, signal);

      return {
        lookbackDays: Number(summaryPayload.lookbackDays),
        generatedAt: String(summaryPayload.generatedAt),
        totalMembers: Number(summaryPayload.totalMembers ?? members.length),
        summary: summaryPayload.summary,
        members
      };
    } finally {
      // 3) Always clean up *this run's* job, and await it.
      if (myJobId) {
        await cleanupCaseloadJob(myJobId, true);
      }

      // 4) Only clear activeJobId if it still points at *this* job
      if (activeJobId === myJobId) activeJobId = null;
    }
  }





  // best-effort cleanup on tab close / refresh
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      if (activeJobId) cleanupCaseloadJob(activeJobId, true);
    });
  }
  // cleanup on destroy (best effort)
  onDestroy(() => {
    if (activeJobId) cleanupCaseloadJob(activeJobId, true);
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

    // Per-run controller so we can cancel any previous run in this tab
    const myController = new AbortController();
    const signal = myController.signal;

    // If another run is in-flight, abort it first (prevents parallel stepping / floods)
    if (runController) {
      runController.abort();
    }
    runController = myController;

    try {
      const requested = parseLookbackDays(selectedLookbackDays);
      selectedLookbackDays = String(requested);

      // If we already loaded a larger/equal window this session, reuse cache (no backend call).
      if (cachedReport && lastLoadedLookbackDays !== null && requested <= lastLoadedLookbackDays) {
        report = cachedReport;
        buildDerivedFilters();
        applyFilters();
        return;
      }

      // IMPORTANT: before starting a new job, clean up any prior jobId we were tracking
      // (avoids backend holding onto old job state)
      const prevJobId = activeJobId;
      activeJobId = null;
      if (prevJobId) {
        await cleanupCaseloadJob(prevJobId, true);
      }

      // If user increases lookback, fetch ONLY the delta (older slice) and merge into frontend cache.
      if (cachedReport && lastLoadedLookbackDays !== null && requested > lastLoadedLookbackDays) {
        progressText = `Fetching additional data for days ${lastLoadedLookbackDays} → ${requested}…`;

        const delta = await runJobAndBuildReport(requested, lastLoadedLookbackDays, signal);
        const merged = mergeReports(cachedReport, delta, requested);

        cachedReport = merged;
        lastLoadedLookbackDays = requested;
        report = merged;

        buildDerivedFilters();
        applyFilters();
        return;
      }

      // Otherwise, fetch the full window from backend (job + polling), then cache it in-memory.
      const data = await runJobAndBuildReport(requested, undefined, signal);

      cachedReport = data;
      lastLoadedLookbackDays = requested;
      report = data;

      buildDerivedFilters();
      applyFilters();
    } catch (e: any) {
      // If user clicked again, the previous run will throw AbortError — don't show that as an error.
      if (e?.name === 'AbortError') return;

      console.error(e);
      error = e?.message ?? String(e);
    } finally {
      loading = false;
      progressText = null;

      // Only clear the controller if it still belongs to this run
      if (runController === myController) {
        runController = null;
      }
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
        max={MAX_LOOKBACK_DAYS}
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
