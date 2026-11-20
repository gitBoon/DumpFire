/**
 * account-ending-bodies.ts — the bodies of an account's endings, shared by the routes and the start's pass (card 2996,
 * R5; named so by its code review, FP12).
 *
 * Two of them: what disabling an account ends (`disableAccountSteps`, the body of `disableAccount`) and what changing
 * an account's role ends (`changeAccountRole`, the body of `PUT /api/users/{id}` for a role). The disable route and
 * the role route call them, and so does the start's pass for an account the record of account endings ends or lowers
 * (`endRecordedAccountsPresent`), so that an account ended again at start is ended as completely as the application
 * ends one. Each records its ending (`recordAccountEnding`) in the transaction that makes it.
 *
 * And the start's password pass (card 2997, `endReplacedPasswordsPresent`): an account holding a password the record
 * says was replaced here is given one nothing matches and signed out, as a password reset signs it out.
 *
 * Its own module, as api-key-revoke.ts is (card 2995's departure 7): the webhook-writer rule pins
 * `holdNoLongerReadable` to callers in other files than webhooks.ts.
 *
 * Each runs inside the caller's transaction on the server's connection and throws if there is none.
 */
import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { db, sqlite } from './db';
import { users, type User } from './db/schema';
import { endAccountAccess, endSessionsOf, type AccessEnded } from './auth';
import { advanceReadableCovered, ENDING_IN_MAIL, holdNoLongerReadable, switchOffLostWebhooks, type EndingCause, type Telling } from './webhooks';
import { removeFailureAddress, removeSettingsSetBy, type SettingsRemoved } from './setting-setters';
import { endUnusedInvites } from './invites';
import { endPendingSignIns } from './mfa-store';
import { ACCOUNT_ENDING, ORIGIN, accountRulings, passwordReplacedHere, raiseUserCounterOverSeed, recordAccountEnding, recordPasswordReplaced, type AccountEnding } from './account-endings';
import { DUMMY_HASH } from './dummy-hash';
import { stamp } from '$lib/timestamps';

/** Who an account is, for the lines: by id and name. */
type Named = { id: number; username: string };

/** Throws unless a transaction is open on the server's connection. */
function requireTransaction(what: string): void {
	if (!sqlite.inTransaction) throw new Error(`${what} ends an account inside the transaction of its change, and none is open`);
}

/** What disabling an account did (`disableAccountSteps`). */
export type DisableSteps = { disabledAt: string; removed: SettingsRemoved; access: AccessEnded; failureAddress: boolean };

/**
 * The disable's body (card 2671; card 2996, R5): `disabled_at` now and `disabled_by` `by`; the ending recorded,
 * `disabled` (`origin` `belt` where the start's pass disables by the record's rule, so that only the superadmin enables
 * it, FP15); for an administrator the mail settings, the App URL and the destinations it saved removed
 * (`removeSettingsSetBy`, `disabled`, by `actor`, or found at start-up where there is none; found by the record's pass,
 * naming nobody, where `cause.unnamed`, FP16); what a password reset ends, with the keys (`endAccountAccess`, telling as
 * `cause` says, FP6); the start pass's moment moved past it (`advanceReadableCovered`); and its address taken out of
 * the backup failure address (`removeFailureAddress`). In that order. Writes no line of its own: the route's is
 * `disableAccount`'s, the start's its own WARN, counted.
 */
export function disableAccountSteps(
	target: User,
	by: { id: number | null; actor: Named | null },
	cause: EndingCause,
	{ origin = ORIGIN.here }: { origin?: 'here' | 'belt' } = {}
): DisableSteps {
	requireTransaction('disableAccountSteps');
	const disabledAt = stamp();
	db.update(users).set({ disabledAt, disabledBy: by.id }).where(eq(users.id, target.id)).run();
	recordAccountEnding(sqlite, target.id, ACCOUNT_ENDING.disabled, { at: disabledAt, origin });
	// The settings an administrator set, removed first (card 2922): the ending below holds what an account set, and
	// finds nothing left to hold, so a disable removes them as it always has and writes no hold's line. Their holds
	// left by an earlier ending stay, as tombstones (R1).
	const removed: SettingsRemoved =
		target.role === 'admin' || target.role === 'superadmin'
			? removeSettingsSetBy(target, 'disabled', by.actor, cause.unnamed ? 'record' : 'start-up')
			: { mail: false, appUrl: false, destinations: [] };
	// Told after the commit (card 2923): `disabled_at`, written above, leaves the account out of the owners' mail.
	// It deletes the links of every request the account made too (card 2922).
	const access = endAccountAccess(target.id, { apiKeys: true, cause });
	// This ending held what the account could read (card 2935): the start pass's moment moves past it (P4).
	advanceReadableCovered(disabledAt, target.id);
	// The account's address out of the backup failure address whatever its role (card 2671's code review, CS2).
	const failureAddress = removeFailureAddress(target.email);
	return { disabledAt, removed, access, failureAddress };
}

