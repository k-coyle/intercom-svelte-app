type JobProgressLike = {
	status?: string;
	phase?: string;
	done?: boolean;
	error?: unknown;
};

type PagedResponseLike = {
	items?: unknown[];
	nextOffset?: unknown;
	total?: unknown;
};

function normalizeFiniteNumber(value: unknown): number | null {
	const num = Number(value);
	return Number.isFinite(num) ? num : null;
}

export async function runJobUntilComplete<TProgress extends JobProgressLike>(opts: {
	createJob: () => Promise<string>;
	stepJob: (jobId: string) => Promise<TProgress>;
	signal?: AbortSignal;
	stepDelayMs?: number;
	defaultErrorMessage: string;
	cancelledErrorMessage: string;
	onJobCreated?: (jobId: string) => void;
	onProgress?: (progress: TProgress) => void;
}): Promise<{ jobId: string; progress: TProgress | null }> {
	const jobId = await opts.createJob();
	if (opts.onJobCreated) opts.onJobCreated(jobId);

	const stepDelayMs = Math.max(0, Math.floor(opts.stepDelayMs ?? 150));
	let lastProgress: TProgress | null = null;

	while (true) {
		if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

		const prog = await opts.stepJob(jobId);
		lastProgress = prog;
		if (opts.onProgress) opts.onProgress(prog);

		if (prog?.status === 'error') {
			throw new Error(String(prog?.error ?? opts.defaultErrorMessage));
		}
		if (prog?.status === 'cancelled') {
			throw new Error(opts.cancelledErrorMessage);
		}

		const done = !!prog?.done || prog?.status === 'complete' || prog?.phase === 'complete';
		if (done) break;

		if (stepDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
		}
	}

	return { jobId, progress: lastProgress };
}

export async function fetchAllPagedViewItems<T>(opts: {
	limit?: number;
	defaultLimit?: number;
	maxLimit?: number;
	signal?: AbortSignal;
	fetchPage: (offset: number, limit: number) => Promise<PagedResponseLike>;
	onPage?: (page: { loaded: number; total: number | null; nextOffset: number | null }) => void;
}): Promise<T[]> {
	const defaultLimit = Math.max(1, Math.floor(opts.defaultLimit ?? 500));
	const maxLimit = Math.max(defaultLimit, Math.floor(opts.maxLimit ?? 5000));
	const limit = Math.min(maxLimit, Math.max(1, Math.floor(opts.limit ?? defaultLimit)));

	const all: T[] = [];
	let offset = 0;
	const seenOffsets = new Set<number>();
	let pageCount = 0;

	while (true) {
		if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		if (seenOffsets.has(offset)) {
			throw new Error(`Paged view loop detected at offset ${offset}.`);
		}
		seenOffsets.add(offset);

		const page = await opts.fetchPage(offset, limit);
		const items = (page.items ?? []) as T[];
		all.push(...items);
		pageCount += 1;

		const nextOffset = normalizeFiniteNumber(page.nextOffset);
		const total = normalizeFiniteNumber(page.total);

		if (opts.onPage) {
			opts.onPage({
				loaded: all.length,
				total,
				nextOffset
			});
		}

		if (nextOffset == null) break;
		if (nextOffset <= offset) {
			throw new Error(
				`Invalid pagination: nextOffset ${nextOffset} must be greater than current offset ${offset}.`
			);
		}
		if (items.length === 0) {
			throw new Error(
				`Invalid pagination: received an empty page at offset ${offset} with nextOffset ${nextOffset}.`
			);
		}
		if (pageCount > 10000) {
			throw new Error('Paging safety stop triggered after 10000 pages.');
		}
		offset = nextOffset;
	}

	return all;
}
