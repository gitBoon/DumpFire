import { json, error } from '@sveltejs/kit';
import { db, sqlite } from '$lib/server/db';
import { ACCESS_KIND, recordAccessChange } from '$lib/server/access-changes';
import { teamMembers, teams } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { pathId, readBody, readText } from '$lib/server/request-body';
import { requireTeamManager, requireUser } from '$lib/server/route-guards';
import { switchOffLostWebhooks } from '$lib/server/webhooks';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** PUT — Update team details (admin or team owner). */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const teamId = pathId(params.id, 'team');
	const body = await readBody(request);

	// The team is read and the caller checked in the transaction that renames
	// it, after the body has arrived: a check made before could be overtaken
	// by the caller's ownership being taken away while the body was arriving.
	// So could the caller's session, or their role: it asks first whether the
	// session is still open, and who its account is now (card 2253).
	const updated = writeAs(locals, (caller) => {
		const team = requireTeamManager(caller, teamId);

		const updates: Partial<typeof teams.$inferInsert> = {};
		const name = readText(body, 'name', { trim: true, min: 1, max: 200, keep: team.name });
		if (name !== undefined) updates.name = name;
		const emoji = readText(body, 'emoji', { min: 1, max: 32, keep: team.emoji });
		if (emoji !== undefined) updates.emoji = emoji;
		// Nothing to change was a 500, from an update with nothing to set.
		if (Object.keys(updates).length === 0) throw error(400, 'No valid fields to update');

		return db.update(teams).set(updates).where(eq(teams.id, teamId)).returning().get();
	});
	return json(updated);
};

/** DELETE — Delete a team (admin or team owner). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	const teamId = pathId(params.id, 'team');

	// The team read, the caller checked and the team deleted in one
	// transaction that asks first whether the session is still open, and who
	// its account is now (card 2253). The check and the delete were two steps
	// with no transaction around them.
	writeAs(locals, (caller) => {
		const team = requireTeamManager(caller, teamId);

		// Its members, read before the delete takes them: each webhook one of
		// them set whose board they can no longer open is switched off for
		// good, in this write (card 2752, D2).
		const members = db.select({ userId: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, teamId)).all();
		// The record of access changes (card 3002, W10): the team deleted, as `none` for each of its members and shares
		// from here (R2). Written just before the delete, in its transaction, while the team's creation time can be read.
		recordAccessChange(sqlite, { kind: ACCESS_KIND.team, subject: teamId, access: 'deleted' });
		db.delete(teams).where(eq(teams.id, teamId)).run();
		if (members.length > 0) {
			switchOffLostWebhooks(
				{ setters: members.map((member) => member.userId) },
				`the team ${team.name} was deleted by ${requireUser(caller).username}`
			);
		}
	});
	return json({ success: true });
};
