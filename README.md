# Coaching Analytics & Engagement Services (Intercom)

This repository contains a small SvelteKit + Node service that reads data from Intercom and exposes:

- A set of **coaching analytics reports** (Caseload, Sessions, Enrolled Participants, Billing).
- A collection of **microservices / jobs** that keep key contact attributes in sync:
  - Last Coaching Session
  - First Session Date
  - Last Call
  - Engagement Status & Engagement Status Date
  - Eligible Programs (based on Referral)
- A **CSV export endpoint** that produces a member-level engagement extract for downstream BI tools.

The system is designed to be:

- **Read-heavy**, using Intercom’s `/conversations/search` and `/contacts/search` APIs.
- **Write-light**, updating only a small set of contact custom attributes.
- **Configurable**, with lookback windows and filters controlled via JSON inputs.

---

## 1. Core Intercom Attributes

### 1.1 Conversation attributes

The following conversation-level attributes are expected to exist in Intercom:

#### `Channel` (custom conversation attribute)

- **Type**: string  
- **Values used by the app**:
  - `Phone`
  - `Video Conference`
  - `Email`
  - `Chat`
- **Used to**:
  - Distinguish coaching sessions across different media.
  - Identify **call-based sessions** (Phone / Video) for engagement and “Last Call” logic.
  - Identify written channels (Email / Chat) for caseload & sessions reporting.

#### `Service Code` (custom conversation attribute)

- **Type**: string  
- **Values used by engagement logic**:
  - `Health Coaching 001`
  - `Disease Management 002`
- **Used to**:
  - Restrict “qualifying coaching calls” to specific clinical programs.
  - Exclude non‑program conversations (e.g., tech support, general questions).

> **Qualifying coaching call** (for engagement):  
> A conversation where:
> - `custom_attributes.Channel` ∈ {`Phone`, `Video Conference`}  
> - `custom_attributes.Service Code` ∈ {`Health Coaching 001`, `Disease Management 002`}  
> - `state = closed`

### 1.2 Contact attributes

The following **contact-level custom attributes** are either consumed or maintained by this service:

1. **Enrolled Date** (Date)
   - Date the member becomes formally enrolled in the program.
   - Source: client enrollment file → SFTP → Django → Census → Intercom.
   - Used for:
     - Determining “newly enrolled” participants.
     - Engagement logic when no sessions have occurred yet.

2. **Registration Date** (Date)
   - Date the member registers for the USPM app.
   - Source: application webhook.
   - **Note**: Most reports now use **Enrolled Date**; Registration may still be present for legacy use.

3. **Next Coaching Session** (Date)
   - Date of the member’s **next scheduled** session.
   - Source: OnceHub integration.
   - Not directly mutated by this service; read-only for potential future analytics.

4. **Last Coaching Session** (Date / Unix seconds)
   - Date/time of the member’s **most recent qualifying coaching call**:
     - Channel ∈ {Phone, Video Conference}
     - Service Code ∈ {Health Coaching 001, Disease Management 002}
     - Conversation state = `closed`
   - **Maintained by** the Session Indexer v2 job.

5. **Last Call** (Date / Unix seconds)
   - Date/time of the **most recent phone call** to the member:
     - Channel = `Phone`
     - Conversation state can be **open or closed**.
   - **Maintained by** the Session Indexer v2 job, using:
     - `last_close_at` when closed
     - `created_at` when not yet closed

6. **First Session Date** (Date / Unix seconds)
   - Date of the first **qualifying coaching session** (same criteria as Last Coaching Session).
   - **Maintained by** the Session Indexer v2 job for any contact that:
     - Has an Enrolled Date or Registration Date, and
     - Does not yet have a First Session Date populated.

7. **Engagement Status** (List: `Engaged` / `At Risk` / `Unengaged`)
   - Current program engagement flag.
   - **Maintained by** Engagement Classifier v2.

8. **Engagement Status Date** (Date / Unix seconds)
   - The date/time when the **Engagement Status** attribute last changed.
   - **Maintained by** Engagement Classifier v2.

9. **Referral** (string)
   - Indicates referral source (e.g., `Counter Health`).
   - Used by the Referral → Eligible Programs microservice.

