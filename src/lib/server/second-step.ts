/**
 * second-step.ts — what a right password leads to, and the second step that
 * signs in (card 2769).
 *
 * A right password at an account that holds a second factor no longer signs
 * in: `afterPassword` opens a ten-minute challenge (sign-in-challenges.ts) and
 * sends the browser to `/login/verify`, where `verifyStep` checks an
 * authenticator code or a recovery code against it, and only then is a
 * session made (`finishSignIn`). An account that holds none is given an enrol
 * challenge instead, on a set-up link it brought or, within the 14 days after
 * the release and where no mail host is configured, on its password alone;
 * where mail is set up it is emailed a link, and otherwise it needs one from
 * an administrator (decision 8). An enrol challenge sends the browser to
 * `/login/enrol`, where it sets one up
 * (`enrolView`, `enrolCode`, `enrolConfirm`): the QR code and the secret, the
 * first code, the ten recovery codes, and a confirm that writes the factor,
 * the codes and the session in one transaction. An invite and the first-run
 * set-up issue the same challenge after the password is set.
 *
 * Every function here takes values, never a request body: each form action
 * reads its own form in its `+page.server.ts` and hands the values on (I10).
 *
 * `verifyStep`, `enrolCode` and `enrolConfirm` are synchronous, and their
 * actions await nothing but the form before calling them (decision 6):
 * reading the challenge, counting, comparing, and taking the challenge with
 * the session or the factor are one stretch that no other request can come
 * between, so there is no check in flight to guard, and the take is an
 * invariant. tests/two-step-sign-in.test.ts T29 holds it.
 *
 * Counters (D4, section 4.5): every wrong code is counted on the challenge
 * (five end it), on its lane (`mfa_known_wrong` for a browser remembered for
 * the account, `mfa_other_wrong` for any other), which pauses code entry at
 * 5, 10, 15, 20 and 25 and locks it at 30, and on
 * `failed_codes_since_sign_in`. A code is tried against every authenticator
 * of the account, and the lane counts one for each tried (card 2772, D4): the
 * challenge and `failed_codes_since_sign_in` count the code once. A recovery
 * code always works, past a pause or the lock: a wrong one counts on the challenge, on `mfa_recovery_wrong` and
 * on the address's sign-in attempts, with no pause of its own (decision 14).
 */
import { error, fail, redirect, type ActionFailure, type Cookies } from '@sveltejs/kit';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, sqlite } from './db';
import { apiKeys, boards, mfaRecoveryCodes, users, webhooks, type User } from './db/schema';
import { afterCommit, inTransaction } from './db/transaction';
import { registerStampFunctions } from './db/timestamps';
import { AccountDisabled, createSession, keyEnded, setSessionCookie, type NewSession } from './auth';
import { rememberBrowser } from './known-browsers';
import { accountKey, countSignInAttempt, forgetWrongSignIns, refundSignInAttempts } from './rate-limit';
import { currentMfaKey } from './mfa-key';
import { twoStepRequired } from './two-step-switch';
import {
	addTotpFactor,
	endPendingSignIns,
	holdsFactor,
	issueEnrolmentLink,
	matchFactors,
	releaseWindowOpen,
	spendRecoveryCode,
	spendStep,
	storeRecoveryCodes,
	usableEnrolmentLink
} from './mfa-store';
import { sha256Hex } from './mfa-crypto';
import { PLACEHOLDER_ORIGIN, isSmtpConfigured, linkBaseUrl, mailCannotSend, mailEverConfigured, mailProblemWords } from './email';
import { endUnusedInvites } from './invites';
import { matchingStep, readAuthenticatorCode } from './totp';
import { canonicalRecoveryCode, newRecoveryCodes } from './recovery-codes';
import { OTPAUTH_ISSUER, otpauthUri, qrDataUri, secretInGroups } from './otpauth';
import {
	CODES_LOCKED_AT,
	countChallengeWrong,
	deleteChallenge,
	deleteChallengeCookie,
	deleteEnrolLinkCookie,
	issueChallenge,
	liveChallenge,
	moveEnrolStage,
	openEnrolState,
	pauseCrossed,
	raiseSignal,
	setChallengeCookie,
	takeChallenge,
	uncountChallengeWrong,
	type ChallengePurpose,
	type ChallengeRow
} from './sign-in-challenges';
import { sendReleaseLinkMail, sendSecurityNotice, type SecurityNotice, type SecurityNoticeDetail } from './notifications';
import type { Lane } from './passwords';
import { createLogger } from './logger';
import { parseStamp, stamp, toStamp } from '$lib/timestamps';

const log = createLogger('AUTH');

// ─── Words (4.8) ────────────────────────────────────────────────────────────

export const NO_MFA_KEY = 'Two-step sign-in cannot be set up on this server right now. Ask an administrator.';
export const PASSWORD_CHANGED_DURING_SIGN_IN = 'Your password was changed while you were signing in. Sign in again with the new one.';
export const SIGN_IN_EXPIRED = 'This sign-in has expired or was already used. Sign in again.';
export const NO_CODE = 'Enter the 6-digit code from your authenticator app.';
export const WRONG_CODE = 'That code is not right. Check your authenticator app and try again.';
export const TOO_MANY_WRONG_CODES = 'Too many wrong codes. Sign in again.';
export const CODES_LOCKED =
	'Authenticator codes are locked for this account after too many wrong codes. Use a recovery code, or ask an ' +
	'administrator to reset your two-step sign-in.';
export const STEP_SPENT = 'That code has just been used. Wait for the next code and enter that one.';
export const FACTOR_UNUSABLE =
	'Your authenticator cannot be checked on this server right now. Use a recovery code, or ask an administrator.';
export const WRONG_RECOVERY_CODE = 'That recovery code is not right, or it has already been used.';
export const MALFORMED_RECOVERY_CODE = 'A recovery code is 16 letters and digits, written as XXXX-XXXX-XXXX-XXXX.';
export const MALFORMED_CODE =
	"That code is not in the right form. Enter the 6 digits from your authenticator app, or choose 'Use a recovery code instead'.";
export const ENROL_WRONG_CODE =
	'That code is not right. Check that your phone sets its clock automatically, then enter the current code.';
export const ENROL_NOT_READY = 'This step is not ready yet. Follow the set-up page from the top.';
export const ENROL_CANNOT_FINISH = 'This set-up can no longer be finished. Sign in again.';
export const NEEDS_LINK =
	'Two-step sign-in is now required, and this account needs a set-up link before it can sign in. Ask an administrator for one.';
export const LINK_EMAILED =
	'Two-step sign-in is now required. We have emailed a link to set it up to the address on your account. It works for 7 days.';
export const COULD_NOT_EMAIL = 'We could not email you a set-up link just now. Try again in a few minutes, or ask an administrator for one.';
export const LINK_DEAD =
	'This set-up link no longer works. It has expired, it has been used, or a newer one was issued. Ask an administrator for a new one.';
export const SIGN_OUT_FIRST = 'You are signed in. Sign out first, then open this link again.';
export const SET_UP_UNDER_WAY =
	'Two-step sign-in is being set up for this account from the link we emailed. Finish it there, or sign in again in ten minutes.';

/**
 * The words for a sign-in while a release-mail link under a day old is live:
 * `hours` whole hours since it was mailed, and when a new one may be had.
 */
export const linkAlreadyEmailed = (hours: number, next: Date): string =>
	`We emailed you a set-up link ${hours === 0 ? 'less than an hour' : `${hours} hour(s)`} ago. Check your inbox and spam folder; it ` +
	`works for 7 days. If you cannot find it, ask an administrator, or sign in again after ${stamp(next)} UTC for a new one.`;

/** What a new authenticator is labelled. */
const FACTOR_LABEL = 'Authenticator';

/** The words for a paused lane, `minutes` from now. */
export const codesPaused = (minutes: number): string =>
	`Code entry is paused after too many wrong codes. Try again in ${minutes} minute(s), or use a recovery code.`;

/** Wrong codes on one challenge that end it (D4). */
export const WRONG_CODES_PER_CHALLENGE = 5;

/** Consecutive wrong recovery codes at each multiple of which the owner is told (decision 14). */
const RECOVERY_GUESSES_NOTICE_EVERY = 10;

