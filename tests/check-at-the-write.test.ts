/**
 * Access is checked at the write (card 2115).
 *
 * A handler that looked up a row, checked the caller against it, and only then
 * awaited the request's body decided on a row that another request could
 * change while the body was arriving: an editor taken off the board, a team
 * owner demoted, a label deleted. What got through was a write the caller was
 * entitled to a moment earlier, or an update that found nothing and answered
 * 200 with no body. Twenty-two handlers did it, eleven in each tree.
 *
 * Every handler now reads its body first. Then one transaction runs the row's
 * guard (404, then 403), reads every field through the readers of
 * `src/lib/server/request-body.ts` (400), looks for the ids named in the body
 * (404), writes, and queues what it tells anyone. Before the body only what
 * reads no row may be asked: the session the gate read, and the id in the
 * path. The plan is `docs/planning/cards-2114-2115-2138-2139-writes.md`.
 *
 * Four kinds of test:
 *
 *   - the rule, read from the source and failing closed: in every handler
 *     under `src/routes/api`, every call made before the body is read is on a
 *     short list of calls that read no row, or the handler is on `ALLOWED`
 *     with the reason;
 *   - each of the 21 handlers reads the rows its guard reads only inside a
 *     transaction (the twenty-second, `POST /api/cards/{id}/dependencies`, is
 *     held by `tests/atomic-dependencies.test.ts`);
 *   - a membership taken away as the check reads it, as another request would
 *     take it, does not let the write through;
 *   - the answers that changed: a board or a team that is not there is 404 to
 *     everyone, and a body that cannot be read is 400 to a caller who would be
 *     refused.
 *
 * What each handler refuses in its fields is in `tests/request-body.test.ts`,
 * and for the report schedule in `tests/internal-refusals.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import {
	boardCategories,
	boardMembers,
	boards,
	cardLabels,
	categories,
	labels,
	reportSchedules,
	teamMembers,
	type BoardCategory,
	type Card,
	type CardComment,
	type Category,
	type Label,
	type Team,
	type webhooks
} from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { api, type ApiResult } from './helpers/api';
import { effects } from './helpers/effects';
import {
	addBoardMember,
	makeBoard,
	makeCard,
	makeComment,
	makeLabel,
	makeTeam,
	makeUser,
	makeWebhook,
	resetDb,
	type BoardFixture
} from './helpers/fixtures';
import { watchReads } from './helpers/reads';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

beforeEach(resetDb);

// ─── The rule, read from the source ─────────────────────────────────────────

const ROOT = process.cwd();

/** The methods a route exports that answer a request. */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * What may be called before the body is read: what reads no row. A refusal,
 * the id in the path, the session the gate has already read, and the
 * session's cookie, which the routes that ask for a password count wrong
 * ones against.
 */
const READS_NO_ROW = ['error', 'Number', 'isNaN', 'pathId', 'requireUser', 'requireSuperadmin', 'isAdmin', 'cookies.get'];

/** The request's own methods that read its body. */
const READER_METHODS = ['json', 'formData', 'arrayBuffer', 'text', 'blob', 'bytes'];

/**
 * The functions known to read the body when they are given the request. Any
 * other function given the request is taken for a read and fails, by name, so
 * that a new helper cannot read the body unseen.
 */
const BODY_READERS = ['readBody'];

/**
 * The handlers that ask something else before their body, by file and method,
 * with why. An entry that no longer matches a handler that does fails, so the
 * list can only shrink.
 */
const ALLOWED: Record<string, string> = {
	'src/routes/api/cards/[id]/attachments/+server.ts POST':
		'The upload asks before it reads 25 MB, so that a caller with no access is not sent it, and asks again with the row inside ' +
		'the transaction that attaches it (docs/authentication-security.md, "An upload is the one request that checks twice").',
	'src/routes/api/requests/+server.ts POST':
		'The public request form: the form token and the rate limits are asked before the body. They read no row.',
	'src/routes/api/requests/[id]/confirm/+server.ts POST':
		'The confirmation link: the rate limit is asked before the body. It reads no row.',
	'src/routes/api/requests/[id]/link/+server.ts POST':
		'The new link a requester asks for (card 2158): the rate limit per address is asked before the body, so that every ask ' +
		'is counted. It reads no row.',
	'src/routes/api/admin/import/+server.ts POST':
		'The import settles `outside` and the media type before it reads the upload, and answers either before any of it is read. ' +
		'Who may import is requireSuperadmin, the session.'
};

