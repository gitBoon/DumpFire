/**
 * The secrets of two-step sign-in, without a database row (card 2768): TOTP
 * codes (RFC 6238 over RFC 4226), recovery codes and their account-bound
 * hashes, the key derivations and AES-256-GCM sealing, the MFA key file's
 * loader, and the start-up verdict on a key.
 *
 * The loader's own tests use a scratch folder under the temp folder each,
 * removed after every test: no test makes or reads an mfa.key in the
 * repository. Everything else uses keys made in the test. The process's own
 * key, under DB_PATH=:memory: and MFA_KEY_FILE='', is written nowhere.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { hotp, matchingStep, newTotpSecret, stepAt } from '$lib/server/totp';
import { RECOVERY_ALPHABET, canonicalRecoveryCode, newRecoveryCodes, recoveryCodeHash } from '$lib/server/recovery-codes';
import { factorAad, newFactorUid, openSealed, sealWith } from '$lib/server/mfa-crypto';
import {
	keyFromBytes,
	loadMfaKey,
	mfaKeyLoad,
	mfaStartVerdict,
	type FactorAtStart,
	type KeyLoad,
	type MfaKey
} from '$lib/server/mfa-key';

/** The RFC 4226 and RFC 6238 SHA-1 test secret. */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

const POSIX = process.platform !== 'win32';

describe('totp.ts', () => {
	it('T1: gives the RFC 4226 Appendix D codes, and with 8 digits the RFC 6238 Appendix B SHA-1 codes', () => {
		const rfc4226 = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
		expect(rfc4226.map((_, counter) => hotp(RFC_SECRET, counter))).toEqual(rfc4226);

		const rfc6238: [number, string][] = [
			[59, '94287082'],
			[1111111109, '07081804'],
			[1111111111, '14050471'],
			[1234567890, '89005924'],
			[2000000000, '69279037'],
			[20000000000, '65353130']
		];
		for (const [seconds, code] of rfc6238) expect(hotp(RFC_SECRET, stepAt(seconds * 1000), 8), String(seconds)).toBe(code);
	});

	const NOW = 1_762_300_015_000;
	const step = stepAt(NOW);

	it("T2: accepts the current step's code, typed with a space inside, and answers that step; a new secret is 20 bytes", () => {
		const code = hotp(RFC_SECRET, step);
		expect(matchingStep(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, NOW)).toBe(step);
		expect(matchingStep(RFC_SECRET, code, NOW)).toBe(step);
		expect(newTotpSecret()).toHaveLength(20);
	});

	it("T3: accepts the previous step's code and answers its step", () => {
		expect(matchingStep(RFC_SECRET, hotp(RFC_SECRET, step - 1), NOW)).toBe(step - 1);
	});

	it("T4: refuses the next step's code and the code of two steps back", () => {
		expect(matchingStep(RFC_SECRET, hotp(RFC_SECRET, step + 1), NOW)).toBeNull();
		expect(matchingStep(RFC_SECRET, hotp(RFC_SECRET, step - 2), NOW)).toBeNull();
	});

	it('T5: refuses five digits, seven digits, letters and an empty string', () => {
		const code = hotp(RFC_SECRET, step);
		for (const typed of [code.slice(0, 5), `${code}0`, 'abcdef', '']) {
			expect(matchingStep(RFC_SECRET, typed, NOW), JSON.stringify(typed)).toBeNull();
		}
	});

	it('T5b: answers null, without throwing, for a code that is not a string (a number, null, an array, an object)', () => {
		const code = hotp(RFC_SECRET, step);
		for (const given of [Number(code), null, undefined, [code], { code }]) {
			expect(matchingStep(RFC_SECRET, given, NOW), JSON.stringify(given)).toBeNull();
		}
	});
});

