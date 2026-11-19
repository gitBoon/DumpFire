/**
 * A OneDrive destination through Microsoft Graph with app-only sign-in (card
 * 2941): its addresses, its listing, its Test, and the addresses it refuses.
 *
 * The Graph client is replaced by one that records each request (its method,
 * its address and the middleware options it was sent with) and answers from
 * `graph.answer`; `@azure/identity`'s credential counts the tokens asked for.
 * Nothing reaches the network.
 *
 * DumpFire signs in as the app, with no user, so a drive is named by a user's
 * sign-in name or object ID (`/users/{id}/drive`) or by a drive ID
 * (`/drives/{id}`). Every address is made, and refused, before a token is
 * asked for; a listing follows only Graph's own next pages; no request follows
 * a redirect; Graph's words are capped at 300 characters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Sent = { method: string; path: string; options: unknown[] | null };

const graph = vi.hoisted(() => ({
	requests: [] as Sent[],
	tokens: 0,
	/** What the sign-in throws, or null (the fix pass's C4). */
	tokenError: null as Error | null,
	answer: (async () => ({})) as (method: string, path: string) => Promise<unknown>
}));

vi.mock('@microsoft/microsoft-graph-client', async (importOriginal) => {
	const real = await importOriginal<typeof import('@microsoft/microsoft-graph-client')>();
	return {
		...real,
		Client: {
			init: () => ({
				api: (path: string) => {
					let options: unknown[] | null = null;
					const send = (method: string) => {
						graph.requests.push({ method, path, options });
						return graph.answer(method, path);
					};
					const request = {
						middlewareOptions(given: unknown[]) {
							options = given;
							return request;
						},
						get: () => send('GET'),
						put: () => send('PUT'),
						delete: () => send('DELETE')
					};
					return request;
				}
			})
		}
	};
});

vi.mock('@azure/identity', () => ({
	ClientSecretCredential: class {
		async getToken() {
			graph.tokens++;
			if (graph.tokenError) throw graph.tokenError;
			return { token: 'app-token', expiresOnTimestamp: 0 };
		}
	}
}));

import { OneDriveDestination, type OneDriveDestinationConfig } from '$lib/server/backup-destinations';
import { DRIVE_REFUSAL, FOLDER_PATH_REFUSAL, ONEDRIVE_DRIVE_NOT_SET } from '$lib/server/onedrive-address';

const BASE = { type: 'onedrive', name: 'One', tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'secret-1', folderPath: '/DumpFire Backups' } as const;
const oneDrive = (fields: Partial<OneDriveDestinationConfig> = {}) =>
	new OneDriveDestination({ ...BASE, drive: 'alice@contoso.example', ...fields } as OneDriveDestinationConfig);

const COPY = 'dumpfire-backup-2026-11-19T10-00-00-000.db';
const USER_ITEM = '/users/alice%40contoso.example/drive/root:/DumpFire%20Backups';
const NEXT = (n: number) => `https://graph.microsoft.com/v1.0/drives/b!abc/items/folder-1/children?$skiptoken=${n}`;
/** Graph's answer for an item that is not there. */
const notFound = () => Object.assign(new Error('The resource could not be found.'), { statusCode: 404, code: 'itemNotFound' });

beforeEach(() => {
	graph.requests.length = 0;
	graph.tokens = 0;
	graph.tokenError = null;
	graph.answer = async () => ({});
});

