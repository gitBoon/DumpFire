import { json, error } from '@sveltejs/kit';
import { db, sqlite } from '$lib/server/db';
import { afterCommit } from '$lib/server/db/transaction';
import { deleteUser } from '$lib/server/deletes';
import { users, type User } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { readAccountFields, requireAssignableRole, requireUnusedAccountFields } from '$lib/server/account-fields';
import { pathId, readBody } from '$lib/server/request-body';
import { requireAdmin, requireManagedAccount } from '$lib/server/route-guards';
import { whilePasswordHolds, type SessionUser } from '$lib/server/auth';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import { endUnusedInvites } from '$lib/server/invites';
import { endPendingSignIns } from '$lib/server/mfa-store';
import { anyRemoved, removeSettingsSetBy, settingsHeldBy } from '$lib/server/setting-setters';
import { mayManageAccount } from '$lib/account-rule';
import { createLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

/**
 * GET — What a role change to user or a delete of the account would remove
 * now (admin only): `{ id, settingsSet }`, `settingsSet` being the mail
 * settings, the App URL and the backup destinations it holds, `{ mail,
 * appUrl, destinations }`, or null for none (card 2397's second review). The
 * users panel reads it just before it asks to make the account a user or
 * delete it: the admin page's own copy is as old as the page, and another
 * administrator may have taken a setting over since. By the admin page's
 * rule of the counts (the rule in $lib/account-rule.ts): null for the
 * caller's own account and for any the caller may not manage, so it tells an
 * administrator nothing of the superadmin's or another administrator's.
 * Nothing else of the account is answered, and the answer is not kept.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const caller = requireAdmin(locals.user);
	const userId = pathId(params.id, 'user');
	const target = db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId)).get();
	if (!target) throw error(404, 'User not found');
	const counted = target.id !== caller.id && mayManageAccount(caller, target);
	const settingsSet = counted ? (settingsHeldBy(target.id).get(target.id) ?? null) : null;
	return json({ id: target.id, settingsSet }, { headers: { 'Cache-Control': 'no-store' } });
};

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
 *
 * An administrator made a user loses, in the same transaction, the mail
 * settings, the App URL and the backup destinations they last changed (card
 * 2397): the answer then has `settingsRemoved`, `{ mail, appUrl,
 * destinations }`, and an answer that removed nothing has no such field.
 *
 * A body that carries `role` or `email` asks for the caller's own password
 * again, in `currentPassword` (card 2701, step-up.ts): it changes an account's
 * privileges, or the address its invites and resets go to. Every refusal the
 * change makes is made first, read only, so that none costs a check or a
 * guess. A username or emoji alone asks for none.
 */
export const PUT: RequestHandler = async ({ params, request, locals, cookies }) => {
	requireAdmin(locals.user);

	const userId = pathId(params.id, 'user');
	const body = await readBody(request);

	/**
	 * Every refusal of the change, read only: the caller as their account is
	 * now, the account, the caller's own email and role, the fields against the
	 * row, the role and whether the name and address are free; and what would
	 * change. Asked before the password, and again in the transaction that
	 * changes the account.
	 */
	const refusals = (caller: SessionUser | null) => {
		const actor = requireAdmin(caller);

		// The superadmin's account is theirs alone, and only the superadmin
		// changes an administrator's: the rule is the one for setting a password
		// and deleting an account, in route-guards.ts.
		const target = requireManagedAccount(actor, userId, {
			superadmin: 'Cannot modify superadmin account',
			admin: 'Only superadmin can modify admin users'
		});

		// Nobody changes their own email here, an administrator included: an
		// email is where an invite to set a new password is sent, and this is
		// the route for another's account. PUT /api/account/email asks for the
		// password they have. Refused for sending it at all, whatever else came
		// with it, before any password is asked for (card 2701).
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
		// stored, and a role sent as the one the account has is no change.
		const changed = [
			...(updates.email !== undefined && updates.email !== target.email.toLowerCase() ? ['email address'] : []),
			...(updates.role !== undefined && updates.role !== target.role ? ['role'] : [])
		];

		return { actor, target, updates, changed };
	};

	// A username or emoji alone changes nothing of the account's access, asks
	// for no password, and ends no invite. One transaction, as below.
	if (!Object.hasOwn(body, 'role') && !Object.hasOwn(body, 'email')) {
		return json(
			writeAs(locals, (caller) => {
				const { target, updates } = refusals(caller);
				if (Object.keys(updates).length === 0) return { ...answered(target), invitesEnded: 0 };
				return { ...db.update(users).set(updates).where(eq(users.id, userId)).returning(ANSWERED).get(), invitesEnded: 0 };
			})
		);
	}

	// A role or an email: the caller's password, asked for again (card 2701),
	// once every refusal that needs none has been made.
	const { userId: callerId, hash } = await confirmStepUp(locals, cookies, body, 'PUT /api/users/[id]', (caller) =>
		refusals(caller)
	);

	// One transaction: the user is read and the caller checked in the one that
	// changes the account, so the role that was checked is the role of the row
	// that is changed. Its fields are read after (card 2117, R1). It asks first
	// whether the session is still open, and who its account is now: the
	// caller's own role may have been lowered while the body arrived (card
	// 2253). It runs only while the caller's stored hash is the one their
	// password was checked against.
	const answer = await whilePasswordHolds(callerId, hash, () =>
		writeAs(locals, (caller) => {
			const { actor, target, updates, changed } = refusals(caller);

			// The invites, the pending sign-ins and the enrolment links (card
			// 2768) end before the account is written.
			const invitesEnded = changed.length > 0 ? endUnusedInvites(target.id) : 0;
			if (changed.length > 0) endPendingSignIns(target.id);
			if (changed.length > 0) {
				afterCommit(() =>
					log.info(
						`User ${actor.id} changed the ${changed.join(' and ')} of user ${target.id} — ended ${invitesEnded} unused invite(s)`,
						{ targetUserId: target.id, changed, ...(changed.includes('role') ? { role: updates.role } : {}), invitesEnded },
						{ userId: actor.id }
					)
				);
			}

			if (Object.keys(updates).length === 0) return { ...answered(target), invitesEnded };

			const row = db.update(users).set(updates).where(eq(users.id, userId)).returning(ANSWERED).get();

			// An administrator made a user loses what they set that sends mail or
			// backups somewhere, in this transaction (card 2397): the mail settings,
			// the App URL and the destinations they last changed. The answer names
			// what went, and only then has the field.
			if (updates.role === 'user' && target.role !== 'user') {
				const settingsRemoved = removeSettingsSetBy(target, 'demoted', actor);
				if (anyRemoved(settingsRemoved)) return { ...row, invitesEnded, settingsRemoved };
			}
			return { ...row, invitesEnded };
		}));

	return json(answer);
};

/** The columns PUT answers of an account, and no others. */
const ANSWERED = { id: users.id, username: users.username, email: users.email, emoji: users.emoji, role: users.role, createdAt: users.createdAt };

/**
 * An account as PUT answers it when nothing changed: the columns an update
 * answers, and no others. This used to answer the row as it was read,
 * password hash included.
 */
function answered(target: User) {
	return {
		id: target.id,
		username: target.username,
		email: target.email,
		emoji: target.emoji,
		role: target.role,
		createdAt: target.createdAt
	};
}

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
 *
 * The mail settings, App URL and backup destinations the account last changed
 * go with it (card 2397, in `deleteUser`): the answer then has
 * `settingsRemoved`, as the role change's has, and is `{ success: true }`
 * where nothing went.
 *
 * It asks for the caller's own password again, in `currentPassword` (card
 * 2701, step-up.ts), after every refusal that needs none.
 */
