<!-- src/routes/engagement/sessions/+page.svelte -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { browser } from '$app/environment';

  type SessionChannel = 'Phone' | 'Video Conference' | 'Email' | 'Chat';

  interface SessionDetailRow {
    memberId: string;
    memberName: string | null;
    memberEmail: string | null;
    client: string | null;
    coachId: string | null;
    coachName: string | null;
    channel: SessionChannel;
    time: number; // unix seconds
    daysSince?: number;
  }

  interface SessionsSummary {
    lookbackDays: number;
    generatedAt: string;
    totalSessions: number;
    uniqueMembers: number;
  }

  interface SessionsReport {
    lookbackDays: number; // max loaded (cached) window
    generatedAt: string; // time of last load/append
    sessions: SessionDetailRow[];
    summary: SessionsSummary;
  }

  interface CoachOption {
    id: string;
    name: string;
  }

  // -------- State --------
  let report: SessionsReport | null = null;

  // Browser-session cache (clean slate on refresh/tab close)
  let cachedReport: SessionsReport | null = null;
  let lastLoadedLookbackDays: number | null = null;

  let loading = false;
  let error: string | null = null;
  let progressText: string | null = null;

  // Track the server-side job (ephemeral; we clean up ASAP)
  let activeJobId: string | null = null;

  // Prevent parallel loads in a single tab: abort any in-flight run when a new one starts.
  let runController: AbortController | null = null;

  // Filters
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

  // Derived filter options
  let uniqueCoaches: CoachOption[] = [];
  let uniqueClients: string[] = [];

  // Display data
  let filteredSessions: SessionDetailRow[] = [];
  const SECONDS_PER_DAY = 24 * 60 * 60;

  function nowUnix(): number {
    return Math.floor(Date.now() / 1000);
  }

  function daysSince(timeUnix: number): number {
    return (nowUnix() - timeUnix) / SECONDS_PER_DAY;
  }

  function getSelectedChannels(): SessionChannel[] {
    return allChannels.filter((ch) => selectedChannels[ch]);
  }

  function buildDerivedFiltersFrom(source: SessionsReport | null) {
    if (!source) return;

    const coachMap = new Map<string, string>();
    const clientSet = new Set<string>();

    for (const s of source.sessions) {
      if (s.coachId) {
        const name = String(s.coachName ?? s.coachId);
        if (!coachMap.has(s.coachId)) coachMap.set(s.coachId, name);
      }
      if (s.client != null) clientSet.add(String(s.client));
    }

    uniqueCoaches = Array.from(coachMap.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    uniqueClients = Array.from(clientSet).sort();
  }

  function applyFilters() {
    if (!report) {
      filteredSessions = [];
      return;
    }

    let sessions = report.sessions;

    if (selectedCoachId) sessions = sessions.filter((s) => s.coachId === selectedCoachId);
    if (selectedClient) sessions = sessions.filter((s) => s.client === selectedClient);

    const selected = new Set(getSelectedChannels());
    if (selected.size > 0 && selected.size < allChannels.length) {
      sessions = sessions.filter((s) => selected.has(s.channel));
    }

    const lookback = Number(selectedLookbackDays);
    if (!Number.isNaN(lookback) && lookback > 0 && lookback <= 365) {
      sessions = sessions.filter((s) => daysSince(s.time) <= lookback);
    }

    filteredSessions = sessions.slice().sort((a, b) => b.time - a.time);
  }

  $: if (report) applyFilters();

  // -------- Backend helpers (job + polling) --------

  async function createJob(
    lookbackDays: number,
    untilLookbackDays?: number | null,
    signal?: AbortSignal
  ): Promise<string> {
    const body: any = { op: 'create', lookbackDays };
    if (untilLookbackDays != null && untilLookbackDays > 0) {
      body.untilLookbackDays = untilLookbackDays;
    }

    const res = await fetch('/API/engagement/caseload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Create job failed (HTTP ${res.status}): ${text}`);
    }

    const json = await res.json();
    const jobId = String(json.jobId ?? '');
    if (!jobId) throw new Error('Create job failed: missing jobId');
    return jobId;
  }

  async function stepJob(jobId: string, signal?: AbortSignal): Promise<any> {
    const res = await fetch('/API/engagement/caseload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'step', jobId }),
      signal
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Step failed (HTTP ${res.status}): ${text}`);
    }

    return res.json();
  }

  async function cleanupJob(jobId: string) {
    try {
      // No AbortSignal here — cleanup should still run even if a new load starts.
      await fetch('/API/engagement/caseload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'cleanup', jobId })
      });
    } catch {
      // best-effort
    }
  }

  async function fetchAllSessions(
    jobId: string,
    limit = 500,
    signal?: AbortSignal
  ): Promise<SessionDetailRow[]> {
    let offset = 0;
    let all: SessionDetailRow[] = [];

    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const url = `/API/engagement/caseload?jobId=${encodeURIComponent(
        jobId
      )}&view=sessions&offset=${offset}&limit=${limit}`;

      const res = await fetch(url, { signal });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Sessions fetch failed (HTTP ${res.status}): ${text}`);
      }

      const json = await res.json();
      const items: SessionDetailRow[] = json.items ?? json.data ?? [];
      all = all.concat(items);

      const nextOffset = json.nextOffset;
      progressText = `Loaded sessions: ${all.length}${json.total ? ` / ${json.total}` : ''}`;

      if (nextOffset == null) break;
      offset = Number(nextOffset);
    }

    return all;
  }

  function sessionKey(s: SessionDetailRow): string {
    return `${s.memberId}|${s.coachId ?? ''}|${s.channel}|${s.time}`;
  }

  function mergeSessions(existing: SessionDetailRow[], incoming: SessionDetailRow[]): SessionDetailRow[] {
    const map = new Map<string, SessionDetailRow>();
    for (const s of existing) map.set(sessionKey(s), s);

    for (const s of incoming) {
      const k = sessionKey(s);
      if (!map.has(k)) {
        map.set(k, s);
      } else {
        const prev = map.get(k)!;
        map.set(k, {
          ...prev,
          ...s,
          memberName: prev.memberName ?? s.memberName ?? null,
          memberEmail: prev.memberEmail ?? s.memberEmail ?? null,
          client: prev.client ?? s.client ?? null,
          coachName: prev.coachName ?? s.coachName ?? null
        });
      }
    }
    return Array.from(map.values());
  }

  function computeSummary(lookbackDays: number, sessions: SessionDetailRow[]): SessionsSummary {
    const members = new Set<string>();
    for (const s of sessions) members.add(s.memberId);

    return {
      lookbackDays,
      generatedAt: new Date().toISOString(),
      totalSessions: sessions.length,
      uniqueMembers: members.size
    };
  }

  // -------- Main loader --------
  async function loadReport() {
    loading = true;
    error = null;
    progressText = null;

    // Per-run job id so we never clean up a newer run by accident
    let myJobId: string | null = null;
    let signal: AbortSignal | undefined;

    try {
      // Cancel any in-flight load in this tab before starting a new one.
      if (runController) {
        runController.abort();
        runController = null;
      }
      runController = new AbortController();
      signal = runController.signal;

      const parsed = Number(selectedLookbackDays);
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new Error('Please enter a lookback window in days (e.g., 30, 90, 365).');
      }

      let requested = parsed;
      if (requested > 365) requested = 365;
      selectedLookbackDays = String(requested);

      // If already loaded a larger/equal window, reuse browser cache only
      if (cachedReport && lastLoadedLookbackDays !== null && requested <= lastLoadedLookbackDays) {
        report = cachedReport;
        buildDerivedFiltersFrom(report);
        applyFilters();
        return;
      }

      const until = lastLoadedLookbackDays; // null on first load

      // Clean up any prior job safely
      const prev = activeJobId;
      activeJobId = null;
      if (prev) await cleanupJob(prev);

      myJobId = await createJob(requested, until, signal);
      activeJobId = myJobId;

      // Poll / step until complete
      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const prog = await stepJob(myJobId, signal);

        if (prog?.status === 'error') throw new Error(String(prog?.error ?? 'Job failed'));
        if (prog?.status === 'cancelled') throw new Error('Job cancelled');

        if (prog?.progress) {
          const p = prog.progress;
          progressText =
            `Phase: ${prog.phase} · Pages ${p.pagesFetched ?? 0} · ` +
            `Sessions ${p.sessionsCount ?? p.sessionsFetched ?? 0} · ` +
            `Members ${p.uniqueMembers ?? 0}`;
        } else {
          progressText = `Phase: ${prog?.phase ?? 'running'}…`;
        }

        const done = !!prog?.done || prog?.status === 'complete' || prog?.phase === 'complete';
        if (done) break;

        await new Promise((r) => setTimeout(r, 150));
      }

      const newSessions = await fetchAllSessions(myJobId, 750, signal);

      const merged = cachedReport?.sessions?.length
        ? mergeSessions(cachedReport.sessions, newSessions)
        : newSessions;

      const generatedAt = new Date().toISOString();
      const summary = computeSummary(requested, merged);

      cachedReport = {
        lookbackDays: requested,
        generatedAt,
        sessions: merged,
        summary
      };

      lastLoadedLookbackDays = requested;
      report = cachedReport;

      buildDerivedFiltersFrom(report);
      applyFilters();
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        // A newer run replaced this one; do not surface as an error.
        return;
      }
      console.error(e);
      error = e?.message ?? String(e);
    } finally {
      loading = false;

      // Always cleanup server job state ASAP so Node isn't acting as a cache.
      if (myJobId) await cleanupJob(myJobId);
      if (activeJobId === myJobId) activeJobId = null;

      progressText = null;

      // Clear controller if it still belongs to this run
      if (runController?.signal === signal) runController = null;
    }
  }

  // Best-effort cleanup on tab close / refresh
  function beaconCleanup() {
    if (!activeJobId) return;
    if (!browser) return;
    try {
      const payload = JSON.stringify({ op: 'cleanup', jobId: activeJobId });
      navigator.sendBeacon('/API/engagement/caseload', payload);
    } catch {
      // ignore
    }
  }

  onMount(() => {
    if (browser) window.addEventListener('beforeunload', beaconCleanup);
  });

  onDestroy(() => {
    if (browser) {
      window.removeEventListener('beforeunload', beaconCleanup);
      beaconCleanup();
    }
  });
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

  .error {
    color: #b00020;
    margin-bottom: 1rem;
  }

  .muted {
    color: #777;
    font-size: 0.8rem;
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
    vertical-align: top;
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
    white-space: nowrap;
  }
