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
import { google, type drive_v3 } from 'googleapis';
import { Client as GraphClient } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';
import { Readable } from 'node:stream';
import { readChoice, readNumber, readText, type RequestBody } from './request-body';
import { trimHost } from './backup-secrets';
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
import { dumpfireFolderName } from '$lib/drive-scope';

// ─── Common Interface ────────────────────────────────────────────────────────

export interface BackupDestination {
	type: string;
	name: string;
	test(): Promise<{ success: boolean; message: string }>;
	upload(data: Buffer, filename: string): Promise<void>;
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
	serviceAccountJson?: string; // JSON string of service account credentials (service_account mode)
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
			if (seen.blob === null) return { success: false, message: err?.message || 'Connection failed' };
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
			return { success: false, message: err.message || 'Connection failed' };
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
			const remotePath = `${this.config.remotePath.replace(/\/+$/, '')}/${filename}`;
			await sftp.put(data, remotePath);
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
			return files
				.filter(f => f.name.startsWith('dumpfire-backup-') && f.name.endsWith('.db'))
				.map(f => f.name)
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
			return { success: false, message: err.message || 'S3 connection failed' };
		}
	}

	async upload(data: Buffer, filename: string): Promise<void> {
		await this.client.send(new PutObjectCommand({
			Bucket: this.config.bucket,
			Key: this.getKey(filename),
			Body: data,
			ContentType: 'application/x-sqlite3'
		}));
	}

	async list(): Promise<string[]> {
		const result = await this.client.send(new ListObjectsV2Command({
			Bucket: this.config.bucket,
			Prefix: this.config.prefix || ''
		}));
		return (result.Contents || [])
			.map(obj => obj.Key?.split('/').pop() || '')
			.filter(name => name.startsWith('dumpfire-backup-') && name.endsWith('.db'))
			.sort();
	}

	async delete(filename: string): Promise<void> {
		await this.client.send(new DeleteObjectCommand({
			Bucket: this.config.bucket,
			Key: this.getKey(filename)
		}));
	}
}

// ─── Google Drive Provider ───────────────────────────────────────────────────

export class GDriveDestination implements BackupDestination {
	type = 'gdrive';
	name: string;

	constructor(private config: GDriveDestinationConfig) {
		this.name = config.name;
	}

