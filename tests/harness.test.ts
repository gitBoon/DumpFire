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
	// Card 2671: an account disabled and enabled again, and every gate that refuses a disabled one.
	'account-disable.test.ts',
	'account-two-step.test.ts',
	'activity-twins.test.ts',
	// Card 2910: the name and the type a file that is not an image is stored with.
	'attachment-names.test.ts',
	'all-tasks.test.ts',
	'all-tasks-page.test.ts',
	'access-every-route.test.ts',
	'admin-panels.test.ts',
	'admin-reset.test.ts',
	'api-key-deadline.test.ts',
	'archive-answers.test.ts',
	'atomic-accounts.test.ts',
	'atomic-creation.test.ts',
	'atomic-dependencies.test.ts',
	'atomic-moves.test.ts',
	'atomic-requests.test.ts',
	'atomic-v1.test.ts',
	'audit-log.test.ts',
	'audit-page.test.ts',
	'backups.test.ts',
	'body-limits.test.ts',
	'board-contents.test.ts',
	'board-list-view.test.ts',
	'board-product-owner.test.ts',
	'board-refresh.test.ts',
	'board-tree-loops.test.ts',
	'bulk-endpoints.test.ts',
	'burndown.test.ts',
	'card-completion.test.ts',
	'card-covers-and-labels.test.ts',
	'card-create-contents.test.ts',
	'card-order.test.ts',
	'card-updates.test.ts',
	'card-window.test.ts',
	'card-window-comments.svelte.test.ts',
	'card-window-follow.svelte.test.ts',
	'card-window-keys.svelte.test.ts',
	'card-window-pages.test.ts',
	// Card 2473: Manage Categories holds the keyboard's focus.
	'category-window.svelte.test.ts',
	'check-at-the-write.test.ts',
	// Card 2546: the one colour picker the five colour forms share.
	'colour-swatches.svelte.test.ts',
	'colours.test.ts',
	'columns.test.ts',
	// Milestone 22, slice S2: a move across the commitment point, by every route.
	'commitment.test.ts',
	'confirm-modal.svelte.test.ts',
	'content-security-policy.test.ts',
	// Card 2526: the side pane's panels in the dashboard's Display menu, remembered per user.
	'dashboard-side-pane.svelte.test.ts',
	'dashboard.test.ts',
	'database-location.test.ts',
	// Card 2675: who may do what to a decision, and its permanent record and personal links.
	'decision-access.test.ts',
	// Card 2676: drafting a decision, its content, revision and readability check.
	'decision-authoring.test.ts',
	// Card 2676, slice A2: the picker, the editor and the board's decision list, in the page.
	'decision-authoring.svelte.test.ts',
	// Card 2697: the dry run, opening and the lifecycle routes, their limits, and delivery.
	'decision-lifecycle.test.ts',
	// Card 2697, slices B2a and B2b: the delivery panel, Resend and the administrator's actions, in the page.
	'decision-lifecycle.svelte.test.ts',
	// Card 2677: a participant's response and opening, signed in or by a personal link.
	'decision-participation.test.ts',
	// Card 2677: the participant page, the response form and the seen watch, in the page.
	'decision-participation.svelte.test.ts',
	// Card 2678: clarification questions and answers, agent drafts, their notices and what the pages read of them.
	'decision-questions.test.ts',
	// Card 2678, slices 2a and 2b: the shared agent-drafted label (card 2712), the results' open questions, the questions panel and form, in the page.
	'decision-questions.svelte.test.ts',
	'decision-record.test.ts',
	// Card 2680, slice 1: the register, each person's record, the record view and what the decision page gains.
	'decision-register.test.ts',
	// Card 2680, slice 3a: the register, a person's record and the record view, in the page; the Record links; live listening.
	'decision-register.svelte.test.ts',
	// Card 2685: the closing-date reminder: who is due, record then send, once a round, the rest it starts, its gating.
	'decision-reminders.test.ts',
	// Card 2680, slices 2a and 2b: linking a card to a decision, both sides of the link, deleting a linked decision, and the routes.
	'decision-card-links.test.ts',
	// Card 2680, slice 3b: the decision page's linked cards with Link and Unlink, and the card window's decisions, in the page.
	'decision-card-links.svelte.test.ts',
	// Card 2679: the results, the ruling, the release of results and superseding, and what the pages read of them.
	'decision-ruling.test.ts',
	// Card 2679, slice 2a: the results page, the ruling form and the release, in the page.
	'decision-ruling.svelte.test.ts',
	'decision-service.test.ts',
	// Card 2682: decisions under API v1, and what a key may never do to one, by the credential as well as the route's word.
	'decisions-api.test.ts',
	'deletes-no-parent-key.test.ts',
	'deletes.test.ts',
	'dependency-refusals.test.ts',
	// Milestone 22, slice S3: archiving or deleting an option is a discard, by every route; the upstream figures.
	'discard.test.ts',
	'docs-format.test.ts',
	// Card 2892: no sequence diagram under docs/ holds a semicolon or a bare # in a message.
	'docs-mermaid.test.ts',
	'error-shape.test.ts',
	'gate.test.ts',
	'gdrive-retention.test.ts',
	'harness.test.ts',
	'header-menus.svelte.test.ts',
	// Milestone 22, slice S5a: an ideas board, its kind, its conversion, and Send to board.
	'ideas-board.test.ts',
	// Milestone 22, slice S5b: the same on the screens (Create Board, the header, the More menu, the columns, the Send window).
	'ideas-screens.svelte.test.ts',
	// Card 2754, slice S1: whether bytes are a PNG, JPEG, GIF or WebP image, and their metadata taken out.
	'image-check.test.ts',
	// Card 2761, slice S2: the images stored before the card checked once at the first start.
	'image-recheck.test.ts',
	// Card 2754, slice S3: the images of cards closed long ago moved to the trash, as DumpFire itself.
	'image-retention.test.ts',
	'import-working-copy.test.ts',
	'internal-refusals.test.ts',
	// Card 2849: invite tokens stored as hashes, and the start-up sweep of those held in plain.
	'invite-hashes.test.ts',
	// Card 2670: the ISO 27001:2022 checklist's source, its page's load and the page.
	'iso-27001.test.ts',
	'kanban-column-header.svelte.test.ts',
	'live-streams.test.ts',
	'load-access-reads.test.ts',
	'load-query-counts.test.ts',
	'logger.test.ts',
	'mail-escaping.test.ts',
	'mail-failures.test.ts',
	'mail-links.test.ts',
	'mail-settings.test.ts',
	'markdown.test.ts',
	'mentions.test.ts',
	// Card 2773: the host's reset, scripts/mfa-reset.mjs, run in a process of its own on a scratch copy; and an
	// administrator's reset of another account's two-step sign-in, and invites refused for an enrolled account.
	'mfa-reset-script.test.ts',
	'mfa-reset.test.ts',
	// Card 2768: the MFA key file, sealing, TOTP and recovery codes; the start-up check, the store and the account changes.
	'mfa-secrets.test.ts',
	'mfa-storage.test.ts',
	'migrations.test.ts',
	// Card 2860: a single-board goal's bulk attach refusal naming its remedy, and the remedy taken.
	'milestone-cross-board.test.ts',
	// Card 2537: the New badge on the board's card and on the list's row, on one clock.
	'new-badge.svelte.test.ts',
	// Card 2719: an id on a board the caller cannot open is answered exactly as one that is not there.
	'not-found-not-forbidden.test.ts',
	'openapi-document.test.ts',
	// Milestone 22, slice S1b: the Options column's rules and its strip.
	'options-column.test.ts',
	// Card 2527: every delivery board has its Options column, made with it and by the start-up step.
	'options-everywhere.test.ts',
	'page-card-window.test.ts',
	'page-failures.test.ts',
	'password-checks.test.ts',
	// Card 2681: the people directory and its groups under API v1, and what a key may never change.
	'people-api.test.ts',
	'people-directory.test.ts',
	// Card 2697, slice B2b: the people dialog asking for the password with an address or an account.
	'people-directory.svelte.test.ts',
	'plan-graph.test.ts',
	'plan-page.test.ts',
	'plan-table.test.ts',
	'pricing.test.ts',
	'public-requests.test.ts',
	// Card 2935: ending or lowering an owner's or administrator's access holds the webhooks whose secret it could read.
	'readable-webhooks.test.ts',
	'report-mail.test.ts',
	'report-access.test.ts',
	'report-recipients.test.ts',
	'report-schedules.test.ts',
	'request-body.test.ts',
	// Card 2870: requester links kept as hashes, one per mail or ask, and the sweep after an older image.
	'request-links.test.ts',
	'schedulers.test.ts',
	// Card 2850: one Secure rule for every cookie, and the start-up warning for an http ORIGIN behind https.
	'secure-cookies.test.ts',
	// Card 2775: session codes stored as hashes, limits by role, and the __Host- cookie.
	'session-hardening.test.ts',
	'setting-setters.test.ts',
	'sftp-host-key.test.ts',
	'share-window.svelte.test.ts',
	// Card 2701: the password asked for again before destructive admin actions.
	'step-up.test.ts',
	// Card 2898: the secrets the server keeps in its database, sealed at rest.
	'stored-secrets.test.ts',
	'sub-board-depth.test.ts',
	'subtask-order.test.ts',
	'team-owners.test.ts',
	'test-helpers.test.ts',
	// Cards 2471 and 2516: the theme as a menu on every page, and help tips a screen reader announces.
	'theme-menus-and-tips.svelte.test.ts',
	'timestamps.test.ts',
	'todo-page.test.ts',
	'transaction.test.ts',
	// Card 2769: setting up two-step sign-in, on the password, after an invite and at the first-run set-up.
	'two-step-enrol.test.ts',
	// Card 2769: two-step sign-in, from sessions made only after a second factor to the code page.
	'two-step-sign-in.test.ts',
	// Milestone 22, slice S4a: options are left out of every delivery measure; lead and cycle time from the commitment.
	'upstream-measures.test.ts',
	// Milestone 22, slice S6: the public API's reads of upstream, its filters and the upstream figures.
	'upstream-api.test.ts',
	// Milestone 22, slice S4b: the same on the screens (Stats panel, flow diagram, dashboard, All Tasks, goals, reports).
	'upstream-screens.svelte.test.ts',
	'uploads-sweep.test.ts',
	'uploads.test.ts',
	'user-delete.test.ts',
	// Card 2754, slice S2b: a card's files listed and downloaded, and an image uploaded, through /api/v1 with a key.
	'v1-attachments.test.ts',
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