export const DELETE: RequestHandler = async ({ params, request, locals, cookies }) => {
	requireAdmin(locals.user);

	const userId = pathId(params.id, 'user');
	const body = await readBody(request);

	/**
	 * Every refusal of the delete, read only: the caller as their account is
	 * now, their own account, whose account they may delete, and a team's only
	 * owner. Asked before the password, and again in the transaction that
	 * deletes the account.
	 */
	const refusals = (caller: SessionUser | null) => {
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

		return actor;
	};

	// The caller's password, asked for again (card 2701), once every refusal
	// that needs none has been made.
	const { userId: callerId, hash } = await confirmStepUp(locals, cookies, body, 'DELETE /api/users/[id]', (caller) =>
		refusals(caller)
	);

	// One transaction: the user is read, checked and deleted together, so the
	// role that was checked is the role of the row that goes. It asks first
	// whether the session is still open, and who its account is now (card
	// 2253), and runs only while the caller's stored hash is the one their
	// password was checked against.
	const removed = await whilePasswordHolds(callerId, hash, () =>
		writeAs(locals, (caller) => {
			const actor = refusals(caller);

			// What named the user with no key to clear it is cleared first; the
			// delete used to fail on it. See $lib/server/deletes.ts.
			return deleteUser(userId, actor);
		}));

	// The mail settings, App URL and destinations the account last changed
	// went with it (card 2397): named only where something did.
	const settingsRemoved = removed?.settingsRemoved;
	return json(settingsRemoved && anyRemoved(settingsRemoved) ? { success: true, settingsRemoved } : { success: true });
};
