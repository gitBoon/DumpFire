/**
 * backup-destinations.ts — Remote storage destination providers for scheduled backups.
 *
 * Implements a common interface for uploading backup files to:
 * - SFTP/SCP (via ssh2-sftp-client)
 * - Amazon S3 / S3-compatible (via @aws-sdk/client-s3)
 * - Google Drive (via googleapis)
 * - OneDrive (via @microsoft/microsoft-graph-client + @azure/identity)
 */

import { error } from '@sveltejs/kit';
import SftpClient from 'ssh2-sftp-client';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { google, type Auth, type drive_v3 } from 'googleapis';
import { Client as GraphClient, RedirectHandlerOptions, RetryHandlerOptions } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';
import { createHash } from 'node:crypto';
import { readChoice, readNumber, readText, type RequestBody } from './request-body';
import { destinationPlace, serviceAccountJsonMasked, serviceAccountMissing, trimHost } from './backup-secrets';
import { readServiceAccountJson, serviceAccountKey, type ServiceAccountRefusal } from './service-account-json';
import {
	HOST_KEY_NOT_CONFIRMED,
	HOST_KEY_REFUSAL,
	confirmedHostKey,
	fingerprintOf,
	hostKeyText,
	pinFor,
	readHostKey,
	serverKeyFile,
	shownHostKey,
	typeOf,
	type HostKey
} from './ssh-host-key';
import { DRIVE_FILE_SCOPE, dumpfireFolderName } from '$lib/drive-scope';
import { ChangedMeanwhile, HeldMeanwhile, failureOf, plainFailure, withStop, type FailureWhat, type MaskSource } from './backup-failure';
import {
	DRIVE_REFUSAL,
	FOLDER_PATH_REFUSAL,
	ONEDRIVE_MAX_PAGES,
	driveBase,
	driveForm,
	driveSet,
	folderSegments,
	itemPath,
	nextPageUrl,
	savedDrive,
	shownFolder
} from './onedrive-address';

// ─── Common Interface ────────────────────────────────────────────────────────

/**
 * The name of a copy DumpFire makes (`copyName` in backup.ts): its time in UTC
 * to the millisecond (to the second before card 2415), `-manual` for ▶ Run Now,
 * `.db`. Every destination's listing keeps only names this matches (card 2941,
 * ruling R5), so retention never counts or removes a file DumpFire did not
 * make, and no other name reaches a delete.
 */
export const COPY_NAME = /^dumpfire-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?(?:-manual)?\.db$/;

/** Whether `name` is a copy DumpFire makes (`COPY_NAME`). */
export const isCopyName = (name: unknown): name is string => typeof name === 'string' && COPY_NAME.test(name);

/** The most of a far end's message the history, the mail and the toast carry (card 2941, ruling R10). */
export const MESSAGE_MAX = 300;

/** `text`, a far end's message, as Backup History, the mail and the toast carry it: at most `MESSAGE_MAX` characters. */
export function cappedMessage(text: unknown): string {
	const said = String(text ?? '');
	return said.length > MESSAGE_MAX ? `${said.slice(0, MESSAGE_MAX - 1)}…` : said;
}

/**
 * What an upload that resumed answers (card 3080, R-F): how many times a Google Drive session resumed within the
 * try that succeeded, and the last fault it resumed after, with the bytes Google held then. The other types answer
 * nothing.
 */
export type UploadAnswer = { resumes: number; lastResumed?: { err: unknown; atBytes: number } };

export interface BackupDestination {
	type: string;
	name: string;
	test(): Promise<{ success: boolean; message: string }>;
	/**
	 * Send `data` as `filename`. `guard` asks whether the destination has been put on hold, and throws if it has
	 * (card 3080, R-B): a destination that makes several requests (Google Drive's session) asks it before each; one
	 * that makes one call is asked by its caller, immediately before. `deadline` (a ▶ Run Now's first try, ms since
	 * the epoch) is when a destination that waits within a try (Google Drive's resumes) stops waiting and ends the
	 * try with its fault (the fix pass, B).
	 */
	upload(data: Buffer, filename: string, guard?: () => void, deadline?: number): Promise<void | UploadAnswer>;
	/**
	 * Whether a copy of `filename` of `size` bytes is already at the destination (card 3080, section 4.5): asked
	 * before a try again, so that a copy that arrived though its try failed is not sent twice. A name DumpFire does
	 * not make is refused. Google Drive has none: its session's own status says.
	 */
	uploadedAlready?(filename: string, size: number): Promise<boolean>;
	/** Whether an upload of a name already there replaces it (SFTP, S3, OneDrive), so a copy not checked is sent again. */
	overwritesByName?: boolean;
	/** How many times a Google Drive session has resumed in this destination's run, over all its tries (R-F). */
	resumedInAll?: number;
	list(): Promise<string[]>;
	/**
	 * Remove one backup. A destination that moved it to a trash, where it can
	 * still be read for a time, says so with 'trashed' (card 2238).
	 */
	delete(filename: string): Promise<void | 'trashed'>;
	/**
	 * The backups retention may remove, oldest first, and those it may not and
	 * leaves where they are (card 2238). A destination without it is counted
	 * from `list()`, every file of which retention may remove.
	 */
	listForRetention?(): Promise<{ removable: string[]; setAside: string[] }>;
}

// ─── Destination Config Types ────────────────────────────────────────────────

export interface SftpDestinationConfig {
	type: 'sftp';
	name: string;
	host: string;
	/** null is the default, 22: a Port box cleared sends null. */
	port: number | null;
	username: string;
	password?: string;
	privateKey?: string;
	remotePath: string;
	/**
	 * The server's host key as it was confirmed (card 2250), `<type>
	 * SHA256:<43 characters>` (ssh-host-key.ts); empty or absent for none. No
	 * connect sends anything to a server without one, and every connect with
	 * one refuses any other key before a credential is sent.
	 */
	hostKey?: string;
}

export interface S3DestinationConfig {
	type: 's3';
	name: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	prefix: string;
	endpoint?: string; // For S3-compatible (MinIO, Backblaze, DigitalOcean Spaces)
}

export interface GDriveDestinationConfig {
	type: 'gdrive';
	name: string;
	authMethod: 'service_account' | 'oauth'; // 'service_account' for enterprise, 'oauth' for personal
	/**
	 * The JSON key file Google gives for a service account (service_account
	 * mode), as stored: rebuilt by the one rule to the fields DumpFire uses,
	 * or '' (card 2939, service-account-json.ts). None, or '', under OAuth.
	 */
	serviceAccountJson?: string;
	clientId?: string;           // Google OAuth Client ID (oauth mode)
	clientSecret?: string;       // Google OAuth Client Secret (oauth mode)
	refreshToken?: string;       // Stored after OAuth consent flow (oauth mode)
	/**
	 * The scope Google granted the refresh token, as Connect recorded it (card
	 * 2188); none for a connection made before, or where Google named none.
	 * `driveScopeIsNarrow` in `$lib/drive-scope` reads it.
	 */
	grantedScope?: string;
	folderId: string;
}

export interface OneDriveDestinationConfig {
	type: 'onedrive';
	name: string;
	tenantId: string;
	clientId: string;
	clientSecret: string;
	folderPath: string; // e.g. '/DumpFire Backups'
	/**
	 * Whose OneDrive (card 2941): a user's sign-in name or object ID, or a
	 * drive ID (`b!…`), by onedrive-address.ts's rule; none, or '', for an
	 * entry saved before, which is not tried until it is set.
	 */
	drive?: string;
}

export type DestinationConfig =
	| SftpDestinationConfig
	| S3DestinationConfig
	| GDriveDestinationConfig
	| OneDriveDestinationConfig;

// ─── SFTP Provider ───────────────────────────────────────────────────────────

export class SftpDestination implements BackupDestination {
	type = 'sftp';
	name: string;

