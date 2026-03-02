import type { SyntheticEngagementData } from '$lib/testing/engagement-synthetic-data';

type IntercomLikePaginationInfo = {
	page: number;
	items: number;
	totalCount?: number;
	nextCursor: string | null;
};

type IntercomLikeRequestOptions = {
	onPage?: (info: IntercomLikePaginationInfo) => void;
};

type QueryFilter = {
	field: string;
	operator: string;
	value: unknown;
};

function deepClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function getValueByField(item: any, field: string): unknown {
	if (field === 'contact_ids') {
		const contacts = item?.contacts?.contacts ?? item?.contacts?.data ?? [];
		if (!Array.isArray(contacts)) return [];
		return contacts.map((contact) => String(contact?.id ?? ''));
	}

	if (field.startsWith('custom_attributes.')) {
		const key = field.slice('custom_attributes.'.length);
		return item?.custom_attributes?.[key];
	}

	return item?.[field];
}

function asNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function includesValue(container: unknown, expected: unknown): boolean {
	if (Array.isArray(container)) {
		return container.map(String).includes(String(expected));
	}
	if (Array.isArray(expected)) {
		return expected.map(String).includes(String(container));
	}
	return String(container) === String(expected);
}

function applyFilter(item: any, filter: QueryFilter): boolean {
	const actual = getValueByField(item, filter.field);
	const operator = String(filter.operator ?? '').toUpperCase();
	const expected = filter.value;

	if (operator === '=') return includesValue(actual, expected);
	if (operator === '!=') return !includesValue(actual, expected);

	if (operator === 'IN') {
		const expectedArray = Array.isArray(expected) ? expected : [expected];
		if (Array.isArray(actual)) {
			return actual.some((value) => expectedArray.map(String).includes(String(value)));
		}
		return expectedArray.map(String).includes(String(actual));
	}

	if (operator === 'NIN') {
		const expectedArray = Array.isArray(expected) ? expected : [expected];
		if (Array.isArray(actual)) {
			return !actual.some((value) => expectedArray.map(String).includes(String(value)));
		}
		return !expectedArray.map(String).includes(String(actual));
	}

	if (operator === '>' || operator === '<' || operator === '<=') {
		const actualNum = asNumber(actual);
		const expectedNum = asNumber(expected);
		if (actualNum == null || expectedNum == null) return false;

		if (operator === '>') return actualNum > expectedNum;
		if (operator === '<') return actualNum < expectedNum;
		return actualNum <= expectedNum;
	}

	return false;
}

function applyQuery(item: any, query: any): boolean {
	if (!query) return true;
	if (query.operator === 'AND' && Array.isArray(query.value)) {
		return query.value.every((filter: QueryFilter) => applyFilter(item, filter));
	}
	return applyFilter(item, query);
}

function paginate<T>(items: T[], perPage: number, startingAfter?: string | null) {
	const start = startingAfter ? Math.max(0, Number(startingAfter)) : 0;
	const safeStart = Number.isFinite(start) ? start : 0;
	const safePerPage = Math.max(1, Math.floor(perPage));
	const slice = items.slice(safeStart, safeStart + safePerPage);
	const nextOffset = safeStart + safePerPage;
	const next = nextOffset < items.length ? { starting_after: String(nextOffset) } : null;
	return { items: slice, next };
}

function buildContactsSearchResponse(data: SyntheticEngagementData, body: any) {
	const query = body?.query;
	const perPage = Number(body?.pagination?.per_page ?? 150);
	const startingAfter = body?.pagination?.starting_after ?? null;

	const filtered = data.contacts.filter((contact) => applyQuery(contact, query));
	const sorted = [...filtered].sort((a, b) => a.id.localeCompare(b.id));
	const page = paginate(sorted, perPage, startingAfter);

	return {
		data: deepClone(page.items),
		total_count: sorted.length,
		pages: page.next ? { next: page.next } : {}
	};
}

function buildConversationsSearchResponse(data: SyntheticEngagementData, body: any) {
	const query = body?.query;
	const perPage = Number(body?.pagination?.per_page ?? 100);
	const startingAfter = body?.pagination?.starting_after ?? null;

	const filtered = data.conversations.filter((conversation) => applyQuery(conversation, query));
	const sorted = [...filtered].sort((a, b) => {
		if (a.created_at !== b.created_at) return a.created_at - b.created_at;
		return a.id.localeCompare(b.id);
	});
	const page = paginate(sorted, perPage, startingAfter);

	return {
		conversations: deepClone(page.items),
		total_count: sorted.length,
		pages: page.next ? { next: page.next } : {}
	};
}

