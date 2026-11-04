/**
 * step-up.ts — the caller's password, asked for again before the actions that
 * cannot be taken back (card 2701).
 *
 * Card 2700 stopped a forged request from another site reaching DumpFire's
 * writes. This asks a real session to prove itself again before the writes
 * that destroy data in bulk or for good, create, remove or change an
 * account's credentials, role or address, or send the database, or the mail
 * invites go through, somewhere the caller chooses. Whoever holds a signed-in
 * browser (an unlocked machine, a copied cookie) or runs script in a page can
 * otherwise do each of them with no further proof. The list is
 * `STEP_UP_ACTIONS`, each with why it asks.
 *
 * A listed route reads its body and the fields it can read with no row, then
 * hands `confirmStepUp` the locals, the cookies, the body, its key on the list
 * and its full guard:
 *
 *     requireAdmin(locals.user);
 *     const body = await readBody(request);
 *     const { userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/admin/purge-archived', requireAdmin);
 *     const { purged } = await whilePasswordHolds(userId, hash, () =>
 *         writeAs(locals, (caller) => purgeArchivedCards(requireAdmin(caller))));
 *
 * `confirmStepUp` runs the guard first, read only, in a `writeAs` of its own:
 * the session still open, the role as it is now, and every refusal the write
 * would make that needs no password, so that none of them costs a check or a
 * guess. Then `currentPassword` (400 `STEP_UP_MISSING`, nothing counted), the
 * account's hash (403 `STEP_UP_NO_PASSWORD` for one that is no bcrypt hash,
 * nothing counted), and the check, counted on the session's row: a wrong one
 * is 403 `STEP_UP_WRONG`, and the third ends the session (`checkCurrentPassword`
 * and `refuseWrongPassword` in auth.ts). A right one is an INFO line naming
 * who and for what. The write then runs in `whilePasswordHolds`, so that it
 * commits only while the stored hash is the one checked; what cannot run in
 * a transaction asks `requirePasswordUnchanged` instead, with nothing awaited
 * before what it guards.
 *
 * Every refusal of the password made here or in auth.ts's check carries its
 * code in `stepUp` (`App.Error`; the code review's F3), which the pages read
 * in place of the words.
 *
 * The import's body is the upload, so its password cannot be in it: it is
 * confirmed first, at `POST /api/admin/import/confirm`, which answers a
 * confirmation good for one import from that session for 60 seconds
 * (`issueImportConfirmation`). The import sends it in the
 * `X-DumpFire-Confirmation` header, and takes it before a byte of the upload
 * is read (`takeImportConfirmation`).
 *
 * The password is never logged or echoed: every refusal is fixed text, and
 * nothing here keeps it beyond the request. The confirmations are kept as
 * SHA-256 digests, beside the digest of their session's token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { error, type Cookies } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { users } from './db/schema';
import { SESSION_COOKIE_NAME, checkCurrentPassword, refuseWrongPassword, type SessionUser } from './auth';
import { createLogger } from './logger';
import { readText, type RequestBody } from './request-body';
import { requireUser } from './route-guards';
import { writeAs } from './write-as';
import {
	CONFIRMATION_HEADER,
	CONFIRMATION_REFUSED,
	PASSWORD_CHANGED_MEANWHILE,
	STEP_UP_FIELD,
	STEP_UP_IN_FLIGHT,
	STEP_UP_MISSING,
	STEP_UP_NO_PASSWORD,
	STEP_UP_SIGNED_OUT,
	STEP_UP_WRONG
} from '$lib/step-up-words';

const log = createLogger('AUTH');

/**
 * The field, the answers and the import's header, kept in `$lib/step-up-words`
 * (the pages read them too: a confirm dialog knows a refusal of the password by
 * its words) and answered from here with the rest: `STEP_UP_FIELD`, the body
 * field (not `password`, which two listed routes use for another);
 * `STEP_UP_MISSING`, no current password, an empty one or one that is not
 * text; `STEP_UP_WRONG`, a wrong one; `STEP_UP_NO_PASSWORD`, an account whose
 * stored hash is no bcrypt hash (decision 9: none exists today);
 * `STEP_UP_IN_FLIGHT` and `STEP_UP_SIGNED_OUT`, auth.ts's;
 * `CONFIRMATION_REFUSED`, an import whose confirmation is missing, unknown,
 * used, expired, another session's or no longer good;
 * `PASSWORD_CHANGED_MEANWHILE`, the stored hash moved between the check and
 * the write; and `CONFIRMATION_HEADER`, the header it is sent in, as
 * `Headers` names it.
 */
