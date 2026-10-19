/**
 * An SFTP destination's host key, confirmed once and checked at every connect
 * (card 2250).
 *
 * An SFTP destination connected to whatever answered for its host: ssh2
 * accepts any host key when it is given no verifier, and the password, or a
 * signature made with the private key, is sent once the handshake completes,
 * then the backup itself. Now:
 *
 *   - a Test of a destination with no confirmed key connects with a verifier
 *     that records the key it is handed and answers false, so the connection
 *     ends inside the key exchange, with no password, private key or
 *     passphrase in its configuration at all, and shows the key (decision 2,
 *     R6);
 *   - with a key confirmed, every connect pins the key's type and refuses any
 *     other fingerprint before a credential is sent (decisions 4 and 5), and a
 *     server that no longer offers a key of the confirmed type is refused by
 *     name (R3);
 *   - an upload, a listing or a delete of a destination with no confirmed key
 *     opens no connection however it is reached (R7), and a backup run does
 *     not try one (decision 6).
 *
 * `ssh2-sftp-client` is replaced by a stand-in (`server`) that does what ssh2
 * does with the configuration it is handed: a host key format it is pinned to
 * that the server does not offer ends the handshake before the verifier is
 * asked; a verifier is handed the server's raw key blob, made by ssh2's own
 * `utils.generateKeyPairSync`, and its `false` ends the connection; only then
 * is the caller authenticated. No connection is made. The fingerprints the
 * tests expect are worked out here, as OpenSSH prints them, not by the code
 * under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { utils, type ParsedKey } from 'ssh2';
import { runBackup, saveBackupConfig } from '$lib/server/backup';
import {
	HostKeyMismatch,
	HostKeyNotConfirmed,
	HostKeySignatureFailed,
	HostKeyTypeNotOffered,
	SftpDestination,
	type SftpDestinationConfig
} from '$lib/server/backup-destinations';
import { SECRET_MASK } from '$lib/server/backup-secrets';
import { sqlite } from '$lib/server/db';
import { escapeHtml } from '$lib/escape-html';
import { api } from './helpers/api';
import { effects } from './helpers/effects';
import { makeSmtp, makeUser, resetDb } from './helpers/fixtures';

/** The SFTP server the stand-in plays, and what was done to it. */
const server = vi.hoisted(() => ({
	/** The raw host key blob it presents. */
	key: Buffer.alloc(0) as Buffer,
	/** The host key formats it offers. */
	offers: [] as string[],
	/** Every configuration a connect was handed. */
	configs: [] as Record<string, unknown>[],
	/** How many times a verifier was asked. */
	verified: 0,
	/**
	 * Whether the server presents a key it cannot sign with: a replay of the
	 * real server's public key, whose signature over the exchange fails after
	 * the verifier said yes (the card 2250 review's S4).
	 */
	forged: false,
	/** The configurations that got past the handshake, and so were used to authenticate. */
	authenticated: [] as Record<string, unknown>[],
	/** Directories made, files put, listings and deletes. */
	made: [] as string[],
	put: [] as string[],
	listed: 0,
	deleted: [] as string[]
}));

vi.mock('ssh2-sftp-client', () => ({
	default: class {
		async connect(config: Record<string, unknown>) {
			server.configs.push({ ...config });
			// ssh2's algorithm negotiation comes before the key is presented.
			const pinned = (config.algorithms as { serverHostKey?: string[] } | undefined)?.serverHostKey;
			if (Array.isArray(pinned) && !pinned.some((format) => server.offers.includes(format))) {
				throw new Error('Handshake failed: no matching host key format');
			}
			if (typeof config.hostVerifier === 'function') {
				server.verified++;
				const answer = (config.hostVerifier as (key: Buffer, verify: (ok: boolean) => void) => boolean | undefined)(server.key, () => {});
				if (answer === false) throw new Error('Host denied (verification failed)');
				// ssh2 checks the signature after the verifier, and ends the handshake if it fails.
				if (server.forged) throw new Error('Handshake failed: signature verification failed');
			}
			// No verifier: accepted by default, as ssh2 does. The credential goes now.
			server.authenticated.push({ ...config });
			return {};
		}
		async exists() {
			return false;
		}
		async mkdir(path: string) {
			server.made.push(path);
		}
		async put(_data: Buffer, path: string) {
			server.put.push(path);
		}
		async list() {
			server.listed++;
			return [];
		}
		async delete(path: string) {
			server.deleted.push(path);
		}
		async end() {}
	}
}));