/** What the security banner's reason says on the page after a right code (decision 16). */
const BANNER_WORDS: Record<string, string> = {
	'wrong-code': 'Someone entered your password and then a wrong code.',
	'unfinished-sign-in': 'Someone entered your password and did not finish signing in.'
};

/**
 * The security banner's reason in words, as the page after a right code and
 * the top of the Account page say it (decision 16; card 2772, D6, F3): a
 * reason this server does not know is said as the password being known.
 */
export function bannerWords(reason: string): string {
	return Object.hasOwn(BANNER_WORDS, reason) ? BANNER_WORDS[reason] : 'Someone may know your password.';
}

/** The lane's two columns on `users`. Written into SQL from here alone, never from a request. */
const LANE_COLUMNS: Record<Lane, { wrong: string; resumesAt: string }> = {
	known: { wrong: 'mfa_known_wrong', resumesAt: 'mfa_known_resumes_at' },
	other: { wrong: 'mfa_other_wrong', resumesAt: 'mfa_other_resumes_at' }
};

/** An account as a log line names it. */
const named = (user: Pick<User, 'id' | 'username'>) => `"${user.username.slice(0, 100)}" (user ${user.id})`;

/** The lane a challenge's codes are counted in. */
function laneOf(challenge: Pick<ChallengeRow, 'lane'>): Lane {
	return challenge.lane === 'known' ? 'known' : 'other';
}

/** A refusal of the code page or the set-up page: the words, and whether the browser must sign in again. */
export type StepFailure = ActionFailure<{ error: string; restart: boolean }>;

/** Answer a refusal; one that sends the browser to sign in again deletes its challenge cookie. */
function refuse(cookies: Cookies, url: URL, status: number, error: string, restart = false): StepFailure {
	if (restart) deleteChallengeCookie(cookies, url);
	return fail(status, { error, restart });
}

// ─── The password step ──────────────────────────────────────────────────────

/** A right password, as the login action hands it on. */
export type PasswordAccepted = {
	/** The account, as read before its password was checked. */
	user: User;
	/** The hash the password was checked against (decision 26). */
	checkedHash: string;
	/** The nonce of the cookie that remembers this browser for the account, or null. */
	remembered: string | null;
	/** The address as received, for the log; null where there is none. */
	address: string | null;
	/** What the address is counted as by sign-in's limits, given back by a password-only sign-in (card 3064, R3). */
	countedAs: string;
	/** The name as typed, for the answer. */
	identity: string;
	/** The challenge token this browser already holds, if any. */
	previousToken: string | null;
	/** The set-up link this browser was left by `/enrol/[token]`, if any (decision 19). */
	linkToken: string | null;
};

type LoginFailure = ActionFailure<{ error: string; identity: string }>;
/** A right password that opens no second step and is told why, on the sign-in page: a release mail went, or went earlier. */
export type LoginNotice = { notice: string; identity: string };

/** The issuer the release mail's links are written under (decision 23). */
const RELEASE_MAIL = 'release-mail';

/** How long a release-mail link must be live before a sign-in mails another: a day (decision 23). */
const RELEASE_MAIL_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * What a right password leads to (4.2, decision 8). An account that holds a
 * factor is given a verify challenge and sent to `/login/verify`, whether or
 * not the MFA key is loaded: without it an authenticator code is answered
 * 503 there, and a recovery code still signs in (the review's CR3). One that
 * holds none, in this order:
 *
 *   (0) no MFA key loaded: 503, since no set-up could finish (decision 28);
 *   (a) the browser holds a set-up link's cookie for a live link of this
 *       account: an enrol challenge on the link, and `/login/enrol`;
 *   (a2) two-step sign-in is dormant (`twoStepRequired`, card 3064, R3): the
 *       account's hash compared again with the one checked (409 `changed`,
 *       nothing written, S-M3), and then the password signs in on its own
 *       (`finishPasswordSignIn`, a `two_step` 0 session), as the version
 *       before two-step sign-in signed everyone in. After the commit the
 *       session's cookie, the challenge's cookie deleted, the browser
 *       remembered under the password-only domain, the throttles forgotten
 *       for a browser not remembered as a second step forgets them, and home;
 *   (b) it may not set up on its password alone (`mayStillEnrolOnPassword`:
 *       not marked `mfa_password_enrol = 1`, the 14 days after the release
 *       over, or a link from anything but the release mail held, decision
 *       25 and CS4): 403, it needs a link;
 *   (c) no mail host is configured: an enrol challenge on the password, and
 *       `/login/enrol` (R1);
 *   (d) a mail host is configured but cannot send a link (its password
 *       missing, or no address to make the link from, or the image's
 *       placeholder): 503, and no link (S3);
 *   (e) otherwise the release mail (decision 23, `releaseMail`).
 *
 * The factor, the link, the mark and the window are read, and the challenge
 * issued, in one synchronous transaction (CR12): a reset or a set-up
 * committed while the password was checked is seen. A challenge is in the
 * lane the password was checked in, and nothing about the throttles is
 * forgotten or given back until the second step is passed. The issue
 * compares the account's hash with the one checked, and a password changed
 * while it was checked is 409 with nothing written (decision 26); an account
 * deleted meanwhile is the expired words. (e) reads the hash, the mark and
 * the window again in its own transaction. One AUTH INFO line, naming a
 * challenge by its short id alone, or why there is no second step.
 */
export async function afterPassword(accepted: PasswordAccepted, cookies: Cookies, url: URL): Promise<LoginFailure | LoginNotice> {
	const { user, checkedHash, remembered, address, identity } = accepted;
	const fromIp = address ?? 'unknown';
	const noSecondStep = (why: string, level: 'info' | 'warn' = 'info') =>
		log[level](`Password accepted for ${named(user)} from IP ${fromIp}, no second step: ${why}`, undefined, { userId: user.id, ip: address });
	const changed = (): LoginFailure => {
		noSecondStep('the password was changed while it was checked', 'warn');
		return fail(409, { error: PASSWORD_CHANGED_DURING_SIGN_IN, identity });
	};
	const gone = (): LoginFailure => {
		noSecondStep('the account was deleted or disabled while its password was checked', 'warn');
		return fail(400, { error: SIGN_IN_EXPIRED, identity });
	};
	const needsLink = (): LoginFailure => {
		noSecondStep('needs a link');
		return fail(403, { error: NEEDS_LINK, identity });
	};

	type Decided =
		| { kind: 'issued'; purpose: ChallengePurpose; token: string; shortId: string; fromLink: boolean }
		| { kind: 'password only'; session: NewSession; user: User }
		| { kind: 'changed' | 'gone' | 'needs link' | 'no key' | 'mail' };
	const decide = (): Decided => {
		const issue = (purpose: ChallengePurpose, enrolGrant: string | null, enrolmentLinkHash: string | null): Decided => {
			const issued = issueChallenge({
				userId: user.id,
				checkedHash,
				purpose,
				lane: remembered === null ? 'other' : 'known',
				previousToken: accepted.previousToken,
				enrolGrant,
				enrolmentLinkHash
			});
			if (!issued.issued) return { kind: issued.why };
			return { kind: 'issued', purpose, token: issued.token, shortId: issued.shortId, fromLink: enrolmentLinkHash !== null };
		};

		// An account deleted while its password was checked has no way in at all,
		// nor one disabled meanwhile (card 2671).
		const still = db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, user.id)).get();
		if (still === undefined || still.disabledAt !== null) return { kind: 'gone' };

		if (holdsFactor(user.id)) return issue('verify', null, null);

		// (0) Setting up needs the MFA key.
		if (currentMfaKey() === null) return { kind: 'no key' };

		// (a) A set-up link of this account; one of any other account is ignored.
		const link = usableEnrolmentLink(accepted.linkToken);
		if (link !== null && link.userId === user.id) return issue('enrol', 'link', link.tokenHash);

		// (a2) Two-step sign-in dormant (card 3064, R3): the password signs in on its own, the account's hash
		// compared again in this transaction with the one checked (S-M3), as the issue compares it on every
		// other branch. The disabled state and the factors were read above, in this transaction.
		if (!twoStepRequired()) {
			const account = db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.id)).get();
			if (account === undefined) return { kind: 'gone' };
			if (account.passwordHash !== checkedHash) return { kind: 'changed' };
			return { kind: 'password only', ...finishPasswordSignIn(user, address) };
		}

		// (b) Leave to set up on the password alone.
		if (!mayStillEnrolOnPassword(user.id)) return { kind: 'needs link' };

		// (c) No mail host: on the password (R1). Never once mail has been set up on this server (card 2922, its
		// plan's R9): a removal of the mail settings does not open it again.
		if (!isSmtpConfigured() && !mailEverConfigured()) return issue('enrol', 'password', null);
		return { kind: 'mail' };
	};
	// An account the record of account endings gives no session (`createSession`'s `AccountDisabled`) is as one
	// disabled meanwhile: the transaction it was thrown in is rolled back, and nothing is written.
	let decided: Decided;
	try {
		decided = inTransaction(decide);
	} catch (err) {
		if (!(err instanceof AccountDisabled)) throw err;
		decided = { kind: 'gone' };
	}

	switch (decided.kind) {
		case 'changed':
			return changed();
		case 'gone':
			return gone();
		case 'password only': {
			const { session, user: signedIn } = decided;
			setSessionCookie(cookies, session, url);
			deleteChallengeCookie(cookies, url);
			// Remembered under the password-only domain, which requiring two-step sign-in retires (R-M9).
			rememberBrowser(cookies, signedIn.id, signedIn.passwordHash, url, 0);
			log.info(
				`User "${signedIn.username}" logged in, no second step: two-step sign-in is not required on this server`,
				{ secondStep: 'none' },
				{ userId: signedIn.id, ip: address }
			);
			// As a second step passed forgets them (`signedInAnswer`, decision 13): the known lane did neither.
			if (remembered === null) {
				forgetWrongSignIns(accountKey(signedIn.id));
				refundSignInAttempts(accepted.countedAs, accountKey(signedIn.id));
			}
			redirect(303, '/');
		}
		case 'needs link':
			return needsLink();
		case 'no key':
			noSecondStep('no MFA key');
			return fail(503, { error: NO_MFA_KEY, identity });
		case 'issued':
			setChallengeCookie(cookies, url, decided.token);
			// The link it came from is named by the challenge now.
			if (decided.fromLink) deleteEnrolLinkCookie(cookies, url);
			log.info(
				`Password accepted for ${named(user)} from IP ${fromIp}, second step issued (${decided.purpose}), challenge ${decided.shortId}`,
				undefined,
				{ userId: user.id, ip: address }
			);
			redirect(303, decided.purpose === 'verify' ? '/login/verify' : '/login/enrol');
	}

	// (d) A mail host that cannot send the link: never R1 for that (S3). Nor no host, where mail was set up once
	// (card 2922, R9), nor mail held for the superadmin's review (R12).
	const base = linkBaseUrl(url);
	if (!isSmtpConfigured() || mailCannotSend() || base === null || isPlaceholder(base)) {
		noSecondStep('could not email', 'warn');
		return fail(503, { error: COULD_NOT_EMAIL, identity });
	}

	// (e) The release mail.
	return releaseMail(accepted, base, { changed, gone, needsLink, noSecondStep });
}

