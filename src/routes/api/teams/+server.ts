import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { teams, teamMembers } from '$lib/server/db/schema';
import { listTeamsFor } from '$lib/server/list-access';
import { readBody, readText } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/**
 * GET — every team, for the share dialog's picker, with its members on the
 * teams the caller is in, and on every team for an administrator (card 2128,
 * `listTeamsFor`). Who was in every team was given to every signed-in caller.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	return json(listTeamsFor(locals.user));
};

/** POST — Create a new team (any authenticated user). */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const userId = locals.user.id;

	// Read as PUT /api/teams/[id] reads them (card 2117): a name that was not
	// text was a 500, and neither had a length.
	const body = await readBody(request);
	const name = readText(body, 'name', {
		required: true,
		trim: true,
		min: 1,
		max: 200,
		says: { missing: 'Team name is required', empty: 'Team name is required' }
	});
	const emoji = readText(body, 'emoji', { min: 1, max: 32 }) ?? '🏢';

	// One transaction: the team and its owner are made together. A failure
	// between the two used to leave a team that only an administrator could
	// manage.
	const team = inTransaction(() => {
		const team = db.insert(teams)
			.values({ name, emoji })
			.returning()
			.get();

		// Auto-add creator as team owner
		db.insert(teamMembers)
			.values({ teamId: team.id, userId, role: 'owner' })
			.run();

		return team;
	});

	return json(team, { status: 201 });
};
