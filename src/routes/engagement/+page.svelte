<script lang="ts">
  import { onMount } from 'svelte';
  import * as Accordion from '$lib/components/ui/accordion/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import { fetchOverviewReport, type OverviewResponse } from '$lib/client/overview-report';

  let overview: OverviewResponse | null = null;
  let overviewLoading = false;
  let overviewError: string | null = null;

  function formatDelta(delta: number, pct: number | null): string {
    const signed = delta >= 0 ? `+${delta}` : String(delta);
    if (pct == null) return `${signed} vs prior MTD`;
    const signedPct = pct >= 0 ? `+${pct.toFixed(2)}%` : `${pct.toFixed(2)}%`;
    return `${signed} (${signedPct}) vs prior MTD`;
  }

  async function loadOverview() {
    overviewLoading = true;
    overviewError = null;
    try {
      overview = await fetchOverviewReport();
    } catch (e: any) {
      overviewError = e?.message ?? String(e);
    } finally {
      overviewLoading = false;
    }
  }

  onMount(() => {
    loadOverview();
  });

  type ReportLink = {
    id: string;
    name: string;
    path: string;
    summary: string;
    primaryAudience: string;
    metrics: string[];
    filters: string[];
    notes?: string[];
  };

  const reports: ReportLink[] = [
    {
      id: 'caseload',
      name: 'Caseload Report',
      path: '/engagement/caseload',
      summary:
        'Counts unique members with at least one qualifying coaching session in the loaded window, then groups them by days since their latest session and channel combination.',
      primaryAudience: 'Coaches, Clinical/Operations Leads, Program Managers',
      metrics: [
        'Unique members with last session <= 7 days ago',
        'Unique members with last session 8-28 days ago',
        'Unique members with last session 29-56 days ago',
        'Unique members with last session > 56 days ago',
        'Channel-combination matrix using Phone, Video Conference, Email, Chat'
      ],
      filters: [
        'Lookback window (days, max 365)',
        'Assigned coach',
        'Employer (Client)',
        'Channel checkboxes (member included if they used any selected channel)'
      ],
      notes: [
        'Session source = closed conversations with Channel in {Phone, Video Conference, Email, Chat}.',
        'Member recency uses latest available timestamp in this order: statistics.last_close_at, statistics.last_admin_reply_at, updated_at, created_at.',
        'Each member is counted once using their most recent session timestamp.'
      ]
    },
    {
      id: 'sessions',
      name: 'Sessions Report',
      path: '/engagement/sessions',
      summary:
        'Lists individual qualifying coaching sessions (not unique members) with the same session rules as Caseload.',
      primaryAudience: 'Coaches, Ops, Finance, Capacity Planning',
      metrics: [
        'Total sessions in the filtered view',
        'Unique members represented by the filtered sessions',
        'Session-level detail table sorted newest-first'
      ],
      filters: [
        'Lookback window (days, max 365)',
        'Assigned coach',
        'Employer (Client)',
        'Channel checkboxes (Phone, Video Conference, Email, Chat)'
      ],
      notes: [
        'Data is pulled from /API/engagement/caseload using view=sessions.',
        'Report counts every qualifying session row, not one row per member.',
        'UI renders up to 2000 filtered rows in-table.'
      ]
    },
    {
      id: 'new-participants',
      name: 'Enrolled Participants Report',
      path: '/engagement/new-participants',
      summary:
        'Tracks recently enrolled participants and buckets them by days without a coaching session.',
      primaryAudience: 'Onboarding Teams, Program Managers, Clinical Leads',
      metrics: [
        'Participants 15-21 days without a session',
        'Participants 22-28 days without a session',
        'Participants > 28 days without a session (report-local Unengaged bucket)',
        'Loaded participant total and filtered participant total'
      ],
      filters: [
        'Lookback window (days, max 365)',
        'Assigned coach',
        'Employer (Client)',
        'Enrolled Date range'
      ],
      notes: [
        'Enrolled participants are contacts with role=user and Enrolled Date inside the loaded lookback window.',
        'daysWithoutSession = days since last session if any session exists; otherwise days since Enrolled Date.',
        'Has session is shown at row level; there is no separate headline metric for no-session participants.'
      ]
    },
    {
      id: 'billing',
      name: 'Billing Report',
      path: '/engagement/billing',
      summary:
        'Builds a month-specific billable cohort from new participants plus members who met the billing engagement window during that month.',
      primaryAudience: 'Finance, RevOps, Program Leadership',
      metrics: [
        'Billable users = union of: new participants in month + engaged-during-month users',
        'Counts for total billable, new participants, engaged during month, and overlap',
        'Per-row fields: member ID, name, email, employer, Enrolled Date, last qualifying session'
      ],
      filters: [
        'Calendar month (YYYY-MM)',
        'Employer (Client) filter for on-page metrics/table/export'
      ],
      notes: [
        'Month window is calculated in America/New_York time and can be any selected month.',
        'New participant = Enrolled Date inside [monthStart, monthEnd).',
        'Engaged during month = last qualifying session timestamp inside [monthStart-56 days, monthEnd).',
        'Billing qualifying sessions currently use closed conversations with Channel in {Phone, Video Conference}.',
        'Billing session timestamp uses statistics.last_close_at, then statistics.last_admin_reply_at, then created_at.',
        'Table shows top 500 filtered rows; full result set is available via CSV export.',
        'Employer is read from the Employer custom attribute.'
      ]
    }
  ];

  const glossary = [
    {
      term: 'Coaching session (reports)',
      def: 'For Caseload, Sessions, and Enrolled Participants: a closed conversation with Channel in {Phone, Video Conference, Email, Chat}.'
    },
    {
      term: 'Qualifying coaching session (sync jobs)',
      def: 'For session/engagement sync and billing logic: Phone or Video Conference conversations; session-sync also requires Service Code in {Health Coaching 001, Disease Management 002} for first/last session updates.'
    },
    {
      term: 'Last Call',
      def: 'In session-sync, Last Call is updated from Phone conversations regardless of closed state.'
    },
    {
      term: 'Channel',
      def: 'Conversation custom attribute Channel (for example: Phone, Video Conference, Email, Chat).'
    },
    {
      term: 'Enrolled Date',
      def: 'Contact custom attribute Enrolled Date, used as participant start date for participant and engagement workflows.'
    },
    {
      term: 'Employer (Client)',
      def: 'Contact custom attribute Employer, used as the client dimension in report filters.'
    },
    {
      term: 'Engaged (engagement-sync)',
      def: 'If Last Coaching Session exists: <= 28 days since last session. If no last session exists: <= 28 days since Enrolled Date.'
    },
    {
      term: 'At Risk (engagement-sync)',
      def: '29-56 days since Last Coaching Session.'
    },
    {
      term: 'Unengaged (engagement-sync)',
      def: '> 56 days since Last Coaching Session, or > 28 days since Enrolled Date when no session exists.'
    },
    {
      term: 'Billing Engaged During Month',
      def: 'A member whose latest billing-qualifying session timestamp falls inside [monthStart-56 days, monthEnd), where month boundaries are evaluated in America/New_York.'
    },
    {
      term: 'Assigned Coach',
      def: 'Usually conversation admin_assignee_id; New Participants falls back to first teammate ID when assignee is missing.'
    },
    {
      term: 'Lookback window',
      def: 'A report input that limits how far back conversations/contacts are loaded before local filtering.'
    }
  ];

  type ApiEndpoint = {
    id: string;
    name: string;
    path: string;
    summary: string;
    schedule: string;
    payload?: string;
    notes?: string[];
  };

  const apiEndpoints: ApiEndpoint[] = [
    {
      id: 'session-sync-v2',
      name: 'Session Sync',
      path: 'POST /API/engagement/session-sync',
      summary:
        'Scans qualifying conversations and updates Last Coaching Session, First Session Date, and Last Call for enrolled members.',
      schedule: 'Typically daily via scheduler (run first, before engagement-sync).',
      payload: '{"lookbackDays": 30, "dryRun": true, "mode": "all"}',
      notes: [
        'Session updates use closed conversations where Channel in {Phone, Video Conference} and Service Code in {"Health Coaching 001", "Disease Management 002"}.',
        'Last Call updates from Phone conversations regardless of close state.',
        'mode controls whether first, last/call, or both are updated.'
      ]
    },
    {
      id: 'engagement-classifier-v2',
      name: 'Engagement Sync',
      path: 'POST /API/engagement/engagement-sync',
      summary:
        'Classifies enrolled members into Engagement Status and writes Engagement Status Date when status changes.',
      schedule: 'Typically daily, after session-sync.',
      payload: '{"dryRun": true, "enrolledLookbackDays": 365}',
      notes: [
        'Engaged: <= 28 days since Last Coaching Session, or <= 28 days since Enrolled Date when no session exists.',
        'At Risk: 29-56 days since Last Coaching Session.',
        'Unengaged: > 56 days since Last Coaching Session, or > 28 days since Enrolled Date with no session.',
        'Current implementation classifies from Enrolled Date + Last Coaching Session.'
      ]
    },
    {
      id: 'referral-eligible-programs',
      name: 'Referral to Eligible Programs Sync',
      path: 'POST /API/engagement/referral-sync',
      summary:
        'For members with Referral = "Counter Health", sets Eligible Programs = "Smart Access".',
      schedule: 'Run nightly or as needed after new members are loaded from upstream systems.',
      notes: [
        'Idempotent: safe to run repeatedly.',
        'Can be extended to map additional Referral values to Eligible Programs.'
      ]
    },
    {
      id: 'engagement-export',
      name: 'Engagement Export (CSV/JSON/File)',
      path: 'POST /API/engagement/report/engagement',
      summary:
        'Exports enrolled-member data with optional filters; returns CSV stream by default or JSON/file outputs by mode.',
      schedule: 'On demand from scripts or ad hoc operations.',
      payload: `{
  "returnMode": "stream",
  "referral": "Counter Health",
  "employer": "ACME Corp",
  "employerExclusions": ["Test Employer"],
  "enrolledDateStart": "2024-01-01",
  "enrolledDateEnd": "2024-12-31",
  "lastSessionStart": "2024-06-01",
  "lastSessionEnd": "2024-06-30",
  "engagementStatus": ["Engaged", "At Risk"],
  "perPage": 150
}`,
      notes: [
        'Supported return modes: stream (default), json, file (requires outputPath).',
        'Filters are applied through Intercom contact search (role=user and Enrolled Date > 0 always enforced).',
        'CSV columns follow the external spec: employee_id, name_first, name_last, member_dob, group_description, last_coaching_session, program_status, status_date, eligible_programs, registration_code.'
      ]
    }
  ];