/**
 * Whether the account may still set up on its password alone (R1), read in
 * the caller's transaction: still marked `mfa_password_enrol = 1`, the 14
 * days still running (decision 25), and holding no enrolment link but the
 * release mail's (CS4): a reset made by an older image, which knows nothing
 * of the mark, issues a link of its own and so closes R1 all the same.
 */
function mayStillEnrolOnPassword(userId: number, now: number = Date.now()): boolean {
	const row = db.select({ flag: users.mfaPasswordEnrol }).from(users).where(eq(users.id, userId)).get();
	if (row?.flag !== 1 || !releaseWindowOpen(now)) return false;
	return sqlite.prepare('SELECT 1 FROM enrolment_links WHERE user_id = ? AND issued_by <> ?').get(userId, RELEASE_MAIL) === undefined;
}

/** Whether a link would begin with the image's placeholder `ORIGIN`, nobody's address (`email.ts`); one that cannot be read is too. */
function isPlaceholder(base: string): boolean {
	try {
		return new URL(base).origin === PLACEHOLDER_ORIGIN;
	} catch {
		return true;
	}
}

/**
 * The release mail (decision 23). In one synchronous transaction: the
 * account's hash still the one checked (else 409), its mark and the window
 * still there (else 403); then, while a live release-mail link under a day
 * old is there, nothing is issued and the sign-in is told when it went;
 * while a live set-up challenge on a live link of the account is open,
 * nothing is issued either, so that whoever holds the password cannot end
 * the owner's set-up (CR6); otherwise a new link is issued beside the older
 * ones, and the address to send it to read. After the commit the mail is
 * sent and awaited. A mail that went has the account's older release-mail
 * links deleted, in a transaction of its own; one that did not go has only
 * its own link deleted, by its hash, and is 503, so that the link the owner
 * already holds goes on working (CR6). No challenge either way: the link is
 * the way in.
 */
async function releaseMail(
	accepted: PasswordAccepted,
	base: string,
	answers: {
		changed: () => LoginFailure;
		gone: () => LoginFailure;
		needsLink: () => LoginFailure;
		noSecondStep: (why: string, level?: 'info' | 'warn') => void;
	}
): Promise<LoginFailure | LoginNotice> {
	const { user, checkedHash, address, identity } = accepted;
	const now = Date.now();

	const outcome = inTransaction(
		():
			| { kind: 'changed' | 'gone' | 'needs link' | 'under way' }
			| { kind: 'mailed earlier'; at: Date }
			| { kind: 'issued'; token: string; email: string; username: string } => {
			const account = db
				.select({ passwordHash: users.passwordHash, email: users.email, username: users.username, disabledAt: users.disabledAt })
				.from(users)
				.where(eq(users.id, user.id))
				.get();
			// Deleted, or disabled (card 2671, S16), since its password was checked: no link.
			if (!account || account.disabledAt !== null) return { kind: 'gone' };
			if (account.passwordHash !== checkedHash) return { kind: 'changed' };
			if (!mayStillEnrolOnPassword(user.id, now)) return { kind: 'needs link' };
			registerStampFunctions(sqlite);
			const nowStamp = stamp(new Date(now));
			const live = sqlite
				.prepare(
					'SELECT created_at FROM enrolment_links WHERE user_id = ? AND issued_by = ? AND stamp_of(expires_at) > ? ' +
						'ORDER BY stamp_of(created_at) DESC LIMIT 1'
				)
				.get(user.id, RELEASE_MAIL, nowStamp) as { created_at: string } | undefined;
			// One whose time names no moment is read as long ago, and replaced.
			const mailedAt = live === undefined ? null : parseStamp(live.created_at);
			if (mailedAt !== null && mailedAt.getTime() > now - RELEASE_MAIL_EVERY_MS) return { kind: 'mailed earlier', at: mailedAt };
			const underWay = sqlite
				.prepare(
					'SELECT 1 FROM sign_in_challenges JOIN enrolment_links ON enrolment_links.token_hash = sign_in_challenges.enrolment_link_hash ' +
						"AND enrolment_links.user_id = sign_in_challenges.user_id WHERE sign_in_challenges.user_id = ? AND sign_in_challenges.purpose = 'enrol' " +
						'AND stamp_of(sign_in_challenges.expires_at) > ? AND stamp_of(enrolment_links.expires_at) > ?'
				)
				.get(user.id, nowStamp, nowStamp);
			if (underWay !== undefined) return { kind: 'under way' };
			return {
				kind: 'issued',
				token: issueEnrolmentLink(user.id, RELEASE_MAIL, { replace: false }),
				email: account.email,
				username: account.username
			};
		}
	);

	switch (outcome.kind) {
		case 'changed':
			return answers.changed();
		case 'gone':
			return answers.gone();
		case 'needs link':
			return answers.needsLink();
		case 'under way':
			answers.noSecondStep('a set-up is under way on its emailed link');
			return { notice: SET_UP_UNDER_WAY, identity };
		case 'mailed earlier': {
			answers.noSecondStep('link already mailed');
			const hours = Math.floor((now - outcome.at.getTime()) / (60 * 60 * 1000));
			return { notice: linkAlreadyEmailed(hours, new Date(outcome.at.getTime() + RELEASE_MAIL_EVERY_MS)), identity };
		}
	}

	const tokenHash = sha256Hex(outcome.token);
	const mailed = await sendReleaseLinkMail(outcome.email, outcome.username, outcome.token, base, { at: new Date(now), address });
	if (!mailed.sent) {
		inTransaction(() => sqlite.prepare('DELETE FROM enrolment_links WHERE token_hash = ?').run(tokenHash));
		answers.noSecondStep(`could not email (${mailProblemWords(mailed.problem)})`, 'warn');
		return fail(503, { error: COULD_NOT_EMAIL, identity });
	}
	// The new link is the one that works now (decision 3).
	inTransaction(() =>
		sqlite.prepare('DELETE FROM enrolment_links WHERE user_id = ? AND issued_by = ? AND token_hash <> ?').run(user.id, RELEASE_MAIL, tokenHash)
	);
	answers.noSecondStep('link mailed');
	return { notice: LINK_EMAILED, identity };
}