	constructor(private config: SftpDestinationConfig) {
		this.name = config.name;
	}

	private createClient(): SftpClient {
		return new SftpClient();
	}

	/** Where the destination connects, as its messages name it. */
	private get address(): string {
		return `${this.config.host}:${this.config.port || 22}`;
	}

	/**
	 * The configuration every connect but a Test's first look is made with
	 * (card 2250, decision 4): the stored secret, a `hostVerifier` that answers
	 * whether the fingerprint of the key the server presents is the confirmed
	 * one, and the confirmed key's type pinned in `algorithms.serverHostKey`.
	 * ssh2 asks the verifier inside the key exchange, and authenticates only
	 * after it, so a key refused is refused before any credential is sent. The
	 * key presented, and whether it matched, are written into `seen`, so that a
	 * refusal can name it.
	 *
	 * With no key confirmed it throws `HostKeyNotConfirmed`, and no connection
	 * is opened, however an upload, a listing or a delete is reached (R7).
	 */
	private getConnectConfig(seen: HostKeySeen = { presented: null, matched: false }) {
		const key = confirmedHostKey(this.config.hostKey);
		if (key === null) throw new HostKeyNotConfirmed();
		const cfg: Record<string, unknown> = {
			host: this.config.host,
			port: this.config.port || 22,
			username: this.config.username,
			hostVerifier: (blob: Buffer) => {
				seen.presented = shownHostKey(blob);
				seen.matched = fingerprintOf(blob) === key.fingerprint;
				return seen.matched;
			},
			algorithms: { serverHostKey: pinFor(key.type) }
		};
		if (this.config.privateKey) {
			cfg.privateKey = this.config.privateKey;
		} else if (this.config.password) {
			cfg.password = this.config.password;
		}
		return cfg;
	}

	/**
	 * Connect `sftp` with the confirmed key, or throw why not: a key that does
	 * not match (`HostKeyMismatch`, decision 5), a server that no longer offers
	 * a key of the confirmed type (`HostKeyTypeNotOffered`, R3), the confirmed
	 * key shown by a server that could not sign with it
	 * (`HostKeySignatureFailed`, the review's S4), or whatever else the connect
	 * threw. ssh2's own words are read only for the second and the third: the
	 * negotiation ends before any key is presented, and ssh2 checks the
	 * signature over the exchange only after the verifier said yes, so nothing
	 * else says them. Either way nothing secret has been sent.
	 */
	private async connect(sftp: SftpClient): Promise<void> {
		const seen: HostKeySeen = { presented: null, matched: false };
		const config = this.getConnectConfig(seen);
		const key = confirmedHostKey(this.config.hostKey) as HostKey;
		try {
			await sftp.connect(config);
		} catch (err) {
			const said = String((err as Error)?.message ?? '');
			if (seen.presented !== null && !seen.matched) throw new HostKeyMismatch(this.address, seen.presented, key);
			if (seen.presented === null && /no matching host key format/.test(said)) {
				throw new HostKeyTypeNotOffered(this.address, key);
			}
			if (seen.matched && /signature verification failed/i.test(said)) throw new HostKeySignatureFailed(this.address, key);
			throw err;
		}
	}

	/**
	 * A Test of a destination with no confirmed key (decision 2, R6): a connect
	 * with a verifier that records the key it is handed and answers false, so
	 * that the connection ends inside the key exchange and nothing is
	 * authenticated. Its configuration is built here, with no password,
	 * private key or passphrase in it: ssh2 parses a private key before the
	 * socket opens, and nothing secret belongs in a connect aimed at a host not
	 * confirmed. No directory is made.
	 */
	private async firstLook(): Promise<SftpTestResult> {
		const sftp = this.createClient();
		const seen: { blob: Buffer | null } = { blob: null };
		try {
			await sftp.connect({
				host: this.config.host,
				port: this.config.port || 22,
				username: this.config.username,
				hostVerifier: (blob: Buffer) => {
					seen.blob = Buffer.from(blob);
					return false;
				},
				readyTimeout: FIRST_LOOK_TIMEOUT_MS
			} as Record<string, unknown>);
		} catch (err: any) {
			if (seen.blob === null) return { success: false, message: withStop(plainFailure(this.config, err, { what: 'test' })) };
		} finally {
			try { await sftp.end(); } catch {}
		}
		const blob = seen.blob;
		if (blob === null) return { success: false, message: `The SFTP server at ${this.address} presented no host key` };
		const shown = shownHostKey(blob);
		return {
			success: false,
			message:
				`SFTP host key not confirmed: the server at ${this.address} presented the host key ${shown}. Check it is ` +
				`the server's own (on the server: ssh-keygen -lf ${serverKeyFile(typeOf(blob))}) and confirm it. Nothing ` +
				'was sent to the server.',
			hostKey: shown
		};
	}

	/**
	 * Connect, make the remote folder if it is missing, and say so. With no key
	 * confirmed it takes a first look instead, and shows the key the server
	 * presented (decision 2). A key refused answers the key presented, if any,
	 * and the confirmed one (decision 10, R3), which the test route writes its
	 * one ERROR line from. A signature that failed is thrown
	 * (`HostKeySignatureFailed`, the review's S4), for the test route to name:
	 * its answer has the same keys as R3's.
	 */
	async test(): Promise<SftpTestResult> {
		if (confirmedHostKey(this.config.hostKey) === null) return this.firstLook();
		const sftp = this.createClient();
		try {
			await this.connect(sftp);
			// Check if remote directory exists, create if not
			const exists = await sftp.exists(this.config.remotePath);
			if (!exists) {
				await sftp.mkdir(this.config.remotePath, true);
			}
			await sftp.end();
			return { success: true, message: `Connected to ${this.address}` };
		} catch (err: any) {
			try { await sftp.end(); } catch {}
			if (err instanceof HostKeyMismatch) {
				return { success: false, message: err.message, hostKey: err.presented, confirmedHostKey: err.confirmed };
			}
			if (err instanceof HostKeyTypeNotOffered) return { success: false, message: err.message, confirmedHostKey: err.confirmed };
			if (err instanceof HostKeySignatureFailed) throw err;
			return { success: false, message: withStop(plainFailure(this.config, err, { what: 'test' })) };
		}
	}

	overwritesByName = true;

	/** Where `filename` goes in the remote folder. */
	private remoteFile(filename: string): string {
		return `${this.config.remotePath.replace(/\/+$/, '')}/${filename}`;
	}

	/**
	 * Whether `filename` is in the remote folder at `size` bytes (card 3080): connected with the confirmed key, and
	 * `stat`. "No such file" is not there; a shorter file a dropped `put` left is not equal, and the next `put`,
	 * which truncates, replaces it.
	 */
	async uploadedAlready(filename: string, size: number): Promise<boolean> {
		if (!isCopyName(filename)) throw new Error(NOT_A_COPY_NAME);
		const sftp = this.createClient();
		try {
			await this.connect(sftp);
			let found = false;
			try {
				const stats = await sftp.stat(this.remoteFile(filename));
				found = stats.isFile !== false && stats.size === size;
			} catch (err: any) {
				if (err?.code !== 'ENOENT') throw err;
			}
			await sftp.end();
			return found;
		} catch (err) {
			try { await sftp.end(); } catch {}
			throw err;
		}
	}

	async upload(data: Buffer, filename: string): Promise<void> {
		const sftp = this.createClient();
		try {
			await this.connect(sftp);
			const exists = await sftp.exists(this.config.remotePath);
			if (!exists) {
				await sftp.mkdir(this.config.remotePath, true);
			}
			await sftp.put(data, this.remoteFile(filename));
			await sftp.end();
		} catch (err) {
			try { await sftp.end(); } catch {}
			throw err;
		}
	}

