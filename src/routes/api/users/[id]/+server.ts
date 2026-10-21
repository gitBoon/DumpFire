import { json, error } from '@sveltejs/kit';
import { db, sqlite } from '$lib/server/db';
import { afterCommit } from '$lib/server/db/transaction';
import { deleteUser } from '$lib/server/deletes';
import { users, type User } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { readAccountFields, requireAssignableRole, requireUnusedAccountFields } from '$lib/server/account-fields';
import { pathId, readBody } from '$lib/server/request-body';
import { requireAdmin, requireManagedAccount } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import { endUnusedInvites } from '$lib/server/invites';
import { createLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

/**
 * PUT — Update user role/details (admin only).
 *
 * An invite is addressed to the account as it was when it was sent: to its
 * email address, and with the role it had. So when the email address or the
 * role actually changes, every invite of the account not yet used ends, in
 * the transaction that writes the change, and the answer says how many
 * (`invitesEnded`). A change of username or emoji ends nothing, and no change
 * here ends a session or an API key.
 *
 * Nobody changes their own role here (card 2117, decision 13): sending `role`
 * for your own account is a 403 whatever it holds, and nothing else sent with
 * it is saved. The superadmin's request to give up their role was answered
 * 200 and ignored, and an administrator's to make themselves a user was
 * answered 200 and done.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireAdmin(locals.user);

	const userId = pathId(params.id, 'user');
	const body = await readBody(request);

	// One transaction: the user is read and the caller checked in the one that
	// changes the account, so the role that was checked is the role of the row
	// that is changed. Its fields are read after (card 2117, R1). It asks first
	// whether the session is still open, and who its account is now: the
	// caller's own role may have been lowered while the body arrived (card 2253).
	const answer = writeAs(locals, (caller) => {
		const actor = requireAdmin(caller);

		// The superadmin's account is theirs alone, and only the superadmin
		// changes an administrator's: the rule is the one for setting a password
		// and deleting an account, in route-guards.ts.
		const target = requireManagedAccount(actor, userId, {
			superadmin: 'Cannot modify superadmin account',
			admin: 'Only superadmin can modify admin users'
		});

		// Nobody changes their own email here, an administrator included. This
		// route asks for no password, and an email is where an invite to set a
		// new one is sent. PUT /api/account/email asks for the password they
		// have. Refused for sending it at all, whatever else came with it.
		if (target.id === actor.id && body.email !== undefined) {
			throw error(403, 'Change your own email on the Account page, which asks for your current password');
		}

		// Nor their own role, the superadmin included, and whatever it is: the
		// role they have, sent back, is refused too (R16). The superadmin's is
		// nobody's to change; an administrator's is the superadmin's to change.
		if (target.id === actor.id && body.role !== undefined) {
			throw error(
				403,
				target.role === 'superadmin'
					? "The superadmin's role cannot be changed"
					: 'Your own role is not changed here: the superadmin can change it'
			);
		}

		// Each text field by its rule, a value the account already holds kept
		// as it is: see account-fields.ts.
		const fields = readAccountFields(body, target);

		// A role is exactly `user` or `admin`, and only the superadmin gives
		// `admin`. What passes is what is written: it used to be compared as it
		// was sent and then bound, and `["superadmin"]` is bound as `superadmin`.
		const role = requireAssignableRole(actor, body, {
			superadmin: 'Cannot assign superadmin role',
			promote: 'Only superadmin can assign admin role'
		});

		// A username or an email another account has is a 409, where it was a
		// 500 from the database (decision 14).
		requireUnusedAccountFields(fields, target.id);

		const updates: Partial<Pick<User, 'emoji' | 'role' | 'username' | 'email'>> = {};
		if (fields.emoji !== undefined) updates.emoji = fields.emoji;
		// Never the superadmin's: that is the caller's own account, refused above.
		if (role !== undefined) updates.role = role;
		if (fields.username !== undefined) updates.username = fields.username;
		if (fields.email !== undefined) updates.email = fields.email.toLowerCase();

		// What actually changes: an email is compared in lower case, as it is
		// stored, and a role sent as the one the account has is no change. The
		// invites end before the account is written.
		const changed = [
			...(updates.email !== undefined && updates.email !== target.email.toLowerCase() ? ['email address'] : []),
			...(updates.role !== undefined && updates.role !== target.role ? ['role'] : [])
		];
		const invitesEnded = changed.length > 0 ? endUnusedInvites(target.id) : 0;
		if (changed.length > 0) {
			afterCommit(() =>
				log.info(
					`User ${actor.id} changed the ${changed.join(' and ')} of user ${target.id} — ended ${invitesEnded} unused invite(s)`,
					{ targetUserId: target.id, changed, ...(changed.includes('role') ? { role: updates.role } : {}), invitesEnded },
					{ userId: actor.id }
				)
			);
		}

		if (Object.keys(updates).length === 0) {
			// The same columns an update answers, and no others. This used to
			// answer the row as it was read, password hash included.
			return {
				id: target.id,
				username: target.username,
				email: target.email,
				emoji: target.emoji,
				role: target.role,
				createdAt: target.createdAt,
				invitesEnded
			};
		}

		const row = db.update(users)
			.set(updates)
			.where(eq(users.id, userId))
			.returning({ id: users.id, username: users.username, email: users.email, emoji: users.emoji, role: users.role, createdAt: users.createdAt })
			.get();
		return { ...row, invitesEnded };
	});

	return json(answer);
};

/**
 * The names of the teams `userId` is the only owner of, in name order: an
 * owner row of theirs, and no other owner in the team (card 2377).
 */
function soleOwnerOf(userId: number): string[] {
	return (
		sqlite
			.prepare(
				`SELECT t.name FROM teams t
				JOIN team_members m ON m.team_id = t.id AND m.user_id = ? AND m.role = 'owner'
				WHERE NOT EXISTS (SELECT 1 FROM team_members o WHERE o.team_id = t.id AND o.role = 'owner' AND o.user_id <> ?)
				ORDER BY t.name, t.id`
			)
			.all(userId, userId) as { name: string }[]
	).map((row) => row.name);
}

/**
 * DELETE — Delete a user (admin only).
 *
 * An account that is the only owner of a team is refused, 409, naming the
 * teams (card 2377): the delete takes its team rows with it, which left each
 * such team with no owner, the one way round card 2373's rule. Asked after
 * the checks of who may delete it, so nobody who may not learns its teams.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireAdmin(locals.user);

	const userId = pathId(params.id, 'user');

	// One transaction: the user is read, checked and deleted together, so the
	// role that was checked is the role of the row that goes. It asks first
	// whether the session is still open, and who its account is now (card 2253).
	writeAs(locals, (caller) => {
		const actor = requireAdmin(caller);

		// Can't delete yourself
		if (userId === actor.id) {
			throw error(400, 'Cannot delete your own account');
		}

		// Nobody deletes the superadmin, and only the superadmin deletes an
		// administrator: the rule is the one for setting a password and
		// changing an account, in route-guards.ts.
		requireManagedAccount(actor, userId, {
			superadmin: 'Cannot delete superadmin account',
			admin: 'Only superadmin can delete admin users'
		});

		// A team keeps an owner (card 2373), before anything is written.
		const owned = soleOwnerOf(userId);
		if (owned.length > 0) {
			const those = owned.length === 1 ? 'that team' : 'those teams';
			throw error(409, `This account is the only owner of: ${owned.join(', ')}. Make someone else an owner or delete ${those} first.`);
		}

		// What named the user with no key to clear it is cleared first; the
		// delete used to fail on it. See $lib/server/deletes.ts.
		deleteUser(userId, actor);
	});

	return json({ success: true });
};
