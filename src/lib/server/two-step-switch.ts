/**
 * two-step-switch.ts — whether two-step sign-in is required on this server
 * (card 3064, R1).
 *
 * The compatibility release ships two-step sign-in dormant: a sign-in with no
 * second factor is let in on its password, as the version before it let
 * everyone in, until the superadmin requires two-step sign-in (event E3). The
 * one setting that decides it is `settings.two_step_required_at`: absent,
 * dormant; present, required, whatever its value (one that names no moment
 * still counts as required: fail closed).
 *
 * Read by this one function, a single read of the settings' primary key at
 * each call. No cache: one process, and a cache is one more thing to get
 * wrong on a security boundary. Nothing in the release writes the setting: no
 * migration and no start pass. A restore may turn it on, never off, and a
 * Reset writes it back (R1).
 *
 * The superadmin turns it on (event E3, R10): `POST /api/admin/two-step/require`
 * asks `refuseRequiring` before the password and `requireTwoStep` in its write.
 * Nothing in the application turns it off (R11): only a host edit with the
 * server stopped, which every start then reports (`reportTwoStepTurnedOff` in
 * startup-checks.ts).
 */

import { error } from '@sveltejs/kit';
import { sqlite } from './db';
import { inTransaction } from './db/transaction';
import { stamp } from '$lib/timestamps';

/** The setting whose presence requires two-step sign-in (card 3064, R1). */
export const TWO_STEP_REQUIRED_AT = 'two_step_required_at';

/**
 * The setting migration 0066 wrote and 0084 deletes: when two-step sign-in was
 * released, which starts the 14 days of setting up on a password alone and
 * card 2935's "made after the release" (`TWO_STEP_RELEASED_AT` in mfa-store.ts,
 * named here so that this module imports nothing of mfa-store).
 */
const TWO_STEP_RELEASED_AT = 'two_step_released_at';

/** Whether two-step sign-in is required on the server whose database this is: the switch's row is there, whatever it holds. */
export function twoStepRequired(database: Pick<typeof sqlite, 'prepare'> = sqlite): boolean {
	return database.prepare('SELECT 1 FROM settings WHERE key = ?').get(TWO_STEP_REQUIRED_AT) !== undefined;
}

// ─── Requiring it (event E3, R10) ───────────────────────────────────────────

/** The 409s of requiring two-step sign-in, before anything is written (R10). */
export const ALREADY_REQUIRED = 'Two-step sign-in is already required on this server.';
export const REQUIRER_HOLDS_NO_FACTOR = 'Set up two-step sign-in for your own account first, on your Account page.';
export const REQUIRER_SIGNED_IN_WITHOUT_CODE = 'Sign out, then sign in again with your code, and require two-step sign-in from that session.';

/** The 409 while administrators hold no factor (S-L7): each named, by name and id, in id order. */
export const administratorsFirst = (missing: readonly { id: number; username: string }[]): string =>
	'Every administrator must set up two-step sign-in before it can be required. Not yet set up: ' +
	missing.map((account) => `"${account.username.slice(0, 100)}" (user ${account.id})`).join(', ') +
	'.';

/**
 * The superadmin and every enabled administrator that holds no second factor,
 * by id (S-L7): while any is listed, two-step sign-in cannot be required, so
 * that none of them is left to a mail at E3. A disabled administrator is not
 * listed: it cannot sign in either way.
 */
export function administratorsWithoutFactor(database: Pick<typeof sqlite, 'prepare'> = sqlite): { id: number; username: string }[] {
	return database
		.prepare(
			"SELECT id, username FROM users WHERE (role = 'superadmin' OR (role = 'admin' AND disabled_at IS NULL)) " +
				'AND NOT EXISTS (SELECT 1 FROM mfa_factors WHERE mfa_factors.user_id = users.id) ORDER BY id'
		)
		.all() as { id: number; username: string }[];
}

/**
 * Every refusal of requiring two-step sign-in, each a 409 with nothing
 * written (R10), in this order: it is already required; the caller (the
 * superadmin, whom the route asks first) holds no factor; the session they ask
 * from, by its hash, is not one made with a code (`two_step` 1), or is not
 * there; the superadmin or an enabled administrator holds no factor, each
 * named (S-L7). Read only: asked by the route before the password, and again
 * in its write by `requireTwoStep`.
 *
 * (A session made on a password alone of an account that holds a factor is
 * refused by `findSession` whatever the switch (S-M1), so the third is reached
 * only through a fault elsewhere: it is kept, as the account holding the
 * factor is the reason the session was refused.)
 */