/** A host key's raw blob, as ssh2 hands it to a verifier. */
function blobOf(type: 'ed25519' | 'ecdsa' | 'rsa', bits?: number): Buffer {
	const pair = utils.generateKeyPairSync(type as 'ed25519', bits ? ({ bits } as object) : {});
	return (utils.parseKey(pair.public) as ParsedKey).getPublicSSH();
}

/** A blob's fingerprint as `ssh-keygen -l` prints it: SHA256: and the unpadded base64 of its SHA-256. */
const fingerprint = (blob: Buffer) => `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;

const ED25519 = blobOf('ed25519');
const OTHER_ED25519 = blobOf('ed25519');
const RSA = blobOf('rsa', 2048);
const ECDSA_384 = blobOf('ecdsa', 384);

/** What each blob's type is offered as by a server that holds it. */
const OFFERED = new Map<Buffer, string[]>([
	[ED25519, ['ssh-ed25519']],
	[OTHER_ED25519, ['ssh-ed25519']],
	[RSA, ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']],
	[ECDSA_384, ['ecdsa-sha2-nistp384']]
]);

/** The server presents `blob`, and offers its type (or `offers`). */
function serve(blob: Buffer, offers: string[] = OFFERED.get(blob)!): void {
	server.key = blob;
	server.offers = offers;
}

const NAS: SftpDestinationConfig = {
	type: 'sftp',
	name: 'NAS',
	host: 'nas.example.test',
	port: 22,
	username: 'backup',
	password: 'nas-password-2250',
	remotePath: '/backups'
};

/** NAS with `blob`'s key confirmed, in the canonical form. */
const confirmed = (blob: Buffer, type: string, more: Partial<SftpDestinationConfig> = {}) =>
	({ ...NAS, hostKey: `${type} ${fingerprint(blob)}`, ...more }) as SftpDestinationConfig;

// Each host key failure says what happened in its first 40 characters, which
// is what Backup History shows of a message (the card 2250 review's S2).
const NOT_CONFIRMED =
	'SFTP host key not confirmed: nothing was sent to this destination. In Admin, Scheduled Backups, press Test on ' +
	'it and confirm the key it shows.';

/** Decision 2's words. */
const notConfirmedYet = (shown: string, file: string) =>
	`SFTP host key not confirmed: the server at nas.example.test:22 presented the host key ${shown}. Check it is ` +
	`the server's own (on the server: ssh-keygen -lf /etc/ssh/${file}) and confirm it. Nothing was sent to the server.`;

/** Decision 5's words. */
const mismatched = (presented: string, confirmedFingerprint: string) =>
	`SFTP host key refused: the server at nas.example.test:22 presented the host key ${presented}, not the confirmed ` +
	`${confirmedFingerprint}, so nothing was sent to it. If the server's key was changed on purpose, check the new ` +
	'key on the server and confirm it, typing the password or private key again; otherwise something else may be ' +
	'answering for the server.';

/** R3's words. */
const typeNotOffered = (type: string) =>
	`SFTP host key refused: the server at nas.example.test:22 no longer offers a host key of the confirmed type (${type}), so nothing ` +
	"was sent to it. If the server's keys were changed on purpose, clear the Host key or replace it with the " +
	"server's new key, typing the password or private key again, then press Test; otherwise something else may be " +
	'answering for the server.';

/** The review's S4 words: the confirmed key shown by a server that could not sign with it. */
const signatureFailed = () =>
	'SFTP host key refused: the server at nas.example.test:22 showed the confirmed key but could not prove it holds ' +
	'it — something on the network may be answering for it. Nothing was sent.';

/** The ERROR lines under BACKUP. */
const errorLines = () =>
	(sqlite.prepare("SELECT message FROM system_logs WHERE context = 'BACKUP' AND level = 'ERROR' ORDER BY id").all() as { message: string }[]).map(
		(row) => row.message
	);