// ─── The verify page ────────────────────────────────────────────────────────

/**
 * What the verify page shows: whose sign-in it is, whether code entry is
 * paused or locked, and, when locked, that the page opens on the recovery
 * code (the review's CR11).
 */
export type VerifyView = { username: string; codesNotice: string | null; codesLocked: boolean };

/** The lane's state now: locked, paused for so many minutes, or open. An unreadable pause is read as the lock. */
function laneState(user: User, lane: Lane, now: number): { locked: true } | { paused: number } | null {
	const wrong = lane === 'known' ? user.mfaKnownWrong : user.mfaOtherWrong;
	const raw = lane === 'known' ? user.mfaKnownResumesAt : user.mfaOtherResumesAt;
	if (wrong >= CODES_LOCKED_AT) return { locked: true };
	if (raw === null) return null;
	const resumes = parseStamp(toStamp(raw));
	if (resumes === null) return { locked: true };
	return resumes.getTime() > now ? { paused: Math.ceil((resumes.getTime() - now) / 60_000) } : null;
}

/** The verify page's view of this challenge, or null when there is no live one: the page sends the browser to sign in. */
export function verifyView(token: string | null, now: number = Date.now()): VerifyView | null {
	const challenge = liveChallenge(token, 'verify', now);
	if (!challenge) return null;
	const user = db.select().from(users).where(eq(users.id, challenge.user_id)).get();
	if (!user) return null;
	const state = laneState(user, laneOf(challenge), now);
	return {
		username: user.username,
		codesNotice: state === null ? null : 'locked' in state ? CODES_LOCKED : codesPaused(state.paused),
		codesLocked: state !== null && 'locked' in state
	};
}

/** What the page after a right code shows when there is something to report (decision 16). */
export type SignInReport = {
	/** Wrong codes entered for the account since its last sign-in. */
	wrongCodes: number;
	lastSignInAt: string | null;
	lastSignInFrom: string | null;
	/** The security banner's reason, in words, and when it was raised; null when it is not set. */
	banner: { words: string; at: string | null } | null;
	/** The account's live API keys. */
	apiKeys: { name: string; createdAt: string; lastUsedAt: string | null }[];
	/** The webhooks the account set that are on: the board and the host they send to. */
	webhooks: { board: string; host: string; createdAt: string }[];
};

/**
 * The account's live API keys, and the webhooks it set that are on, by the
 * board and the host they send to: what the page after a right code and the
 * enrolment notice list (S2), and the Account page's two-step section and
 * the `factor-removed` notice (card 2772, D2). A live key has not ended
 * (`keyEnded`: its expiry and its deadline, by the gate's own rule). Its two
 * halves are read apart by an administrator's two-step reset (card 2915): the
 * keys by `liveApiKeysOf` before the reset deletes them, and the webhooks by
 * `webhooksByIds`, by the switch-off's own ids (S5). scripts/mfa-reset.mjs
 * copies both.
 */
export function keysAndWebhooksOf(
	userId: number,
	now: number
): { apiKeys: { name: string; createdAt: string; lastUsedAt: string | null }[]; webhooks: { board: string; host: string; createdAt: string }[] } {
	const keys = liveApiKeysOf(userId, now);
	const hooks = db
		.select({ board: boards.name, receiver: webhooks.receiver, createdAt: webhooks.createdAt })
		.from(webhooks)
		.innerJoin(boards, eq(boards.id, webhooks.boardId))
		.where(and(eq(webhooks.setBy, userId), eq(webhooks.active, true)))
		.all()
		.map(hookAsListed);
	return { apiKeys: keys, webhooks: hooks };
}

/**
 * The account's live API keys, by name, with when each was made and last
 * used: the half of `keysAndWebhooksOf` that an administrator's two-step reset
 * reads in its transaction before it ends them (card 2915), for its message
 * and the holder's mail. scripts/mfa-reset.mjs reads the same, in raw SQL.
 */
export function liveApiKeysOf(userId: number, now: number): { name: string; createdAt: string; lastUsedAt: string | null }[] {
	const nowStamp = stamp(new Date(now));
	return db
		.select({
			// With its id and hash, which the record of keys ended here is asked by (card 2995, R7).
			id: apiKeys.id,
			keyHash: apiKeys.keyHash,
			name: apiKeys.name,
			createdAt: apiKeys.createdAt,
			lastUsedAt: apiKeys.lastUsedAt,
			expiresAt: apiKeys.expiresAt,
			deadlineAt: apiKeys.deadlineAt
		})
		.from(apiKeys)
		.where(eq(apiKeys.userId, userId))
		.all()
		.filter((key) => !keyEnded(key, nowStamp))
		.map(({ name, createdAt, lastUsedAt }) => ({ name, createdAt, lastUsedAt }));
}

/**
 * The webhooks of `ids`, by the board and the host they send to, in the
 * order of their ids: what an administrator's two-step reset lists, read by
 * the ids its switch-off answered (card 2915, S5), so the message and the
 * holder's mail name exactly what was switched off. scripts/mfa-reset.mjs
 * reads the same, in raw SQL.
 */
export function webhooksByIds(ids: readonly number[]): { board: string; host: string; createdAt: string }[] {
	if (ids.length === 0) return [];
	return db
		.select({ id: webhooks.id, board: boards.name, receiver: webhooks.receiver, createdAt: webhooks.createdAt })
		.from(webhooks)
		.innerJoin(boards, eq(boards.id, webhooks.boardId))
		.where(inArray(webhooks.id, [...ids]))
		.all()
		.sort((a, b) => a.id - b.id)
		.map(hookAsListed);
}

/**
 * A webhook as a list names it: its board, the host alone and when it was
 * made. The host of its stored `receiver` (card 2928): the address is sealed,
 * and a path or a query may hold the receiver's own secret.
 */
function hookAsListed({ board, receiver, createdAt }: { board: string; receiver: string; createdAt: string }): { board: string; host: string; createdAt: string } {
	let host: string;
	try {
		host = new URL(receiver).host;
	} catch {
		host = 'an address that cannot be read';
	}
	return { board, host, createdAt };
}

/**
 * The account's live keys and webhooks, and what is to be reported, read
 * before the sign-in is written; the banner only when `withBanner`.
 */
function reportFor(user: User, now: number, withBanner: boolean): SignInReport {
	const { apiKeys: keys, webhooks: hooks } = keysAndWebhooksOf(user.id, now);
	return {
		wrongCodes: user.failedCodesSinceSignIn,
		lastSignInAt: user.lastSignInAt,
		lastSignInFrom: user.lastSignInFrom,
		banner:
			!withBanner || user.securityBanner === null
				? null
				: { words: bannerWords(user.securityBanner), at: user.securityBannerAt },
		apiKeys: keys,
		webhooks: hooks
	};
}

/**
 * Whether the account's security banner was raised since its previous
 * sign-in (CR14): set, and raised at or after the last sign-in as read
 * before this one writes it. One with no last sign-in, or a time that names
 * no moment, is read as raised since.
 */
function bannerRaisedSinceSignIn(user: Pick<User, 'securityBanner' | 'securityBannerAt' | 'lastSignInAt'>): boolean {
	if (user.securityBanner === null) return false;
	const raised = parseStamp(user.securityBannerAt);
	const previous = parseStamp(user.lastSignInAt);
	return raised === null || previous === null || raised.getTime() >= previous.getTime();
}

/**
 * The part of a sign-in written with the session, inside the caller's
 * transaction, once the second factor is right: the challenge taken (one row,
 * or it throws), the last sign-in written and the wrong codes since it set
 * back to 0, and the session made. Answers the new session, the account
 * as it was, and the report for the decision 16 page when there is anything
 * to report: wrong codes since the last sign-in, or the security banner
 * raised since then (CR14). A sign-in does not clear the banner, and a later
 * sign-in is not shown it again here: it stays at the top of the Account page
 * until its holder clears it there, with That was me (a step-up that clears
 * only the warning the page showed), or by changing their own password (card
 * 2772, D6).
 */
