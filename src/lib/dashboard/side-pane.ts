/**
 * The dashboard's Display choice (card 2526): which of the side pane's panels
 * are drawn, whether the pane is drawn at all, and the boards list's done-board
 * and done-sub switches. Set from the Display menu above Your Boards, and the
 * viewer's own, in this browser, so the dashboard opens the way it was left.
 *
 * It is kept in a cookie per user (`dumpfire-dashboard-display-<user>`), not
 * in `localStorage`, so that the dashboard's load reads it and the server
 * draws the page as it was left: with storage the server drew the defaults
 * and the stored choice came in as the page woke, so a hidden pane flashed up
 * on every reload. The page writes it from the browser (`document.cookie`,
 * so it is not HttpOnly); the load reads it with `cookies.get` and parses it
 * with `parseDashboardDisplay`, which needs no browser. A cookie that cannot
 * be written (cookies blocked) is said nothing about: the choice still works,
 * and the dashboard opens with the defaults on reload.
 */

/** The side pane's switchable groups, in the order the pane draws them, each with its label in the menu. */
export const SIDE_PANE_PANELS = [
	{ key: 'figures', label: 'Figure tiles' },
	{ key: 'priority', label: 'Priority Spread' },
	{ key: 'health', label: 'Board Health Overview' },
	{ key: 'trend', label: '4-Week Trend' },
	{ key: 'categories', label: 'Category Distribution' },
	{ key: 'aging', label: 'Task Aging' },
	{ key: 'team', label: 'Team Leaderboard' },
	{ key: 'xp', label: 'XP Leaderboard' },
	{ key: 'deadlines', label: 'Upcoming Deadlines' },
	{ key: 'quick', label: 'Quick figures' },
	{ key: 'activity', label: 'Recent Activity' }
] as const;

export type SidePanePanel = (typeof SIDE_PANE_PANELS)[number]['key'];

export type DashboardDisplay = {
	/** The panels switched off, in the pane's order. */
	hiddenPanels: SidePanePanel[];
	/** The whole pane switched off; the panels' own choices are kept for when it is back. */
	paneHidden: boolean;
	/** Boards whose every card is done are listed. */
	showCompletedBoards: boolean;
	/** Sub-boards whose every card is done are listed. */
	showCompletedSubs: boolean;
};

/** What the dashboard shows when nothing says otherwise: every panel, done boards listed, done subs not. */
export const DASHBOARD_DISPLAY: DashboardDisplay = {
	hiddenPanels: [],
	paneHidden: false,
	showCompletedBoards: true,
	showCompletedSubs: false
};

/** A fresh copy of the defaults, which a caller may keep and change. */
export function defaultDisplay(): DashboardDisplay {
	return { ...DASHBOARD_DISPLAY, hiddenPanels: [] };
}

/** The cookie's name: one viewer's dashboard display choice. */
export function dashboardDisplayCookie(userId: number): string {
	return `dumpfire-dashboard-display-${userId}`;
}

/** A year, in seconds: how long the cookie is kept since it was last written. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * A choice from the cookie's value, already decoded (`cookies.get` decodes it).
 * The defaults when there is none or it is not JSON of an object. A panel or
 * field it does not know is ignored, and each field it does know but cannot
 * read falls back to its default on its own. Reads nothing of the browser, so
 * the server's load uses it.
 */
export function parseDashboardDisplay(raw: string | null | undefined): DashboardDisplay {
	if (!raw) return defaultDisplay();
	let stored: unknown;
	try {
		stored = JSON.parse(raw);
	} catch {
		return defaultDisplay();
	}
	if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return defaultDisplay();
	const { hiddenPanels, paneHidden, showCompletedBoards, showCompletedSubs } = stored as Record<string, unknown>;
	const hidden = new Set<unknown>(Array.isArray(hiddenPanels) ? hiddenPanels : []);
	return {
		// The panels it knows, in the pane's order, once each, whatever was stored.
		hiddenPanels: SIDE_PANE_PANELS.map((p) => p.key).filter((k) => hidden.has(k)),
		paneHidden: paneHidden === true,
		showCompletedBoards: typeof showCompletedBoards === 'boolean' ? showCompletedBoards : DASHBOARD_DISPLAY.showCompletedBoards,
		showCompletedSubs: typeof showCompletedSubs === 'boolean' ? showCompletedSubs : DASHBOARD_DISPLAY.showCompletedSubs
	};
}

