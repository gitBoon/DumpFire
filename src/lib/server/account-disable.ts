/**
 * account-disable.ts — disabling an account, and enabling it again (card
 * 2671).
 *
 * An administrator disables an account in place of deleting it: the account
 * keeps its name on everything it did, and cannot sign in. Disabling ends at
 * once everything a password reset ends (`endAccountAccess` with its keys:
 * sessions, invites, pending sign-ins, set-up links, API keys, the webhooks it
 * set, its report schedules), the links of the requests it made, for an
 * administrator the mail settings, the App URL and the backup destinations
 * they saved, and, whatever its role, its address in the backup failure
 * address (the code review's CS2). Every gate then
 * refuses it (`findSession`, `keyHolder`, `createSession`, the sign-in, its
 * second step, `usableInvite`). Enabling gives back the sign-in alone: what
 * disabling ended stays ended.
 *
 * Who may do either is `requireManagedAccount`'s table (an administrator for
 * a user, the superadmin for an administrator, nobody for the superadmin);
 * and an account the superadmin disabled is enabled, or deleted, by the
 * superadmin alone (S14, S14b: `requireMayUndoDisable`).
 *
 * Each function runs inside the caller's transaction and throws if there is
 * none, so that the account and everything it ends change together.
 */
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, sqlite } from './db';
import { users, type User } from './db/schema';
import { afterCommit } from './db/transaction';
import { endAccountAccess, namingIds, type AccessEnded } from './auth';
import { advanceReadableCovered, ENDING_IN_MAIL } from './webhooks';
import { anyRemoved, removeFailureAddress, removeSettingsSetBy, type SettingsRemoved } from './setting-setters';
import { createLogger } from './logger';
import { stamp } from '$lib/timestamps';

const log = createLogger('AUTH');

/** Who did it, for the lines and the checks. */
type Actor = Pick<User, 'id' | 'username' | 'role'>;

/** What disabling an account ended and removed, as its route answers it. */
export type Disabled = {
	disabledAt: string;
	access: AccessEnded;
	/** Links of the requests the account made, deleted (S3). */
	requestLinksEnded: number;
	/** The teams the account is the only owner of, by name: still theirs, named so they can be mended (D20). */
	soleOwnerOf: string[];
	/** For an administrator: the settings they saved, removed, and whether the backup failure address was theirs and went (S7). Null for none. */
	settingsRemoved: (SettingsRemoved & { failureAddress: boolean }) | null;
};

/** Whether the account is disabled. */
export function isDisabled(account: Pick<User, 'disabledAt'>): boolean {
	return account.disabledAt !== null;
}

/** The words of the refusals, each in one place for the routes and the tests. */
export const ALREADY_DISABLED = 'This account is already disabled';
export const NOT_DISABLED = 'This account is not disabled';
export const DISABLE_FIRST = 'Disable the account first';
export const ENABLE_FIRST = 'This account is disabled: enable it first';
export const ONLY_SUPERADMIN_ENABLES = 'Only the superadmin can enable an account the superadmin disabled';
export const ONLY_SUPERADMIN_DELETES = 'Only the superadmin can delete an account the superadmin disabled';

/** 409 for a disabled account: a password reset, an invite or a two-step reset of one is refused (D18). */
export function requireEnabledAccount(target: Pick<User, 'disabledAt'>): void {
	if (target.disabledAt !== null) error(409, ENABLE_FIRST);
}

/** 409 for an account that is not disabled: only a disabled account is deleted (D14). */
export function requireDisabledAccount(target: Pick<User, 'disabledAt'>): void {
	if (target.disabledAt === null) error(409, DISABLE_FIRST);
}

/**
 * Whether the superadmin disabled the account: `disabled_by` names an account
 * whose role is `superadmin` now. False for an account not disabled, or whose
 * disabler is gone.
 */
export function disabledBySuperadmin(target: Pick<User, 'disabledBy'>): boolean {
	if (target.disabledBy === null) return false;
	const by = db.select({ role: users.role }).from(users).where(eq(users.id, target.disabledBy)).get();
	return by?.role === 'superadmin';
}

/**
 * 403 when the superadmin disabled the account and the caller is not the
 * superadmin (S14 for an enable, S14b for a delete): an administrator may not
 * undo the superadmin's lock-out, nor erase it.
 */
export function requireMayUndoDisable(actor: Pick<User, 'role'>, target: Pick<User, 'disabledBy'>, what: 'enable' | 'delete'): void {
	if (actor.role !== 'superadmin' && disabledBySuperadmin(target)) {
		error(403, what === 'enable' ? ONLY_SUPERADMIN_ENABLES : ONLY_SUPERADMIN_DELETES);
	}
}

/**
 * The names of the teams `userId` is the only owner of, in name order: an
 * owner row of theirs, and no other owner in the team (card 2377).
 */