/**
 * The fewest handlers that read a body. There were 97 when the rule was
 * written. The floor is set well below, at 50, so that moving handlers about
 * does not trip it, and still high enough that a parser that saw none could
 * not pass. What it cannot see, a handler
 * whose text reads a body where the parser finds no read, fails on its own
 * (`unseen`).
 */
const FEWEST_READING = 50;

/**
 * A body read, as text: what a handler that reads its body has in it however
 * it came by the request. Looked for in a handler the parser says reads no
 * body, where it would mean the parser has missed the read: the request
 * taken out of the event inside the handler (`const { request } = event`), or
 * the body read in a function written inside it.
 */
const READS_A_BODY_AS_TEXT = /\breadBody\(|\brequest\.(json|formData|arrayBuffer|text|blob|bytes)\(/;

type Handler = { file: string; method: string; line: number };

type Reading = {
	/** Every handler exported, and whether it reads a body. */
	handlers: (Handler & { reads: boolean })[];
	/** `file:line METHOD calls name before it reads its body`, one for each call. */
	early: { handler: string; finding: string }[];
	/** A handler exported that is not a function this can read: it fails, as one that is not looked at. */
	unread: string[];
	/** A handler counted as reading no body whose text reads one: the parser missed the read, and it fails. */
	unseen: string[];
};

/** Every file under `dir` whose path `keep` says yes to, from the repository root with forward slashes. */
function filesUnder(dir: string, keep: (path: string) => boolean): string[] {
	return (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
		.map((path) => `${dir}/${path.split('\\').join('/')}`)
		.filter(keep)
		.sort();
}

/** `node` without the parentheses, `await` and `!` round it. */
function bare(node: ts.Expression): ts.Expression {
	let inner = node;
	while (ts.isParenthesizedExpression(inner) || ts.isAwaitExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
	return inner;
}

/** What a call calls, as it is written: `error`, `url.searchParams.get`. */
function calleeOf(call: ts.CallExpression, tree: ts.SourceFile): string {
	return call.expression.getText(tree).replace(/\s+/g, '');
}

/** A function a handler can be written as. */
type HandlerFunction = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** The function an exported handler is: `export const PUT = async (...) => {}` or `export async function PUT(...)`. */
function handlersOf(tree: ts.SourceFile): { method: string; fn: HandlerFunction | undefined; at: ts.Node }[] {
	const found: { method: string; fn: HandlerFunction | undefined; at: ts.Node }[] = [];
	for (const statement of tree.statements) {
		const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
		if (!exported) continue;
		if (ts.isFunctionDeclaration(statement) && statement.name && METHODS.includes(statement.name.text)) {
			found.push({ method: statement.name.text, fn: statement, at: statement });
		}
		if (ts.isVariableStatement(statement)) {
			for (const declared of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declared.name) || !METHODS.includes(declared.name.text)) continue;
				const value = declared.initializer && bare(declared.initializer);
				const fn = value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ? value : undefined;
				found.push({ method: declared.name.text, fn, at: declared });
			}
		}
	}
	return found;
}

/**
 * The calls one handler makes before it reads its body, and whether it reads
 * one. The body is read by the first call that is a reader method of the
 * request (`request.json()`) or is given the request (`readBody(request)`).
 * The request is found by what the handler is given: `{ request }`,
 * `{ request: req }`, or `event` and `event.request`. A function written
 * inside the handler is not looked into, because writing it calls nothing;
 * calling it before the body is a call like any other.
 */
function readHandler(file: string, tree: ts.SourceFile, fn: HandlerFunction): { reads: boolean; early: string[] } {
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const names = new Set<string>();
	let eventName: string | undefined;
	const [given] = fn.parameters;
	if (given && ts.isObjectBindingPattern(given.name)) {
		for (const element of given.name.elements) {
			const key = element.propertyName ?? element.name;
			if (ts.isIdentifier(key) && key.text === 'request' && ts.isIdentifier(element.name)) names.add(element.name.text);
		}
	} else if (given && ts.isIdentifier(given.name)) {
		eventName = given.name.text;
	}
	const isTheRequest = (node: ts.Expression): boolean => {
		const held = bare(node);
		if (ts.isIdentifier(held)) return names.has(held.text);
		return (
			eventName !== undefined &&
			ts.isPropertyAccessExpression(held) &&
			held.name.text === 'request' &&
			ts.isIdentifier(held.expression) &&
			held.expression.text === eventName
		);
	};

	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) calls.push(node);
		ts.forEachChild(node, (child) => {
			if (!ts.isFunctionLike(child)) visit(child);
		});
	};
	if (fn.body) visit(fn.body);

	const isRead = (call: ts.CallExpression): boolean => {
		const callee = call.expression;
		if (ts.isPropertyAccessExpression(callee) && READER_METHODS.includes(callee.name.text) && isTheRequest(callee.expression)) return true;
		return call.arguments.some((argument) => isTheRequest(argument));
	};
	const read = calls.filter(isRead).sort((a, b) => a.getStart(tree) - b.getStart(tree))[0];
	if (!read) return { reads: false, early: [] };

	const early: string[] = [];
	const readCallee = ts.isPropertyAccessExpression(read.expression) && isTheRequest(read.expression.expression) ? null : calleeOf(read, tree);
	if (readCallee !== null && !BODY_READERS.includes(readCallee)) {
		early.push(`${file}:${line(read)} gives the request to ${readCallee}, which is not a known body reader`);
	}
	for (const call of calls) {
		if (call.getEnd() > read.getStart(tree)) continue;
		const callee = calleeOf(call, tree);
		if (!READS_NO_ROW.includes(callee)) early.push(`${file}:${line(call)} calls ${callee} before it reads its body`);
	}
	return { reads: true, early };
}

