/**
 * mfa-key.ts — the key that protects authenticator secrets, and the verdict
 * on it at start (card 2768).
 *
 * The key is 32 bytes kept in a file outside the database and outside every
 * backup, named by `MFA_KEY_FILE`, as 64 hexadecimal characters. Three keys
 * are derived from it, so the file's bytes are never used under two
 * primitives: the AES-256-GCM key that seals secrets (HKDF-SHA256), the key
 * check stored in `settings.mfa_key_check` (HMAC-SHA256), and the key id each
 * sealed secret names (the first 16 hex of another HMAC-SHA256). Nothing else
 * of the key is kept, and none of it is ever written to a log, a message, a
 * row or a backup.
 *
 * Wherever the production rules apply (`NODE_ENV` anything but `development`
 * or `test`, on a database that is not in memory) a key is never made:
 * `MFA_KEY_FILE` must name an existing regular file, and without one the
 * server will not start. In development and under test a missing key is made
 * beside the database (`mfa.key`) or at the named path, through a temporary
 * file and a hard link, so that no reader sees half a key. An in-memory
 * database with no `MFA_KEY_FILE` (the tests) gets a key of this process's
 * own, written nowhere.
 *
 * Nothing is read at import: `vite build` runs under `NODE_ENV=production`
 * and imports server modules. The first call of `mfaKeyLoad`, which
 * hooks.server.ts makes through `checkMfaKeyAtStart`, reads the file, and its
 * answer is kept for the life of the process.
 */
import { closeSync, constants, fstatSync, linkSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { getDbPath } from './db';
import { factorAad, openSealed } from './mfa-crypto';
import { TOTP_SECRET_BYTES } from './totp';

export const MFA_KEY_CHECK_SETTING = 'mfa_key_check';
export const MFA_KEY_FILE_NAME = 'mfa.key';
export const MFA_KEY_FILE_MAX_BYTES = 4096;

/** What the rest of the code holds: never the file's bytes themselves. */
export type MfaKey = { id: string; check: string; encryptionKey: Buffer };

export type KeyLoad =
	| { ok: true; key: MfaKey; path: string | null; made: boolean; insideDatabaseDir: boolean; warnings: string[] }
	| { ok: false; problem: string };

const SEE = 'See docs/deployment.md, The Key That Protects Authenticator Secrets.';
const KEY_TEXT = /^[0-9a-f]{64}$/i;

/** The three keys derived from the file's 32 bytes. */
export function keyFromBytes(raw: Buffer): MfaKey {
	return {
		id: createHmac('sha256', raw).update('dumpfire-mfa-key-id').digest('hex').slice(0, 16),
		check: createHmac('sha256', raw).update('dumpfire-mfa-check').digest('hex'),
		encryptionKey: Buffer.from(hkdfSync('sha256', raw, Buffer.alloc(0), 'dumpfire mfa aes-256-gcm v1', 32))
	};
}

const isMemory = (dbPath: string) => dbPath === ':memory:' || dbPath === '';

/**
 * Whether the production rules apply: unless `NODE_ENV` is `development` or
 * `test`, or the database is in memory. Unset, `production` and any other
 * value (`staging`, a misspelling) are production: an unset variable must
 * fail closed.
 */
export function productionRules(nodeEnv: string | undefined, dbPath: string): boolean {
	return !(nodeEnv === 'development' || nodeEnv === 'test' || isMemory(dbPath));
}

const codeOf = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code ?? 'an unknown error';

type FileRead = { kind: 'missing' } | { kind: 'problem'; problem: string } | { kind: 'ok'; raw: Buffer; warnings: string[] };

/**
 * Read the key file at `path`, through one descriptor: a regular file of at
 * most 4 KiB; on POSIX not writable by its group or by everyone (refused) and
 * not readable by them (warned); holding 64 hexadecimal characters with
 * nothing but whitespace around them. No problem quotes what the file holds.
 */
function readKeyFile(path: string): FileRead {
	let fd: number;
	try {
		// On POSIX opened without blocking, so that a FIFO (or another file that
		// would wait for a writer) cannot hang the start: the fstat below then
		// refuses it as not a regular file. A regular file reads as it would.
		fd = openSync(path, process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK);
	} catch (err) {
		const code = codeOf(err);
		if (code === 'ENOENT') return { kind: 'missing' };
		if (code === 'EISDIR') return { kind: 'problem', problem: `The MFA key file ${path} is not a regular file. ${SEE}` };
		return { kind: 'problem', problem: `The MFA key file ${path} could not be read (${code}). ${SEE}` };
	}

	const held = Buffer.alloc(MFA_KEY_FILE_MAX_BYTES + 1);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return { kind: 'problem', problem: `The MFA key file ${path} is not a regular file. ${SEE}` };
		if (stat.size > MFA_KEY_FILE_MAX_BYTES) {
			return {
				kind: 'problem',
				problem: `The MFA key file ${path} is larger than ${MFA_KEY_FILE_MAX_BYTES} bytes, so it is not a key file. ${SEE}`
			};
		}

		const warnings: string[] = [];
		if (process.platform !== 'win32') {
			if (stat.mode & 0o022) {
				return {
					kind: 'problem',
					problem:
						`The MFA key file ${path} can be written by its group or by everyone, so it could be swapped for ` +
						`another key. Make it readable and writable by its owner alone (chmod 600). ${SEE}`
				};
			}
			if (stat.mode & 0o044) {
				warnings.push(
					`The MFA key file ${path} can be read by its group or by everyone. Make it readable by its owner ` +
						`alone (chmod 600) unless it is mounted as a read-only secret. ${SEE}`
				);
			}
		}

		let length = 0;
		while (length < held.length) {
			const n = readSync(fd, held, length, held.length - length, null);
			if (n === 0) break;
			length += n;
		}
		if (length > MFA_KEY_FILE_MAX_BYTES) {
			return {
				kind: 'problem',
				problem: `The MFA key file ${path} is larger than ${MFA_KEY_FILE_MAX_BYTES} bytes, so it is not a key file. ${SEE}`
			};
		}

		const text = held.subarray(0, length).toString('utf8').trim();
		if (!KEY_TEXT.test(text)) {
			return {
				kind: 'problem',
				problem:
					`The MFA key file ${path} does not hold a key: it must hold 64 hexadecimal characters and nothing ` +
					`else (openssl rand -hex 32). ${SEE}`
			};
		}
		return { kind: 'ok', raw: Buffer.from(text, 'hex'), warnings };
	} catch (err) {
		return { kind: 'problem', problem: `The MFA key file ${path} could not be read (${codeOf(err)}). ${SEE}` };
	} finally {
		held.fill(0);
		try {
			closeSync(fd);
		} catch {
			// Closed already, or never to be: nothing more is read from it.
		}
	}
}