/** The one statement of this module that gives an account `DUMMY_HASH`, prepared once per connection (`giveDummyHash`). */
const dummyHashStatements = new WeakMap<Database.Database, Database.Statement>();

/**
 * Give the account `userId` `DUMMY_HASH`, which nothing matches, and no leave to set up two-step sign-in on its password:
 * the one write of both in this module (card 2997's code review, FP10), for `makeInert` and the start's password pass.
 * With `belt`, the hash it discards is first recorded as replaced, a `belt` row (N1; nothing for a superadmin, R6, or a
 * hash already recorded, FP5); without, the hash is one the record names already (`endReplacedPasswordsPresent`).
 */
function giveDummyHash(userId: number, { belt }: { belt: boolean }): void {
	if (belt) recordPasswordReplaced(sqlite, userId, { origin: ORIGIN.belt });
	let statement = dummyHashStatements.get(sqlite);
	if (statement === undefined) {
		statement = sqlite.prepare('UPDATE users SET password_hash = ?, mfa_password_enrol = 0 WHERE id = ?');
		dummyHashStatements.set(sqlite, statement);
	}
	statement.run(DUMMY_HASH, userId);
}

/**
 * Make an account inert (card 2996): `DUMMY_HASH` for its password, which nothing matches, and no leave to set up
 * two-step sign-in on it; with `secondSteps`, its second factors and recovery codes deleted (R6). For an account the
 * record of account endings names as deleted, or as one this server had before it recorded endings. The hash it
 * discards is recorded first as replaced, a `belt` row (card 2997, N1, decision 14), so that the account, once enabled
 * again, is not given it back by the next restore; for a superadmin, or a hash already `DUMMY_HASH`, nothing (R6).
 */
export function makeInert(userId: number, { secondSteps }: { secondSteps: boolean }): void {
	requireTransaction('makeInert');
	giveDummyHash(userId, { belt: true });
	if (secondSteps) {
		sqlite.prepare('DELETE FROM mfa_factors WHERE user_id = ?').run(userId);
		sqlite.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(userId);
	}
}

/** The columns `PUT /api/users/{id}` answers of an account, and no others. */
export const ACCOUNT_ANSWERED = {
	id: users.id,
	username: users.username,
	email: users.email,
	emoji: users.emoji,
	role: users.role,
	createdAt: users.createdAt
};

/** What changing a role did (`changeAccountRole`). */
export type RoleChanged = {
	row: { id: number; username: string; email: string; emoji: string | null; role: string; createdAt: string };
	invitesEnded: number;
	sessionsEnded: number;
	/** For an administrator made a user: the mail settings, App URL and destinations it last changed, removed. */
	settingsRemoved: SettingsRemoved | null;
};

/**
 * The role change's body (card 2117, 2397, 2752, 2768, 2775, 2935; card 2996, R5): every invite of the account not yet
 * used ended, its pending sign-ins and enrolment links ended, its sessions ended; the account written with `updates`
 * (its new role, and any other field the route was sent with it); the change recorded, `role`, the role after; each
 * webhook it set on a board it can no longer open switched off for good; for an administrator made a user, every
 * webhook with a secret it could read and cannot now held, and the mail settings, App URL and destinations it last
 * changed removed (`removeSettingsSetBy`, `demoted`, by `actor`, or found at start-up where there is none). In that
 * order. Writes no line of its own; tells as `cause` says (FP6), naming nobody where `cause.unnamed` (FP16).
 */