export function finishSignIn(
	challenge: ChallengeRow,
	purpose: ChallengePurpose,
	now: number,
	address: string | null,
	stage?: string
): { session: NewSession; user: User; report: SignInReport | null } {
	takeChallenge(challenge.token_hash, purpose, now, stage);
	const user = db.select().from(users).where(eq(users.id, challenge.user_id)).get();
	if (!user) throw new Error('A challenge was taken for an account that is not there.');
	const freshBanner = bannerRaisedSinceSignIn(user);
	const report = user.failedCodesSinceSignIn > 0 || freshBanner ? reportFor(user, now, freshBanner) : null;
	db.update(users)
		.set({ lastSignInAt: stamp(new Date(now)), lastSignInFrom: address, failedCodesSinceSignIn: 0 })
		.where(eq(users.id, user.id))
		.run();
	// Made after the code, a recovery code or the enrol's confirm: two-step (card 3064, R5).
	return { session: createSession(user.id, { twoStep: 1 }), user, report };
}

/**
 * A sign-in on a password alone, while two-step sign-in is dormant (card 3064,
 * R3, R9), inside the caller's transaction, which has read there that the
 * switch is off and that the account holds no factor and is not disabled, and
 * has compared or just written its hash: the last sign-in written and the
 * wrong codes since it set back to 0, as `finishSignIn` writes them, and a
 * session made with `two_step` 0, which `findSession` refuses once two-step
 * sign-in is required or the account holds a factor. Asked with the switch on
 * or a factor held, it is a fault in the caller, and throws, rolling the
 * transaction back; so does `createSession`, with `AccountDisabled`, for an
 * account it gives no session. Answers the session and the account as it is.
 */
export function finishPasswordSignIn(
	who: Pick<User, 'id'>,
	address: string | null,
	now: number = Date.now()
): { session: NewSession; user: User } {
	if (twoStepRequired() || holdsFactor(who.id)) {
		throw new Error('A sign-in on a password alone was asked while two-step sign-in is required, or of an account that holds a factor.');
	}
	db.update(users)
		.set({ lastSignInAt: stamp(new Date(now)), lastSignInFrom: address, failedCodesSinceSignIn: 0 })
		.where(eq(users.id, who.id))
		.run();
	const user = db.select().from(users).where(eq(users.id, who.id)).get();
	if (!user) throw new Error('A sign-in on a password alone was asked for an account that is not there.');
	return { session: createSession(user.id, { twoStep: 0 }), user };
}

/**
 * The live challenge of `purpose` this browser holds, and its account, read
 * in the caller's transaction (`verifyStep`, `enrolCode`): none, or its
 * account gone or disabled (card 2671), is `expired`; an account whose password hash is not the one
 * the challenge was issued against has the challenge deleted, a WARN said
 * after the commit, and is `password changed`.
 */
function openChallenge(
	token: string | null,
	purpose: ChallengePurpose,
	now: number,
	address: string | null
): { challenge: ChallengeRow; user: User } | { kind: 'expired' | 'password changed' } {
	const challenge = liveChallenge(token, purpose, now);
	if (!challenge) return { kind: 'expired' };
	const user = db.select().from(users).where(eq(users.id, challenge.user_id)).get();
	// Gone, or disabled since the challenge was issued (card 2671): expired.
	if (!user || user.disabledAt !== null) return { kind: 'expired' };
	if (user.passwordHash !== challenge.password_hash) {
		deleteChallenge(challenge.token_hash);
		const what = purpose === 'verify' ? 'sign-in' : 'set-up';
		afterCommit(() =>
			log.warn(
				`The password of ${named(user)} was changed under a pending ${what} (challenge ${challenge.short_id}): the ${what} was ended`,
				undefined,
				{ userId: user.id, ip: address }
			)
		);
		return { kind: 'password changed' };
	}
	return { challenge, user };
}

/**
 * What a sign-in that passed its second step (or a set-up's confirm) sends,
 * after its commit: the session's cookie, the browser remembered under the
 * new MAC domain, the challenge's cookie gone, and the INFO line. For a
 * browser not remembered, the account's waits forgotten and this address's
 * attempts at it given back; the known lane did neither at the password and
 * does neither here (decision 13). Answers the report of decision 16 when
 * there is one; otherwise throws the redirect home.
 */
function signedInAnswer(
	signedIn: { session: NewSession; user: User; report: SignInReport | null; lane: Lane },
	secondStep: string,
	from: { address: string | null; countedAs: string },
	cookies: Cookies,
	url: URL
): VerifyReport {
	const { session, user, report, lane } = signedIn;
	setSessionCookie(cookies, session, url);
	// After a second factor: the session is `two_step` 1, and so is the domain (card 3064, R-M9).
	rememberBrowser(cookies, user.id, user.passwordHash, url, 1);
	deleteChallengeCookie(cookies, url);
	log.info(`User "${user.username}" logged in`, { secondStep }, { userId: user.id, ip: from.address });
	if (lane === 'other') {
		forgetWrongSignIns(accountKey(user.id));
		refundSignInAttempts(from.countedAs, accountKey(user.id));
	}
	if (report !== null) return { signedIn: true, report };
	redirect(303, '/');
}

// ─── The verify step ────────────────────────────────────────────────────────

/** The values the verify action hands on: the challenge token from the raw cookie, and the form's two fields. */
export type VerifyInput = {
	token: string | null;
	code: unknown;
	recoveryCode: unknown;
	/** The address as received, null where there is none; and its key, as sign-in counts it. */
	address: string | null;
	countedAs: string;
};

export type VerifyFailure = StepFailure;
/** A right code with something to report: signed in, and the page shows the report (decision 16). */
export type VerifyReport = { signedIn: true; report: SignInReport };

type Outcome =
	| { kind: 'expired' | 'password changed' | 'no code' | 'locked' | 'no factor' | 'malformed' | 'malformed code' | 'step spent' | 'too many' }
	| { kind: 'paused'; minutes: number }
	| { kind: 'wrong'; recovery: boolean }
	| { kind: 'signed in'; session: NewSession; user: User; report: SignInReport | null; lane: Lane; by: 'authenticator' | 'recovery code' };

/**
 * `run`, a sign-in completion's transaction, with the `AccountDisabled` that
 * `createSession` throws for a disabled account (card 2671, S5) answered as
 * an expired sign-in: the transaction it was thrown in is rolled back, so the
 * challenge is left untaken and nothing it counted or spent stands; `undo`
 * forgets what the caller gathered to tell after it; one WARN says why.
 */
function expiredIfDisabled<T>(run: () => T, address: string | null, undo: () => void = () => {}): T | { kind: 'expired' } {
	try {
		return run();
	} catch (err) {
		if (!(err instanceof AccountDisabled)) throw err;
		undo();
		log.warn(`A sign-in of user ${err.userId} was refused at its last step: the account is disabled`, undefined, {
			userId: err.userId,
			ip: address
		});
		return { kind: 'expired' };
	}
}

/**
 * Check a code against the challenge this browser holds (4.5), in one
 * synchronous transaction, in this order: a live verify challenge; the
 * account's password hash unchanged since it was issued; for an
 * authenticator code, its form (`readAuthenticatorCode`, the step-up's rule;
 * a malformed one refused before its lane is read or anything counted, card 2889),
 * its lane neither locked nor paused (refused uncounted)
 * and at least one authenticator that opens (503 uncounted otherwise), every
 * one tried (`matchFactors`); then counted, in one statement each, the lane
 * by the authenticators tried (card 2772, D4). A right code takes the counts
 * back and signs in; a step already spent takes them back and asks for the next code; a
 * wrong one leaves them, pausing or locking its lane, and the fifth on the
 * challenge ends it (decision 30). A recovery code skips the lane and the
 * factor; a malformed one is answered before anything is counted.
 *
 * Notices are sent after the commit, and the cookies set; the WARN of a
 * recovery code that signed in, and a wrong one's count on the address, are
 * run after the commit too (CR7), so that a rolled-back sign-in says and
 * counts nothing. Answers the failure, or the report; a plain success throws
 * the redirect home.
 */
