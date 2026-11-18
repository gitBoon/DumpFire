/**
 * mfa-store.ts — the rows of two-step sign-in (card 2768): authenticator
 * factors, recovery codes, and the pending sign-ins and enrolment links an
 * account change ends.
 *
 * A factor's secret is written only sealed under this server's MFA key, bound
 * to its account and its `factor_uid` (mfa-crypto.ts), and the first factor
 * records the key's check in `settings.mfa_key_check`, which the start-up
 * check compares (mfa-key.ts). A factor that cannot be opened (no key, made
 * with another key, or sealed for another row) is said once in the log at
 * ERROR and is never a wrong code. A recovery code is kept only as a hash
 * bound to its account.
 *
 * A step and a recovery code are each spent by one conditional UPDATE and
 * nothing read before it, so two requests with the same code cannot both
 * spend it. Writes of more than one statement run in `inTransaction`, which is
 * a savepoint inside a caller's own.
 *
 * Issuing an enrolment link, and the reset that removes an account's second
 * factor and issues one, are card 2773's (`issueEnrolmentLink`,
 * `resetTwoStep`): that card is built before 2769, and the administrator's
 * reset and the host's command both need a link. Issuing and taking
 * challenges, and taking an enrolment link, are card 2769's.
 */
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db, sqlite } from './db';
import { enrolmentLinks, mfaFactors, mfaRecoveryCodes, settings, signInChallenges, users, type MfaFactor } from './db/schema';
import { afterCommit, inTransaction } from './db/transaction';
import { endAccountAccess } from './auth';
import { forgetPendingAdd } from './pending-authenticators';
import { createLogger } from './logger';
import { registerStampFunctions } from './db/timestamps';
import { parseStamp, stamp } from '$lib/timestamps';
import { MFA_KEY_CHECK_SETTING, currentMfaKey } from './mfa-key';
import { enrolAad, factorAad, newFactorUid, openSealed, sealWith, sha256Hex, type Sealed } from './mfa-crypto';
import { TOTP_SECRET_BYTES, matchingStep } from './totp';
import { canonicalRecoveryCode, recoveryCodeHash } from './recovery-codes';

const log = createLogger('AUTH');

export type FactorSecret = { usable: true; secret: Buffer } | { usable: false; why: 'no key' | 'other key' | 'does not open' };

/**
 * `settings.mfa_key_check` in `database`, or null: none is stored, or the
 * database has no `settings` table or not its two columns (a backup from
 * before they were there).
 */
export function readMfaKeyCheck(database: Database.Database): string | null {
	const columns = new Set(
		(database.prepare("SELECT name FROM pragma_table_info('settings')").all() as { name: string }[]).map(
			(column) => column.name
		)
	);
	if (!columns.has('key') || !columns.has('value')) return null;
	const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(MFA_KEY_CHECK_SETTING) as
		| { value: string | null }
		| undefined;
	return row?.value ?? null;
}

/**
 * Whether the account holds a second factor (card 2773, decision 9): such an
 * account is not sent an invite. One read, for a route's own check; the
 * queries that ask it of many accounts at once keep their own subquery.
 */
export function holdsFactor(userId: number): boolean {
	return db.select({ id: mfaFactors.id }).from(mfaFactors).where(eq(mfaFactors.userId, userId)).get() !== undefined;
}

/**
 * Write a TOTP factor for the account, its secret sealed under this server's
 * key, and answer its row id and `factor_uid`. In one transaction with the key
 * check: none stored is recorded; one of another key is replaced while no
 * factor exists, and otherwise refused with nothing written. Throws when no
 * key is loaded.
 */