10. **Eligible Programs** (string / list)
    - A description of which programs a member is currently eligible for.
    - **Maintained by** the Referral → Eligible Programs microservice (e.g., set to `Smart Access` when `Referral = Counter Health`).

11. **Employer** (string)
    - Client/employer responsible for the member.
    - Used across all reporting endpoints as the primary **client filter/dimension**.

12. **User ID / Registration Code / Date of Birth**
    - Used primarily for the CSV export service (see §4.3).

---

## 2. Engagement Logic (BI Definition)

### 2.1 Qualifying coaching call

For **Engagement Status**, we only consider **qualifying coaching calls**:

- Conversation `state = closed`
- `custom_attributes.Channel` ∈ {`Phone`, `Video Conference`}
- `custom_attributes.Service Code` ∈ {`Health Coaching 001`, `Disease Management 002`}

These calls feed into **Last Coaching Session**, **First Session Date**, and the engagement classifier.

### 2.2 Status buckets

Given a member’s **Last Coaching Session** (if present) and **Enrolled Date**, we compute:

- **Engaged**
  - Last qualifying coaching call **≤ 28 days ago**, OR
  - Member **enrolled within the last 28 days** and has **not yet had a qualifying session**.

- **At Risk**
  - Last qualifying coaching call is **29–56 days ago**.

- **Unengaged**
  - Last qualifying coaching call is **> 56 days ago**, OR
  - The **first qualifying coaching call** did **not occur within 28 days** of Enrolled Date, **and** the member never satisfied an Engaged status window **after** that initial delay.

#### Important edge cases

- If a member **does not have an Enrolled Date**, we **do not** update Engagement Status.
- Once a member **has remedied** an earlier Unengaged period with a new qualifying session, we do **not** re-apply the “first call > 28 days after Enrolled Date” path to Unengaged again.
  - The microservice is **authoritative** for contacts with Enrolled Date, but it respects improvements driven by recent sessions.
- Engagement Status and Engagement Status Date are only updated when the **status actually changes**.

---

## 3. Reports & UI

All UI pages live under `/intercom/*` and talk to `/API/intercom/*` endpoints.

### 3.1 Caseload Report – `/intercom/caseload`

**Backend:** `POST /API/intercom/caseload`  
**Purpose:** Show **unique members** with at least one coaching session in the lookback window, bucketed by **time since last session** and **channel combination**.

#### Coaching session (for caseload / sessions)

For these reports, a **coaching session** is:

- A **closed** Intercom conversation where:
  - `Channel` ∈ {`Phone`, `Video Conference`, `Email`, `Chat`}

> Note: this is broader than the **qualifying coaching call** definition used for Engagement Status.

#### Buckets (per member)

Buckets are based on **daysSinceLastSession**:

- `bucket_1`: ≤ 7 days
- `bucket_2`: 8–28 days
- `bucket_3`: 29–56 days
- `bucket_4`: > 56 days

#### Filters (UI)

- Assigned coach
- Employer (client)
- Channel / session type (Phone, Video, Email, Chat)
- Lookback window (days; capped at 365)

#### Output (API)

`CaseloadReport`:

- `summary.bucket_*` – count of members in each bucket (all members, unfiltered)
- `members[]` – one row per member:
  - Member ID, name, email, client
  - Coach IDs & names
  - Channels used & channel combination
  - Last session time & days since
  - Bucket flags
- `sessions[]` – session-level detail (used by Sessions UI)

### 3.2 Sessions Report – `/intercom/sessions`

**Backend:** **reuses** `POST /API/intercom/caseload` and consumes the `sessions[]` array.

**Purpose:** Show **session-level counts**, not unique members, across configurable windows.

#### Metrics (UI)

- Sessions ≤ 7 days ago
- Sessions 8–28 days ago
- Sessions 29–56 days ago
- Sessions in a **custom date range**

#### Filters

- Assigned coach
- Employer (client)
- Channel (Phone, Video, Email, Chat)
- Lookback window (days; capped at 365)
- Custom date range (applied as a real filter in the UI)