	async list(): Promise<string[]> {
		const sftp = this.createClient();
		try {
			await this.connect(sftp);
			const files = await sftp.list(this.config.remotePath);
			await sftp.end();
			// Regular files alone (the fix pass's C2): a folder or a link of a copy's name is never one.
			return files
				.filter(f => f.type === '-')
				.map(f => f.name)
				.filter(isCopyName)
				.sort();
		} catch (err) {
			try { await sftp.end(); } catch {}
			throw err;
		}
	}

	async delete(filename: string): Promise<void> {
		const sftp = this.createClient();
		try {
			await this.connect(sftp);
			const remotePath = `${this.config.remotePath.replace(/\/+$/, '')}/${filename}`;
			await sftp.delete(remotePath);
			await sftp.end();
		} catch (err) {
			try { await sftp.end(); } catch {}
			throw err;
		}
	}
}

/**
 * What an SFTP Test answers (card 2250, decision 10): as every destination's,
 * and `hostKey`, the key the server presented, where it was not confirmed or
 * did not match, and `confirmedHostKey`, the stored one, where a key was
 * refused (R3: with no `hostKey` where the server offered no key of its type).
 */
export type SftpTestResult = { success: boolean; message: string; hostKey?: string; confirmedHostKey?: string };

/** How long a Test's first look waits for the handshake: ssh2's own default, written out. */
const FIRST_LOOK_TIMEOUT_MS = 20_000;

/** What a connect's verifier saw: the key the server presented, as a Test shows it, and whether it is the confirmed one. */
type HostKeySeen = { presented: string | null; matched: boolean };

/** An SFTP destination with no confirmed host key, at a connect other than a Test's first look (R7). Nothing is opened. */
export class HostKeyNotConfirmed extends Error {
	constructor() {
		super(HOST_KEY_NOT_CONFIRMED);
		this.name = 'HostKeyNotConfirmed';
	}
}

/** A server that presented a key other than the confirmed one (decision 5): refused before any credential. */
export class HostKeyMismatch extends Error {
	/** The key presented, `<type> SHA256:…`. */
	readonly presented: string;
	/** The confirmed key, as stored. */
	readonly confirmed: string;

	constructor(address: string, presented: string, confirmed: HostKey) {
		super(
			`SFTP host key refused: the server at ${address} presented the host key ${presented}, not the confirmed ` +
				`${confirmed.fingerprint}, ` +
				"so nothing was sent to it. If the server's key was changed on purpose, check the new key on the server and " +
				'confirm it, typing the password or private key again; otherwise something else may be answering for the server.'
		);
		this.name = 'HostKeyMismatch';
		this.presented = presented;
		this.confirmed = hostKeyText(confirmed);
	}
}

/** A server that no longer offers a key of the confirmed type (R3): the handshake ends before any key is presented. */
export class HostKeyTypeNotOffered extends Error {
	/** The confirmed key, as stored. */
	readonly confirmed: string;

	constructor(address: string, confirmed: HostKey) {
		super(
			`SFTP host key refused: the server at ${address} no longer offers a host key of the confirmed type ` +
				`(${confirmed.type}), so nothing ` +
				"was sent to it. If the server's keys were changed on purpose, clear the Host key or replace it with the " +
				"server's new key, typing the password or private key again, then press Test; otherwise something else may " +
				'be answering for the server.'
		);
		this.name = 'HostKeyTypeNotOffered';
		this.confirmed = hostKeyText(confirmed);
	}
}

/**
 * A server that presented the confirmed key and then could not sign the
 * exchange with it (the card 2250 review's S4): a replay of the real server's
 * public key by something that does not hold its private key. ssh2 checks the
 * signature after the verifier, before any credential.
 */
export class HostKeySignatureFailed extends Error {
	/** The confirmed key, as stored. */
	readonly confirmed: string;

	constructor(address: string, confirmed: HostKey) {
		super(
			`SFTP host key refused: the server at ${address} showed the confirmed key but could not prove it holds it — ` +
				'something on the network may be answering for it. Nothing was sent.'
		);
		this.name = 'HostKeySignatureFailed';
		this.confirmed = hostKeyText(confirmed);
	}
}

// ─── Amazon S3 Provider ──────────────────────────────────────────────────────

export class S3Destination implements BackupDestination {
	type = 's3';
	name: string;
	private client: S3Client;
	/**
	 * The client the upload and its check use (card 3080's fix pass, L): one attempt, so the SDK does not try again
	 * inside one of the run's tries, which wait and look for the copy first. Keep Last and Test keep the SDK's own.
	 */
	private once: S3Client;

	constructor(private config: S3DestinationConfig) {
		this.name = config.name;
		const s3Config: Record<string, unknown> = {
			region: config.region || 'us-east-1',
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey
			}
		};
		if (config.endpoint) {
			s3Config.endpoint = config.endpoint;
			s3Config.forcePathStyle = true;
		}
		this.client = new S3Client(s3Config);
		this.once = new S3Client({ ...s3Config, maxAttempts: 1 });
	}

	private getKey(filename: string): string {
		const prefix = this.config.prefix?.replace(/\/+$/, '');
		return prefix ? `${prefix}/${filename}` : filename;
	}

	async test(): Promise<{ success: boolean; message: string }> {
		try {
			await this.client.send(new ListObjectsV2Command({
				Bucket: this.config.bucket,
				MaxKeys: 1,
				Prefix: this.config.prefix || ''
			}));
			return { success: true, message: `Connected to S3 bucket "${this.config.bucket}"` };
		} catch (err: any) {
			return { success: false, message: withStop(plainFailure(this.config, err, { what: 'test' })) };
		}
	}

	overwritesByName = true;

	/**
	 * Whether the key `filename` goes to holds `size` bytes (card 3080): one listing with the exact key as its prefix
	 * and `MaxKeys` 1, so only `s3:ListBucket` is needed, as Keep Last needs (no `HeadObject`, which needs
	 * `s3:GetObject`). It does not touch `listed` (R-K), which only Keep Last's listing fills.
	 */
	async uploadedAlready(filename: string, size: number): Promise<boolean> {
		if (!isCopyName(filename)) throw new Error(NOT_A_COPY_NAME);
		const key = this.getKey(filename);
		const result = await this.once.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: key, MaxKeys: 1 }));
		const found = result.Contents?.[0];
		return found?.Key === key && found?.Size === size;
	}

	async upload(data: Buffer, filename: string): Promise<void> {
		await this.once.send(new PutObjectCommand({
			Bucket: this.config.bucket,
			Key: this.getKey(filename),
			Body: data,
			ContentType: 'application/x-sqlite3'
		}));
	}

	/** The keys the last listing found, which alone `delete` removes (card 2941, C1). */
	private listed = new Set<string>();

	/**
	 * The copies directly under the prefix, oldest first (card 2941, C1, which
	 * took in card 2991): listed under the prefix and a `/`, one level only
	 * (`Delimiter`), so that a sibling prefix (`dumpfire-old/` beside
	 * `dumpfire`) and a key in a folder below are not counted, every page
	 * (`ContinuationToken`) up to `S3_MAX_PAGES`, and only a key that is
	 * exactly where an upload of its name puts it. It read one page of 1,000
	 * keys, any of them under the prefix's text, by the last part of its key.
	 */
	async list(): Promise<string[]> {
		const trimmed = this.config.prefix?.replace(/\/+$/, '') ?? '';
		const prefix = trimmed ? `${trimmed}/` : '';
		const names: string[] = [];
		const keys = new Set<string>();
		let token: string | undefined;
		let pages = 0;
		do {
			if (++pages > S3_MAX_PAGES) throw new Error(`S3 listing of the backup prefix went on for more than ${S3_MAX_PAGES} pages`);
			const result = await this.client.send(new ListObjectsV2Command({
				Bucket: this.config.bucket,
				Prefix: prefix,
				Delimiter: '/',
				ContinuationToken: token
			}));
			for (const obj of result.Contents || []) {
				const key = obj.Key ?? '';
				const name = key.startsWith(prefix) ? key.slice(prefix.length) : '';
				if (isCopyName(name) && key === this.getKey(name)) {
					names.push(name);
					keys.add(key);
				}
			}
			token = result.IsTruncated ? result.NextContinuationToken : undefined;
		} while (token);
		this.listed = keys;
		return names.sort();
	}

	/** Remove a copy the last listing found, by its key; any other is refused (card 2941, C1). */
	async delete(filename: string): Promise<void> {
		const key = this.getKey(filename);
		if (!this.listed.has(key)) throw new Error(S3_NOT_LISTED);
		await this.client.send(new DeleteObjectCommand({
			Bucket: this.config.bucket,
			Key: key
		}));
		this.listed.delete(key);
	}
}

