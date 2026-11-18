/**
 * account-two-step.ts — the Two-step sign-in section of the Account page, and
 * the warning at its top (card 2772, D1-D3, D6, D10).
 *
 * What each of the section's routes does, apart from reading its body and
 * asking for the password and a code (the step-up, step-up.ts):
 *
 *   - adding an authenticator: its name read (`authenticatorLabel`), whether
 *     one more may be held (`mayStartAdding`: at most `MOST_AUTHENTICATORS`,
 *     the MFA key loaded), the pending add issued once the step-up's write has
 *     returned (`startAdding`, pending-authenticators.ts), and the new phone's
 *     first code, which writes the factor (`finishAdding`);
 *   - removing one (`removable`, `removeFactor`): never the last, and only
 *     while another opens here; the account's other sessions and pending
 *     sign-ins end with it;
 *   - a new set of recovery codes (`regenerateRecoveryCodes`);
 *   - That was me (`dismissable`, `dismissBanner`): clears the warning only
 *     as the page showed it, compared and cleared in one statement;
 *   - what the page loads (`twoStepView`): never a secret, a key id, a factor
 *     uid, a spent step, a recovery code or a pending id.
 *
 * Each write is called inside the route's `writeAs`, the step-up's in its
 * `whilePasswordHolds`, and asks its refusals again there. Its log line and
 * its notice wait for the commit. Nothing here logs a name, a secret, a code
 * or a pending id.
 */
import { error } from '@sveltejs/kit';
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { db } from './db';
import { mfaFactors, mfaRecoveryCodes, users } from './db/schema';
import { afterCommit } from './db/transaction';
import { endOtherSessions } from './auth';
import { createLogger } from './logger';
import { currentMfaKey } from './mfa-key';
import { MOST_AUTHENTICATORS, addTotpFactor, endPendingSignIns, factorOpens, spendStep, storeRecoveryCodes } from './mfa-store';
import { sendSecurityNotice } from './notifications';
import { OTPAUTH_ISSUER, otpauthUri, qrDataUri, secretInGroups } from './otpauth';
import {
	countPendingWrong,
	forgetPendingAdd,
	isPendingId,
	issuePendingAdd,
	openPendingSecret,
	pendingAddOf,
	wasReplacedBy
} from './pending-authenticators';
import { newRecoveryCodes } from './recovery-codes';
import { schedulesOnOf } from './reports';
import { ENROL_WRONG_CODE, NO_MFA_KEY, bannerWords, keysAndWebhooksOf } from './second-step';
import { matchingStep } from './totp';
import { PASSWORD_CHANGED_MEANWHILE } from '$lib/step-up-words';
import { stamp, toStamp } from '$lib/timestamps';

const log = createLogger('AUTH');

// ─── Words (D12) ────────────────────────────────────────────────────────────

export const MOST_AUTHENTICATORS_WORDS = 'You have three authenticators, the most an account can hold. Remove one first.';
export const LABEL_MISSING = 'Name this authenticator, such as Work phone.';
/** The longest name an authenticator is given, in characters once its white space is collapsed. */
export const LONGEST_LABEL = 40;
export const LABEL_TOO_LONG = `label must be at most ${LONGEST_LABEL} characters`;
export const LABEL_UNPRINTABLE = 'The name cannot hold control or formatting characters.';
export const ADD_ENDED = 'This set-up has ended. Start again with Add an authenticator.';
export const ADD_REPLACED = 'This set-up was replaced by a newer one. Use the newest, or start again.';
export const ADD_TOO_MANY = 'Too many wrong codes. Start again with Add an authenticator.';
export const NEW_CODE_MALFORMED = 'Enter the 6-digit code from your new authenticator app.';
export const ONLY_AUTHENTICATOR = 'This is your only authenticator. Add the new one first, then remove this one.';
export const NONE_OTHER_OPENS =
	'Your other authenticator cannot be checked on this server right now, so this one cannot be removed. Ask an administrator.';
export const AUTHENTICATOR_NOT_FOUND = 'Authenticator not found';
export const NO_BANNER = 'There is no warning to dismiss.';
export const NEWER_BANNER = 'A newer warning arrived. Read it, then dismiss it again.';

