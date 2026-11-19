/**
 * Card 2898: the secrets the server keeps in its database are sealed at rest
 * (src/lib/server/stored-secrets.ts). The envelope, its padding and its
 * additional data; the start's sweep of plain values and its scrub of the
 * file; and the signing keys sealed in place.
 *
 * The cases are numbered as the plan's section 5 numbers them
 * (docs/planning/card-2898-secrets-encrypted-at-rest.md). The key is the
 * process's own, made under DB_PATH=:memory: and written nowhere; keys "of
 * another server" are made here from random bytes. Case 21 works on a scratch
 * database file under the temp folder, removed after it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Admin › Vacuum's scrub held up by a reader, for its route's case alone (the code review's E7): the in-memory database has no log to hold. */
const vacuumStub = vi.hoisted(() => ({ held: false }));

vi.mock('$lib/server/stored-secrets', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/stored-secrets')>();
	return { ...real, vacuumAndScrub: (...args: Parameters<typeof real.vacuumAndScrub>) => (vacuumStub.held ? false : real.vacuumAndScrub(...args)) };
});

import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, sqlite } from '$lib/server/db';
import { settings, systemLogs, webhooks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { currentMfaKey, keyFromBytes, type MfaKey } from '$lib/server/mfa-key';
import { sealWith } from '$lib/server/mfa-crypto';
import { destinationPlace, mailChanges, mailConnection, secretsToEnter } from '$lib/server/backup-secrets';
import { sealStoredSecretsAtStart } from '$lib/server/startup-checks';
import {
	SECRETS_SCRUB_PENDING,
	anythingSealed,
	destinationSecretAad,
	isSealed,
	mailPasswordAad,
	openDestinationSecrets,
	openStored,
	sealDestinationSecrets,
	sealPlainSecrets,
	sealStored,
	sealValue,
	sealedForRestore,
	settingAad,
	vacuumAndScrub,
	webhookSecretAad
} from '$lib/server/stored-secrets';
import type { Cookies } from '@sveltejs/kit';
import { KNOWN_BROWSER_SECRET_KEY, rememberBrowser, rememberedNonce, resetKnownBrowserSecretCache } from '$lib/server/known-browsers';
import { issueFormToken, resetFormSecretCache, verifyFormToken, writeFormSecret } from '$lib/server/request-tokens';
import { makeBoard, makeUser, makeWebhook, resetDb } from './helpers/fixtures';
import { readOpened } from './helpers/reads';
import { api } from './helpers/api';

/** This process's key. */
const key = (): MfaKey => currentMfaKey()!;
const otherKey = () => keyFromBytes(randomBytes(32));

const setting = (name: string) => db.select().from(settings).where(eq(settings.key, name)).get()?.value;
const putSetting = (name: string, value: string) =>
	db.insert(settings).values({ key: name, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();

/** Every system log line and console line written while `fn` runs. */
function linesOf(fn: () => void): string[] {
	const from = (sqlite.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM system_logs').get() as { n: number }).n;
	const error = vi.spyOn(console, 'error').mockImplementation(() => {});
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		fn();
		const logged = db.select().from(systemLogs).all().filter((row) => row.id > from).map((row) => `[${row.level}] [${row.context}] ${row.message} ${row.meta ?? ''}`);
		return [...logged, ...error.mock.calls.map((call) => String(call[0])), ...warn.mock.calls.map((call) => String(call[0]))];
	} finally {
		error.mockRestore();
		warn.mockRestore();
	}
}

beforeEach(() => {
	resetDb();
});

/** Card 2939: Google's whole key file for a service account, and the fields DumpFire keeps of it, in its order. */
const MARKER_2939 = 'zz-2939-sweep';
const GOOGLE_FILE = {
	type: 'service_account',
	project_id: 'project-2939',
	private_key_id: 'key-id-2939',
	private_key: `-----BEGIN PRIVATE KEY-----\n${MARKER_2939}\n-----END PRIVATE KEY-----\n`,
	client_email: 'robot@project-2939.iam.example.test',
	client_id: '2939',
	auth_uri: 'https://accounts.google.com/o/oauth2/auth',
	token_uri: `https://${MARKER_2939}.invalid/token`,
	auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
	client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/robot',
	universe_domain: 'googleapis.com'
};
const KEPT_FIELDS = ['type', 'project_id', 'private_key_id', 'private_key', 'client_email', 'client_id'];
const keptOf = (account: Record<string, unknown>) => Object.fromEntries(Object.entries(account).filter(([field]) => KEPT_FIELDS.includes(field)));
const robotWith = (account: unknown, name = 'Robot') => ({
	type: 'gdrive',
	name,
	authMethod: 'service_account',
	folderId: 'folder-2939',
	serviceAccountJson: typeof account === 'string' ? account : JSON.stringify(account)
});
const destinationsIn = (text: string | undefined) => JSON.parse(text!).destinations as Record<string, string>[];

describe('the envelope', () => {
	it('2: sealStored writes the envelope, two seals differ and each opens to the value; an empty value is stored empty', () => {
		const aad = settingAad('known_browser_secret');
		const first = sealStored('the secret', aad);
		const second = sealStored('the secret', aad);
		expect(first).toMatch(/^dfsealed:1:[0-9a-f]{16}:/);
		expect(isSealed(first)).toBe(true);
		expect(first).not.toBe(second);
		expect(openStored(first, aad)).toEqual({ kind: 'opened', value: 'the secret' });
		expect(openStored(second, aad)).toEqual({ kind: 'opened', value: 'the secret' });

		// Row 2 (E6): '' through the seal is ''.
		expect(sealStored('', aad)).toBe('');
	});

	it('3: plaintexts of 1 and 63 bytes seal to one length and 64 to the next; a bad padding does not open', () => {
		const length = (plain: string) => sealValue(plain, 'aad', key()).length;
		expect(length('a')).toBe(length('a'.repeat(63)));
		expect(length('a'.repeat(64))).toBeGreaterThan(length('a'.repeat(63)));

		// Row 2: 64 bytes sealed with no 0x80 at the end of the text.
		const raw = sealWith({ ...key(), encryptionKey: key().secretsKey }, Buffer.alloc(64, 0x41), 'aad');
		const envelope = `dfsealed:1:${raw.keyId}:${raw.nonce}:${raw.ciphertext}`;
		expect(isSealed(envelope)).toBe(true);
		expect(openStored(envelope, 'aad', key())).toEqual({ kind: 'unopenable', value: '' });
	});

	it('4: isSealed refuses what is near an envelope, and sealStored refuses to seal one', () => {
		const good = sealValue('x', 'aad', key());
		const [, , id, nonce, body] = good.split(':');
		expect(isSealed(good)).toBe(true);
		for (const near of [
			`dfsealed:2:${id}:${nonce}:${body}`, // another version
			`dfsealed:1:${id}:${nonce.slice(4)}:${body}`, // a short nonce
			`dfsealed:1:${id}:${body}`, // a part missing
			`dfsealed:1:${id.toUpperCase()}:${nonce}:${body}`,
			` ${good}`
		]) {
			expect(isSealed(near), near).toBe(false);
		}

		// Row 2 (S9): nothing is sealed twice.
		expect(() => sealStored(good, 'aad')).toThrow(/already sealed/);
	});

	it('5: an empty value is empty, and a value with no envelope is plain, as it is', () => {
		expect(openStored('', 'aad')).toEqual({ kind: 'empty', value: '' });
		expect(openStored(null, 'aad')).toEqual({ kind: 'empty', value: '' });
		expect(openStored('hunter2 in plain', 'aad')).toEqual({ kind: 'plain', value: 'hunter2 in plain' });
	});

	it('6: another key, other additional data, or a changed byte does not open, and nothing is thrown', () => {
		const sealed = sealValue('the secret', 'aad', key());
		expect(openStored(sealed, 'aad', otherKey()).kind).toBe('unopenable');
		// The same key's id, another key's bytes: the tag refuses it.
		expect(openStored(sealed, 'aad', { ...otherKey(), id: key().id }).kind).toBe('unopenable');
		expect(openStored(sealed, 'other aad', key()).kind).toBe('unopenable');
		const parts = sealed.split(':');
		const body = Buffer.from(parts[4], 'base64');
		body[0] ^= 0x01;
		const changed = [...parts.slice(0, 4), body.toString('base64')].join(':');
		expect(() => openStored(changed, 'aad', key())).not.toThrow();
		expect(openStored(changed, 'aad', key()).kind).toBe('unopenable');
	});

	it('6b: text that begins dfsealed: and is no envelope reads as unopenable, never as a plain secret (departure 2)', () => {
		const good = sealValue('the secret', 'aad', key());
		const [, , id, nonce, body] = good.split(':');
		for (const near of ['dfsealed:', 'dfsealed:1:', `dfsealed:2:${id}:${nonce}:${body}`, `dfsealed:1:${id}:${nonce.slice(2)}:${body}`, `dfsealed:1:${id}:${body}`, `${good}!`]) {
			expect(openStored(near, 'aad', key()), near).toEqual({ kind: 'unopenable', value: '' });
		}
		// Another case is no envelope's mark: a plain secret, as it is.
		expect(openStored(`DFSEALED:1:${id}:${nonce}:${body}`, 'aad', key()).kind).toBe('plain');
	});
});

describe('the additional data (S8)', () => {
	const HOST_KEY = 'ssh-ed25519 SHA256:s16t1ixxsjxOgoaXCXACvAIOEG1K5biSlM7GekmavrY';
	const OTHER_HOST_KEY = 'ssh-ed25519 SHA256:AAAAt1ixxsjxOgoaXCXACvAIOEG1K5biSlM7GekmavrY';
	const SFTP = { type: 'sftp', name: 'Offsite', host: 'sftp.example.test', port: 22, username: 'backup', remotePath: '/backups', hostKey: HOST_KEY };

	it.each([
		{
			kind: 'mail password',
			aad: () => mailPasswordAad({ smtp_host: ' Mail.Example.TEST\t', smtp_port: '465', smtp_user: 'sender', smtp_allow_insecure: 'true' }),
			expected: '[1,"mail-password","mail.example.test",465,"sender",true]'
		},
		{
			kind: 'destination secret',
			aad: () => destinationSecretAad(SFTP, 'password'),
			expected: '[1,"destination-secret","password","sftp",["sftp.example.test",22,"backup","/backups"],null,"SHA256:s16t1ixxsjxOgoaXCXACvAIOEG1K5biSlM7GekmavrY"]'
		},
		{ kind: 'webhook secret', aad: () => webhookSecretAad(7, 3, 'https://hooks.example.test/a'), expected: '[1,"webhook-secret",7,3,"https://hooks.example.test/a"]' },
		{ kind: 'signing key', aad: () => settingAad('request_form_secret'), expected: '[1,"setting","request_form_secret"]' }
	])('7: the $kind is bound to fixed, versioned text', ({ aad, expected }) => {
		expect(aad()).toBe(expected);
	});

	it("8: a mail password opens after its host's case and spaces change, and not after a change of host, port, user or way out", () => {
		const saved = { smtp_host: 'mail.example.test', smtp_port: '587', smtp_user: 'sender', smtp_allow_insecure: 'false' };
		const sealed = sealValue('the mail password', mailPasswordAad(saved), key());
		expect(openStored(sealed, mailPasswordAad({ ...saved, smtp_host: '  MAIL.Example.test ' })).value).toBe('the mail password');
		// The port and the way out as the mailer reads them: none is 587, and not 'true' is off.
		expect(openStored(sealed, mailPasswordAad({ host: 'mail.example.test', user: 'sender' })).value).toBe('the mail password');

		for (const changed of [{ smtp_host: 'mail.elsewhere.test' }, { smtp_port: '465' }, { smtp_user: 'another' }, { smtp_allow_insecure: 'true' }]) {
			expect(openStored(sealed, mailPasswordAad({ ...saved, ...changed })).kind, JSON.stringify(changed)).toBe('unopenable');
		}
	});

	it("9: a destination's secret opens after a rename, not after a change of place, nor an SFTP password after its host key changes", () => {
		const sealed = sealValue('the password', destinationSecretAad(SFTP, 'password'), key());
		expect(openStored(sealed, destinationSecretAad({ ...SFTP, name: 'Renamed' }, 'password')).value).toBe('the password');

		for (const moved of [{ host: 'sftp.elsewhere.test' }, { port: 2222 }, { username: 'other' }, { remotePath: '/elsewhere' }]) {
			expect(openStored(sealed, destinationSecretAad({ ...SFTP, ...moved }, 'password')).kind, JSON.stringify(moved)).toBe('unopenable');
		}
		// Another field of the same destination is another seal.
		expect(openStored(sealed, destinationSecretAad(SFTP, 'privateKey')).kind).toBe('unopenable');

		// Row 3: the confirmed host key changed, or removed.
		expect(openStored(sealed, destinationSecretAad({ ...SFTP, hostKey: OTHER_HOST_KEY }, 'password')).kind).toBe('unopenable');
		expect(openStored(sealed, destinationSecretAad({ ...SFTP, hostKey: '' }, 'password')).kind).toBe('unopenable');
	});

	it('7b: two places, or two mail connections, are the same to the match rules exactly when they seal alike (E3)', () => {
		const MAIL_BASE = { smtp_host: 'mail.example.test', smtp_port: '587', smtp_user: 'sender', smtp_allow_insecure: 'false' };
		const mails: Record<string, unknown>[] = [
			MAIL_BASE,
			{ ...MAIL_BASE, smtp_host: ' MAIL.Example.test\t' },
			{ ...MAIL_BASE, smtp_host: 'mail.example.test ' },
			{ ...MAIL_BASE, smtp_host: 'mail.elsewhere.test' },
			{ ...MAIL_BASE, smtp_port: '' },
			{ ...MAIL_BASE, smtp_port: null },
			{ ...MAIL_BASE, smtp_port: '465' },
			{ ...MAIL_BASE, smtp_user: 'another' },
			{ ...MAIL_BASE, smtp_user: null },
			{ ...MAIL_BASE, smtp_allow_insecure: 'true' },
			{ ...MAIL_BASE, smtp_allow_insecure: null }
		];
		for (const a of mails) {
			for (const b of mails) {
				const sameByRule = mailChanges(mailConnection(a), mailConnection(b)).length === 0;
				expect(mailPasswordAad(a) === mailPasswordAad(b), `${JSON.stringify(a)} ~ ${JSON.stringify(b)}`).toBe(sameByRule);
			}
		}

		const key = { hostKey: HOST_KEY };
		const account = (id: string) => JSON.stringify({ client_email: 'robot@example.test', private_key_id: id, private_key: 'k' });
		const places: Record<string, unknown>[] = [
			{ ...SFTP },
			{ ...SFTP, name: 'Renamed' },
			{ ...SFTP, host: ' SFTP.example.TEST' },
			{ ...SFTP, port: undefined },
			{ ...SFTP, port: 2222 },
			{ ...SFTP, remotePath: '' },
			{ type: 's3', name: 'B', bucket: 'b', region: '', ...key },
			{ type: 's3', name: 'B', bucket: 'b', region: 'us-east-1', ...key },
			{ type: 's3', name: 'B', bucket: 'b', region: 'eu-west-2', ...key },
			{ type: 's3', name: 'B', bucket: 'c', ...key },
			{ type: 'gdrive', name: 'G', authMethod: 'oauth', folderId: 'f', clientId: 'c', ...key },
			{ type: 'gdrive', name: 'G', authMethod: 'oauth', folderId: 'f', clientId: 'd', ...key },
			{ type: 'gdrive', name: 'G', authMethod: 'service_account', folderId: 'f', serviceAccountJson: account('1'), ...key },
			{ type: 'gdrive', name: 'G', authMethod: 'service_account', folderId: 'f', serviceAccountJson: account('2'), ...key },
			{ type: 'onedrive', name: 'O', tenantId: 't', clientId: 'c', folderPath: '/DumpFire Backups/', ...key },
			{ type: 'onedrive', name: 'O', tenantId: 't', clientId: 'c', ...key },
			{ type: 'onedrive', name: 'O', tenantId: 't', clientId: 'c', folderPath: 'Elsewhere', ...key },
			{ type: 'tape', name: 'T', ...key }
		];
		for (const a of places) {
			for (const b of places) {
				const samePlace = JSON.stringify(destinationPlace(a)) === JSON.stringify(destinationPlace(b));
				expect(destinationSecretAad(a, 'password') === destinationSecretAad(b, 'password'), `${JSON.stringify(a)} ~ ${JSON.stringify(b)}`).toBe(samePlace);
			}
		}
	});

	it("10: a webhook's secret opens only with the same id, board and address", () => {
		const sealed = sealValue('whsec', webhookSecretAad(7, 3, 'https://hooks.example.test/a'), key());
		expect(openStored(sealed, webhookSecretAad(7, 3, 'https://hooks.example.test/a')).value).toBe('whsec');

		// Row 2: each changed.
		expect(openStored(sealed, webhookSecretAad(8, 3, 'https://hooks.example.test/a')).kind).toBe('unopenable');
		expect(openStored(sealed, webhookSecretAad(7, 4, 'https://hooks.example.test/a')).kind).toBe('unopenable');
		expect(openStored(sealed, webhookSecretAad(7, 3, 'https://hooks.example.test/b')).kind).toBe('unopenable');
	});
});

describe('destinations', () => {
	it("11: a service account's private_key is sealed inside its JSON, the rest of it readable, and its place unchanged", () => {
		const account = { type: 'service_account', client_email: 'backups@project.example.test', private_key_id: 'k1', private_key: '-----BEGIN PRIVATE KEY-----\nMII\n' };
		const destination = { type: 'gdrive', name: 'Drive', authMethod: 'service_account', folderId: 'folder', serviceAccountJson: JSON.stringify(account) };

		const stored = sealDestinationSecrets({ destinations: [destination] }).destinations[0];

		const json = JSON.parse(stored.serviceAccountJson);
		expect(isSealed(json.private_key)).toBe(true);
		expect(json).toEqual({ ...account, private_key: json.private_key });
		expect(stored.serviceAccountJson).not.toContain('BEGIN PRIVATE KEY');
		expect(destinationPlace(stored)).toEqual(destinationPlace(destination));
		expect(JSON.parse(openDestinationSecrets({ destinations: [stored] }).destinations[0].serviceAccountJson)).toEqual(account);
	});

	it('12: sealPlainSecrets seals every kind held in plain, an unknown type among them, leaves empty and sealed values, counts, and seals nothing the second time', () => {
		const user = makeUser({ role: 'admin' });
		const hook = makeWebhook(makeBoard({ owner: user }).board, { secret: 'webhook secret in plain' });
		const unsigned = makeWebhook(makeBoard({ owner: user }).board);
		const alreadySealed = sealValue('sealed before', destinationSecretAad({ type: 's3', name: 'B', bucket: 'b' }, 'secretAccessKey'), key());
		putSetting('smtp_host', 'mail.example.test');
		putSetting('smtp_user', 'sender');
		putSetting('smtp_pass', 'mail password in plain');
		putSetting('known_browser_secret', 'b'.repeat(64));
		putSetting(
			'backup_config',
			JSON.stringify({
				schedule: 'daily',
				destinations: [
					{ type: 'sftp', name: 'Offsite', host: 'sftp.example.test', username: 'backup', password: 'sftp password in plain', privateKey: '' },
					{ type: 's3', name: 'B', bucket: 'b', secretAccessKey: alreadySealed },
					{ type: 'tape', name: 'Unknown', secretAccessKey: 'unknown type in plain' }
				]
			})
		);
		const formKey = setting('request_form_secret');

		const counts = sealPlainSecrets(sqlite);

		expect(counts).toEqual({ mail: 1, destinationFields: 2, webhooks: 1, signingKeys: 1, unreadableConfigs: 0 });
		expect(isSealed(setting('smtp_pass'))).toBe(true);
		expect(readOpened('settings', 'smtp_pass')).toBe('mail password in plain');
		expect(readOpened('settings', 'known_browser_secret')).toBe('b'.repeat(64));
		expect(readOpened('webhooks', hook.id)).toBe('webhook secret in plain');
		expect(readOpened('webhooks', unsigned.id)).toBe('');
		// The form key was sealed already, and is as it was.
		expect(setting('request_form_secret')).toBe(formKey);
		const config = JSON.parse(setting('backup_config')!);
		expect(isSealed(config.destinations[0].password)).toBe(true);
		expect(config.destinations[0].privateKey).toBe('');
		expect(config.destinations[1].secretAccessKey).toBe(alreadySealed);
		expect(isSealed(config.destinations[2].secretAccessKey)).toBe(true);
		expect(JSON.parse(readOpened('settings', 'backup_config')!).destinations.map((d: Record<string, unknown>) => d.password ?? d.secretAccessKey)).toEqual([
			'sftp password in plain',
			'sealed before',
			'unknown type in plain'
		]);

		expect(sealPlainSecrets(sqlite)).toEqual({ mail: 0, destinationFields: 0, webhooks: 0, signingKeys: 0, unreadableConfigs: 0 });

		// Row 2 (S12): a configuration that is not JSON is counted, nothing is sealed in it, and none of its text is logged.
		putSetting('backup_config', 'not json: hunter2-in-a-broken-config');
		putSetting('smtp_pass', 'another mail password');
		const lines = linesOf(() => sealStoredSecretsAtStart(sqlite));
		expect(setting('backup_config')).toBe('not json: hunter2-in-a-broken-config');
		expect(lines.some((line) => line.includes('1 backup configuration(s) unreadable'))).toBe(true);
		expect(lines.filter((line) => line.includes('hunter2') || line.includes('another mail password'))).toEqual([]);
	});
});

describe('what is taken for sealed (the code review S2)', () => {
	it('12b: only text beginning dfsealed:, in that case, is taken for sealed: a plain DFSEALED: secret is sealed at start, and a name holding the text is nothing sealed', () => {
		const user = makeUser({ role: 'admin' });
		const hook = makeWebhook(makeBoard({ owner: user }).board, { secret: 'DFSEALED:a plain secret' });
		db.delete(settings).where(eq(settings.key, 'request_form_secret')).run();
		putSetting('backup_config', JSON.stringify({ destinations: [{ type: 's3', name: 'dfsealed: a name', prefix: 'dfsealed:/path', secretAccessKey: '' }] }));
		db.update(webhooks).set({ secret: '' }).where(eq(webhooks.id, hook.id)).run();
		expect(anythingSealed(sqlite)).toBe(false);
		db.update(webhooks).set({ secret: 'DFSEALED:a plain secret' }).where(eq(webhooks.id, hook.id)).run();
		expect(anythingSealed(sqlite)).toBe(false);

		expect(sealPlainSecrets(sqlite).webhooks).toBe(1);

		expect(isSealed(db.select().from(webhooks).where(eq(webhooks.id, hook.id)).get()!.secret)).toBe(true);
		expect(readOpened('webhooks', hook.id)).toBe('DFSEALED:a plain secret');
		expect(anythingSealed(sqlite)).toBe(true);
	});
});

describe('the start step: service account JSON brought to the one rule (card 2939)', () => {
	it('23: rebuilds a stored key to the fields DumpFire uses, its sealed private_key byte for byte and still opening, names it without a value, and a second start writes and says nothing', () => {
		const sealed = sealDestinationSecrets({ destinations: [robotWith(GOOGLE_FILE)] }).destinations[0];
		const envelope = JSON.parse(sealed.serviceAccountJson).private_key as string;
		expect(isSealed(envelope)).toBe(true);
		putSetting('backup_config', JSON.stringify({ destinations: [sealed] }));

		const lines = linesOf(() => sealStoredSecretsAtStart(sqlite));

		const [stored] = destinationsIn(setting('backup_config'));
		const account = JSON.parse(stored.serviceAccountJson);
		expect(Object.keys(account)).toEqual(KEPT_FIELDS);
		expect(account).toEqual({ ...keptOf(GOOGLE_FILE), private_key: envelope });
		expect(JSON.parse(openDestinationSecrets({ destinations: [stored] }).destinations[0].serviceAccountJson).private_key).toBe(GOOGLE_FILE.private_key);
		const said = lines.filter((line) => line.includes('Rewrote the service account JSON'));
		expect(said.length).toBeGreaterThan(0);
		expect(said[0]).toContain('destination "Robot" (kept its key, every other field dropped)');
		expect(lines.filter((line) => line.includes(MARKER_2939) || line.includes(envelope.slice(12)))).toEqual([]);

		const before = setting('backup_config');
		const again = linesOf(() => sealStoredSecretsAtStart(sqlite));
		expect(setting('backup_config')).toBe(before);
		expect(again.filter((line) => line.includes('service account JSON'))).toEqual([]);
	});

	it('24: clears what is not a key (another type, a key of another universe, JSON on an OAuth or an S3 entry), names each, lists the service accounts to enter, and is no first sealing', () => {
		putSetting(
			'backup_config',
			JSON.stringify({
				destinations: [
					robotWith({ type: 'external_account', token_url: `https://${MARKER_2939}.invalid`, credential_source: { file: '/etc/hostname' } }, 'Outside'),
					robotWith({ ...GOOGLE_FILE, universe_domain: `${MARKER_2939}.invalid` }, 'Elsewhere'),
					{ type: 'gdrive', name: 'Connected', authMethod: 'oauth', clientId: 'c', clientSecret: 'oauth-secret', refreshToken: 'oauth-token', folderId: 'f', serviceAccountJson: JSON.stringify(GOOGLE_FILE) },
					{ type: 's3', name: 'Bucket', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's3-secret', serviceAccountJson: JSON.stringify(GOOGLE_FILE) }
				]
			})
		);
		const lines = linesOf(() => sealStoredSecretsAtStart(sqlite));

		const [outside, elsewhere, connected, bucket] = destinationsIn(setting('backup_config'));
		expect(outside.serviceAccountJson).toBe('');
		expect(JSON.parse(elsewhere.serviceAccountJson)).toEqual({ ...keptOf(GOOGLE_FILE), private_key: '' });
		expect(connected.serviceAccountJson).toBe('');
		expect(bucket.serviceAccountJson).toBe('');
		const said = lines.find((line) => line.includes('Rewrote the service account JSON of 4 backup destination(s)'))!;
		expect(said).toContain('destination "Outside" (cleared,');
		expect(said).toContain('destination "Elsewhere" (its key removed,');
		expect(said).toContain('destination "Connected" (cleared,');
		expect(said).toContain('destination "Bucket" (cleared,');
		expect(lines.filter((line) => line.includes(MARKER_2939))).toEqual([]);
		expect(secretsToEnter(sqlite).toEnter.destinations.map((d) => d.name)).toEqual(expect.arrayContaining(['Outside', 'Elsewhere']));
	});

	it('24c: a second start after a key was removed and a JSON cleared writes nothing and says nothing (the code review, F6)', () => {
		putSetting(
			'backup_config',
			JSON.stringify({
				destinations: [robotWith({ ...GOOGLE_FILE, universe_domain: `${MARKER_2939}.invalid` }, 'Elsewhere'), robotWith({ type: 'external_account' }, 'Outside')]
			})
		);
		linesOf(() => sealStoredSecretsAtStart(sqlite));
		const [elsewhere, outside] = destinationsIn(setting('backup_config'));
		expect(JSON.parse(elsewhere.serviceAccountJson).private_key).toBe('');
		expect(outside.serviceAccountJson).toBe('');
		const before = setting('backup_config');

		const again = linesOf(() => sealStoredSecretsAtStart(sqlite));

		expect(setting('backup_config')).toBe(before);
		expect(again.filter((line) => line.includes('service account JSON'))).toEqual([]);
	});

	it('24d: names a destination in the WARN quoted as card 2270’s lines quote one, a " in its name escaped (the code review, F8)', () => {
		putSetting('backup_config', JSON.stringify({ destinations: [robotWith({ type: 'external_account' }, 'Say "hi"')] }));

		const lines = linesOf(() => sealStoredSecretsAtStart(sqlite));

		expect(lines.find((line) => line.includes('Rewrote the service account JSON'))).toContain('destination "Say \\"hi\\"" (cleared,');
	});

	it('24b: a start that only brings a JSON to the rule writes no first-sealing mark', () => {
		putSetting('backup_config', JSON.stringify({ destinations: [robotWith({ type: 'external_account' }, 'Outside')] }));
		// Anything else held in plain sealed first, so that this start seals nothing.
		sealPlainSecrets(sqlite);
		expect(setting('stored_secrets_first_sealed')).toBeUndefined();

		const lines = linesOf(() => sealStoredSecretsAtStart(sqlite));

		expect(destinationsIn(setting('backup_config'))[0].serviceAccountJson).toBe('');
		expect(lines.some((line) => line.includes('Rewrote the service account JSON of 1'))).toBe(true);
		expect(setting('stored_secrets_first_sealed')).toBeUndefined();
	});

	it('26: a restore brings each destination of the backup to the rule before it is sealed: another type and OAuth JSON cleared, a key rebuilt and sealed', () => {
		const config = {
			destinations: [
				robotWith({ type: 'external_account', credential_source: { file: '/etc/hostname' } }, 'Outside'),
				robotWith(GOOGLE_FILE),
				{ type: 'gdrive', name: 'Connected', authMethod: 'oauth', clientId: 'c', folderId: 'f', serviceAccountJson: JSON.stringify(GOOGLE_FILE) }
			]
		};

		const { rows, sealed } = sealedForRestore('settings', [{ key: 'backup_config', value: JSON.stringify(config) }]);

		const [outside, robot, connected] = destinationsIn(rows[0].value as string);
		expect(outside.serviceAccountJson).toBe('');
		expect(connected.serviceAccountJson).toBe('');
		const account = JSON.parse(robot.serviceAccountJson);
		expect(Object.keys(account)).toEqual(KEPT_FIELDS);
		expect(isSealed(account.private_key)).toBe(true);
		expect(sealed).toBe(1);
		expect(rows[0].value).not.toContain(MARKER_2939);
		expect(JSON.parse(openDestinationSecrets({ destinations: [robot] }).destinations[0].serviceAccountJson)).toEqual(keptOf(GOOGLE_FILE));
	});
});

describe('the start step: signing keys and the scrub', () => {
	it('22: a signing key that does not open is replaced at the start step, the WARN saying what that breaks and holding no value', () => {
		const theirs = sealValue('c'.repeat(64), settingAad('known_browser_secret'), otherKey());
		putSetting('known_browser_secret', theirs);

		const lines = linesOf(() => sealStoredSecretsAtStart(sqlite));

		const now = setting('known_browser_secret')!;
		expect(now).not.toBe(theirs);
		expect(readOpened('settings', 'known_browser_secret')).toMatch(/^[0-9a-f]{64}$/);
		const said = lines.filter((line) => line.includes('Replaced the remembered-browser key'));
		expect(said.length).toBeGreaterThan(0);
		expect(said[0]).toContain('forgets every remembered browser');
		expect(lines.filter((line) => line.includes('c'.repeat(16)) || line.includes(now.slice(11)))).toEqual([]);
	});

	describe('21: on a database file', () => {
		let folder: string;
		const opened: Database.Database[] = [];
		beforeEach(() => {
			folder = mkdtempSync(join(tmpdir(), 'dumpfire-scrub-'));
		});
		afterEach(() => {
			for (const database of opened.splice(0)) {
				if (database.open) database.close();
			}
			rmSync(folder, { recursive: true, force: true });
		});

		/** A file database with this schema, in WAL, as db/index.ts opens one; secure_delete off until asked. */
		function scratch(): { database: Database.Database; path: string } {
			const path = join(folder, 'dumpfire.db');
			writeFileSync(path, sqlite.serialize());
			const database = new Database(path);
			opened.push(database);
			database.pragma('journal_mode = WAL');
			return { database, path };
		}
		const bytesOf = (path: string) => Buffer.concat([readFileSync(path), existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : Buffer.alloc(0)]);
		const settingIn = (database: Database.Database, name: string) =>
			(database.prepare('SELECT value FROM settings WHERE key = ?').get(name) as { value: string } | undefined)?.value;

		it('scrubs a value freed before secure_delete and the plain value sealed out of the file and its log, and clears the marker', () => {
			const { database, path } = scratch();
			// Long enough to end on an overflow page, which the delete frees whole and nothing but VACUUM rewrites.
			database.prepare("INSERT INTO settings (key, value) VALUES ('old_note', ?)").run(`${'x'.repeat(6000)}FREED-PLAIN-TEXT-7f3a`);
			database.pragma('wal_checkpoint(TRUNCATE)');
			database.prepare("DELETE FROM settings WHERE key = 'old_note'").run();
			database.pragma('wal_checkpoint(TRUNCATE)');
			expect(bytesOf(path).includes('FREED-PLAIN-TEXT-7f3a')).toBe(true);
			database.pragma('secure_delete = ON');
			database.prepare("INSERT INTO settings (key, value) VALUES ('smtp_pass', 'LIVE-PLAIN-TEXT-9c1d')").run();
			database.pragma('wal_checkpoint(TRUNCATE)');

			const later: (() => boolean)[] = [];
			linesOf(() => sealStoredSecretsAtStart(database, (scrub) => later.push(scrub)));

			expect(isSealed(settingIn(database, 'smtp_pass'))).toBe(true);
			const bytes = bytesOf(path);
			expect(bytes.includes('FREED-PLAIN-TEXT-7f3a')).toBe(false);
			expect(bytes.includes('LIVE-PLAIN-TEXT-9c1d')).toBe(false);
			expect(settingIn(database, SECRETS_SCRUB_PENDING)).toBeUndefined();
			expect(later).toEqual([]);
			// The server's own connection deletes with secure_delete on (db/index.ts, the code review's tests).
			expect(sqlite.pragma('secure_delete', { simple: true })).toBe(1);
		});

		it('keeps the marker while a reader holds the log and says so at ERROR naming Admin › Vacuum; a pending scrub is tried after the start, in the background, until it succeeds', () => {
			const { database, path } = scratch();
			database.prepare("INSERT INTO settings (key, value) VALUES ('smtp_pass', 'LIVE-PLAIN-TEXT-4b2e')").run();
			const reader = new Database(path);
			opened.push(reader);
			reader.prepare('BEGIN').run();
			reader.prepare('SELECT COUNT(*) FROM settings').get();
			const later: (() => boolean)[] = [];

			const lines = linesOf(() => sealStoredSecretsAtStart(database, (scrub) => later.push(scrub)));

			expect(isSealed(settingIn(database, 'smtp_pass'))).toBe(true);
			expect(settingIn(database, SECRETS_SCRUB_PENDING)).toBeDefined();
			const errors = lines.filter((line) => line.includes('[ERROR]') && line.includes('could not be scrubbed'));
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]).toContain('Admin › Vacuum');
			// This start's own failure is tried again in the background (E4).
			expect(later).toHaveLength(1);

			// A later start: the marker is an earlier start's, so nothing is scrubbed before the server listens.
			database.prepare('UPDATE settings SET value = ? WHERE key = ?').run('2026-01-01T00:00:00.000Z', SECRETS_SCRUB_PENDING);
			const afterListen: (() => boolean)[] = [];
			const atStart = linesOf(() => sealStoredSecretsAtStart(database, (scrub) => afterListen.push(scrub)));
			expect(atStart.filter((line) => line.includes('could not be scrubbed'))).toEqual([]);
			expect(settingIn(database, SECRETS_SCRUB_PENDING)).toBe('2026-01-01T00:00:00.000Z');
			expect(afterListen).toHaveLength(1);
			// Still held: the background try fails, says so, and keeps the marker.
			expect(linesOf(() => expect(afterListen[0]()).toBe(false)).some((line) => line.includes('could not be scrubbed'))).toBe(true);
			expect(settingIn(database, SECRETS_SCRUB_PENDING)).toBeDefined();

			reader.prepare('COMMIT').run();
			reader.close();
			expect(afterListen[0]()).toBe(true);
			expect(settingIn(database, SECRETS_SCRUB_PENDING)).toBeUndefined();
			expect(bytesOf(path).includes('LIVE-PLAIN-TEXT-4b2e')).toBe(false);
		});

		it('Admin › Vacuum leaves an empty log and clears the marker; held up by a reader, it says it did not finish and keeps the marker', () => {
			const { database, path } = scratch();
			database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(SECRETS_SCRUB_PENDING, '2026-11-19T00:00:00.000Z');
			database.prepare("INSERT INTO settings (key, value) VALUES ('filler', ?)").run('x'.repeat(5000));
			expect(readFileSync(`${path}-wal`).length).toBeGreaterThan(0);

			expect(vacuumAndScrub(database)).toBe(true);

			expect(readFileSync(`${path}-wal`).length).toBe(0);
			expect(settingIn(database, SECRETS_SCRUB_PENDING)).toBeUndefined();

			// Row 4 (the code review's E7, S5): a reader holds the log.
			database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(SECRETS_SCRUB_PENDING, '2026-11-19T00:00:00.000Z');
			const reader = new Database(path);
			opened.push(reader);
			reader.prepare('BEGIN').run();
			reader.prepare('SELECT COUNT(*) FROM settings').get();
			expect(vacuumAndScrub(database)).toBe(false);
			expect(settingIn(database, SECRETS_SCRUB_PENDING)).toBeDefined();
			reader.prepare('COMMIT').run();
		});

		it('25: marks the scrub when the start only brought a service account JSON to the rule (card 2939), kept while a reader holds the log', () => {
			const { database, path } = scratch();
			sealPlainSecrets(database);
			database
				.prepare("INSERT INTO settings (key, value) VALUES ('backup_config', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
				.run(JSON.stringify({ destinations: [robotWith(GOOGLE_FILE)] }));
			sealPlainSecrets(database);
			database.prepare('DELETE FROM settings WHERE key = ?').run(SECRETS_SCRUB_PENDING);
			database.pragma('wal_checkpoint(TRUNCATE)');
			const reader = new Database(path);
			opened.push(reader);
			reader.prepare('BEGIN').run();
			reader.prepare('SELECT COUNT(*) FROM settings').get();

			const lines = linesOf(() => sealStoredSecretsAtStart(database, () => {}));

			expect(lines.some((line) => line.includes('Rewrote the service account JSON of 1'))).toBe(true);
			expect(lines.some((line) => line.startsWith('Sealed') || line.includes('] Sealed '))).toBe(false);
			expect(settingIn(database, SECRETS_SCRUB_PENDING)).toBeDefined();
			reader.prepare('COMMIT').run();
		});

		it('deletes the stale backup copies beside the database on the first sealing start alone (the code review E8)', () => {
			const { database, path } = scratch();
			const stale = `${path}.backup-temp`;
			database.prepare("INSERT INTO settings (key, value) VALUES ('smtp_pass', 'FIRST-PLAIN')").run();
			writeFileSync(stale, 'a stale copy');

			linesOf(() => sealStoredSecretsAtStart(database, () => {}));
			expect(existsSync(stale)).toBe(false);
			expect(settingIn(database, 'stored_secrets_first_sealed')).toBeDefined();

			// A later start that seals what an older image wrote: the copy is left.
			writeFileSync(stale, 'a backup being made');
			database.prepare("UPDATE settings SET value = 'SECOND-PLAIN' WHERE key = 'smtp_pass'").run();
			linesOf(() => sealStoredSecretsAtStart(database, () => {}));
			expect(isSealed(settingIn(database, 'smtp_pass'))).toBe(true);
			expect(existsSync(stale)).toBe(true);
		});
	});

	it('Admin › Vacuum answers 503 in plain words, and says so at ERROR, when the scrub did not finish (the code review E7, S5)', async () => {
		const admin = makeUser({ role: 'admin' });
		vacuumStub.held = true;
		try {
			const from = (sqlite.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM system_logs').get() as { n: number }).n;
			const res = await api('POST', '/api/admin/vacuum', { user: admin });
			expect(res.status).toBe(503);
			expect(res.body.message).toMatch(/write-ahead log is held by a reader.*The scrub stays pending and is tried again/);
			const errors = db.select().from(systemLogs).all().filter((row) => row.id > from && row.level === 'ERROR');
			expect(errors.map((row) => row.message).join(' ')).toContain('could not scrub');
		} finally {
			vacuumStub.held = false;
		}
		expect((await api('POST', '/api/admin/vacuum', { user: admin })).status).toBe(200);
	});
});

describe('the two signing keys, stored sealed', () => {
	/** The cookie a remember sets for `user`, as `rememberBrowser` writes it. */
	function remembered(user: { id: number }, passwordHash: string): { name: string; value: string } {
		let made: { name: string; value: string } | undefined;
		rememberBrowser({ set: (name: string, value: string) => (made = { name, value }) } as unknown as Cookies, user.id, passwordHash, null);
		return made!;
	}
	const sending = (cookie: { name: string; value: string }) => ({ get: (name: string) => (name === cookie.name ? cookie.value : undefined) });

	it('40: the remembered-browser key is made sealed and a cookie of it holds; with its row tampered the cookie is refused, and the next remember replaces the row', () => {
		const user = makeUser();
		db.delete(settings).where(eq(settings.key, KNOWN_BROWSER_SECRET_KEY)).run();
		resetKnownBrowserSecretCache();

		const cookie = remembered(user, 'hash-40');
		const row = setting(KNOWN_BROWSER_SECRET_KEY)!;
		expect(isSealed(row)).toBe(true);
		expect(readOpened('settings', KNOWN_BROWSER_SECRET_KEY)).toMatch(/^[0-9a-f]{64}$/);
		expect(rememberedNonce(sending(cookie), { id: user.id, passwordHash: 'hash-40' })).not.toBeNull();

		// Row 2: sealed under another key, as a row written by hand would be.
		putSetting(KNOWN_BROWSER_SECRET_KEY, sealValue('a'.repeat(64), settingAad(KNOWN_BROWSER_SECRET_KEY), otherKey()));
		resetKnownBrowserSecretCache();
		expect(rememberedNonce(sending(cookie), { id: user.id, passwordHash: 'hash-40' })).toBeNull();
		const tampered = setting(KNOWN_BROWSER_SECRET_KEY);

		const again = remembered(user, 'hash-40');
		expect(setting(KNOWN_BROWSER_SECRET_KEY)).not.toBe(tampered);
		expect(readOpened('settings', KNOWN_BROWSER_SECRET_KEY)).toMatch(/^[0-9a-f]{64}$/);
		expect(rememberedNonce(sending(again), { id: user.id, passwordHash: 'hash-40' })).not.toBeNull();
	});

	it('41: writeFormSecret writes the form key sealed, and a form token signed with it holds', () => {
		db.delete(settings).where(eq(settings.key, 'request_form_secret')).run();
		resetFormSecretCache();

		writeFormSecret();

		expect(isSealed(setting('request_form_secret'))).toBe(true);
		expect(readOpened('settings', 'request_form_secret')).toMatch(/^[0-9a-f]{64}$/);
		const token = issueFormToken();
		resetFormSecretCache();
		expect(verifyFormToken(token)).toBe(true);
	});
});