</style>

<div class="page">
  <h1>Sessions Dashboard</h1>
  <div class="subtitle">
    Coaching sessions (closed conversations) by <strong>coach</strong>, <strong>client</strong>, and <strong>channel</strong>.
  </div>

  {#if error}
    <div class="error">Error: {error}</div>
  {/if}

  <div class="filters">
    <div class="filter-group">
      <label for="lookback">Lookback window (days, max 365)</label>
      <input id="lookback" type="number" min="1" max="365" bind:value={selectedLookbackDays} />
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
      {:else}
        <div class="muted">
          Data is cached in this browser session; increasing the window appends older sessions to the cache.
        </div>
      {/if}
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
            <input type="checkbox" bind:checked={selectedChannels[ch]} />
            {ch}
          </label>
        {/each}
      </div>
      <div class="muted">Session is included if its channel is selected.</div>
    </div>
  </div>

  {#if loading && !report}
    <p>Loading sessions…</p>
  {:else if report}
    <div class="muted" style="margin-bottom: 0.75rem;">
      Generated at {new Date(report.generatedAt).toLocaleString()} · Cached lookback = {report.lookbackDays} days ·
      Sessions cached: {report.summary.totalSessions} · Unique members: {report.summary.uniqueMembers}
    </div>

    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Channel</th>
          <th>Coach</th>
          <th>Member</th>
          <th>Client</th>
          <th>Days since</th>
        </tr>
      </thead>
      <tbody>
        {#each filteredSessions.slice(0, 2000) as s}
          <tr>
            <td>{new Date(s.time * 1000).toLocaleString()}</td>
            <td><span class="pill">{s.channel}</span></td>
            <td>{s.coachName || s.coachId || '—'}</td>
            <td>
              {s.memberName || '(no name)'}
              <div class="muted">{s.memberEmail || ''}</div>
            </td>
            <td>{s.client || '—'}</td>
            <td>{daysSince(s.time).toFixed(1)}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    {#if filteredSessions.length > 2000}
      <div class="muted">Showing first 2000 sessions (of {filteredSessions.length}). Add filters to narrow.</div>
    {/if}
  {/if}
</div>
