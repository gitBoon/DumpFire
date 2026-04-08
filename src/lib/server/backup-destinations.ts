/**
 * backup-destinations.ts — Remote storage destination providers for scheduled backups.
 *
 * Implements a common interface for uploading backup files to:
 * - SFTP/SCP (via ssh2-sftp-client)
 * - Amazon S3 / S3-compatible (via @aws-sdk/client-s3)
 * - Google Drive (via googleapis)
 * - OneDrive (via @microsoft/microsoft-graph-client + @azure/identity)
 */

import SftpClient from 'ssh2-sftp-client';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { google } from 'googleapis';
import { Client as GraphClient } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';
import { Readable } from 'node:stream';

// ─── Common Interface ────────────────────────────────────────────────────────

export interface BackupDestination {
	type: string;
	name: string;
	test(): Promise<{ success: boolean; message: string }>;
	upload(data: Buffer, filename: string): Promise<void>;
	list(): Promise<string[]>;
	delete(filename: string): Promise<void>;
}

// ─── Destination Config Types ────────────────────────────────────────────────

export interface SftpDestinationConfig {
	type: 'sftp';
	name: string;
	host: string;
	port: number;
	username: string;
	password?: string;
	privateKey?: string;
	remotePath: string;
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

	private getConnectConfig() {
		const cfg: Record<string, unknown> = {
			host: this.config.host,
			port: this.config.port || 22,
			username: this.config.username
		};
		if (this.config.privateKey) {
			cfg.privateKey = this.config.privateKey;
		} else if (this.config.password) {
			cfg.password = this.config.password;
		}
		return cfg;
	}

	async test(): Promise<{ success: boolean; message: string }> {
		const sftp = this.createClient();
		try {
			await sftp.connect(this.getConnectConfig());
			// Check if remote directory exists, create if not
			const exists = await sftp.exists(this.config.remotePath);
			if (!exists) {
				await sftp.mkdir(this.config.remotePath, true);
			}
			await sftp.end();
			return { success: true, message: `Connected to ${this.config.host}:${this.config.port}` };
		} catch (err: any) {
			try { await sftp.end(); } catch {}
			return { success: false, message: err.message || 'Connection failed' };
		}
	}

	async upload(data: Buffer, filename: string): Promise<void> {
		const sftp = this.createClient();
		try {
			await sftp.connect(this.getConnectConfig());
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
			await sftp.connect(this.getConnectConfig());
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
			await sftp.connect(this.getConnectConfig());
			const remotePath = `${this.config.remotePath.replace(/\/+$/, '')}/${filename}`;
			await sftp.delete(remotePath);
			await sftp.end();
		} catch (err) {
			try { await sftp.end(); } catch {}
			throw err;
		}
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

	async list(): Promise<string[]> {
		const drive = await this.getDrive();
		const res = await drive.files.list({
			q: `'${this.config.folderId}' in parents and trashed = false and name contains 'dumpfire-backup-'`,
			fields: 'files(id,name)',
			orderBy: 'name',
			supportsAllDrives: true,
			includeItemsFromAllDrives: true
		});
		return (res.data.files || []).map(f => f.name || '').filter(Boolean);
	}

	async delete(filename: string): Promise<void> {
		const drive = await this.getDrive();
		// Find the file by name in the folder
		const res = await drive.files.list({
			q: `'${this.config.folderId}' in parents and name = '${filename}' and trashed = false`,
			fields: 'files(id)',
			supportsAllDrives: true,
			includeItemsFromAllDrives: true
		});
		const file = res.data.files?.[0];
		if (file?.id) {
			await drive.files.delete({ fileId: file.id, supportsAllDrives: true });
		}
	}
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
