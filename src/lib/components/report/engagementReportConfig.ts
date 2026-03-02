export type ReportKey = 'overview' | 'caseload' | 'sessions' | 'enrolled' | 'billing';

export type KpiItem = {
	label: string;
	value: string | number;
	deltaLabel: string;
	deltaPct: string;
	trend: 'up' | 'down' | 'flat';
	points: number[];
};

export type TableColumn = {
	key: string;
	header: string;
	className?: string;
};

type PanelConfig = {
	title: string;
	kind: 'summary' | 'distribution' | 'trend' | 'notes' | 'endpoints';
	timeframe?: string;
	lines: string[];
};

type TableConfig = {
	title: string;
	columns: TableColumn[];
	rows: Record<string, any>[];
	footerText?: string;
};

export type EngagementReportLayout = {
	pageTitle: string;
	pageSubtitle: string;
	topKpis: KpiItem[];
	midLeftPanel: PanelConfig;
	midRightPanel: PanelConfig;
	bottomLeftPanel: PanelConfig;
	bottomRightTable: TableConfig;
};

const actionColumn: TableColumn = { key: '__actions', header: '', className: 'w-12 text-right' };

export const engagementReportConfig: Record<ReportKey, EngagementReportLayout> = {
	overview: {
		pageTitle: 'Overview',
		pageSubtitle: 'Monthly engagement summary for registration, enrollment, and coaching activity.',
		topKpis: [
			{
				label: 'New registrations (MTD)',
				value: '1,475',
				deltaLabel: '+120',
				deltaPct: '+8.9%',
				trend: 'up',
				points: [18, 21, 22, 24, 23, 26, 27, 29, 30, 34, 36, 38]
			},
			{
				label: 'New enrollees (MTD)',
				value: '843',
				deltaLabel: '+58',
				deltaPct: '+7.4%',
				trend: 'up',
				points: [10, 11, 13, 12, 12, 14, 15, 17, 18, 19, 22, 23]
			},
			{
				label: 'Qualifying coaching sessions (MTD)',
				value: '5,430',
				deltaLabel: '-112',
				deltaPct: '-2.1%',
				trend: 'down',
				points: [58, 60, 61, 60, 62, 63, 62, 64, 63, 62, 61, 60]
			}
		],
		midLeftPanel: {
			title: 'Enrollment Snapshot',
			kind: 'summary',
			lines: [
				'65% engaged participants in current filtered population.',
				'21% at-risk participants by latest engagement classification.',
				'14% unengaged participants requiring outreach.'
			]
		},
		midRightPanel: {
			title: 'Caseload Trends',
			kind: 'trend',
			timeframe: 'Last 30 days',
			lines: []
		},
		bottomLeftPanel: {
			title: 'Background Jobs / API Endpoints',
			kind: 'endpoints',
			lines: [
				'POST /API/engagement/session-sync',
				'POST /API/engagement/engagement-sync',
				'POST /API/engagement/referral-sync',
				'POST /API/engagement/report/engagement',
				'First three endpoints update Intercom attributes; last endpoint produces a reporting stream.'
			]
		},
		bottomRightTable: {
			title: 'Recent Activity',
			columns: [
				{ key: 'name', header: 'Name' },
				{ key: 'summary', header: 'Summary' },
				{ key: 'lastActive', header: 'Last Active' },
				actionColumn
			],
			rows: [
				{ name: 'Ralph Smith', summary: 'First Coaching Session', lastActive: '6h ago' },
				{ name: 'Wade Warren', summary: 'Video Coaching', lastActive: '2d ago' },
				{ name: 'Annette Black', summary: 'Chat Follow-up', lastActive: '2d ago' },
				{ name: 'Cameron William', summary: 'Phone Coaching', lastActive: '3d ago' }
			],
			footerText: 'Showing 1-4 of 50 entries'
		}
	},
	caseload: {
		pageTitle: 'Caseload',
		pageSubtitle: 'Member recency and channel distribution grouped by coaching activity windows.',
		topKpis: [
			{
				label: 'Active in <= 7 days',
				value: '231',
				deltaLabel: '+14',
				deltaPct: '+6.5%',
				trend: 'up',
				points: [13, 13, 14, 14, 15, 16, 16, 17, 18, 18, 19, 20]
			},
			{
				label: '8-28 days since session',
				value: '402',
				deltaLabel: '-9',
				deltaPct: '-2.2%',
				trend: 'down',
				points: [38, 39, 40, 39, 38, 37, 36, 36, 35, 34, 34, 33]
			},
			{
				label: '29-56 days since session',
				value: '266',
				deltaLabel: '+4',
				deltaPct: '+1.5%',
				trend: 'up',
				points: [24, 24, 23, 23, 22, 22, 21, 21, 22, 22, 23, 23]
			},
			{
				label: '> 56 days since session',
				value: '187',
				deltaLabel: '+12',
				deltaPct: '+6.9%',
				trend: 'up',
				points: [12, 12, 13, 13, 13, 14, 15, 15, 16, 16, 17, 18]
			}
		],
		midLeftPanel: {
			title: 'Distribution Summary',
			kind: 'distribution',
			lines: [
				'Phone + Video remains the most common channel combination.',
				'Email-only activity is concentrated in older recency buckets.',
				'Chat usage remains stable month over month.'
			]
		},
		midRightPanel: {
			title: 'Recency Trend',
			kind: 'trend',
			timeframe: 'Last 30 days',
			lines: []
		},
		bottomLeftPanel: {
			title: 'Bucket Rules',
			kind: 'notes',
			lines: [
				'Bucket 1: last session <= 7 days.',
				'Bucket 2: last session 8-28 days.',
				'Bucket 3: last session 29-56 days.',
				'Bucket 4: last session > 56 days.'
			]
		},
		bottomRightTable: {
			title: 'Coach Caseload Detail',
			columns: [
				{ key: 'coach', header: 'Coach' },
				{ key: 'members', header: 'Members' },
				{ key: 'bucket1', header: '<=7d' },
				{ key: 'bucket2', header: '8-28d' },
				{ key: 'bucket3', header: '29-56d' },
				{ key: 'bucket4', header: '>56d' },
				actionColumn
			],
			rows: [
				{ coach: 'Coach A', members: 130, bucket1: 41, bucket2: 56, bucket3: 22, bucket4: 11 },
				{ coach: 'Coach B', members: 98, bucket1: 28, bucket2: 39, bucket3: 19, bucket4: 12 },
				{ coach: 'Coach C', members: 115, bucket1: 34, bucket2: 49, bucket3: 20, bucket4: 12 }
			],
			footerText: 'Showing 1-3 of 12 entries'
		}
	},
	sessions: {
		pageTitle: 'Sessions',
		pageSubtitle: 'Session-level detail for qualifying conversations across channels and coaches.',
		topKpis: [
			{
				label: 'Total sessions (window)',
				value: '2,904',
				deltaLabel: '+104',
				deltaPct: '+3.7%',
				trend: 'up',
				points: [42, 44, 45, 47, 46, 49, 50, 51, 52, 54, 55, 57]
			},
			{
				label: 'Unique members',
				value: '1,102',
				deltaLabel: '+26',
				deltaPct: '+2.4%',
				trend: 'up',
				points: [19, 19, 20, 20, 21, 21, 22, 22, 23, 24, 24, 25]
			},
			{
				label: 'Avg sessions/member',
				value: '2.64',
				deltaLabel: '+0.08',
				deltaPct: '+3.1%',
				trend: 'up',
				points: [2.3, 2.4, 2.4, 2.5, 2.5, 2.5, 2.6, 2.6, 2.6, 2.7, 2.7, 2.7]
			}
		],
		midLeftPanel: {
			title: 'Session Mix',
			kind: 'summary',
			lines: [
				'Phone and Video represent the highest-volume channels.',
				'Email sessions are mostly follow-up interactions.',
				'Chat volume is concentrated in short recency windows.'
			]
		},
		midRightPanel: {
			title: 'Session Volume Trend',
			kind: 'trend',
			timeframe: 'Last 30 days',
			lines: []
		},
		bottomLeftPanel: {
			title: 'Session Notes',
			kind: 'notes',
			lines: [
				'Rows represent individual qualifying sessions.',
				'Session timestamps are sorted newest first.',
				'Filters apply by coach, employer, and channel.'
			]
		},
		bottomRightTable: {
			title: 'Session Channel Detail',
			columns: [
				{ key: 'month', header: 'Month' },
				{ key: 'phone', header: 'Phone' },
				{ key: 'video', header: 'Video' },
				{ key: 'email', header: 'Email' },
				{ key: 'chat', header: 'Chat' },
				actionColumn
			],
			rows: [
				{ month: '2026-02', phone: 481, video: 352, email: 190, chat: 144 },
				{ month: '2026-01', phone: 460, video: 347, email: 182, chat: 140 },
				{ month: '2025-12', phone: 434, video: 325, email: 171, chat: 128 }
			],
			footerText: 'Showing 1-3 of 12 entries'
		}
	},
	enrolled: {
		pageTitle: 'Enrolled Participants',
		pageSubtitle: 'Recently enrolled members and their coaching follow-up progression.',
		topKpis: [
			{
				label: 'Participants loaded',
				value: '689',
				deltaLabel: '+32',
				deltaPct: '+4.9%',
				trend: 'up',
				points: [9, 10, 10, 11, 11, 12, 12, 12, 13, 13, 14, 14]
			},
			{
				label: '15-21 days without session',
				value: '88',
				deltaLabel: '-6',
				deltaPct: '-6.4%',
				trend: 'down',
				points: [12, 12, 11, 11, 10, 10, 9, 9, 9, 8, 8, 8]
			},
			{
				label: '> 28 days without session',
				value: '47',
				deltaLabel: '-4',
				deltaPct: '-7.8%',
				trend: 'down',
				points: [8, 8, 8, 7, 7, 7, 6, 6, 6, 5, 5, 5]
			}
		],
		midLeftPanel: {
			title: 'Follow-up Summary',
			kind: 'summary',
			lines: [
				'Most enrolled members receive a session within 14 days.',
				'22-28 day bucket is trending down this month.',
				'No-session group is monitored with daily outreach.'
			]
		},
		midRightPanel: {
			title: 'Enrollment Trend',
			kind: 'trend',
			timeframe: 'Last 30 days',
			lines: []
		},
		bottomLeftPanel: {
			title: 'Participant Buckets',
			kind: 'notes',
			lines: [
				'15-21 days without session.',
				'22-28 days without session.',
				'More than 28 days without session.'
			]
		},
		bottomRightTable: {
			title: 'Recent Enrollments',
			columns: [
				{ key: 'name', header: 'Member' },
				{ key: 'enrolledDate', header: 'Enrolled Date' },
				{ key: 'coach', header: 'Coach' },
				{ key: 'daysWithoutSession', header: 'Days Without Session' },
				actionColumn
			],
			rows: [
				{ name: 'Allison Reed', enrolledDate: '2026-02-11', coach: 'Coach A', daysWithoutSession: 19 },
				{ name: 'Bernard Lee', enrolledDate: '2026-02-08', coach: 'Coach C', daysWithoutSession: 14 },
				{ name: 'Clara Smith', enrolledDate: '2026-02-03', coach: 'Coach B', daysWithoutSession: 23 }
			],
			footerText: 'Showing 1-3 of 145 entries'
		}
	},
	billing: {
		pageTitle: 'Billing',
		pageSubtitle: 'Month-specific billable cohort from enrollment and qualifying engagement activity.',
		topKpis: [
			{
				label: 'Total billable users',
				value: '1,263',
				deltaLabel: '+54',
				deltaPct: '+4.5%',
				trend: 'up',
				points: [21, 22, 22, 23, 23, 24, 24, 25, 26, 26, 27, 28]
			},
			{
				label: 'New participants in month',
				value: '402',
				deltaLabel: '+21',
				deltaPct: '+5.5%',
				trend: 'up',
				points: [7, 7, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11]
			},
			{
				label: 'Engaged during month',
				value: '971',
				deltaLabel: '+33',
				deltaPct: '+3.5%',
				trend: 'up',
				points: [16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21]
			}
		],
		midLeftPanel: {
			title: 'Billing Cohort Summary',
			kind: 'summary',
			lines: [
				'Billable cohort is the union of new participants and engaged members in month.',
				'Overlap identifies members counted in both cohort segments.',
				'Month windows are evaluated in America/New_York.'
			]
		},
		midRightPanel: {
			title: 'Billing Trend',
			kind: 'trend',
			timeframe: 'Last 30 days',
			lines: []
		},
		bottomLeftPanel: {
			title: 'Billing Rules',
			kind: 'notes',
			lines: [
				'New participant: Enrolled Date in selected month.',
				'Engaged during month: latest qualifying session in [monthStart-56d, monthEnd).',
				'Filter views by employer without changing source cohort logic.'
			]
		},
		bottomRightTable: {
			title: 'Billable Members',
			columns: [
				{ key: 'member', header: 'Member' },
				{ key: 'employer', header: 'Employer' },
				{ key: 'enrolledDate', header: 'Enrolled Date' },
				{ key: 'lastSession', header: 'Last Session' },
				actionColumn
			],
			rows: [
				{
					member: 'Mona Patel',
					employer: 'Acme Health',
					enrolledDate: '2026-02-02',
					lastSession: '2026-02-19'
				},
				{
					member: 'James Fuller',
					employer: 'Acme Health',
					enrolledDate: '2026-01-14',
					lastSession: '2026-02-16'
				},
				{
					member: 'Taylor Lin',
					employer: 'Northwest Co',
					enrolledDate: '2026-02-07',
					lastSession: '2026-02-18'
				}
			],
			footerText: 'Showing 1-3 of 500 entries'
		}
	}
};
