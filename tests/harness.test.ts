/**
 * Proves the harness itself: the database is the in-memory one, the schema is
 * what the real migrations build, every test file is here to be run, and a
 * route handler can be called as a signed-in or anonymous caller. If these
 * fail, no other test result means anything.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDbPath, sqlite } from '$lib/server/db';
import { api, routeMethods, routePatterns } from './helpers/api';
import { makeBoard, makeCard, makeUser, resetDb } from './helpers/fixtures';

beforeEach(resetDb);

describe('database fixture', () => {
	it('runs against an in-memory database', () => {
		expect(getDbPath()).toBe(':memory:');
	});

	it('has the schema the real migrations build', () => {
		const tables = (
			sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
				name: string;
			}[]
		).map((t) => t.name);
		for (const expected of ['users', 'boards', 'columns', 'cards', 'subtasks', 'work_dependencies']) {
			expect(tables).toContain(expected);
		}
	});

	it('enforces foreign keys, as the application database does', () => {
		expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
	});

	it('starts each test empty', () => {
		makeUser();
		resetDb();
		const { n } = sqlite.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
		expect(n).toBe(0);
	});
});

/**
 * Every test file there is, by its path under `tests/`. A new one is added
 * here, and one that is deleted is taken out.
 *
 * vitest runs whatever files it finds and counts them: it has no way to know
 * that one is missing. A build from a commit that left a test file out, by a
 * merge or by `git add` not being told of it, ran the others and passed.
 */
const TEST_FILES = [
	'access-control.test.ts',
	'activity-twins.test.ts',
	'all-tasks.test.ts',
	'access-every-route.test.ts',
	'admin-reset.test.ts',
	'archive-answers.test.ts',
	'atomic-accounts.test.ts',
	'atomic-creation.test.ts',
	'atomic-dependencies.test.ts',
	'atomic-moves.test.ts',
	'atomic-requests.test.ts',
	'atomic-v1.test.ts',
	'backups.test.ts',
	'body-limits.test.ts',
	'board-contents.test.ts',
	'board-list-view.test.ts',
	'board-refresh.test.ts',
	'board-tree-loops.test.ts',
	'bulk-endpoints.test.ts',
	'burndown.test.ts',
	'card-completion.test.ts',
	'card-covers-and-labels.test.ts',
	'card-updates.test.ts',
	'card-window.test.ts',
	'check-at-the-write.test.ts',
	'colours.test.ts',
	'columns.test.ts',
	'content-security-policy.test.ts',
	'database-location.test.ts',
	'deletes-no-parent-key.test.ts',
	'deletes.test.ts',
	'dependency-refusals.test.ts',
	'docs-format.test.ts',
	'error-shape.test.ts',
	'gate.test.ts',
	'gdrive-retention.test.ts',
	'harness.test.ts',
	'import-working-copy.test.ts',
	'internal-refusals.test.ts',
	'live-streams.test.ts',
	'logger.test.ts',
	'mail-escaping.test.ts',
	'mail-failures.test.ts',
	'mail-links.test.ts',
	'mail-settings.test.ts',
	'markdown.test.ts',
	'mentions.test.ts',
	'migrations.test.ts',
	'openapi-document.test.ts',
	'page-failures.test.ts',
	'password-checks.test.ts',
	'plan-table.test.ts',
	'pricing.test.ts',
	'public-requests.test.ts',
	'report-mail.test.ts',
	'report-access.test.ts',
	'report-recipients.test.ts',
	'report-schedules.test.ts',
	'request-body.test.ts',
	'schedulers.test.ts',
	'sftp-host-key.test.ts',
	'sub-board-depth.test.ts',
	'subtask-order.test.ts',
	'test-helpers.test.ts',
	'timestamps.test.ts',
	'todo-page.test.ts',
	'transaction.test.ts',
	'uploads-sweep.test.ts',
	'uploads.test.ts',
	'user-delete.test.ts',
	'webhooks.test.ts',
	'write-as.test.ts',
	'xp-leaderboard.svelte.test.ts'
];

describe('the suite', () => {
	it('is every test file in the list, and no file that is not in it', () => {
		const tests = join(process.cwd(), 'tests');
		const onDisk = (readdirSync(tests, { recursive: true }) as string[])
			.map((file) => file.split(sep).join('/'))
			.filter((file) => file.endsWith('.test.ts'))
			.sort();

		const missing = TEST_FILES.filter((file) => !onDisk.includes(file));
		const unlisted = onDisk.filter((file) => !TEST_FILES.includes(file));

		// A file in the list and not on disk was left out of this tree: its tests did not run.
		expect(missing, `test files in TEST_FILES that are not under tests/: ${missing.join(', ')}`).toEqual([]);
		// A new file is added to the list, so that leaving it out later is noticed.
		expect(
			unlisted,
			`test files under tests/ that are not in TEST_FILES, in tests/harness.test.ts: ${unlisted.join(', ')}`
		).toEqual([]);
	});
});

describe('the build', () => {
	it('stops on a type error, inside the image as on a workstation', () => {
		const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

		// npm runs "prebuild" before "build". The type check comes after the
		// expected-schema check, so a type error stops the build as a stale
		// schema module does. Nothing in .npmrc turns scripts off.
		const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
		expect(scripts.prebuild).toBe('node scripts/generate-expected-schema.mjs --check && npm run check');
		expect(scripts.check).toMatch(/\bsvelte-check\b/);
		expect(read('.npmrc')).not.toMatch(/ignore-scripts\s*=\s*true/);

		// The image builds with `npm run build`, which is what runs "prebuild",
		// and prunes the dev dependencies, svelte-check among them, only after it.
		const dockerfile = read('Dockerfile');
		const build = dockerfile.search(/^RUN npm run build\r?$/m);
		const prune = dockerfile.search(/^RUN npm ci --omit=dev\r?$/m);
		expect(build).toBeGreaterThan(-1);
		expect(prune).toBeGreaterThan(build);
	});
});

describe('route helper', () => {
	it('sees the whole API route tree', () => {
		const patterns = routePatterns();
		expect(patterns).toContain('/api/cards/[id]');
		expect(patterns).toContain('/api/v1/cards/[cardId]');
		expect(patterns.length).toBeGreaterThan(100);
	});

	it('reports the methods a route exports', async () => {
		expect(await routeMethods('/api/cards/[id]')).toEqual(['PUT', 'DELETE']);
	});

	it('calls a handler as a signed-in user', async () => {
		const owner = makeUser();
		const { cols } = makeBoard({ owner });
		const card = makeCard(cols['To Do'], { title: 'Before' });

		const res = await api('PUT', `/api/cards/${card.id}`, { user: owner, body: { title: 'After' } });

		expect(res.status).toBe(200);
		expect(res.body.title).toBe('After');
	});

	it('calls a handler as an anonymous caller', async () => {
		const { cols } = makeBoard({ owner: makeUser() });
		const card = makeCard(cols['To Do']);

		const res = await api('PUT', `/api/cards/${card.id}`, { body: { title: 'x' } });

		expect(res.status).toBe(401);
	});

	it('prefers a static route over a parameterised one', async () => {
		// /api/cards/reorder must not be read as /api/cards/[id] with id "reorder".
		const res = await api('PUT', '/api/cards/reorder', { body: {} });
		expect(res.status).toBe(401);
	});

	it('refuses a path that is not a route', async () => {
		await expect(api('GET', '/api/no-such-route')).rejects.toThrow(/No route matches/);
	});
});
