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
import { inTransaction } from './db/transaction';
import { endAccountAccess } from './auth';
import { createLogger } from './logger';
import { stamp } from '$lib/timestamps';
import { MFA_KEY_CHECK_SETTING, currentMfaKey } from './mfa-key';
import { enrolAad, factorAad, newFactorUid, openSealed, sealWith, sha256Hex, type Sealed } from './mfa-crypto';
import { TOTP_SECRET_BYTES } from './totp';
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
	const key = currentMfaKey();
	let why: 'no key' | 'other key' | 'does not open';
	if (key === null) {
		why = 'no key';
	} else if (factor.keyId !== key.id) {
		why = 'other key';
	} else {
		const opened = openSealed(
			key,
			{ nonce: factor.secretNonce, ciphertext: factor.secretCiphertext },
			factorAad(factor.userId, factor.factorUid)
		);
		if (opened !== null && opened.length === TOTP_SECRET_BYTES) return { usable: true, secret: opened };
		opened?.fill(0);
		why = 'does not open';
	}

	log.error(
		`A second factor could not be opened (${why}): factor ${factor.id} of user ${factor.userId}, made with key ` +
			`${factor.keyId}; this server's key is ${key?.id ?? 'not loaded'}. It is not counted as a wrong code; the ` +
			'account can use a recovery code.',
		{ factorId: factor.id, keyId: factor.keyId },
		{ userId: factor.userId }
	);
	return { usable: false, why };
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

/**
 * Issue an enrolment link for the account, and return its token (card 2773).
 * The account's earlier links are deleted first, so it has one link that
 * works, and a leaked older one stops working (decision 3). Only the token's
 * SHA-256 is stored; the token itself is returned for the caller to show
 * once, and is never logged or stored.
 *
 * Inside the caller's transaction, the one that checked the account may be
 * given a link. It throws if no transaction is open.
 */
export function issueEnrolmentLink(userId: number, issuedBy: string): string {
	if (!sqlite.inTransaction) {
		throw new Error(
			'issueEnrolmentLink must be called inside the transaction that checks the account may be given a link: ' +
				'wrap the check and this call in inTransaction.'
		);
	}

	db.delete(enrolmentLinks).where(eq(enrolmentLinks.userId, userId)).run();
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
	token: string;
};

/**
 * Set the account's two-step sign-in back to nothing, and issue the link that
 * sets up a new one (card 2773, decision 11): its factors and recovery codes
 * are deleted, its wrong-code counts set to 0 and their pauses cleared, and
 * its sessions, unused invites, pending sign-ins and enrolment links ended.
 * Its password, API keys, webhooks, report schedules, security banner, last
 * sign-in and failed codes since it are kept: the banner and that count are
 * about the password and the last sign-in, which a reset does not change.
 * The link is issued last, because ending the account's access deletes its
 * links.
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
			mfaRecoveryResumesAt: null
		})
		.where(eq(users.id, userId))
		.run();
	const ended = endAccountAccess(userId, { apiKeys: false, reportSchedules: false });
	const token = issueEnrolmentLink(userId, issuedBy);
	return {
		factors,
		recoveryCodes,
		sessions: ended.sessions,
		invites: ended.invites,
		challenges: ended.challenges,
		token
	};
}
