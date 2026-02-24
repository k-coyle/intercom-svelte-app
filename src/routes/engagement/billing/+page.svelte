<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    cleanupBillingJob,
    fetchAllBillingRows,
    fetchBillingView,
    runBillingJobUntilComplete
  } from '$lib/client/billing-job';
  import {
    downloadCsv,
    formatUnixDate
  } from '$lib/client/report-utils';
  import ReportCanvas from '$lib/components/report/ReportCanvas.svelte';

  interface BillingRow {
    memberId: string;
    memberName: string | null;
    memberEmail: string | null;
    employer: string | null;
    registrationAt: number | null; // Enrolled Date (unix seconds)
    lastSessionAt: number | null;  // last qualifying session timestamp (unix seconds)
    isNewParticipant: boolean;
    engagedDuringMonth: boolean;
  }

  interface BillingReport {
    year: number;
    month: number; // 1-12
    monthYearLabel: string;
    monthStart: string;
    monthEnd: string;
    generatedAt: string;
    totalRows: number;
    rows: BillingRow[];
  }

  let report: BillingReport | null = null;
  let cachedReport: BillingReport | null = null;
  let lastLoadedMonthLabel: string | null = null;
  let selectedMonthLabel: string = getCurrentPreviousMonthLabel(); // YYYY-MM

  let loading = false;
  let error: string | null = null;
  let loadingStage: string = '';
  let activeJobId: string | null = null;
  let runController: AbortController | null = null;

  // Employer filter
  let uniqueEmployers: string[] = [];
  let selectedEmployer: string = '';

  // Filtered rows (used for metrics, table, and CSV export)
  let filteredRows: BillingRow[] = [];

  // Derived metrics (based on filteredRows)
  let totalBillable = 0;
  let totalNewParticipants = 0;
  let totalEngaged = 0;
  let totalBoth = 0;
  let totalEngagedOnly = 0;

  function getCurrentPreviousMonthLabel(): string {
    const now = new Date();
    let year = now.getFullYear();
    let monthIndex = now.getMonth(); // 0-11 (current month)

    // previous month
    if (monthIndex === 0) {
      year -= 1;
      monthIndex = 11;
    } else {
      monthIndex -= 1;
    }

    const month = monthIndex + 1;
    return `${year}-${String(month).padStart(2, '0')}`;
  }

  function buildUniqueEmployers() {
    if (!report) {
      uniqueEmployers = [];
      return;
    }

    const set = new Set<string>();
    for (const row of report.rows) {
      if (row.employer != null) {
        set.add(String(row.employer));
      }
    }
    uniqueEmployers = Array.from(set).sort();
  }

  async function fetchBillingSummary(jobId: string, signal?: AbortSignal): Promise<any> {
    return fetchBillingView<any>(jobId, 'summary', undefined, undefined, signal);
  }

  async function runReport() {
    loading = true;
    error = null;
    loadingStage = 'Starting billing job…';

    let myJobId: string | null = null;
    let signal: AbortSignal | undefined;

    try {
      const requestedMonth = selectedMonthLabel || getCurrentPreviousMonthLabel();

      // Reuse cached report if it's for the same selected month
      if (cachedReport && lastLoadedMonthLabel === requestedMonth) {
        report = cachedReport;
        selectedEmployer = '';
        buildUniqueEmployers();
        return;
      }

      // Cancel any previous run in this tab
      if (runController) {
        runController.abort();
        runController = null;
      }
      runController = new AbortController();
      signal = runController.signal;

      // cleanup previous job if still tracked
      const prev = activeJobId;
      activeJobId = null;
      if (prev) await cleanupBillingJob(prev);

      const run = await runBillingJobUntilComplete({
        monthYearLabel: requestedMonth,
        signal,
        onJobCreated: (id) => {
          myJobId = id;
          activeJobId = id;
        },
        onProgress: (prog) => {
          if (prog?.progress) {
            const p = prog.progress;
            loadingStage =
              `Phase: ${prog.phase} · Conv pages ${p.conversationPagesFetched ?? 0} · ` +
              `Participants ${p.newParticipants ?? 0} · Contacts remaining ${p.contactsRemaining ?? 0}`;
          } else {
            loadingStage = `Phase: ${prog?.phase ?? 'running'}…`;
          }
        }
      });

      myJobId = run.jobId;
      activeJobId = run.jobId;

      loadingStage = 'Fetching report output…';
      const summary = await fetchBillingSummary(myJobId, signal);
      const rows = await fetchAllBillingRows<BillingRow>({
        jobId: myJobId,
        limit: 1000,
        signal,
        onPage: ({ loaded, total }) => {
          loadingStage = `Loaded rows: ${loaded}${total ? ` / ${total}` : ''}`;
        }
      });

      const data: BillingReport = {
        year: Number(summary.year),
        month: Number(summary.month),
        monthYearLabel: String(summary.monthYearLabel),
        monthStart: String(summary.monthStart),
        monthEnd: String(summary.monthEnd),
        generatedAt: String(summary.generatedAt),
        totalRows: Number(summary.totalRows ?? rows.length),
        rows
      };

      report = data;
      cachedReport = data;
      lastLoadedMonthLabel = data.monthYearLabel;

      selectedEmployer = '';
      buildUniqueEmployers();
      loadingStage = 'Done.';
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      console.error(e);
      error = e?.message ?? String(e);
    } finally {
      loading = false;

      if (myJobId) await cleanupBillingJob(myJobId);
      if (activeJobId === myJobId) activeJobId = null;
      if (runController?.signal === signal) runController = null;
    }
  }
  function exportCsv() {
    if (!report) return;

    const headers = [
      'User ID',
      'Name',
      'Email',
      'Employer',
      'Enrolled Date',
      'Last Qualifying Session',
      'Is New Participant',
      'Engaged During Month'
    ];

    const rows = filteredRows.map((row) => [
        row.memberId,
        row.memberName ?? '',
        row.memberEmail ?? '',
        row.employer ?? '',
        formatUnixDate(row.registrationAt),
        formatUnixDate(row.lastSessionAt),
        row.isNewParticipant ? 'Yes' : 'No',
        row.engagedDuringMonth ? 'Yes' : 'No'
      ]
    );

    const monthStr = report.month.toString().padStart(2, '0');
    const suffix = selectedEmployer ? `_${selectedEmployer.replace(/[^a-zA-Z0-9_-]/g, '_')}` : '';
    const filename = `billing_${report.year}-${monthStr}${suffix}.csv`;

    downloadCsv(filename, headers, rows);
  }

  // --- REACTIVE FILTERING & METRICS ---

  // filteredRows depends on both report and selectedEmployer
  $: filteredRows = report
    ? (selectedEmployer
        ? report.rows.filter((r) => r.employer === selectedEmployer)
        : report.rows)
    : [];

  // metrics depend on filteredRows
  $: {
    totalBillable = filteredRows.length;
    totalNewParticipants = filteredRows.filter((r) => r.isNewParticipant).length;
    totalEngaged = filteredRows.filter((r) => r.engagedDuringMonth).length;
    totalBoth = filteredRows.filter(
      (r) => r.isNewParticipant && r.engagedDuringMonth
    ).length;
    totalEngagedOnly = totalEngaged - totalBoth;
  }

  onDestroy(() => {
    if (runController) runController.abort();
    if (activeJobId) cleanupBillingJob(activeJobId, true);
  });
</script>

<ReportCanvas reportKey="billing" />