type Made = { kind: 'made'; raw: Buffer } | FileRead;

/**
 * Make a key at `path`: written to a temporary file of its own in the same
 * folder (created only if absent, owner-only), then hard-linked into place,
 * which fails with EEXIST if another instance got there first. The temporary
 * file is removed in every case. On EEXIST the other instance's key is read.
 */
function makeKeyFile(path: string, random: () => Buffer, link: (from: string, to: string) => void): Made {
	const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
	const raw = random();
	const text = `${raw.toString('hex')}\n`;
	let wrote = false;
	try {
		writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
		wrote = true;
		link(temporary, path);
		return { kind: 'made', raw };
	} catch (err) {
		raw.fill(0);
		if (wrote && codeOf(err) === 'EEXIST') return readKeyFile(path);
		return { kind: 'problem', problem: `The MFA key file ${path} could not be made (${codeOf(err)}). ${SEE}` };
	} finally {
		if (wrote) {
			try {
				unlinkSync(temporary);
			} catch {
				// Gone already.
			}
		}
	}
}

/**
 * Whether the key file is inside the folder the database is in, both paths
 * resolved through their links. Inside unless the path from the folder to
 * the file leaves it.
 */
function insideFolderOf(dbPath: string, path: string): boolean {
	try {
		const folder = realpathSync(dirname(resolve(dbPath)));
		const file = realpathSync(path);
		const rel = relative(folder, file);
		return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
	} catch {
		return false;
	}
}

const loaded = (
	raw: Buffer,
	path: string | null,
	made: boolean,
	insideDatabaseDir: boolean,
	warnings: string[]
): KeyLoad => {
	const key = keyFromBytes(raw);
	raw.fill(0);
	return { ok: true, key, path, made, insideDatabaseDir, warnings };
};

/**
 * Load the key by the rules above, from what is given: never from the
 * environment. `random` makes a new key's 32 bytes, and `link` puts a new key
 * file in place; both are seams for the tests.
 */