/** The account each ERROR line under BACKUP is filed under (card 2253, slice 5: the Test's, under the superadmin who asked). */
const errorLinesFiledUnder = () =>
	(sqlite.prepare("SELECT user_id AS userId FROM system_logs WHERE context = 'BACKUP' AND level = 'ERROR' ORDER BY id").all() as { userId: number | null }[]).map(
		(row) => row.userId
	);

beforeEach(() => {
	resetDb();
	server.configs.length = 0;
	server.authenticated.length = 0;
	server.made.length = 0;
	server.put.length = 0;
	server.deleted.length = 0;
	server.verified = 0;
	server.forged = false;
	server.listed = 0;
	serve(ED25519);
	// An ERROR line is printed as well as kept.
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('a Test with no confirmed key (decision 2, R6)', () => {
	it('answers the key the server presented, sends nothing and makes no directory', async () => {
		const chief = makeUser({ username: 'chief', role: 'superadmin' });

		const res = await api('POST', '/api/admin/backup/test', { user: chief, body: NAS });

		const shown = `ssh-ed25519 ${fingerprint(ED25519)}`;
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: false, message: notConfirmedYet(shown, 'ssh_host_ed25519_key.pub'), hostKey: shown });
		expect(server.verified).toBe(1);
		expect(server.authenticated).toEqual([]);
		expect(server.made).toEqual([]);
		// Not a mismatch: no ERROR line.
		expect(errorLines()).toEqual([]);
	});

	it.each([
		['a password', { password: 'nas-password-2250' }],
		['a private key', { password: undefined, privateKey: 'a-stored-private-key' }],
		['a private key that does not parse, and a passphrase left on it', { password: '', privateKey: 'not a key at all', passphrase: 'left' }]
	])('puts no secret in the configuration, for a destination with %s', async (_case, secrets) => {
		const result = await new SftpDestination({ ...NAS, ...secrets } as SftpDestinationConfig).test();

		const shown = `ssh-ed25519 ${fingerprint(ED25519)}`;
		expect(result).toEqual({ success: false, message: notConfirmedYet(shown, 'ssh_host_ed25519_key.pub'), hostKey: shown });
		expect(server.configs).toHaveLength(1);
		expect(Object.keys(server.configs[0]).sort()).toEqual(['host', 'hostVerifier', 'port', 'readyTimeout', 'username']);
		expect(server.configs[0]).toMatchObject({ host: 'nas.example.test', port: 22, username: 'backup' });
	});

	it('names the server’s key file of the type presented', async () => {
		serve(RSA);
		const rsa = await new SftpDestination(NAS).test();
		expect(rsa).toEqual({
			success: false,
			message: notConfirmedYet(`ssh-rsa ${fingerprint(RSA)}`, 'ssh_host_rsa_key.pub'),
			hostKey: `ssh-rsa ${fingerprint(RSA)}`
		});

		serve(ECDSA_384);
		const ecdsa = await new SftpDestination({ ...NAS, port: null }).test();
		expect(ecdsa.message).toBe(notConfirmedYet(`ecdsa-sha2-nistp384 ${fingerprint(ECDSA_384)}`, 'ssh_host_ecdsa_key.pub'));
		expect(server.authenticated).toEqual([]);
	});
});