/** The most pages of 1,000 keys an S3 listing reads before it gives up, as OneDrive's (card 2941, C1). */
export const S3_MAX_PAGES = 100;

/** What a destination's check for a copy refuses a name DumpFire does not make with (card 3080; card 2941, R5). */
export const NOT_A_COPY_NAME = 'DumpFire looks only for a backup of a name it makes';

/** What an S3 delete of a copy the last listing did not find throws (card 2941, C1). */
export const S3_NOT_LISTED = 'S3 removes only a backup it has just listed for retention';

// ─── Google Drive Provider ───────────────────────────────────────────────────

export class GDriveDestination implements BackupDestination {
	type = 'gdrive';
	name: string;

	constructor(private config: GDriveDestinationConfig) {
		this.name = config.name;
	}

	/**
	 * The signed-in auth client (card 3080: `getDrive`'s setup, refactored, so that the upload's session can send
	 * its own requests through it): the OAuth2 client with the refresh token, or the service account's JWT.
	 */
	private async getAuth(): Promise<Auth.OAuth2Client> {
		if (this.config.authMethod === 'oauth') {
			// OAuth2 flow — use client credentials + refresh token
			if (!this.config.clientId || !this.config.clientSecret || !this.config.refreshToken) {
				throw new Error('Google Drive OAuth not configured — connect your account first');
			}
			const oauth2Client = new google.auth.OAuth2(
				this.config.clientId,
				this.config.clientSecret
			);
			oauth2Client.setCredentials({ refresh_token: this.config.refreshToken });
			return oauth2Client;
		} else {
			// A service account (card 2939): its key read by the one rule, once,
			// and a JWT built from that key's fields alone. The JSON never reaches
			// the library: `GoogleAuth({ credentials })` would pick its way to sign
			// in by the JSON's `type`, and an `external_account` JSON reads any
			// file the server can read and posts it to an address of the sender's
			// choosing. JSON that is not a key throws the run's own sentence, never
			// a parse error, which would quote the text.
			const account = serviceAccountKey(this.config.serviceAccountJson);
			if (account === null) throw new Error(serviceAccountMissing(this.config.serviceAccountJson));
			// A literal of exactly these four, never a spread (ruling P5): the
			// constructor chain reads `universe_domain`, `quota_project_id`,
			// `credentials`, `transporterOptions`, endpoints, `clientAuthentication`,
			// `client_secret` and more from its options, and `keyFile` names a file
			// it reads. None of them may come from the stored JSON.
			const auth = new google.auth.JWT({
				email: account.email,
				key: account.key,
				keyId: account.keyId,
				scopes: [DRIVE_FILE_SCOPE]
			});
			return auth;
		}
	}

	private async getDrive() {
		return google.drive({ version: 'v3', auth: await this.getAuth() });
	}

