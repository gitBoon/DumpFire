/**
 * step-up.ts — the caller's password, asked for again before the actions that
 * cannot be taken back (card 2701).
 *
 * Card 2700 stopped a forged request from another site reaching DumpFire's
 * writes. This asks a real session to prove itself again before the writes
 * that destroy data in bulk or for good, create, remove or change an
 * account's credentials, role or address, or send the database, the mail
 * invites go through, or a board's activity (card 2751), somewhere the caller
 * chooses. Whoever holds a signed-in
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
 * guess. Then `currentPassword` and `currentCode` (400 `STEP_UP_MISSING`,
 * nothing counted), the code's form (400 `STEP_UP_CODE_MALFORMED`, nothing
 * counted: card 2771), the account's hash (403 `STEP_UP_NO_PASSWORD` for one
 * that is no bcrypt hash, nothing counted), and the check, counted on the
 * session's row: the account's second factor first (no factor, one that
 * cannot be opened, a code whose step is spent: refused, nothing counted),
 * then the password, then the code, spent with the count cleared; a wrong
 * password or a wrong code is 403 `STEP_UP_WRONG`, never saying which, and
 * the third ends the session (`checkCurrentProof` and `refuseWrongPassword`
 * in auth.ts). A right one is an INFO line naming who, with which code, and
 * for what; a recovery code a WARN line and a notice to the owner, and a
 * wrong code after a right password the owner's banner and a notice. The
 * write then runs in `whilePasswordHolds`, so that it commits only while the
 * stored hash is the one checked; what cannot run in a transaction asks
 * `requirePasswordUnchanged` instead, with nothing awaited before what it
 * guards. A refusal there leaves the code spent (card 2771, S4).
 *
 * Every refusal of the password or the code made here or in auth.ts's check
 * carries its code in `stepUp` (`App.Error`; the code review's F3), which the
 * pages read in place of the words.
 *
 * The import's body is the upload, so its password cannot be in it: it is
 * confirmed first, at `POST /api/admin/import/confirm`, which answers a
 * confirmation good for one import from that session for 60 seconds
 * (`issueImportConfirmation`). The import sends it in the
 * `X-DumpFire-Confirmation` header, and takes it before a byte of the upload
 * is read (`takeImportConfirmation`).
 *
 * The password and the code are never logged or echoed: every refusal is
 * fixed text, and nothing here keeps either beyond the request. The confirmations are kept as
 * SHA-256 digests, beside their session's hash (card 2775).
 */
import { createHash, randomBytes } from 'node:crypto';
import { error, type Cookies } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, sqlite } from './db';
import { users } from './db/schema';
import { passwordReplacedHere } from './account-endings';
import { DUMMY_HASH } from './dummy-hash';
import { getRequestEvent } from '$app/server';
import { checkCurrentProof, refuseWrongPassword, sessionHashIn, type ProofCode, type SessionUser } from './auth';
import { addressOf } from './client-address';
import { createLogger } from './logger';
import { sendSecurityNotice } from './notifications';
import { LONGEST_PASSWORD } from './passwords';
import { canonicalRecoveryCode } from './recovery-codes';
import { readText, type RequestBody } from './request-body';
import { requireUser } from './route-guards';
import { LONGEST_CODE, readAuthenticatorCode } from './totp';
import { writeAs } from './write-as';
import {
	CONFIRMATION_HEADER,
	CONFIRMATION_REFUSED,
	PASSWORD_CHANGED_MEANWHILE,
	STEP_UP_CODE_FIELD,
	STEP_UP_CODE_MALFORMED,
	STEP_UP_CODE_SPENT,
	STEP_UP_FACTOR_UNUSABLE,
	STEP_UP_FIELD,
	STEP_UP_IN_FLIGHT,
	STEP_UP_MISSING,
	STEP_UP_NO_FACTOR,
	STEP_UP_NO_PASSWORD,
	STEP_UP_SIGNED_OUT,
	STEP_UP_WRONG
} from '$lib/step-up-words';

const log = createLogger('AUTH');