/** Every handler of one file. */
function readFile(file: string, source: string): Reading {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const reading: Reading = { handlers: [], early: [], unread: [], unseen: [] };
	for (const { method, fn, at } of handlersOf(tree)) {
		const line = tree.getLineAndCharacterOfPosition(at.getStart(tree)).line + 1;
		if (!fn) {
			reading.unread.push(`${file}:${line} ${method} is not a function this test can read`);
			continue;
		}
		const { reads, early } = readHandler(file, tree, fn);
		reading.handlers.push({ file, method, line, reads });
		if (!reads && READS_A_BODY_AS_TEXT.test(fn.getText(tree))) {
			reading.unseen.push(`${file}:${line} ${method} reads a body where this test cannot find the read`);
		}
		for (const finding of early) reading.early.push({ handler: `${file} ${method}`, finding: `${finding} (${method})` });
	}
	return reading;
}

describe('every handler reads its body before it reads a row', () => {
	const files = filesUnder('src/routes/api', (path) => path.endsWith('/+server.ts'));
	const all: Reading = { handlers: [], early: [], unread: [], unseen: [] };
	for (const file of files) {
		const reading = readFile(file, readFileSync(join(ROOT, file), 'utf8'));
		all.handlers.push(...reading.handlers);
		all.early.push(...reading.early);
		all.unread.push(...reading.unread);
		all.unseen.push(...reading.unseen);
	}

	it('calls nothing before the body but what reads no row, or is on ALLOWED', () => {
		const unlisted = all.early.filter(({ handler }) => !(handler in ALLOWED)).map(({ finding }) => finding);

		// Each line names the file, the line, the call and the handler. Read the
		// body first, and call the guard inside the transaction that writes.
		expect(unlisted).toEqual([]);
	});

	it('has nothing on ALLOWED that no longer asks anything before its body', () => {
		const asking = new Set(all.early.map(({ handler }) => handler));

		expect(Object.keys(ALLOWED).filter((handler) => !asking.has(handler))).toEqual([]);
	});

	it('reads every handler it finds', () => {
		expect(all.unread).toEqual([]);
	});

	it('finds the read in every handler whose text reads a body', () => {
		// Each names the file, the line and the handler. Take the request from
		// the handler's own parameter, `{ request }` or `event.request`, and
		// read the body in the handler itself.
		expect(all.unseen).toEqual([]);
	});

	it('was looked for in the whole tree', () => {
		expect(files.length).toBeGreaterThanOrEqual(120);
		expect(all.handlers.length).toBeGreaterThanOrEqual(200);
		expect(all.handlers.filter((h) => h.reads).length).toBeGreaterThanOrEqual(FEWEST_READING);
		// One of each way a handler is given its request, found reading a body.
		const reads = (file: string, method: string) => all.handlers.some((h) => h.file === file && h.method === method && h.reads);
		expect(reads('src/routes/api/v1/labels/[labelId]/+server.ts', 'PUT')).toBe(true);
		expect(reads('src/routes/api/requests/[id]/messages/+server.ts', 'POST')).toBe(true);
		expect(reads('src/routes/api/cards/[id]/attachments/+server.ts', 'POST')).toBe(true);
	});
});

