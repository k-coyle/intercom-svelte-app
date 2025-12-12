# intercom-svelte-app

A SvelteKit-based internal reporting app for analyzing Intercom engagement data, segment performance, conversation response times, and workflow activity.

This project is designed to help support, operations, and analytics teams explore Intercom conversations, segments, and custom attributes using a fast, interactive UI.

---

## ✨ Features

- 📊 **Engagement Reporting**
  - Message / conversation volume over time
  - Response time distributions (e.g. >24h, >48h)
  - Unreplied or overdue conversations

- 👥 **Segment & Workflow Insights**
  - Performance by Intercom segment or tag
  - Visibility into testing / QA workflows
  - Drill-down into specific cohorts

- 📈 **Coaching & Operations Dashboards**
  - Unique members with recent coaching sessions
  - Time-since-last-session buckets (e.g. <8 days, 8–28, 29–56, >56)
  - Channel-based filtering (Phone, Video Conference, Chat, etc.)

- ⚙️ **Configurable Data Sources**
  - Intercom API integration (planned / configurable)
  - CSV / NDJSON ingestion for offline or batch exports

---

## 🧱 Tech Stack

- **Framework:** SvelteKit  
- **Language:** TypeScript  
- **Build Tool:** Vite  
- **Runtime:** Node.js  
- **Testing:** Vitest (and Playwright if configured)  
- **Styling:** (Tailwind CSS / other – update as appropriate)

---

## 🚀 Getting Started

### 1. Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended)
- npm, pnpm, or yarn

Check versions:

```bash
node -v
npm -v
```