export function addTotpFactor(userId: number, label: string, secret: Buffer): { id: number; factorUid: string } {
	const key = currentMfaKey();
	if (key === null) throw new Error('No MFA key is loaded, so no second factor can be written.');
	// A secret of any other length would be written and then refused as one
	// that does not open (factorSecret): refused here instead, before anything
	// is stored (card 2768 review, slice 1b report).
	if (secret.length !== TOTP_SECRET_BYTES) {
		throw new Error(`An authenticator secret is ${TOTP_SECRET_BYTES} bytes; no factor was written.`);
	}

	return inTransaction(() => {
		const stored = readMfaKeyCheck(sqlite);
		if (stored === null) {
			db.insert(settings).values({ key: MFA_KEY_CHECK_SETTING, value: key.check }).run();
		} else if (stored !== key.check) {
			const factors = db.select({ n: sql<number>`count(*)` }).from(mfaFactors).get()!.n;
			if (factors > 0) {
				throw new Error("The stored MFA key check does not match this server's key; no factor was written.");
			}
			db.update(settings).set({ value: key.check }).where(eq(settings.key, MFA_KEY_CHECK_SETTING)).run();
		}

		const factorUid = newFactorUid();
		const sealed = sealWith(key, secret, factorAad(userId, factorUid));
		const row = db
			.insert(mfaFactors)
			.values({
				factorUid,
				userId,
				kind: 'totp',
				label,
				keyId: key.id,
				secretCiphertext: sealed.ciphertext,
				secretNonce: sealed.nonce,
				createdAt: stamp()
			})
			.returning({ id: mfaFactors.id })
			.get();
		return { id: row.id, factorUid };
	});
}

/**
 * A factor's secret, or why it cannot be had: no key is loaded, the factor
 * names another key, or it does not open to a 20-byte secret under this one.
 * Each of those is one ERROR line naming the factor, its account and both key
 * ids, and nothing of what is sealed.
 */
export function factorSecret(
	factor: Pick<MfaFactor, 'id' | 'userId' | 'factorUid' | 'keyId' | 'secretCiphertext' | 'secretNonce'>
): FactorSecret {
	const opened = openFactor(factor);
	if (opened.usable) return opened;
	const why = opened.why;
	const key = currentMfaKey();

	log.error(
		`A second factor could not be opened (${why}): factor ${factor.id} of user ${factor.userId}, made with key ` +
			`${factor.keyId}; this server's key is ${key?.id ?? 'not loaded'}. It is not counted as a wrong code; the ` +
			'account can use a recovery code.',
		{ factorId: factor.id, keyId: factor.keyId },
		{ userId: factor.userId }
	);
	return { usable: false, why };
}

/**
 * Whether a factor opens under this server's key, with no ERROR line: its
 * secret opened only to see that it does, and zeroed (card 2772, D2, S8: an
 * authenticator is removed only while another opens).
 */
export function factorOpens(
	factor: Pick<MfaFactor, 'id' | 'userId' | 'factorUid' | 'keyId' | 'secretCiphertext' | 'secretNonce'>
): boolean {
	const opened = openFactor(factor);
	if (!opened.usable) return false;
	opened.secret.fill(0);
	return true;
}

/** `factorSecret` without its ERROR line: the secret, or why it cannot be had. */
function openFactor(
	factor: Pick<MfaFactor, 'id' | 'userId' | 'factorUid' | 'keyId' | 'secretCiphertext' | 'secretNonce'>
): FactorSecret {
	const key = currentMfaKey();
	if (key === null) return { usable: false, why: 'no key' };
	if (factor.keyId !== key.id) return { usable: false, why: 'other key' };
	const opened = openSealed(key, { nonce: factor.secretNonce, ciphertext: factor.secretCiphertext }, factorAad(factor.userId, factor.factorUid));
	if (opened !== null && opened.length === TOTP_SECRET_BYTES) return { usable: true, secret: opened };
	opened?.fill(0);
	return { usable: false, why: 'does not open' };
}

/**
 * The most authenticators an account may hold (card 2772, D4): a main phone,
 * a spare, and a new phone during a replacement. A guess against N of them
 * has 2N candidates, and the sign-in lane counts N for each wrong code, so the
 * lock at 30 holds 60 candidates in a million for N of 1, 2 or 3; at 4 it
 * would be 64. Passkeys are not codes and are not counted by it.
 */
export const MOST_AUTHENTICATORS = 3;

/**
 * What `matchFactors` found: the authenticators tried (those that opened),
 * those that did not open, the factor and step to spend, and whether the code
 * matched only steps already spent.
 */
export type FactorMatch = {
	tried: number;
	unusable: number;
	/** The lowest id among the factors whose match is unspent, and its step; null for none. */
	matched: { factorId: number; step: number } | null;
	/** True only when the code matched and every match is at or below its factor's last spent step (S6). */
	spent: boolean;
};

