<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    cleanupCaseloadJob,
    fetchAllCaseloadViewItems,
    fetchCaseloadViewPage,
    runCaseloadJobUntilComplete
  } from '$lib/client/caseload-job';
  import {
    MAX_LOOKBACK_DAYS,
    parseLookbackDays
  } from '$lib/client/report-utils';
  import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';

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
    return fetchAllCaseloadViewItems<CaseloadMemberRow>({
      jobId,
      view: 'members',
      limit: 2000,
      signal
    });
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
      const run = await runCaseloadJobUntilComplete({
        lookbackDays,
        untilLookbackDays,
        signal,
        onJobCreated: (id) => {
          myJobId = id;
          activeJobId = id;
        },
        onProgress: (prog) => {
          if (prog?.progress) {
            const p = prog.progress;
            progressText =
              `Pages ${p.pagesFetched ?? 0} · conv ${p.conversationsFetched ?? 0} · ` +
              `members ${p.uniqueMembers ?? 0} · missing contacts ${p.missingContacts ?? 0}`;
          }
        }
      });

      myJobId = run.jobId;
      activeJobId = run.jobId;

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

<ReportCanvas reportKey="caseload" />