/** Wrong codes for one pending add that end it: the fifth (D1). */
export const WRONG_ADD_CODES = 5;

/** The most characters a new phone's code is read to: longer is malformed. */
const LONGEST_CODE = 64;

// ─── Reading what is sent ──────────────────────────────────────────────────

/**
 * An authenticator's name as it is kept (D1, S9, E17): every run of white
 * space collapsed to one space and the ends trimmed; then 1 to
 * `LONGEST_LABEL` characters, with no Unicode control or format character
 * (`\p{Cc}`, `\p{Cf}`). Refused 400 otherwise, nothing counted.
 */
export function authenticatorLabel(sent: string): string {
	const label = sent.replace(/\s+/gu, ' ').trim();
	if (label === '') error(400, LABEL_MISSING);
	if ([...label].length > LONGEST_LABEL) error(400, LABEL_TOO_LONG);
	if (/[\p{Cc}\p{Cf}]/u.test(label)) error(400, LABEL_UNPRINTABLE);
	return label;
}

/**
 * The new phone's code as the confirm reads it (D1.3, E28): at most
 * `LONGEST_CODE` characters, then six ASCII digits once the ends are trimmed
 * and every space dropped; refused 400 `NEW_CODE_MALFORMED` otherwise, before
 * anything is read or counted.
 */
export function newPhoneCode(sent: string): string {
	if (sent.length > LONGEST_CODE) error(400, NEW_CODE_MALFORMED);
	const digits = sent.trim().replace(/ /g, '');
	if (!/^[0-9]{6}$/.test(digits)) error(400, NEW_CODE_MALFORMED);
	return digits;
}

// ─── Adding an authenticator (D1) ──────────────────────────────────────────

/** How many authenticators the account holds. */
export function authenticatorsOf(userId: number): number {
	return db
		.select({ n: sql<number>`count(*)` })
		.from(mfaFactors)
		.where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.kind, 'totp')))
		.get()!.n;
}

/**
 * Refused unless the account may begin adding an authenticator: 409 at
 * `MOST_AUTHENTICATORS` (D4), 503 `NO_MFA_KEY` with no MFA key loaded, so
 * that none could be sealed. Asked by the start's guard, nothing counted, and
 * again in its write.
 */
export function mayStartAdding(userId: number): void {
	if (authenticatorsOf(userId) >= MOST_AUTHENTICATORS) error(409, MOST_AUTHENTICATORS_WORDS);
	if (currentMfaKey() === null) error(503, NO_MFA_KEY);
}

/** What the start answers, for the page to show once (`Cache-Control: no-store`). */
export type AddingStarted = { pendingId: string; account: string; issuer: string; secret: string; qr: string; expiresAt: string };

/**
 * Begin adding an authenticator named `label` for the account `userId`, signed
 * in as `account`, from the session whose hash is `session`, its password
 * checked against `passwordHash` (D1.1, D1.2). Called after the step-up's
 * write has returned (S7): a pending add replacing any the account held, and
 * an INFO line. The secret is zeroed once it is written into the answer.
 */
export function startAdding(userId: number, account: string, session: Buffer, passwordHash: string, label: string): AddingStarted {
	const issued = issuePendingAdd(userId, session, passwordHash, label);
	try {
		log.info(`Authenticator set-up begun by user ${userId}`, undefined, { userId });
		return {
			pendingId: issued.pendingId,
			account,
			issuer: OTPAUTH_ISSUER,
			secret: secretInGroups(issued.secret),
			qr: qrDataUri(otpauthUri(account, issued.secret)),
			expiresAt: stamp(new Date(issued.expiresAt))
		};
	} finally {
		issued.secret.fill(0);
	}
}

/** The authenticator the confirm wrote. */
export type AuthenticatorAdded = { id: number; label: string; createdAt: string };

