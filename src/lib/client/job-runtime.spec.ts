import { describe, expect, it, vi } from 'vitest';
import { fetchAllPagedViewItems, runJobUntilComplete } from '$lib/client/job-runtime';

describe('runJobUntilComplete', () => {
	it('returns the terminal progress payload and emits progress events', async () => {
		const createJob = vi.fn().mockResolvedValue('job-1');
		const stepJob = vi
			.fn()
			.mockResolvedValueOnce({ status: 'running', done: false, progress: 10 })
			.mockResolvedValueOnce({ status: 'complete', done: true, progress: 20 });
		const onProgress = vi.fn();
		const onJobCreated = vi.fn();

		const result = await runJobUntilComplete({
			createJob,
			stepJob,
			stepDelayMs: 0,
			defaultErrorMessage: 'job failed',
			cancelledErrorMessage: 'job cancelled',
			onJobCreated,
			onProgress
		});

		expect(createJob).toHaveBeenCalledTimes(1);
		expect(stepJob).toHaveBeenCalledTimes(2);
		expect(onJobCreated).toHaveBeenCalledWith('job-1');
		expect(onProgress).toHaveBeenCalledTimes(2);
		expect(result).toEqual({
			jobId: 'job-1',
			progress: { status: 'complete', done: true, progress: 20 }
		});
	});

	it('throws default errors for failed jobs', async () => {
		await expect(
			runJobUntilComplete({
				createJob: async () => 'job-1',
				stepJob: async () => ({ status: 'error', error: undefined }),
				stepDelayMs: 0,
				defaultErrorMessage: 'job failed',
				cancelledErrorMessage: 'job cancelled'
			})
		).rejects.toThrow('job failed');
	});

	it('throws cancelled errors for cancelled jobs', async () => {
		await expect(
			runJobUntilComplete({
				createJob: async () => 'job-1',
				stepJob: async () => ({ status: 'cancelled' }),
				stepDelayMs: 0,
				defaultErrorMessage: 'job failed',
				cancelledErrorMessage: 'job cancelled'
			})
		).rejects.toThrow('job cancelled');
	});
});

describe('fetchAllPagedViewItems', () => {
	it('loads all pages and reports page progress', async () => {
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce({ items: [{ id: 1 }, { id: 2 }], nextOffset: 2, total: 3 })
			.mockResolvedValueOnce({ items: [{ id: 3 }], nextOffset: null, total: 3 });
		const onPage = vi.fn();

		const rows = await fetchAllPagedViewItems<{ id: number }>({
			fetchPage,
			onPage
		});

		expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
		expect(fetchPage).toHaveBeenNthCalledWith(1, 0, 500);
		expect(fetchPage).toHaveBeenNthCalledWith(2, 2, 500);
		expect(onPage).toHaveBeenCalledTimes(2);
		expect(onPage).toHaveBeenLastCalledWith({
			loaded: 3,
			total: 3,
			nextOffset: null
		});
	});

	it('throws for invalid pagination loops and regressions', async () => {
		await expect(
			fetchAllPagedViewItems({
				fetchPage: async () => ({
					items: [{ id: 1 }],
					nextOffset: 0,
					total: 1
				})
			})
		).rejects.toThrow(/must be greater than current offset/);

		await expect(
			fetchAllPagedViewItems({
				fetchPage: async () => ({
					items: [],
					nextOffset: 1,
					total: 2
				})
			})
		).rejects.toThrow(/received an empty page/);
	});
});