export function verifyStep(input: VerifyInput, cookies: Cookies, url: URL): VerifyFailure | VerifyReport {
	const now = Date.now();
	const notices: [number, SecurityNotice, SecurityNoticeDetail][] = [];
	const at = new Date(now);
	const fromIp = input.address ?? 'unknown';

	const outcome = expiredIfDisabled(() => inTransaction((): Outcome => {
		// 1. A live challenge of purpose verify; 2. the password hash it was
		// issued against still the account's.
		const opened = openChallenge(input.token, 'verify', now, input.address);
		if ('kind' in opened) return opened;
		const { challenge, user } = opened;
		const lane = laneOf(challenge);

		const recovery = typeof input.recoveryCode === 'string' ? input.recoveryCode.trim() : '';
		const code = typeof input.code === 'string' ? input.code.trim() : '';
		if (recovery === '' && code === '') return { kind: 'no code' };

		/** The first wrong code on this challenge is a stolen-password signal, mailed at most once an hour (decision 15a). */
		const signalFirstWrong = (wrongOnChallenge: number) => {
			if (wrongOnChallenge === 1 && raiseSignal(user.id, 'wrong-code', now)) {
				notices.push([user.id, 'wrong-code', { at, address: input.address }]);
			}
		};

		if (recovery !== '') {
			// 6. A recovery code: a malformed one before anything is counted.
			if (canonicalRecoveryCode(recovery) === null) return { kind: 'malformed' };
			const onChallenge = countChallengeWrong(challenge.token_hash);
			const counted = sqlite
				.prepare(
					'UPDATE users SET mfa_recovery_wrong = mfa_recovery_wrong + 1, failed_codes_since_sign_in = ' +
						'failed_codes_since_sign_in + 1 WHERE id = ? RETURNING mfa_recovery_wrong AS n'
				)
				.get(user.id) as { n: number };

			// 7. Compared, and spent if right.
			if (spendRecoveryCode(user.id, recovery) === 'spent') {
				uncountChallengeWrong(challenge.token_hash);
				// Both lanes, their pauses and the lock, and the recovery count, cleared (decision 14).
				sqlite
					.prepare(
						'UPDATE users SET mfa_known_wrong = 0, mfa_other_wrong = 0, mfa_known_resumes_at = NULL, ' +
							'mfa_other_resumes_at = NULL, mfa_recovery_wrong = 0, failed_codes_since_sign_in = ' +
							'failed_codes_since_sign_in - 1 WHERE id = ?'
					)
					.run(user.id);
				const left = db
					.select({ id: mfaRecoveryCodes.id })
					.from(mfaRecoveryCodes)
					.where(and(eq(mfaRecoveryCodes.userId, user.id), isNull(mfaRecoveryCodes.usedAt)))
					.all().length;
				afterCommit(() =>
					log.warn(`A recovery code signed in ${named(user)} from IP ${fromIp}: ${left} left`, undefined, {
						userId: user.id,
						ip: input.address
					})
				);
				notices.push([user.id, 'recovery-code-used', { at, address: input.address, codesLeft: left }]);
				return { kind: 'signed in', ...finishSignIn(challenge, 'verify', now, input.address), lane, by: 'recovery code' };
			}

			log.warn(
				`Wrong recovery code for ${named(user)} from IP ${fromIp} (${counted.n} in a row; challenge ${challenge.short_id}, ` +
					`${onChallenge} of ${WRONG_CODES_PER_CHALLENGE})`,
				undefined,
				{ userId: user.id, ip: input.address }
			);
			signalFirstWrong(onChallenge);
			if (counted.n % RECOVERY_GUESSES_NOTICE_EVERY === 0) {
				notices.push([user.id, 'recovery-codes-guessed', { at, address: input.address, count: counted.n }]);
			}
			// On the address's sign-in attempts too, which the password step is held to (decision 14).
			afterCommit(() => countSignInAttempt(input.countedAs, accountKey(user.id)));
			if (onChallenge >= WRONG_CODES_PER_CHALLENGE) {
				deleteChallenge(challenge.token_hash);
				return { kind: 'too many' };
			}
			return { kind: 'wrong', recovery: true };
		}

		// 3. An authenticator code: first its form (card 2889), by the step-up's
		// rule, so that one that cannot be a code is answered before the lane is
		// read or anything counted, as a malformed recovery code is; then its
		// lane neither locked nor paused, and neither counted.
		const digits = readAuthenticatorCode(input.code);
		if (digits === null) return { kind: 'malformed code' };
		const state = laneState(user, lane, now);
		if (state !== null) return 'locked' in state ? { kind: 'locked' } : { kind: 'paused', minutes: state.paused };

		// 4. Every authenticator of the account tried (card 2772, D4), with no
		// early exit: none that opens is 503, uncounted, each said at ERROR (by
		// factorSecret), and none at all said at ERROR here.
		const found = matchFactors(user.id, digits, now);
		if (found.tried === 0) {
			if (found.unusable === 0) {
				log.error(`${named(user)} has a pending sign-in and no second factor (challenge ${challenge.short_id})`, undefined, {
					userId: user.id
				});
			}
			return { kind: 'no factor' };
		}

		// 5. Counted, each in one statement: the lane by the authenticators tried,
		// so that a guess against N of them, 2N candidates, moves it N (D4); the
		// challenge and the failed codes since sign-in by the one code typed, so
		// that the first wrong code on the challenge is still its signal (S2).
		const weight = found.tried;
		const columns = LANE_COLUMNS[lane];
		const onChallenge = countChallengeWrong(challenge.token_hash);
		const counted = sqlite
			.prepare(
				`UPDATE users SET ${columns.wrong} = ${columns.wrong} + ?, failed_codes_since_sign_in = ` +
					`failed_codes_since_sign_in + 1 WHERE id = ? RETURNING ${columns.wrong} AS n`
			)
			.get(weight, user.id) as { n: number };

		// 7. What the compare found: a match spends that factor's step alone; a
		// code whose every match is spent asks for the next one. Either takes the
		// counts back exactly.
		const matched = found.matched;
		if (matched !== null || found.spent) {
			uncountChallengeWrong(challenge.token_hash);
			if (matched === null || spendStep(matched.factorId, matched.step) === 'not spent') {
				sqlite
					.prepare(
						`UPDATE users SET ${columns.wrong} = max(${columns.wrong} - ?, 0), failed_codes_since_sign_in = ` +
							'max(failed_codes_since_sign_in - 1, 0) WHERE id = ?'
					)
					.run(weight, user.id);
				return { kind: 'step spent' };
			}
			sqlite
				.prepare(
					`UPDATE users SET ${columns.wrong} = 0, ${columns.resumesAt} = NULL, failed_codes_since_sign_in = ` +
						'max(failed_codes_since_sign_in - 1, 0) WHERE id = ?'
				)
				.run(user.id);
			return { kind: 'signed in', ...finishSignIn(challenge, 'verify', now, input.address), lane, by: 'authenticator' };
		}

		// The lines and notices name the codes typed and the authenticators tried,
		// never the lane's weighted count, which is not the number typed (E3).
		log.warn(
			`Wrong two-step sign-in code for ${named(user)} from IP ${fromIp} (${lane} lane; ${weight} authenticator${weight === 1 ? '' : 's'} ` +
				`tried; challenge ${challenge.short_id}, ${onChallenge} of ${WRONG_CODES_PER_CHALLENGE})`,
			undefined,
			{ userId: user.id, ip: input.address }
		);
		signalFirstWrong(onChallenge);
		const pause = pauseCrossed(counted.n - weight, counted.n);
		if (pause === 'locked') {
			log.warn(`Authenticator codes for ${named(user)} are locked after too many wrong codes in a row (${lane} lane)`, undefined, {
				userId: user.id,
				ip: input.address
			});
			notices.push([user.id, 'codes-locked', { at, address: input.address }]);
		} else if (pause !== null) {
			const until = new Date(now + pause * 60_000);
			sqlite.prepare(`UPDATE users SET ${columns.resumesAt} = ? WHERE id = ?`).run(stamp(until), user.id);
			log.warn(
				`Authenticator codes for ${named(user)} are paused for ${pause} minute(s) after too many wrong codes in a row (${lane} lane)`,
				undefined,
				{ userId: user.id, ip: input.address }
			);
			notices.push([user.id, 'codes-paused', { at, address: input.address, until }]);
		}
		// The fifth on the challenge ends it: the pause, if one began, is shown at the next sign-in (decision 30).
		if (onChallenge >= WRONG_CODES_PER_CHALLENGE) {
			deleteChallenge(challenge.token_hash);
			return { kind: 'too many' };
		}
		return { kind: 'wrong', recovery: false };
	}), input.address, () => {
		// Rolled back: nothing it would have told of happened.
		notices.length = 0;
	});

	for (const [userId, notice, detail] of notices) sendSecurityNotice(userId, notice, detail);

	switch (outcome.kind) {
		case 'expired':
			return refuse(cookies, url, 400, SIGN_IN_EXPIRED, true);
		case 'password changed':
			return refuse(cookies, url, 409, PASSWORD_CHANGED_DURING_SIGN_IN, true);
		case 'no code':
			return refuse(cookies, url, 400, NO_CODE);
		case 'locked':
			return refuse(cookies, url, 403, CODES_LOCKED);
		case 'paused':
			return refuse(cookies, url, 429, codesPaused(outcome.minutes));
		case 'no factor':
			return refuse(cookies, url, 503, FACTOR_UNUSABLE);
		case 'malformed':
			return refuse(cookies, url, 400, MALFORMED_RECOVERY_CODE);
		case 'malformed code':
			return refuse(cookies, url, 400, MALFORMED_CODE);
		case 'step spent':
			return refuse(cookies, url, 400, STEP_SPENT);
		case 'too many':
			return refuse(cookies, url, 400, TOO_MANY_WRONG_CODES, true);
		case 'wrong':
			return refuse(cookies, url, 400, outcome.recovery ? WRONG_RECOVERY_CODE : WRONG_CODE);
	}

	return signedInAnswer(outcome, outcome.by, input, cookies, url);
}

