import { redirect } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { listMilestones } from '$lib/server/milestones';
import { getBurndown, parseBurndownQuery, BurndownError } from '$lib/server/burndown';
import type { BurndownResult } from '$lib/burndown';
import type { PageServerLoad } from './$types';

/**
 * The burndown page is driven entirely by its query string — the same
 * parameters as GET /api/v1/burndown — so a view is a link: bookmark it, send
 * it, and anyone with the same access sees the same chart.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/login');
	const user = locals.user;

	const params = new URLSearchParams(url.searchParams);
	// A breakdown is part of the page. Across several boards the natural one
	// is by board; within a single board, by category.
	if (!params.has('groupBy')) {
		const single = (params.get('boardIds') ?? '').split(',').filter(Boolean).length === 1;
		params.set('groupBy', single ? 'category' : 'board');
	}
	params.set('options', 'true');

	let result: BurndownResult | null = null;
	let problem: { status: number; message: string } | null = null;
	try {
		result = getBurndown(user, parseBurndownQuery(params, user));
	} catch (e) {
		// Shown in the page rather than as an error screen: the controls stay
		// usable, so a bad link can be corrected from where it landed.
		if (e instanceof BurndownError) problem = { status: e.status, message: e.message };
		else throw e;
	}

	const accessible = getAccessibleBoardIds(user);
	const boards = (
		sqlite
			.prepare('SELECT id, name, emoji, category_id AS categoryId, parent_card_id AS parentCardId FROM boards ORDER BY name COLLATE NOCASE')
			.all() as { id: number; name: string; emoji: string | null; categoryId: number | null; parentCardId: number | null }[]
	)
		.filter((b) => accessible === null || accessible.includes(b.id))
		.map((b) => ({ ...b, emoji: b.emoji ?? '📋' }));

	// Only groups that hold at least one board this user can see.
	const withBoards = new Set(boards.map((b) => b.categoryId).filter((id): id is number => id !== null));
	const boardCategories = (
		sqlite.prepare('SELECT id, name, color FROM board_categories ORDER BY name COLLATE NOCASE').all() as {
			id: number;
			name: string;
			color: string;
		}[]
	).filter((c) => withBoards.has(c.id));

	const milestones = listMilestones(user).map((m) => ({
		id: m.id,
		name: m.name,
		status: m.status,
		targetDate: m.targetDate
	}));

	return {
		user,
		result,
		problem,
		groupBy: params.get('groupBy'),
		boards,
		boardCategories,
		milestones
	};
};