describe('a connect with the key confirmed (decision 4)', () => {
	it.each([
		['ssh-ed25519', ED25519, ['ssh-ed25519']],
		['ssh-rsa', RSA, ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']],
		['ecdsa-sha2-nistp384', ECDSA_384, ['ecdsa-sha2-nistp384']]
	])('pins %s and authenticates, for a Test and an upload', async (type, blob, pin) => {
		serve(blob);
		const destination = new SftpDestination(confirmed(blob, type));

		expect(await destination.test()).toEqual({ success: true, message: 'Connected to nas.example.test:22' });
		await destination.upload(Buffer.from('backup'), 'dumpfire-backup-1.db');

		expect(server.authenticated).toHaveLength(2);
		for (const config of server.authenticated) {
			expect(config.algorithms).toEqual({ serverHostKey: pin });
			expect(config.password).toBe('nas-password-2250');
		}
		expect(server.put).toEqual(['/backups/dumpfire-backup-1.db']);
	});

	it('lists and deletes with the key confirmed', async () => {
		const destination = new SftpDestination(confirmed(ED25519, 'ssh-ed25519'));

		expect(await destination.list()).toEqual([]);
		await destination.delete('dumpfire-backup-1.db');

		expect(server.listed).toBe(1);
		expect(server.deleted).toEqual(['/backups/dumpfire-backup-1.db']);
		expect(server.authenticated).toHaveLength(2);
	});
});

describe('a key that does not match (decision 5)', () => {
	it('is refused by a Test before any credential, answering both keys, with one ERROR line', async () => {
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		serve(OTHER_ED25519);
		const stored = `ssh-ed25519 ${fingerprint(ED25519)}`;
		const presented = `ssh-ed25519 ${fingerprint(OTHER_ED25519)}`;

		const res = await api('POST', '/api/admin/backup/test', { user: chief, body: confirmed(ED25519, 'ssh-ed25519') });

		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			success: false,
			message: mismatched(presented, fingerprint(ED25519)),
			hostKey: presented,
			confirmedHostKey: stored
		});
		expect(server.authenticated).toEqual([]);
		expect(server.made).toEqual([]);
		expect(errorLines()).toEqual([
			`SFTP host key mismatch for destination "NAS" at nas.example.test:22: presented ${fingerprint(OTHER_ED25519)}, ` +
				`confirmed ${fingerprint(ED25519)}. Nothing was sent.`
		]);
		expect(errorLinesFiledUnder()).toEqual([chief.id]);
	});

	it('is refused by an upload, a listing and a delete, as HostKeyMismatch', async () => {
		serve(OTHER_ED25519);
		const destination = new SftpDestination(confirmed(ED25519, 'ssh-ed25519'));
		const words = mismatched(`ssh-ed25519 ${fingerprint(OTHER_ED25519)}`, fingerprint(ED25519));

		for (const act of [() => destination.upload(Buffer.from('x'), 'f.db'), () => destination.list(), () => destination.delete('f.db')]) {
			const thrown = await act().then(
				() => null,
				(err: unknown) => err
			);
			expect(thrown).toBeInstanceOf(HostKeyMismatch);
			expect((thrown as Error).message).toBe(words);
		}
		expect(server.authenticated).toEqual([]);
		expect(server.put).toEqual([]);
	});
});

describe('a server that no longer offers a key of the confirmed type (R3)', () => {
	it('is refused by a Test before the verifier is asked, answering the confirmed key, with one ERROR line', async () => {
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		serve(RSA);
		const stored = `ssh-ed25519 ${fingerprint(ED25519)}`;

		const res = await api('POST', '/api/admin/backup/test', { user: chief, body: confirmed(ED25519, 'ssh-ed25519') });

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: false, message: typeNotOffered('ssh-ed25519'), confirmedHostKey: stored });
		expect(server.verified).toBe(0);
		expect(server.authenticated).toEqual([]);
		expect(errorLines()).toEqual([
			`SFTP host key type not offered for destination "NAS" at nas.example.test:22: confirmed ${stored}. Nothing was sent.`
		]);
		expect(errorLinesFiledUnder()).toEqual([chief.id]);
	});

	it('is refused by an upload as HostKeyTypeNotOffered', async () => {
		serve(RSA);

		const thrown = await new SftpDestination(confirmed(ED25519, 'ssh-ed25519')).upload(Buffer.from('x'), 'f.db').then(
			() => null,
			(err: unknown) => err
		);

		expect(thrown).toBeInstanceOf(HostKeyTypeNotOffered);
		expect((thrown as Error).message).toBe(typeNotOffered('ssh-ed25519'));
		expect(server.put).toEqual([]);
	});
});