function coerceIntercomPerPage(perPage?: number, max = 150, fallback = 150): number {
	if (!perPage || !Number.isFinite(perPage)) return fallback;
	if (perPage <= 0) return fallback;
	return Math.min(Math.floor(perPage), max);
}

export function createOfflineIntercomModule(data: SyntheticEngagementData) {
	async function intercomRequest(
		path: string,
		init: RequestInit = {},
		_opts?: unknown
	): Promise<any> {
		const method = String(init.method ?? 'GET').toUpperCase();
		const parsedBody = init.body ? JSON.parse(String(init.body)) : {};

		if (path === '/admins' && method === 'GET') {
			return { admins: deepClone(data.admins) };
		}

		if (path === '/contacts/search' && method === 'POST') {
			return buildContactsSearchResponse(data, parsedBody);
		}

		if (path === '/conversations/search' && method === 'POST') {
			return buildConversationsSearchResponse(data, parsedBody);
		}

		if (path.startsWith('/contacts/') && method === 'GET') {
			const id = path.slice('/contacts/'.length);
			const found = data.contacts.find((contact) => contact.id === id);
			if (!found) throw new Error(`Intercom 404 Not Found on ${path}: {"request_id":"offline-404"}`);
			return deepClone(found);
		}

		throw new Error(`Unhandled offline Intercom request: ${method} ${path}`);
	}

	async function intercomPaginate<T>(opts: {
		path: string;
		body: Record<string, any>;
		perPage?: number;
		extractItems: (response: any) => T[];
		getNextCursor?: (response: any) => string | undefined;
		onPage?: (info: IntercomLikePaginationInfo) => void;
		requestOptions?: IntercomLikeRequestOptions;
	}): Promise<T[]> {
		const perPage = coerceIntercomPerPage(opts.perPage);
		const all: T[] = [];
		let cursor: string | undefined;
		let page = 1;

		while (true) {
			const payload: any = {
				...opts.body,
				pagination: {
					per_page: perPage
				}
			};
			if (cursor) payload.pagination.starting_after = cursor;

			const response = await intercomRequest(
				opts.path,
				{
					method: 'POST',
					body: JSON.stringify(payload)
				},
				opts.requestOptions
			);

			const items = opts.extractItems(response);
			all.push(...items);

			const nextCursor = (opts.getNextCursor ?? ((r: any) => r?.pages?.next?.starting_after))(response);
			const onPage = opts.onPage ?? opts.requestOptions?.onPage;
			if (onPage) {
				onPage({
					page,
					items: items.length,
					totalCount: response?.total_count,
					nextCursor: nextCursor ?? null
				});
			}

			if (!nextCursor) break;
			cursor = nextCursor;
			page += 1;
		}

		return all;
	}

	async function fetchContactsByIds(
		contactIds: string[],
		opts: { concurrency?: number; onError?: (contactId: string, error: unknown) => void } = {}
	): Promise<Map<string, any>> {
		const result = new Map<string, any>();
		const uniqueIds = [...new Set(contactIds)].filter(Boolean);
		const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 10));
		let index = 0;

		async function worker() {
			while (index < uniqueIds.length) {
				const contactId = uniqueIds[index];
				index += 1;
				try {
					const contact = await intercomRequest(`/contacts/${contactId}`, { method: 'GET' });
					result.set(contactId, contact);
				} catch (error) {
					if (opts.onError) opts.onError(contactId, error);
				}
			}
		}

		await Promise.all(Array.from({ length: Math.min(concurrency, uniqueIds.length) }, () => worker()));
		return result;
	}

	return {
		INTERCOM_MAX_PER_PAGE: 150,
		coerceIntercomPerPage,
		extractIntercomContacts: (response: any) => response?.data ?? response?.contacts ?? [],
		extractIntercomConversations: (response: any) => response?.conversations ?? response?.data ?? [],
		fetchContactsByIds,
		intercomPaginate,
		intercomRequest
	};
}
