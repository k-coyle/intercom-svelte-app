import type { RequestHandler } from '@sveltejs/kit';
import {
  INTERCOM_ACCESS_TOKEN,
  INTERCOM_VERSION,
  INTERCOM_API_BASE
} from '$env/static/private';
import fs from 'node:fs/promises';
import path from 'node:path';

const INTERCOM_BASE_URL = INTERCOM_API_BASE || 'https://api.intercom.io';
const INTERCOM_API_VERSION = INTERCOM_VERSION || '2.10';

// Custom attribute keys in Intercom
const ATTR_USER_ID = 'User ID';
const ATTR_NAME = 'Name';
const ATTR_DOB = 'Date of Birth';
const ATTR_EMPLOYER = 'Employer';
const ATTR_LAST_SESSION = 'Last Coaching Session';
const ATTR_ENGAGEMENT_STATUS = 'Engagement Status';
const ATTR_ENGAGEMENT_STATUS_DATE = 'Engagement Status Date';
const ATTR_ELIGIBLE_PROGRAMS = 'Eligible Programs';
const ATTR_REGISTRATION_CODE = 'Registration Code';
const ATTR_REFERRAL = 'Referral';
const ATTR_ENROLLED_DATE = 'Enrolled Date'; // adjust to "Registration Date" if needed

// ----- Types -----

type ExportRequestBody = {
  outputPath: string;

  // Filters (all optional; if omitted they won’t be applied)
  referral?: string;                // custom_attributes.Referral
  employer?: string;                // custom_attributes.Employer
  enrolledDateStart?: string;       // "YYYY-MM-DD"
  enrolledDateEnd?: string;         // "YYYY-MM-DD"
  lastSessionStart?: string;        // "YYYY-MM-DD"
  lastSessionEnd?: string;          // "YYYY-MM-DD"
  engagementStatus?: string | string[]; // e.g. "Engaged" or ["Engaged","At Risk"]

  perPage?: number;                 // optional override, default 150
};

type IntercomContact = {
  id: string;
  name?: string | null;
  email?: string | null;
  custom_attributes?: Record<string, any>;
};

// ----- Intercom helper -----

async function intercomRequest(pathname: string, init: RequestInit = {}): Promise<any> {
  if (!INTERCOM_ACCESS_TOKEN) {
    throw new Error('INTERCOM_ACCESS_TOKEN is not set');
  }

  const res = await fetch(`${INTERCOM_BASE_URL}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${INTERCOM_ACCESS_TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Intercom-Version': INTERCOM_API_VERSION,
      ...(init.headers ?? {})
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Intercom ${res.status} ${res.statusText}: ${text}`);
  }

  return res.json();
}

// ----- Utility functions -----