describe('the rule itself', () => {
	const of = (code: string) => readFile('src/routes/api/example/+server.ts', code).early.map(({ finding }) => finding);

	it('finds a guard called before the body, by file, line, call and handler', () => {
		const code = [
			'export const PUT = async ({ params, request, locals }) => {',
			'\tconst user = requireUser(locals.user);',
			'\tconst { label } = requireLabel(user, Number(params.labelId), "edit");',
			'\tconst body = await readBody(request);',
			'};'
		].join('\n');

		expect(of(code)).toEqual(['src/routes/api/example/+server.ts:3 calls requireLabel before it reads its body (PUT)']);
	});

	it('finds the body read as req.json(), as event.request.json(), and through .catch', () => {
		const early = (head: string, read: string) => of(`export const POST = async (${head}) => {\n\tcanEditBoard(1, 2);\n\tconst b = await ${read};\n};`);

		expect(early('{ request: req }', 'req.json()')).toEqual(['src/routes/api/example/+server.ts:2 calls canEditBoard before it reads its body (POST)']);
		expect(early('event', 'event.request.formData()')).toHaveLength(1);
		expect(early('{ request }', 'request.json().catch(() => ({}))')).toHaveLength(1);
		expect(early('{ request }', 'readBody(request)')).toHaveLength(1);
	});

	it('refuses a function given the request that is not a known body reader', () => {
		const code = 'export const POST = async ({ request }) => {\n\tconst b = await parse(request);\n};';

		expect(of(code)).toEqual([
			'src/routes/api/example/+server.ts:2 gives the request to parse, which is not a known body reader (POST)'
		]);
	});

	it('lets through what reads no row, a function written and not called, and anything after the body', () => {
		const code = [
			'export const PUT = async ({ params, request, locals }) => {',
			'\tif (!locals.user) throw error(401, "Not authenticated");',
			'\tconst id = pathId(params.id, "card");',
			'\tconst old = Number(params.id); if (isNaN(old)) throw error(400, "Invalid");',
			'\tconst shape = (row) => present(row);',
			'\tconst body = await readBody(request);',
			'\treturn inTransaction(() => requireCard(locals.user, id, "edit"));',
			'};',
			// A handler that reads no body may call what it likes.
			'export const GET = async ({ params, locals }) => json(requireCard(locals.user, Number(params.id), "view"));',
			// `request` that is not the event's request, as in requests/[id]: a row.
			'export const DELETE = async ({ params, locals }) => {\n\tconst request = find(params.id);\n\tallowed(locals.user, request);\n};'
		].join('\n');

		expect(of(code)).toEqual([]);
	});

	it('cannot be passed by a handler it cannot read', () => {
		const reading = readFile('src/routes/api/example/+server.ts', 'export const POST = makeHandler();');

		expect(reading.unread).toEqual(['src/routes/api/example/+server.ts:1 POST is not a function this test can read']);
	});

	it('cannot be passed by a read it does not see: the request taken from the event in the handler, or the body read in a function inside it', () => {
		const unseen = (code: string) => readFile('src/routes/api/example/+server.ts', code).unseen;
		const destructured = [
			'export const POST = async (event) => {',
			'\tconst { request } = event;',
			'\tcanEditBoard(1, 2);',
			'\tconst b = await request.json();',
			'};'
		].join('\n');
		const nested = [
			'export const PUT = async ({ request, params }) => {',
			'\tconst read = () => readBody(request);',
			'\trequireLabel(user, Number(params.labelId), "edit");',
			'\tconst b = await read();',
			'};'
		].join('\n');

		expect(unseen(destructured)).toEqual(['src/routes/api/example/+server.ts:1 POST reads a body where this test cannot find the read']);
		expect(unseen(nested)).toEqual(['src/routes/api/example/+server.ts:1 PUT reads a body where this test cannot find the read']);
		// Read where the test can see it, it is not unseen: it is judged by the rule.
		expect(unseen('export const POST = async ({ request }) => {\n\tconst b = await readBody(request);\n};')).toEqual([]);
		// A row named request that is read for its fields is no body.
		expect(unseen('export const DELETE = async ({ params }) => {\n\tconst request = find(params.id);\n\treturn json(request.title);\n};')).toEqual([]);
	});
});

