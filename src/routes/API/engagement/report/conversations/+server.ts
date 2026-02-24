// src/routes/API/engagement/report/conversations/+server.ts
import type { RequestHandler } from '@sveltejs/kit';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  coerceIntercomPerPage,
  extractIntercomConversations,
  fetchContactsByIds,
  intercomPaginate,
  intercomRequest
} from '$lib/server/intercom';

import {
  INTERCOM_ATTR_CHANNEL,
  INTERCOM_ATTR_EMPLOYER,
  INTERCOM_ATTR_NAME,
  INTERCOM_ATTR_SERVICE_CODE
} from '$lib/server/intercom-attrs';
import { isQualifyingCoachingSession } from '$lib/server/engagement-rules';

type ReturnMode = 'file' | 'stream' | 'json';

type ConversationsExportRequestBody = {
  lookbackDays?: number;

  returnMode?: ReturnMode;
  outputPath?: string;

  perPage?: number;

  // filters out rows if user name is blank/null/empty
  requireUserName?: boolean;

  // controls how many conversation detail calls happen at once
  detailsConcurrency?: number;
};

type AdminInfo = { id: string; name: string; email: string | null };

const SECONDS_PER_DAY = 24 * 60 * 60;
const MAX_LOOKBACK_DAYS = 365;

// Conversation custom attrs
const CHANNEL_ATTR_KEY = INTERCOM_ATTR_CHANNEL;
const SERVICE_CODE_ATTR_KEY = INTERCOM_ATTR_SERVICE_CODE;

