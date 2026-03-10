export type DefinitionItem = {
	term: string;
	description: string;
};

export const sdDefinitionsByRoute: Record<string, DefinitionItem[]> = {
	'/sd/enrollments': [
		{
			term: 'Total Enrollments',
			description: 'Members with Enrollment Date before reporting end date.'
		},
		{
			term: 'New Enrollments',
			description: 'Members with Enrollment Date inside the selected reporting period.'
		},
		{
			term: 'Program',
			description: 'Intercom contact custom attribute: Eligible Programs.'
		},
		{
			term: 'Employer',
			description: 'Intercom contact custom attribute: Employer.'
		}
	],
	'/sd/coaching-activity': [
		{
			term: 'Coach Encounter',
			description: 'Closed Intercom conversation associated with a valid user contact.'
		},
		{
			term: 'Unique Members',
			description: 'Distinct members with at least one encounter in reporting period.'
		},
		{
			term: 'Directionality',
			description: 'Bidirectional, Unidirectional, or Other based on author/message rules.'
		},
		{
			term: 'Coach',
			description: 'Last teammate/admin responder for the conversation.'
		}
	],
	'/sd/scheduling': [
		{
			term: 'Session Date',
			description: 'When the session is scheduled to occur (starting_time).'
		},
		{
			term: 'Created Date',
			description: 'When the booking record was created.'
		},
		{
			term: 'Missed Sessions',
			description: 'Sessions with status Rescheduled or No-Show.'
		},
		{
			term: 'Date Basis',
			description: 'Controls whether reporting period applies to Session Date or Created Date.'
		}
	]
};
