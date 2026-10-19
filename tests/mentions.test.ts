/**
 * Who an @mention names (card 2207, `docs/planning/cards-2179-2180-2181-read-leaks-3.md`,
 * decisions 19 to 23).
 *
 * The rule was `@` and then `\w+`, lower-cased, and the name looked up as
 * typed: `@Greg` reached nobody when the account was `Greg`, `@jane.doe`
 * mailed `jane`, `bob@example.com` mailed an account called `example`, and
 * `@zoë` was read as `zo`. Now a mention starts at an `@` that no letter,
 * digit or `_` comes before, and its name is the longest username the text
 * after it begins with, in any case, where it ends at the end of a word. One
 * function, `findMentions` in `src/lib/mentions.ts`, decides it for the
 * server's mail and the page's chips alike. Which of the people named are
 * mailed is card 2198's rule and is tested in `atomic-creation.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { JSDOM } from 'jsdom';
import { findMentions } from '$lib/mentions';
import { createMarkdownRenderer } from '$lib/markdown';
import { parseMentions } from '$lib/server/mentions';
import { api } from './helpers/api';
import { effects } from './helpers/effects';
import { addBoardMember, makeBoard, makeCard, makeSmtp, makeUser, resetDb } from './helpers/fixtures';

beforeEach(resetDb);

/** The usernames each text is read against. */
const ACCOUNTS = ['Greg', 'jane', 'jane.doe', 'Jane-Doe', 'Jane Doe', "o'brien", 'zoë'];

/** What `findMentions` names in `text`, and the text it covers. */
const named = (text: string, usernames: readonly string[] = ACCOUNTS) =>
	findMentions(text, usernames).map((m) => ({ username: m.username, covers: text.slice(m.start, m.end) }));

describe('findMentions, the one rule', () => {
	it.each([
		['@Greg', [['Greg', '@Greg']]],
		['@greg', [['Greg', '@greg']]],
		['@GREG.', [['Greg', '@GREG']]],
		['@jane.doe', [['jane.doe', '@jane.doe']]],
		['@jane-doe', [['Jane-Doe', '@jane-doe']]],
		['@jane.', [['jane', '@jane']]],
		['@jane,', [['jane', '@jane']]],
		["@jane's", [['jane', '@jane']]],
		['(@jane)', [['jane', '@jane']]],
		['"@jane"', [['jane', '@jane']]],
		['@@jane', [['jane', '@jane']]],
		['@jane.smith', []],
		['@janet', []],
		['@jane_doe', []],
		['@jane2', []],
		['@Jane Doe will', [['Jane Doe', '@Jane Doe']]],
		["@o'brien", [["o'brien", "@o'brien"]]],
		['@ZOË', [['zoë', '@ZOË']]],
		['bob@jane.doe', []],
		['a@greg', []],
		['@nobody', []]
	] as [string, [string, string][]][])('%s', (text, expected) => {
		expect(named(text)).toEqual(expected.map(([username, covers]) => ({ username, covers })));
	});

	it('gives each mention where its @ is and where its name ends, in order', () => {
		const text = 'Hi @greg, ask @Jane Doe or @jane.doe; not mail@greg.';
		expect(findMentions(text, ACCOUNTS)).toEqual([
			{ start: 3, end: 8, username: 'Greg' },
			{ start: 14, end: 23, username: 'Jane Doe' },
			{ start: 27, end: 36, username: 'jane.doe' }
		]);
	});

	it('takes the name typed exactly where two differ only in case, and neither where it is typed in neither spelling', () => {
		const pair = ['Sam', 'sam'];
		expect(named('@Sam', pair)).toEqual([{ username: 'Sam', covers: '@Sam' }]);
		expect(named('@sam', pair)).toEqual([{ username: 'sam', covers: '@sam' }]);
		expect(named('@SAM', pair)).toEqual([]);
	});

	it('names nobody when it is given no usernames', () => {
		expect(findMentions('@greg and @jane', [])).toEqual([]);
	});
});

/**
 * The server finds mentions inside the comment's write transaction, and the
 * page on every text node it draws, so a long text must not cost a look at
 * every account for every `@` (review of card 2207: one comment of 50,000
 * `@` against 1,000 accounts took about 713 ms). The bound is generous; the
 * measured times are in the plan's "Review fixes".
 */
