<script lang="ts">
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
      path: '/intercom/caseload',
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
        'A “coaching session” is any closed Intercom conversation where Channel ∈ {Phone, Video Conference, Email, Chat}.'
      ]
    },
    {
      id: 'sessions',
      name: 'Sessions Report',
      path: '/intercom/sessions',
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
      path: '/intercom/new-participants',
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
      path: '/intercom/billing',
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
      def: 'A closed Intercom conversation where the custom Channel attribute is one of: Phone, Video Conference, Email, or Chat.'
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
      def: 'The Intercom teammate associated with the conversation (or contact) who is responsible for that member’s coaching relationship.'
    },
    {
      term: 'Lookback window',
      def: 'A dynamic number of days prior to “today” used by some reports to bound which conversations or sessions are included (e.g., 365-day lookback for caseload data).'
    }
  ];

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
      id: 'session-index-v2',
      name: 'Session Indexer v2',
      path: 'POST /API/intercom/report/session-index',
      summary:
        'Scans qualifying conversations and updates Last Coaching Session, First Session Date, and Last Call for enrolled members.',
      schedule:
        'Daily via cron/EventBridge. Run once with a large lookback for backfill, then with smaller windows (e.g., 7–30 days).',
      notes: [
        'Qualifying coaching sessions: closed conversations where Channel ∈ {Phone, Video Conference} and Service Code ∈ {"Health Coaching 001", "Disease Management 002"}.',
        'Also updates Last Call for any Phone conversations, regardless of close state.',
        'Respects lookbackDays in the request body for incremental runs.'
      ]
    },
    {
      id: 'engagement-classifier-v2',
      name: 'Engagement Classifier v2',
      path: 'POST /API/intercom/report/engagement',
      summary:
        'Reads Enrolled Date, First Session Date, and Last Coaching Session to compute Engagement Status and Engagement Status Date for enrolled members.',
      schedule:
        'Daily, after Session Indexer v2 completes, using a similar lookback window.',
      payload: `{"lookbackDays": 365, "dryRun": false}`,
      notes: [
        'Engaged: last qualifying session ≤28 days ago OR Enrolled Date ≤28 days ago with no session yet.',
        'At Risk: last qualifying session 29–56 days ago.',
        'Unengaged: last qualifying session >56 days ago OR (when Engagement Status has never been set) first qualifying session occurs >28 days after Enrolled Date.',
        'Only considers qualifying sessions (Phone/Video + Service Code = 001 or 002).'
      ]
    },
    {
      id: 'referral-eligible-programs',
      name: 'Referral → Eligible Programs Sync',
      path: 'POST /API/intercom/report/referral-sync',
      summary:
        'For members with Referral = "Counter Health", sets Eligible Programs = "Smart Access".',
      schedule:
        'Run nightly or as needed after new members are loaded from upstream systems.',
      notes: [
        'Idempotent: safe to run repeatedly.',
        'Can be extended to map additional Referral values to Eligible Programs.'
      ]
    },
    {
      id: 'export-members-csv',
      name: 'Member Export CSV',
      path: 'POST /API/intercom/export-members-csv',
      summary:
        'Exports a CSV of enrolled members and key attributes for ad-hoc analysis or downstream BI.',
      schedule:
        'On-demand from the command line (curl) or a one-off job. Not wired to the UI.',
      payload: `{
  "outputPath": "/path/to/engagement_report.csv",
  "referral": "Counter Health",
  "employer": "ACME Corp",
  "enrolledStart": "2024-01-01",
  "enrolledEnd": "2024-12-31",
  "lastSessionStart": "2024-06-01",
  "lastSessionEnd": "2024-06-30",
  "engagementStatus": "Unengaged",
  "perPage": 150
}`,
      notes: [
        'Filters (Referral, Employer, Enrolled Date window, Last Session Date window, Engagement Status) are pushed into Intercom search where possible to keep exports fast.',
        'CSV columns follow the external spec: employee_id, name_first, name_last, member_dob, group_description, last_coaching_session, program_status, status_date, eligible_programs, registration_code.'
      ]
    }
  ];
</script>