describe('a Test that keeps a masked secret (the card 2250 review’s M1)', () => {
	/** NAS saved with its password, and the host key `hostKey` or none. */
	const stored = (hostKey?: string) =>
		saveBackupConfig({
			schedule: 'disabled',
			scheduleTime: '02:00',
			scheduleDay: 0,
			retention: 7,
			destinations: [hostKey === undefined ? NAS : { ...NAS, hostKey }],
			notifyOnFailure: false,
			notifyEmail: ''
		});
	const chief = () => makeUser({ username: 'chief', role: 'superadmin' });
	const ED25519_KEY = () => `ssh-ed25519 ${fingerprint(ED25519)}`;
	const refusal = 'Backup destination "NAS": type its password again. A saved secret is used only with the settings it was saved with, and this changes its host key.';

	it('is refused when it supplies a host key where none is stored, and nothing connects', async () => {
		stored();

		const res = await api('POST', '/api/admin/backup/test', { user: chief(), body: { ...NAS, password: SECRET_MASK, hostKey: ED25519_KEY() } });

		expect(res.status).toBe(400);
		expect(res.body.message).toBe(refusal);
		expect(server.configs).toEqual([]);
		expect(server.authenticated).toEqual([]);
	});

	it('is refused when it supplies a host key other than the stored one, and nothing connects', async () => {
		stored(`ssh-ed25519 ${fingerprint(OTHER_ED25519)}`);

		const res = await api('POST', '/api/admin/backup/test', { user: chief(), body: { ...NAS, password: SECRET_MASK, hostKey: ED25519_KEY() } });

		expect(res.status).toBe(400);
		expect(res.body.message).toBe(refusal);
		expect(server.configs).toEqual([]);
	});

	it('connects with the stored password when the key sent is the stored one, as the page’s Test after Confirm sends it', async () => {
		stored(ED25519_KEY());

		const res = await api('POST', '/api/admin/backup/test', { user: chief(), body: { ...NAS, password: SECRET_MASK, hostKey: ED25519_KEY() } });

		expect(res.body).toEqual({ success: true, message: 'Connected to nas.example.test:22' });
		expect(server.authenticated).toHaveLength(1);
		expect(server.authenticated[0].password).toBe('nas-password-2250');
	});

	it('takes the first look, with no secret, when neither a key is sent nor one stored', async () => {
		stored();

		const res = await api('POST', '/api/admin/backup/test', { user: chief(), body: { ...NAS, password: SECRET_MASK, hostKey: '' } });

		expect(res.body.hostKey).toBe(ED25519_KEY());
		expect(server.configs).toHaveLength(1);
		expect(server.configs[0].password).toBeUndefined();
		expect(server.authenticated).toEqual([]);
	});

	it('may still be given a key with the password typed: the typed password is the caller’s own', async () => {
		stored();

		const res = await api('POST', '/api/admin/backup/test', { user: chief(), body: { ...NAS, password: 'typed-for-this-test', hostKey: ED25519_KEY() } });

		expect(res.body).toEqual({ success: true, message: 'Connected to nas.example.test:22' });
		expect(server.authenticated.map((config) => config.password)).toEqual(['typed-for-this-test']);
	});
});

describe('a server that shows the confirmed key but cannot sign with it (the card 2250 review’s S4)', () => {
	it('is refused by a Test by name, answering the confirmed key, with one ERROR line naming its fingerprint', async () => {
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		server.forged = true;
		const stored = `ssh-ed25519 ${fingerprint(ED25519)}`;

		const res = await api('POST', '/api/admin/backup/test', { user: chief, body: confirmed(ED25519, 'ssh-ed25519') });

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: false, message: signatureFailed(), confirmedHostKey: stored });
		expect(server.verified).toBe(1);
		expect(server.authenticated).toEqual([]);
		expect(errorLines()).toEqual([
			`SFTP host key signature failed for destination "NAS" at nas.example.test:22: confirmed ${fingerprint(ED25519)}. Nothing was sent.`
		]);
		expect(errorLinesFiledUnder()).toEqual([chief.id]);
	});

	it('is refused by an upload as HostKeySignatureFailed, and a run says so', async () => {
		server.forged = true;

		const thrown = await new SftpDestination(confirmed(ED25519, 'ssh-ed25519')).upload(Buffer.from('x'), 'f.db').then(
			() => null,
			(err: unknown) => err
		);

		expect(thrown).toBeInstanceOf(HostKeySignatureFailed);
		expect((thrown as Error).message).toBe(signatureFailed());
		expect(server.put).toEqual([]);
	});

	it('is not said of a key that did not match, whatever ssh2 says after', async () => {
		server.forged = true;
		serve(OTHER_ED25519);

		const thrown = await new SftpDestination(confirmed(ED25519, 'ssh-ed25519')).upload(Buffer.from('x'), 'f.db').then(
			() => null,
			(err: unknown) => err
		);

		expect(thrown).toBeInstanceOf(HostKeyMismatch);
	});
});

