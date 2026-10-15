import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users, teams, boards } from '$lib/server/db/schema';
import { asc, inArray } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { checkRateLimit } from '$lib/server/rate-limit';
import { verifyFormToken } from '$lib/server/request-tokens';
import { addressToCount } from '$lib/server/client-address';
import type { RequestHandler } from './$types';

/**
 * GET — The users and teams a request can be sent to, and the boards it may
 * name.
 *
 * For a signed-in user, or for someone holding a token issued with the request
 * form (sent as `X-Form-Token`). It used to answer anybody: one unauthenticated
 * call listed every username, team name and board name in the system.
 *
 * The form is public, so the names of the people and teams in it are still
 * visible to anyone who loads it — that is what choosing a recipient
 * requires. What this stops is the list being fetched cold and repeatedly: a
 * token has to be earned by loading the form, expires, and is rate limited
 * per address.
 *
 * A board is not needed to send a request: whoever accepts it picks the board
 * the card goes on. So the boards are the ones a signed-in caller can open,
 * and none to a holder of the token (card 2128, decision 6). Every board's
 * name, private ones and sub-boards among them, went to anyone who loaded
 * the form.
 */
export const GET: RequestHandler = async ({ request, locals, getClientAddress }) => {
	if (!locals.user) {
		if (!verifyFormToken(request.headers.get('x-form-token'))) {
			throw error(401, 'Open the request form to choose who to send a request to.');
		}
		const { limited, retryAfterSecs } = checkRateLimit(
			`request-targets:${addressToCount({ getClientAddress })}`,
			30,
			15 * 60 * 1000
		);
		if (limited) {
			throw error(429, `Too many requests. Try again in ${Math.ceil(retryAfterSecs / 60)} minute(s).`);
		}
	}

	const allUsers = db.select({ id: users.id, username: users.username, emoji: users.emoji })
		.from(users)
		.all();

	const allTeams = db.select({ id: teams.id, name: teams.name, emoji: teams.emoji })
		.from(teams)
		.all();

	const open = locals.user ? getAccessibleBoardIds(locals.user) : [];
	const allBoards = open !== null && open.length === 0
		? []
		: db.select({ id: boards.id, name: boards.name, emoji: boards.emoji })
			.from(boards)
			.where(open === null ? undefined : inArray(boards.id, open))
			.orderBy(asc(boards.name))
			.all();

	const targets = [
		...allTeams.map(t => ({ id: t.id, name: t.name, emoji: t.emoji || '🏢', type: 'team' as const })),
		...allUsers.map(u => ({ id: u.id, name: u.username, emoji: u.emoji || '👤', type: 'user' as const }))
	];

	return json({ targets, boards: allBoards.map(b => ({ id: b.id, name: b.name, emoji: b.emoji || '📋' })) });
};