describe('addresses', () => {
	it('T9: upload and delete address the item in the user’s drive, every segment encoded, and follow no redirect', async () => {
		const destination = oneDrive();

		await destination.upload(Buffer.from('copy'), COPY);
		await destination.delete(COPY);

		expect(graph.requests.map(({ method, path }) => [method, path])).toEqual([
			['PUT', `${USER_ITEM}/${COPY}:/content`],
			['DELETE', `${USER_ITEM}/${COPY}`]
		]);
		for (const { options } of graph.requests) {
			expect(options).toEqual([expect.objectContaining({ maxRedirects: 0 })]);
			expect((options![0] as { shouldRedirect: () => boolean }).shouldRedirect()).toBe(false);
		}
	});

	it.each([
		{ fields: { folderPath: 'a/../b' }, words: FOLDER_PATH_REFUSAL },
		{ fields: { folderPath: 'https://x' }, words: FOLDER_PATH_REFUSAL },
		{ fields: { drive: 'not-a-drive' }, words: DRIVE_REFUSAL }
	])('T18: a stored $fields is refused at use, before any token is asked for', async ({ fields, words }) => {
		const destination = oneDrive(fields);

		await expect(destination.upload(Buffer.from('copy'), COPY)).rejects.toThrow(words);
		await expect(destination.list()).rejects.toThrow(words);
		expect(await destination.test()).toEqual({ success: false, message: expect.stringContaining(words) });
		expect(graph.tokens).toBe(0);
		expect(graph.requests).toEqual([]);
	});
});

describe('the listing', () => {
	it('T10: with a drive ID, lists the folder’s children and answers only copies DumpFire names, oldest first', async () => {
		graph.answer = async () => ({
			value: [
				{ name: 'dumpfire-backup-2026-11-19T10-00-00-000.db', file: {} },
				{ name: 'notes.txt', file: {} },
				{ name: 'dumpfire-backup-x.db', file: {} },
				{ name: 'dumpfire-backup-2026-11-18T10-00-00.db', file: {} }
			]
		});

		const names = await oneDrive({ drive: 'b!abc_-1', folderPath: 'Nightly Backups/2026' }).list();

		expect(names).toEqual(['dumpfire-backup-2026-11-18T10-00-00.db', 'dumpfire-backup-2026-11-19T10-00-00-000.db']);
		expect(graph.requests.map(({ method, path }) => [method, path])).toEqual([
			['GET', '/drives/b!abc_-1/root:/Nightly%20Backups/2026:/children?$select=name,file&$top=200']
		]);
	});

	it('C2b: answers only files, not a folder of a copy’s name', async () => {
		graph.answer = async () => ({
			value: [
				{ name: 'dumpfire-backup-2026-11-18T10-00-00.db', file: {} },
				{ name: 'dumpfire-backup-2026-11-19T10-00-00.db', folder: { childCount: 0 } }
			]
		});

		expect(await oneDrive().list()).toEqual(['dumpfire-backup-2026-11-18T10-00-00.db']);
	});

	it('T11: follows each next page Graph gives', async () => {
		const pages: Record<string, unknown> = {
			[`${USER_ITEM}:/children?$select=name,file&$top=200`]: { value: [{ name: 'dumpfire-backup-2026-11-03T00-00-00.db', file: {} }], '@odata.nextLink': NEXT(1) },
			[NEXT(1)]: { value: [{ name: 'dumpfire-backup-2026-11-01T00-00-00.db', file: {} }], '@odata.nextLink': NEXT(2) },
			[NEXT(2)]: { value: [{ name: 'dumpfire-backup-2026-11-02T00-00-00.db', file: {} }] }
		};
		graph.answer = async (_method, path) => pages[path];

		const names = await oneDrive().list();

		expect(names).toEqual(['dumpfire-backup-2026-11-01T00-00-00.db', 'dumpfire-backup-2026-11-02T00-00-00.db', 'dumpfire-backup-2026-11-03T00-00-00.db']);
		expect(graph.requests.map(({ path }) => path)).toEqual(Object.keys(pages));
	});

	it.each([
		'https://graph.microsoft.com:x@evil.example/v1.0/next',
		'https://graph.microsoft.com.evil.example/v1.0/next',
		'http://graph.microsoft.com/v1.0/next',
		'https://graph.microsoft.com:8443/v1.0/next',
		'https://graph.microsoft.com\\@evil.example/v1.0/next',
		'https://graph.microsoft.com/beta/next'
	])('T12: refuses a next page of %s, and asks nothing of it', async (link) => {
		graph.answer = async () => ({ value: [], '@odata.nextLink': link });

		await expect(oneDrive().list()).rejects.toThrow('OneDrive answered a next page outside https://graph.microsoft.com/v1.0/');
		expect(graph.requests).toHaveLength(1);
	});

	it('T13: stops with an error after 100 pages, not for ever', async () => {
		graph.answer = async () => {
			// A guard for the test itself: an unbounded loop would never end.
			if (graph.requests.length > 101) throw new Error('listed past the cap');
			return { value: [], '@odata.nextLink': NEXT(1) };
		};

		await expect(oneDrive().list()).rejects.toThrow('OneDrive listing of the backup folder went on for more than 100 pages');
		expect(graph.requests).toHaveLength(100);
	});

	it('T14: throws what Graph answered, where it answered an empty folder', async () => {
		graph.answer = async () => {
			throw notFound();
		};

		await expect(oneDrive().list()).rejects.toThrow('The resource could not be found.');
	});

	it('C4: a sign-in that fails throws Microsoft’s words capped at 300 characters, for an upload, a listing and a delete', async () => {
		graph.tokenError = new Error(`AADSTS7000215: Invalid client secret provided. ${'Trace ID: 0000. '.repeat(40)}`);

		for (const call of [() => oneDrive().upload(Buffer.from('copy'), COPY), () => oneDrive().list(), () => oneDrive().delete(COPY)]) {
			const thrown = await call().then(
				() => null,
				(err: Error) => err
			);
			expect(thrown?.message).toHaveLength(300);
			expect(thrown?.message).toMatch(/^AADSTS7000215: Invalid client secret provided\. .*…$/);
		}
		expect(graph.requests).toEqual([]);
	});
});

