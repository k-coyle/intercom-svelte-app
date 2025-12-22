# Intercom Engagement & Coaching Reports

A SvelteKit-based internal reporting app for analyzing Intercom data related to:

- Coaching caseload and participant engagement
- Session volumes by channel
- Enrolled participants with no/limited sessions
- Billing-eligible participants (new + engaged)

The app is intended for internal use by Support, Operations, Coaching, and RevOps teams. It uses Intercom’s REST API to read conversations, contacts, and custom attributes, and exposes a set of focused dashboards plus a small engagement microservice.

---

## High-Level Architecture

- Framework: SvelteKit + Vite
- Frontend: Svelte pages under `src/routes/intercom/*`
- Backend / API routes: SvelteKit `+server.ts` endpoints under `src/routes/API/intercom/*`
- Data source: Intercom REST API (`/contacts/search`, `/conversations/search`, `/contacts/{id}`)
- Auth / config: Intercom Personal Access Token + version via environment variables

Key routes:

- UI pages
  - `/intercom` – reports home & glossary
  - `/intercom/caseload` – caseload report
  - `/intercom/sessions` – sessions report
  - `/intercom/new-participants` – enrolled participants report
  - `/intercom/billing` – billing report

- API routes
  - `POST /API/intercom` – engagement sync job (updates Intercom contact attributes)
  - `POST /API/intercom/caseload` – caseload + session data
  - `POST /API/intercom/new-participants` – enrolled participants data
  - `POST /API/intercom/billing` – billing cohort data

Each report page calls its corresponding `/API/intercom/*` route, caches the raw results in memory in the browser, and then applies filters client-side.

---

## Intercom Data Model Assumptions

### Contact (people) attributes

The app assumes the following contact-level custom attributes exist in Intercom:

- `Registration Date` / `Enrolled Date`
  - Type: date (UNIX timestamp or date-type custom attribute)
  - Meaning: the day a member became an enrolled participant.
- `Employer`
  - Type: string
  - Meaning: client / employer; used as the primary “Client” dimension.
- `Last Coaching Call` or `Last Coaching Session`
  - Type: integer (UNIX timestamp, seconds)
  - Maintained by the engagement sync job.
- `Engagement Status`
  - Type: string
  - Values (recommended): `Engaged`, `At Risk`, `Unengaged`
  - Also maintained by the engagement sync job.

### Conversation attributes

The application expects the following conversation-level attribute:

**Channel** (custom conversation attribute)

- Type: string
- Values used by the app:
  - Phone
  - Video Conference
  - Email
  - Chat

Used to:

- Distinguish coaching sessions across different media
- Identify call-based sessions (Phone / Video) for engagement logic

Definition of a “coaching session” in this app:

> A closed Intercom conversation where the `Channel` attribute is one of:
> Phone, Video Conference, Email, or Chat.

---

## Reports Overview

All reports live under `/intercom` and share consistent terminology (defined in the Reports Home page glossary).

### 1. Caseload Report – `/intercom/caseload`

Purpose:

Show unique members with at least one coaching session in the lookback window, bucketed by time since last session, with breakdown by coach, client, and channel combinations.

Key buckets (per member):

- last session ≤ 7 days ago
- last session 8–28 days ago
- last session 29–56 days ago
- last session > 56 days ago

Filters:

- Assigned coach
- Employer (client)
- Channel combinations (e.g., Phone-only, Email+Chat, etc.)
- Lookback window in days (up to 365)

API: `POST /API/intercom/caseload`

Returns a `CaseloadReport` with:

- `summary` – counts per bucket
- `members[]` – one row per member with:
  - Member ID, name, email, client
  - Last session timestamp and days since last session
  - `channelsUsed[]` and `channelCombo`
  - Boolean flags per bucket

---

### 2. Sessions Report – `/intercom/sessions`

Purpose:

Show session-level (not unique members) counts over the same time windows, filterable by coach, client, channel, and date range.

Key metrics:

- Total coaching sessions in:
  - last session ≤ 7 days ago
  - last session 8–28 days ago
  - last session 29–56 days ago
  - last session > 56 days ago
  - arbitrary custom date range
- Channel breakdowns (Phone, Video, Email, Chat)

Filters:

- Assigned coach
- Employer (client)
- Channel
- Date range

API: `POST /API/intercom/caseload`

The caseload API already returns a `sessions[]` array, which this report reuses for session-level views.

---

### 3. Enrolled Participants Report – `/intercom/new-participants`

Purpose:

Track enrolled participants and categorize them by days without a coaching session, filterable by coach, client, and participant start date.