### 3.3 Enrolled Participants Report – `/intercom/new-participants`

**Backend:** `POST /API/intercom/new-participants`  
**Purpose:** Focus on **enrolled participants** and bucket them by **days without a coaching session**.

#### Participant definition

- A contact with a valid **Enrolled Date** (custom attribute).
- The backend currently filters for contacts whose Enrolled / Registration date falls within the lookback window.

#### Days without session

For each enrolled participant:

- If the member **has sessions**:
  - `daysWithoutSession = days since last coaching session`.
- If the member **has no sessions**:
  - `daysWithoutSession = days since Enrolled Date`.

#### Buckets (exclusive)

- `gt_14_to_21`: 14–21 days without a session
- `gt_21_to_28`: 22–28 days without a session
- `gt_28`: > 28 days without a session (considered **Unengaged for this report only**)

> This “Unengaged” concept is **local to this report** and does **not** overwrite the global Engagement Status attribute.

#### Filters & features

- Assigned coach
- Employer (client)
- **Participant date range** (based on Enrolled Date)
- Lookback window (days; capped at 365)
- CSV export of filtered participants from the UI

### 3.4 Billing Report – `/intercom/billing`

**Backend:** `POST /API/intercom/billing`  
**Purpose:** Identify **billable members** for a given calendar month and expose them as an exportable list.

#### Billing cohort logic

For a given month (`monthYearLabel` = `YYYY-MM`):

A member is included if:

1. They became a **new participant** during that month (based on **Enrolled Date**), **OR**
2. They met **Engaged Participant** criteria on at least one day that month:

   - For billing, “engaged” is defined as having a **call-based coaching session** (Channel ∈ {Phone, Video}) within **56 days** of that day.

The backend:

- Computes the month window in **America/New_York**.
- Pulls conversations in a tail window (month start minus 56 days through month end).
- Filters by Channel and state (closed).
- Computes `lastSessionAt` per member and identifies:
  - **New participants** (Enrolled Date within that month)
  - **Engaged during the month** (had a qualifying call within the 56‑day window overlapping the month)

#### Output columns (per row)

- `memberId` (User ID)
- `memberName`
- `memberEmail`
- `employer`
- `registrationAt` (now effectively **Enrolled Date**)
- `lastSessionAt`
- `isNewParticipant`
- `engagedDuringMonth`

#### Filters

- Employer (client) – used for on-page view and CSV export.

---

## 4. Microservices & Helper Endpoints

### 4.1 Session Indexer v2

**Endpoint (example):** `POST /API/intercom/session-sync`  

**Purpose:**

- Scan Intercom conversations over a lookback window.
- Maintain:
  - `Last Coaching Session` (qualifying calls with Service Code filter)
  - `First Session Date` (for newly enrolled members)
  - `Last Call` (latest phone call, open or closed conversation)

**Inputs (JSON):**

```json
{
  "lookbackDays": 365,
  "dryRun": true
}
```

- `lookbackDays` (optional, default in code): days back from “now” to scan conversations.
- `dryRun` (boolean): if `true`, logs would-be updates but does **not** write to Intercom.

**Key behaviors & edge cases:**

- Only **closed** conversations with:
  - Channel ∈ {Phone, Video Conference}
  - Service Code ∈ {Health Coaching 001, Disease Management 002}
  are considered **qualifying coaching calls**.
- For **Last Call**:
  - Channel = `Phone`
  - Uses `last_close_at` if closed, otherwise `created_at`.
- **First Session Date** is only populated if:
  - The contact has Enrolled Date / Registration Date, and
  - First Session Date is currently empty.
- The job is designed for one **large backfill**, then smaller incremental runs.

### 4.2 Engagement Classifier v2

**Endpoint (example):** `POST /API/intercom/engagement-sync`  

**Purpose:**

- Read enrollment / session attributes and maintain:
  - `Engagement Status`
  - `Engagement Status Date`

**Inputs (JSON):**

```json
{
  "lookbackDays": 365,
  "dryRun": true
}
```

**Core logic:**