// ─── The rows a guard reads, read where they are used ───────────────────────

type Scene = {
	/** Owns board A. */
	owner: SessionUser;
	admin: SessionUser;
	/** May edit board A. */
	editor: SessionUser;
	/** Has nothing to do with board A or the team. */
	outsider: SessionUser;
	A: BoardFixture;
	card: Card;
	label: Label;
	/** A card category of board A. */
	category: Category;
	/** A dashboard grouping board A is filed under. */
	grouping: BoardCategory;
	/** The owner's comment on `card`. */
	comment: CardComment;
	/** Owned by `teamOwner`, who is not an administrator. */
	team: Team;
	teamOwner: SessionUser;
	/** The owner's report schedule of board A. */
	scheduleId: number;
	webhook: typeof webhooks.$inferSelect;
};

function scene(): Scene {
	const owner = makeUser({ username: 'owner' });
	const admin = makeUser({ username: 'admin', role: 'admin' });
	const editor = makeUser({ username: 'editor' });
	const outsider = makeUser({ username: 'outsider' });
	const teamOwner = makeUser({ username: 'team-owner' });
	const A = makeBoard({ owner, name: 'A' });
	addBoardMember(A.board, editor, 'editor');
	const card = makeCard(A.cols['To Do'], { title: 'A card' });
	const label = makeLabel(A.board, 'A label');
	const category = db.insert(categories).values({ boardId: A.board.id, name: 'A category' }).returning().get();
	const grouping = db.insert(boardCategories).values({ name: 'A grouping' }).returning().get();
	db.update(boards).set({ categoryId: grouping.id }).where(eq(boards.id, A.board.id)).run();
	const comment = makeComment(card, owner, 'Said');
	const team = makeTeam([teamOwner, editor], 'A team');
	db.update(teamMembers).set({ role: 'owner' }).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, teamOwner.id))).run();
	const scheduleId = db
		.insert(reportSchedules)
		.values({ userId: owner.id, name: 'Weekly', scope: 'board', scopeId: A.board.id, frequency: 'weekly' })
		.returning()
		.get().id;
	const webhook = makeWebhook(A.board);
	return { owner, admin, editor, outsider, A, card, label, category, grouping, comment, team, teamOwner, scheduleId, webhook };
}