describe('recovery-codes.ts', () => {
	const SHOWN = '01AB-CD10-EFGH-JK01';

	it('T6: makes ten distinct codes, each XXXX-XXXX-XXXX-XXXX from the alphabet', () => {
		const codes = newRecoveryCodes();
		const letter = `[${RECOVERY_ALPHABET}]`;
		const form = new RegExp(`^${letter}{4}-${letter}{4}-${letter}{4}-${letter}{4}$`);
		expect(codes).toHaveLength(10);
		expect(new Set(codes).size).toBe(10);
		for (const code of codes) expect(code).toMatch(form);
	});

	it('T7: reads a code typed in lower case, without hyphens, with spaces, and with O, I and L as the code shown', () => {
		const canonical = canonicalRecoveryCode(SHOWN);
		expect(canonical).toBe('01ABCD10EFGHJK01');
		for (const typed of ['01ab-cd10-efgh-jk01', '01ABCD10EFGHJK01', '01AB CD10 EFGH JK01', ' 01AB - CD10-EFGH-JK01 ', 'OIAB-CDLO-EFGH-JKOl']) {
			expect(canonicalRecoveryCode(typed), typed).toBe(canonical);
		}
	});

	it('T8: reads fifteen or seventeen characters, a U, or punctuation as no code', () => {
		for (const typed of ['01ABCD10EFGHJK0', '01ABCD10EFGHJK011', '01ABCD10EFGHJKU1', '01AB.CD10.EFGH.JK01', '01AB_CD10-EFGH-JK01']) {
			expect(canonicalRecoveryCode(typed), typed).toBeNull();
		}
	});

	it('T9: hashes a code as SHA-256 of dumpfire-recovery-v1:<id>:<code>, so one code hashes differently for two accounts', () => {
		const canonical = '01ABCD10EFGHJK01';
		expect(recoveryCodeHash(7, canonical)).toBe(
			createHash('sha256').update(`dumpfire-recovery-v1:7:${canonical}`).digest('hex')
		);
		expect(recoveryCodeHash(7, canonical)).not.toBe(recoveryCodeHash(8, canonical));
	});
});

describe('mfa-crypto.ts and the key derivations', () => {
	/** A file key of the bytes 0 to 31. */
	const FILE_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

	it('T10: derives pinned values from a fixed key, and a pinned ciphertext opens under the derived key and not the raw one', () => {
		const key = keyFromBytes(FILE_KEY);
		expect(key.id).toBe('a8b674d849ff1f39');
		expect(key.check).toBe('20a5c12654936afd8d6e80dc4abeb1cfd9924dbb38096b28d54261d23b056e30');
		expect(key.encryptionKey.toString('hex')).toBe('965f0eeeb8addef885b4cab4feb161d6c82e2ff6528c90c4d4fc8c2b123dabdb');
		expect(Buffer.isBuffer(key.encryptionKey)).toBe(true);

		const pinned = { nonce: 'oKGio6Slpqeoqaqr', ciphertext: 'BK5XGE/m/Wj/FDamd0qK3FHcBDhDFK9wYoN2y9USmH4tcTfY' };
		const aad = 'mfa-factor:7:00112233445566778899aabbccddeeff';
		expect(openSealed(key, pinned, aad)?.toString('ascii')).toBe('12345678901234567890');
		expect(openSealed({ ...key, encryptionKey: FILE_KEY }, pinned, aad)).toBeNull();
	});

	it('T11: opens what it sealed with the same additional data; two seals differ; the seal names the key', () => {
		const key = keyFromBytes(randomBytes(32));
		const secret = newTotpSecret();
		const aad = factorAad(3, newFactorUid());

		const first = sealWith(key, secret, aad);
		const second = sealWith(key, secret, aad);
		expect(openSealed(key, first, aad)).toEqual(secret);
		expect(openSealed(key, second, aad)).toEqual(secret);
		expect(first.nonce).not.toBe(second.nonce);
		expect(first.ciphertext).not.toBe(second.ciphertext);
		expect(first.keyId).toBe(key.id);
	});

	it('T12: opens nothing under another factor_uid or user id, with a tag byte changed, or from 16 bytes', () => {
		const key = keyFromBytes(randomBytes(32));
		const uid = newFactorUid();
		const sealed = sealWith(key, newTotpSecret(), factorAad(3, uid));

		expect(openSealed(key, sealed, factorAad(3, newFactorUid()))).toBeNull();
		expect(openSealed(key, sealed, factorAad(4, uid))).toBeNull();

		const body = Buffer.from(sealed.ciphertext, 'base64');
		const changed = Buffer.from(body);
		changed[changed.length - 1] ^= 0x01;
		expect(openSealed(key, { nonce: sealed.nonce, ciphertext: changed.toString('base64') }, factorAad(3, uid))).toBeNull();

		// Nothing sealed under this key and these data: the body is exactly a
		// valid 16-byte tag, which GCM would open to an empty secret. Only the
		// length guard refuses it.
		const empty = sealWith(key, Buffer.alloc(0), factorAad(3, uid));
		expect(Buffer.from(empty.ciphertext, 'base64')).toHaveLength(16);
		expect(openSealed(key, empty, factorAad(3, uid))).toBeNull();
	});
});

