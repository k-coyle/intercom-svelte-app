import { describe, expect, it } from 'vitest';
import {
	SD_BLANK_FILTER_LABELS,
	SD_SERVICE_CODE_ALIASES,
	matchesSelectedFilter,
	matchesSelectedListFilter,
	mergeFilterOptions,
	normalizeFilterValue,
	retainSelectedFilterValues,
	valuesOrBlank
} from './sd-report-utils';

describe('SD report filter utilities', () => {
	it('merges defaults with discovered values using alphabetic, case-insensitive dedupe', () => {
		expect(mergeFilterOptions(['World Bank', 'Vitality'], ['  acme health ', 'world bank'])).toEqual([
			'acme health',
			'Vitality',
			'World Bank'
		]);
	});

	it('maps blank scalar and list values to report-specific catch-all labels', () => {
		expect(
			mergeFilterOptions(['Smart Access'], [null, ''], {
				blankLabel: SD_BLANK_FILTER_LABELS.program
			})
		).toEqual([SD_BLANK_FILTER_LABELS.program, 'Smart Access']);

		expect(valuesOrBlank([])).toEqual([null]);
		expect(
			matchesSelectedListFilter([SD_BLANK_FILTER_LABELS.program], [], {
				blankLabel: SD_BLANK_FILTER_LABELS.program
			})
		).toBe(true);
	});

	it('normalizes service-code aliases to the PM-facing categories', () => {
		expect(
			mergeFilterOptions(['Health Coaching'], ['Health Coaching 001', 'Disease Management 002'], {
				blankLabel: SD_BLANK_FILTER_LABELS.serviceCode,
				aliases: SD_SERVICE_CODE_ALIASES
			})
		).toEqual(['Disease Management', 'Health Coaching']);

		expect(
			matchesSelectedFilter(['Health Coaching'], 'Health Coaching 001', {
				blankLabel: SD_BLANK_FILTER_LABELS.serviceCode,
				aliases: SD_SERVICE_CODE_ALIASES
			})
		).toBe(true);
	});

	it('retains selected values with canonical option casing', () => {
		expect(retainSelectedFilterValues(['world bank', 'missing'], ['Vitality', 'World Bank'])).toEqual([
			'World Bank'
		]);
	});

	it('normalizes blank scalar values consistently', () => {
		expect(
			normalizeFilterValue('   ', { blankLabel: SD_BLANK_FILTER_LABELS.employer })
		).toBe(SD_BLANK_FILTER_LABELS.employer);
	});
});