	async test(): Promise<{ success: boolean; message: string }> {
		try {
			const drive = await this.getDrive();
			if (this.config.folderId) {
				// The folder fetched first, as an upload would meet it (card 2188,
				// decision 8): a listing of a folder the account cannot see answers
				// "0 existing files", as if it were empty.
				const reached = await reachFolder(drive, this.config.folderId, this.config, 'test');
				if (!reached.reached) {
					return { success: false, message: `Google Drive cannot reach the folder "${this.config.folderId}": ${reached.reason}` };
				}
				// List files in the folder to verify access
				const res = await drive.files.list({
					q: `'${this.config.folderId}' in parents and trashed = false`,
					pageSize: 1,
					fields: 'files(id,name)',
					supportsAllDrives: true,
					includeItemsFromAllDrives: true
				});
				const count = res.data.files?.length ?? 0;
				return { success: true, message: `Connected to Google Drive folder (${count} existing file${count !== 1 ? 's' : ''})` };
			} else {
				// No folder specified — just verify credentials work
				await drive.files.list({ pageSize: 1, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
				return { success: true, message: 'Connected to Google Drive (no folder specified — will upload to root)' };
			}
		} catch (err: any) {
			return { success: false, message: withStop(plainFailure(this.config, err, { what: 'test' })) };
		}
	}

	/**
	 * The session this run's upload goes through (card 3080, R-A): its address, held in memory only and never logged
	 * or written anywhere, and the copy it is for. Kept from one try to the next, so a later try asks its status.
	 */
	private session: { uri: string; filename: string; size: number } | null = null;

	/** How many times the session has resumed in this run, over all its tries (R-F). */
	resumedInAll = 0;

	/** Google Drive's session is its own check: no `uploadedAlready`, and a name is never written twice. */
	overwritesByName = false;

	/**
	 * Send `data` as `filename` through a resumable session (card 3080, R-A): one POST that opens it, then PUTs of
	 * `DRIVE_CHUNK` bytes each, every request through the signed-in auth client with gaxios's own retries off, and
	 * `guard` asked before each. A chunk answered with a passing fault, or a session Google has lost (404, 410), is
	 * resumed within the try: after a wait (1, 2, 4, 8, 16 s, or the far end's Retry-After up to 2 minutes) the
	 * session's status says which bytes Google holds, and the upload carries on from there, so a 502 halfway costs one
	 * chunk. A resume is not a try: after `DRIVE_RESUMES` in a row without progress the try ends with the last fault,
	 * a passing one. A fault that does not pass ends the try at once, as does a POST that fails (no session yet, so
	 * nothing is at Google). A later try begins with the kept session's status, not a POST, so a try that ended without
	 * knowing whether its last chunk landed never makes a second file; a session gone is opened again from the first
	 * byte. Google's answer on completion must hold the copy's size and MD5 (`DriveStoredOtherwise`).
	 *
	 * `files.create` with media could not do this: googleapis sends it as one multipart request, so a retry sent all
	 * of the copy again, and gaxios does not retry a POST.
	 */
	async upload(data: Buffer, filename: string, guard: () => void = () => {}, deadline?: number): Promise<UploadAnswer> {
		const auth = await this.getAuth();
		const total = data.length;
		const md5 = createHash('md5').update(data).digest('hex');
		const kept = this.session !== null && this.session.filename === filename && this.session.size === total;
		/** What is asked next: a new session, the session's status, or the bytes from `next`. */
		let step: 'open' | 'status' | 'send' = kept ? 'status' : 'open';
		/** The first byte Google does not hold, as last known: where the next chunk starts. */
		let next = 0;
		let resumes = 0;
		/** Resumes in a row since Google last held more bytes. */
		let stalled = 0;
		let lastResumed: { err: unknown; atBytes: number } | undefined;
		let lastFault: unknown = undefined;
		/** Whether the status being asked follows a fault. */
		let resuming = false;

		/** Google holds the bytes before `bytes`: more than before is progress, and resets the count of resumes. */
		const holds = (bytes: number) => {
			if (bytes > next) stalled = 0;
			next = bytes;
		};

		for (;;) {
			try {
				// The hold and the settings, asked before every request that reaches Google (R-B, R-C), with nothing
				// awaited between.
				guard();
				if (step === 'open') {
					this.session = null;
					const uri = await this.openSession(auth, filename, total);
					this.session = { uri, filename, size: total };
					next = 0;
					step = 'send';
					continue;
				}
				const uri = this.session!.uri;
				if (step === 'status') {
					const answer = await this.sessionRequest(auth, uri, { 'Content-Range': `bytes */${total}`, 'Content-Length': '0' });
					if (answer.status !== 308) return await this.completed(auth, answer.data, total, md5, guard, { resumes, lastResumed });
					holds(rangeEnd(answer.headers));
					// What Google confirmed it holds, not what was last known before the fault (the fix pass, M).
					if (resuming && lastResumed !== undefined) lastResumed.atBytes = next;
					// The last resume in a row without progress ends the try with its fault (R-A).
					if (resuming && stalled >= DRIVE_RESUMES) break;
					resuming = false;
					step = 'send';
					continue;
				}
				const start = next;
				const end = Math.min(next + DRIVE_CHUNK, total);
				const answer = await this.sessionRequest(
					auth,
					uri,
					{ 'Content-Range': `bytes ${start}-${end - 1}/${total}`, 'Content-Length': String(end - start) },
					data.subarray(start, end)
				);
				if (answer.status !== 308) return await this.completed(auth, answer.data, total, md5, guard, { resumes, lastResumed });
				const held = rangeEnd(answer.headers);
				// A 308 that holds nothing past where the chunk began is a stall (the fix pass, A): resumed as a fault
				// that passes, with the same waits and the same cap, so it never loops without a wait.
				if (held <= start) {
					next = held;
					throw new DriveStalled();
				}
				holds(held);
			} catch (err) {
				if (err instanceof HeldMeanwhile || err instanceof ChangedMeanwhile || err instanceof DriveStoredOtherwise || step === 'open') throw err;
				const failure = failureOf(this.config, err);
				const gone = failure.status === 404 || failure.status === 410;
				// The session gone at its status: a new one, from the first byte, in the same try.
				if (gone && step === 'status') {
					step = 'open';
					continue;
				}
				if (!failure.temporary && !gone) throw err;
				if (stalled >= DRIVE_RESUMES) throw err;
				const wait = failure.retryAfterMs ?? DRIVE_RESUME_WAITS_MS[Math.min(stalled + 1, DRIVE_RESUME_WAITS_MS.length) - 1];
				// A ▶ Run Now's first try ends where a wait would cross its deadline (the fix pass, B): with the fault,
				// which passes, and the session kept, so the try again in the background asks its status and sends only
				// what Google does not hold.
				if (deadline !== undefined && Date.now() + wait > deadline) throw err;
				// A resume (R-A): wait, then ask the session's status.
				lastFault = err;
				stalled++;
				resumes++;
				this.resumedInAll++;
				lastResumed = { err, atBytes: next };
				// On the global setTimeout, so that a test's fake clock moves it.
				await new Promise<void>((resolve) => setTimeout(resolve, wait));
				resuming = true;
				step = 'status';
			}
		}
		throw lastFault;
	}

	/**
	 * Open a session for `filename` of `total` bytes in the folder (R-A), and answer its address: Google's `Location`,
	 * which must be under Google's upload address, since the copy and the bearer token go to it. One elsewhere is
	 * refused (`DriveSessionElsewhere`), its address said nowhere.
	 */
	private async openSession(auth: Auth.OAuth2Client, filename: string, total: number): Promise<string> {
		const answer = await auth.request({
			url: `${DRIVE_UPLOAD_URL}?uploadType=resumable&supportsAllDrives=true&fields=id,size,md5Checksum`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json; charset=UTF-8',
				'X-Upload-Content-Type': 'application/x-sqlite3',
				'X-Upload-Content-Length': String(total)
			},
			data: JSON.stringify({ name: filename, parents: [this.config.folderId] }),
			responseType: 'json',
			retry: false
		});
		const uri = headerIn(answer.headers, 'location') ?? '';
		if (!uri.startsWith(`${DRIVE_UPLOAD_URL}?`)) throw new DriveSessionElsewhere();
		return uri;
	}

	/** One PUT to the session: a chunk, or (with no body) its status. 2xx is complete, 308 holds part; anything else throws. */
	private async sessionRequest(auth: Auth.OAuth2Client, uri: string, headers: Record<string, string>, body?: Buffer) {
		return auth.request<unknown>({
			url: uri,
			method: 'PUT',
			headers,
			...(body === undefined ? {} : { data: body }),
			validateStatus: (status: number) => (status >= 200 && status < 300) || status === 308,
			responseType: 'json',
			retry: false
		});
	}

	/**
	 * The session's completion (R-A): the file Google made must be the copy's size and MD5. Where the answer names
	 * the file but not its size or checksum, they are read by its id (`files.get`, the hold asked first; the fix pass,
	 * K). The session is done with once the file is checked; a read that fails keeps it, and the resume that follows
	 * asks its status again.
	 */
	private async completed(auth: Auth.OAuth2Client, body: unknown, total: number, md5: string, guard: () => void, answer: UploadAnswer): Promise<UploadAnswer> {
		let file: Record<string, unknown> = {};
		try {
			const read = typeof body === 'string' ? JSON.parse(body) : body;
			if (read && typeof read === 'object') file = read as Record<string, unknown>;
		} catch {
			// Not JSON: neither size nor checksum, so refused below.
		}
		if (typeof file.id === 'string' && file.id !== '' && (file.size === undefined || file.md5Checksum === undefined)) {
			guard();
			const drive = google.drive({ version: 'v3', auth });
			const got = await drive.files.get({ fileId: file.id, fields: 'size,md5Checksum', supportsAllDrives: true });
			file = { ...file, ...(got.data as Record<string, unknown>) };
		}
		this.session = null;
		if (Number(file.size) !== total || file.md5Checksum !== md5) throw new DriveStoredOtherwise();
		return answer;
	}

	/**
	 * Every backup in the folder, oldest first, with what this account may do
	 * to it. Drive answers 100 files a page unless asked for more, and a folder
	 * can hold more than one page of either, so every page is read.
	 */
	private async listBackups(): Promise<GDriveBackupFile[]> {
		const drive = await this.getDrive();
		const files: GDriveBackupFile[] = [];
		let pageToken: string | undefined;
		let pages = 0;
		do {
			// A token Drive answers again and again would otherwise list for
			// ever; 100 pages of 1,000 is far past any folder of backups.
			if (++pages > GDRIVE_MAX_PAGES) {
				throw new Error(`Google Drive listing of the backup folder went on for more than ${GDRIVE_MAX_PAGES} pages`);
			}
			const res = await drive.files.list({
				q: `'${this.config.folderId}' in parents and trashed = false and name contains 'dumpfire-backup-'`,
				fields: 'nextPageToken, files(id, name, capabilities(canDelete, canTrash))',
				orderBy: 'name',
				pageSize: 1000,
				pageToken,
				supportsAllDrives: true,
				includeItemsFromAllDrives: true
			});
			for (const f of res.data.files || []) {
				// Only a copy DumpFire makes (card 2941, R5): `contains` matches any name holding the text.
				if (!f.id || !isCopyName(f.name)) continue;
				files.push({
					id: f.id,
					name: f.name,
					canDelete: f.capabilities?.canDelete === true,
					canTrash: f.capabilities?.canTrash === true
				});
			}
			pageToken = res.data.nextPageToken || undefined;
		} while (pageToken);
		return files;
	}

	async list(): Promise<string[]> {
		return (await this.listBackups()).map(f => f.name);
	}

	/**
	 * The files listed for retention, by name, every one of a name in the order
	 * listed, so that `delete` removes a file that was listed, by its id, in the
	 * way the account may remove it. Nothing else is removed (card 2941, R5).
	 */
	private listed = new Map<string, GDriveBackupFile[]>();

	/**
	 * A file the account can see but may neither delete nor trash (one another
	 * identity made, or one in a Shared drive where the account is no Manager)
	 * is set aside: Drive answers a delete of it with 404 File not found, and
	 * it would be picked first on every run, being the oldest (card 2238).
	 */
	async listForRetention(): Promise<{ removable: string[]; setAside: string[] }> {
		const files = await this.listBackups();
		// Only removable files are kept by name, so that a set-aside file of the
		// same name as a removable one is never the one tried; every one of a name.
		this.listed = new Map();
		for (const f of files) {
			if (!(f.canDelete || f.canTrash)) continue;
			const same = this.listed.get(f.name);
			if (same) same.push(f);
			else this.listed.set(f.name, [f]);
		}
		const removable: string[] = [];
		const setAside: string[] = [];
		for (const f of files) (f.canDelete || f.canTrash ? removable : setAside).push(f.name);
		return { removable, setAside };
	}

	/**
	 * Remove the next file listed for retention under `filename`, by its id.
	 * A name not listed is refused: the lookup by name it made instead put the
	 * name into a query (card 2941, R5).
	 */
	async delete(filename: string): Promise<void | 'trashed'> {
		const same = this.listed.get(filename);
		const file = same?.shift();
		if (!file) throw new Error(GDRIVE_NOT_LISTED);
		if (same && same.length === 0) this.listed.delete(filename);
		const drive = await this.getDrive();
		if (file.canDelete) {
			await drive.files.delete({ fileId: file.id, supportsAllDrives: true });
			return;
		}
		// Only to the trash, where Drive keeps it for 30 days.
		await drive.files.update({ fileId: file.id, requestBody: { trashed: true }, supportsAllDrives: true });
		return 'trashed';
	}
}

/** Where Google Drive takes an upload, and the only place a session's address may be (card 3080). */
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

/** How much of a copy each request of a Google Drive session sends: 8 MiB, 32 times Google's required 256 KiB (R-A). */
export const DRIVE_CHUNK = 8 * 1024 * 1024;

/** The most resumes in a row without progress within one try (R-A); the next ends the try with its fault. */
export const DRIVE_RESUMES = 5;

/** The waits before each resume in a row without progress: 1, 2, 4, 8 and 16 s, 31 s in all (R-A). */
export const DRIVE_RESUME_WAITS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** What a Google Drive session answers in its completion where it holds other bytes than were sent (card 3080). */
export class DriveStoredOtherwise extends Error {
	constructor() {
		super('Google Drive stored a file of a different size or content');
		this.name = 'DriveStoredOtherwise';
	}
}

/** A Google Drive session that took a chunk and held no more of the copy (the fix pass, A): it passes, and is resumed. */
export class DriveStalled extends Error {
	constructor() {
		super('Google Drive took a chunk of the copy and held no more of it');
		this.name = 'DriveStalled';
	}
}

/** What a Google Drive session answered elsewhere than Google's upload address throws: the address is said nowhere. */
export class DriveSessionElsewhere extends Error {
	constructor() {
		super(`Google Drive answered an upload session outside ${DRIVE_UPLOAD_URL}, so nothing was sent to it`);
		this.name = 'DriveSessionElsewhere';
	}
}

/** A header of a gaxios answer (a fetch `Headers`, or a plain record), any case. */
function headerIn(headers: unknown, name: string): string | undefined {
	if (headers && typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
	if (headers && typeof headers === 'object') {
		for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return String(value);
	}
	return undefined;
}

/** The first byte a session's 308 says it does not hold yet: after its `Range: bytes=0-n`, or 0 where it names none. */
function rangeEnd(headers: unknown): number {
	const range = /^bytes=0-(\d+)$/.exec(headerIn(headers, 'range')?.trim() ?? '');
	return range ? Number(range[1]) + 1 : 0;
}

/** What a Google Drive delete of a name not listed for retention throws (card 2941, R5). */
export const GDRIVE_NOT_LISTED = 'Google Drive removes only a backup it has just listed for retention';

/** The most pages of 1,000 files a Google Drive listing reads before it gives up. */
const GDRIVE_MAX_PAGES = 100;

/** What Google Drive calls a folder. */
const GDRIVE_FOLDER_TYPE = 'application/vnd.google-apps.folder';

/** The name of the folder Connect makes: in `$lib/drive-scope`, so the admin page names it too. */
export { dumpfireFolderName };

/**
 * Whether the account `drive` is signed in as can reach the folder `folderId`
 * (card 2188, decision 8): it is fetched (`files.get`), and must be a folder
 * that is not in the trash. Any error Google answers is "cannot reach", in
 * one plain sentence with no full stop (card 3080, `plainFailure`), masked
 * with `config`'s secrets. With `drive.file`, a folder DumpFire did not make may be one
 * Google does not let it see; this reads what Google answers rather than
 * depending on it. Used by Connect and by `GDriveDestination.test()`.
 */
export async function reachFolder(
	drive: drive_v3.Drive,
	folderId: string,
	config: MaskSource = { type: 'gdrive' },
	what: FailureWhat = 'test'
): Promise<{ reached: true } | { reached: false; reason: string }> {
	try {
		const res = await drive.files.get({ fileId: folderId, fields: 'id, name, mimeType, trashed', supportsAllDrives: true });
		if (res.data.mimeType !== GDRIVE_FOLDER_TYPE) return { reached: false, reason: 'it is not a folder' };
		if (res.data.trashed) return { reached: false, reason: 'it is in the trash' };
		return { reached: true };
	} catch (err: any) {
		return { reached: false, reason: plainFailure(config, err, { what }) };
	}
}

/** Make the folder Connect gives a destination whose Folder ID is empty, in the account's My Drive, and answer its id (card 2188). */
export async function makeDumpfireFolder(drive: drive_v3.Drive, now: Date = new Date()): Promise<{ id: string; name: string }> {
	const name = dumpfireFolderName(now);
	const res = await drive.files.create({ requestBody: { name, mimeType: GDRIVE_FOLDER_TYPE }, fields: 'id' });
	if (!res.data.id) throw new Error('Google Drive made the folder but did not answer its id');
	return { id: res.data.id, name };
}

/** A backup in a Google Drive folder, and what the account may do to it. */
interface GDriveBackupFile {
	id: string;
	name: string;
	canDelete: boolean;
	canTrash: boolean;
}

// ─── OneDrive Provider ───────────────────────────────────────────────────────

/**
 * A OneDrive destination through Microsoft Graph, signed in as the app
 * (`ClientSecretCredential`), at the drive its `drive` names (card 2941,
 * onedrive-address.ts). Every address is made before a token is asked for, so
 * a destination with no drive, or a drive or folder path refused, asks Graph
 * nothing. No request follows a redirect, a listing follows only Graph's own
 * next pages, and Graph's words are capped (`cappedMessage`).
 */
export class OneDriveDestination implements BackupDestination {
	type = 'onedrive';
	name: string;

	constructor(private config: OneDriveDestinationConfig) {
		this.name = config.name;
	}

	/** The item at the folder path, and `names` within it: thrown words where it cannot be addressed. */
	private item(...names: string[]): string {
		return itemPath(this.config.drive, this.config.folderPath, ...names);
	}

	/**
	 * `path` asked of `client`, never following a redirect (ruling R4). With `once`, Graph's own retries are off as
	 * well (card 3080): it otherwise tries a 429, 503 or 504 again up to three times, waiting up to 180 s each, inside
	 * one of the run's tries.
	 */
	private request(client: GraphClient, path: string, once = false) {
		const options = [new RedirectHandlerOptions(0, () => false), ...(once ? [new RetryHandlerOptions(0, 0)] : [])];
		return client.api(path).middlewareOptions(options);
	}

	/**
	 * `call`'s answer, or a throw with Graph's words capped (ruling R10), which keeps the status, code, headers,
	 * request id and name (card 3080), so the run can tell a passing failure and read its Retry-After.
	 */
	private async graph<T>(call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} catch (err: any) {
			const kept = new Error(cappedMessage(err?.message || 'OneDrive request failed')) as Error & Record<string, unknown>;
			for (const field of ['statusCode', 'code', 'headers', 'requestId'] as const) {
				if (err?.[field] !== undefined) kept[field] = err[field];
			}
			if (typeof err?.name === 'string' && err.name !== 'Error') kept.name = err.name;
			throw kept;
		}
	}

	private async getClient(): Promise<GraphClient> {
		const credential = new ClientSecretCredential(
			this.config.tenantId,
			this.config.clientId,
			this.config.clientSecret
		);
		const token = await credential.getToken('https://graph.microsoft.com/.default');

		return GraphClient.init({
			authProvider: (done) => {
				done(null, token.token);
			}
		});
	}

	/**
	 * The drive, which names its owner, then the folder: found, or not there
	 * yet (the first backup makes it), or a file. Makes nothing.
	 */
	async test(): Promise<{ success: boolean; message: string }> {
		let base: string;
		let folder: string;
		try {
			base = driveBase(this.config.drive);
			folder = this.item();
		} catch (err: any) {
			return { success: false, message: err.message };
		}
		const shown = shownFolder(this.config.folderPath);
		try {
			const client = await this.getClient();
			const drive = await this.request(client, `${base}?$select=id,driveType,owner`).get();
			const owner = drive?.owner?.user?.displayName ?? drive?.owner?.group?.displayName ?? 'its owner';
			const where = `Connected to ${cappedMessage(owner)}'s OneDrive (drive ${cappedMessage(drive?.driveType ?? 'of unknown type')})`;
			let item: any;
			try {
				item = await this.request(client, `${folder}?$select=id,folder`).get();
			} catch (err: any) {
				if (err?.statusCode === 404 || err?.code === 'itemNotFound') {
					return { success: true, message: `${where}; folder "${shown}" will be made by the first backup` };
				}
				throw err;
			}
			if (!item?.folder) return { success: false, message: `"${shown}" in that OneDrive is a file, not a folder` };
			return { success: true, message: `${where}; folder "${shown}" found` };
		} catch (err: any) {
			return { success: false, message: withStop(plainFailure(this.config, err, { what: 'test' })) };
		}
	}

	overwritesByName = true;

	/**
	 * Whether `filename` is in the folder at `size` bytes (card 3080): its item, with Graph's own retries off. 404 or
	 * `itemNotFound` is not there; any other failure is thrown, and the run uploads.
	 */
	async uploadedAlready(filename: string, size: number): Promise<boolean> {
		if (!isCopyName(filename)) throw new Error(NOT_A_COPY_NAME);
		const path = `${this.item(filename)}?$select=size,file`;
		const client = await this.graph(() => this.getClient());
		try {
			const item: any = await this.graph(() => this.request(client, path, true).get());
			return !!item?.file && item?.size === size;
		} catch (err: any) {
			if (err?.statusCode === 404 || err?.code === 'itemNotFound') return false;
			throw err;
		}
	}

	/** One PUT, which Graph takes up to 250 MB (card 2990 for larger), with Graph's own retries off (card 3080). */
	async upload(data: Buffer, filename: string): Promise<void> {
		const path = `${this.item(filename)}:/content`;
		const client = await this.graph(() => this.getClient());
		await this.graph(() => this.request(client, path, true).put(data));
	}

	/**
	 * Every copy in the folder, oldest first: every page Graph answers, up to
	 * `ONEDRIVE_MAX_PAGES`. Any failure throws (card 2941): it answered an empty
	 * folder, and retention said nothing. Files alone (`file` facet, the fix
	 * pass's C2): a folder of a copy's name is never one.
	 */
	async list(): Promise<string[]> {
		let path = `${this.item()}:/children?$select=name,file&$top=200`;
		const client = await this.graph(() => this.getClient());
		const names: string[] = [];
		for (let pages = 1; ; pages++) {
			if (pages > ONEDRIVE_MAX_PAGES) {
				throw new Error(`OneDrive listing of the backup folder went on for more than ${ONEDRIVE_MAX_PAGES} pages`);
			}
			const page: any = await this.graph(() => this.request(client, path).get());
			for (const f of page?.value ?? []) if (f?.file && isCopyName(f?.name)) names.push(f.name);
			const link = page?.['@odata.nextLink'];
			if (link === undefined || link === null) break;
			const next = nextPageUrl(link);
			if (next === null) throw new Error('OneDrive answered a next page outside https://graph.microsoft.com/v1.0/, so the listing was stopped');
			path = next;
		}
		return names.sort();
	}

	async delete(filename: string): Promise<void> {
		const path = this.item(filename);
		const client = await this.graph(() => this.getClient());
		await this.graph(() => this.request(client, path).delete());
	}
}

// ─── A destination, as a request sends it ────────────────────────────────────

/** The kinds of destination there are. */
export const DESTINATION_TYPES = ['sftp', 's3', 'gdrive', 'onedrive'] as const;

/** What each kind holds beside its `type` and `name`. Each is text, but an SFTP `port` and Google Drive's `authMethod`. */
const DESTINATION_FIELDS: Record<DestinationConfig['type'], readonly string[]> = {
	sftp: ['host', 'port', 'username', 'password', 'privateKey', 'remotePath', 'hostKey'],
	s3: ['region', 'bucket', 'accessKeyId', 'secretAccessKey', 'prefix', 'endpoint'],
	gdrive: ['authMethod', 'serviceAccountJson', 'clientId', 'clientSecret', 'refreshToken', 'folderId'],
	onedrive: ['tenantId', 'clientId', 'clientSecret', 'folderPath', 'drive']
};

/** The most a destination's text may hold, its name among them. */
const LONGEST_TEXT = 2048;

/**
 * The two that hold a file pasted in, and are longer than any address or
 * name: an SSH private key (one of 4,096 bits is about 3,300 characters) and a
 * Google service account's JSON (about 2,400). 2,048 would refuse both.
 */
const PASTED_FILES: Record<string, number> = { privateKey: 20000, serviceAccountJson: 20000 };

/**
 * A destination, from a request body or an entry of one (card 2117, R10): a
 * text `name`, a `type` of `sftp`, `s3`, `gdrive` or `onedrive`, and the fields
 * that type holds, each text but an SFTP `port` (a whole number from 1 to
 * 65535, or `null` for the default, 22, as a Port box cleared sends it) and
 * Google Drive's `authMethod` (`service_account` or `oauth`). Any
 * other field is not kept. Every field went into the settings as it was sent.
 * Text is at most 2,048 characters, but a private key and a service account's
 * JSON, at most 20,000. An SFTP `hostKey` is a host key fingerprint with its
 * type, saved as `<type> SHA256:<43>`, or empty for none (card 2250, R5).
 * A service account's JSON is read by the one rule and saved rebuilt, and
 * none but '' is taken with OAuth (card 2939, `readServiceAccountField`).
 * A OneDrive `drive` is a sign-in name, an object ID (saved in lower case) or
 * a drive ID, its `folderPath` folders none of them empty, `.`, `..` or
 * holding a character OneDrive refuses, and a OneDrive destination with no
 * drive is refused unless it is one stored with none at the same place (card
 * 2941, `legacyUnmoved`).
 *
 * `at` names the destination in a refusal (`destinations[2].port must be a
 * whole number from 1 to 65535`); none for a body that is one destination.
 * `stored` finds the destination saved under the name sent: a value it holds,
 * sent back unchanged, is kept as it is (decision 8). A secret sent back
 * masked, as the settings' GET sends it, is left as the mask here: whether it
 * is kept, and from which stored destination, is `keepMaskedSecrets`'s (in
 * backup-secrets.ts, card 2190), which both routes call next. `missing` is
 * the text for a name or a type not sent, where a route has its own.
 */
export function readDestination(
	entry: RequestBody,
	at: string | null,
	stored: (name: string) => DestinationConfig | undefined,
	missing?: string
): DestinationConfig {
	const prefix = at === null ? '' : `${at}.`;
	const name = readText(entry, 'name', {
		required: true,
		min: 1,
		max: LONGEST_TEXT,
		says: {
			missing: missing ?? `${prefix}name is required`,
			empty: missing ?? `${prefix}name cannot be empty`,
			type: `${prefix}name must be text`,
			invalid: `${prefix}name must be at most ${LONGEST_TEXT} characters`
		}
	});
	const oneOf = `${prefix}type must be one of: ${DESTINATION_TYPES.join(', ')}`;
	const type = readChoice(entry, 'type', {
		required: true,
		from: DESTINATION_TYPES,
		says: { missing: missing ?? `${prefix}type is required`, type: oneOf, invalid: oneOf }
	});
	const saved = stored(name) as Record<string, unknown> | undefined;

	const destination: Record<string, unknown> = { type, name };
	for (const field of DESTINATION_FIELDS[type]) {
		const keep = saved?.[field];
		let value: unknown;
		if (field === 'port') {
			// null is 22 when the destination connects (`port || 22`), as it was
			// before card 2117 (its second fix pass).
			value = readNumber(entry, field, {
				whole: true,
				min: 1,
				max: 65535,
				nullable: true,
				keep,
				says: { type: `${prefix}port must be a whole number`, invalid: `${prefix}port must be a whole number from 1 to 65535` }
			});
		} else if (field === 'authMethod') {
			value = readChoice(entry, field, {
				from: ['service_account', 'oauth'],
				keep,
				says: `${prefix}authMethod must be one of: service_account, oauth`
			});
		} else {
			const max = PASTED_FILES[field] ?? LONGEST_TEXT;
			value = readText(entry, field, {
				max,
				keep,
				says: { type: `${prefix}${field} must be text`, invalid: `${prefix}${field} must be at most ${max} characters` }
			});
			// An SFTP host is saved trimmed of ASCII spaces and tabs only, as
			// keepMaskedSecrets compares it, so that the host compared is the host
			// connected to (the review-fix pass's S1). One sent back as stored is
			// kept as it is.
			if (field === 'host' && typeof value === 'string' && value !== keep) value = trimHost(value);
			// An SFTP host key is saved in one form, `<type> SHA256:<43>`, from
			// either form an administrator copies, and empty for none (card
			// 2250, R5); anything else is refused.
			if (field === 'hostKey' && typeof value === 'string') value = readHostKeyField(value, prefix);
			// A service account's JSON is read by the one rule and stored
			// rebuilt (card 2939); refused, in words that never quote it, unless
			// it is a key of Google's shape or the key-less shape a backup leaves.
			if (field === 'serviceAccountJson' && typeof value === 'string') {
				value = readServiceAccountField(value, prefix, destination.authMethod === 'oauth');
			}
			// A OneDrive destination's user or drive ID, and its folder path, by
			// onedrive-address.ts's rules, asked again at use (card 2941, R3).
			// One sent back as stored is kept byte for byte, as a host is, and only
			// checked (the fix pass's C5): trimming or lower-casing it would move its
			// place, and the secret bound to it.
			if (type === 'onedrive' && field === 'drive' && typeof value === 'string') {
				const drive = value === keep ? (value === '' || driveForm(value) !== null ? value : null) : savedDrive(value);
				if (drive === null) throw error(400, `${prefix}drive ${DRIVE_REFUSAL}`);
				value = drive;
			}
			if (type === 'onedrive' && field === 'folderPath' && typeof value === 'string' && folderSegments(value) === null) {
				throw error(400, `${prefix}folderPath ${FOLDER_PATH_REFUSAL}`);
			}
		}
		if (value === undefined) continue;
		destination[field] = value;
	}
	if (type === 'onedrive' && !driveSet(destination.drive) && !legacyUnmoved(destination, saved)) {
		throw error(400, `${prefix}drive ${ONEDRIVE_DRIVE_REQUIRED}`);
	}
	return destination as unknown as DestinationConfig;
}

/** What follows `drive` in the refusal of a OneDrive destination saved with none (card 2941). */
export const ONEDRIVE_DRIVE_REQUIRED =
	'is required for OneDrive: give the sign-in name or object ID of the user whose OneDrive holds the backups, or a drive ID beginning b!';

/**
 * Whether `sent`, a OneDrive destination with no drive, is the one stored
 * under its name, saved before card 2941 with none, at the same place (ruling
 * R9): it is let through, so that other settings can be saved while it waits,
 * and it is not tried until its drive is set. Any change of its place needs
 * the drive.
 */
function legacyUnmoved(sent: Record<string, unknown>, saved: Record<string, unknown> | undefined): boolean {
	if (saved === undefined || saved.type !== 'onedrive' || driveSet(saved.drive)) return false;
	return JSON.stringify(destinationPlace(sent)) === JSON.stringify(destinationPlace(saved));
}

/** What `readDestination` answers, with 400, to a service account's JSON the rule refuses (card 2939, decision 8), after the field's name. */
export const SERVICE_ACCOUNT_REFUSALS: Record<ServiceAccountRefusal, string> = {
	'not-json': 'is not JSON. Paste the whole JSON key file Google gives for the service account.',
	'not-key':
		'must be the JSON key file Google gives for a service account: type service_account, with its client_email and private_key as text.',
	'other-universe': 'names a universe_domain other than googleapis.com. DumpFire backs up to Google Drive at googleapis.com only.'
};

/** The same, for one sent with a Google Drive destination that signs in with OAuth (card 2939, ruling P4). */
export const SERVICE_ACCOUNT_UNDER_OAUTH = 'must be empty for a Google Drive destination that signs in with OAuth.';

/**
 * A service account's JSON as `readDestination` saves it (card 2939): '' as
 * it is; under OAuth anything else refused (ruling P4); JSON sent masked
 * (`serviceAccountJsonMasked`, the predicate `keepMaskedSecrets` reads, ruling
 * P6) as it is, since it is replaced whole by the stored JSON or refused;
 * otherwise read by the rule (`readServiceAccountJson`) and stored rebuilt,
 * or a 400 naming `<prefix>serviceAccountJson` in words that never hold any
 * of the text.
 */
function readServiceAccountField(value: string, prefix: string, oauth: boolean): string {
	if (value === '') return value;
	if (oauth) throw error(400, `${prefix}serviceAccountJson ${SERVICE_ACCOUNT_UNDER_OAUTH}`);
	if (serviceAccountJsonMasked(value)) return value;
	const reading = readServiceAccountJson(value);
	if ('refusal' in reading) throw error(400, `${prefix}serviceAccountJson ${SERVICE_ACCOUNT_REFUSALS[reading.refusal]}`);
	return reading.stored;
}

/**
 * A host key as `readDestination` saves it (card 2250, R5): `readHostKey`'s
 * canonical form, or '' for text that is empty once trimmed; otherwise a 400
 * naming the field, `<prefix>hostKey`.
 */
function readHostKeyField(value: string, prefix: string): string {
	if (/^[ \t\r\n]*$/.test(value)) return '';
	const key = readHostKey(value);
	if (key === null) throw error(400, `${prefix}hostKey ${HOST_KEY_REFUSAL}`);
	return hostKeyText(key);
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createDestination(config: DestinationConfig): BackupDestination {
	switch (config.type) {
		case 'sftp': return new SftpDestination(config);
		case 's3': return new S3Destination(config);
		case 'gdrive': return new GDriveDestination(config);
		case 'onedrive': return new OneDriveDestination(config);
		default: throw new Error(`Unknown destination type: ${(config as any).type}`);
	}
}
