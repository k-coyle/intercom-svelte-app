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

  // ---- Background jobs / API endpoints ----

  type ApiEndpoint = {
    id: string;
    name: string;
    path: string; // HTTP method + URL
    summary: string;
    schedule: string; // how/when it is typically run
    payload?: string; // example JSON body (optional)
    notes?: string[];
  };

  const apiEndpoints: ApiEndpoint[] = [
    {
      id: 'session-sync-v2',
      name: 'Session Sync',
      path: 'POST /API/engagement/session-sync',
      summary:
        'Scans qualifying conversations and updates Last Coaching Session, First Session Date, and Last Call for enrolled members.',
      schedule:
        'Typically daily via scheduler (run first, before engagement-sync).',
      payload: `{"lookbackDays": 30, "dryRun": true, "mode": "all"}`,
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
      schedule:
        'Typically daily, after session-sync.',
      payload: `{"dryRun": true, "enrolledLookbackDays": 365}`,
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
      schedule:
        'Run nightly or as needed after new members are loaded from upstream systems.',
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
      schedule:
        'On demand from scripts or ad hoc operations.',
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
    This home page documents the analytics reports built on top of the data and provides
    definitions for key terms used across dashboards. Use it as the single source of truth for how
    metrics are calculated and where to find them.
  </p>

  <div class="grid">
    <!-- LEFT: Reports catalog -->
    <div>
      <div class="section-title">Available Reports</div>
      <div class="section-subtitle">
        Each report uses conversations and contact attributes, with report-local notes where logic
        differs between dashboards.
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
        Terms below are precise to current implementation. Where behavior differs by job/report,
        that scope is called out in the definition.
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
      These endpoints support recurring sync jobs and ad hoc exports. Some run on schedules;
      others are invoked on demand.
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