describe('Test', () => {
	const DRIVE = { id: 'drive-1', driveType: 'business', owner: { user: { displayName: 'Alice' } } };

	it('T15: with no drive, says so and asks for no token', async () => {
		expect(await oneDrive({ drive: undefined }).test()).toEqual({ success: false, message: ONEDRIVE_DRIVE_NOT_SET });
		expect(await oneDrive({ drive: '' }).test()).toEqual({ success: false, message: ONEDRIVE_DRIVE_NOT_SET });
		expect(graph.tokens).toBe(0);
		expect(graph.requests).toEqual([]);
	});

	it.each([
		{ folder: async () => ({ id: 'f', folder: { childCount: 0 } }), answer: { success: true, message: `Connected to Alice's OneDrive (drive business); folder "DumpFire Backups" found` } },
		{
			folder: async () => {
				throw notFound();
			},
			answer: { success: true, message: `Connected to Alice's OneDrive (drive business); folder "DumpFire Backups" will be made by the first backup` }
		},
		{ folder: async () => ({ id: 'f' }), answer: { success: false, message: '"DumpFire Backups" in that OneDrive is a file, not a folder' } }
	])('T16: reads the drive, then the folder: $answer.message', async ({ folder, answer }) => {
		graph.answer = async (_method, path) => (path.startsWith(`${USER_ITEM}?`) ? folder() : DRIVE);

		expect(await oneDrive().test()).toEqual(answer);
		expect(graph.requests.map(({ method, path }) => [method, path])).toEqual([
			['GET', '/users/alice%40contoso.example/drive?$select=id,driveType,owner'],
			['GET', `${USER_ITEM}?$select=id,folder`]
		]);
	});

	it('T17: a drive that cannot be read answers Graph’s words, capped at 300 characters', async () => {
		graph.answer = async () => {
			throw Object.assign(new Error(`Access denied. ${'x'.repeat(400)}`), { statusCode: 403 });
		};

		const result = await oneDrive().test();

		expect(result.success).toBe(false);
		expect(result.message).toHaveLength(300);
		expect(result.message).toMatch(/^Access denied\. x+…$/);
	});
});