Definitions (for this report):

- Enrolled participant: contact with a valid `Registration Date` / `Enrolled Date` custom attribute.
- Days without session:
  - If has sessions: days since last session
  - If no sessions: days since participant start date

Exclusive buckets (per participant):

- 14–21 days without a session
- 22–28 days without a session
- >28 days without a session (Unengaged for this report)

Note: This “Unengaged” is local to this report and may be stricter than the global engagement status configured elsewhere (e.g., 28/56-day call-based rules).

Filters:

- Assigned coach
- Employer (client)
- Participant date range (based on `Registration Date` / `Enrolled Date`)
- Lookback window in days (used when querying Intercom)

API: `POST /API/intercom/new-participants`

Returns a `NewParticipantsReport` with one `ParticipantRow` per enrolled participant, including:

- Contact info, client, participant date
- Session metadata (has session, first/last session timestamps)
- Days since participant date, days without session
- Coach IDs/names and channels used
- Bucket flags

---

### 4. Billing Report – `/intercom/billing`

Purpose:

Identify billable members for the previous calendar month, and export them as CSV.

Billing cohort logic:

For the previous calendar month, a member is included if:

- They became a new participant that month, OR
- They met “Engaged Participant” criteria for at least one day in that month.

Engaged Participant (for billing) = had a qualifying coaching session (Phone or Video Conference) within the last 56 days relative to a day in the month.

Columns (per row):

- User ID
- Name
- Email
- Employer
- Registration Date
- Last Coaching Session date
- Flags:
  - `isNewParticipant` (registered in the billing month)
  - `engagedDuringMonth` (met engaged criteria during the month)

Filters:

- Employer (client) – affects both the on-page table and the CSV export

API: `POST /API/intercom/billing`

Returns a `BillingReport` with `rows[]` representing the final billing cohort. The UI shows the first 500 rows and allows CSV export of the filtered set.

---

## Engagement Sync Microservice

Route: `POST /API/intercom`

Purpose:

Periodically scan closed conversations for call channels and update each contact’s:

- `Last Coaching Call` (UNIX timestamp)
- `Engagement Status` (`Engaged`, `At Risk`, `Unengaged`)

Logic:

1. Read closed conversations where:
   - `state = closed`
   - `updated_at > now - lookbackDays`
2. Filter to conversations where `Channel` is one of:
   - Phone
   - Video Conference
3. For each contact:
   - Find the most recent qualifying call time
   - Compute `daysSinceLastCall`
   - Classify:
     - Engaged — last call ≤ 28 days ago
     - At Risk — 29–56 days ago
     - Unengaged — >56 days ago
   - Update the contact via `PUT /contacts/{id}`

Running manually (local dev):

```bash
curl -X POST http://localhost:5173/API/intercom   -H "Content-Type: application/json"   -d '{"lookbackDays": 365, "dryRun": true}'
```

- `dryRun: true` → logs what would be updated, but does not write to Intercom.
- `dryRun: false` → actually updates `Last Coaching Call` and `Engagement Status`.

In production, this endpoint is typically triggered via a scheduled job (e.g., AWS EventBridge / cron hitting an internal URL every 24 hours).

---

## Environment Configuration

Environment variables are consumed via `$env/static/private` in SvelteKit:

```ts
import {
  INTERCOM_ACCESS_TOKEN,
  INTERCOM_VERSION,
  INTERCOM_API_BASE
} from '$env/static/private';
```

Required:

- `INTERCOM_ACCESS_TOKEN`
  - Intercom Personal Access Token with scopes:
    - `contacts:read`
    - `contacts:write` (for engagement sync)
    - `conversations:read`
    - `data_attributes:read` (recommended)

Example:

```bash
INTERCOM_ACCESS_TOKEN=xxxxxxxxxxxxxxxx
```

Optional:

- `INTERCOM_VERSION`
  - Intercom API version header; defaults to `2.10` if not set.
  - Example:
    ```bash
    INTERCOM_VERSION=2.11
    ```
- `INTERCOM_API_BASE`
  - Override base URL for Intercom (for testing/proxying).
  - Default: `https://api.intercom.io`.

Local `.env` example:

```bash
INTERCOM_ACCESS_TOKEN=your_intercom_pat_here
INTERCOM_VERSION=2.11
INTERCOM_API_BASE=https://api.intercom.io
```

These environment variables must be available at build time (for SvelteKit’s `$env/static/private`), and also at runtime when using a Node adapter in production.

---

## Local Development

1. Prerequisites