describe('findMentions on a long text', () => {
	const many = (n: number, name: (i: number) => string) => Array.from({ length: n }, (_, i) => name(i));
	const timed = (text: string, usernames: readonly string[]) => {
		const begun = performance.now();
		const found = findMentions(text, usernames);
		return { found, ms: performance.now() - begun };
	};

	it('50,000 @ against 3,000 usernames, well under 50 ms', () => {
		const { found, ms } = timed('@'.repeat(50_000), many(3_000, (i) => `user${i}`));
		expect(found).toEqual([]);
		expect(ms).toBeLessThan(50);
	});

	it('50,000 @a against 3,000 usernames that begin with a, well under 50 ms', () => {
		const { found, ms } = timed('@a '.repeat(50_000), many(3_000, (i) => `a${i}`));
		expect(found).toEqual([]);
		expect(ms).toBeLessThan(50);
	});

	it('looks at no more than the first 200 @ that could start a name', () => {
		const text = '@ @@ '.repeat(500) + '@greg '.repeat(250);
		expect(findMentions(text, ACCOUNTS)).toHaveLength(200);
	});
});

describe('the chip on the page', () => {
	const win = new JSDOM('', { url: 'https://dumpfire.test/board/1' }).window as unknown as Window & typeof globalThis;
	const render = createMarkdownRenderer(win);

	it('wraps the text as written, never the stored name, and gives an unknown name no chip', () => {
		expect(render('hi @JANE.DOE and @nobody', { mentions: ['jane.doe'] })).toBe(
			'<p>hi <span class="mention-chip">@JANE.DOE</span> and @nobody</p>\n'
		);
	});
});

describe('the mail, through both routes that add a comment', () => {
	const ROUTES = [
		['POST /api/cards/{id}/comments', (cardId: number) => `/api/cards/${cardId}/comments`],
		['POST /api/v1/cards/{id}/comments', (cardId: number) => `/api/v1/cards/${cardId}/comments`]
	] as const;

	/** A board A that `owner` owns, with `viewers` on it and a card; mail switched on. */
	function boardWith(...viewers: string[]) {
		const owner = makeUser({ username: 'owner' });
		const { board, cols } = makeBoard({ owner, name: 'A' });
		for (const username of viewers) addBoardMember(board, makeUser({ username }), 'viewer');
		makeSmtp();
		return { owner, card: makeCard(cols['To Do'], { title: 'First' }) };
	}

	async function comment(path: string, owner: ReturnType<typeof makeUser>, content: string) {
		const sent = effects();
		try {
			const res = await api('POST', path, { user: owner, body: { content } });
			await sent.settle();
			expect(res.status).toBe(201);
			return sent.emails.map((e) => `${e.to}: ${e.subject}`);
		} finally {
			sent.restore();
		}
	}

	it.each(ROUTES)('%s mails the account named in any case and with a dot, and not the shorter name before the dot', async (_route, path) => {
		const { owner, card } = boardWith('Greg', 'jane', 'jane.doe');

		const mails = await comment(path(card.id), owner, '@greg and @jane.doe, please');

		expect(mails.filter((m) => m.endsWith('owner mentioned you: First')).sort()).toEqual([
			'Greg@example.test: owner mentioned you: First',
			'jane.doe@example.test: owner mentioned you: First'
		]);
	});

	it.each(ROUTES)('%s reads no mention in an email address', async (_route, path) => {
		const { owner, card } = boardWith('example');

		const mails = await comment(path(card.id), owner, 'Write to bob@example.com about it');

		expect(mails).toEqual(['example@example.test: New comment on: First']);
	});
});

describe('one rule, read from the source', () => {
	const root = process.cwd();
	function files(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
			const p = join(dir, e.name);
			return e.isDirectory() ? files(p) : /\.(ts|js|svelte)$/.test(e.name) ? [p] : [];
		});
	}
	const rel = (p: string) => relative(root, p).split(sep).join('/');

	it('has one matcher, which the server and the renderer import, and no copy of the old pattern', () => {
		expect(existsSync(join(root, 'src/lib/utils/mentions.ts'))).toBe(false);
		expect(files(join(root, 'src')).filter((f) => readFileSync(f, 'utf8').includes('@(\\w+)')).map(rel)).toEqual([]);
		for (const file of ['src/lib/server/mentions.ts', 'src/lib/markdown.ts']) {
			expect(readFileSync(join(root, file), 'utf8'), file).toMatch(/import \{ findMentions \} from '\$lib\/mentions';/);
		}
	});

	it('the server mails the usernames findMentions names, as stored, each once', () => {
		const text = 'Hi @GREG, @jane and @greg; mail a@jane.doe';
		expect(parseMentions(text, ACCOUNTS)).toEqual(['Greg', 'jane']);
	});
});