describe('each reads the rows its guard reads inside the transaction that writes', () => {
	/**
	 * For each handler, the tables its guard reads, and a request that
	 * succeeds. Every read of each table must be inside a transaction, and
	 * there must be one. Read before the body, as all 21 were, the first read
	 * was outside one.
	 */
	type Case = {
		route: string;
		tables: string[];
		status: number;
		/** Rows the request needs that the scene does not have. */
		prepare?: (s: Scene) => void;
		request: (s: Scene) => Promise<ApiResult>;
	};
	const send =
		(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: (s: Scene) => string, body: (s: Scene) => unknown, as: (s: Scene) => SessionUser = (s) => s.owner) =>
		(s: Scene) =>
			api(method, path(s), { user: as(s), body: body(s) });

	const CASES: Case[] = [
		{
			route: 'PUT /api/teams/:id',
			tables: ['teams', 'team_members'],
			status: 200,
			request: send('PUT', (s) => `/api/teams/${s.team.id}`, () => ({ name: 'Renamed' }), (s) => s.teamOwner)
		},
		{
			route: 'POST /api/teams/:id/members/:userId',
			tables: ['teams', 'team_members'],
			status: 201,
			request: send('POST', (s) => `/api/teams/${s.team.id}/members/${s.outsider.id}`, (s) => ({ userId: s.outsider.id }), (s) => s.teamOwner)
		},
		{
			route: 'PUT /api/boards/:id',
			tables: ['boards', 'board_members'],
			status: 200,
			request: send('PUT', (s) => `/api/boards/${s.A.board.id}`, () => ({ name: 'Renamed' }), (s) => s.editor)
		},
		{
			route: 'POST /api/boards/:id/share',
			tables: ['boards', 'board_members'],
			status: 200,
			request: send('POST', (s) => `/api/boards/${s.A.board.id}/share`, (s) => ({ type: 'user', targetId: s.outsider.id, role: 'viewer' }))
		},
		{
			route: 'PATCH /api/boards/:id/share',
			tables: ['boards'],
			status: 200,
			request: send('PATCH', (s) => `/api/boards/${s.A.board.id}/share`, () => ({ isPublic: true }))
		},
		{
			route: 'DELETE /api/boards/:id/share',
			tables: ['boards'],
			status: 200,
			prepare: (s) => addBoardMember(s.A.board, s.outsider, 'viewer'),
			request: send('DELETE', (s) => `/api/boards/${s.A.board.id}/share`, (s) => ({ type: 'user', targetId: s.outsider.id }))
		},
		{
			route: 'PUT /api/categories/:id',
			tables: ['categories', 'board_members'],
			status: 200,
			request: send('PUT', (s) => `/api/categories/${s.category.id}`, () => ({ name: 'Renamed' }), (s) => s.editor)
		},
		{
			route: 'PUT /api/board-categories/:id',
			tables: ['board_categories', 'board_members'],
			status: 200,
			request: send('PUT', (s) => `/api/board-categories/${s.grouping.id}`, () => ({ name: 'Renamed' }), (s) => s.editor)
		},
		{
			route: 'PUT /api/cards/:id/comments/:commentId',
			tables: ['card_comments', 'cards'],
			status: 200,
			request: send('PUT', (s) => `/api/cards/${s.card.id}/comments/${s.comment.id}`, () => ({ content: 'Edited' }))
		},
		{
			route: 'PUT /api/report-schedules/:id',
			tables: ['report_schedules'],
			status: 200,
			request: send('PUT', (s) => `/api/report-schedules/${s.scheduleId}`, () => ({ enabled: false }))
		},
		{
			route: 'POST /api/v1/boards/:boardId/columns',
			tables: ['boards', 'board_members'],
			status: 201,
			request: send('POST', (s) => `/api/v1/boards/${s.A.board.id}/columns`, () => ({ title: 'Review' }), (s) => s.editor)
		},
		{
			route: 'POST /api/v1/boards/:boardId/labels',
			tables: ['boards', 'board_members'],
			status: 201,
			request: send('POST', (s) => `/api/v1/boards/${s.A.board.id}/labels`, () => ({ name: 'Urgent' }), (s) => s.editor)
		},
		{
			route: 'POST /api/v1/boards/:boardId/categories',
			tables: ['boards', 'board_members'],
			status: 201,
			request: send('POST', (s) => `/api/v1/boards/${s.A.board.id}/categories`, () => ({ name: 'Bug' }), (s) => s.editor)
		},
		{
			route: 'POST /api/v1/boards/:boardId/webhooks',
			tables: ['boards', 'board_members'],
			status: 201,
			request: send('POST', (s) => `/api/v1/boards/${s.A.board.id}/webhooks`, () => ({ url: 'https://hooks.example.test/new' }), (s) => s.editor)
		},
		{
			route: 'POST /api/v1/cards/:cardId/labels',
			tables: ['cards', 'labels', 'board_members'],
			status: 201,
			request: send('POST', (s) => `/api/v1/cards/${s.card.id}/labels`, (s) => ({ labelId: s.label.id }), (s) => s.editor)
		},
		{
			route: 'DELETE /api/v1/cards/:cardId/labels',
			tables: ['cards', 'board_members'],
			status: 200,
			prepare: (s) => void db.insert(cardLabels).values({ cardId: s.card.id, labelId: s.label.id }).run(),
			request: send('DELETE', (s) => `/api/v1/cards/${s.card.id}/labels`, (s) => ({ labelId: s.label.id }), (s) => s.editor)
		},
		{
			route: 'PUT /api/v1/labels/:labelId',
			tables: ['labels', 'board_members'],
			status: 200,
			request: send('PUT', (s) => `/api/v1/labels/${s.label.id}`, () => ({ name: 'Renamed' }), (s) => s.editor)
		},
		{
			// The card window's label picker renames a label here (card 2010).
			route: 'PATCH /api/labels',
			tables: ['labels', 'board_members'],
			status: 200,
			request: send('PATCH', () => '/api/labels', (s) => ({ id: s.label.id, name: 'Renamed' }), (s) => s.editor)
		},
		{
			route: 'PUT /api/v1/categories/:categoryId',
			tables: ['categories', 'board_members'],
			status: 200,
			request: send('PUT', (s) => `/api/v1/categories/${s.category.id}`, () => ({ name: 'Renamed' }), (s) => s.editor)
		},
		{
			route: 'PUT /api/v1/board-categories/:categoryId',
			tables: ['board_categories', 'board_members'],
			status: 200,
			request: send('PUT', (s) => `/api/v1/board-categories/${s.grouping.id}`, () => ({ name: 'Renamed' }), (s) => s.editor)
		},
		{
			route: 'PUT /api/v1/columns/:columnId',
			tables: ['columns', 'board_members'],
			status: 200,
			request: send('PUT', (s) => `/api/v1/columns/${s.A.cols['On Hold'].id}`, () => ({ title: 'Waiting' }), (s) => s.editor)
		},
		{
			route: 'PUT /api/v1/webhooks/:webhookId',
			tables: ['webhooks', 'board_members'],
			status: 200,
			request: send('PUT', (s) => `/api/v1/webhooks/${s.webhook.id}`, () => ({ active: false }), (s) => s.editor)
		}
	];

	it('has a case for each of the 21 handlers, and for any added since', () => {
		expect(new Set(CASES.map((c) => c.route)).size).toBeGreaterThanOrEqual(21);
		expect(new Set(CASES.map((c) => c.route)).size).toBe(CASES.length);
	});

	for (const c of CASES) {
		for (const table of c.tables) {
			it(`${c.route} (${table})`, async () => {
				const s = scene();
				c.prepare?.(s);
				const sent = effects();
				// Installed last: it counts every read of the table from here on.
				const reads = watchReads(table);

				let res: ApiResult;
				try {
					res = await c.request(s);
				} finally {
					reads.restore();
					sent.restore();
				}

				expect(res.status, JSON.stringify(res.body)).toBe(c.status);
				expect(reads.inTransaction.length).toBeGreaterThan(0);
				expect(reads.inTransaction).toEqual(reads.inTransaction.map(() => true));
			});
		}
	}
});

