# Engagement Dashboard API Contract

This document defines the backend contracts used by the `/engagement` dashboard UI.

## KPI Definitions

- `new_registrations_mtd` uses contact custom attribute `Registration Date`.
- `new_enrollees_mtd` uses contact custom attribute `Enrolled Date`.
- `qualifying_sessions_mtd` uses conversations where:
  - `Channel` is `Phone` or `Video Conference`
  - `Service Code` is one of:
    - `Health Coaching 001`
    - `Disease Management 002`
- Reporting timezone: `America/New_York`.
- Delta method: compare selected month elapsed days to the same elapsed day count in prior month.

## Overview Endpoint

- `GET /API/engagement/overview`
- Query params:
  - `monthYearLabel` (optional): `YYYY-MM`
    - If omitted, backend defaults to the current month in `America/New_York`.

### Response Shape

```json
{
	"monthYearLabel": "2026-02",
	"timeZone": "America/New_York",
	"window": {
		"monthStart": "2026-02-01T05:00:00.000Z",
		"monthEnd": "2026-03-01T05:00:00.000Z",
		"elapsedEnd": "2026-02-24T05:00:00.000Z",
		"elapsedDays": 24
	},
	"kpis": {
		"newRegistrationsMtd": {
			"count": 0,
			"priorCount": 0,
			"deltaCount": 0,
			"deltaPct": 0,
			"sparkline": [0, 0, 0]
		},
		"newEnrolleesMtd": {
			"count": 0,
			"priorCount": 0,
			"deltaCount": 0,
			"deltaPct": 0,
			"sparkline": [0, 0, 0]
		},
		"qualifyingSessionsMtd": {
			"count": 0,
			"priorCount": 0,
			"deltaCount": 0,
			"deltaPct": 0,
			"sparkline": [0, 0, 0]
		}
	}
}
```

## Async Job Pattern

Heavy report endpoints should follow the same lifecycle:

- `POST` with `op=create` -> returns `{ jobId, status, phase }`
- `POST` with `op=step` -> returns progress and advances work in bounded time
- `GET ?jobId=...` -> status payload
- `GET ?jobId=...&view=...` -> result views (`summary`, `rows`, etc.)
- `POST` with `op=cleanup` -> removes in-memory job state
- `POST` with `op=cancel` -> marks job cancelled

## New Participants Endpoint Modes

- Endpoint: `POST /API/engagement/new-participants`
- Async mode (new):
  - `op=create` with optional `lookbackDays`
  - `op=step` with `jobId`
  - `op=cancel` with `jobId`
  - `op=cleanup` with `jobId`
  - `GET /API/engagement/new-participants?jobId=...` for status
  - `GET ...&view=summary|participants|report` for result views
- Legacy mode (compatibility window):
  - `POST` with no `op` still returns the full report payload synchronously.

## Billing Month Selection

- Endpoint: `POST /API/engagement/billing` with `op=create`
- `monthYearLabel` is optional (`YYYY-MM`).
- If omitted, backend defaults to the current month in `America/New_York`.

## Compatibility Policy

- Legacy response modes remain active for one release cycle after async conversion.
- New UI consumes additive endpoints first, then legacy callers are migrated.