/**
 * Try a code against every authenticator of the account (card 2772, D4), the
 * one matcher of sign-in and the step-up. The account's `totp` factors are
 * read in id order and each is opened in turn, one plaintext secret at a time,
 * zeroed in a `finally` before the next is opened; one that does not open is
 * skipped and counted `unusable`, its ERROR line said by `factorSecret` (not
 * said when `said` is false: the step-up's second look, a moment after its
 * first said it). `matchingStep` runs on every opened secret, with no early
 * exit, so the work does not say which factor matched.
 *
 * `matched` prefers a match whose step is above that factor's `last_step`,
 * the lowest id among them: a code that matches one factor's spent step and
 * another's unspent one is the unspent one's. Nothing is spent here: the
 * caller spends only the matched factor's step (`spendStep`).
 */
export function matchFactors(userId: number, digits: unknown, at: number, { said = true }: { said?: boolean } = {}): FactorMatch {
	const factors = db
		.select()
		.from(mfaFactors)
		.where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.kind, 'totp')))
		.orderBy(mfaFactors.id)
		.all();
	let tried = 0;
	let unusable = 0;
	let matched: FactorMatch['matched'] = null;
	let matchedAny = false;
	for (const factor of factors) {
		const opened = said ? factorSecret(factor) : openFactor(factor);
		if (!opened.usable) {
			unusable++;
			continue;
		}
		tried++;
		let step: number | null;
		try {
			step = matchingStep(opened.secret, digits, at);
		} finally {
			opened.secret.fill(0);
		}
		if (step === null) continue;
		matchedAny = true;
		if (matched === null && (factor.lastStep === null || step > factor.lastStep)) matched = { factorId: factor.id, step };
	}
	return { tried, unusable, matched, spent: matchedAny && matched === null };
}

/** Seal a secret being set up, bound to its account and the hash of its token. Throws when no key is loaded. */
export function sealEnrolment(userId: number, tokenHash: string, plaintext: Buffer): Sealed {
	const key = currentMfaKey();
	if (key === null) throw new Error('No MFA key is loaded, so no secret can be sealed.');
	return sealWith(key, plaintext, enrolAad(userId, tokenHash));
}

/** Open a secret being set up, or null: no key, or it was not sealed for this account and token. */
export function openEnrolment(userId: number, tokenHash: string, sealed: Pick<Sealed, 'nonce' | 'ciphertext'>): Buffer | null {
	const key = currentMfaKey();
	if (key === null) return null;
	return openSealed(key, sealed, enrolAad(userId, tokenHash));
}

/**
 * Spend a time step of a factor: one UPDATE that succeeds only for a step
 * later than the last one spent, with nothing read before it. `'not spent'`
 * is a step already spent or older, or a factor gone meanwhile.
 */
export function spendStep(factorId: number, step: number): 'spent' | 'not spent' {
	const changes = db
		.update(mfaFactors)
		.set({ lastStep: step, lastUsedAt: stamp() })
		.where(and(eq(mfaFactors.id, factorId), or(isNull(mfaFactors.lastStep), lt(mfaFactors.lastStep, step))))
		.run().changes;
	return changes === 1 ? 'spent' : 'not spent';
}

/**
 * Replace the account's recovery codes with `codes`, kept only as hashes bound
 * to the account. Throws, writing nothing, on a code that is not one (a
 * fault in the caller).
 */
export function storeRecoveryCodes(userId: number, codes: readonly string[]): void {
	const hashes = codes.map((code) => {
		const canonical = canonicalRecoveryCode(code);
		if (canonical === null) throw new Error('storeRecoveryCodes was given a value that is not a recovery code.');
		return recoveryCodeHash(userId, canonical);
	});

	inTransaction(() => {
		db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId)).run();
		const createdAt = stamp();
		for (const codeHash of hashes) db.insert(mfaRecoveryCodes).values({ userId, codeHash, createdAt }).run();
	});
}

/**
 * Spend one of the account's recovery codes as typed: `'not a code'` when it
 * cannot be one, with nothing run; otherwise one UPDATE, scoped to the account
 * in its WHERE and in the hash, with nothing read before it. `'not found'` is
 * a code the account does not have, or one already spent.
 */
export function spendRecoveryCode(userId: number, input: string): 'spent' | 'not a code' | 'not found' {
	const canonical = canonicalRecoveryCode(input);
	if (canonical === null) return 'not a code';

	const changes = db
		.update(mfaRecoveryCodes)
		.set({ usedAt: stamp() })
		.where(
			and(
				eq(mfaRecoveryCodes.userId, userId),
				eq(mfaRecoveryCodes.codeHash, recoveryCodeHash(userId, canonical)),
				isNull(mfaRecoveryCodes.usedAt)
			)
		)
		.run().changes;
	return changes === 1 ? 'spent' : 'not found';
}