1. **Skip** any contact without an **Enrolled Date**.
2. Use **Last Coaching Session**, **First Session Date**, and **Enrolled Date** to classify as:
   - Engaged
   - At Risk
   - Unengaged  
   (see §2.2)
3. If the newly computed status differs from the existing value:
   - Update `Engagement Status`.
   - Set `Engagement Status Date` to the current timestamp.
4. If a member has ever been **Unengaged** due to **first call > 28 days after Enrolled Date**, but later remedies this with a recent qualifying call, we **do not** re‑apply that path to Unengaged again.

### 4.3 Referral → Eligible Programs Microservice

**Endpoint (example):** `POST /API/intercom/referral-sync`  

**Purpose:**

- Ensure that program eligibility attributes reflect referral rules.

**Current rule:**

- If `Referral = "Counter Health"`, then set:
  - `Eligible Programs = "Smart Access"`.

The service can be extended to support additional referral-to-program mappings in the future.

### 4.4 Engagement CSV Export Service

**Endpoint:** `POST /API/intercom/report/engagement`  

**Purpose:**

- Create a **CSV file** on disk that contains a member-level engagement snapshot suitable for downstream BI pipelines.

**Body (JSON):**

```json
{
  "outputPath": "/absolute/or/relative/path/to/engagement_report.csv",
  "referral": "Counter Health",
  "employer": "Acme Corp",
  "enrolledDateFrom": "2025-01-01",
  "enrolledDateTo": "2025-12-31",
  "lastSessionFrom": "2025-03-01",
  "lastSessionTo": "2025-03-31",
  "engagementStatus": "Engaged",
  "perPage": 150
}
```

All filters are optional; when present, they are pushed down into Intercom queries where possible.

**CSV columns (example mapping):**

`<CSV column name> | <Intercom user attribute> | <Description>`

- `employee_id` | `User ID` | Member’s unique ID in client system.
- `name_first` | `Name` | Member’s first name (without middle).
- `name_last` | `Name` | Member’s last name.
- `member_dob` | `Date of Birth` | ISO 8601 date of birth.
- `group_description` | `Employer` | Employer / group name.
- `last_coaching_session` | `Last Coaching Session` | ISO 8601 date of last qualifying coaching session.
- `program_status` | `Engagement Status` | Current engagement status.
- `status_date` | `Engagement Status Date` | ISO 8601 date when status was set.
- `eligible_programs` | `Eligible Programs` | Program eligibility string.
- `registration_code` | `Registration Code` | Registration code in USPM platform.

---

## 5. Environment Configuration

Environment variables are loaded via SvelteKit’s `$env/static/private`:

```ts
import {
  INTERCOM_ACCESS_TOKEN,
  INTERCOM_VERSION,
  INTERCOM_API_BASE
} from '$env/static/private';
```

### Required

- **`INTERCOM_ACCESS_TOKEN`**
  - Intercom PAT with scopes:
    - `contacts:read`
    - `contacts:write` (for engagement & helper syncs)
    - `conversations:read`
    - `data_attributes:read` (recommended)
  - Example:
    ```bash
    INTERCOM_ACCESS_TOKEN=xxxxxxxxxxxxxxxx
    ```

### Optional

- **`INTERCOM_VERSION`**
  - Intercom API version header; defaults to `2.10` if not set.
  - Example:
    ```bash
    INTERCOM_VERSION=2.11
    ```

- **`INTERCOM_API_BASE`**
  - Override base URL for Intercom (e.g., for proxying).
  - Default: `https://api.intercom.io`.

### Local `.env` example

Create a `.env` file in the project root:

```bash
INTERCOM_ACCESS_TOKEN=your_intercom_pat_here
INTERCOM_VERSION=2.11
INTERCOM_API_BASE=https://api.intercom.io
```

> ⚠️ These env vars must be available at **build time** (for `$env/static/private`) and at **runtime** when using a Node adapter.

---

## 6. Local Development

### 6.1 Prerequisites

- Node.js LTS (18+ or 20 LTS recommended)
- npm (or pnpm / yarn; examples assume npm)

Check versions:

```bash
node -v
npm -v
```

### 6.2 Install dependencies

From the project root:

```bash
npm install
```

### 6.3 Set environment variables