	private async getDrive() {
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
			return google.drive({ version: 'v3', auth: oauth2Client });
		} else {
			// Service Account flow
			if (!this.config.serviceAccountJson) {
				throw new Error('Service Account JSON not configured');
			}
			const credentials = JSON.parse(this.config.serviceAccountJson);
			const auth = new google.auth.GoogleAuth({
				credentials,
				scopes: ['https://www.googleapis.com/auth/drive.file']
			});
			return google.drive({ version: 'v3', auth });
		}
	}

	async test(): Promise<{ success: boolean; message: string }> {
		try {
			const drive = await this.getDrive();
			if (this.config.folderId) {
				// The folder fetched first, as an upload would meet it (card 2188,
				// decision 8): a listing of a folder the account cannot see answers
				// "0 existing files", as if it were empty.
				const reached = await reachFolder(drive, this.config.folderId);
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
			return { success: false, message: err.message || 'Google Drive connection failed' };
		}
	}

	async upload(data: Buffer, filename: string): Promise<void> {
		const drive = await this.getDrive();
		const stream = Readable.from(data);
		await drive.files.create({
			requestBody: {
				name: filename,
				parents: [this.config.folderId]
			},
			media: {
				mimeType: 'application/x-sqlite3',
				body: stream
			},
			fields: 'id',
			supportsAllDrives: true
		});
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
				if (!f.id || !f.name) continue;
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
	 * The files listed for retention, by name, so that `delete` removes the
	 * file that was listed, by its id, in the way the account may remove it.
	 */
	private listed = new Map<string, GDriveBackupFile>();

	/**
	 * A file the account can see but may neither delete nor trash (one another
	 * identity made, or one in a Shared drive where the account is no Manager)
	 * is set aside: Drive answers a delete of it with 404 File not found, and
	 * it would be picked first on every run, being the oldest (card 2238).
	 */
	async listForRetention(): Promise<{ removable: string[]; setAside: string[] }> {
		const files = await this.listBackups();
		// Only removable files are kept by name, so that a set-aside file of the
		// same name as a removable one is never the one tried.
		this.listed = new Map(files.filter(f => f.canDelete || f.canTrash).map(f => [f.name, f]));
		const removable: string[] = [];
		const setAside: string[] = [];
		for (const f of files) (f.canDelete || f.canTrash ? removable : setAside).push(f.name);
		return { removable, setAside };
	}

	async delete(filename: string): Promise<void | 'trashed'> {
		const drive = await this.getDrive();
		let file = this.listed.get(filename);
		if (!file) {
			// Not from a listing for retention: find it by name, as before.
			const res = await drive.files.list({
				q: `'${this.config.folderId}' in parents and name = '${filename}' and trashed = false`,
				fields: 'files(id)',
				supportsAllDrives: true,
				includeItemsFromAllDrives: true
			});
			const id = res.data.files?.[0]?.id;
			if (!id) return;
			file = { id, name: filename, canDelete: true, canTrash: false };
		}
		if (file.canDelete) {
			await drive.files.delete({ fileId: file.id, supportsAllDrives: true });
			this.listed.delete(filename);
			return;
		}
		// Only to the trash, where Drive keeps it for 30 days.
		await drive.files.update({ fileId: file.id, requestBody: { trashed: true }, supportsAllDrives: true });
		this.listed.delete(filename);
		return 'trashed';
	}
}

/** The most pages of 1,000 files a Google Drive listing reads before it gives up. */
const GDRIVE_MAX_PAGES = 100;

/** What Google Drive calls a folder. */
const GDRIVE_FOLDER_TYPE = 'application/vnd.google-apps.folder';

/** The name of the folder Connect makes: in `$lib/drive-scope`, so the admin page names it too. */
export { dumpfireFolderName };

/**
 * Whether the account `drive` is signed in as can reach the folder `folderId`
 * (card 2188, decision 8): it is fetched (`files.get`), and must be a folder
 * that is not in the trash. Any error Google answers is "cannot reach", with
 * its message. With `drive.file`, a folder DumpFire did not make may be one
 * Google does not let it see; this reads what Google answers rather than
 * depending on it. Used by Connect and by `GDriveDestination.test()`.
 */
export async function reachFolder(
	drive: drive_v3.Drive,
	folderId: string
): Promise<{ reached: true } | { reached: false; reason: string }> {
	try {
		const res = await drive.files.get({ fileId: folderId, fields: 'id, name, mimeType, trashed', supportsAllDrives: true });
		if (res.data.mimeType !== GDRIVE_FOLDER_TYPE) return { reached: false, reason: 'it is not a folder' };
		if (res.data.trashed) return { reached: false, reason: 'it is in the trash' };
		return { reached: true };
	} catch (err: any) {
		return { reached: false, reason: err?.message || 'Google Drive did not find it' };
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

export class OneDriveDestination implements BackupDestination {
	type = 'onedrive';
	name: string;

	constructor(private config: OneDriveDestinationConfig) {
		this.name = config.name;
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

	private getFolderPath(): string {
		return this.config.folderPath?.replace(/^\/+/, '').replace(/\/+$/, '') || 'DumpFire Backups';
	}

	async test(): Promise<{ success: boolean; message: string }> {
		try {
			const client = await this.getClient();
			// Try listing the root to verify credentials
			await client.api('/drives').get();
			return { success: true, message: 'Connected to OneDrive' };
		} catch (err: any) {
			return { success: false, message: err.message || 'OneDrive connection failed' };
		}
	}

	async upload(data: Buffer, filename: string): Promise<void> {
		const client = await this.getClient();
		const folderPath = this.getFolderPath();
		// For files < 4MB, use simple upload; backup files are typically small JSON
		await client
			.api(`/drives/root:/${folderPath}/${filename}:/content`)
			.put(data);
	}

	async list(): Promise<string[]> {
		const client = await this.getClient();
		const folderPath = this.getFolderPath();
		try {
			const result = await client.api(`/drives/root:/${folderPath}:/children`).get();
			return (result.value || [])
				.map((f: any) => f.name as string)
				.filter((name: string) => name.startsWith('dumpfire-backup-') && name.endsWith('.db'))
				.sort();
		} catch {
			return [];
		}
	}

	async delete(filename: string): Promise<void> {
		const client = await this.getClient();
		const folderPath = this.getFolderPath();
		await client.api(`/drives/root:/${folderPath}/${filename}`).delete();
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
	onedrive: ['tenantId', 'clientId', 'clientSecret', 'folderPath']
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
		}
		if (value === undefined) continue;
		destination[field] = value;
	}
	return destination as unknown as DestinationConfig;
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