/**
 * The field, the answers and the import's header, kept in `$lib/step-up-words`
 * (the pages read them too: a confirm dialog knows a refusal of the password by
 * its words) and answered from here with the rest: `STEP_UP_FIELD`, the body
 * field (not `password`, which two listed routes use for another), and
 * `STEP_UP_CODE_FIELD`, the code's (card 2771); `STEP_UP_MISSING`, no current
 * password or no code, an empty one or one that is not text;
 * `STEP_UP_CODE_MALFORMED`, a code in neither form; `STEP_UP_WRONG`, a wrong
 * password or code; `STEP_UP_NO_PASSWORD`, an account whose stored hash is no
 * bcrypt hash (decision 9: none exists today); `STEP_UP_IN_FLIGHT`,
 * `STEP_UP_SIGNED_OUT`, `STEP_UP_NO_FACTOR`, `STEP_UP_FACTOR_UNUSABLE` and
 * `STEP_UP_CODE_SPENT`, auth.ts's;
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
	STEP_UP_CODE_FIELD,
	STEP_UP_CODE_MALFORMED,
	STEP_UP_CODE_SPENT,
	STEP_UP_FACTOR_UNUSABLE,
	STEP_UP_FIELD,
	STEP_UP_IN_FLIGHT,
	STEP_UP_MISSING,
	STEP_UP_NO_FACTOR,
	STEP_UP_NO_PASSWORD,
	STEP_UP_SIGNED_OUT,
	STEP_UP_WRONG
};

/**
 * The code sent beside the password, by its form (card 2771, D2), or null for
 * one in neither: at most `LONGEST_CODE` characters, then, trimmed with every
 * space dropped, exactly six ASCII digits (the authenticator's, `123 456`
 * among them, by `readAuthenticatorCode`, the rule sign-in shares: card 2889),
 * or a recovery code as `canonicalRecoveryCode` reads one. A six-digit text
 * is never a recovery code (sixteen characters), so the two cannot both
 * match. Pure: nothing read or counted.
 */
export function readStepUpCode(sent: string): ProofCode | null {
	if (sent.length > LONGEST_CODE) return null;
	const digits = readAuthenticatorCode(sent);
	if (digits !== null) return { kind: 'authenticator', digits };
	const trimmed = sent.trim();
	if (canonicalRecoveryCode(trimmed) !== null) return { kind: 'recovery', typed: trimmed };
	return null;
}