// ─── Access taken away while the body arrives ───────────────────────────────

describe('access taken away as the check reads it does not let the write through', () => {
	/**
	 * Another request takes the caller's access away just as this one reads
	 * it: what an owner removing an editor, while the editor's body was still
	 * arriving, would do. With the check before the body, the write went
	 * through on the access the caller had a moment earlier: the plan's probe
	 * renamed a label for an editor who was no longer one. Read inside the
	 * transaction that writes, nothing can come between, and `afterRead` is
	 * never called.
	 */
	it('PUT /api/v1/labels/:labelId, the editor removed from the board', async () => {
		const s = scene();
		let landed = false;
		const reads = watchReads('board_members', (nth) => {
			if (nth !== 1) return;
			landed = true;
			db.delete(boardMembers).where(and(eq(boardMembers.boardId, s.A.board.id), eq(boardMembers.userId, s.editor.id))).run();
		});

		let res: ApiResult;
		try {
			res = await api('PUT', `/api/v1/labels/${s.label.id}`, { user: s.editor, body: { name: 'Renamed' } });
		} finally {
			reads.restore();
		}

		expect(landed).toBe(false);
		expect(res.status).toBe(200);
	});

	it('PUT /api/teams/:id, the team owner made a member', async () => {
		const s = scene();
		let landed = false;
		const reads = watchReads('team_members', (nth) => {
			if (nth !== 1) return;
			landed = true;
			db.update(teamMembers).set({ role: 'member' }).where(eq(teamMembers.userId, s.teamOwner.id)).run();
		});

		let res: ApiResult;
		try {
			res = await api('PUT', `/api/teams/${s.team.id}`, { user: s.teamOwner, body: { name: 'Renamed' } });
		} finally {
			reads.restore();
		}

		expect(landed).toBe(false);
		expect(res.status).toBe(200);
	});
});

