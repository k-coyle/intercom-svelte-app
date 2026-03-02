import { describe, expect, it } from 'vitest';
import {
	coerceMonthYearLabel,
	computeMonthComparisonWindow,
	computeMonthWindow,
	getCurrentMonthYearLabel,
	unixDaysBetween
} from '$lib/server/report-time';

describe('report-time invariants', () => {
	const anchorNow = new Date('2026-03-02T12:00:00.000Z');

	it('computes stable current month label in America/New_York', () => {
		expect(getCurrentMonthYearLabel(anchorNow, 'America/New_York')).toBe('2026-03');
	});

	it('coerces empty month label to current month and validates explicit labels', () => {
		expect(coerceMonthYearLabel('', anchorNow, 'America/New_York')).toBe('2026-03');
		expect(coerceMonthYearLabel('2026-02', anchorNow, 'America/New_York')).toBe('2026-02');
		expect(() => coerceMonthYearLabel('2026-13', anchorNow, 'America/New_York')).toThrow(
			/Invalid month/
		);
	});

	it('builds month windows with increasing start/end boundaries', () => {
		const feb = computeMonthWindow('2026-02', 'America/New_York');
		expect(feb.monthYearLabel).toBe('2026-02');
		expect(feb.month).toBe(2);
		expect(feb.monthStartUnix).toBeLessThan(feb.monthEndUnix);
		expect(feb.monthStartISO < feb.monthEndISO).toBe(true);
	});

	it('computes elapsed month comparison windows for past and future months', () => {
		const past = computeMonthComparisonWindow('2026-02', {
			now: anchorNow,
			timeZone: 'America/New_York'
		});
		expect(past.current.elapsedDays).toBe(28);
		expect(past.prior.elapsedDays).toBe(28);
		expect(past.current.elapsedEndUnix).toBe(past.current.month.monthEndUnix);
		expect(past.prior.elapsedEndUnix).toBeLessThanOrEqual(past.prior.month.monthEndUnix);

		const future = computeMonthComparisonWindow('2026-04', {
			now: anchorNow,
			timeZone: 'America/New_York'
		});
		expect(future.current.elapsedDays).toBe(0);
		expect(future.current.elapsedEndUnix).toBe(future.current.month.monthStartUnix);
	});

	it('calculates day deltas as non-negative ceil day counts', () => {
		expect(unixDaysBetween(100, 100)).toBe(0);
		expect(unixDaysBetween(100, 101)).toBe(1);
		expect(unixDaysBetween(100, 100 + 60 * 60 * 24 * 2 - 1)).toBe(2);
	});
});
