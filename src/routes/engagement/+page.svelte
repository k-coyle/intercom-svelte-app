<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Accordion from "$lib/components/ui/accordion/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";

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
        'Shows how many unique members a coach is actively working with, segmented by recency of their last coaching session and communication channel combination.',
      primaryAudience: 'Coaches, Clinical/Operations Leads, Program Managers',
      metrics: [
        'Unique members with a coaching session in the last <=7 days',
        'Unique members with a coaching session >7 & <=28 days',
        'Unique members with a coaching session >28 & <=56 days ago',
        'Unique members with a coaching session >56 days ago',
        'Breakdown by channel combination (Phone, Video Conference, Email, Chat)'
      ],
      filters: [
        'Assigned Coach',
        'Employer (Client)',
        'Session type / channel combination (Phone, Video, Email, Chat)',
        'Optional date lookback window'
      ],
      notes: [
        'Each member is counted once per row based on their most recent qualifying coaching session.',
        'A “coaching session” is any closed conversation where Channel ∈ {Phone, Video Conference, Email, Chat}.'
      ]
    },
    {
      id: 'sessions',
      name: 'Sessions Report',
      path: '/engagement/sessions',
      summary:
        'Tracks the total number of coaching sessions over configurable time windows, rather than unique members.',
      primaryAudience: 'Coaches, Ops, Finance, Capacity Planning',
      metrics: [
        'Total coaching sessions in the last <=7 days',
        'Total coaching sessions in the last 8–28 days',
        'Total coaching sessions in the last 29–56 days',
        'Total coaching sessions in a configurable date range'
      ],
      filters: [
        'Assigned Coach',
        'Employer (Client)',
        'Session type / channel (Phone, Video, Email, Chat)',
        'Date range'
      ],
      notes: [
        'This report counts every qualifying coaching session (not unique members).',
        'Session definition matches the Caseload Report: closed conversation + Channel ∈ {Phone, Video Conference, Email, Chat}.'
      ]
    },
    {
      id: 'new-participants',
      name: 'Enrolled Participants Report',
      path: '/engagement/new-participants',
      summary:
        'Focuses on members who recently became program participants (Enrolled Date) and how quickly they receive their first coaching session.',
      primaryAudience: 'Onboarding Teams, Program Managers, Clinical Leads',
      metrics: [
        'Enrolled participants with no coaching session yet',
        'Enrolled participants >14–21 days without a first coaching session',
        'Enrolled participants 22–28 days without a first coaching session',
        'Enrolled participants >28 days without a coaching session (treated as “Unengaged” for onboarding)'
      ],
      filters: [
        'Assigned Coach',
        'Employer (Client)',
        'Participant Date (Enrolled Date)',
        'Lookback window (server-side bound on Enrolled Date + conversations)'
      ],
      notes: [
        '“Enrolled participant” in this report = contact whose Enrolled Date falls within the loaded lookback window.',
        'Buckets are report-local and based on days since first/last session or since Enrolled Date if no session yet.'
      ]
    },
    {
      id: 'billing',
      name: 'Billing Report',
      path: '/engagement/billing',
      summary:
        'Identifies members who should be billable for a given calendar month, based on becoming a participant or meeting engagement criteria, and exposes them as an exportable table.',
      primaryAudience: 'Finance, RevOps, Program Leadership',
      metrics: [
        'List of members who either:',
        '  • Became enrolled participants during the previous calendar month, OR',
        '  • Met Engaged Participant criteria for at least one day in that month',
        'For each member: User ID, Name, Email, Enrolled Date, Last Coaching Session, Employer',
        'Counts of total billable members, enrolled participants, engaged participants, and overlap (enrolled + engaged)'
      ],
      filters: [
        'Employer (Client) – affects on-page metrics, visible table, and CSV export'
      ],
      notes: [
        'Billing window = previous calendar month (e.g., running in October produces a report for September).',
        'Engaged Participant (for billing) = had a qualifying coaching session within the last 56 days relative to at least one day in the billing month.',
        'Table shows top 500 filtered rows; full result set is available via CSV export.',
        'Employer is taken from the custom attribute: Employer.'
      ]
    }
  ];

  const glossary = [
    {
      term: 'Coaching session',
      def: 'A closed conversation where the custom Channel attribute is one of: Phone, Video Conference, Email, or Chat.'
    },
    {
      term: 'Channel',
      def: 'The conversation-level value stored in custom_attributes.Channel (e.g., Phone, Video Conference, Email, Chat). Used to distinguish between call-based vs. written interactions.'
    },
    {
      term: 'Enrolled Date',
      def: 'Custom contact attribute Enrolled Date. Represents the date a member became an official program participant (accepted terms and conditions). Used as the participant start date across reports and engagement logic.'
    },
    {
      term: 'Employer (Client)',
      def: 'Custom contact attribute Employer. Represents the client / employer responsible for the member, and is the primary “client” dimension used across reports.'
    },
    {
      term: 'Engaged Participant',
      def: 'A member with a last qualifying coaching (Phone or Video Conference) session ≤28 days ago, or a newly-enrolled member (Enrolled Date ≤28 days ago) with no session yet. Some billing logic also treats “engaged” as having a session within the last 56 days relative to a day in the month.'
    },
    {
      term: 'At Risk Participant',
      def: 'A member whose last qualifying coaching (Phone or Video Conference) session was between 29 and 56 days ago.'
    },
    {
      term: 'Unengaged Participant',
      def: 'A member whose last qualifying coaching (Phone or Video Conference) session was >56 days ago, or (when engagement has never been set) a member whose first qualifying session occurs >28 days after Enrolled Date. Some reports also treat >28 days without any session after Enrolled Date as Unengaged for onboarding.'
    },
    {
      term: 'Assigned Coach',
      def: 'The coach associated with the conversation (or contact) who is responsible for that member’s coaching relationship.'
    },
    {
      term: 'Lookback window',
      def: 'A dynamic number of days prior to “today” used by some reports to bound which conversations or sessions are included (e.g., 365-day lookback for caseload data).'
    }
  ];

  // ---- Background jobs / API endpoints ----

