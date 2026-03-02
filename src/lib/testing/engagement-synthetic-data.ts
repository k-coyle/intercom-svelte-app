import {
	INTERCOM_ATTR_CHANNEL,
	INTERCOM_ATTR_EMPLOYER,
	INTERCOM_ATTR_ENROLLED_DATE,
	INTERCOM_ATTR_REGISTRATION_DATE,
	INTERCOM_ATTR_SERVICE_CODE
} from '$lib/server/intercom-attrs';
import {
	QUALIFYING_COACHING_CHANNELS,
	isQualifyingCoachingSession,
	STANDARD_REPORT_SESSION_CHANNELS
} from '$lib/server/engagement-rules';
import {
	computeMonthComparisonWindow,
	computeMonthWindow,
	REPORT_TIMEZONE
} from '$lib/server/report-time';

type ContactLike = {
	id: string;
	role: 'user';
	name: string;
	email: string;
	custom_attributes: Record<string, string | number>;
};

type ConversationLike = {
	id: string;
	state: 'closed' | 'open';
	created_at: number;
	updated_at: number;
	admin_assignee_id: string | null;
	custom_attributes: Record<string, string>;
	contacts: { contacts: Array<{ id: string }> };
	statistics: {
		last_close_at: number;
		last_admin_reply_at: number;
	};
};

type AdminLike = {
	id: string;
	name: string;
	email: string;
};

type ExpectedInvariants = {
	anchorNowIso: string;
	lookbackDays: number;
	billingMonthLabel: string;
	overviewMonthLabel: string;
	caseload: {
		totalMembers: number;
		totalSessions: number;
		buckets: {
			bucket_1: number;
			bucket_2: number;
			bucket_3: number;
			bucket_4: number;
		};
	};
	newParticipants: {
		totalParticipants: number;
		summary: {
			gt_14_to_21: number;
			gt_21_to_28: number;
			gt_28: number;
		};
	};
	billing: {
		totalRows: number;
		totalNewParticipants: number;
		totalEngagedDuringMonth: number;
	};
	overview: {
		newRegistrationsMtd: { count: number; priorCount: number };
		newEnrolleesMtd: { count: number; priorCount: number };
		qualifyingSessionsMtd: { count: number; priorCount: number };
		enrollmentSnapshot: {
			newlyRegisteredWithQualifyingSessionMtd: {
				current: {
					registeredCount: number;
					withQualifyingSessionCount: number;
					pct: number | null;
				};
				prior: {
					registeredCount: number;
					withQualifyingSessionCount: number;
					pct: number | null;
				};
			};
		};
		caseloadTrends: {
			sessionsByServiceCodeMtd: Array<{
				serviceCode: string;
				count: number;
				sharePct: number;
			}>;
		};
	};
};

export type SyntheticEngagementData = {
	anchorNow: Date;
	contacts: ContactLike[];
	conversations: ConversationLike[];
	admins: AdminLike[];
	expected: ExpectedInvariants;
};

type SyntheticDataOptions = {
	anchorNow?: Date;
	memberCount?: number;
};

type Profile = 'high_engaged' | 'stable_engaged' | 'watchlist' | 'reengaged' | 'new_no_session';

const SECONDS_PER_DAY = 24 * 60 * 60;

const EMPLOYERS = [
	'Acme Health',
	'Horizon Inc',
	'Northwind Co',
	'Zenith Group',
	'Evergreen Systems',
	'Summit Benefits',
	'Cedar Point Partners',
	'Atlas Workforce'
];

const FIRST_NAMES = [
	'Avery',
	'Blake',
	'Cameron',
	'Dakota',
	'Emerson',
	'Finley',
	'Gray',
	'Harper',
	'Indigo',
	'Jordan',
	'Kendall',
	'Logan',
	'Morgan',
	'Nico',
	'Parker',
	'Quinn',
	'Reese',
	'Skyler',
	'Taylor',
	'Val'
];

const LAST_NAMES = [
	'Adams',
	'Bennett',
	'Coleman',
	'Diaz',
	'Edwards',
	'Foster',
	'Garcia',
	'Hughes',
	'Irwin',
	'Jackson',
	'Kim',
	'Lopez',
	'Mitchell',
	'Nguyen',
	'Owens',
	'Patel',
	'Quintero',
	'Reed',
	'Shaw',
	'Turner'
];