export function loadMfaKey(input: {
	nodeEnv: string | undefined;
	keyFile: string | undefined;
	dbPath: string;
	random?: () => Buffer;
	link?: (from: string, to: string) => void;
}): KeyLoad {
	const random = input.random ?? (() => randomBytes(32));
	const link = input.link ?? linkSync;
	const production = productionRules(input.nodeEnv, input.dbPath);
	const named = typeof input.keyFile === 'string' && input.keyFile !== '';

	if (!named && isMemory(input.dbPath)) return loaded(random(), null, false, false, []);
	if (!named && production) {
		return {
			ok: false,
			problem:
				'MFA_KEY_FILE must be set in production: it names the file holding the key that protects ' +
				`authenticator secrets, 64 hexadecimal characters. ${SEE}`
		};
	}

	const path = named ? resolve(input.keyFile!) : join(dirname(resolve(input.dbPath)), MFA_KEY_FILE_NAME);
	let read: Made = readKeyFile(path);
	if (read.kind === 'missing') {
		if (production) {
			return {
				ok: false,
				problem: `MFA_KEY_FILE names no file (${path}); the server never makes a key in production. ${SEE}`
			};
		}
		read = makeKeyFile(path, random, link);
	}
	if (read.kind === 'missing') return { ok: false, problem: `The MFA key file ${path} is not there. ${SEE}` };
	if (read.kind === 'problem') return { ok: false, problem: read.problem };

	const inside = named && !isMemory(input.dbPath) && insideFolderOf(input.dbPath, path);
	return read.kind === 'made'
		? loaded(read.raw, path, true, inside, [])
		: loaded(read.raw, path, false, inside, read.warnings);
}

let cached: KeyLoad | null = null;

/** This process's key, loaded on the first call from the environment and kept. */
export function mfaKeyLoad(): KeyLoad {
	cached ??= loadMfaKey({ nodeEnv: process.env.NODE_ENV, keyFile: process.env.MFA_KEY_FILE, dbPath: getDbPath() });
	return cached;
}

/** This process's key, or null when it did not load. */
export function currentMfaKey(): MfaKey | null {
	const load = mfaKeyLoad();
	return load.ok ? load.key : null;
}

/** A factor as the start-up check reads it. */
export type FactorAtStart = { id: number; userId: number; factorUid: string; keyId: string; ciphertext: string; nonce: string };

export type MfaStartVerdict =
	| { refuse: string }
	| { refuse: null; recordCheck: string | null; unreadable: { id: number; userId: number }[]; warnings: string[] };

/** Whether a factor opens with `key` to a 20-byte secret. What opened is zeroed at once. */
function opensWith(key: MfaKey, factor: FactorAtStart): boolean {
	if (factor.keyId !== key.id) return false;
	const opened = openSealed(key, factor, factorAad(factor.userId, factor.factorUid));
	if (opened === null) return false;
	const whole = opened.length === TOTP_SECRET_BYTES;
	opened.fill(0);
	return whole;
}

/**
 * Whether the server may start with the key it loaded, and what to record and
 * say if it may. With factors stored, a key check from another key refuses;
 * with no check stored, every factor is tried, and the check is recorded if
 * any opens and the start refused if none does. With a check that matches,
 * every factor that does not open is named. With no factors there is nothing
 * to compare, and nothing is recorded: the first factor written records it.
 */
export function mfaStartVerdict(input: {
	load: KeyLoad;
	factors: readonly FactorAtStart[];
	storedCheck: string | null;
}): MfaStartVerdict {
	const { load, factors, storedCheck } = input;
	if (!load.ok) return { refuse: load.problem };

	const key = load.key;
	const warnings = [...load.warnings];
	if (load.insideDatabaseDir && load.path !== null) {
		warnings.push(
			`The MFA key file ${load.path} is inside the database's directory: a copy of that volume carries both the ` +
				'secrets and their key. Move it, see docs/deployment.md'
		);
	}
	if (factors.length === 0) return { refuse: null, recordCheck: null, unreadable: [], warnings };

	if (storedCheck !== null && storedCheck !== key.check) {
		return {
			refuse:
				"The MFA key does not match the one the second factors were made with (a volume swap, a moved DB_PATH, " +
				`a restore by hand, or the wrong key file). ${SEE}`
		};
	}

	const unreadable = factors.filter((factor) => !opensWith(key, factor)).map(({ id, userId }) => ({ id, userId }));
	if (storedCheck === null) {
		if (unreadable.length === factors.length) {
			return {
				refuse:
					`None of the ${factors.length} second factor(s) opens with this MFA key, and no key check is stored: ` +
					'the key does not match the one they were made with (a volume swap, a moved DB_PATH, a restore by ' +
					`hand, or the wrong key file). ${SEE}`
			};
		}
		return { refuse: null, recordCheck: key.check, unreadable, warnings };
	}
	return { refuse: null, recordCheck: null, unreadable, warnings };
}
