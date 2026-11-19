/**
 * Two-step sign-in's storage (card 2768): the start-up check's wiring, the
 * store of factors, recovery codes and enrolment seals, what an account
 * change ends, and what a backup holds of them and a restore brings back,
 * with the import's answer.
 *
 * The restores here are into the application's own in-memory database, from
 * backups `generateBackupData` makes of it; the import's writes its upload
 * and safety copy under a temporary folder the test points `process.cwd` at.
 *
 * The key is the process's own, made under DB_PATH=:memory: with
 * MFA_KEY_FILE='' and written nowhere. One test needs no key at all, and asks
 * for it through `currentMfaKey`, which is wrapped below for that alone.
 * Keys "of another server" are made in the test from random bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keyStub = vi.hoisted(() => ({ none: false }));

vi.mock('$lib/server/mfa-key', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/mfa-key')>();
	return { ...real, currentMfaKey: () => (keyStub.none ? null : real.currentMfaKey()) };
});

import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { enrolmentLinks, mfaFactors, mfaRecoveryCodes, settings, signInChallenges, users, webhooks } from '$lib/server/db/schema';
import { restoreFromBackup } from '$lib/server/db/restore';
import { generateBackupData } from '$lib/server/backup';
import { backupSealKey, sealCopy } from '$lib/server/backup-secrets';
import { mfaWithoutFactorSentence } from '$lib/server/mfa-backup';
import { inTransaction } from '$lib/server/db/transaction';
import { endAccountAccess } from '$lib/server/auth';
import { MFA_KEY_CHECK_SETTING, currentMfaKey, keyFromBytes, loadMfaKey, mfaKeyLoad, type FactorAtStart, type KeyLoad, type MfaKey } from '$lib/server/mfa-key';
import { factorAad, newFactorUid, sealWith, sha256Hex } from '$lib/server/mfa-crypto';
import { newTotpSecret, stepAt } from '$lib/server/totp';
import { canonicalRecoveryCode, newRecoveryCodes, recoveryCodeHash } from '$lib/server/recovery-codes';
import {
	addTotpFactor,
	factorSecret,
	openEnrolment,
	readMfaKeyCheck,
	sealEnrolment,
	spendRecoveryCode,
	spendStep,
	storeRecoveryCodes
} from '$lib/server/mfa-store';
import { MfaKeyError, checkMfaKeyAtStart, sealStoredSecretsAtStart } from '$lib/server/startup-checks';
import { mailPasswordAad, openStored, recordKeyCheck, sealValue, settingAad, webhookSecretAad } from '$lib/server/stored-secrets';
import { stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { failingWrite } from './helpers/failing-write';
import { importConfirmation, makeBoard, makeUser, makeWebhook, resetDb, stepUp } from './helpers/fixtures';
import { watchReads } from './helpers/reads';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';
import { allowOtherTimestampForms } from './helpers/timestamps';

/** This process's key. */
const key = (): MfaKey => currentMfaKey()!;

const factorRow = (id: number) => db.select().from(mfaFactors).where(eq(mfaFactors.id, id)).get()!;
const keyCheck = () => db.select().from(settings).where(eq(settings.key, MFA_KEY_CHECK_SETTING)).get()?.value ?? null;
const setKeyCheck = (value: string) =>
	db.insert(settings).values({ key: MFA_KEY_CHECK_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
const factorCount = () => db.select().from(mfaFactors).all().length;
const codesOf = (userId: number) => db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId)).all();

/** The first words of each write, as tests/atomic-accounts.test.ts reads them. */
const shape = (writes: readonly string[]) =>
	writes.map((each) => each.split(/[ (]/).slice(0, 3).join(' ').replace(/"/g, '').toLowerCase());

/** Every console line written while `fn` runs, by stream. */
function consoleLines(fn: () => void): { error: string[]; warn: string[] } {
	const error = vi.spyOn(console, 'error').mockImplementation(() => {});
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		fn();
		return { error: error.mock.calls.map((call) => String(call[0])), warn: warn.mock.calls.map((call) => String(call[0])) };
	} finally {
		error.mockRestore();
		warn.mockRestore();
	}
}

/** A pending sign-in and an enrolment link of the account, as card 2769 will write them. */
function pendingFor(userId: number, n: number): void {
	const expiresAt = stamp(new Date(Date.now() + 10 * 60 * 1000));
	for (let i = 0; i < n; i++) {
		db.insert(signInChallenges)
			.values({
				tokenHash: sha256Hex(`challenge-${userId}-${i}-${randomBytes(4).toString('hex')}`),
				shortId: `c${userId}${i}`,
				userId,
				purpose: 'sign-in',
				lane: 'other',
				passwordHash: '$2b$04$notareal.hash',
				expiresAt
			})
			.run();
	}
	db.insert(enrolmentLinks)
		.values({ tokenHash: sha256Hex(`link-${userId}-${randomBytes(4).toString('hex')}`), userId, issuedBy: 'admin', expiresAt })
		.run();
}
const pendingOf = (userId: number) => ({
	challenges: db.select().from(signInChallenges).where(eq(signInChallenges.userId, userId)).all().length,
	links: db.select().from(enrolmentLinks).where(eq(enrolmentLinks.userId, userId)).all().length
});

beforeEach(() => {
	// The key back first: resetDb writes the form key sealed under it (card 2898).
	keyStub.none = false;
	resetDb();
});

describe('checkMfaKeyAtStart', () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), 'dumpfire-mfa-start-'));
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it('T30: on a key that does not load, writes one [CRITICAL] [AUTH] line, the path printable and no key file content, and throws', () => {
		// A folder whose name holds a character printable() replaces, and a key file in it that is no key.
		const folder = join(scratch, 'odd​name');
		mkdirSync(folder);
		const content = 'c0ffee'.repeat(10);
		const path = join(folder, 'mfa.key');
		writeFileSync(path, `${content}\n`, { mode: 0o600 });
		const load = loadMfaKey({ nodeEnv: 'production', keyFile: path, dbPath: join(scratch, 'dumpfire.db') });
		// resetDb's sealed form key recorded one (card 2898): none, to see that none is written.
		db.delete(settings).where(eq(settings.key, MFA_KEY_CHECK_SETTING)).run();

		let thrown: unknown;
		const lines = consoleLines(() => {
			try {
				checkMfaKeyAtStart(load, () => [], () => null);
			} catch (err) {
				thrown = err;
			}
		});

		expect(thrown).toBeInstanceOf(MfaKeyError);
		expect(lines.error).toHaveLength(1);
		const [line] = lines.error;
		expect(line).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] \[CRITICAL\] \[AUTH\] The server will not start\. The MFA key file /);
		expect(line).toContain(join(scratch, 'odd name', 'mfa.key'));
		expect(line).not.toContain('​');
		expect(line).not.toContain(content.slice(0, 12));
		expect((thrown as MfaKeyError).line).toBe(line);
		expect(keyCheck()).toBeNull();
	});

	it('T31: with factors and no stored check, records the check, names the unreadable factor at ERROR, warns, and starts', () => {
		const loaded: KeyLoad = { ok: true, key: key(), path: null, made: false, insideDatabaseDir: false, warnings: ['The key file is readable.'] };
		const sealedAs = (id: number, userId: number, by: MfaKey): FactorAtStart => {
			const factorUid = newFactorUid();
			const sealed = sealWith(by, newTotpSecret(), factorAad(userId, factorUid));
			return { id, userId, factorUid, keyId: sealed.keyId, ciphertext: sealed.ciphertext, nonce: sealed.nonce };
		};
		const factors = [sealedAs(11, 2, key()), sealedAs(12, 3, keyFromBytes(randomBytes(32)))];

		const lines = consoleLines(() => checkMfaKeyAtStart(loaded, () => factors));

		expect(keyCheck()).toBe(key().check);
		const authErrors = lines.error.filter((line) => line.includes('[ERROR] [AUTH]'));
		expect(authErrors).toHaveLength(1);
		expect(authErrors[0]).toContain('1 second factor(s) could not be opened');
		expect(authErrors[0]).toContain('factor 12 of user 3');
		expect(authErrors[0]).not.toContain('factor 11');
		expect(lines.warn.some((line) => line.includes('[WARN]') && line.includes('The key file is readable.'))).toBe(true);
	});

	it('T31b: when this start made the key, warns on the console naming its path, printable, and that it must be backed up apart', () => {
		const path = join(scratch, 'odd​name', 'mfa.key');
		const made: KeyLoad = { ok: true, key: key(), path, made: true, insideDatabaseDir: false, warnings: [] };
		const notMade: KeyLoad = { ...made, made: false };

		const lines = consoleLines(() => checkMfaKeyAtStart(made, () => [], () => null));
		const said = lines.warn.filter((line) => line.includes('The server made a new MFA key'));
		expect(said).toHaveLength(1);
		expect(said[0]).toContain('[WARN]');
		expect(said[0]).toContain(join(scratch, 'odd name', 'mfa.key'));
		expect(said[0]).not.toContain('​');
		expect(said[0]).toContain('Back it up apart from the database');

		// A key read, not made, is not said.
		const quiet = consoleLines(() => checkMfaKeyAtStart(notMade, () => [], () => null));
		expect(quiet.warn.some((line) => line.includes('The server made a new MFA key'))).toBe(false);
	});
});