function daysAgo(anchorUnix: number, days: number): number {
	return anchorUnix - days * SECONDS_PER_DAY;
}

function monthLabelFromDate(date: Date): string {
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(date: Date, deltaMonths: number): Date {
	return new Date(
		Date.UTC(
			date.getUTCFullYear(),
			date.getUTCMonth() + deltaMonths,
			15,
			date.getUTCHours(),
			date.getUTCMinutes(),
			date.getUTCSeconds()
		)
	);
}

function pickProfile(index: number): Profile {
	const mod = index % 12;
	if (mod <= 5) return 'high_engaged';
	if (mod <= 8) return 'stable_engaged';
	if (mod === 9) return 'watchlist';
	if (mod === 10) return 'reengaged';
	return 'new_no_session';
}

function getEnrollmentDaysAgo(index: number, profile: Profile): number {
	if (index % 4 === 0) return 4 + (index % 24);

	if (profile === 'high_engaged') return 8 + (index % 48);
	if (profile === 'stable_engaged') return 24 + (index % 76);
	if (profile === 'watchlist') return 45 + (index % 90);
	if (profile === 'reengaged') return 70 + (index % 170);
	return 6 + (index % 42);
}

function getLastSessionDaysAgo(index: number, profile: Profile): number | null {
	if (profile === 'high_engaged') return 1 + (index % 12);
	if (profile === 'stable_engaged') return 8 + (index % 32);
	if (profile === 'watchlist') return 38 + (index % 48);
	if (profile === 'reengaged') return 2 + (index % 10);
	return null;
}

function buildContact(args: {
	id: string;
	name: string;
	email: string;
	employer: string;
	registrationUnix: number;
	enrolledUnix: number;
}): ContactLike {
	return {
		id: args.id,
		role: 'user',
		name: args.name,
		email: args.email,
		custom_attributes: {
			[INTERCOM_ATTR_EMPLOYER]: args.employer,
			[INTERCOM_ATTR_REGISTRATION_DATE]: args.registrationUnix,
			[INTERCOM_ATTR_ENROLLED_DATE]: args.enrolledUnix
		}
	};
}

function buildConversation(args: {
	id: string;
	memberId: string;
	state?: 'closed' | 'open';
	channel: string;
	serviceCode: string;
	createdAtUnix: number;
	adminId: string | null;
}): ConversationLike {
	const created = args.createdAtUnix;
	return {
		id: args.id,
		state: args.state ?? 'closed',
		created_at: created,
		updated_at: created,
		admin_assignee_id: args.adminId,
		custom_attributes: {
			[INTERCOM_ATTR_CHANNEL]: args.channel,
			[INTERCOM_ATTR_SERVICE_CODE]: args.serviceCode
		},
		contacts: { contacts: [{ id: args.memberId }] },
		statistics: {
			last_close_at: created,
			last_admin_reply_at: created
		}
	};
}

function computeCaseloadExpected(args: {
	contacts: ContactLike[];
	conversations: ConversationLike[];
	anchorUnix: number;
	lookbackDays: number;
}) {
	const sinceUnix = args.anchorUnix - args.lookbackDays * SECONDS_PER_DAY;
	const allowedChannels = new Set<string>(STANDARD_REPORT_SESSION_CHANNELS);
	const seenConversationIds = new Set<string>();
	const memberLastSession = new Map<string, number>();
	let sessionsCount = 0;

	for (const conversation of args.conversations) {
		const id = String(conversation.id ?? '');
		if (id) {
			if (seenConversationIds.has(id)) continue;
			seenConversationIds.add(id);
		}

		if (conversation.state !== 'closed') continue;
		if (conversation.updated_at <= sinceUnix) continue;

		const channel = String(conversation.custom_attributes?.[INTERCOM_ATTR_CHANNEL] ?? '');
		if (!allowedChannels.has(channel)) continue;

		const memberId = String(conversation.contacts?.contacts?.[0]?.id ?? '');
		if (!memberId) continue;

		const sessionTime =
			conversation.statistics?.last_close_at ??
			conversation.statistics?.last_admin_reply_at ??
			conversation.updated_at ??
			conversation.created_at;
		if (!sessionTime) continue;

		sessionsCount += 1;
		const prev = memberLastSession.get(memberId) ?? 0;
		if (sessionTime > prev) memberLastSession.set(memberId, sessionTime);
	}

	const buckets = { bucket_1: 0, bucket_2: 0, bucket_3: 0, bucket_4: 0 };
	for (const lastSessionAt of memberLastSession.values()) {
		const days = (args.anchorUnix - lastSessionAt) / SECONDS_PER_DAY;
		if (days <= 7) buckets.bucket_1 += 1;
		else if (days <= 28) buckets.bucket_2 += 1;
		else if (days <= 56) buckets.bucket_3 += 1;
		else buckets.bucket_4 += 1;
	}

	return {
		totalMembers: memberLastSession.size,
		totalSessions: sessionsCount,
		buckets
	};
}

function computeNewParticipantsExpected(args: {
	contacts: ContactLike[];
	conversations: ConversationLike[];
	anchorUnix: number;
	lookbackDays: number;
}) {
	const sinceUnix = args.anchorUnix - args.lookbackDays * SECONDS_PER_DAY;
	const allowedChannels = new Set<string>(STANDARD_REPORT_SESSION_CHANNELS);
	const participantIds = new Set<string>();
	const participantAt = new Map<string, number>();

	for (const contact of args.contacts) {
		const enrolled = Number(contact.custom_attributes?.[INTERCOM_ATTR_ENROLLED_DATE] ?? NaN);
		if (Number.isFinite(enrolled) && enrolled > sinceUnix) {
			participantIds.add(contact.id);
			participantAt.set(contact.id, enrolled);
		}
	}

	const seenConversationIds = new Set<string>();
	const lastSessionByParticipant = new Map<string, number>();

	for (const conversation of args.conversations) {
		const id = String(conversation.id ?? '');
		if (id) {
			if (seenConversationIds.has(id)) continue;
			seenConversationIds.add(id);
		}

		if (conversation.state !== 'closed') continue;
		if (conversation.updated_at <= sinceUnix) continue;

		const channel = String(conversation.custom_attributes?.[INTERCOM_ATTR_CHANNEL] ?? '');
		if (!allowedChannels.has(channel)) continue;

		const sessionTime =
			conversation.statistics?.last_close_at ??
			conversation.statistics?.last_admin_reply_at ??
			conversation.updated_at ??
			conversation.created_at;
		if (!sessionTime) continue;

		for (const contactRef of conversation.contacts?.contacts ?? []) {
			const memberId = String(contactRef?.id ?? '');
			if (!participantIds.has(memberId)) continue;

			const prev = lastSessionByParticipant.get(memberId) ?? 0;
			if (sessionTime > prev) lastSessionByParticipant.set(memberId, sessionTime);
		}
	}

	const summary = { gt_14_to_21: 0, gt_21_to_28: 0, gt_28: 0 };

	for (const memberId of participantIds) {
		const lastSession = lastSessionByParticipant.get(memberId);
		const participantUnix = participantAt.get(memberId) ?? args.anchorUnix;
		const daysWithoutSession =
			lastSession != null
				? (args.anchorUnix - lastSession) / SECONDS_PER_DAY
				: (args.anchorUnix - participantUnix) / SECONDS_PER_DAY;

		if (daysWithoutSession > 28) summary.gt_28 += 1;
		else if (daysWithoutSession > 21) summary.gt_21_to_28 += 1;
		else if (daysWithoutSession > 14) summary.gt_14_to_21 += 1;
	}

	return {
		totalParticipants: participantIds.size,
		summary
	};
}

function computeBillingExpected(args: {
	contacts: ContactLike[];
	conversations: ConversationLike[];
	billingMonthLabel: string;
}) {
	const month = computeMonthWindow(args.billingMonthLabel, REPORT_TIMEZONE);
	const engagedTailWindowStartUnix = month.monthStartUnix - 56 * SECONDS_PER_DAY;
	const sessionChannels = new Set<string>(QUALIFYING_COACHING_CHANNELS);

	const seenConversationIds = new Set<string>();
	const lastSessionByMember = new Map<string, number>();

	for (const conversation of args.conversations) {
		const id = String(conversation.id ?? '');
		if (id) {
			if (seenConversationIds.has(id)) continue;
			seenConversationIds.add(id);
		}

		if (conversation.state !== 'closed') continue;
		if (conversation.created_at <= engagedTailWindowStartUnix) continue;
		if (conversation.created_at > month.monthEndUnix - 1) continue;

		const channel = String(conversation.custom_attributes?.[INTERCOM_ATTR_CHANNEL] ?? '');
		if (!sessionChannels.has(channel)) continue;

		const memberId = String(conversation.contacts?.contacts?.[0]?.id ?? '');
		if (!memberId) continue;

		const sessionTime =
			conversation.statistics?.last_close_at ??
			conversation.statistics?.last_admin_reply_at ??
			conversation.created_at;
		if (!sessionTime) continue;
		if (sessionTime < engagedTailWindowStartUnix || sessionTime >= month.monthEndUnix) continue;

		const prev = lastSessionByMember.get(memberId) ?? 0;
		if (sessionTime > prev) lastSessionByMember.set(memberId, sessionTime);
	}

	const newParticipantIds = new Set<string>();
	for (const contact of args.contacts) {
		const enrolled = Number(contact.custom_attributes?.[INTERCOM_ATTR_ENROLLED_DATE] ?? NaN);
		if (!Number.isFinite(enrolled)) continue;
		if (enrolled >= month.monthStartUnix && enrolled < month.monthEndUnix) {
			newParticipantIds.add(contact.id);
		}
	}

	const engagedIds = new Set<string>();
	for (const [memberId, lastSessionAt] of lastSessionByMember.entries()) {
		if (lastSessionAt >= engagedTailWindowStartUnix && lastSessionAt < month.monthEndUnix) {
			engagedIds.add(memberId);
		}
	}

	const unionIds = new Set<string>([...newParticipantIds, ...engagedIds]);
	let totalNewParticipants = 0;
	let totalEngagedDuringMonth = 0;

	for (const memberId of unionIds) {
		if (newParticipantIds.has(memberId)) totalNewParticipants += 1;
		if (engagedIds.has(memberId)) totalEngagedDuringMonth += 1;
	}

	return {
		totalRows: unionIds.size,
		totalNewParticipants,
		totalEngagedDuringMonth
	};
}

function computeOverviewExpected(args: {
	contacts: ContactLike[];
	conversations: ConversationLike[];
	anchorNow: Date;
	overviewMonthLabel: string;
}) {
	const comparison = computeMonthComparisonWindow(args.overviewMonthLabel, {
		now: args.anchorNow,
		timeZone: REPORT_TIMEZONE
	});

	function countContactsInRange(attrKey: string, startUnix: number, endUnix: number): number {
		return args.contacts.filter((contact) => {
			if (contact.role !== 'user') return false;
			const raw = Number(contact.custom_attributes?.[attrKey] ?? NaN);
			if (!Number.isFinite(raw)) return false;
			return raw >= startUnix && raw < endUnix;
		}).length;
	}

	function getContactIdsInRange(attrKey: string, startUnix: number, endUnix: number): Set<string> {
		const ids = new Set<string>();
		for (const contact of args.contacts) {
			if (contact.role !== 'user') continue;
			const raw = Number(contact.custom_attributes?.[attrKey] ?? NaN);
			if (!Number.isFinite(raw)) continue;
			if (raw < startUnix || raw >= endUnix) continue;
			ids.add(contact.id);
		}
		return ids;
	}

	function collectQualifyingSessions(
		startUnix: number,
		endUnix: number
	): Array<{ memberId: string; serviceCode: string }> {
		const seenConversationIds = new Set<string>();
		const sessions: Array<{ memberId: string; serviceCode: string }> = [];

		for (const conversation of args.conversations) {
			const id = String(conversation.id ?? '');
			if (id) {
				if (seenConversationIds.has(id)) continue;
				seenConversationIds.add(id);
			}

			const channel = conversation.custom_attributes?.[INTERCOM_ATTR_CHANNEL];
			const serviceCode = conversation.custom_attributes?.[INTERCOM_ATTR_SERVICE_CODE];
			if (!isQualifyingCoachingSession(channel, serviceCode)) continue;

			const createdAt = Number(conversation.created_at ?? NaN);
			if (!Number.isFinite(createdAt)) continue;
			if (createdAt < startUnix || createdAt >= endUnix) continue;

			const memberId = String(conversation.contacts?.contacts?.[0]?.id ?? '');
			if (!memberId) continue;

			sessions.push({
				memberId,
				serviceCode: String(serviceCode ?? '').trim() || 'Unspecified'
			});
		}

		return sessions;
	}

	function computeConversion(
		registeredIds: Set<string>,
		sessions: Array<{ memberId: string; serviceCode: string }>
	) {
		const withSession = new Set(sessions.map((session) => session.memberId));
		let withQualifyingSessionCount = 0;
		for (const id of registeredIds) {
			if (withSession.has(id)) withQualifyingSessionCount += 1;
		}

		const registeredCount = registeredIds.size;
		return {
			registeredCount,
			withQualifyingSessionCount,
			pct:
				registeredCount === 0
					? null
					: Number(((withQualifyingSessionCount / registeredCount) * 100).toFixed(2))
		};
	}

	function computeServiceCodeRows(sessions: Array<{ serviceCode: string }>) {
		const counts = new Map<string, number>();
		for (const session of sessions) {
			counts.set(session.serviceCode, (counts.get(session.serviceCode) ?? 0) + 1);
		}

		const total = sessions.length;
		return [...counts.entries()]
			.map(([serviceCode, count]) => ({
				serviceCode,
				count,
				sharePct: total === 0 ? 0 : Number(((count / total) * 100).toFixed(2))
			}))
			.sort((a, b) => {
				if (b.count !== a.count) return b.count - a.count;
				return a.serviceCode.localeCompare(b.serviceCode);
			});
	}

	function collectAllChannelSessionsForServiceCode(
		startUnix: number,
		endUnix: number
	): Array<{ serviceCode: string }> {
		const seenConversationIds = new Set<string>();
		const allowedChannels = new Set<string>(STANDARD_REPORT_SESSION_CHANNELS);
		const sessions: Array<{ serviceCode: string }> = [];

		for (const conversation of args.conversations) {
			const id = String(conversation.id ?? '');
			if (id) {
				if (seenConversationIds.has(id)) continue;
				seenConversationIds.add(id);
			}

			if (conversation.state !== 'closed') continue;

			const createdAt = Number(conversation.created_at ?? NaN);
			if (!Number.isFinite(createdAt)) continue;
			if (createdAt < startUnix || createdAt >= endUnix) continue;

			const channel = String(conversation.custom_attributes?.[INTERCOM_ATTR_CHANNEL] ?? '');
			if (!allowedChannels.has(channel)) continue;

			const serviceCode = String(conversation.custom_attributes?.[INTERCOM_ATTR_SERVICE_CODE] ?? '').trim();
			sessions.push({ serviceCode: serviceCode || 'Unspecified' });
		}

		return sessions;
	}

	const currentQualifyingSessions = collectQualifyingSessions(
		comparison.current.month.monthStartUnix,
		comparison.current.elapsedEndUnix
	);
	const priorQualifyingSessions = collectQualifyingSessions(
		comparison.prior.month.monthStartUnix,
		comparison.prior.elapsedEndUnix
	);
	const currentRegisteredIds = getContactIdsInRange(
		INTERCOM_ATTR_REGISTRATION_DATE,
		comparison.current.month.monthStartUnix,
		comparison.current.elapsedEndUnix
	);
	const priorRegisteredIds = getContactIdsInRange(
		INTERCOM_ATTR_REGISTRATION_DATE,
		comparison.prior.month.monthStartUnix,
		comparison.prior.elapsedEndUnix
	);
	const currentAllChannelSessions = collectAllChannelSessionsForServiceCode(
		comparison.current.month.monthStartUnix,
		comparison.current.elapsedEndUnix
	);

	return {
		newRegistrationsMtd: {
			count: countContactsInRange(
				INTERCOM_ATTR_REGISTRATION_DATE,
				comparison.current.month.monthStartUnix,
				comparison.current.elapsedEndUnix
			),
			priorCount: countContactsInRange(
				INTERCOM_ATTR_REGISTRATION_DATE,
				comparison.prior.month.monthStartUnix,
				comparison.prior.elapsedEndUnix
			)
		},
		newEnrolleesMtd: {
			count: countContactsInRange(
				INTERCOM_ATTR_ENROLLED_DATE,
				comparison.current.month.monthStartUnix,
				comparison.current.elapsedEndUnix
			),
			priorCount: countContactsInRange(
				INTERCOM_ATTR_ENROLLED_DATE,
				comparison.prior.month.monthStartUnix,
				comparison.prior.elapsedEndUnix
			)
		},
		qualifyingSessionsMtd: {
			count: currentQualifyingSessions.length,
			priorCount: priorQualifyingSessions.length
		},
		enrollmentSnapshot: {
			newlyRegisteredWithQualifyingSessionMtd: {
				current: computeConversion(currentRegisteredIds, currentQualifyingSessions),
				prior: computeConversion(priorRegisteredIds, priorQualifyingSessions)
			}
		},
		caseloadTrends: {
			sessionsByServiceCodeMtd: computeServiceCodeRows(currentAllChannelSessions)
		}
	};
}

export function buildSyntheticEngagementData(opts: SyntheticDataOptions = {}): SyntheticEngagementData {
	const anchorNow = opts.anchorNow ? new Date(opts.anchorNow) : new Date('2026-03-02T12:00:00.000Z');
	const anchorUnix = Math.floor(anchorNow.getTime() / 1000);
	const memberCount = Math.max(120, Math.floor(opts.memberCount ?? 360));
	const lookbackDays = 90;
	const currentMonthLabel = monthLabelFromDate(anchorNow);
	const currentMonthWindow = computeMonthWindow(currentMonthLabel, REPORT_TIMEZONE);
	const currentMonthCohortSize = Math.max(24, Math.floor(memberCount * 0.18));
	const latestCurrentMonthUnix = Math.max(
		currentMonthWindow.monthStartUnix + 6 * 60 * 60,
		Math.min(anchorUnix - 15 * 60, currentMonthWindow.monthStartUnix + 2 * SECONDS_PER_DAY)
	);
	const priorMonthLabel = monthLabelFromDate(shiftMonth(anchorNow, -1));

	const admins: AdminLike[] = [
		{ id: 'adm-1', name: 'Coach Rivera', email: 'coach.rivera@example.test' },
		{ id: 'adm-2', name: 'Coach Chen', email: 'coach.chen@example.test' },
		{ id: 'adm-3', name: 'Coach Patel', email: 'coach.patel@example.test' },
		{ id: 'adm-4', name: 'Coach Wright', email: 'coach.wright@example.test' },
		{ id: 'adm-5', name: 'Coach Larson', email: 'coach.larson@example.test' },
		{ id: 'adm-6', name: 'Coach Singh', email: 'coach.singh@example.test' }
	];

	const contacts: ContactLike[] = [];
	const conversations: ConversationLike[] = [];
	let conversationCounter = 1;

	for (let index = 1; index <= memberCount; index += 1) {
		const memberId = `u${String(index).padStart(4, '0')}`;
		const employer = EMPLOYERS[index % EMPLOYERS.length];
		const firstName = FIRST_NAMES[index % FIRST_NAMES.length];
		const lastName = LAST_NAMES[Math.floor(index / 2) % LAST_NAMES.length];
		const profile = pickProfile(index);
		let enrolledUnix: number;
		let registrationUnix: number;

		if (index <= currentMonthCohortSize) {
			const enrollmentOffsetWindow = Math.max(
				1,
				latestCurrentMonthUnix - currentMonthWindow.monthStartUnix - 4 * 60 * 60
			);
			const enrollmentOffset = ((index * 6 * 60 * 60) % enrollmentOffsetWindow) + 3 * 60 * 60;
			enrolledUnix = currentMonthWindow.monthStartUnix + enrollmentOffset;
			registrationUnix = Math.max(
				currentMonthWindow.monthStartUnix + 60 * 60,
				enrolledUnix - (2 + (index % 4)) * 60 * 60
			);
		} else {
			const enrolledDaysAgo = getEnrollmentDaysAgo(index, profile);
			const registrationDaysAgo = enrolledDaysAgo + 1 + (index % 3);
			enrolledUnix = daysAgo(anchorUnix, enrolledDaysAgo);
			registrationUnix = daysAgo(anchorUnix, registrationDaysAgo);
		}

		contacts.push(
			buildContact({
				id: memberId,
				name: `${firstName} ${lastName}`,
				email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${index}@example.test`,
				employer,
				registrationUnix,
				enrolledUnix
			})
		);

		const lastSessionDaysAgo = getLastSessionDaysAgo(index, profile);
		if (lastSessionDaysAgo != null) {
			const sessionDaysAgoList: number[] = [lastSessionDaysAgo];

			if (profile === 'high_engaged') {
				sessionDaysAgoList.push(lastSessionDaysAgo + 8 + (index % 10));
				if (index % 2 === 0) sessionDaysAgoList.push(lastSessionDaysAgo + 18 + (index % 14));
			} else if (profile === 'stable_engaged') {
				sessionDaysAgoList.push(lastSessionDaysAgo + 12 + (index % 20));
			} else if (profile === 'watchlist') {
				if (index % 3 === 0) sessionDaysAgoList.push(lastSessionDaysAgo + 10 + (index % 14));
			} else if (profile === 'reengaged') {
				sessionDaysAgoList.push(75 + (index % 60));
			}

			for (let j = 0; j < sessionDaysAgoList.length; j += 1) {
				const days = sessionDaysAgoList[j];
				const channel = STANDARD_REPORT_SESSION_CHANNELS[(index + j) % STANDARD_REPORT_SESSION_CHANNELS.length];
				const isCallChannel = channel === 'Phone' || channel === 'Video Conference';
				const serviceCode =
					isCallChannel && (index + j) % 7 !== 0
						? (index + j) % 2 === 0
							? 'Health Coaching 001'
							: 'Disease Management 002'
						: 'Support 000';

				const conversation = buildConversation({
					id: `c${String(conversationCounter).padStart(6, '0')}`,
					memberId,
					channel,
					serviceCode,
					createdAtUnix: daysAgo(anchorUnix, days),
					adminId: admins[(index + j) % admins.length].id
				});
				conversations.push(conversation);

				// Intentional duplicate IDs to keep de-duplication test coverage active.
				if (index % 45 === 0 && j === 0) {
					conversations.push({ ...conversation });
				}

				conversationCounter += 1;
			}

			// Some open conversations should not affect jobs that require closed state.
			if (index % 30 === 0) {
				conversations.push(
					buildConversation({
						id: `c${String(conversationCounter).padStart(6, '0')}`,
						memberId,
						state: 'open',
						channel: 'Phone',
						serviceCode: 'Health Coaching 001',
						createdAtUnix: daysAgo(anchorUnix, Math.max(1, lastSessionDaysAgo - 1)),
						adminId: admins[index % admins.length].id
					})
				);
				conversationCounter += 1;
			}
		}
	}

	const caseload = computeCaseloadExpected({
		contacts,
		conversations,
		anchorUnix,
		lookbackDays
	});
	const newParticipants = computeNewParticipantsExpected({
		contacts,
		conversations,
		anchorUnix,
		lookbackDays
	});
	const billing = computeBillingExpected({
		contacts,
		conversations,
		billingMonthLabel: priorMonthLabel
	});
	const overview = computeOverviewExpected({
		contacts,
		conversations,
		anchorNow,
		overviewMonthLabel: priorMonthLabel
	});

	return {
		anchorNow,
		admins,
		contacts,
		conversations,
		expected: {
			anchorNowIso: anchorNow.toISOString(),
			lookbackDays,
			billingMonthLabel: priorMonthLabel,
			overviewMonthLabel: priorMonthLabel,
			caseload,
			newParticipants,
			billing,
			overview
		}
	};
}