function parseDateToUnix(dateStr?: string): number | null {
  if (!dateStr) return null;
  const ms = Date.parse(dateStr);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

function formatDateAttr(raw: any): string {
  if (raw === null || raw === undefined) return '';

  // Unix seconds
  if (typeof raw === 'number') {
    const d = new Date(raw * 1000);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }

  const s = String(raw).trim();
  if (!s) return '';

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // ISO or other parseable formats
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  // Fallback: return as-is
  return s;
}

function splitName(fullName?: string | null): { first: string; last: string } {
  if (!fullName) return { first: '', last: '' };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Build Intercom contact search query with filters
function buildContactSearchQuery(body: ExportRequestBody): any {
  const filters: any[] = [];

  // Always restrict to "user" role (adjust if you also need leads)
  filters.push({
    field: 'role',
    operator: '=',
    value: 'user'
  });

  if (body.referral) {
    filters.push({
      field: `custom_attributes.${ATTR_REFERRAL}`,
      operator: '=',
      value: body.referral
    });
  }

  if (body.employer) {
    filters.push({
      field: `custom_attributes.${ATTR_EMPLOYER}`,
      operator: '=',
      value: body.employer
    });
  }

  const enrolledStartUnix = parseDateToUnix(body.enrolledDateStart);
  const enrolledEndUnix = parseDateToUnix(body.enrolledDateEnd);

  if (enrolledStartUnix !== null) {
    filters.push({
      field: `custom_attributes.${ATTR_ENROLLED_DATE}`,
      operator: '>',
      value: enrolledStartUnix
    });
  }

  if (enrolledEndUnix !== null) {
    filters.push({
      field: `custom_attributes.${ATTR_ENROLLED_DATE}`,
      operator: '<',
      value: enrolledEndUnix
    });
  }

  const lastSessionStartUnix = parseDateToUnix(body.lastSessionStart);
  const lastSessionEndUnix = parseDateToUnix(body.lastSessionEnd);

  if (lastSessionStartUnix !== null) {
    filters.push({
      field: `custom_attributes.${ATTR_LAST_SESSION}`,
      operator: '>',
      value: lastSessionStartUnix
    });
  }

  if (lastSessionEndUnix !== null) {
    filters.push({
      field: `custom_attributes.${ATTR_LAST_SESSION}`,
      operator: '<',
      value: lastSessionEndUnix
    });
  }

  if (body.engagementStatus) {
    const values = Array.isArray(body.engagementStatus)
      ? body.engagementStatus
      : [body.engagementStatus];

    if (values.length === 1) {
      filters.push({
        field: `custom_attributes.${ATTR_ENGAGEMENT_STATUS}`,
        operator: '=',
        value: values[0]
      });
    } else if (values.length > 1) {
      filters.push({
        field: `custom_attributes.${ATTR_ENGAGEMENT_STATUS}`,
        operator: 'IN',
        value: values
      });
    }
  }

  if (filters.length === 1) {
    return filters[0];
  }

  return {
    operator: 'AND',
    value: filters
  };
}

// Fetch all contacts matching filters, with pagination
async function searchContactsForExport(body: ExportRequestBody): Promise<IntercomContact[]> {
  const query = buildContactSearchQuery(body);
  const perPage = body.perPage && body.perPage > 0 && body.perPage <= 150 ? body.perPage : 150;

  const allContacts: IntercomContact[] = [];
  let pagination: any = { per_page: perPage };
  let page = 1;

  while (pagination) {
    const payload: any = {
      query,
      pagination
    };

    const data = await intercomRequest('/contacts/search', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const contacts: IntercomContact[] = data.data ?? [];
    const totalCount = data.total_count ?? data.total ?? 'unknown';

    console.log(
      `Contacts search page ${page}: got ${contacts.length} contacts (total_count=${totalCount}).`
    );

    allContacts.push(...contacts);

    if (!data.pages?.next) {
      pagination = null;
      break;
    }

    pagination = {
      per_page: perPage,
      starting_after: data.pages.next.starting_after
    };
    page += 1;
  }

  console.log(`Total contacts fetched for CSV export: ${allContacts.length}`);
  return allContacts;
}

// Build CSV string from contacts
function buildCsv(contacts: IntercomContact[]): { csv: string; rows: any[] } {
  const rows: any[] = [];

  for (const contact of contacts) {
    const attrs = contact.custom_attributes ?? {};

    // Employee ID
    const employeeId =
      attrs[ATTR_USER_ID] ?? contact['external_id'] ?? contact.id ?? '';

    // Name → split into first / last
    const rawNameAttr = attrs[ATTR_NAME] ?? contact.name ?? '';
    const { first: nameFirst, last: nameLast } = splitName(rawNameAttr);

    const memberDob = formatDateAttr(attrs[ATTR_DOB]);
    const groupDescription = attrs[ATTR_EMPLOYER] ?? '';

    const lastCoachingSession = formatDateAttr(attrs[ATTR_LAST_SESSION]);
    const programStatus = attrs[ATTR_ENGAGEMENT_STATUS] ?? '';
    const statusDate = formatDateAttr(attrs[ATTR_ENGAGEMENT_STATUS_DATE]);

    const eligiblePrograms = attrs[ATTR_ELIGIBLE_PROGRAMS] ?? '';
    const registrationCode = attrs[ATTR_REGISTRATION_CODE] ?? '';

    rows.push({
      employee_id: employeeId,
      name_first: nameFirst,
      name_last: nameLast,
      member_dob: memberDob,
      group_description: groupDescription,
      last_coaching_session: lastCoachingSession,
      program_status: programStatus,
      status_date: statusDate,
      eligible_programs: eligiblePrograms,
      registration_code: registrationCode
    });
  }

  const header = [
    'employee_id',
    'name_first',
    'name_last',
    'member_dob',
    'group_description',
    'last_coaching_session',
    'program_status',
    'status_date',
    'eligible_programs',
    'registration_code'
  ];

  const lines: string[] = [];
  lines.push(header.join(','));

  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.employee_id),
        csvEscape(r.name_first),
        csvEscape(r.name_last),
        csvEscape(r.member_dob),
        csvEscape(r.group_description),
        csvEscape(r.last_coaching_session),
        csvEscape(r.program_status),
        csvEscape(r.status_date),
        csvEscape(r.eligible_programs),
        csvEscape(r.registration_code)
      ].join(',')
    );
  }

  const csv = lines.join('\n');
  return { csv, rows };
}

// ----- SvelteKit handler -----

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = (await request.json()) as ExportRequestBody;

    if (!body.outputPath || typeof body.outputPath !== 'string') {
      return new Response(
        JSON.stringify({ error: 'outputPath is required and must be a string' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const outPathAbs = path.resolve(body.outputPath);

    console.log('Starting CSV export with filters:', {
      referral: body.referral,
      employer: body.employer,
      enrolledDateStart: body.enrolledDateStart,
      enrolledDateEnd: body.enrolledDateEnd,
      lastSessionStart: body.lastSessionStart,
      lastSessionEnd: body.lastSessionEnd,
      engagementStatus: body.engagementStatus,
      perPage: body.perPage
    });

    const contacts = await searchContactsForExport(body);
    const { csv, rows } = buildCsv(contacts);

    // Ensure directory exists
    const dir = path.dirname(outPathAbs);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(outPathAbs, csv, 'utf8');
    console.log(`CSV export written to ${outPathAbs} (${rows.length} rows)`);

    // Return summary + small preview
    const previewRows = rows.slice(0, 10);

    return new Response(
      JSON.stringify({
        outputPath: outPathAbs,
        totalContacts: contacts.length,
        rowsWritten: rows.length,
        preview: previewRows
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (e: any) {
    console.error('Intercom export-members-csv failed:', e?.message ?? e);
    return new Response(
      JSON.stringify({
        error: 'Intercom export-members-csv failed',
        details: e?.message ?? String(e)
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
