<!-- src/routes/engagement/new-participants/+page.svelte -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    cleanupNewParticipantsJob,
    fetchAllNewParticipantsRows,
    fetchNewParticipantsView,
    runNewParticipantsJobUntilComplete
  } from '$lib/client/new-participants-job';
  import {
    MAX_LOOKBACK_DAYS,
    downloadCsv,
    formatUnixDate,
    parseLookbackDays
  } from '$lib/client/report-utils';
  import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';

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
  let progressText: string | null = null;
  let activeJobId: string | null = null;
  let runController: AbortController | null = null;

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

  function bucketLabel(b: ParticipantBuckets): string {
    if (b.gt_28) return '> 28 days (Unengaged)';
    if (b.gt_21_to_28) return '22-28 days';
    if (b.gt_14_to_21) return '15-21 days';
    return '<= 14 days';
  }

  function exportCsv() {
    if (!filteredParticipants.length) {
      error = 'No rows to export. Load data and/or adjust filters first.';
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

    const rows = filteredParticipants.map((p) => [
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
      ]
    );

    downloadCsv('enrolled-participants-report.csv', header, rows);
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

  async function fetchNewParticipantsSummary(jobId: string, signal?: AbortSignal): Promise<any> {
    return fetchNewParticipantsView<any>(jobId, 'summary', undefined, undefined, signal);
  }

  async function loadReport() {
    loading = true;
    error = null;
    progressText = null;

    let myJobId: string | null = null;
    let signal: AbortSignal | undefined;

    try {
      const requested = parseLookbackDays(selectedLookbackDays);
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

      // Cancel any previous run in this tab
      if (runController) {
        runController.abort();
        runController = null;
      }
      runController = new AbortController();
      signal = runController.signal;

      // Cleanup previous job if still tracked
      const prev = activeJobId;
      activeJobId = null;
      if (prev) await cleanupNewParticipantsJob(prev);

      progressText = 'Starting report job...';
      const run = await runNewParticipantsJobUntilComplete({
        lookbackDays: requested,
        signal,
        onJobCreated: (id) => {
          myJobId = id;
          activeJobId = id;
        },
        onProgress: (prog) => {
          if (prog?.progress) {
            const p = prog.progress;
            progressText =
              `Phase: ${prog.phase} · participants pages ${p.participantPagesFetched ?? 0} · ` +
              `conversation pages ${p.conversationPagesFetched ?? 0}`;
          } else {
            progressText = `Phase: ${prog?.phase ?? 'running'}...`;
          }
        }
      });

      myJobId = run.jobId;
      activeJobId = run.jobId;

      progressText = 'Fetching report output...';
      const summary = await fetchNewParticipantsSummary(myJobId, signal);
      const participants = await fetchAllNewParticipantsRows<ParticipantRow>({
        jobId: myJobId,
        limit: 1000,
        signal,
        onPage: ({ loaded, total }) => {
          progressText = `Loaded participants: ${loaded}${total ? ` / ${total}` : ''}`;
        }
      });

      const data: NewParticipantsReport = {
        generatedAt: String(summary.generatedAt),
        lookbackDays: Number(summary.lookbackDays ?? requested),
        totalParticipants: Number(summary.totalParticipants ?? participants.length),
        summary: {
          gt_14_to_21: Number(summary.summary?.gt_14_to_21 ?? 0),
          gt_21_to_28: Number(summary.summary?.gt_21_to_28 ?? 0),
          gt_28: Number(summary.summary?.gt_28 ?? 0)
        },
        participants
      };
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
      progressText = 'Done.';
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      console.error(e);
      error = e?.message ?? String(e);
    } finally {
      loading = false;
      if (myJobId) await cleanupNewParticipantsJob(myJobId);
      if (activeJobId === myJobId) activeJobId = null;
      if (runController?.signal === signal) runController = null;
    }
  }

  onDestroy(() => {
    if (runController) runController.abort();
    if (activeJobId) cleanupNewParticipantsJob(activeJobId, true);
  });
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

<ReportCanvas reportKey="enrolled" />