// ─── Setting up: the enrol page (4.6) ───────────────────────────────────────

/**
 * What the set-up page shows: at `secret_shown`, the QR code and the secret
 * in groups of four, with the account and the issuer they are filed under;
 * from the right first code on, the ten recovery codes. `unavailable` when
 * what the challenge keeps cannot be opened: no MFA key (decision 28).
 */
export type EnrolView =
	| { stage: 'secret_shown'; username: string; issuer: string; secret: string; qr: string }
	| { stage: 'codes_shown'; username: string; codes: string[] }
	| { stage: 'unavailable' };

/**
 * The set-up page's view of this browser's enrol challenge, or null when
 * there is no live one: the page sends the browser to sign in. Showing the
 * recovery codes moves a challenge at `code_verified` to `codes_shown`, the
 * stage confirm needs (4.3); a reload shows the same ten.
 */
export function enrolView(token: string | null, now: number = Date.now()): EnrolView | null {
	return inTransaction((): EnrolView | null => {
		const challenge = liveChallenge(token, 'enrol', now);
		if (!challenge) return null;
		const user = db.select({ username: users.username }).from(users).where(eq(users.id, challenge.user_id)).get();
		if (!user) return null;
		const state = openEnrolState(challenge);
		if (state === null) return { stage: 'unavailable' };

		if (challenge.stage === 'secret_shown') {
			const secret = Buffer.from(state.secret, 'base64');
			try {
				return {
					stage: 'secret_shown',
					username: user.username,
					issuer: OTPAUTH_ISSUER,
					secret: secretInGroups(secret),
					qr: qrDataUri(otpauthUri(user.username, secret))
				};
			} finally {
				secret.fill(0);
			}
		}
		if (state.codes === null) throw new Error(`An enrol challenge at ${challenge.stage} keeps no recovery codes.`);
		if (challenge.stage === 'code_verified') moveEnrolStage(challenge, 'code_verified', 'codes_shown');
		return { stage: 'codes_shown', username: user.username, codes: state.codes };
	});
}

/** The values the set-up page's actions hand on: the challenge token from the raw cookie, the first code, and the caller's address. */
export type EnrolInput = {
	token: string | null;
	code?: unknown;
	/** The address as received, null where there is none; and its key, as sign-in counts it. */
	address: string | null;
	countedAs: string;
};

export type EnrolFailure = StepFailure;

/**
 * The first code of the authenticator being set up (`?/code`), in one
 * synchronous transaction: a live enrol challenge (else the expired words);
 * the account's password unchanged since it was issued (else 409, the
 * challenge deleted); at `secret_shown` (else 409, nothing written); what it
 * keeps opens (else 503, nothing counted: decision 28); then counted on the
 * challenge alone and compared. Right: the count taken back, ten recovery
 * codes made and sealed with the secret and the code's step, `code_verified`,
 * and the page again to show them. Wrong: 400, and the fifth ends the
 * challenge.
 */
export function enrolCode(input: EnrolInput, cookies: Cookies, url: URL): EnrolFailure {
	const now = Date.now();

	const outcome = inTransaction(
		(): { kind: 'expired' | 'password changed' | 'not ready' | 'unavailable' | 'no code' | 'wrong' | 'too many' | 'verified' } => {
			const opened = openChallenge(input.token, 'enrol', now, input.address);
			if ('kind' in opened) return opened;
			const { challenge } = opened;
			if (challenge.stage !== 'secret_shown') return { kind: 'not ready' };
			const state = openEnrolState(challenge);
			if (state === null) return { kind: 'unavailable' };
			const code = typeof input.code === 'string' ? input.code.trim() : '';
			if (code === '') return { kind: 'no code' };

			const onChallenge = countChallengeWrong(challenge.token_hash);
			const secret = Buffer.from(state.secret, 'base64');
			let step: number | null;
			try {
				step = matchingStep(secret, code, now);
			} finally {
				secret.fill(0);
			}
			if (step !== null) {
				uncountChallengeWrong(challenge.token_hash);
				moveEnrolStage(challenge, 'secret_shown', 'code_verified', { secret: state.secret, step, codes: newRecoveryCodes() });
				return { kind: 'verified' };
			}
			if (onChallenge >= WRONG_CODES_PER_CHALLENGE) {
				deleteChallenge(challenge.token_hash);
				return { kind: 'too many' };
			}
			return { kind: 'wrong' };
		}
	);

	switch (outcome.kind) {
		case 'expired':
			return refuse(cookies, url, 400, SIGN_IN_EXPIRED, true);
		case 'password changed':
			return refuse(cookies, url, 409, PASSWORD_CHANGED_DURING_SIGN_IN, true);
		case 'not ready':
			return refuse(cookies, url, 409, ENROL_NOT_READY);
		case 'unavailable':
			return refuse(cookies, url, 503, NO_MFA_KEY);
		case 'no code':
			return refuse(cookies, url, 400, NO_CODE);
		case 'wrong':
			return refuse(cookies, url, 400, ENROL_WRONG_CODE);
		case 'too many':
			return refuse(cookies, url, 400, TOO_MANY_WRONG_CODES, true);
	}
	// The codes are shown by the page, not by this answer, so that a reload
	// does not post the code again.
	redirect(303, '/login/enrol');
}

/**
 * Finish setting up (`?/confirm`), in one synchronous transaction. First
 * everything that refuses it, with nothing written: a live enrol challenge
 * at `codes_shown` (a live one at another stage is the stage answer); the
 * password unchanged since it was issued; what it keeps opens (else 503);
 * the account holding no factor and no recovery codes; the link it came
 * from, if any, live; and, for a set-up on the password alone, that leave
 * still there and still no mail host (CS6: a reset, a link of an older
 * image, the 14 days' end or a mail host set up meanwhile ends it). No live
 * challenge at all is that one answer too (CR5). Every refusal but the stage
 * and the key is one answer,
 * 409 "can no longer be finished" (I12). Then, together: the challenge and
 * the link taken, each by a conditional DELETE (one row each, else it
 * throws), the factor written with the first code's step spent, the ten
 * recovery codes, every other pending sign-in, link and unused invite of the
 * account ended, its leave to set up on its password taken away, the last
 * sign-in written and the session made.
 *
 * After the commit: the session's and the remembered browser's cookies, the
 * challenge's deleted, two INFO lines, and the `enrolled` notice listing the
 * account's keys and webhooks (S2). Answers the failure, or the report of
 * decision 16 when there is something to report, as `verifyStep` does (ruled
 * 2026-11-13 on slice 3's report); a plain success throws the redirect home.
 */