/**
 * The new phone's first code (D1.3), inside the confirm's `writeAs`, for the
 * account `userId` from the session whose hash is `session`. In order, each
 * refusal writing nothing:
 *
 *   - no live pending add for the account: 409 `ADD_ENDED`;
 *   - `pendingId` not the live one's: 409 `ADD_REPLACED` (E19), whichever
 *     session began the newer, when it is one of the last two the live one
 *     replaced (`wasReplacedBy`); any other id 409 `ADD_ENDED`, so that a
 *     session sending a made-up id learns nothing of an add under way (CS2);
 *   - one another session began: 409 `ADD_ENDED`;
 *   - the password changed since the step-up: forgotten, 409
 *     `PASSWORD_CHANGED_MEANWHILE`;
 *   - no authenticator held (the account was reset): forgotten, 409
 *     `ADD_ENDED`; three held: forgotten, 409 `MOST_AUTHENTICATORS_WORDS`;
 *   - its secret not opening here: 503 `NO_MFA_KEY`, kept;
 *   - a wrong code: counted, 400 `ENROL_WRONG_CODE`; the fifth forgets it,
 *     409 `ADD_TOO_MANY`.
 *
 * A right code: the factor written with the name, the code's step spent (one
 * that cannot be is a fault, and throws), the pending add forgotten; after the
 * commit an INFO line and the `factor-added` notice.
 */
export function finishAdding(
	userId: number,
	session: Buffer,
	pendingId: string,
	digits: string,
	address: string | null,
	now: number = Date.now()
): AuthenticatorAdded {
	const add = pendingAddOf(userId, now);
	if (add === undefined) error(409, ADD_ENDED);
	if (!isPendingId(add, pendingId)) error(409, wasReplacedBy(add, pendingId) ? ADD_REPLACED : ADD_ENDED);
	if (add.session !== session.toString('hex')) error(409, ADD_ENDED);

	const account = db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).get();
	if (!account || account.passwordHash !== add.passwordHash) {
		forgetPendingAdd(userId);
		error(409, PASSWORD_CHANGED_MEANWHILE);
	}
	const held = authenticatorsOf(userId);
	if (held === 0) {
		forgetPendingAdd(userId);
		error(409, ADD_ENDED);
	}
	if (held >= MOST_AUTHENTICATORS) {
		forgetPendingAdd(userId);
		error(409, MOST_AUTHENTICATORS_WORDS);
	}

	const secret = openPendingSecret(add);
	if (secret === null) error(503, NO_MFA_KEY);
	try {
		const step = matchingStep(secret, digits, now);
		if (step === null) {
			if (countPendingWrong(add) >= WRONG_ADD_CODES) {
				forgetPendingAdd(userId);
				error(409, ADD_TOO_MANY);
			}
			error(400, ENROL_WRONG_CODE);
		}
		const { id } = addTotpFactor(userId, add.label, secret);
		if (spendStep(id, step) !== 'spent') throw new Error('The first code of a new authenticator could not be spent.');
		forgetPendingAdd(userId);
		const createdAt = db.select({ createdAt: mfaFactors.createdAt }).from(mfaFactors).where(eq(mfaFactors.id, id)).get()!.createdAt;
		const label = add.label;
		afterCommit(() => {
			log.info(`Authenticator ${id} added by user ${userId}`, { factorId: id }, { userId });
			sendSecurityNotice(userId, 'factor-added', { at: new Date(now), address, authenticator: { label, createdAt } });
		});
		return { id, label, createdAt };
	} finally {
		secret.fill(0);
	}
}

// ─── Removing an authenticator (D2) ────────────────────────────────────────

/**
 * The account's own authenticator `factorId`, if it may be removed now:
 * refused 404 when it is not the account's (or not there), 409
 * `ONLY_AUTHENTICATOR` when no other is held, and 409 `NONE_OTHER_OPENS` when
 * none of the others opens under this server's key (S8). Asked by the guard,
 * nothing counted, and again in the write.
 */
export function removable(userId: number, factorId: number): typeof mfaFactors.$inferSelect {
	const factor = db
		.select()
		.from(mfaFactors)
		.where(and(eq(mfaFactors.id, factorId), eq(mfaFactors.userId, userId)))
		.get();
	if (!factor) error(404, AUTHENTICATOR_NOT_FOUND);
	const others = db
		.select()
		.from(mfaFactors)
		.where(and(eq(mfaFactors.userId, userId), ne(mfaFactors.id, factorId)))
		.orderBy(mfaFactors.id)
		.all();
	if (others.length === 0) error(409, ONLY_AUTHENTICATOR);
	if (!others.some((other) => other.kind === 'totp' && factorOpens(other))) error(409, NONE_OTHER_OPENS);
	return factor;
}