export function changeAccountRole(
	target: User,
	updates: Partial<Pick<User, 'emoji' | 'username' | 'email'>> & { role: 'user' | 'admin' },
	actor: Named | null,
	cause: EndingCause
): RoleChanged {
	requireTransaction('changeAccountRole');
	const invitesEnded = endUnusedInvites(target.id);
	endPendingSignIns(target.id);
	const sessionsEnded = endSessionsOf(target.id);
	const row = db.update(users).set(updates).where(eq(users.id, target.id)).returning(ACCOUNT_ANSWERED).get();
	recordAccountEnding(sqlite, target.id, ACCOUNT_ENDING.role);
	// Each webhook the account set on a board it can no longer open is switched off for good, in this write (card 2752).
	switchOffLostWebhooks({ setters: [target.id] }, cause.log, { telling: cause.telling, unnamed: cause.unnamed });
	// An administrator made an ordinary user could read every webhook's secret, and can now read only those on the
	// boards it owns: the others with a secret are held (card 2935, P2).
	if ((target.role === 'admin' || target.role === 'superadmin') && row.role !== 'admin' && row.role !== 'superadmin') {
		holdNoLongerReadable(target.id, 'all', cause);
	}
	// What an administrator made a user set that sends mail or backups somewhere (card 2397).
	const settingsRemoved =
		updates.role === 'user' && target.role !== 'user' ? removeSettingsSetBy(target, 'demoted', actor, cause.unnamed ? 'record' : 'start-up') : null;
	return { row, invitesEnded, sessionsEnded, settingsRemoved };
}

/** What the start's pass ended again (`endRecordedAccountsPresent`), counted only. */
export type AccountsEndedAgain = { deleted: number; beforeRecord: number; disabled: number; lowered: number; superadminNamed: number };

/**
 * End again every account present that the record of account endings ends or lowers (card 2996, section 3.6 as
 * section 11 rules it, R5, R6): one an older image's import or a host edit brought back. The counter raised over the
 * seed first (`raiseUserCounterOverSeed`); then the one rule over the present accounts, the credential and seed halves
 * included and the held-here half not (R6), and through the application's own bodies:
 *
 * - **Deleted (inert)** and not yet so: its `deleted` belt written where none names it by its very creation time (R3),
 *   disabled as a disable disables it (`disableAccountSteps`, by the superadmin) where it is enabled, `DUMMY_HASH`,
 *   and its second factors and recovery codes deleted (`makeInert`).
 * - **Before record** and not yet so: disabled the same way, or, already disabled, an exact `disabled` belt written,
 *   so that its exact rows govern from then on; `DUMMY_HASH`.
 * - **Disabled** and enabled here: disabled the same way, its password kept.
 * - **Above its ceiling:** lowered as a role change lowers it (`changeAccountRole`).
 * - **A superadmin** a `deleted` row of this server's own names (the only row that counts for one, FP1): never touched,
 *   counted (`superadminNamed`).
 *
 * Every row it writes is a belt (FP2, FP15). It mails the boards' owners only as `telling` says (FP6: the start passes
 * whether the schedulers run), and every line it causes names no account (FP16). Inside the caller's transaction; a
 * second run finds nothing.
 */
