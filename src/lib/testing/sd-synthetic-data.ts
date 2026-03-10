import { buildSyntheticEngagementData } from '$lib/testing/engagement-synthetic-data';

type SyntheticOncehubBooking = {
	id: string;
	status: string;
	created_time: string;
	starting_time: string;
	attendees: string[];
	owner: string;
};

export function buildSyntheticOncehubBookings(nowUnix = Math.floor(Date.now() / 1000)): SyntheticOncehubBooking[] {
	const pastStatuses = [
		'completed',
		'completed',
		'completed',
		'no_show',
		'rescheduled',
		'canceled',
		'completed',
		'no_show',
		'rescheduled',
		'canceled'
	];
	const futureStatuses = [
		'scheduled',
		'scheduled',
		'scheduled',
		'rescheduled',
		'canceled',
		'scheduled',
		'rescheduled',
		'scheduled',
		'canceled',
		'scheduled'
	];
	const coachEmails = ['coach.alpha@uspm.com', 'coach.bravo@uspm.com', 'coach.charlie@uspm.com'];
	const engagementData = buildSyntheticEngagementData({ anchorNow: new Date(nowUnix * 1000) });
	const memberEmails = engagementData.contacts
		.map((contact) => String(contact.email ?? '').trim().toLowerCase())
		.filter((email) => email.length > 0);

	const rows: SyntheticOncehubBooking[] = [];
	for (let i = 0; i < 540; i += 1) {
		const dayOffset = i - 420;
		const hourOffset = 7 + (i % 11);
		const minuteOffset = (i % 4) * 15;
		const startUnix =
			nowUnix + dayOffset * 24 * 60 * 60 + hourOffset * 60 * 60 + minuteOffset * 60;
		const status =
			startUnix < nowUnix
				? pastStatuses[i % pastStatuses.length]
				: futureStatuses[i % futureStatuses.length];
		const leadDays = [0, 1, 2, 3, 5, 7, 14, 21, 30, 45][i % 10];
		const createdUnix = Math.min(startUnix - leadDays * 24 * 60 * 60, nowUnix - ((i % 6) + 1) * 60 * 60);
		const memberEmail = memberEmails[(i * 13) % memberEmails.length] ?? `member${i + 1}@example.test`;
		rows.push({
			id: `OFFBOOK-${String(i + 1).padStart(4, '0')}`,
			status,
			created_time: new Date(createdUnix * 1000).toISOString(),
			starting_time: new Date(startUnix * 1000).toISOString(),
			attendees: [coachEmails[i % coachEmails.length], memberEmail],
			owner: `OFFOWNER-${(i % 9) + 1}`
		});
	}

	const edgeCases: Array<{
		idSuffix: string;
		status: string;
		startOffsetDays: number;
		leadDays: number;
		hourUtc: number;
		coachIndex: number;
		memberIndex: number;
		ownerIndex: number;
	}> = [
		// Future-heavy calendar edge cases.
		{ idSuffix: '0001', status: 'scheduled', startOffsetDays: 120, leadDays: 140, hourUtc: 14, coachIndex: 0, memberIndex: 7, ownerIndex: 1 },
		{ idSuffix: '0002', status: 'rescheduled', startOffsetDays: 75, leadDays: 95, hourUtc: 16, coachIndex: 1, memberIndex: 33, ownerIndex: 2 },
		{ idSuffix: '0003', status: 'canceled', startOffsetDays: 45, leadDays: 60, hourUtc: 18, coachIndex: 2, memberIndex: 52, ownerIndex: 3 },
		{ idSuffix: '0004', status: 'scheduled', startOffsetDays: 180, leadDays: 2, hourUtc: 13, coachIndex: 0, memberIndex: 89, ownerIndex: 4 },
		// Past and near-term edge cases.
		{ idSuffix: '0005', status: 'completed', startOffsetDays: -40, leadDays: 15, hourUtc: 15, coachIndex: 1, memberIndex: 101, ownerIndex: 5 },
		{ idSuffix: '0006', status: 'canceled', startOffsetDays: 20, leadDays: 5, hourUtc: 17, coachIndex: 2, memberIndex: 121, ownerIndex: 6 },
		{ idSuffix: '0007', status: 'no_show', startOffsetDays: -3, leadDays: 10, hourUtc: 14, coachIndex: 1, memberIndex: 142, ownerIndex: 7 },
		{ idSuffix: '0008', status: 'rescheduled', startOffsetDays: -1, leadDays: 21, hourUtc: 12, coachIndex: 0, memberIndex: 163, ownerIndex: 8 },
		{ idSuffix: '0009', status: 'scheduled', startOffsetDays: 1, leadDays: 0, hourUtc: 15, coachIndex: 2, memberIndex: 185, ownerIndex: 9 },
		{ idSuffix: '0010', status: 'rescheduled', startOffsetDays: 210, leadDays: 180, hourUtc: 19, coachIndex: 1, memberIndex: 207, ownerIndex: 1 }
	];

	for (const edge of edgeCases) {
		const startUnix = nowUnix + edge.startOffsetDays * 24 * 60 * 60 + edge.hourUtc * 60 * 60;
		const createdUnix = startUnix - edge.leadDays * 24 * 60 * 60;
		const memberEmail =
			memberEmails[edge.memberIndex % memberEmails.length] ?? `member.edge.${edge.idSuffix}@example.test`;
		rows.push({
			id: `OFFEDGE-${edge.idSuffix}`,
			status: edge.status,
			created_time: new Date(createdUnix * 1000).toISOString(),
			starting_time: new Date(startUnix * 1000).toISOString(),
			attendees: [coachEmails[edge.coachIndex % coachEmails.length], memberEmail],
			owner: `OFFOWNER-${edge.ownerIndex}`
		});
	}

	return rows.sort((a, b) => Date.parse(b.starting_time) - Date.parse(a.starting_time));
}
