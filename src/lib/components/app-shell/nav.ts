import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
import UsersIcon from '@lucide/svelte/icons/users';
import CalendarDaysIcon from '@lucide/svelte/icons/calendar-days';
import UserPlusIcon from '@lucide/svelte/icons/user-plus';
import ReceiptIcon from '@lucide/svelte/icons/receipt';
import BarChart3Icon from '@lucide/svelte/icons/bar-chart-3';
import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
import CalendarRangeIcon from '@lucide/svelte/icons/calendar-range';

export type NavItem = {
	label: string;
	href: string;
	icon: any;
};

export const engagementNav: NavItem[] = [
	{ label: 'Overview', href: '/engagement', icon: LayoutDashboardIcon },
	{ label: 'Caseload', href: '/engagement/caseload', icon: UsersIcon },
	{ label: 'Sessions', href: '/engagement/sessions', icon: CalendarDaysIcon },
	{ label: 'Enrolled', href: '/engagement/new-participants', icon: UserPlusIcon },
	{ label: 'Billing', href: '/engagement/billing', icon: ReceiptIcon },
	{ label: 'History', href: '/engagement/history', icon: BarChart3Icon }
];

export const sdNav: NavItem[] = [
	{ label: 'Enrollments', href: '/sd/enrollments', icon: BarChart3Icon },
	{ label: 'Coaching Activity', href: '/sd/coaching-activity', icon: MessagesSquareIcon },
	{ label: 'Scheduling', href: '/sd/scheduling', icon: CalendarRangeIcon },
	{ label: 'Incoming Referrals', href: '/sd/referrals/incoming', icon: UserPlusIcon },
	{ label: 'Outgoing Referrals', href: '/sd/referrals/outgoing', icon: ReceiptIcon }
];