/**
 * Delete every pending sign-in and enrolment link of the account, and answer
 * how many of each. Inside the caller's transaction, the one that changes the
 * account (a password set, an email or role change); it throws if no
 * transaction is open.
 */
export function endPendingSignIns(userId: number): { challenges: number; enrolmentLinks: number } {
	if (!sqlite.inTransaction) {
		throw new Error(
			'endPendingSignIns must be called inside the transaction that changes the account: wrap the change ' +
				'and this call in inTransaction.'
		);
	}

	const challenges = db.delete(signInChallenges).where(eq(signInChallenges.userId, userId)).run().changes;
	const links = db.delete(enrolmentLinks).where(eq(enrolmentLinks.userId, userId)).run().changes;
	return { challenges, enrolmentLinks: links };
}

/** How long an enrolment link works for once it is issued: seven days, as an invite (card 2773). */
export const ENROLMENT_LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** The path an enrolment link's token follows, after the server's address: `<base>/enrol/<token>` (card 2773, decision 2). */
export const ENROLMENT_LINK_PATH = '/enrol/';

/** An enrolment link that can still be used: its hash, and the account it sets up. */
export type UsableEnrolmentLink = { tokenHash: string; userId: number; username: string };

/**
 * The enrolment link with this token, if it can still be used (card 2769,
 * decision 19): a token as one is made, whose hash names a link before its
 * expiry, as `stamp_of` reads it, of an account that holds no second factor.
 * Null for anything else. One read, nothing written: the link is taken only
 * when the factor is written (`enrolConfirm`).
 */