export function refuseRequiring(callerId: number, session: Buffer | undefined): void {
	if (twoStepRequired()) error(409, ALREADY_REQUIRED);
	if (sqlite.prepare('SELECT 1 FROM mfa_factors WHERE user_id = ?').get(callerId) === undefined) error(409, REQUIRER_HOLDS_NO_FACTOR);
	const own =
		session === undefined
			? undefined
			: (sqlite.prepare('SELECT two_step AS twoStep FROM sessions WHERE id = ? AND user_id = ?').get(session, callerId) as
					| { twoStep: number }
					| undefined);
	if (own?.twoStep !== 1) error(409, REQUIRER_SIGNED_IN_WITHOUT_CODE);
	const missing = administratorsWithoutFactor();
	if (missing.length > 0) error(409, administratorsFirst(missing));
}

/** What requiring two-step sign-in did: the sessions made on a password alone it ended, and the accounts it marked. */
export type TwoStepRequired = { at: string; sessionsEnded: number; accountsMarked: number };

/**
 * Require two-step sign-in (event E3, R10), in the caller's transaction (a
 * savepoint of its own), after every refusal asked again
 * (`refuseRequiring`):
 *
 *   1. the switch, now (no `ON CONFLICT`: a second press fails);
 *   2. `two_step_released_at`, now, replacing any: migration 0066's line, so
 *      that the 14 days start at E3;
 *   3. 0066's mark: every account holding no factor and no enrolment link may
 *      set up on its password alone for those 14 days, where mail was never
 *      set up;
 *   4. every session made on a password alone (`two_step` 0) ended: 0067's
 *      line, limited to them. The caller's, made with a code, is kept.
 *
 * Remembered browsers of the password-only domain are refused from now on by
 * the switch itself (`rememberedNonce`), and the old cookie name is never read
 * (`oldNameRefusal`). The caller says the CRITICAL line once it is committed.
 */
export function requireTwoStep(callerId: number, session: Buffer | undefined, now: number = Date.now()): TwoStepRequired {
	return inTransaction(() => {
		refuseRequiring(callerId, session);
		const at = stamp(new Date(now));
		sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(TWO_STEP_REQUIRED_AT, at);
		sqlite
			.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
			.run(TWO_STEP_RELEASED_AT, at);
		const accountsMarked = sqlite
			.prepare(
				'UPDATE users SET mfa_password_enrol = 1 ' +
					'WHERE NOT EXISTS (SELECT 1 FROM mfa_factors WHERE mfa_factors.user_id = users.id) ' +
					'AND NOT EXISTS (SELECT 1 FROM enrolment_links WHERE enrolment_links.user_id = users.id)'
			)
			.run().changes;
		const sessionsEnded = sqlite.prepare('DELETE FROM sessions WHERE two_step = 0').run().changes;
		return { at, sessionsEnded, accountsMarked };
	});
}

/**
 * The CRITICAL line of requiring two-step sign-in (R10, kept for good: card
 * 2899), its counts worded as `requireTwoStep` counts them: every session made
 * on a password alone, those kept at the release among them, and every account
 * marked, a disabled one among them.
 */
export const twoStepRequiredLine = (by: { id: number; username: string }, done: Pick<TwoStepRequired, 'sessionsEnded' | 'accountsMarked'>): string =>
	`Two-step sign-in is now required on this server, by ${by.username} (ID: ${by.id}): ${done.sessionsEnded} session(s) made on a ` +
	`password alone ended (sessions kept at the release included); ${done.accountsMarked} account(s) with no second factor and no ` +
	'set-up link (disabled accounts included) may set up on the password alone for 14 days where mail was never set up';

/**
 * The CRITICAL line of a start that finds `two_step_released_at` and no switch
 * (R11, S-L7, decision 51): only a host edit or a restore that went wrong
 * leaves that state.
 */
export const TWO_STEP_TURNED_OFF = 'Two-step sign-in was required on this server and is not now: a host edit or a restore turned it off';

/** Whether this database holds `two_step_released_at` while the switch is absent (R11). */
export function twoStepTurnedOff(database: Pick<typeof sqlite, 'prepare'> = sqlite): boolean {
	return database.prepare('SELECT 1 FROM settings WHERE key = ?').get(TWO_STEP_RELEASED_AT) !== undefined && !twoStepRequired(database);
}