- Node.js LTS (18+ or 20 LTS recommended)
- npm (or pnpm / yarn, but scripts assume npm)

Check versions:

```bash
node -v
npm -v
```

2. Install dependencies

From the project root:

```bash
npm install
```

3. Set environment variables

Create `.env` as shown above (or export vars in your shell).

4. Run the dev server

```bash
npm run dev
```

By default, SvelteKit runs on `http://localhost:5173`.

Open:

- `http://localhost:5173/intercom` – reports home
- `http://localhost:5173/intercom/caseload` – caseload report
- `http://localhost:5173/intercom/sessions` – sessions report
- `http://localhost:5173/intercom/new-participants` – enrolled participants report
- `http://localhost:5173/intercom/billing` – billing report

5. Run tests (optional)

```bash
npm test
# or
npm run test:unit
```

---

## Building for Production

```bash
npm run build
```

With the default `@sveltejs/adapter-auto`, SvelteKit will choose an adapter based on the deployment environment. For AWS (EC2, ECS, etc.) it’s usually best to use the Node adapter.

### Switching to Node adapter (recommended for AWS)

Install the adapter:

```bash
npm install -D @sveltejs/adapter-node
```

Update `svelte.config.js`:

```js
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter()
  }
};

export default config;
```

Build:

```bash
npm run build
```

Produces a Node server in `build/`. Run it locally with:

```bash
node build/index.js
```

---

## Deploying to AWS (Example: EC2 + Node Adapter)

There are many ways to deploy this app to AWS. Here’s a simple EC2-based pattern:

1. Create an EC2 instance
   - OS: Amazon Linux 2 or Ubuntu LTS
   - Security group:
     - Allow inbound HTTP/HTTPS from your office/VPN or load balancer
   - SSH into the instance.

2. Install Node & Git (Ubuntu example):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

3. Clone the repo and build:

```bash
git clone <your-github-repo-url> intercom-engagement-job
cd intercom-engagement-job

npm install
npm run build
```

4. Configure environment variables

You can set env vars in:

- A shell script that wraps `node build/index.js`, or
- A systemd unit file.

Example systemd unit (`/etc/systemd/system/intercom-reports.service`):

```ini
[Unit]
Description=Intercom Engagement & Coaching Reports
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/intercom-engagement-job
Environment=INTERCOM_ACCESS_TOKEN=your_pat_here
Environment=INTERCOM_VERSION=2.11
Environment=INTERCOM_API_BASE=https://api.intercom.io
ExecStart=/usr/bin/node build/index.js
Restart=on-failure
User=ubuntu

[Install]
WantedBy=multi-user.target
```

Reload and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable intercom-reports
sudo systemctl start intercom-reports
sudo systemctl status intercom-reports
```

By default, the app will listen on the port configured by SvelteKit (often `3000` or `4173` for prod). You can put this behind:

- An Application Load Balancer
- An Nginx reverse proxy
- Or expose it directly (internal-only) via security groups/VPC.

5. Scheduling the engagement sync (optional)

To run the engagement job daily on AWS:

If the app is reachable at `http://your-host/API/intercom` inside your VPC, you can:

- Use `cron` on the EC2 instance, or
- Use AWS EventBridge + Lambda to `POST` to that internal URL.

Example crontab entry (runs at 2 AM server time):

```bash
0 2 * * * curl -X POST http://localhost:3000/API/intercom   -H "Content-Type: application/json"   -d '{"lookbackDays": 365, "dryRun": false}' >> /var/log/intercom-engagement-cron.log 2>&1
```

---

## Security Notes

- This app has no built-in authentication – it assumes it lives on an internal network or behind your SSO / VPN.
- Protect the host and route access via:
  - VPC and Security Groups
  - A reverse proxy with auth (e.g., ALB + Cognito, Nginx behind SSO)
- Treat `INTERCOM_ACCESS_TOKEN` as highly sensitive; give it the minimum scopes required.

---

## Customization

Adjust bucket thresholds, channels, and engaged/at-risk logic in:

- `src/routes/API/intercom/+server.ts` (engagement job)
- `src/routes/API/intercom/caseload/+server.ts`
- `src/routes/API/intercom/new-participants/+server.ts`
- `src/routes/API/intercom/billing/+server.ts`

Update user-facing definitions and glossary in:

- `src/routes/intercom/+page.svelte`

Whenever you change business logic (e.g., engagement windows, channel definitions), update both:

1. The backend logic in `+server.ts`, and
2. The documentation and glossary in the Reports Home page and this README.