export function usableEnrolmentLink(token: string | null, now: number = Date.now()): UsableEnrolmentLink | null {
	if (token === null || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
	registerStampFunctions(sqlite);
	const row = sqlite
		.prepare(
			'SELECT enrolment_links.token_hash AS tokenHash, users.id AS userId, users.username AS username FROM enrolment_links ' +
				'JOIN users ON users.id = enrolment_links.user_id WHERE enrolment_links.token_hash = ? ' +
				'AND stamp_of(enrolment_links.expires_at) > ? ' +
				'AND NOT EXISTS (SELECT 1 FROM mfa_factors WHERE mfa_factors.user_id = users.id)'
		)
		.get(sha256Hex(token), stamp(new Date(now))) as UsableEnrolmentLink | undefined;
	return row ?? null;
}

/** The setting the release migration (0066) writes: when two-step sign-in was turned on, which starts the 14 days (decision 25). */
export const TWO_STEP_RELEASED_AT = 'two_step_released_at';

/** How long after the release an account marked `mfa_password_enrol = 1` may set up on its password alone: 14 days (R1). */
export const PASSWORD_SET_UP_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * When leave to set up on a password alone ends, from `two_step_released_at`
 * as it is stored: 14 days after it. Null for no setting, or one that names
 * no moment: the window is then over (decision 25).
 */
export function passwordSetUpEnds(releasedAt: string | null | undefined): Date | null {
	const released = parseStamp(releasedAt);
	return released === null ? null : new Date(released.getTime() + PASSWORD_SET_UP_MS);
}

/** Whether the 14 days after the release are still running at `now` (decision 25). */
export function releaseWindowOpen(now: number = Date.now()): boolean {
	const ends = passwordSetUpEnds(db.select({ value: settings.value }).from(settings).where(eq(settings.key, TWO_STEP_RELEASED_AT)).get()?.value);
	return ends !== null && ends.getTime() > now;
}

/**
 * Issue an enrolment link for the account, and return its token (card 2773).
 * The account's earlier links are deleted first, so it has one link that
 * works, and a leaked older one stops working (decision 3). Only the token's
 * SHA-256 is stored; the token itself is returned for the caller to show
 * once, and is never logged or stored.
 *
 * `replace: false` keeps the earlier links (card 2769, the review's CR6): the
 * release mail issues its link beside them, and deletes the older ones only
 * once the mail has gone, so that a mail that fails does not take away the
 * link the owner already holds.
 *
 * Inside the caller's transaction, the one that checked the account may be
 * given a link. It throws if no transaction is open.
 */
export function issueEnrolmentLink(userId: number, issuedBy: string, { replace = true }: { replace?: boolean } = {}): string {
	if (!sqlite.inTransaction) {
		throw new Error(
			'issueEnrolmentLink must be called inside the transaction that checks the account may be given a link: ' +
				'wrap the check and this call in inTransaction.'
		);
	}

	if (replace) db.delete(enrolmentLinks).where(eq(enrolmentLinks.userId, userId)).run();
	const token = randomBytes(32).toString('base64url');
	db.insert(enrolmentLinks)
		.values({
			tokenHash: sha256Hex(token),
			userId,
			issuedBy,
			createdAt: stamp(),
			expiresAt: stamp(new Date(Date.now() + ENROLMENT_LINK_LIFETIME_MS))
		})
		.run();
	return token;
}

/** What `resetTwoStep` removed and ended, and the new link's token. */
export type TwoStepReset = {
	factors: number;
	recoveryCodes: number;
	sessions: number;
	invites: number;
	challenges: number;
	/** How many of the account's report schedules that were on it paused, and their ids, in order (card 2894, D2). */
	reportSchedules: number;
	reportScheduleIds: number[];
	token: string;
};

/**
 * The meta of a two-step reset's CRITICAL line (card 2894, S15): the
 * account, who reset it (an administrator's id, or `'host'` for
 * scripts/mfa-reset.mjs), and the counts, with the ids of the report
 * schedules paused. The script writes the same fields from its own SQL, and
 * tests/mfa-reset-script.test.ts (T21) holds its meta equal to this for the
 * same reset.
 */
export function twoStepResetMeta(targetUserId: number, resetBy: number | 'host', reset: TwoStepReset) {
	return {
		targetUserId,
		resetBy,
		factorsRemoved: reset.factors,
		recoveryCodesRemoved: reset.recoveryCodes,
		sessionsEnded: reset.sessions,
		challengesEnded: reset.challenges,
		invitesEnded: reset.invites,
		reportSchedulesPaused: reset.reportSchedules,
		reportScheduleIds: reset.reportScheduleIds
	};
}

/**
 * Set the account's two-step sign-in back to nothing, and issue the link that
 * sets up a new one (card 2773, decision 11): its factors and recovery codes
 * are deleted, its wrong-code counts set to 0 and their pauses cleared, its
 * leave to set up on its password alone taken away (card 2769), and its
 * sessions, unused invites, pending sign-ins and enrolment links ended.
 * Its report schedules that are on are paused (card 2894, D2): a schedule
 * sends a board's activity whether or not anyone is signed in, so one made by
 * whoever took the device would outlive the reset; the holder turns back on
 * the ones they recognise through the step-up (card 2751).
 * Its password, API keys, webhooks, security banner, last sign-in and failed
 * codes since it are kept: the banner and that count are about the password
 * and the last sign-in, which a reset does not change. The keys and webhooks
 * kept are listed in the administrator's message and the holder's mail (S14).
 * The link is issued last, because ending the account's access deletes its
 * links. Once the reset is committed, an authenticator the account was adding
 * on its Account page is forgotten (card 2772, D1, S7): its sessions are gone,
 * and nothing is to be added to a reset account but through the link.
 *
 * Inside the caller's transaction, the one that checked the account may be
 * reset. It throws if no transaction is open.
 */
export function resetTwoStep(userId: number, issuedBy: string = 'admin-reset'): TwoStepReset {
	if (!sqlite.inTransaction) {
		throw new Error(
			'resetTwoStep must be called inside the transaction that checks the account may be reset: wrap the ' +
				'check and this call in inTransaction.'
		);
	}

	const factors = db.delete(mfaFactors).where(eq(mfaFactors.userId, userId)).run().changes;
	const recoveryCodes = db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId)).run().changes;
	db.update(users)
		.set({
			mfaKnownWrong: 0,
			mfaOtherWrong: 0,
			mfaRecoveryWrong: 0,
			mfaKnownResumesAt: null,
			mfaOtherResumesAt: null,
			mfaRecoveryResumesAt: null,
			// No setting up on the password alone after a reset (card 2773,
			// section 9; card 2769): the link issued below is the way back.
			mfaPasswordEnrol: 0
		})
		.where(eq(users.id, userId))
		.run();
	const ended = endAccountAccess(userId, { apiKeys: false });
	const token = issueEnrolmentLink(userId, issuedBy);
	afterCommit(() => forgetPendingAdd(userId));
	return {
		factors,
		recoveryCodes,
		sessions: ended.sessions,
		invites: ended.invites,
		challenges: ended.challenges,
		reportSchedules: ended.reportSchedules,
		reportScheduleIds: ended.reportScheduleIds,
		token
	};
}