describe('the store', () => {
	it('T32: a factor keeps no secret bytes, names this key, has a 32-hex uid and opens; the first records the check and the second leaves it', () => {
		const user = makeUser();
		const secret = newTotpSecret();
		const { id, factorUid } = addTotpFactor(user.id, 'Phone', secret);

		const row = factorRow(id);
		const text = JSON.stringify(row);
		for (const form of [secret.toString('hex'), secret.toString('base64'), secret.toString('latin1')]) {
			expect(text).not.toContain(form);
		}
		expect(row.keyId).toBe(key().id);
		expect(row.factorUid).toBe(factorUid);
		expect(factorUid).toMatch(/^[0-9a-f]{32}$/);
		expect(row.kind).toBe('totp');
		expect(factorSecret(row)).toEqual({ usable: true, secret });
		expect(keyCheck()).toBe(key().check);

		addTotpFactor(user.id, 'Tablet', newTotpSecret());
		expect(keyCheck()).toBe(key().check);
		expect(db.select().from(settings).where(eq(settings.key, MFA_KEY_CHECK_SETTING)).all()).toHaveLength(1);
	});

	it("T33: a factor's ciphertext copied to another factor or another account does not open, said once each; nor does a 19-byte secret", () => {
		const owner = makeUser();
		const other = makeUser();
		const first = factorRow(addTotpFactor(owner.id, 'Phone', newTotpSecret()).id);
		const second = addTotpFactor(owner.id, 'Tablet', newTotpSecret()).id;
		const theirs = addTotpFactor(other.id, 'Phone', newTotpSecret()).id;
		for (const id of [second, theirs]) {
			db.update(mfaFactors).set({ secretCiphertext: first.secretCiphertext, secretNonce: first.secretNonce }).where(eq(mfaFactors.id, id)).run();
		}
		// Sealed rightly for its own row, but 19 bytes.
		const shortUid = newFactorUid();
		const short = sealWith(key(), randomBytes(19), factorAad(owner.id, shortUid));
		const shortId = db
			.insert(mfaFactors)
			.values({ factorUid: shortUid, userId: owner.id, kind: 'totp', label: 'Short', keyId: key().id, secretCiphertext: short.ciphertext, secretNonce: short.nonce, createdAt: stamp() })
			.returning({ id: mfaFactors.id })
			.get().id;

		for (const [id, userId] of [
			[second, owner.id],
			[theirs, other.id],
			[shortId, owner.id]
		]) {
			const row = factorRow(id);
			let answer: unknown;
			const lines = consoleLines(() => (answer = factorSecret(row)));
			expect(answer).toEqual({ usable: false, why: 'does not open' });
			const said = lines.error.filter((line) => line.includes('A second factor could not be opened'));
			expect(said).toHaveLength(1);
			expect(said[0]).toContain('[ERROR] [AUTH]');
			expect(said[0]).toContain(`factor ${id} of user ${userId}`);
			for (const hidden of [row.secretCiphertext, row.secretNonce, factorAad(userId, row.factorUid)]) {
				expect(said[0]).not.toContain(hidden);
			}
		}
	});

	it("T34: a factor of another key is 'other key', and with no key loaded 'no key'", () => {
		const user = makeUser();
		const uid = newFactorUid();
		const otherKey = keyFromBytes(randomBytes(32));
		const sealed = sealWith(otherKey, newTotpSecret(), factorAad(user.id, uid));
		const id = db
			.insert(mfaFactors)
			.values({ factorUid: uid, userId: user.id, kind: 'totp', label: 'Old', keyId: otherKey.id, secretCiphertext: sealed.ciphertext, secretNonce: sealed.nonce, createdAt: stamp() })
			.returning({ id: mfaFactors.id })
			.get().id;
		const ours = factorRow(addTotpFactor(user.id, 'Phone', newTotpSecret()).id);

		consoleLines(() => {
			expect(factorSecret(factorRow(id))).toEqual({ usable: false, why: 'other key' });
			keyStub.none = true;
			expect(factorSecret(ours)).toEqual({ usable: false, why: 'no key' });
		});
	});

	it("T35: replaces another key's stored check while no factor exists, and writes the factor", () => {
		const user = makeUser();
		// Nothing sealed (card 2898, S2): resetDb's sealed form key taken away.
		db.delete(settings).where(eq(settings.key, 'request_form_secret')).run();
		setKeyCheck(keyFromBytes(randomBytes(32)).check);

		const { id } = addTotpFactor(user.id, 'Phone', newTotpSecret());

		expect(keyCheck()).toBe(key().check);
		expect(factorRow(id).userId).toBe(user.id);
	});

	it("T36: refuses, writing nothing, when another key's check is stored and a factor exists", () => {
		const user = makeUser();
		addTotpFactor(user.id, 'Phone', newTotpSecret());
		const theirs = keyFromBytes(randomBytes(32)).check;
		setKeyCheck(theirs);

		expect(() => addTotpFactor(user.id, 'Tablet', newTotpSecret())).toThrow(/does not match this server's key; no factor was written/);
		expect(factorCount()).toBe(1);
		expect(keyCheck()).toBe(theirs);
	});

	it('T37: an enrolment seal opens for its account and token only; the factor made from it is sealed afresh for the factor', () => {
		const user = makeUser();
		const other = makeUser();
		const tokenHash = sha256Hex('an enrolment token');
		const secret = newTotpSecret();
		const sealed = sealEnrolment(user.id, tokenHash, secret);

		expect(openEnrolment(user.id, tokenHash, sealed)).toEqual(secret);
		expect(openEnrolment(other.id, tokenHash, sealed)).toBeNull();
		expect(openEnrolment(user.id, sha256Hex('another token'), sealed)).toBeNull();

		const row = factorRow(addTotpFactor(user.id, 'Phone', openEnrolment(user.id, tokenHash, sealed)!).id);
		expect(row.secretNonce).not.toBe(sealed.nonce);
		expect(factorSecret(row)).toEqual({ usable: true, secret });
		expect(openEnrolment(user.id, tokenHash, { nonce: row.secretNonce, ciphertext: row.secretCiphertext })).toBeNull();
	});

	it('T38: spends a step on a new factor and a later one, each by one UPDATE with no read of mfa_factors before it', () => {
		const user = makeUser();
		const { id } = addTotpFactor(user.id, 'Phone', newTotpSecret());
		const step = stepAt(Date.now());

		expect(spendStep(id, step)).toBe('spent');
		const spent = factorRow(id);
		expect(spent.lastStep).toBe(step);
		expect(spent.lastUsedAt).not.toBeNull();
		expect(spendStep(id, step + 1)).toBe('spent');
		expect(factorRow(id).lastStep).toBe(step + 1);

		const writes = failingWrite();
		try {
			expect(spendStep(id, step + 2)).toBe('spent');
			expect(shape(writes.writes)).toEqual(['update mfa_factors set']);
		} finally {
			writes.restore();
		}
		const reads = watchReads('mfa_factors');
		try {
			expect(spendStep(id, step + 3)).toBe('spent');
			expect(reads.inTransaction).toEqual([]);
		} finally {
			reads.restore();
		}
	});

	it("T39: does not spend a step already spent, or an earlier one, and leaves the row as it was", () => {
		const user = makeUser();
		const { id } = addTotpFactor(user.id, 'Phone', newTotpSecret());
		const step = stepAt(Date.now());
		expect(spendStep(id, step)).toBe('spent');
		const before = factorRow(id);

		expect(spendStep(id, step)).toBe('not spent');
		expect(spendStep(id, step - 1)).toBe('not spent');
		expect(factorRow(id)).toEqual(before);
	});

	it('T40: stores ten account-bound hashes and no code text; a second set replaces it, and an old code is then not found', () => {
		const user = makeUser();
		const codes = newRecoveryCodes();
		storeRecoveryCodes(user.id, codes);

		const rows = codesOf(user.id);
		expect(rows.map((row) => row.codeHash).sort()).toEqual(
			codes.map((code) => recoveryCodeHash(user.id, canonicalRecoveryCode(code)!)).sort()
		);
		const text = JSON.stringify(rows);
		for (const code of codes) {
			expect(text).not.toContain(code);
			expect(text).not.toContain(canonicalRecoveryCode(code)!);
		}

		const again = newRecoveryCodes();
		storeRecoveryCodes(user.id, again);
		expect(codesOf(user.id).map((row) => row.codeHash).sort()).toEqual(
			again.map((code) => recoveryCodeHash(user.id, canonicalRecoveryCode(code)!)).sort()
		);
		expect(spendRecoveryCode(user.id, codes[0])).toBe('not found');
	});

	it('T41: spends a right code typed in lower case with spaces, once, by one UPDATE with no read before it', () => {
		const user = makeUser();
		const codes = newRecoveryCodes();
		storeRecoveryCodes(user.id, codes);
		const typed = codes[0].toLowerCase().replace(/-/g, ' ');

		expect(spendRecoveryCode(user.id, typed)).toBe('spent');
		const hash = recoveryCodeHash(user.id, canonicalRecoveryCode(codes[0])!);
		expect(codesOf(user.id).find((row) => row.codeHash === hash)!.usedAt).not.toBeNull();
		expect(spendRecoveryCode(user.id, codes[0])).toBe('not found');

		const writes = failingWrite();
		try {
			expect(spendRecoveryCode(user.id, codes[1])).toBe('spent');
			expect(shape(writes.writes)).toEqual(['update mfa_recovery_codes set']);
		} finally {
			writes.restore();
		}
		const reads = watchReads('mfa_recovery_codes');
		try {
			expect(spendRecoveryCode(user.id, codes[2])).toBe('spent');
			expect(reads.inTransaction).toEqual([]);
		} finally {
			reads.restore();
		}
	});

	it("T42: a row of another account holding this account's hash of the code is not found, and stays unspent", () => {
		// Only the WHERE's user_id can refuse it: the hash is this account's own.
		const owner = makeUser();
		const other = makeUser();
		const [code] = newRecoveryCodes();
		db.insert(mfaRecoveryCodes)
			.values({ userId: other.id, codeHash: recoveryCodeHash(owner.id, canonicalRecoveryCode(code)!), createdAt: stamp() })
			.run();

		expect(spendRecoveryCode(owner.id, code)).toBe('not found');
		expect(codesOf(owner.id)).toEqual([]);
		expect(codesOf(other.id)).toHaveLength(1);
		expect(codesOf(other.id)[0].usedAt).toBeNull();
	});

	it('T43: a hash row moved to another account is not found for either', () => {
		const owner = makeUser();
		const other = makeUser();
		const codes = newRecoveryCodes();
		storeRecoveryCodes(owner.id, codes);
		const hash = recoveryCodeHash(owner.id, canonicalRecoveryCode(codes[0])!);
		db.update(mfaRecoveryCodes).set({ userId: other.id }).where(eq(mfaRecoveryCodes.codeHash, hash)).run();

		expect(spendRecoveryCode(owner.id, codes[0])).toBe('not found');
		expect(spendRecoveryCode(other.id, codes[0])).toBe('not found');
		expect(codesOf(other.id)[0].usedAt).toBeNull();
	});

	it("T44: a malformed code is 'not a code', and no statement is run", () => {
		const user = makeUser();
		storeRecoveryCodes(user.id, newRecoveryCodes());
		const prepare = vi.spyOn(sqlite, 'prepare');
		const exec = vi.spyOn(sqlite, 'exec');
		try {
			expect(spendRecoveryCode(user.id, 'not-a-code')).toBe('not a code');
			expect(prepare).not.toHaveBeenCalled();
			expect(exec).not.toHaveBeenCalled();
		} finally {
			prepare.mockRestore();
			exec.mockRestore();
		}
	});
});

describe('what an account change ends', () => {
	it("T45: endAccountAccess deletes the account's pending sign-ins and enrolment links, not another's, and counts them", () => {
		const user = makeUser();
		const other = makeUser();
		pendingFor(user.id, 2);
		pendingFor(other.id, 1);

		const ended = inTransaction(() => endAccountAccess(user.id, { apiKeys: false, cause: { log: 'a test', mail: 'a test' } }));

		expect(ended).toMatchObject({ challenges: 2, enrolmentLinks: 1 });
		expect(pendingOf(user.id)).toEqual({ challenges: 0, links: 0 });
		expect(pendingOf(other.id)).toEqual({ challenges: 1, links: 1 });
	});

	it("T46: changing one's own email address ends the account's pending sign-ins and enrolment links, not another's", async () => {
		const user = makeUser();
		const other = makeUser();
		pendingFor(user.id, 2);
		pendingFor(other.id, 1);

		// The current password and a code, through the step-up (card 2771).
		const res = await api('PUT', '/api/account/email', stepUp(user, { newEmail: 'moved@example.test' }));

		expect(res.status).toBe(200);
		expect(pendingOf(user.id)).toEqual({ challenges: 0, links: 0 });
		expect(pendingOf(other.id)).toEqual({ challenges: 1, links: 1 });
	});

	it("T47: an administrator's change of an account's email or role ends that account's pending sign-ins and enrolment links", async () => {
		const chief = makeUser({ role: 'superadmin' });
		const target = makeUser();
		const bystander = makeUser();
		pendingFor(target.id, 2);
		pendingFor(bystander.id, 1);

		const moved = await api('PUT', `/api/users/${target.id}`, stepUp(chief, { email: 'elsewhere@example.test' }));
		expect(moved.status).toBe(200);
		expect(pendingOf(target.id)).toEqual({ challenges: 0, links: 0 });

		pendingFor(target.id, 1);
		const promoted = await api('PUT', `/api/users/${target.id}`, stepUp(chief, { role: 'admin' }));
		expect(promoted.status).toBe(200);
		expect(pendingOf(target.id)).toEqual({ challenges: 0, links: 0 });
		expect(pendingOf(bystander.id)).toEqual({ challenges: 1, links: 1 });
	});
});

// ─── Card 2898: the key check's one rule, and the stored secrets at start ────

describe('the key check, one rule for factors and stored secrets (card 2898, S2)', () => {
	const formKeyRow = () => db.select().from(settings).where(eq(settings.key, 'request_form_secret')).get();

	it('13: none stored is recorded; another key\'s while anything is sealed throws; a stale one while nothing is sealed is replaced; a factor is refused when only a stored secret is sealed', () => {
		// Row 1: none stored.
		db.delete(settings).where(eq(settings.key, MFA_KEY_CHECK_SETTING)).run();
		recordKeyCheck(sqlite, key());
		expect(keyCheck()).toBe(key().check);

		// Row 2: another key's, and the form key sealed: thrown, nothing written.
		const theirs = keyFromBytes(randomBytes(32)).check;
		setKeyCheck(theirs);
		expect(formKeyRow()?.value).toMatch(/^dfsealed:1:/);
		expect(() => recordKeyCheck(sqlite, key())).toThrow(/does not match this server's key/);
		expect(keyCheck()).toBe(theirs);

		// Row 4: no factor at all, and the stored secret alone refuses one (addTotpFactor counts anything sealed).
		const user = makeUser();
		expect(() => addTotpFactor(user.id, 'Phone', newTotpSecret())).toThrow(/does not match this server's key; no factor was written/);
		expect(factorCount()).toBe(0);
		expect(keyCheck()).toBe(theirs);

		// Row 3: nothing sealed, a stale check replaced.
		db.delete(settings).where(eq(settings.key, 'request_form_secret')).run();
		recordKeyCheck(sqlite, key());
		expect(keyCheck()).toBe(key().check);
	});
});

describe('the stored secrets at start (card 2898)', () => {
	const MAIL = { smtp_host: 'mail.example.test', smtp_user: 'sender' };
	const settingNow = (name: string) => db.select().from(settings).where(eq(settings.key, name)).get()?.value;
	const put = (name: string, value: string) =>
		db.insert(settings).values({ key: name, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
	const loaded = (by: MfaKey): KeyLoad => ({ ok: true, key: by, path: null, made: false, insideDatabaseDir: false, warnings: [] });

	it('18: a fresh install with secrets in plain is sealed at start and its check recorded; a start with another key is then refused', () => {
		db.delete(settings).where(eq(settings.key, MFA_KEY_CHECK_SETTING)).run();
		for (const [name, value] of Object.entries(MAIL)) put(name, value);
		put('smtp_pass', 'the mail password');
		put('request_form_secret', 'e'.repeat(64));

		consoleLines(() => sealStoredSecretsAtStart());

		expect(settingNow('smtp_pass')).toMatch(/^dfsealed:1:/);
		expect(settingNow('request_form_secret')).toMatch(/^dfsealed:1:/);
		expect(keyCheck()).toBe(key().check);

		let thrown: unknown;
		consoleLines(() => {
			try {
				checkMfaKeyAtStart(loaded(keyFromBytes(randomBytes(32))), () => [], undefined, { ok: true, key: null, path: null, warnings: [] });
			} catch (err) {
				thrown = err;
			}
		});
		expect(thrown).toBeInstanceOf(MfaKeyError);
		expect((thrown as MfaKeyError).message).toMatch(/or the stored secrets were sealed with/);
	});

	it("18b: a stale check of another key with nothing sealed, a plain form key and no factors: the start goes on, and this key's check is recorded (the code review E1)", () => {
		put(MFA_KEY_CHECK_SETTING, keyFromBytes(randomBytes(32)).check);
		put('request_form_secret', 'e'.repeat(64));

		consoleLines(() => checkMfaKeyAtStart(mfaKeyLoad(), () => [], undefined, { ok: true, key: null, path: null, warnings: [] }));
		consoleLines(() => sealStoredSecretsAtStart(sqlite, () => {}));

		expect(keyCheck()).toBe(key().check);
		expect(settingNow('request_form_secret')).toMatch(/^dfsealed:1:/);
	});

	it('18c: addTotpFactor puts only the key-check mismatch in its own words, and any other failure is thrown as it was (the code review E9)', () => {
		const user = makeUser();
		db.delete(settings).where(eq(settings.key, MFA_KEY_CHECK_SETTING)).run();
		const writes = failingWrite();
		let thrown: unknown;
		try {
			writes.failNth(1);
			addTotpFactor(user.id, 'Phone', newTotpSecret());
		} catch (err) {
			thrown = err;
		} finally {
			writes.restore();
		}
		expect(String(thrown)).toMatch(/failingWrite: write 1 was made to fail/);
		expect(factorCount()).toBe(0);
	});

	it('19: with the right key and one stored secret tampered with, the start goes on and one ERROR names it, holding no value; it reads as unopenable', () => {
		for (const [name, value] of Object.entries(MAIL)) put(name, value);
		put('smtp_pass', sealValue('the-mail-password-19', mailPasswordAad(MAIL), key()));
		// Moved by hand to another host: the seal no longer opens there.
		put('smtp_host', 'mail.elsewhere.test');

		const lines = consoleLines(() => checkMfaKeyAtStart(mfaKeyLoad(), () => [], undefined, { ok: true, key: null, path: null, warnings: [] }));

		const errors = lines.error.filter((line) => line.includes('[ERROR] [AUTH]') && line.includes('stored secret(s) could not be opened'));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('the mail password');
		expect([...lines.error, ...lines.warn].filter((line) => line.includes('the-mail-password-19'))).toEqual([]);
		expect(openStored(settingNow('smtp_pass'), mailPasswordAad({ ...MAIL, smtp_host: 'mail.elsewhere.test' })).kind).toBe('unopenable');
	});

	/** No check stored, and a mail password, the form key and a webhook's secret sealed under another key: none opens. */
	function noneOpens() {
		const theirs = keyFromBytes(randomBytes(32));
		db.delete(settings).where(eq(settings.key, MFA_KEY_CHECK_SETTING)).run();
		for (const [name, value] of Object.entries(MAIL)) put(name, value);
		put('smtp_pass', sealValue('their mail password', mailPasswordAad(MAIL), theirs));
		put('request_form_secret', sealValue('f'.repeat(64), settingAad('request_form_secret'), theirs));
		const owner = makeUser();
		const hook = makeWebhook(makeBoard({ owner }).board, { url: 'https://hooks.example.test/forgotten' });
		db.update(webhooks).set({ secret: sealValue('their webhook secret', webhookSecretAad(hook.id, hook.boardId, hook.url), theirs) }).where(eq(webhooks.id, hook.id)).run();
		return hook;
	}
	const NO_PREVIOUS = { ok: true as const, key: null, path: null, warnings: [] };

	// The code review's S6 reversed decision 10: the forget never runs on its own.
	it('20: with no check stored and none of the stored secrets opening, the start is refused, naming FORGET_UNOPENABLE_SECRETS, and nothing is changed', () => {
		noneOpens();
		const before = snapshotDb();

		let thrown: unknown;
		consoleLines(() => {
			try {
				checkMfaKeyAtStart(mfaKeyLoad(), () => [], undefined, NO_PREVIOUS, undefined, undefined, false);
			} catch (err) {
				thrown = err;
			}
		});

		expect(thrown).toBeInstanceOf(MfaKeyError);
		expect((thrown as MfaKeyError).message).toMatch(/None of the 3 stored secret\(s\) opens with this MFA key, and no key check is stored/);
		expect((thrown as MfaKeyError).message).toContain('FORGET_UNOPENABLE_SECRETS=1');
		expectUnchanged(before);
	});

	it('20c: with FORGET_UNOPENABLE_SECRETS=1, stored secrets none of which opens are forgotten as a backup forgets them, the check recorded and the scrub marked', () => {
		const hook = noneOpens();

		const lines = consoleLines(() => checkMfaKeyAtStart(mfaKeyLoad(), () => [], undefined, NO_PREVIOUS, undefined, undefined, true));

		expect(settingNow('secrets_scrub_pending')).toMatch(/^\d{4}-/);
		expect(lines.warn.filter((line) => line.includes('FORGET_UNOPENABLE_SECRETS=1 is set'))).toHaveLength(1);
		expect(settingNow('smtp_pass')).toBeUndefined();
		expect(settingNow('request_form_secret')).toBeUndefined();
		const row = db.select().from(webhooks).where(eq(webhooks.id, hook.id)).get()!;
		expect(row.secret).toBe('');
		expect(row.active).toBe(false);
		expect(JSON.parse(settingNow('webhook_secrets_left_out')!)).toEqual([{ id: hook.id, active: true }]);
		expect(keyCheck()).toBe(key().check);
		expect(lines.error.filter((line) => line.includes('were forgotten as a backup forgets them'))).toHaveLength(1);
	});

	it('20b: with no check stored and some stored secrets opening, the check is recorded and the rest named unreadable, nothing forgotten', () => {
		db.delete(settings).where(eq(settings.key, MFA_KEY_CHECK_SETTING)).run();
		for (const [name, value] of Object.entries(MAIL)) put(name, value);
		const theirs = sealValue('their mail password', mailPasswordAad(MAIL), keyFromBytes(randomBytes(32)));
		put('smtp_pass', theirs);
		// The form key resetDb sealed under this key opens.

		const lines = consoleLines(() => checkMfaKeyAtStart(mfaKeyLoad(), () => [], undefined, { ok: true, key: null, path: null, warnings: [] }));

		expect(settingNow('smtp_pass')).toBe(theirs);
		expect(keyCheck()).toBe(key().check);
		expect(lines.error.filter((line) => line.includes('1 stored secret(s) could not be opened') && line.includes('the mail password'))).toHaveLength(1);
		expect(lines.error.filter((line) => line.includes('forgotten'))).toEqual([]);
	});
});

describe('addTotpFactor, given a secret that is not 20 bytes', () => {
	it('refuses it and writes nothing: no factor row, no mfa_key_check', () => {
		const user = makeUser();
		// resetDb's sealed form key recorded one (card 2898): none, to see that none is written.
		db.delete(settings).where(eq(settings.key, MFA_KEY_CHECK_SETTING)).run();

		for (const length of [0, 19, 21, 32]) {
			expect(() => addTotpFactor(user.id, 'Phone', randomBytes(length))).toThrow(/is 20 bytes; no factor was written/);
		}

		expect(factorCount()).toBe(0);
		expect(keyCheck()).toBeNull();
	});
});

describe('mfaWithoutFactorSentence', () => {
	const none = { withoutFactor: [], leftOut: [], leftOutBecause: null, takenFromBackup: 0 } as const;
	const SEE = ' See docs/admin-guide.md, Restoring from Backup.';

	it('R4: names why the backup\'s factors were left out, in plain words, for each reason, after the accounts without one', () => {
		const reasons = [
			['unsealed', 'the backup was not made by this server, or was changed after it was made'],
			['no key', 'no MFA key is loaded on this server'],
			['key differs', 'the backup was made under a different MFA key']
		] as const;
		for (const [because, words] of reasons) {
			expect(
				mfaWithoutFactorSentence({ ...none, withoutFactor: ['chief', 'gone'], leftOut: ['gone'], leftOutBecause: because }),
				because
			).toBe(
				'2 account(s) have no second factor after this restore and each needs its two-step sign-in reset before it ' +
					`can sign in: chief, gone. Their second factors in the backup were left out because ${words}: gone.${SEE}`
			);
		}
	});

	it('R5: says once, when any account was brought back from the backup, to have them regenerate their recovery codes', () => {
		const note =
			'Accounts brought back from the backup have their recovery codes as they were then; ask them to regenerate their codes.';
		expect(mfaWithoutFactorSentence({ ...none, takenFromBackup: 2 })).toBe(`${note}${SEE}`);
		expect(mfaWithoutFactorSentence({ ...none, withoutFactor: ['chief'], takenFromBackup: 1 })).toBe(
			'1 account(s) have no second factor after this restore and each needs its two-step sign-in reset before it ' +
				`can sign in: chief. ${note}${SEE}`
		);
		expect(mfaWithoutFactorSentence(none)).toBeNull();
	});
});

describe('backups and restores', () => {
	const opened: Database.Database[] = [];
	afterEach(() => {
		for (const database of opened.splice(0)) database.close();
	});

	/** A backup of the application's database, made now and opened. */
	const backupNow = () => {
		const backup = new Database(generateBackupData());
		opened.push(backup);
		return backup;
	};
	const restore = (backup: Database.Database, options: { key?: MfaKey | null } = {}) => restoreFromBackup(sqlite, backup, options);

	const factorsOf = (userId: number) => db.select().from(mfaFactors).where(eq(mfaFactors.userId, userId)).all();
	const userRow = (id: number) => db.select().from(users).where(eq(users.id, id)).get()!;
	const deleteUser = (id: number) => db.delete(users).where(eq(users.id, id)).run();
	const setBackupKeyCheck = (backup: Database.Database, value: string) =>
		backup.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, MFA_KEY_CHECK_SETTING);
	const rowsIn = (database: Database.Database, table: string) =>
		(database.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;

	/** An account with a factor and ten recovery codes, under this process's key. */
	function enrolled(username?: string) {
		const user = makeUser({ username });
		const factor = addTotpFactor(user.id, 'Phone', newTotpSecret());
		const codes = newRecoveryCodes();
		storeRecoveryCodes(user.id, codes);
		return { user, factor, codes };
	}

	it('T48: generateBackupData holds no challenge or link, holds the factor as ciphertext, the code hashes and the key check, and no key', () => {
		// A key whose file bytes are known, as a server with that key file seals and checks with.
		const raw = randomBytes(32);
		const fileKey = keyFromBytes(Buffer.from(raw));
		const user = makeUser();
		// The key backups are sealed with, made now, before the check of another key is stored: it is
		// written sealed under this process's key, which records the check by the one rule (card 2898, S2).
		backupSealKey(sqlite);
		const factorUid = newFactorUid();
		const sealed = sealWith(fileKey, newTotpSecret(), factorAad(user.id, factorUid));
		db.insert(mfaFactors)
			.values({ factorUid, userId: user.id, kind: 'totp', label: 'Phone', keyId: fileKey.id, secretCiphertext: sealed.ciphertext, secretNonce: sealed.nonce, createdAt: stamp() })
			.run();
		setKeyCheck(fileKey.check);
		storeRecoveryCodes(user.id, newRecoveryCodes());
		pendingFor(user.id, 2);
		const pending = [
			...db.select().from(signInChallenges).all().map((row) => row.tokenHash),
			...db.select().from(enrolmentLinks).all().map((row) => row.tokenHash)
		];
		const hashes = codesOf(user.id).map((row) => row.codeHash).sort();

		const bytes = generateBackupData();
		const copy = new Database(bytes);
		opened.push(copy);

		expect(rowsIn(copy, 'sign_in_challenges')).toBe(0);
		expect(rowsIn(copy, 'enrolment_links')).toBe(0);
		for (const tokenHash of pending) expect(bytes.includes(Buffer.from(tokenHash))).toBe(false);
		expect(copy.prepare('SELECT factor_uid, key_id, secret_ciphertext, secret_nonce FROM mfa_factors').all()).toEqual([
			{ factor_uid: factorUid, key_id: fileKey.id, secret_ciphertext: sealed.ciphertext, secret_nonce: sealed.nonce }
		]);
		expect(copy.prepare('SELECT code_hash FROM mfa_recovery_codes ORDER BY code_hash').pluck().all() as string[]).toEqual(hashes);
		expect(readMfaKeyCheck(copy)).toBe(fileKey.check);

		// Neither the file key nor a derived AES key, this one's or the process's, in any form.
		for (const secret of [raw, fileKey.encryptionKey, key().encryptionKey]) {
			const hex = secret.toString('hex');
			for (const form of [secret, Buffer.from(hex), Buffer.from(hex.toUpperCase()), Buffer.from(secret.toString('base64'))]) {
				expect(bytes.includes(form)).toBe(false);
			}
		}
	});

	it("T49: this server's own sealed older backup keeps a removed factor removed, a used code used, an added factor, and this server's last_step", () => {
		makeUser({ role: 'superadmin' });
		const { user, factor: kept, codes } = enrolled();
		const removed = addTotpFactor(user.id, 'Old', newTotpSecret());
		const step = stepAt(Date.now());
		expect(spendStep(kept.id, step)).toBe('spent');
		const backup = backupNow();

		db.delete(mfaFactors).where(eq(mfaFactors.id, removed.id)).run();
		expect(spendRecoveryCode(user.id, codes[0])).toBe('spent');
		const added = addTotpFactor(user.id, 'Tablet', newTotpSecret());
		expect(spendStep(kept.id, step + 5)).toBe('spent');

		const result = restore(backup);

		expect(result.errors).toEqual([]);
		expect(result.sealVerified).toBe(true);
		const factors = factorsOf(user.id);
		expect(factors.map((row) => row.factorUid).sort()).toEqual([kept.factorUid, added.factorUid].sort());
		const keptRow = factors.find((row) => row.factorUid === kept.factorUid)!;
		expect(keptRow.lastStep).toBe(step + 5);
		expect(factorSecret(keptRow).usable).toBe(true);
		const used = recoveryCodeHash(user.id, canonicalRecoveryCode(codes[0])!);
		expect(codesOf(user.id).find((row) => row.codeHash === used)!.usedAt).not.toBeNull();
		expect(spendRecoveryCode(user.id, codes[0])).toBe('not found');
		expect(result.mfa).toMatchObject({ keptFromHere: 1, takenFromBackup: 0, leftOut: [], leftOutBecause: null });
		expect(result.restored['mfa_factors']).toBe(2);
		expect(result.restored['mfa_recovery_codes']).toBe(10);
	});

	it('T50: an account renamed since a sealed backup and restored to its old name is matched on id and created_at', () => {
		makeUser({ role: 'superadmin' });
		const { user, codes } = enrolled('before');
		const removed = addTotpFactor(user.id, 'Old', newTotpSecret());
		const backup = backupNow();

		db.update(users).set({ username: 'after' }).where(eq(users.id, user.id)).run();
		db.delete(mfaFactors).where(eq(mfaFactors.id, removed.id)).run();
		expect(spendRecoveryCode(user.id, codes[0])).toBe('spent');

		const result = restore(backup);

		expect(userRow(user.id).username).toBe('before');
		expect(factorsOf(user.id).map((row) => row.factorUid)).not.toContain(removed.factorUid);
		expect(factorsOf(user.id)).toHaveLength(1);
		const used = recoveryCodeHash(user.id, canonicalRecoveryCode(codes[0])!);
		expect(codesOf(user.id).find((row) => row.codeHash === used)!.usedAt).not.toBeNull();
		expect(result.mfa).toMatchObject({ keptFromHere: 1, takenFromBackup: 0, leftOut: [] });
	});

	it('T51: an account deleted here since the backup comes back with its factor and codes, and the factor opens', () => {
		makeUser({ role: 'superadmin' });
		const { user, factor, codes } = enrolled();
		const backup = backupNow();
		deleteUser(user.id);
		expect(factorsOf(user.id)).toEqual([]);

		const result = restore(backup);

		const factors = factorsOf(user.id);
		expect(factors.map((row) => row.factorUid)).toEqual([factor.factorUid]);
		expect(factorSecret(factors[0]).usable).toBe(true);
		expect(codesOf(user.id).map((row) => row.codeHash).sort()).toEqual(
			codes.map((code) => recoveryCodeHash(user.id, canonicalRecoveryCode(code)!)).sort()
		);
		expect(spendRecoveryCode(user.id, codes[1])).toBe('spent');
		expect(result.mfa).toMatchObject({ keptFromHere: 0, takenFromBackup: 1, leftOut: [], leftOutBecause: null });
	});

	it("T52: a backup sealed with another server's key has an account's MFA rows left out as 'unsealed', and names it without a factor", () => {
		makeUser({ role: 'superadmin' });
		const { user } = enrolled();
		const backup = backupNow();
		sealCopy(backup, randomBytes(32));
		deleteUser(user.id);

		const result = restore(backup);

		expect(result.sealVerified).toBe(false);
		expect(factorsOf(user.id)).toEqual([]);
		expect(codesOf(user.id)).toEqual([]);
		expect(result.mfa.leftOut).toEqual([user.username]);
		expect(result.mfa.leftOutBecause).toBe('unsealed');
		expect(result.mfa.withoutFactor).toContain(user.username);
	});

	it("T53: this server's own sealed backup restored with another key has an account's MFA rows left out as 'key differs'", () => {
		makeUser({ role: 'superadmin' });
		const { user } = enrolled();
		const backup = backupNow();
		deleteUser(user.id);

		const result = restore(backup, { key: keyFromBytes(randomBytes(32)) });

		expect(result.sealVerified).toBe(true);
		expect(factorsOf(user.id)).toEqual([]);
		expect(codesOf(user.id)).toEqual([]);
		expect(result.mfa.leftOut).toEqual([user.username]);
		expect(result.mfa.leftOutBecause).toBe('key differs');
	});

	it("T53b: this server's own sealed backup restored with no MFA key loaded has an account's MFA rows left out as 'no key'", () => {
		makeUser({ role: 'superadmin' });
		const { user } = enrolled();
		const backup = backupNow();
		deleteUser(user.id);

		const result = restore(backup, { key: null });

		expect(result.sealVerified).toBe(true);
		expect(factorsOf(user.id)).toEqual([]);
		expect(codesOf(user.id)).toEqual([]);
		expect(result.mfa.leftOut).toEqual([user.username]);
		expect(result.mfa.leftOutBecause).toBe('no key');
	});

	it("R1: the same id with another created_at is another account: this server's factor and codes are not kept, and it is named without a factor", () => {
		makeUser({ role: 'superadmin' });
		const { user } = enrolled();
		// Another account with a factor, so that two-step sign-in is in use after the restore.
		const { user: other } = enrolled();
		const backup = backupNow();
		// In the backup, the id is another account's, made at another moment,
		// holding no second factor or code; sealed again, as this server would.
		backup.prepare('UPDATE users SET created_at = ? WHERE id = ?').run('2001-01-01 00:00:00', user.id);
		backup.prepare('DELETE FROM mfa_factors WHERE user_id = ?').run(user.id);
		backup.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(user.id);
		sealCopy(backup, backupSealKey(sqlite));

		const result = restore(backup);

		expect(result.sealVerified).toBe(true);
		expect(userRow(user.id).createdAt).toBe('2001-01-01 00:00:00');
		expect(factorsOf(user.id)).toEqual([]);
		expect(codesOf(user.id)).toEqual([]);
		expect(factorsOf(other.id)).toHaveLength(1);
		expect(result.mfa.withoutFactor).toContain(user.username);
		expect(result.mfa.withoutFactor).not.toContain(other.username);
		expect(result.mfa).toMatchObject({ keptFromHere: 1, takenFromBackup: 0, leftOut: [] });
	});

	it('R2: a created_at the same moment in another form (ISO 8601 with Z) is the same account', () => {
		makeUser({ role: 'superadmin' });
		const { user, factor } = enrolled();
		const backup = backupNow();
		const createdAt = userRow(user.id).createdAt;
		backup.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(`${createdAt.replace(' ', 'T')}.000Z`, user.id);
		sealCopy(backup, backupSealKey(sqlite));
		// Added here since the backup: kept only if the account is matched.
		const added = addTotpFactor(user.id, 'Tablet', newTotpSecret());

		const result = restore(backup);

		expect(factorsOf(user.id).map((row) => row.factorUid).sort()).toEqual([factor.factorUid, added.factorUid].sort());
		expect(result.mfa).toMatchObject({ keptFromHere: 1, takenFromBackup: 0, leftOut: [] });
	});

	it('R3: a created_at that names no moment matches nothing, even the same text on both sides, so the backup is the word', () => {
		makeUser({ role: 'superadmin' });
		const { user, factor } = enrolled();
		// Written in no form a moment has, on purpose.
		allowOtherTimestampForms();
		db.update(users).set({ createdAt: 'not a moment' }).where(eq(users.id, user.id)).run();
		const backup = backupNow();
		// Added here since the backup: it would be kept were the account matched.
		const added = addTotpFactor(user.id, 'Tablet', newTotpSecret());

		const result = restore(backup);

		expect(factorsOf(user.id).map((row) => row.factorUid)).toEqual([factor.factorUid]);
		expect(factorsOf(user.id).map((row) => row.factorUid)).not.toContain(added.factorUid);
		expect(result.mfa).toMatchObject({ keptFromHere: 0, takenFromBackup: 1, leftOut: [] });
	});

	it('T54: on a server with a factor, a backup without the MFA tables and key check restores and names exactly the accounts with none', () => {
		const chief = makeUser({ role: 'superadmin' });
		const { user, factor } = enrolled();
		const other = makeUser();
		const backup = backupNow();
		// As a backup made before migration 0065 is.
		backup.exec('DROP TABLE mfa_factors; DROP TABLE mfa_recovery_codes; DROP TABLE sign_in_challenges; DROP TABLE enrolment_links;');
		backup.prepare('DELETE FROM settings WHERE key = ?').run(MFA_KEY_CHECK_SETTING);
		for (const column of [
			'mfa_known_wrong',
			'mfa_other_wrong',
			'mfa_known_resumes_at',
			'mfa_other_resumes_at',
			'mfa_recovery_wrong',
			'mfa_recovery_resumes_at',
			'last_sign_in_at',
			'last_sign_in_from',
			'failed_codes_since_sign_in',
			'security_banner',
			'security_banner_at',
			// Migration 0066 (card 2769).
			'mfa_password_enrol',
			// Migration 0069 (card 2772's code review, CS1).
			'security_signal_last_at'
		]) {
			backup.exec(`ALTER TABLE users DROP COLUMN ${column}`);
		}

		const result = restore(backup);

		expect(result.errors).toEqual([]);
		expect(factorsOf(user.id).map((row) => row.factorUid)).toEqual([factor.factorUid]);
		expect(result.mfa.leftOut).toEqual([]);
		expect(result.mfa.leftOutBecause).toBeNull();
		expect(result.mfa.withoutFactor).toEqual([chief.username, other.username]);
	});

	it("T55: zeroes every account's guessing counters; the same account keeps this server's history, any other has the backup's", () => {
		makeUser({ role: 'superadmin' });
		const same = makeUser();
		const gone = makeUser();
		const guessing = {
			mfaKnownWrong: 4,
			mfaOtherWrong: 2,
			mfaKnownResumesAt: '2026-11-05 10:15:00',
			mfaOtherResumesAt: '2026-11-05 10:20:00',
			mfaRecoveryWrong: 3,
			mfaRecoveryResumesAt: '2026-11-05 10:25:00'
		};
		// Leave to set up on the password alone (card 2769) is zeroed with the
		// guessing counters, and then kept for the same account as its history is.
		const then = {
			lastSignInAt: '2026-10-01 09:00:00',
			lastSignInFrom: '10.0.0.1',
			failedCodesSinceSignIn: 1,
			securityBanner: null,
			securityBannerAt: null,
			mfaPasswordEnrol: 1,
			// Migration 0069 (card 2772's code review, CS1): kept with the banner.
			securitySignalLastAt: null
		};
		const now = {
			lastSignInAt: '2026-11-04 18:00:00',
			lastSignInFrom: '10.0.0.2',
			failedCodesSinceSignIn: 3,
			securityBanner: 'password used elsewhere',
			securityBannerAt: '2026-11-04 18:05:00',
			mfaPasswordEnrol: 1,
			securitySignalLastAt: '2026-11-04 18:40:00'
		};
		for (const id of [same.id, gone.id]) db.update(users).set({ ...guessing, ...then }).where(eq(users.id, id)).run();
		const backup = backupNow();
		db.update(users).set({ ...guessing, ...now }).where(eq(users.id, same.id)).run();
		deleteUser(gone.id);

		restore(backup);

		for (const row of db.select().from(users).all()) {
			expect(row).toMatchObject({
				mfaKnownWrong: 0,
				mfaOtherWrong: 0,
				mfaKnownResumesAt: null,
				mfaOtherResumesAt: null,
				mfaRecoveryWrong: 0,
				mfaRecoveryResumesAt: null
			});
		}
		expect(userRow(same.id)).toMatchObject(now);
		expect(userRow(gone.id)).toMatchObject({ ...then, mfaPasswordEnrol: 0 });
	});

	it("T4: the same account keeps this server's flag 0 over the backup's 1; an account brought back from the backup gets 0", () => {
		// The flag lets an account set up two-step sign-in on its password alone
		// (card 2769). An administrator's reset since the backup set it to 0
		// here, and a restore must not give that leave back; nor may a backup
		// give it to an account that is not this server's.
		makeUser({ role: 'superadmin' });
		const same = makeUser();
		const gone = makeUser();
		for (const id of [same.id, gone.id]) db.update(users).set({ mfaPasswordEnrol: 1 }).where(eq(users.id, id)).run();
		const backup = backupNow();
		db.update(users).set({ mfaPasswordEnrol: 0 }).where(eq(users.id, same.id)).run();
		deleteUser(gone.id);

		const result = restore(backup);

		expect(result.errors).toEqual([]);
		expect(userRow(same.id).mfaPasswordEnrol).toBe(0);
		expect(userRow(gone.id).mfaPasswordEnrol).toBe(0);
	});

	it("T5: a backup made before migration 0066 restores, and the same account keeps this server's flag", () => {
		makeUser({ role: 'superadmin' });
		const same = makeUser();
		const other = makeUser();
		db.update(users).set({ mfaPasswordEnrol: 1 }).where(eq(users.id, same.id)).run();
		const backup = backupNow();
		// As a backup made before migration 0066 is: none of its columns, and no setting that starts the 14 days.
		backup.exec('ALTER TABLE users DROP COLUMN mfa_password_enrol');
		backup.exec('ALTER TABLE sessions DROP COLUMN two_step');
		backup.exec('ALTER TABLE sign_in_challenges DROP COLUMN enrol_grant');
		backup.exec('ALTER TABLE sign_in_challenges DROP COLUMN enrolment_link_hash');
		backup.prepare("DELETE FROM settings WHERE key = 'two_step_released_at'").run();
		deleteUser(other.id);

		const result = restore(backup);

		expect(result.errors).toEqual([]);
		expect(userRow(same.id).mfaPasswordEnrol).toBe(1);
		expect(userRow(other.id).mfaPasswordEnrol).toBe(0);
	});

	it("T56: a backup holding challenges and enrolment links brings none in, and this server's are gone", () => {
		makeUser({ role: 'superadmin' });
		const user = makeUser();
		const backup = backupNow();
		const expiresAt = stamp(new Date(Date.now() + 10 * 60 * 1000));
		backup
			.prepare(
				'INSERT INTO sign_in_challenges (token_hash, short_id, user_id, purpose, lane, password_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
			.run(sha256Hex('by hand'), 'h1', user.id, 'sign-in', 'other', '$2b$04$notareal.hash', expiresAt);
		backup
			.prepare('INSERT INTO enrolment_links (token_hash, user_id, issued_by, expires_at) VALUES (?, ?, ?, ?)')
			.run(sha256Hex('a link by hand'), user.id, 'admin', expiresAt);
		pendingFor(user.id, 2);

		const result = restore(backup);

		expect(rowsIn(sqlite, 'sign_in_challenges')).toBe(0);
		expect(rowsIn(sqlite, 'enrolment_links')).toBe(0);
		expect(result.restored['sign_in_challenges']).toBeUndefined();
		expect(result.restored['enrolment_links']).toBeUndefined();
	});

	it("T57: with a factor after the restore, settings holds this key's check, whatever the backup or this server held", () => {
		makeUser({ role: 'superadmin' });
		const { user } = enrolled();
		const backup = backupNow();
		setBackupKeyCheck(backup, keyFromBytes(randomBytes(32)).check);
		setKeyCheck(keyFromBytes(randomBytes(32)).check);

		restore(backup);

		expect(factorsOf(user.id)).toHaveLength(1);
		expect(keyCheck()).toBe(key().check);
	});

	// Card 2898 (S2): a restore always writes its new form key sealed, which
	// records this key's check, so with no factor the check is this key's,
	// whatever this server or the backup held; the backup's is never kept.
	it("T58: with no factor after the restore, the check is this key's, recorded with the sealed form key, and a backup's other check is not kept", () => {
		makeUser({ role: 'superadmin' });
		const backup = backupNow();
		setBackupKeyCheck(backup, keyFromBytes(randomBytes(32)).check);

		restore(backup);

		expect(factorCount()).toBe(0);
		expect(keyCheck()).toBe(key().check);

		// None here: this key's after.
		db.delete(settings).where(eq(settings.key, MFA_KEY_CHECK_SETTING)).run();
		restore(backup);
		expect(keyCheck()).toBe(key().check);
	});

	describe("the import's answer", () => {
		const logLevel = process.env.LOG_LEVEL;
		const folders: string[] = [];
		afterEach(() => {
			vi.restoreAllMocks();
			if (logLevel === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = logLevel;
			for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
		});

		/** Send `bytes` to the import as `superadmin`, with WARN lines kept, and answer the response and every console line. */
		async function importing(superadmin: ReturnType<typeof makeUser>, bytes: Buffer) {
			process.env.LOG_LEVEL = 'WARN';
			const confirmed = importConfirmation(superadmin);
			const folder = mkdtempSync(join(tmpdir(), 'dumpfire-mfa-import-'));
			folders.push(folder);
			vi.spyOn(process, 'cwd').mockReturnValue(folder);
			const lines: string[] = [];
			const listen = (line: unknown) => {
				lines.push(String(line));
			};
			vi.spyOn(console, 'error').mockImplementation(listen);
			vi.spyOn(console, 'warn').mockImplementation(listen);
			vi.spyOn(console, 'log').mockImplementation(listen);

			const response = await api('POST', '/api/admin/import?outside=keep', {
				user: superadmin,
				headers: { 'content-type': 'application/octet-stream', ...confirmed },
				body: bytes
			});
			return { response, lines };
		}

		it('T59: with a factor in the restored data, names each account without one, in the answer, its mfaWithoutFactor and a WARN line', async () => {
			const chief = makeUser({ role: 'superadmin', username: 'chief' });
			enrolled('enrolled');
			makeUser({ username: 'without' });
			const bytes = generateBackupData();

			const { response, lines } = await importing(chief, bytes);

			const sentence =
				'2 account(s) have no second factor after this restore and each needs its two-step sign-in reset before it can ' +
				'sign in: chief, without. See docs/admin-guide.md, Restoring from Backup.';
			expect(response.status).toBe(200);
			expect(response.body.message).toContain(sentence);
			expect(response.body.mfaWithoutFactor).toBe(sentence);
			expect(lines.filter((line) => line.includes('[WARN] [IMPORT]') && line.endsWith(sentence))).toHaveLength(1);
		});

		it('T60: when no account has a factor, says nothing of second factors and has no mfaWithoutFactor', async () => {
			const chief = makeUser({ role: 'superadmin', username: 'chief' });
			makeUser({ username: 'without' });
			const bytes = generateBackupData();

			const { response, lines } = await importing(chief, bytes);

			expect(response.status).toBe(200);
			expect(response.body.message).not.toContain('second factor');
			expect(response.body).not.toHaveProperty('mfaWithoutFactor');
			expect(lines.some((line) => line.includes('second factor'))).toBe(false);
		});
	});
});