describe('a connect with no confirmed key, other than a Test (R7)', () => {
	it('opens no connection for an upload, a listing or a delete', async () => {
		const destination = new SftpDestination(NAS);

		for (const act of [() => destination.upload(Buffer.from('x'), 'f.db'), () => destination.list(), () => destination.delete('f.db')]) {
			const thrown = await act().then(
				() => null,
				(err: unknown) => err
			);
			expect(thrown).toBeInstanceOf(HostKeyNotConfirmed);
			expect((thrown as Error).message).toBe(NOT_CONFIRMED);
		}
		expect(server.configs).toEqual([]);
	});
});

describe('a backup run', () => {
	/** Back up to `destination` alone, with the failure mail on. */
	const runTo = async (destination: SftpDestinationConfig) => {
		makeSmtp();
		saveBackupConfig({
			schedule: 'disabled',
			scheduleTime: '02:00',
			scheduleDay: 0,
			retention: 7,
			destinations: [destination],
			notifyOnFailure: true,
			notifyEmail: 'ops@example.test'
		});
		const sent = effects();
		try {
			return { results: await runBackup(), emails: sent.emails.map((mail) => ({ to: mail.to, html: mail.html })) };
		} finally {
			sent.restore();
		}
	};
	const history = () => sqlite.prepare('SELECT destination_name AS name, status, error FROM backup_log ORDER BY id').all();

	it('does not try a destination with no confirmed key, and says why in Backup History, the ERROR line and the failure mail (decision 6)', async () => {
		const exec = vi.spyOn(sqlite, 'exec');

		const { results, emails } = await runTo(NAS);

		expect(results).toEqual([{ destination: 'NAS', status: 'failed', message: NOT_CONFIRMED, durationMs: 0 }]);
		// Not tried at all: no copy of the database is made for it (card 2169's N2).
		expect(exec.mock.calls.filter(([sql]) => String(sql).includes('VACUUM INTO'))).toEqual([]);
		expect(server.configs).toEqual([]);
		expect(history()).toEqual([{ name: 'NAS', status: 'failed', error: NOT_CONFIRMED }]);
		expect(errorLines()).toEqual([`Backup failed: NAS → ${NOT_CONFIRMED}`]);
		expect(emails).toHaveLength(1);
		expect(emails[0].to).toBe('ops@example.test');
		expect(emails[0].html).toContain(escapeHtml(NOT_CONFIRMED));
	});

	it('holds a destination with neither password nor key to the same rule', async () => {
		const { results } = await runTo({ ...NAS, password: '' });

		expect(results.map((r) => [r.status, r.message])).toEqual([['failed', NOT_CONFIRMED]]);
		expect(server.configs).toEqual([]);
	});

	it('fails a destination whose key does not match, putting nothing, with one ERROR line (decision 5)', async () => {
		serve(OTHER_ED25519);
		const words = mismatched(`ssh-ed25519 ${fingerprint(OTHER_ED25519)}`, fingerprint(ED25519));

		const { results } = await runTo(confirmed(ED25519, 'ssh-ed25519'));

		expect(results.map((r) => [r.status, r.message])).toEqual([['failed', words]]);
		expect(server.authenticated).toEqual([]);
		expect(server.put).toEqual([]);
		expect(errorLines()).toEqual([`Backup failed: NAS → ${words}`]);
	});

	it('fails a destination whose server no longer offers the confirmed type, putting nothing (R3)', async () => {
		serve(RSA);

		const { results } = await runTo(confirmed(ED25519, 'ssh-ed25519'));

		expect(results.map((r) => [r.status, r.message])).toEqual([['failed', typeNotOffered('ssh-ed25519')]]);
		expect(server.put).toEqual([]);
		expect(errorLines()).toEqual([`Backup failed: NAS → ${typeNotOffered('ssh-ed25519')}`]);
	});

	it('uploads to a destination whose key matches', async () => {
		const { results } = await runTo(confirmed(ED25519, 'ssh-ed25519'));

		expect(results.map((r) => r.status)).toEqual(['success']);
		expect(server.put).toHaveLength(1);
		expect(errorLines()).toEqual([]);
	});
});