export {
	CONFIRMATION_HEADER,
	CONFIRMATION_REFUSED,
	PASSWORD_CHANGED_MEANWHILE,
	STEP_UP_FIELD,
	STEP_UP_IN_FLIGHT,
	STEP_UP_MISSING,
	STEP_UP_NO_PASSWORD,
	STEP_UP_SIGNED_OUT,
	STEP_UP_WRONG
};

/** The most characters a current password is read to: bcrypt reads the first 72 bytes anyway. */
const LONGEST_PASSWORD = 1024;

/**
 * The actions that ask for the current password, by `METHOD /route/id` as
 * `UPLOADS` and `LARGER` key theirs, with why (card 2701, decision 2). The
 * import asks at its confirmation, which stands for it here.
 */
export const STEP_UP_ACTIONS = Object.freeze({
	'POST /api/admin/reset': 'Empties every table but the log and the backup history; the next visitor becomes the superadmin',
	'POST /api/admin/import/confirm': "Confirms an import, which replaces every row and every account with the backup's",
	'POST /api/admin/purge-archived': 'Deletes every archived card on every board, for good',
	'POST /api/admin/boards/[id]/clear-cards': 'Deletes every card of a board and of its sub-boards',
	'POST /api/admin/boards/[id]/clear-categories': 'Deletes every category of a board and unsets it on every card',
	'POST /api/admin/reset-xp': "Sets everyone's XP to 0, which cannot be undone",
	'POST /api/users': 'Makes an account: a credential that outlives the session that made it',
	'PUT /api/users/[id]': "With role or email: changes an account's privileges, or the address its invites and resets go to",
	'DELETE /api/users/[id]': 'Removes an account and what goes with it',
	'PUT /api/users/[id]/password': "Sets another account's password: a takeover",
	'POST /api/users/[id]/invite': 'A password reset by another way, whose link is answered when the mail fails',
	'DELETE /api/boards/[id]': 'Deletes a board and everything under it, sub-boards at every depth included, for good',
	'DELETE /api/columns/[id]': 'With a card in it: deletes every card in the column, with their sub-boards and files',
	'POST /api/admin/export': "Hands out every account's password hash and email address",
	'PUT /api/admin/backup': "With destinations: can send every later backup to a destination of the caller's choosing",
	'POST /api/admin/backup': 'Sends the whole database to every destination now',
	'POST /api/admin/backup/gdrive/auth': "Binds a backup destination to a Google account of the caller's choosing",
	'PUT /api/admin/smtp': 'Chooses the mail server invites and resets go through, and the App URL their links point at'
} as const);

/** A key of `STEP_UP_ACTIONS`. */
export type StepUpAction = keyof typeof STEP_UP_ACTIONS;

/** How long a confirmation is good for. */
export const CONFIRMATION_SECONDS = 60;

/** The most confirmations kept at once; the oldest go first. */
const MOST_CONFIRMATIONS = 1000;

/** A bcrypt hash, as `makePasswordHash` stores one. */
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/** `never` for a promise: a transaction's work cannot await (transaction.ts). */
type NotAPromise<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * Ask the caller of a listed action for their current password, after every
 * refusal that needs none, and answer what the write needs to be held to it.
 *
 *   (a) `guard`, in a `writeAs` that writes nothing: the session still open,
 *       the account as it is now, and every refusal of the route's that needs
 *       no password. Its answer is `actor`.
 *   (b) `currentPassword`: text of 1 to 1,024 characters, or 400
 *       `STEP_UP_MISSING`. Nothing is counted.
 *   (c) the session's cookie, or 401; and the account's hash, which must be a
 *       bcrypt hash, or 403 `STEP_UP_NO_PASSWORD` with a WARN line. Nothing
 *       is counted.
 *   (d) the check, counted on the session's row, one at a time, the third
 *       wrong one ending the session: 403 `STEP_UP_WRONG`, 403 signed out, or
 *       429 (`checkCurrentPassword`, `refuseWrongPassword`).
 *   (e) an INFO line naming who confirmed, and for what.
 *
 * It answers the hash the password was checked against, which the write is
 * then held to (`whilePasswordHolds`, `requirePasswordUnchanged`). Not the
 * password: nothing compares it again (the code review's S2).
 */
export async function confirmStepUp<U>(
	locals: App.Locals,
	cookies: Cookies,
	body: RequestBody,
	action: StepUpAction,
	guard: (caller: SessionUser | null) => NotAPromise<U>
): Promise<{ actor: U; userId: number; hash: string }> {
	const { actor, caller } = writeAs(locals, (caller) => ({ actor: guard(caller), caller: requireUser(caller) }));

	// Missing, empty or not text carries its code; too long is said in the
	// reader's own words, as every length limit is (card 2218).
	const sent = Object.hasOwn(body, STEP_UP_FIELD) ? body[STEP_UP_FIELD] : undefined;
	if (typeof sent !== 'string' || sent === '') {
		error(400, { message: STEP_UP_MISSING, stepUp: 'missing' });
	}
	const password = readText(body, STEP_UP_FIELD, { required: true, min: 1, max: LONGEST_PASSWORD });

	const session = cookies.get(SESSION_COOKIE_NAME);
	if (!session) error(401, 'Not authenticated');

	const account = db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, caller.id)).get();
	if (!account) error(404, 'User not found');
	if (!BCRYPT_HASH.test(account.passwordHash)) {
		log.warn(
			`Password not confirmed for user ${caller.id} on ${action}: the account has no usable password`,
			{ action },
			{ userId: caller.id }
		);
		error(403, { message: STEP_UP_NO_PASSWORD, stepUp: 'no-password' });
	}

	refuseWrongPassword(cookies, await checkCurrentPassword(session, caller.id, password, account.passwordHash, action), STEP_UP_WRONG);

	log.info(`Password confirmed by ${caller.username} (ID: ${caller.id}) for ${action}`, { action }, { userId: caller.id });
	return { actor, userId: caller.id, hash: account.passwordHash };
}