// Contact custom attrs
const CONTACT_NAME_ATTR_KEY = INTERCOM_ATTR_NAME;
const CONTACT_EMPLOYER_ATTR_KEY = INTERCOM_ATTR_EMPLOYER;

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function formatMMDDYYYY(unixSeconds: any): string {
  const n = typeof unixSeconds === 'number' ? unixSeconds : Number(unixSeconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function csvEscape(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function fetchAdminMap(): Promise<Map<string, AdminInfo>> {
  const map = new Map<string, AdminInfo>();

  try {
    const data = await intercomRequest('/admins', { method: 'GET' });
    const admins = data.admins ?? data.data ?? [];

    for (const a of admins) {
      const id = a?.id != null ? String(a.id) : '';
      if (!id) continue;
      map.set(id, {
        id,
        name: (a.name as string) ?? id,
        email: (a.email as string) ?? null
      });
    }
  } catch (err: any) {
    console.warn('Warning: unable to fetch admins map:', err?.message ?? err);
  }

  return map;
}

function getPrimaryContactId(conv: any): string | null {
  const list =
    conv?.contacts?.contacts ??
    conv?.contacts?.data ??
    conv?.contacts ??
    [];
  if (Array.isArray(list) && list.length > 0 && list[0]?.id != null) {
    return String(list[0].id);
  }
  return null;
}

type AuthorEntry = {
  created_at: number;
  authorType: 'admin' | 'contact' | 'bot' | string;
  authorId: string | null;
  authorName: string | null;
};

function collectAuthorEntries(conv: any): AuthorEntry[] {
  const entries: AuthorEntry[] = [];

  // source.author sometimes present
  if (conv?.source?.author?.type && conv?.source?.created_at) {
    entries.push({
      created_at: Number(conv.source.created_at) || 0,
      authorType: String(conv.source.author.type),
      authorId: conv.source.author.id != null ? String(conv.source.author.id) : null,
      authorName: conv.source.author.name != null ? String(conv.source.author.name) : null
    });
  }

  // initial conversation_message (often the first message)
  if (conv?.conversation_message?.author?.type && conv?.conversation_message?.created_at) {
    entries.push({
      created_at: Number(conv.conversation_message.created_at) || 0,
      authorType: String(conv.conversation_message.author.type),
      authorId:
        conv.conversation_message.author.id != null
          ? String(conv.conversation_message.author.id)
          : null,
      authorName:
        conv.conversation_message.author.name != null
          ? String(conv.conversation_message.author.name)
          : null
    });
  }

  // conversation_parts
  const partsContainer = conv?.conversation_parts;
  const parts =
    partsContainer?.conversation_parts ??
    partsContainer?.data ??
    (Array.isArray(partsContainer) ? partsContainer : []);

  if (Array.isArray(parts)) {
    for (const p of parts) {
      const t = p?.author?.type;
      const created = p?.created_at;
      if (!t || !created) continue;

      entries.push({
        created_at: Number(created) || 0,
        authorType: String(t),
        authorId: p.author?.id != null ? String(p.author.id) : null,
        authorName: p.author?.name != null ? String(p.author.name) : null
      });
    }
  }

  return entries.filter((e) => Number.isFinite(e.created_at) && e.created_at > 0);
}

function hasAnyAuthorType(entries: AuthorEntry[], type: string): boolean {
  const target = type.toLowerCase();
  return entries.some((e) => String(e.authorType).toLowerCase() === target);
}

function normalizeVal(v: any): string {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function getInitiatorType(entries: AuthorEntry[]): string {
  if (!entries.length) return '';
  let first = entries[0];
  for (const e of entries) if (e.created_at < first.created_at) first = e;
  return normalizeVal(first.authorType);
}

function computeCommunicationFlag(
  entries: AuthorEntry[],
  channel: any,
  serviceCode: any
): 'Unidirectional' | 'Bidirectional' | 'Unanswered' | '' {
  const hasContact = hasAnyAuthorType(entries, 'contact');
  const hasAdmin = hasAnyAuthorType(entries, 'admin');
  const initiator = getInitiatorType(entries);

  // C) Unanswered: started by user + no teammate reply
  if (initiator === 'contact' && !hasAdmin) return 'Unanswered';

  // B) Bidirectional: true back-and-forth OR qualifies as coaching session
  if ((hasContact && hasAdmin) || isQualifyingCoachingSession(channel, serviceCode)) {
    return 'Bidirectional';
  }

  // A) Unidirectional: teammate outreach only (no user messages)
  if (hasAdmin && !hasContact) return 'Unidirectional';

  return '';
}

function computeBotBoolean(entries: AuthorEntry[]): boolean {
  return hasAnyAuthorType(entries, 'bot');
}

function getLastAdminIdFromEntries(entries: AuthorEntry[]): string | null {
  let best: AuthorEntry | null = null;
  for (const e of entries) {
    if (String(e.authorType).toLowerCase() !== 'admin') continue;
    if (!e.authorId) continue;
    if (!best || e.created_at > best.created_at) best = e;
  }
  return best?.authorId ?? null;
}

// Fetch full conversation (so we can reliably read conversation_parts and authors)
async function fetchConversationDetails(conversationId: string): Promise<any> {
  // Intercom endpoint is typically /conversations/{id}
  return intercomRequest(`/conversations/${conversationId}`, { method: 'GET' });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, 25));
  const results: R[] = new Array(items.length);
  let i = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

async function searchConversationsCreatedSince(
  sinceUnix: number,
  perPage: number
): Promise<any[]> {
  // locked to created_at per your direction
  return intercomPaginate<any>({
    path: '/conversations/search',
    body: {
      query: {
        field: 'created_at',
        operator: '>',
        value: sinceUnix
      }
    },
    perPage,
    extractItems: extractIntercomConversations,
    onPage: ({ page, items, totalCount }) => {
      const count = totalCount ?? 'unknown';
      console.log(`conversations-export page ${page}: got ${items} conversations (total_count=${count})`);
    }
  });
}

export const POST: RequestHandler = async ({ request }) => {
  try {
    let body: ConversationsExportRequestBody = {};
    const raw = await request.text();

    if (raw && raw.trim().length > 0) {
    try {
        body = JSON.parse(raw) as ConversationsExportRequestBody;
    } catch (e1: any) {
        // Common Windows CMD mistake: payload contains literal backslashes like {\"lookbackDays\":30}
        const relaxed = raw.replace(/\\"/g, '"');
        try {
        body = JSON.parse(relaxed) as ConversationsExportRequestBody;
        } catch (e2: any) {
        return new Response(
            JSON.stringify({
            error: 'Invalid JSON body',
            details: e2?.message ?? e1?.message ?? String(e1),
            received: raw.slice(0, 300),
            exampleCmd: 'curl -X POST "http://localhost:5173/API/engagement/report/conversations" -H "Content-Type: application/json" -d "{""lookbackDays"":30,""returnMode"":""json""}"'
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
        }
    }
    }

    const requestedLookback = Number(body.lookbackDays ?? 30);
    const lookbackDays = Number.isFinite(requestedLookback)
      ? Math.max(1, Math.min(Math.floor(requestedLookback), MAX_LOOKBACK_DAYS))
      : 30;

    const mode: ReturnMode = body.returnMode ?? (body.outputPath ? 'file' : 'stream');
    const outPathAbs = body.outputPath ? path.resolve(body.outputPath) : null;

    if (mode === 'file' && !outPathAbs) {
      return new Response(
        JSON.stringify({ error: 'outputPath is required when returnMode="file"' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const requireUserName = body.requireUserName !== false; // default true
    const perPage = coerceIntercomPerPage(body.perPage);
    const detailsConcurrency = Number.isFinite(Number(body.detailsConcurrency))
      ? Math.max(1, Math.min(Number(body.detailsConcurrency), 15))
      : 6;

    const nowUnix = Math.floor(Date.now() / 1000);
    const sinceUnix = nowUnix - lookbackDays * SECONDS_PER_DAY;

    console.log('Starting conversations export:', {
      lookbackDays,
      sinceUnix,
      filterField: 'created_at',
      returnMode: mode,
      outputPath: outPathAbs,
      perPage,
      requireUserName,
      detailsConcurrency
    });

    // 1) Fetch conversation list in the window (created_at)
    const conversations = await searchConversationsCreatedSince(sinceUnix, perPage);
    console.log(`Total conversations fetched (search): ${conversations.length}`);

    // 2) Fetch admin map (id -> name)
    const adminMap = await fetchAdminMap();

    // 3) Fetch conversation details (for parts/authors and last admin)
    const conversationIds = conversations
      .map((c) => (c?.id != null ? String(c.id) : ''))
      .filter((id) => id.length > 0);

    const detailsList = await mapWithConcurrency(conversationIds, detailsConcurrency, async (id) => {
      try {
        return await fetchConversationDetails(id);
      } catch (e: any) {
        console.warn('Failed to fetch conversation details:', id, e?.message ?? e);
        return null;
      }
    });

    const detailsById = new Map<string, any>();
    for (let idx = 0; idx < conversationIds.length; idx++) {
      const id = conversationIds[idx];
      const d = detailsList[idx];
      if (d) detailsById.set(id, d);
    }

    // 4) Hydrate contacts for name/employer
    const contactIds = Array.from(
      new Set(
        conversationIds
          .map((id) => {
            const d = detailsById.get(id);
            const base = d ?? conversations.find((c) => String(c?.id) === id);
            return getPrimaryContactId(base) ?? '';
          })
          .filter((id) => id.length > 0)
      )
    );

    const contactMap = await fetchContactsByIds(contactIds, {
      concurrency: 10,
      onError: (contactId, error) => {
        console.warn('Failed to hydrate contact', contactId, error);
      }
    });

    // 5) Build CSV
    const header = [
      'conversation_id',
      'created_at',
      'custom_attributes.Channel',
      'custom_attributes.Service Code',
      'state',
      'communication_flag',
      'bot',
      'teammate_name',
      'user_name',
      'custom_attributes.Employer'
    ];

    const rows: Record<string, any>[] = [];
    const lines: string[] = [];
    lines.push(header.join(','));

    let skippedMissingUserName = 0;
    let missingContact = 0;
    let missingDetails = 0;

    for (const conv of conversations) {
      const conversationId = conv?.id != null ? String(conv.id) : '';
      if (!conversationId) continue;

      const details = detailsById.get(conversationId) ?? null;
      if (!details) {
        missingDetails += 1;
        // We can still output using the search object, but teammate-last-touch and bot/flag may be weaker.
        // To keep deterministic + accurate, we skip if no details.
        continue;
      }

      const contactId = getPrimaryContactId(details);
      const contact = contactId ? (contactMap.get(contactId) ?? null) : null;
      if (!contactId || !contact) {
        missingContact += 1;
        continue;
      }

      const cAttrs = contact.custom_attributes ?? {};
      const userNameRaw =
        (contact.name as string) ??
        (cAttrs[CONTACT_NAME_ATTR_KEY] as string) ??
        '';
      const userName = String(userNameRaw ?? '').trim();

      if (requireUserName && !userName) {
        skippedMissingUserName += 1;
        continue;
      }

      const employer =
        cAttrs[CONTACT_EMPLOYER_ATTR_KEY] != null
          ? String(cAttrs[CONTACT_EMPLOYER_ATTR_KEY])
          : '';

      // Conversation custom attributes: prefer details (full object)
      const convAttrs = (details?.custom_attributes ?? conv?.custom_attributes ?? {});
      const channel = convAttrs[CHANNEL_ATTR_KEY] != null ? String(convAttrs[CHANNEL_ATTR_KEY]) : '';
      const serviceCode =
        convAttrs[SERVICE_CODE_ATTR_KEY] != null ? String(convAttrs[SERVICE_CODE_ATTR_KEY]) : '';

      const state = details?.state != null ? String(details.state) : (conv?.state != null ? String(conv.state) : '');

      const entries = collectAuthorEntries(details);
      const communicationFlag = computeCommunicationFlag(entries, channel, serviceCode);
      const bot = computeBotBoolean(entries);

      // teammate = last admin author in conversation parts/messages
      const lastAdminId = getLastAdminIdFromEntries(entries);
      const teammateName =
        lastAdminId && adminMap.get(lastAdminId)?.name
          ? adminMap.get(lastAdminId)!.name
          : (details?.admin_assignee_id != null ? (adminMap.get(String(details.admin_assignee_id))?.name ?? String(details.admin_assignee_id)) : (lastAdminId ?? ''));

      const createdAt = formatMMDDYYYY(details?.created_at);

      const row = {
        conversation_id: conversationId,
        created_at: createdAt,
        channel,
        service_code: serviceCode,
        state,
        communication_flag: communicationFlag,
        bot,
        teammate_name: teammateName,
        user_name: userName,
        employer
      };

      rows.push(row);

      lines.push(
        [
          csvEscape(conversationId),
          csvEscape(createdAt),
          csvEscape(channel),
          csvEscape(serviceCode),
          csvEscape(state),
          csvEscape(communicationFlag),
          csvEscape(bot),
          csvEscape(teammateName),
          csvEscape(userName),
          csvEscape(employer)
        ].join(',')
      );
    }

    const csv = lines.join('\n');

    // ---- Mode: write to filesystem and return JSON summary ----
    if (mode === 'file' && outPathAbs) {
      const dir = path.dirname(outPathAbs);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(outPathAbs, csv, 'utf8');

      return new Response(
        JSON.stringify({
          mode,
          outputPath: outPathAbs,
          lookbackDays,
          sinceUnix,
          filterField: 'created_at',
          conversationsFetched: conversations.length,
          detailsFetched: detailsById.size,
          rowsWritten: rows.length,
          skippedMissingUserName,
          missingContact,
          missingDetails,
          preview: rows.slice(0, 25)
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ---- Mode: JSON summary only ----
    if (mode === 'json') {
      return new Response(
        JSON.stringify({
          mode,
          lookbackDays,
          sinceUnix,
          filterField: 'created_at',
          conversationsFetched: conversations.length,
          detailsFetched: detailsById.size,
          rowsWritten: rows.length,
          skippedMissingUserName,
          missingContact,
          missingDetails,
          preview: rows.slice(0, 200)
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ---- Default: stream CSV ----
    const fileName = `conversation_export_${new Date().toISOString().slice(0, 10)}.csv`;

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`
      }
    });
  } catch (e: any) {
    console.error('Conversations export failed:', e?.message ?? e);
    return new Response(
      JSON.stringify({
        error: 'Conversations export failed',
        details: e?.message ?? String(e)
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