// ─── The answers that changed (decision 3) ──────────────────────────────────

describe('a board or a team that is not there is 404 to everyone', () => {
	/**
	 * The guards look the row up before they ask who the caller is. These
	 * handlers asked first, so everyone but an administrator was told 403 for
	 * a row that is not there, and an administrator, who passes every check,
	 * was answered 200 for doing nothing or a 500 from the database.
	 */
	const MISSING = 99999;
	type Missing = { request: string; body?: unknown; says: string };
	const CASES: Missing[] = [
		{ request: `POST /api/v1/boards/${MISSING}/columns`, body: { title: 'x' }, says: 'Board not found' },
		{ request: `POST /api/v1/boards/${MISSING}/labels`, body: { name: 'x' }, says: 'Board not found' },
		{ request: `POST /api/v1/boards/${MISSING}/categories`, body: { name: 'x' }, says: 'Board not found' },
		{ request: `PUT /api/boards/${MISSING}`, body: { name: 'x' }, says: 'Board not found' },
		// A read, put right with card 2130: an administrator was answered an empty list.
		{ request: `GET /api/boards/${MISSING}/share`, says: 'Board not found' },
		{ request: `POST /api/boards/${MISSING}/share`, body: { type: 'user', targetId: 1, role: 'viewer' }, says: 'Board not found' },
		{ request: `PATCH /api/boards/${MISSING}/share`, body: { isPublic: true }, says: 'Board not found' },
		{ request: `DELETE /api/boards/${MISSING}/share`, body: { type: 'user', targetId: 1 }, says: 'Board not found' },
		{ request: `PUT /api/teams/${MISSING}`, body: { name: 'x' }, says: 'Team not found' },
		{ request: `DELETE /api/teams/${MISSING}`, says: 'Team not found' },
		{ request: `POST /api/teams/${MISSING}/members/1`, body: { userId: 1 }, says: 'Team not found' },
		{ request: `DELETE /api/teams/${MISSING}/members/1`, says: 'Team not found' }
	];

	for (const c of CASES) {
		it(c.request, async () => {
			const s = scene();
			const [method, path] = c.request.split(' ') as ['GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', string];

			for (const caller of [s.admin, s.owner, s.outsider]) {
				const before = snapshotDb();
				const res = await api(method, path, { user: caller, body: c.body });

				expect(res.status, caller.username).toBe(404);
				expect(res.body).toEqual({ message: c.says });
				expectUnchanged(before, caller.username);
			}
		});
	}

	it('and a share to somebody, or a team, that is not there is 404 too', async () => {
		const s = scene();
		const share = (body: unknown) => api('POST', `/api/boards/${s.A.board.id}/share`, { user: s.owner, body });

		expect((await share({ type: 'user', targetId: MISSING, role: 'viewer' })).body).toEqual({ message: 'User not found' });
		expect((await share({ type: 'team', targetId: MISSING, role: 'viewer' })).body).toEqual({ message: 'Team not found' });
	});
});

describe('a body that cannot be read is 400, to a caller who would be refused', () => {
	/** Read first, the body is answered before the row is looked at: it was 403 or 404. */
	const NOT_JSON = Buffer.from('{"name": ');
	const json = { 'content-type': 'application/json' };

	it('for a caller who cannot edit the board, and for a row that is not there', async () => {
		const s = scene();

		for (const path of [`/api/v1/labels/${s.label.id}`, '/api/v1/labels/99999', `/api/boards/${s.A.board.id}`, `/api/teams/${s.team.id}`]) {
			const res = await api('PUT', path, { user: s.outsider, body: NOT_JSON, headers: json });

			expect(res.status, path).toBe(400);
		}
		const res = await api('POST', `/api/v1/boards/${s.A.board.id}/columns`, { user: s.outsider, body: NOT_JSON, headers: json });
		expect(res.status).toBe(400);
	});

	it('and a body that can be read is still refused 403 to them, whatever is wrong in it', async () => {
		const s = scene();

		const res = await api('PUT', `/api/v1/labels/${s.label.id}`, { user: s.outsider, body: { name: 5 } });

		expect(res.status).toBe(403);
		expect(db.select({ name: labels.name }).from(labels).where(eq(labels.id, s.label.id)).get()).toEqual({ name: 'A label' });
	});
});
