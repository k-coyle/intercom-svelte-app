import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
import UsersIcon from '@lucide/svelte/icons/users';
import CalendarDaysIcon from '@lucide/svelte/icons/calendar-days';
import UserPlusIcon from '@lucide/svelte/icons/user-plus';
import ReceiptIcon from '@lucide/svelte/icons/receipt';

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
	{ label: 'Billing', href: '/engagement/billing', icon: ReceiptIcon }
];