export function endRecordedAccountsPresent(telling: Telling = { mail: true }): AccountsEndedAgain {
	requireTransaction('endRecordedAccountsPresent');
	raiseUserCounterOverSeed(sqlite);
	const counts: AccountsEndedAgain = { deleted: 0, beforeRecord: 0, disabled: 0, lowered: 0, superadminNamed: 0 };
	const present = db.select().from(users).all();
	const rulings = accountRulings(sqlite, present);
	if (rulings.length === 0) return counts;
	// What the owners' mail and the webhooks' lines say caused the pass's holds: naming nobody (FP16).
	const endedAgain: EndingCause = {
		log: 'an account the record of account endings on this server ends was found and ended again',
		mail: ENDING_IN_MAIL.disabled,
		telling,
		unnamed: true
	};
	const loweredAgain: EndingCause = {
		log: 'an account the record of account endings on this server lowers was found above its role and lowered again',
		mail: ENDING_IN_MAIL.demoted,
		telling,
		unnamed: true
	};
	const byId = new Map(present.map((account) => [account.id, account]));
	const superadmin = present.filter((account) => account.role === 'superadmin' && account.disabledAt === null).sort((a, b) => a.id - b.id)[0]?.id ?? null;
	const secondStepsOf = sqlite.prepare('SELECT (SELECT COUNT(*) FROM mfa_factors WHERE user_id = @id) + (SELECT COUNT(*) FROM mfa_recovery_codes WHERE user_id = @id) AS n');
	for (const ruling of rulings) {
		const target = byId.get(ruling.id);
		if (target === undefined) continue;
		if (target.role === 'superadmin') {
			counts.superadminNamed++;
			continue;
		}
		if (ruling.ended === 'deleted' || ruling.ended === 'before record') {
			const inert = ruling.ended === 'deleted';
			const holdsSecondSteps = inert && (secondStepsOf.get({ id: target.id }) as { n: number }).n > 0;
			// The row that keeps it so (R3; rule 2's belt), written while its hash is the one it was matched on.
			const belt: AccountEnding | null = inert ? (ruling.exactDeleted ? null : ACCOUNT_ENDING.deleted) : target.disabledAt !== null ? ACCOUNT_ENDING.disabled : null;
			if (target.disabledAt === null || target.passwordHash !== DUMMY_HASH || holdsSecondSteps || belt !== null) {
				if (belt !== null) recordAccountEnding(sqlite, target.id, belt, { origin: ORIGIN.belt });
				if (target.disabledAt === null) disableAccountSteps(target, { id: superadmin, actor: null }, endedAgain, { origin: ORIGIN.belt });
				makeInert(target.id, { secondSteps: inert });
				counts[inert ? 'deleted' : 'beforeRecord']++;
			}
		} else if (ruling.ended === 'disabled' && target.disabledAt === null) {
			disableAccountSteps(target, { id: superadmin, actor: null }, endedAgain, { origin: ORIGIN.belt });
			counts.disabled++;
		}
		if (ruling.lowerTo !== null) {
			changeAccountRole(target, { role: ruling.lowerTo }, null, loweredAgain);
			counts.lowered++;
		}
	}
	return counts;
}

/** What the start's password pass did (`endReplacedPasswordsPresent`), counted only. */
export type PasswordsEndedAgain = { reset: number; superadmin: number };

/**
 * End every present account holding a password the record of account endings says was replaced on this server (card
 * 2997, section 3.6 as R3 and R4 rule it): one an older image's import, a host file rollback or a host edit brought
 * back. Asked through the one matcher (`passwordReplacedHere`), each account by its role as it is (R10):
 *
 * - **Any account but a superadmin** it names: `DUMMY_HASH`, which nothing matches, and no leave to set up two-step
 *   sign-in on its password; then what a password reset ends, with its API keys (`endAccountAccess`, R4): its sessions,
 *   pending sign-ins and unused invites (an invite from a rolled-back file would set the password again), its keys
 *   recorded and deleted, what it set or could read held. Its second factors stay: the account is not deleted. No row
 *   is written: the hash is already recorded. Counted `reset`.
 * - **A superadmin** it names (only by its exact `here` row): never touched, so that it can still sign in; counted
 *   `superadmin`, for a WARN at every run until the password is changed.
 *
 * It mails the boards' owners only as `telling` says (card 2996's FP6), and every line it causes names no account
 * (FP16). Inside the caller's transaction (its own, `endReplacedPasswordsAtStart`, R3); a second run finds nothing,
 * since `credentialOf(DUMMY_HASH)` is ''.
 */
export function endReplacedPasswordsPresent(telling: Telling = { mail: true }): PasswordsEndedAgain {
	requireTransaction('endReplacedPasswordsPresent');
	const counts: PasswordsEndedAgain = { reset: 0, superadmin: 0 };
	const cause: EndingCause = {
		log: 'an account holding a password the record of account endings on this server says was replaced was found and signed out',
		mail: ENDING_IN_MAIL.passwordReplaced,
		telling,
		unnamed: true
	};
	const present = db.select({ id: users.id, createdAt: users.createdAt, role: users.role, passwordHash: users.passwordHash }).from(users).all();
	for (const account of present) {
		if (!passwordReplacedHere(sqlite, account)) continue;
		if (account.role === 'superadmin') {
			counts.superadmin++;
			continue;
		}
		giveDummyHash(account.id, { belt: false });
		endAccountAccess(account.id, { apiKeys: true, cause });
		counts.reset++;
	}
	return counts;
}