/** The address of the request being answered, as a security notice names it, or null outside one. */
function requestAddress(): string | null {
	try {
		return addressOf(getRequestEvent());
	} catch {
		return null;
	}
}

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
	'DELETE /api/users/[id]': 'Removes a disabled account and what goes with it',
	'PUT /api/users/[id]/password': "Sets another account's password: a takeover",
	'POST /api/users/[id]/invite': 'A password reset by another way, whose link is answered when the mail fails',
	// Card 2773: what stands in for a lost authenticator, and hands the caller the link that sets up its successor.
	'POST /api/users/[id]/mfa/reset': "Removes another account's second factor, ends its API keys and the webhooks it set, and issues the link that sets up a new one",
	// Card 2671: an account disabled, which ends its every credential, and enabled again, which lets it sign in.
	'POST /api/users/[id]/disable': "Disables another account: ends its sessions, keys and webhooks, and refuses it at every gate",
	'POST /api/users/[id]/enable': 'Enables a disabled account again: it may sign in with its own password and authenticator',
	'DELETE /api/boards/[id]': 'Deletes a board and everything under it, sub-boards at every depth included, for good',
	'DELETE /api/columns/[id]': 'With a card in it: deletes every card in the column, with their sub-boards and files',
	'POST /api/admin/export': "Hands out every account's password hash and email address",
	'PUT /api/admin/backup': "With destinations: can send every later backup to a destination of the caller's choosing",
	'POST /api/admin/backup': 'Sends the whole database to every destination now',
	'POST /api/admin/backup/gdrive/auth': "Binds a backup destination to a Google account of the caller's choosing",
	'PUT /api/admin/smtp': 'Chooses the mail server invites and resets go through, and (the superadmin alone) the App URL their links point at',
	// Card 2922: a setting held for review put back in use, or removed with, for the mail, every mailed link on the server.
	'POST /api/admin/settings/held':
		"Keeps a held mail server, App URL or backup destination in use, or removes it, which for the mail ends every invite, set-up link and request link on the server",
	// Card 2697 (Q9, Q21): what decides where a decision's record mail and personal links go, and who answers for a participant.
	'PUT /api/decisions/[id]/participants/[participantId]/account':
		"Changes which credential answers for a participant on a decision's record: an account, or a personal link mailed in its place",
	'PUT /api/decisions/[id]/participants/[participantId]/address':
		"Ends a participant's personal link and moves the address their record mail and next link go to",
	'PUT /api/people/[id]': "With email or userId: changes where a person's decision mail and personal links go, or which account answers for them",
	// Card 2697's code review, part B (S1): every other People write that sets or ends an address or an account.
	'POST /api/people': "Adds a person with an address, and perhaps an account, that decide where a decision's record mail and personal links go",
	'DELETE /api/people/[id]': "Deletes a person: ends every personal link they hold, and frees their address for another person",
	'POST /api/people/from-accounts': "Adds people linked to accounts, with the accounts' addresses, which decide where decision mail and links go",
	// Card 2697, B4 (Q9, Q29): a decision's record destroyed, or a decision ended for good with every participant told.
	'DELETE /api/decisions/[id]': "Once opened: deletes a decision's permanent record, its versions, responses and events, for good",
	'POST /api/decisions/[id]/withdraw': "Once opened: ends a decision for good and mails every participant the caller's words",
	// Card 2679 (decision 2): a ruling, permanent and mailed to everyone, and the one-way release of its results.
	'POST /api/decisions/[id]/rule': 'Rules on a decision for good, and mails every participant the ruling and its reason',
	'POST /api/decisions/[id]/release': "Shows a ruled decision's totals and comments, for good, to everyone who can see it",
	// Card 2771 (D7): the Account page's three forms, which asked for the password on their own.
	'PUT /api/account/password': "Changes the account's own password, which ends its other sessions and invites and pauses its report schedules",
	'PUT /api/account/email': "Moves the address the account's invites, resets and security notices go to",
	'POST /api/account/api-keys': 'Makes an API key: a credential that outlives a password change unless it is ended',
	// Card 2772 (D5, D7): a key made on a password alone, before two-step sign-in, kept past its deadline.
	'POST /api/account/api-keys/[id]/keep': 'Keeps an API key made before two-step sign-in past its deadline',
	// Card 2772 (D1-D3, D6, D7): the Account page's two-step section, and the warning at its top.
	'POST /api/account/two-step/authenticators': 'Begins adding an authenticator: a second factor that signs in as the account',
	'DELETE /api/account/two-step/authenticators/[id]': "Removes an authenticator, and ends the account's other sessions",
	'POST /api/account/two-step/recovery-codes': "Replaces the account's recovery codes, each of which signs in in place of a code",
	'DELETE /api/account/two-step/banner': "Clears the warning that someone entered the account's password with a wrong code",
	// Card 2751 (D1, D2): what mails board activity out, on a timetable that outlives the session, or once.
	'POST /api/report-schedules': 'Makes a report schedule: board activity mailed to the addresses it names on a timetable, after this session has ended',
	'PUT /api/report-schedules/[id]':
		'With an address added, turned on, or its status filter widened: starts or widens a timetable that mails board activity outside',
	'POST /api/reports/email': 'Mails a report of board activity to the addresses given'
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
 * Ask the caller of a listed action for their current password and a code,
 * after every refusal that needs neither, and answer what the write needs to
 * be held to it.
 *
 *   (a) `guard`, in a `writeAs` that writes nothing: the session still open,
 *       the account as it is now, and every refusal of the route's that needs
 *       no password. Its answer is `actor`.
 *   (b) `currentPassword`: text of 1 to 1,024 characters (`LONGEST_PASSWORD`,
 *       the most any password may be set to: card 2888), or 400
 *       `STEP_UP_MISSING`. Then `currentCode` (card 2771, D1): text, or 400
 *       `STEP_UP_MISSING`; in one of the two forms (`readStepUpCode`), or 400
 *       `STEP_UP_CODE_MALFORMED`. Nothing is counted.
 *   (c) the session the gate let the request in with (its hash, from
 *       `locals.credential`), or 401; and the account's hash, which must be a
 *       bcrypt hash, or 403 `STEP_UP_NO_PASSWORD` with a WARN line. Nothing
 *       is counted.
 *   (d) the check, counted on the session's row, one at a time, the third
 *       wrong one ending the session: the second factor first (403
 *       `no-factor`, 503 `factor-unusable`, 400 `code-spent`, nothing
 *       counted), then 403 `STEP_UP_WRONG` for a wrong password or code, 403
 *       signed out, or 429 (`checkCurrentProof`, `refuseWrongPassword`). A
 *       right password with a wrong code that raised the owner's banner sends
 *       the `wrong-code` notice (D6).
 *   (e) an INFO line naming who confirmed, with which code, and for what; for
 *       a recovery code, a WARN line with the codes left and the
 *       `recovery-code-used` notice (D12, D13).
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

	// The code, read straight after (card 2771, D1 and D2): missing, empty or
	// not text, and then one in neither form, refused before anything is
	// counted or the session read.
	const typed = Object.hasOwn(body, STEP_UP_CODE_FIELD) ? body[STEP_UP_CODE_FIELD] : undefined;
	if (typeof typed !== 'string' || typed === '') {
		error(400, { message: STEP_UP_MISSING, stepUp: 'missing' });
	}
	const code = readStepUpCode(typed);
	if (code === null) error(400, { message: STEP_UP_CODE_MALFORMED, stepUp: 'code-malformed' });

	// The session the gate let the request in with, as its hash (card 2775).
	const session = sessionHashIn(locals.credential);
	if (!session) error(401, 'Not authenticated');

	const account = db
		.select({ passwordHash: users.passwordHash, createdAt: users.createdAt, role: users.role })
		.from(users)
		.where(eq(users.id, caller.id))
		.get();
	if (!account) error(404, 'User not found');
	if (!BCRYPT_HASH.test(account.passwordHash)) {
		log.warn(
			`Password not confirmed for user ${caller.id} on ${action}: the account has no usable password`,
			{ action },
			{ userId: caller.id }
		);
		error(403, { message: STEP_UP_NO_PASSWORD, stepUp: 'no-password' });
	}

	// A stored hash the record of account endings says was replaced here (card
	// 2997, R5), for anyone but the superadmin: the proof is checked against the
	// hash nothing matches instead, so that it is answered `STEP_UP_WRONG` and
	// counted as a wrong password, in a wrong password's time. The hash answered
	// stays the stored one.
	const replaced = account.role !== 'superadmin' && passwordReplacedHere(sqlite, { id: caller.id, ...account });
	const proven = await checkCurrentProof(session, caller.id, password, code, replaced ? DUMMY_HASH : account.passwordHash, action);
	// Committed by now: the owner told of a right password with a wrong code,
	// as at sign-in, whatever the answer (card 2771, D6). Never awaited.
	if (proven.signalled) sendSecurityNotice(caller.id, 'wrong-code', { at: new Date(), address: requestAddress(), confirming: true });
	refuseWrongPassword(cookies, proven, STEP_UP_WRONG);

	if (proven.by === 'recovery code') {
		const left = proven.codesLeft ?? 0;
		log.info(`Password and a recovery code confirmed by ${caller.username} (ID: ${caller.id}) for ${action}`, { action }, { userId: caller.id });
		log.warn(`A recovery code confirmed ${action} for ${caller.username} (ID: ${caller.id}): ${left} left`, { action }, { userId: caller.id });
		sendSecurityNotice(caller.id, 'recovery-code-used', { at: new Date(), address: requestAddress(), codesLeft: left, confirming: true });
	} else {
		log.info(`Password and code confirmed by ${caller.username} (ID: ${caller.id}) for ${action}`, { action }, { userId: caller.id });
	}
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