/**
 * Remove the account's authenticator `factorId` (D2), inside the route's
 * write, the session whose hash is `session` being the one that asked: asked
 * again (`removable`), then together the factor deleted, every other session
 * of the account ended and this one kept, and every pending sign-in and
 * enrolment link ended. After the commit: a pending add another session holds
 * forgotten, a WARN line, and the `factor-removed` notice listing the
 * account's live API keys and webhooks, and its report schedules that are on
 * (card 2894, D4). The schedules are listed and not paused: whoever removed
 * the authenticator holds the password and a code, and could turn one
 * straight back on, while the real owner removing a lost phone would only
 * lose their reports. Answers how many sessions ended.
 */
export function removeFactor(userId: number, factorId: number, session: Buffer, address: string | null, now: number = Date.now()): { sessionsEnded: number } {
	const factor = removable(userId, factorId);
	db.delete(mfaFactors).where(and(eq(mfaFactors.id, factorId), eq(mfaFactors.userId, userId))).run();
	const sessionsEnded = endOtherSessions(userId, session);
	endPendingSignIns(userId);
	const live = keysAndWebhooksOf(userId, now);
	const schedules = schedulesOnOf(userId);
	const authenticator = { label: factor.label, createdAt: factor.createdAt };
	afterCommit(() => {
		forgetPendingAdd(userId, session);
		log.warn(`Authenticator ${factorId} removed by its owner, user ${userId}: ${sessionsEnded} other session(s) ended`, { factorId }, { userId });
		sendSecurityNotice(userId, 'factor-removed', { at: new Date(now), address, authenticator, ...live, schedules });
	});
	return { sessionsEnded };
}

// ─── Recovery codes (D3) ───────────────────────────────────────────────────

/**
 * A new set of ten recovery codes for the account, in place of every code it
 * held, inside the route's write; answered once, as `XXXX-XXXX-XXXX-XXXX`.
 * After the commit: an INFO line and the `codes-regenerated` notice.
 */
export function regenerateRecoveryCodes(userId: number, address: string | null, now: number = Date.now()): string[] {
	const codes = newRecoveryCodes();
	storeRecoveryCodes(userId, codes);
	afterCommit(() => {
		log.info(`Recovery codes regenerated by user ${userId}`, undefined, { userId });
		sendSecurityNotice(userId, 'codes-regenerated', { at: new Date(now), address });
	});
	return codes;
}

// ─── The warning at the top of the page (D6) ───────────────────────────────

/**
 * The moment of the account's latest signal, as the page is given it and
 * sends it back to clear the warning (card 2772's code review, CS1):
 * `security_signal_last_at`, which every signal sets, or `security_banner_at`
 * where it is NULL (a banner raised before migration 0069, or restored from
 * a backup made before it).
 */
const latestSignal = sql<string | null>`coalesce(${users.securitySignalLastAt}, ${users.securityBannerAt})`;

/**
 * Refused 409 unless the account's warning is the one the page showed: none
 * set is `NO_BANNER`; a latest signal other than `signalAt`, the one the page
 * showed, is `NEWER_BANNER` (S3, CS1), a signal inside the banner's hour
 * included. Asked by the guard, nothing counted.
 */
export function dismissable(userId: number, signalAt: string): void {
	const held = db.select({ banner: users.securityBanner, latest: latestSignal }).from(users).where(eq(users.id, userId)).get();
	if (!held || held.banner === null) error(409, NO_BANNER);
	if (held.latest !== signalAt) error(409, NEWER_BANNER);
}

/**
 * Clear the account's warning, only as the page showed it (S3, A16, CS1):
 * one UPDATE of the banner, its time and the latest signal's, where the
 * latest signal is still `signalAt`, which must change the row, or 409 as
 * `dismissable` answers. An INFO line after the commit.
 */
export function dismissBanner(userId: number, signalAt: string): void {
	dismissable(userId, signalAt);
	const changed = db
		.update(users)
		.set({ securityBanner: null, securityBannerAt: null, securitySignalLastAt: null })
		.where(and(eq(users.id, userId), isNotNull(users.securityBanner), sql`${latestSignal} = ${signalAt}`))
		.run().changes;
	if (changed !== 1) error(409, NEWER_BANNER);
	afterCommit(() => log.info(`Security banner dismissed by user ${userId}`, undefined, { userId }));
}