/**
 * The cookie that holds the choice, as `document.cookie` takes it: the
 * URI-encoded JSON, for the whole site, kept a year, sent on a link from
 * another site but not on its requests (Lax).
 */
export function dashboardDisplayCookieText(userId: number, display: DashboardDisplay): string {
	return `${dashboardDisplayCookie(userId)}=${encodeURIComponent(JSON.stringify(display))}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}

/** Remembers the choice, in the browser. With no viewer, or cookies that cannot be written, it remembers nothing, and says nothing. */
export function writeDashboardDisplay(userId: number | null | undefined, display: DashboardDisplay): void {
	if (typeof userId !== 'number') return;
	try {
		document.cookie = dashboardDisplayCookieText(userId, display);
	} catch {
		// Blocked, or no document (the server): the dashboard still changes, and opens with the defaults on reload.
	}
}

/** The choice with one panel switched on or off, the rest as they were. */
export function withPanel(display: DashboardDisplay, key: SidePanePanel, shown: boolean): DashboardDisplay {
	const hidden = new Set<string>(display.hiddenPanels);
	if (shown) hidden.delete(key);
	else hidden.add(key);
	return { ...display, hiddenPanels: SIDE_PANE_PANELS.map((p) => p.key).filter((k) => hidden.has(k)) };
}

/** What decides whether a panel has anything to draw: the load's analytics, and the two counts the page works out. */
export type SidePaneContent = {
	analytics: {
		active: number;
		boardHealth: unknown[];
		weeklyTrend: { count: number }[];
		categoryDistribution: { count: number }[];
		teamLeaderboard: unknown[];
		recentActivity: unknown[];
	};
	/** How many people GET /api/xp last listed. */
	xpCount: number;
	/** How many deadlines Upcoming Deadlines lists, from `dueFigures` on the page's clock. */
	upcomingCount: number;
};

/**
 * Whether a panel has anything to draw, switched on or not: the one test the
 * sidebar draws each panel by and the page decides its column by. The figure
 * tiles and the quick figures are always drawn; each other panel only with
 * something in it, as before card 2526.
 */
export function panelHasContent(key: SidePanePanel, content: SidePaneContent): boolean {
	const a = content.analytics;
	switch (key) {
		case 'figures':
		case 'quick':
			return true;
		case 'priority':
		case 'aging':
			return a.active > 0;
		case 'health':
			return a.boardHealth.length > 0;
		case 'trend':
			return a.weeklyTrend.some((w) => w.count > 0);
		case 'categories':
			return a.categoryDistribution.some((c) => c.count > 0);
		case 'team':
			return a.teamLeaderboard.length > 0;
		case 'xp':
			return content.xpCount > 0;
		case 'deadlines':
			return content.upcomingCount > 0;
		case 'activity':
			return a.recentActivity.length > 0;
	}
}

/**
 * True while the side pane has something to draw: it is switched on, and at
 * least one panel switched on has something in it. Otherwise the page draws
 * no column, and the boards take the width.
 */
export function sidePaneShown(display: DashboardDisplay, content: SidePaneContent): boolean {
	return !display.paneHidden && SIDE_PANE_PANELS.some((p) => !display.hiddenPanels.includes(p.key) && panelHasContent(p.key, content));
}

/** True while any of the choice is off its default: the Display button's dot. */
export function displayChanged(display: DashboardDisplay): boolean {
	return (
		display.showCompletedBoards !== DASHBOARD_DISPLAY.showCompletedBoards ||
		display.showCompletedSubs !== DASHBOARD_DISPLAY.showCompletedSubs ||
		display.paneHidden ||
		display.hiddenPanels.length > 0
	);
}

/** The Display button's title: what it holds, or what is changed from the defaults. */
export function displayTitle(display: DashboardDisplay): string {
	if (!displayChanged(display)) return 'Display: done boards, done sub-boards, categories and the side pane';
	const parts: string[] = [];
	if (display.showCompletedBoards !== DASHBOARD_DISPLAY.showCompletedBoards || display.showCompletedSubs !== DASHBOARD_DISPLAY.showCompletedSubs) {
		parts.push('a setting is changed from its default');
	}
	if (display.paneHidden) parts.push('the side pane is hidden');
	else if (display.hiddenPanels.length > 0) {
		const n = display.hiddenPanels.length;
		parts.push(`${n} side pane panel${n === 1 ? ' is' : 's are'} hidden`);
	}
	return `Display: ${parts.join('; ')}`;
}