export function soleOwnerOf(userId: number): string[] {
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

/** Throws unless a transaction is open: what disabling ends must change with the account. */
function requireTransaction(what: string): void {
	if (!sqlite.inTransaction) {
		throw new Error(`${what} must be called inside the transaction of its route: wrap it in inTransaction or writeAs.`);
	}
}

/**
 * Disable `target`, by `actor`, inside the caller's transaction. 409 when it
 * is already disabled. Who may is the route's to ask first.
 *
 * Writes `disabled_at` and `disabled_by`; ends what a password reset ends,
 * with the API keys (`endAccountAccess`: the webhooks it set are switched off
 * as `setter access ended`, those already off held the same way and their
 * boards' owners mailed once committed, card 2923; its report schedules
 * paused); deletes the links of
 * every request it made (S3); for an administrator removes the mail
 * settings, the App URL and the destinations they saved
 * (`removeSettingsSetBy`, reason `disabled`); and, whatever its role, takes
 * its address out of the backup failure address (S7, the code review's CS2:
 * `removeFailureAddress`). Reads the teams it is the only owner of, which
 * stay theirs (D20).
 *
 * Once committed, one WARN under AUTH naming both accounts and every count,
 * with the ids of the webhooks and schedules, filed with `ip`, the address
 * the administrator did it from, which the notice to the account never names
 * (the code review's CS1). The notice is the route's, after the commit, so
 * that it can say whether it went.
 */
export function disableAccount(target: User, actor: Actor, ip: string | null = null): Disabled {
	requireTransaction('disableAccount');
	if (target.disabledAt !== null) error(409, ALREADY_DISABLED);

	const disabledAt = stamp();
	db.update(users).set({ disabledAt, disabledBy: actor.id }).where(eq(users.id, target.id)).run();
	// The settings an administrator set, removed first (card 2922): the ending below holds what an account set, and
	// finds nothing left to hold, so a disable removes them as it always has and writes no hold's line. Their holds
	// left by an earlier ending stay, as tombstones (R1).
	const removed: SettingsRemoved =
		target.role === 'admin' || target.role === 'superadmin'
			? removeSettingsSetBy(target, 'disabled', actor)
			: { mail: false, appUrl: false, destinations: [] };
	// Told after the commit (card 2923): `disabled_at`, written above, leaves the account out of the owners' mail.
	// It deletes the links of every request the account made too (card 2922, as S3 here before).
	const access = endAccountAccess(target.id, {
		apiKeys: true,
		cause: { log: `${target.username}'s account was disabled by ${actor.username}`, mail: ENDING_IN_MAIL.disabled }
	});
	// This ending held what the account could read (card 2935): the start pass's moment moves past it (P4), so the
	// next start does not hold again what an owner switches on with a new secret meanwhile.
	advanceReadableCovered(disabledAt, target.id);
	const requestLinksEnded = access.requestLinks;

	// The account's address out of the backup failure address whatever its role (the code review's CS2): any
	// address can be typed there, and the mail goes to whoever holds it.
	const failureAddress = removeFailureAddress(target.email);
	const settingsRemoved: Disabled['settingsRemoved'] = anyRemoved(removed) || failureAddress ? { ...removed, failureAddress } : null;
	const owned = soleOwnerOf(target.id);

	const removedWords =
		settingsRemoved === null
			? ''
			: '; removed ' +
				[
					settingsRemoved.mail ? 'the mail settings' : null,
					settingsRemoved.appUrl ? 'the App URL' : null,
					settingsRemoved.destinations.length > 0 ? `the backup destination(s) ${settingsRemoved.destinations.map((d) => `"${d}"`).join(', ')}` : null,
					settingsRemoved.failureAddress ? 'their address from the backup failure address' : null
				]
					.filter((part) => part !== null)
					.join(', ');
	afterCommit(() =>
		log.warn(
			`Account of user ${target.id} ("${target.username}") disabled by "${actor.username}" (user ${actor.id}): ended ` +
				`${access.sessions} session(s), ${access.invites} invite(s), ${access.challenges} pending sign-in(s), ` +
				`${access.enrolmentLinks} set-up link(s), ${access.apiKeys} API key(s) and ${requestLinksEnded} request link(s), ` +
				`switched off ${access.webhooks} webhook(s) they set up${namingIds(access.webhookIds)} and paused ` +
				`${access.reportSchedules} report schedule(s)${namingIds(access.reportScheduleIds)}` +
				(owned.length > 0 ? `; the only owner of: ${owned.join(', ')}` : '') +
				removedWords,
			{
				targetUserId: target.id,
				disabledBy: actor.id,
				sessionsEnded: access.sessions,
				invitesEnded: access.invites,
				challengesEnded: access.challenges,
				enrolmentLinksEnded: access.enrolmentLinks,
				apiKeysEnded: access.apiKeys,
				webhookIds: access.webhookIds,
				reportScheduleIds: access.reportScheduleIds,
				requestLinksEnded,
				soleOwnerOf: owned,
				...(settingsRemoved === null ? {} : { settingsRemoved })
			},
			{ userId: actor.id, ip }
		)
	);

	return { disabledAt, access, requestLinksEnded, soleOwnerOf: owned, settingsRemoved };
}

/**
 * Enable `target` again, by `actor`, inside the caller's transaction: 409
 * when it is not disabled; 403 when the superadmin disabled it and `actor` is
 * not the superadmin (S14). Clears both columns, and nothing else: the keys,
 * webhooks, schedules and request links disabling ended stay ended (D8).
 * Once committed, one WARN under AUTH.
 */
export function enableAccount(target: User, actor: Actor, ip: string | null = null): { enabledAt: string } {
	requireTransaction('enableAccount');
	if (target.disabledAt === null) error(409, NOT_DISABLED);
	requireMayUndoDisable(actor, target, 'enable');

	db.update(users).set({ disabledAt: null, disabledBy: null }).where(eq(users.id, target.id)).run();
	const was = target.disabledAt;
	afterCommit(() =>
		log.warn(
			`Account of user ${target.id} ("${target.username}") enabled again by "${actor.username}" (user ${actor.id}), ` +
				`disabled since ${was}: it may sign in; its API keys, webhooks, report schedules and request links stay ended`,
			{ targetUserId: target.id, enabledBy: actor.id, disabledAt: was, disabledBy: target.disabledBy },
			{ userId: actor.id, ip }
		)
	);
	return { enabledAt: stamp() };
}