</script>

<div class="mx-auto max-w-7xl space-y-8 px-4 py-6 sm:px-6 lg:px-8">
  <div class="space-y-2">
    <h1 class="text-3xl font-semibold tracking-tight">Coaching Analytics Reports</h1>
    <p class="max-w-4xl text-sm text-muted-foreground">
      This page documents report definitions and backend support endpoints. Use it as the source of
      truth for how each report is calculated and where each dataset comes from.
    </p>
  </div>

  <section class="space-y-3">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-medium">Overview KPIs (MTD)</h2>
      {#if overview}
        <span class="text-xs text-muted-foreground">
          {overview.monthYearLabel} · {overview.timeZone}
        </span>
      {/if}
    </div>

    {#if overviewError}
      <p class="text-sm text-destructive">Unable to load overview KPIs: {overviewError}</p>
    {:else if overviewLoading}
      <p class="text-sm text-muted-foreground">Loading overview KPIs...</p>
    {:else if overview}
      <div class="grid gap-3 md:grid-cols-3">
        <Card.Root>
          <Card.Header class="pb-2">
            <Card.Description>New registrations</Card.Description>
            <Card.Title class="text-2xl">{overview.kpis.newRegistrationsMtd.count}</Card.Title>
          </Card.Header>
          <Card.Content class="text-xs text-muted-foreground">
            {formatDelta(
              overview.kpis.newRegistrationsMtd.deltaCount,
              overview.kpis.newRegistrationsMtd.deltaPct
            )}
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header class="pb-2">
            <Card.Description>New enrollees</Card.Description>
            <Card.Title class="text-2xl">{overview.kpis.newEnrolleesMtd.count}</Card.Title>
          </Card.Header>
          <Card.Content class="text-xs text-muted-foreground">
            {formatDelta(
              overview.kpis.newEnrolleesMtd.deltaCount,
              overview.kpis.newEnrolleesMtd.deltaPct
            )}
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header class="pb-2">
            <Card.Description>Qualifying coaching sessions</Card.Description>
            <Card.Title class="text-2xl">{overview.kpis.qualifyingSessionsMtd.count}</Card.Title>
          </Card.Header>
          <Card.Content class="text-xs text-muted-foreground">
            {formatDelta(
              overview.kpis.qualifyingSessionsMtd.deltaCount,
              overview.kpis.qualifyingSessionsMtd.deltaPct
            )}
          </Card.Content>
        </Card.Root>
      </div>
    {/if}
  </section>

  <div class="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)]">
    <section class="space-y-4">
      <div class="space-y-1">
        <h2 class="text-lg font-medium">Available Reports</h2>
        <p class="text-sm text-muted-foreground">
          Each report uses conversations and contact attributes, with report-specific notes where
          logic differs.
        </p>
      </div>

      <div class="space-y-4">
        {#each reports as r}
          <Card.Root id={r.id}>
            <Card.Header class="space-y-3">
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="space-y-1">
                  <Card.Title class="text-xl">{r.name}</Card.Title>
                  <Card.Description>{r.summary}</Card.Description>
                </div>
                <Badge variant="secondary" class="max-w-full whitespace-normal">
                  {r.primaryAudience}
                </Badge>
              </div>
            </Card.Header>

            <Card.Content class="space-y-3">
              <Accordion.Root type="multiple" class="w-full">
                <Accordion.Item value={`${r.id}-metrics`}>
                  <Accordion.Trigger>Key metrics</Accordion.Trigger>
                  <Accordion.Content>
                    <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      {#each r.metrics as m}
                        <li>{m}</li>
                      {/each}
                    </ul>
                  </Accordion.Content>
                </Accordion.Item>

                <Accordion.Item value={`${r.id}-filters`}>
                  <Accordion.Trigger>Filters</Accordion.Trigger>
                  <Accordion.Content>
                    <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      {#each r.filters as f}
                        <li>{f}</li>
                      {/each}
                    </ul>
                  </Accordion.Content>
                </Accordion.Item>

                {#if r.notes?.length}
                  <Accordion.Item value={`${r.id}-notes`}>
                    <Accordion.Trigger>Important notes</Accordion.Trigger>
                    <Accordion.Content>
                      <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                        {#each r.notes as note}
                          <li>{note}</li>
                        {/each}
                      </ul>
                    </Accordion.Content>
                  </Accordion.Item>
                {/if}
              </Accordion.Root>
            </Card.Content>

            <Card.Footer class="flex flex-wrap items-center justify-between gap-2">
              <Button href={r.path} size="sm">Open report</Button>
              <span class="text-xs text-muted-foreground">{r.path}</span>
            </Card.Footer>
          </Card.Root>
        {/each}
      </div>
    </section>

    <aside class="space-y-4">
      <Card.Root class="lg:sticky lg:top-6">
        <Card.Header class="space-y-1">
          <Card.Title>Shared Definitions</Card.Title>
          <Card.Description>
            Terms below are precise to current implementation. Where behavior differs by job/report,
            the definition calls it out.
          </Card.Description>
        </Card.Header>

        <Card.Content class="space-y-4">
          {#each glossary as g, i}
            <div class="space-y-1">
              <div class="text-sm font-medium">{g.term}</div>
              <div class="text-sm text-muted-foreground">{g.def}</div>
            </div>
            {#if i < glossary.length - 1}
              <Separator />
            {/if}
          {/each}
        </Card.Content>
      </Card.Root>
    </aside>
  </div>

  <section class="space-y-4">
    <div class="space-y-1">
      <h2 class="text-lg font-medium">Background Jobs and API Endpoints</h2>
      <p class="text-sm text-muted-foreground">
        These endpoints support recurring sync jobs and ad hoc exports.
      </p>
    </div>

    <div class="space-y-4">
      {#each apiEndpoints as e}
        <Card.Root id={e.id}>
          <Card.Header class="space-y-3">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="space-y-1">
                <Card.Title class="text-xl">{e.name}</Card.Title>
                <Card.Description>{e.summary}</Card.Description>
              </div>
              <Badge variant="outline" class="max-w-full whitespace-normal break-all font-mono text-xs">
                {e.path}
              </Badge>
            </div>
          </Card.Header>

          <Card.Content class="space-y-3">
            <div class="space-y-1">
              <div class="text-sm font-medium">Typical schedule</div>
              <div class="text-sm text-muted-foreground">{e.schedule}</div>
            </div>

            {#if e.payload}
              <div class="space-y-2">
                <div class="text-sm font-medium">Example payload</div>
                <pre class="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed text-muted-foreground">{e.payload}</pre>
              </div>
            {/if}

            {#if e.notes?.length}
              <div class="space-y-2">
                <div class="text-sm font-medium">Notes</div>
                <ul class="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {#each e.notes as note}
                    <li>{note}</li>
                  {/each}
                </ul>
              </div>
            {/if}
          </Card.Content>
        </Card.Root>
      {/each}
    </div>
  </section>
</div>
