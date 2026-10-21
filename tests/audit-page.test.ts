// @vitest-environment jsdom
/**
 * The Audit page's Load more (card 2383), the page mounted whole with
 * Svelte's client runtime, as the plan page's and the dashboard's files
 * mount theirs: `fetch` a stand-in answering `GET /api/audit` page by page and
 * keeping each request sent, and `EventSource` (the Live Console's stream,
 * which jsdom does not have) a stand-in that never opens.
 *
 * Load more was offered while the last page came back full (`data.length`
 * against the page of 100), so a filter with exactly 100 entries showed it,
 * and a press read an empty page. It is now offered only while the answer's
 * `pagination.hasMore` says more follows (the route answers it since card
 * 2294). The page's failures, read from the source, are in
 * `tests/page-failures.test.ts`. The plan is
 * `docs/planning/cards-2329-2383-2384.md`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';

// A bare 'svelte' gives the server's runtime, whose onMount never runs: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

const AuditPage = (await import('../src/routes/audit/+page.svelte')).default;

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;
/** Each `/api/audit` request sent, by its query. */
let asked: URLSearchParams[] = [];
/** How the next read of the log is answered: rows from `offset`, and whether more follow. */
let pages: { count: number; hasMore: boolean }[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** `count` rows, numbered on from `from`, as the route answers them. */
const rows = (from: number, count: number) =>
	Array.from({ length: count }, (_, i) => ({
		id: from + i, boardId: 1, boardName: 'Website', cardId: null, userId: 1, action: 'card_created',
		detail: `Created card ${from + i}`, userName: 'alice', userEmoji: '🙂', createdAt: '2026-10-21 09:00:00'
	}));

class NoStream {
	static CLOSED = 2;
	readyState = 0;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((e: MessageEvent) => void) | null = null;
	close() {}
}

beforeEach(() => {
	asked = [];
	pages = [];
	vi.stubGlobal('EventSource', NoStream);
	vi.stubGlobal('requestAnimationFrame', (run: () => void) => setTimeout(run, 0));
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			if (!url.startsWith('/api/audit?')) return json([]);
			const query = new URLSearchParams(url.slice('/api/audit?'.length));
			asked.push(query);
			const offset = Number(query.get('offset'));
			const page = pages.shift() ?? { count: 0, hasMore: false };
			return json({ data: rows(offset + 1, page.count), pagination: { limit: 100, offset, count: page.count, hasMore: page.hasMore } });
		})
	);
});

afterEach(() => {
	if (drawn) {
		unmount(drawn.component);
		drawn.target.remove();
		drawn = null;
	}
	vi.unstubAllGlobals();
});

/** Lets every answer in flight arrive, and draws. */
async function settle() {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
}

/** Mounts the page and opens its Audit Log tab, which reads the first page. */
async function openAuditLog() {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const data = { allUsers: [{ id: 1, username: 'alice', emoji: '🙂' }], allBoards: [{ id: 1, name: 'Website', emoji: '📋' }] };
	drawn = { component: mount(AuditPage, { target, props: { data } as never }), target };
	flushSync();
	[...target.querySelectorAll<HTMLButtonElement>('.audit-tab')].find((b) => b.textContent?.includes('Audit Log'))!.click();
	await settle();
	return target;
}

const loadMore = (target: HTMLElement) =>
	[...target.querySelectorAll<HTMLButtonElement>('.audit-more button')].find((b) => b.textContent?.trim() === 'Load more');

describe('Load more on the Audit page reads hasMore (card 2383)', () => {
	it('a first page of exactly 100 with nothing after it offers no Load more', async () => {
		pages = [{ count: 100, hasMore: false }];
		const target = await openAuditLog();

		expect(asked).toHaveLength(1);
		expect(asked[0].get('limit')).toBe('100');
		expect(loadMore(target)).toBeUndefined();
	});

	it('a page with more after it offers Load more, which reads from 100 on and goes once the answer says nothing follows', async () => {
		pages = [
			{ count: 100, hasMore: true },
			{ count: 100, hasMore: false }
		];
		const target = await openAuditLog();
		expect(loadMore(target)).toBeDefined();

		loadMore(target)!.click();
		await settle();
		expect(asked.map((q) => q.get('offset'))).toEqual(['0', '100']);
		expect(loadMore(target)).toBeUndefined();
	});
});