export function enrolConfirm(input: EnrolInput, cookies: Cookies, url: URL): EnrolFailure | VerifyReport {
	const now = Date.now();

	type Confirmed = { kind: 'enrolled'; session: NewSession; user: User; report: SignInReport | null; grant: string; lane: Lane };
	const outcome = expiredIfDisabled(() => inTransaction((): { kind: 'refused'; why: string; userId: number | null } | { kind: 'not ready' | 'unavailable' } | Confirmed => {
		const challenge = liveChallenge(input.token, 'enrol', now);
		if (!challenge) return { kind: 'refused', why: 'no live set-up', userId: null };
		if (challenge.stage !== 'codes_shown') return { kind: 'not ready' };
		const user = db.select().from(users).where(eq(users.id, challenge.user_id)).get();
		if (!user) return { kind: 'refused', why: 'the account is gone', userId: null };
		const refused = (why: string) => ({ kind: 'refused' as const, why, userId: user.id });
		if (user.passwordHash !== challenge.password_hash) return refused('the password was changed');
		const state = openEnrolState(challenge);
		if (state === null) return { kind: 'unavailable' };
		if (state.step === null || state.codes === null) throw new Error('An enrol challenge at codes_shown keeps no step or no codes.');
		const held = db.select({ id: mfaRecoveryCodes.id }).from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.id)).get();
		if (holdsFactor(user.id) || held !== undefined) return refused('a second factor or recovery codes are already held');
		registerStampFunctions(sqlite);
		const nowStamp = stamp(new Date(now));
		if (challenge.enrolment_link_hash !== null) {
			const link = sqlite
				.prepare('SELECT 1 FROM enrolment_links WHERE token_hash = ? AND user_id = ? AND stamp_of(expires_at) > ?')
				.get(challenge.enrolment_link_hash, user.id, nowStamp);
			if (link === undefined) return refused('its set-up link is gone');
		}
		if (challenge.enrol_grant === 'password' && (!mayStillEnrolOnPassword(user.id, now) || isSmtpConfigured() || mailEverConfigured())) {
			return refused('its leave to set up on the password alone has ended');
		}

		// Nothing refuses it now: everything together.
		const finished = finishSignIn(challenge, 'enrol', now, input.address, 'codes_shown');
		if (challenge.enrolment_link_hash !== null) {
			const taken = sqlite
				.prepare('DELETE FROM enrolment_links WHERE token_hash = ? AND user_id = ? AND stamp_of(expires_at) > ? RETURNING token_hash')
				.all(challenge.enrolment_link_hash, user.id, nowStamp);
			if (taken.length !== 1) throw new Error(`A set-up link read in this transaction could not be taken (${taken.length} rows).`);
		}
		const secret = Buffer.from(state.secret, 'base64');
		let factorId: number;
		try {
			factorId = addTotpFactor(user.id, FACTOR_LABEL, secret).id;
		} finally {
			secret.fill(0);
		}
		if (spendStep(factorId, state.step) !== 'spent') throw new Error('The first code of a new factor could not be spent.');
		storeRecoveryCodes(user.id, state.codes);
		endPendingSignIns(user.id);
		endUnusedInvites(user.id);
		db.update(users).set({ mfaPasswordEnrol: 0 }).where(eq(users.id, user.id)).run();
		return {
			kind: 'enrolled',
			session: finished.session,
			user: finished.user,
			report: finished.report,
			grant: challenge.enrol_grant ?? 'unknown',
			lane: laneOf(challenge)
		};
	}), input.address);

	switch (outcome.kind) {
		// A disabled account's set-up (card 2671): its session refused, everything rolled back.
		case 'expired':
			return refuse(cookies, url, 400, SIGN_IN_EXPIRED, true);
		case 'not ready':
			return refuse(cookies, url, 409, ENROL_NOT_READY);
		case 'unavailable':
			return refuse(cookies, url, 503, NO_MFA_KEY);
		case 'refused':
			log.warn(`A two-step set-up could not be finished: ${outcome.why}`, undefined, {
				userId: outcome.userId ?? undefined,
				ip: input.address
			});
			return refuse(cookies, url, 409, ENROL_CANNOT_FINISH, true);
	}

	const { user, grant } = outcome;
	log.info(`Two-step sign-in set up for ${named(user)} (${grant})`, undefined, { userId: user.id, ip: input.address });
	sendSecurityNotice(user.id, 'enrolled', { at: new Date(now), address: input.address, ...keysAndWebhooksOf(user.id, now) });
	// Then as at a right code (decision 13). Wrong codes since the last
	// sign-in, or the security banner, survive a reset of two-step sign-in:
	// reported here as after a right code (decision 16), before they are set back.
	return signedInAnswer(outcome, 'enrolment', input, cookies, url);
}

// ─── Setting up after an invite or the first-run set-up ─────────────────────

/** An enrol challenge issued for a password an invite or the first-run set-up has just set, or the Account page's set-up has just checked. */
export type SetUpIssued = { userId: number; token: string; shortId: string };

/**
 * Inside the invite's, the set-up's or the Account page's own transaction,
 * after the password is set (and what setting it ends is ended), or checked
 * by the step-up of `POST /api/account/two-step/set-up` (grant `account`, card
 * 3064, R8): an enrol challenge on that password, in the other lane. Refused,
 * it is a fault in the caller, and throws, rolling the transaction back.
 */
export function issueSetUpChallenge(
	userId: number,
	passwordHash: string,
	previousToken: string | null,
	grant: 'invite' | 'setup' | 'account'
): SetUpIssued {
	const issued = issueChallenge({ userId, checkedHash: passwordHash, purpose: 'enrol', lane: 'other', previousToken, enrolGrant: grant });
	if (!issued.issued) throw new Error(`A set-up challenge was refused (${issued.why}) for the password this transaction set.`);
	return { userId, token: issued.token, shortId: issued.shortId };
}

/** After the commit: the challenge cookie, the INFO line, and the set-up page. */
export function goToSetUp(cookies: Cookies, url: URL, issued: SetUpIssued, after: 'an invite' | 'the first-run set-up'): never {
	setChallengeCookie(cookies, url, issued.token);
	log.info(`Second step issued (enrol) for user ${issued.userId} after ${after}, challenge ${issued.shortId}`, undefined, {
		userId: issued.userId
	});
	redirect(303, '/login/enrol');
}

// ─── Setting up from the Account page while dormant (card 3064, R8) ─────────

/** The 409s of setting up two-step sign-in from the Account page (R8). */
export const OWN_SET_UP_HELD = 'Two-step sign-in is already set up for this account.';
export const OWN_SET_UP_REQUIRED = 'Two-step sign-in is required on this server: it is set up when you next sign in.';

/**
 * Every refusal of setting up two-step sign-in from the Account page while it
 * is dormant (R8), with nothing written: the account holds a factor (409), two-step sign-in is
 * required (409: the sign-in's release path sets it up), or no MFA key is
 * loaded (503, as at sign-in: decision 28). Read only: asked by the route
 * before the password, and again in its write.
 */
export function refuseOwnSetUp(userId: number): void {
	if (holdsFactor(userId)) error(409, OWN_SET_UP_HELD);
	if (twoStepRequired()) error(409, OWN_SET_UP_REQUIRED);
	if (currentMfaKey() === null) error(503, NO_MFA_KEY);
}

/**
 * In the route's own transaction, after its step-up checked the password
 * against `passwordHash` (R8): every refusal asked again (`refuseOwnSetUp`),
 * then an enrol challenge of grant `account` on that hash, replacing the one
 * this browser holds, and the caller's session, by its hash, ended, so that
 * `/login/enrol`, which serves only a browser signed out, serves it. The
 * enrol pages then run as for any set-up, and their confirm makes a session
 * with `two_step` 1 (`finishSignIn`). Answers the challenge issued. The
 * session is the caller's, which the route's `writeAs` has just found open in
 * this transaction: one not ended is a fault in the caller, and throws,
 * rolling the transaction back.
 */
export function startOwnSetUp(userId: number, passwordHash: string, previousToken: string | null, session: Buffer): SetUpIssued {
	refuseOwnSetUp(userId);
	const issued = issueSetUpChallenge(userId, passwordHash, previousToken, 'account');
	const ended = sqlite.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(session, userId).changes;
	if (ended !== 1) throw new Error(`The session of a set-up from the Account page could not be ended (${ended} rows).`);
	return issued;
}