<style>
  .page {
    padding: 1.5rem;
    max-width: 1100px;
    margin: 0 auto;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  h1 {
    font-size: 1.8rem;
    margin-bottom: 0.5rem;
  }

  .intro {
    color: #555;
    font-size: 0.95rem;
    margin-bottom: 1.5rem;
  }

  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.9fr);
    gap: 1.5rem;
    align-items: flex-start;
  }

  .reports {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .card {
    border-radius: 0.75rem;
    border: 1px solid #ddd;
    padding: 0.9rem 1rem;
    background: #fafafa;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.25rem;
  }

  .card-title {
    font-weight: 600;
    font-size: 1rem;
  }

  .chip {
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    background: #eef3ff;
    color: #25326b;
    white-space: nowrap;
  }

  .card-summary {
    font-size: 0.88rem;
    color: #555;
    margin-bottom: 0.35rem;
  }

  .label {
    font-size: 0.78rem;
    font-weight: 600;
    margin-top: 0.25rem;
    margin-bottom: 0.1rem;
    color: #444;
  }

  ul {
    margin: 0;
    padding-left: 1.2rem;
  }

  li {
    font-size: 0.82rem;
    color: #444;
    margin-bottom: 0.1rem;
  }

  .card-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.5rem;
    gap: 0.5rem;
  }

  .open-link {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.35rem 0.7rem;
    border-radius: 999px;
    border: 1px solid #0077cc;
    background: #0077cc;
    color: white;
    font-size: 0.8rem;
    text-decoration: none;
  }

  .open-link:hover {
    background: #005fa3;
  }

  .path {
    font-size: 0.75rem;
    color: #777;
  }

  .glossary {
    border-radius: 0.75rem;
    border: 1px solid #ddd;
    padding: 0.9rem 1rem;
    background: #fbfbfb;
  }

  .glossary h2 {
    font-size: 1rem;
    margin-bottom: 0.5rem;
  }

  .glossary-item {
    margin-bottom: 0.5rem;
  }

  .glossary-term {
    font-weight: 600;
    font-size: 0.85rem;
  }

  .glossary-def {
    font-size: 0.8rem;
    color: #444;
  }

  .section-title {
    font-size: 1.05rem;
    font-weight: 600;
    margin-bottom: 0.4rem;
  }

  .section-subtitle {
    font-size: 0.8rem;
    color: #666;
    margin-bottom: 0.6rem;
  }

  .api-section {
    margin-top: 2rem;
  }

  .code-block {
    margin-top: 0.25rem;
    padding: 0.4rem 0.5rem;
    border-radius: 0.4rem;
    border: 1px solid #ddd;
    background: #f3f3f3;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
      'Courier New', monospace;
    font-size: 0.75rem;
    white-space: pre-wrap;
  }

  @media (max-width: 900px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>

<div class="page">
  <h1>Coaching Analytics Reports</h1>
  <p class="intro">
    This home page documents the analytics reports built on top of Intercom data and provides
    definitions for key terms used across dashboards. Use it as the single source of truth for how
    metrics are calculated and where to find them.
  </p>

  <div class="grid">
    <!-- LEFT: Reports catalog -->
    <div>
      <div class="section-title">Available Reports</div>
      <div class="section-subtitle">
        Each report uses Intercom conversations and contact attributes, with standardized definitions
        for coaching sessions, engagement buckets, and participant status.
      </div>

      <div class="reports">
        {#each reports as r}
          <div class="card" id={r.id}>
            <div class="card-header">
              <div class="card-title">{r.name}</div>
              <div class="chip">{r.primaryAudience}</div>
            </div>

            <div class="card-summary">
              {r.summary}
            </div>

            <div class="label">Key metrics</div>
            <ul>
              {#each r.metrics as m}
                <li>{m}</li>
              {/each}
            </ul>

            <div class="label">Filters</div>
            <ul>
              {#each r.filters as f}
                <li>{f}</li>
              {/each}
            </ul>

            {#if r.notes && r.notes.length}
              <div class="label">Important notes</div>
              <ul>
                {#each r.notes as note}
                  <li>{note}</li>
                {/each}
              </ul>
            {/if}

            <div class="card-footer">
              <a class="open-link" href={r.path}>
                Open report
              </a>
              <span class="path">{r.path}</span>
            </div>
          </div>
        {/each}
      </div>
    </div>

    <!-- RIGHT: Glossary / shared definitions -->
    <aside class="glossary">
      <h2>Shared Definitions</h2>
      <p class="section-subtitle">
        These terms are used consistently across all dashboards. Changes here should be reflected in
        code and documentation together.
      </p>

      {#each glossary as g}
        <div class="glossary-item">
          <div class="glossary-term">{g.term}</div>
          <div class="glossary-def">{g.def}</div>
        </div>
      {/each}
    </aside>
  </div>

  <!-- New: Background jobs / API endpoints -->
  <div class="api-section">
    <div class="section-title">Background Jobs & API Endpoints</div>
    <div class="section-subtitle">
      These backend endpoints keep Intercom attributes in sync and support the reports above. They are
      typically triggered via cron/EventBridge or from the command line, not directly from the UI.
    </div>

    <div class="reports">
      {#each apiEndpoints as e}
        <div class="card" id={e.id}>
          <div class="card-header">
            <div class="card-title">{e.name}</div>
            <div class="chip">{e.path}</div>
          </div>

          <div class="card-summary">
            {e.summary}
          </div>

          <div class="label">Typical schedule</div>
          <ul>
            <li>{e.schedule}</li>
          </ul>

          {#if e.payload}
            <div class="label">Example payload</div>
            <pre class="code-block">{e.payload}</pre>
          {/if}

          {#if e.notes && e.notes.length}
            <div class="label">Notes</div>
            <ul>
              {#each e.notes as note}
                <li>{note}</li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>
