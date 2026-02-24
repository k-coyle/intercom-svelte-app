<!-- src/routes/engagement/sessions/+page.svelte -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { browser } from '$app/environment';
  import {
    beaconCleanupCaseloadJob,
    fetchAllCaseloadViewItems,
    cleanupCaseloadJob,
    runCaseloadJobUntilComplete
  } from '$lib/client/caseload-job';
  import {
    MAX_LOOKBACK_DAYS,
    formatUnixDate,
    parseLookbackDays
  } from '$lib/client/report-utils';
  import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';

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
    if (!Number.isNaN(lookback) && lookback > 0 && lookback <= MAX_LOOKBACK_DAYS) {
      sessions = sessions.filter((s) => daysSince(s.time) <= lookback);
    }

    filteredSessions = sessions.slice().sort((a, b) => b.time - a.time);
  }

  $: if (report) applyFilters();

  // -------- Backend helpers (job + polling) --------

  async function fetchAllSessions(
    jobId: string,
    limit = 500,
    signal?: AbortSignal
  ): Promise<SessionDetailRow[]> {
    return fetchAllCaseloadViewItems<SessionDetailRow>({
      jobId,
      view: 'sessions',
      limit,
      signal,
      onPage: ({ loaded, total }) => {
        progressText = `Loaded sessions: ${loaded}${total ? ` / ${total}` : ''}`;
      }
    });
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

      const requested = parseLookbackDays(selectedLookbackDays);
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
      if (prev) await cleanupCaseloadJob(prev);

      const run = await runCaseloadJobUntilComplete({
        lookbackDays: requested,
        untilLookbackDays: until,
        signal,
        onJobCreated: (id) => {
          myJobId = id;
          activeJobId = id;
        },
        onProgress: (prog) => {
          if (prog?.progress) {
            const p = prog.progress;
            progressText =
              `Phase: ${prog.phase} · Pages ${p.pagesFetched ?? 0} · ` +
              `Sessions ${p.sessionsCount ?? p.sessionsFetched ?? 0} · ` +
              `Members ${p.uniqueMembers ?? 0}`;
          } else {
            progressText = `Phase: ${prog?.phase ?? 'running'}…`;
          }
        }
      });

      myJobId = run.jobId;
      activeJobId = run.jobId;

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
      if (myJobId) await cleanupCaseloadJob(myJobId);
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
    beaconCleanupCaseloadJob(activeJobId);
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

<ReportCanvas reportKey="sessions" />