// ─── What the page loads (D10) ─────────────────────────────────────────────

/** A moment in the stored form as the section says it, `2026-11-17 09:12 UTC`, or as it is when it names none. */
export function momentWords(at: string): string {
	const stored = toStamp(at);
	return stored === null ? at : `${stored.slice(0, 16)} UTC`;
}

/** What the section says of the recovery codes left (D3, E20). */
export function codesLeftWords(left: number): string {
	if (left === 0) return 'You have no recovery codes left. Make a new set now: without them, a lost phone means asking an administrator.';
	if (left === 1) return '1 recovery code left. Make a new set.';
	if (left <= 3) return `${left} recovery codes left. Make a new set.`;
	return `${left} recovery codes left.`;
}

/** What the Account page loads for the section and the warning at its top. */
export type TwoStepView = {
	factors: { id: number; label: string; kind: string; createdAt: string; lastUsedAt: string | null }[];
	codesLeft: number;
	/**
	 * The warning, in words; when it was raised (`security_banner_at`); and
	 * the moment of the latest signal, which the page shows when it is later
	 * and sends back to clear the warning (CS1). Null when none is set.
	 */
	banner: { words: string; at: string | null; latestAt: string | null } | null;
	lastSignInAt: string | null;
	lastSignInFrom: string | null;
	failedCodesSince: number;
	most: number;
	keys: { name: string; createdAt: string; lastUsedAt: string | null }[];
	webhooks: { board: string; host: string; createdAt: string }[];
	/** The section's lines: the codes left (D3), the last sign-in and the wrong codes since it, only when there were any (E23). */
	words: { codesLeft: string; lastSignIn: string | null; wrongCodes: string | null };
};

/**
 * What the section shows of the account `userId` (D10), read at `now`: its
 * authenticators in the order they were added, its unused recovery codes, the
 * warning, its last sign-in and the wrong codes since, and its live keys and
 * webhooks for the Remove dialog (S4). Never a secret, a key id, a factor
 * uid, a spent step, a recovery code or a pending id.
 */
export function twoStepView(userId: number, now: number = Date.now()): TwoStepView {
	const factors = db
		.select({ id: mfaFactors.id, label: mfaFactors.label, kind: mfaFactors.kind, createdAt: mfaFactors.createdAt, lastUsedAt: mfaFactors.lastUsedAt })
		.from(mfaFactors)
		.where(eq(mfaFactors.userId, userId))
		.orderBy(mfaFactors.id)
		.all();
	const codesLeft = db
		.select({ n: sql<number>`count(*)` })
		.from(mfaRecoveryCodes)
		.where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)))
		.get()!.n;
	const user = db
		.select({
			banner: users.securityBanner,
			bannerAt: users.securityBannerAt,
			latestAt: latestSignal,
			lastSignInAt: users.lastSignInAt,
			lastSignInFrom: users.lastSignInFrom,
			failedCodesSince: users.failedCodesSinceSignIn
		})
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (!user) error(404, 'User not found');
	const { apiKeys: keys, webhooks } = keysAndWebhooksOf(userId, now);
	return {
		factors,
		codesLeft,
		banner: user.banner === null ? null : { words: bannerWords(user.banner), at: user.bannerAt, latestAt: user.latestAt },
		lastSignInAt: user.lastSignInAt,
		lastSignInFrom: user.lastSignInFrom,
		failedCodesSince: user.failedCodesSince,
		most: MOST_AUTHENTICATORS,
		keys,
		webhooks,
		words: {
			codesLeft: codesLeftWords(codesLeft),
			lastSignIn:
				user.lastSignInAt === null
					? null
					: `Last sign-in to your account: ${momentWords(user.lastSignInAt)}${user.lastSignInFrom === null ? '' : ` from ${user.lastSignInFrom}`}.`,
			wrongCodes: user.failedCodesSince > 0 ? `Wrong codes entered since: ${user.failedCodesSince}.` : null
		}
	};
}