// ---- Background jobs / API endpoints ----

type ApiEndpoint = {
  id: string;
  name: string;
  path: string;        // HTTP method + URL
  summary: string;
  schedule: string;    // how/when it’s typically run
  payload?: string;    // example JSON body (optional)
  notes?: string[];
};

const apiEndpoints: ApiEndpoint[] = [
  {
    id: 'session-sync',
    name: 'Session Sync',
    path: 'POST /API/engagement/session-sync',
    summary:
      'Indexes coaching sessions/calls from conversations and writes derived fields back to Intercom as custom attributes (e.g., last session date, first session date, etc.).',
    schedule:
      'Run on a schedule (cron/EventBridge). Typically: daily incremental runs; occasional longer lookback for backfills.',
    payload: `{"lookbackDays":100,"mode":"all","dryRun":false}`,
    notes: [
      'This endpoint updates Intercom custom attributes.',
      'Use a larger lookback for backfills; smaller lookbacks for daily increments.',
      'dryRun=true should produce logs/preview without writing updates.'
    ]
  },
  {
    id: 'engagement-sync',
    name: 'Engagement Sync',
    path: 'POST /API/engagement/engagement-sync',
    summary:
      'Computes engagement classification (Engaged / At Risk / Unengaged) based on business rules and writes results to Intercom contact custom attributes.',
    schedule:
      'Run on a schedule after Session Sync (cron/EventBridge). Usually daily.',
    payload: `{"dryRun":false,"enrolledLookbackDays":100}`,
    notes: [
      'This endpoint updates Intercom custom attributes.',
      'Typically depends on session-related attributes already being up to date (run after Session Sync).',
      'enrolledLookbackDays bounds how far back to consider newly/previously enrolled members.'
    ]
  },
  {
    id: 'referral-sync',
    name: 'Referral Sync',
    path: 'POST /API/engagement/referral-sync',
    summary:
      'Syncs referral-driven eligibility/program fields (maps Referral → Eligible Programs or other reporting/eligibility attributes) and writes them back to Intercom.',
    schedule:
      'Nightly or as needed after upstream member/referral loads. Safe to run repeatedly.',
    payload: `{"dryRun":false}`,
    notes: [
      'This endpoint updates Intercom custom attributes.',
      'Idempotent by design (re-running should not create duplicates).'
    ]
  },
  {
    id: 'report-engagement',
    name: 'Engagement Report Stream',
    path: 'POST /API/engagement/report/engagement',
    summary:
      'Generates an engagement reporting stream (report-facing dataset) used by dashboards/exports. This is reporting output, not Intercom attribute updates.',
    schedule:
      'Run on a schedule (monthly) or on-demand for validation. May run after Engagement Sync depending on your pipeline.',
    payload: `{"lookbackDays":365,"dryRun":false}`,
    notes: [
      'This endpoint produces a reporting data stream (or report dataset) rather than updating Intercom attributes.',
      'Use lookbackDays to control report window / recomputation scope.',
      'If you want parity with Intercom attributes, run after Engagement Sync.'
    ]
  }
];
</script>

<div class="container mx-auto max-w-6xl space-y-10 px-4 py-8">
  <!-- Header -->
  <header class="space-y-2">
    <h1 class="text-3xl font-semibold tracking-tight">
      Coaching Analytics Reports
    </h1>
    <p class="max-w-3xl text-sm text-muted-foreground">
      This home page documents the analytics reports built on top of the data and provides definitions
      for key terms used across dashboards. Use it as the single source of truth for how metrics are
      calculated and where to find them.
    </p>
  </header>

  <!-- Reports + Glossary -->
  <div class="grid gap-6 lg:grid-cols-3">
    <!-- LEFT: Reports -->
    <section class="space-y-4 lg:col-span-2">
      <div class="space-y-1">
        <h2 class="text-lg font-medium">Available Reports</h2>
        <p class="text-sm text-muted-foreground">
          Each report uses conversations and contact attributes, with standardized definitions for coaching sessions,
          engagement buckets, and participant status.
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
              <!-- Button supports href (renders <a>) -->
              <Button href={r.path} size="sm">
                Open report
              </Button>

              <span class="text-xs text-muted-foreground">{r.path}</span>
            </Card.Footer>
          </Card.Root>
        {/each}
      </div>
    </section>

    <!-- RIGHT: Glossary -->
    <aside class="space-y-4">
      <Card.Root class="lg:sticky lg:top-6">
        <Card.Header class="space-y-1">
          <Card.Title>Shared Definitions</Card.Title>
          <Card.Description>
            These terms are used consistently across all dashboards. Changes here should be reflected
            in code and documentation together.
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

  <!-- Background jobs / API endpoints -->
  <section class="space-y-4">
    <div class="space-y-1">
      <h2 class="text-lg font-medium">Background Jobs & API Endpoints</h2>
      <p class="text-sm text-muted-foreground">
        These backend endpoints keep data attributes in sync and support the reports above. They are
        typically triggered via cron/EventBridge or from the command line, not directly from the UI.
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
                <pre class="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
{e.payload}</pre>
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