/**
 * Refused 403 unless the account's stored hash is still `hash`, the one its
 * password was checked against: in `PASSWORD_CHANGED_MEANWHILE` (`changed`),
 * or for the import in `CONFIRMATION_REFUSED` (`confirmation`), whose proof
 * no longer holds. Synchronous: for what cannot run in a transaction (the
 * import's restore, the export's copy, a backup run), asked with nothing
 * awaited between it and what it guards.
 */
export function requirePasswordUnchanged(userId: number, hash: string, refusal: 'changed' | 'confirmation'): void {
	const now = db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).get();
	if (now && now.passwordHash === hash) return;
	if (refusal === 'confirmation') error(403, { message: CONFIRMATION_REFUSED, stepUp: 'confirmation' });
	error(403, { message: PASSWORD_CHANGED_MEANWHILE, stepUp: 'changed' });
}

// ─── The import's confirmation ──────────────────────────────────────────────

/** A confirmation as it is kept: the digest of its session's token, whose it is, the hash checked, and when it ends. */
type Held = { session: string; userId: number; hash: string; endsAt: number };

/** The confirmations not yet taken, by the SHA-256 of each. One per session. */
const confirmations = new Map<string, Held>();

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * A confirmation for one import from `session` by the account `userId`, whose
 * password was checked against `hash`: 32 random bytes, base64url, good for
 * `CONFIRMATION_SECONDS`. Only its SHA-256 is kept. A new one replaces the
 * session's last; the expired are swept out as each is issued, and at most
 * `MOST_CONFIRMATIONS` are kept, the oldest going first.
 */
export function issueImportConfirmation(session: string, userId: number, hash: string): string {
	const now = Date.now();
	const ofSession = digest(session);
	for (const [key, held] of confirmations) {
		if (held.endsAt <= now || held.session === ofSession) confirmations.delete(key);
	}
	while (confirmations.size >= MOST_CONFIRMATIONS) confirmations.delete(confirmations.keys().next().value!);
	const confirmation = randomBytes(32).toString('base64url');
	confirmations.set(digest(confirmation), { session: ofSession, userId, hash, endsAt: now + CONFIRMATION_SECONDS * 1000 });
	return confirmation;
}

/**
 * Take the confirmation `sent` (the header's text) for an import from
 * `session` (the session cookie's token): never the request, so that the
 * body is not read here. It is removed whatever it is, and refused 403
 * `CONFIRMATION_REFUSED` when it is missing, unknown, used, expired or
 * another session's. Matched on the session alone: the account it was issued
 * to is answered, for the import to compare with the caller as they are once
 * the upload is in, and the hash, for `requirePasswordUnchanged`.
 */
export function takeImportConfirmation(sent: string | null, session: string | undefined): { userId: number; hash: string } {
	const key = sent ? digest(sent) : undefined;
	const held = key === undefined ? undefined : confirmations.get(key);
	if (key !== undefined) confirmations.delete(key);
	if (!held || session === undefined || held.session !== digest(session) || held.endsAt <= Date.now()) {
		error(403, { message: CONFIRMATION_REFUSED, stepUp: 'confirmation' });
	}
	return { userId: held.userId, hash: held.hash };
}

/** Forget every confirmation not yet taken, as a restart does: for tests, between them, as `forgetConnects`. */
export function forgetImportConfirmations(): void {
	confirmations.clear();
}