Create `.env` as shown above (or export env vars in your shell).

### 6.4 Run the dev server

```bash
npm run dev
```

By default, SvelteKit serves on `http://localhost:5173`.

Useful routes:

- `http://localhost:5173/intercom` – Reports home
- `http://localhost:5173/intercom/caseload` – Caseload report
- `http://localhost:5173/intercom/sessions` – Sessions report
- `http://localhost:5173/intercom/new-participants` – Enrolled participants report
- `http://localhost:5173/intercom/billing` – Billing report

### 6.5 Run tests (if available)

```bash
npm test
# or
npm run test:unit
```

---

## 7. Building for Production

```bash
npm run build
```

With the default `@sveltejs/adapter-auto`, SvelteKit will try to infer the target. For AWS or other Node environments, it is recommended to use the **Node adapter**.

### 7.1 Switching to Node adapter

Install:

```bash
npm install -D @sveltejs/adapter-node
```

Update `svelte.config.js`:

```ts
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

This produces a Node server in `build/`. Run locally with:

```bash
node build/index.js
```

---

## 8. Deploying to AWS (Example: EC2 + Node Adapter)

There are many ways to deploy this app. A simple pattern:

### 8.1 Create an EC2 instance

- OS: Amazon Linux 2 or Ubuntu LTS.
- Security Group:
  - Allow inbound HTTP/HTTPS from office/VPN or load balancer.
- SSH into the instance.

### 8.2 Install Node & Git (Ubuntu example)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

### 8.3 Clone the repo and build

```bash
git clone <your-github-repo-url> intercom-engagement-job
cd intercom-engagement-job

npm install
npm run build
```

### 8.4 Configure environment & systemd

Create a systemd unit, e.g. `/etc/systemd/system/intercom-reports.service`:

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

Expose the app:

- Directly (internal-only) via Security Groups/VPC, or
- Behind an Application Load Balancer or Nginx reverse proxy.

### 8.5 Scheduling jobs (optional)

For example, to run the **engagement classifier** daily at 2 AM on the EC2 instance:

```bash
crontab -e
```

Add:

```bash
0 2 * * * curl -X POST http://localhost:3000/API/intercom/engagement-sync   -H "Content-Type: application/json"   -d '{"lookbackDays": 365, "dryRun": false}' >> /var/log/intercom-engagement-cron.log 2>&1
```

You can follow a similar pattern for:

- `session-sync` backfill / maintenance jobs
- `referral-sync` runs
- `report/engagement` exports (if you want scheduled CSV generation)

---

## 9. Security Notes

- This app does **not** ship with built-in authentication/authorization.
- It is intended to run:
  - On an internal network, or
  - Behind your existing SSO / VPN / reverse proxy.

Recommendations:

- Restrict access at the network layer (VPC, Security Groups).
- Consider ALB + Cognito, or Nginx behind your SSO, for user-level auth.
- Treat `INTERCOM_ACCESS_TOKEN` as highly sensitive:
  - Limit scopes to the minimum necessary.
  - Rotate tokens per your security policy.

---

## 10. Customization

You can adjust business rules in the following files:

- **Engagement / sessions logic**
  - `src/routes/API/intercom/session-sync/+server.ts`
  - `src/routes/API/intercom/engagement-sync/+server.ts`
- **Referral rules**
  - `src/routes/API/intercom/referral-sync/+server.ts`
- **CSV export**
  - `src/routes/API/intercom/report/engagement/+server.ts`
- **Reports**
  - `src/routes/API/intercom/caseload/+server.ts`
  - `src/routes/API/intercom/new-participants/+server.ts`
  - `src/routes/API/intercom/billing/+server.ts`

And keep documentation aligned in:

- `src/routes/intercom/+page.svelte` (Reports home & glossary)
- This `README.md`

Whenever you change:

- Engagement windows
- Service Code and Channel definitions
- Bucket thresholds
- Eligibility rules

Update **both**:

1. The backend logic (`+server.ts` files), and  
2. The user-facing documentation (Reports home + README).

This keeps BI stakeholders, coaching teams, and engineering all aligned on a single source of truth.