describe('loadMfaKey', () => {
	let scratch: string;
	/** A folder of its own for the database, inside the scratch folder. */
	let dbDir: string;
	let dbPath: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), 'dumpfire-mfa-key-'));
		dbDir = join(scratch, 'data');
		mkdirSync(dbDir);
		dbPath = join(dbDir, 'dumpfire.db');
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	/** A key file of `text` at `path`, its owner's alone. */
	const keyFile = (path: string, text: string) => {
		writeFileSync(path, text, { mode: 0o600 });
		return path;
	};
	const failed = (load: KeyLoad) => {
		expect(load.ok).toBe(false);
		return load.ok ? '' : load.problem;
	};
	const succeeded = (load: KeyLoad) => {
		if (!load.ok) throw new Error(`expected a key, got: ${load.problem}`);
		return load;
	};

	it('T13: with MFA_KEY_FILE unset and a database on disk, NODE_ENV production, unset or staging is a problem naming it', () => {
		for (const nodeEnv of ['production', undefined, 'staging']) {
			for (const keyFile of [undefined, '']) {
				expect(failed(loadMfaKey({ nodeEnv, keyFile, dbPath })), String(nodeEnv)).toMatch(/MFA_KEY_FILE must be set in production/);
			}
		}
		expect(readdirSync(dbDir)).toEqual([]);
	});

	it('T14: under the production rules, MFA_KEY_FILE naming a missing file is a problem, and no file is made', () => {
		const path = join(scratch, 'missing.key');
		expect(failed(loadMfaKey({ nodeEnv: 'production', keyFile: path, dbPath }))).toMatch(/MFA_KEY_FILE names no file/);
		expect(existsSync(path)).toBe(false);
		expect(readdirSync(scratch)).toEqual(['data']);
	});

	it('T15: loads a named file of 64 hex characters and a newline, outside the database folder', () => {
		const raw = randomBytes(32);
		const path = keyFile(join(scratch, 'secret.key'), `${raw.toString('hex')}\n`);

		const load = succeeded(loadMfaKey({ nodeEnv: 'production', keyFile: path, dbPath }));
		expect(load.key).toEqual(keyFromBytes(raw));
		expect(load.path).toBe(path);
		expect(load.made).toBe(false);
		expect(load.insideDatabaseDir).toBe(false);
		expect(load.warnings).toEqual([]);
	});

	it('T16: refuses 63 characters, or 64 that are not hex, and quotes none of the file in the problem', () => {
		const short = 'deadbeef'.repeat(8).slice(0, 63);
		const notHex = 'xyzw'.repeat(16);
		for (const text of [short, notHex]) {
			const path = keyFile(join(scratch, 'bad.key'), `${text}\n`);
			const problem = failed(loadMfaKey({ nodeEnv: 'production', keyFile: path, dbPath }));
			expect(problem).toMatch(/does not hold a key/);
			expect(problem).not.toContain(text.slice(0, 8));
			expect(problem).not.toContain(text.slice(-8));
		}
	});

	it('T17: refuses a folder at the named path, or a file over 4 KiB', () => {
		const folder = join(scratch, 'a-folder');
		mkdirSync(folder);
		expect(failed(loadMfaKey({ nodeEnv: 'production', keyFile: folder, dbPath }))).toMatch(/not a regular file/);

		const big = keyFile(join(scratch, 'big.key'), `${randomBytes(32).toString('hex')}\n${' '.repeat(4096)}`);
		expect(failed(loadMfaKey({ nodeEnv: 'production', keyFile: big, dbPath }))).toMatch(/larger than 4096 bytes/);
	});

	it.skipIf(!POSIX)('T17b: refuses a FIFO at the named path as not a regular file, without waiting for a writer', () => {
		const fifo = join(scratch, 'fifo.key');
		execFileSync('mkfifo', ['-m', '600', fifo]);
		expect(failed(loadMfaKey({ nodeEnv: 'production', keyFile: fifo, dbPath }))).toMatch(/not a regular file/);
	});

	it.skipIf(!POSIX)('T18: refuses a key file its group or everyone can write', () => {
		for (const mode of [0o620, 0o602]) {
			const path = keyFile(join(scratch, `writable-${mode.toString(8)}.key`), `${randomBytes(32).toString('hex')}\n`);
			chmodSync(path, mode);
			expect(failed(loadMfaKey({ nodeEnv: 'production', keyFile: path, dbPath })), mode.toString(8)).toMatch(/can be written/);
		}
	});

	it.skipIf(!POSIX)('T19: loads a key file everyone can read (0444), with a warning', () => {
		const path = keyFile(join(scratch, 'secret.key'), `${randomBytes(32).toString('hex')}\n`);
		chmodSync(path, 0o444);
		const load = succeeded(loadMfaKey({ nodeEnv: 'production', keyFile: path, dbPath }));
		expect(load.warnings).toHaveLength(1);
		expect(load.warnings[0]).toMatch(/can be read by its group or by everyone/);
	});

	it('T20: under test with no MFA_KEY_FILE, makes mfa.key beside the database through a link, and reads it the next time', () => {
		const first = succeeded(loadMfaKey({ nodeEnv: 'test', keyFile: undefined, dbPath }));
		const path = join(dbDir, 'mfa.key');
		expect(first.path).toBe(path);
		expect(first.made).toBe(true);
		expect(first.insideDatabaseDir).toBe(false);
		expect(readFileSync(path, 'utf8')).toMatch(/^[0-9a-f]{64}\n$/);
		if (POSIX) expect(statSync(path).mode & 0o777).toBe(0o600);
		// No temporary file is left.
		expect(readdirSync(dbDir)).toEqual(['mfa.key']);

		const second = succeeded(loadMfaKey({ nodeEnv: 'test', keyFile: undefined, dbPath }));
		expect(second.made).toBe(false);
		expect(second.key).toEqual(first.key);
	});

	it("T21: reads the other instance's key when it linked the file first, and leaves no temporary file", () => {
		const theirs = randomBytes(32);
		const load = succeeded(
			loadMfaKey({
				nodeEnv: 'test',
				keyFile: undefined,
				dbPath,
				link: (from, to) => {
					writeFileSync(to, `${theirs.toString('hex')}\n`, { mode: 0o600 });
					linkSync(from, to);
				}
			})
		);
		expect(load.made).toBe(false);
		expect(load.key).toEqual(keyFromBytes(theirs));
		expect(readdirSync(dbDir)).toEqual(['mfa.key']);
	});

	it('T22: under :memory: with no MFA_KEY_FILE, whatever NODE_ENV, loads a key of its own and writes no file; mfaKeyLoad keeps it', () => {
		// A development server makes <cwd>/mfa.key (git-ignored), so it may be
		// there: what is asserted is that this test neither makes nor touches it.
		const beforeKey = (folder: string) => {
			const path = join(folder, 'mfa.key');
			return existsSync(path) ? { there: true, mtimeMs: statSync(path).mtimeMs } : { there: false, mtimeMs: null };
		};
		const cwdBefore = beforeKey(process.cwd());
		const tmpBefore = beforeKey(tmpdir());
		for (const nodeEnv of ['production', undefined, 'staging', 'test', 'development']) {
			const load = succeeded(loadMfaKey({ nodeEnv, keyFile: undefined, dbPath: ':memory:' }));
			expect(load.path).toBeNull();
			expect(load.made).toBe(false);
		}
		expect(beforeKey(process.cwd())).toEqual(cwdBefore);
		expect(beforeKey(tmpdir())).toEqual(tmpBefore);

		const once = succeeded(mfaKeyLoad());
		expect(once.path).toBeNull();
		expect(succeeded(mfaKeyLoad()).key).toBe(once.key);
	});

	it("T29: warns of a named key file inside the database's folder, reached by a relative path or through a link", () => {
		const inside = keyFile(join(dbDir, 'inside.key'), `${randomBytes(32).toString('hex')}\n`);

		const byRelative = succeeded(
			loadMfaKey({ nodeEnv: 'production', keyFile: relative(process.cwd(), inside), dbPath })
		);
		expect(byRelative.insideDatabaseDir).toBe(true);
		const verdict = mfaStartVerdict({ load: byRelative, factors: [], storedCheck: null });
		expect(verdict.refuse).toBeNull();
		if (verdict.refuse === null) {
			expect(verdict.warnings).toEqual([
				`The MFA key file ${inside} is inside the database's directory: a copy of that volume carries both the ` +
					'secrets and their key. Move it, see docs/deployment.md'
			]);
		}

		// The database reached through a link to its folder (a junction on Windows).
		const linked = join(scratch, 'linked');
		symlinkSync(dbDir, linked, 'junction');
		const throughLink = succeeded(loadMfaKey({ nodeEnv: 'production', keyFile: inside, dbPath: join(linked, 'dumpfire.db') }));
		expect(throughLink.insideDatabaseDir).toBe(true);
	});
});