/** A confirmation as it is kept: its session's hash in hex, whose it is, the hash checked, and when it ends. */
type Held = { session: string; userId: number; hash: string; endsAt: number };

/** The confirmations not yet taken, by the SHA-256 of each. One per session. */
const confirmations = new Map<string, Held>();

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * A confirmation for one import from the session whose hash is `session`
 * (card 2775: the SHA-256 the confirmation was keyed by before) by the
 * account `userId`, whose password was checked against `hash`: 32 random
 * bytes, base64url, good for
 * `CONFIRMATION_SECONDS`. Only its SHA-256 is kept. A new one replaces the
 * session's last; the expired are swept out as each is issued, and at most
 * `MOST_CONFIRMATIONS` are kept, the oldest going first.
 */
export function issueImportConfirmation(session: Buffer, userId: number, hash: string): string {
	const now = Date.now();
	const ofSession = session.toString('hex');
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
 * `session` (the hash of the session the gate let the request in with):
 * never the request, so that the body is not read here. It is removed
 * whatever it is, and refused 403
 * `CONFIRMATION_REFUSED` when it is missing, unknown, used, expired or
 * another session's. Matched on the session alone: the account it was issued
 * to is answered, for the import to compare with the caller as they are once
 * the upload is in, and the hash, for `requirePasswordUnchanged`.
 */
export function takeImportConfirmation(sent: string | null, session: Buffer | undefined): { userId: number; hash: string } {
	const key = sent ? digest(sent) : undefined;
	const held = key === undefined ? undefined : confirmations.get(key);
	if (key !== undefined) confirmations.delete(key);
	if (!held || session === undefined || held.session !== session.toString('hex') || held.endsAt <= Date.now()) {
		error(403, { message: CONFIRMATION_REFUSED, stepUp: 'confirmation' });
	}
	return { userId: held.userId, hash: held.hash };
}

/** Forget every confirmation not yet taken, as a restart does: for tests, between them, as `forgetConnects`. */
export function forgetImportConfirmations(): void {
	confirmations.clear();
}