describe('mfaStartVerdict', () => {
	const key = keyFromBytes(randomBytes(32));
	const otherKey = keyFromBytes(randomBytes(32));
	const loaded: KeyLoad = { ok: true, key, path: null, made: false, insideDatabaseDir: false, warnings: [] };

	/** A factor row as the start-up check reads it, sealed under `by` (a 20-byte secret). */
	const factor = (id: number, userId: number, by: MfaKey): FactorAtStart => {
		const factorUid = newFactorUid();
		const sealed = sealWith(by, newTotpSecret(), factorAad(userId, factorUid));
		return { id, userId, factorUid, keyId: sealed.keyId, ciphertext: sealed.ciphertext, nonce: sealed.nonce };
	};

	it('T23: refuses a key that did not load, with factors or without', () => {
		const load: KeyLoad = { ok: false, problem: 'MFA_KEY_FILE must be set in production.' };
		expect(mfaStartVerdict({ load, factors: [], storedCheck: null })).toEqual({ refuse: 'MFA_KEY_FILE must be set in production.' });
		expect(mfaStartVerdict({ load, factors: [factor(1, 1, key)], storedCheck: key.check })).toEqual({
			refuse: 'MFA_KEY_FILE must be set in production.'
		});
	});

	it("T24: refuses when factors are stored and the stored check is another key's", () => {
		const verdict = mfaStartVerdict({ load: loaded, factors: [factor(1, 1, key)], storedCheck: otherKey.check });
		expect(verdict.refuse).toMatch(/does not match the one the second factors were made with/);
	});

	it('T25: with no stored check and one factor of two opening, starts, records the check and names the other', () => {
		const opens = factor(1, 1, key);
		// Sealed with this key, for another account: it does not open as this one's.
		const misplaced = { ...factor(2, 5, key), userId: 6 };
		expect(mfaStartVerdict({ load: loaded, factors: [opens, misplaced], storedCheck: null })).toEqual({
			refuse: null,
			recordCheck: key.check,
			unreadable: [{ id: 2, userId: 6 }],
			warnings: []
		});
	});

	it('T26: with no stored check and no factor opening, refuses', () => {
		const verdict = mfaStartVerdict({ load: loaded, factors: [factor(1, 1, otherKey), factor(2, 2, otherKey)], storedCheck: null });
		expect(verdict.refuse).toMatch(/None of the 2 second factor\(s\) opens with this MFA key/);
	});

	it("T27: with the check matching, starts, names a factor of another key id, and records nothing", () => {
		expect(
			mfaStartVerdict({ load: loaded, factors: [factor(1, 1, key), factor(2, 3, otherKey)], storedCheck: key.check })
		).toEqual({ refuse: null, recordCheck: null, unreadable: [{ id: 2, userId: 3 }], warnings: [] });
	});

	it("T28: with no factors and another key's check stored, starts and records nothing", () => {
		expect(mfaStartVerdict({ load: loaded, factors: [], storedCheck: otherKey.check })).toEqual({
			refuse: null,
			recordCheck: null,
			unreadable: [],
			warnings: []
		});
	});
});
