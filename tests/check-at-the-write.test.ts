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
 *
 * And, for card 2253, a second rule read from the source the same way: every
 * write handler asks, at the write, whether its key or session is still open
 * and who its account is now (`writeAs` and `stillCallerNow`), with the list
 * of handlers the card's later slices still have to move. `writeAs` itself is
 * tested in `tests/write-as.test.ts`.
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
const READS_NO_ROW = [
	'error',
	'Number',
	'isNaN',
	'pathId',
	'requireUser',
	'requireSuperadmin',
	'requireAdmin',
	'refuseOwnAccount',
	'isAdmin',
	'cookies.get'
];

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

/**
 * The function an exported handler is: `export const PUT = async (...) => {}`,
 * `export async function PUT(...)`, or a function of the file exported by name
 * (`export { handler as PUT }`). One exported by name from another file, or as
 * anything but a function written here, has no function (`fn` undefined), and
 * is reported as one this test cannot read.
 */
function handlersOf(tree: ts.SourceFile): { method: string; fn: HandlerFunction | undefined; at: ts.Node }[] {
	const found: { method: string; fn: HandlerFunction | undefined; at: ts.Node }[] = [];
	/** The function written in this file under a name, if it is one. */
	const local = (name: string): HandlerFunction | undefined => {
		for (const statement of tree.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
			if (!ts.isVariableStatement(statement)) continue;
			for (const declared of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declared.name) || declared.name.text !== name) continue;
				const value = declared.initializer && bare(declared.initializer);
				return value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ? value : undefined;
			}
		}
		return undefined;
	};
	for (const statement of tree.statements) {
		if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
			for (const element of statement.exportClause.elements) {
				if (!METHODS.includes(element.name.text)) continue;
				const fn = statement.moduleSpecifier ? undefined : local((element.propertyName ?? element.name).text);
				found.push({ method: element.name.text, fn, at: element });
			}
			continue;
		}
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
/**
 * What a handler is given, by what it calls it: `{ request, locals }`,
 * `{ request: req }`, or `event` and `event.request`. `isTheRequest` and
 * `isTheLocals` say whether an expression is the request or the locals;
 * `userNames` are the names bound from `locals.user` in the parameter itself
 * (`{ locals: { user } }`).
 */
function givenTo(fn: HandlerFunction) {
	const requestNames = new Set<string>();
	const localsNames = new Set<string>();
	const userNames = new Set<string>();
	let eventName: string | undefined;
	const [given] = fn.parameters;
	if (given && ts.isObjectBindingPattern(given.name)) {
		for (const element of given.name.elements) {
			const key = element.propertyName ?? element.name;
			if (!ts.isIdentifier(key)) continue;
			if (key.text === 'request' && ts.isIdentifier(element.name)) requestNames.add(element.name.text);
			if (key.text === 'locals' && ts.isIdentifier(element.name)) localsNames.add(element.name.text);
			if (key.text === 'locals' && ts.isObjectBindingPattern(element.name)) {
				for (const inner of element.name.elements) {
					const innerKey = inner.propertyName ?? inner.name;
					if (ts.isIdentifier(innerKey) && innerKey.text === 'user' && ts.isIdentifier(inner.name)) userNames.add(inner.name.text);
				}
			}
		}
	} else if (given && ts.isIdentifier(given.name)) {
		eventName = given.name.text;
	}
	const isEventProperty = (held: ts.Expression, name: string) =>
		eventName !== undefined &&
		ts.isPropertyAccessExpression(held) &&
		held.name.text === name &&
		ts.isIdentifier(held.expression) &&
		held.expression.text === eventName;
	const isTheRequest = (node: ts.Expression): boolean => {
		const held = bare(node);
		if (ts.isIdentifier(held)) return requestNames.has(held.text);
		return isEventProperty(held, 'request');
	};
	const isTheLocals = (node: ts.Expression): boolean => {
		const held = bare(node);
		if (ts.isIdentifier(held)) return localsNames.has(held.text);
		return isEventProperty(held, 'locals');
	};
	return { isTheRequest, isTheLocals, localsNames, userNames, eventName };
}

/** Every call in `node`, not looking into a function written inside it unless `intoFunctions`. */
function callsIn(node: ts.Node, intoFunctions = false): ts.CallExpression[] {
	const calls: ts.CallExpression[] = [];
	const visit = (at: ts.Node): void => {
		if (ts.isCallExpression(at)) calls.push(at);
		ts.forEachChild(at, (child) => {
			if (intoFunctions || !ts.isFunctionLike(child)) visit(child);
		});
	};
	visit(node);
	return calls;
}

/** The call that first reads the handler's body: a reader method of the request, or a call given the request. */
function bodyReadOf(tree: ts.SourceFile, fn: HandlerFunction, isTheRequest: (node: ts.Expression) => boolean): ts.CallExpression | undefined {
	const isRead = (call: ts.CallExpression): boolean => {
		const callee = call.expression;
		if (ts.isPropertyAccessExpression(callee) && READER_METHODS.includes(callee.name.text) && isTheRequest(callee.expression)) return true;
		return call.arguments.some((argument) => isTheRequest(argument));
	};
	return (fn.body ? callsIn(fn.body) : []).filter(isRead).sort((a, b) => a.getStart(tree) - b.getStart(tree))[0];
}

function readHandler(file: string, tree: ts.SourceFile, fn: HandlerFunction): { reads: boolean; early: string[] } {
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const { isTheRequest } = givenTo(fn);
	const calls = fn.body ? callsIn(fn.body) : [];
	const read = bodyReadOf(tree, fn, isTheRequest);
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

// ─── Who the caller is, asked again at the write (card 2253) ────────────────

/*
 * The gate decides who is calling before the body is read, and a body can
 * take as long as the caller likes to arrive: a reset, a key deleted, a
 * sign-out or a role lowered meanwhile was met by nothing. So every `POST`,
 * `PUT`, `PATCH` and `DELETE` handler under `src/routes/api` writes through
 * `writeAs(locals, (caller) => …)` (src/lib/server/write-as.ts), which asks in
 * its transaction whether the key or session is still open and who its
 * account is now, and decides who the caller is inside it with `caller`
 * alone. What cannot run in a transaction (the handlers of STILL_CALLER_NOW)
 * asks `stillCallerNow(locals)` instead, as the statement right after its
 * body, and awaits nothing between that and what it guards. Read from the
 * source, failing closed (the plan's decision 4 and R2):
 *
 *   - every write handler calls `writeAs(locals, …)`, after its body if it
 *     reads one, or is on STILL_CALLER_NOW and calls `stillCallerNow(locals)`.
 *     Only a call made in the handler itself counts, not one written in a
 *     function inside it, which may never be called (and, for (d), one in
 *     `whilePasswordHolds`'s write);
 *   - no write outside every `writeAs` callback: `db.insert`, `db.update`,
 *     `db.delete`, anything asked of `sqlite`, or a statement's `.run()`,
 *     except the call a check guards (the vacuum's);
 *   - each callback readable, not async, and using its caller;
 *   - no decision on the caller as the gate read it, anywhere: no name bound
 *     from `locals.user` (before the body a quick check is a call that binds
 *     no name, `requireUser(locals.user);`), no read of `.user` after the
 *     body but on a callback's own parameter, and the locals neither copied
 *     nor handed to anything but `writeAs` and `stillCallerNow`;
 *   - (a) no `inTransaction` in a route file, imported or called;
 *   - (b) `stillCallerNow` only in the handlers on STILL_CALLER_NOW, and each
 *     of them calls it, right after its body;
 *   - (c) nothing awaited between each `stillCallerNow` and the call it
 *     guards;
 *   - (d) the three routes that ask for a current password check inside
 *     `whilePasswordHolds`'s write: everything that write does is inside its
 *     `writeAs`.
 *
 * What it cannot see: a service the handler calls outside its callback that
 * writes. The review of each route slice looks for that, and the walks of
 * tests/access-every-route.test.ts (slice 2253-8) catch it for every handler
 * with a body.
 */

/** The methods that change something, every one of which asks again at the write. */
const WRITING = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * (b) and (c): the handlers that ask `stillCallerNow(locals)` because what
 * they do cannot run inside `writeAs`, with why, and the call each check
 * guards, by its callee as written: one for each check, in source order.
 */
const STILL_CALLER_NOW: Record<string, { reason: string; guards: RegExp[] }> = {
	'src/routes/api/admin/vacuum/+server.ts POST': { reason: 'VACUUM cannot run in a transaction.', guards: [/^sqlite\.exec$/] },
	'src/routes/api/admin/import/+server.ts POST': {
		reason:
			'The restore opens its own transaction, and files are written before it: the first is .restore-temp.db. ' +
			'No writeAs after the restore: the database it would ask is no longer the one the caller was let in by.',
		guards: [/(^|\.)writeFileSync$/]
	},
	'src/routes/api/reports/+server.ts POST': {
		reason: 'It only reads, after a body, and builds a PDF with an await.',
		guards: [/^generate\w*Report$/]
	},
	'src/routes/api/reports/email/+server.ts POST': {
		reason: 'Mail leaves the process, after a PDF built with an await: checked again before the send.',
		guards: [/^generate\w*Report$/, /^sendEmailWithAttachment$/]
	},
	'src/routes/api/admin/backup/+server.ts POST': { reason: 'The backup leaves the process.', guards: [/^runBackup$/] },
	'src/routes/api/admin/backup/test/+server.ts POST': {
		reason: "A destination's stored secret leaves the process.",
		guards: [/^createDestination$/]
	},
	'src/routes/api/admin/backup/gdrive/auth/+server.ts POST': { reason: 'The code goes to Google.', guards: [/(^|\.)getToken$/] }
};

/**
 * The guards that may take `locals.user` before the body, as a quick refusal
 * in a call that binds no name: those that read no row, as card 2115's
 * READS_NO_ROW has them. Any other call given it there decides on the caller
 * as the gate read it. `requireAdmin` and `refuseOwnAccount` (slice 2253-4)
 * keep the 403s the account and request routes gave before their body, in
 * the same order, where an `if` on `locals.user` gave them.
 */
const QUICK_CHECKS = ['requireUser', 'requireSuperadmin', 'requireAdmin', 'refuseOwnAccount'];

/** And, by handler, a guard that reads a row and is asked before the body there too, with why. */
const QUICK_CHECKS_IN: Record<string, { guards: string[]; reason: string }> = {
	'src/routes/api/cards/[id]/attachments/+server.ts POST': {
		guards: ['requireCard'],
		reason:
			'The upload asks before it reads 25 MB, so that a caller with no access is not sent it (card 2115\'s ALLOWED), ' +
			'and asks again with caller inside the writeAs that attaches it (decision 7).'
	},
	'src/routes/api/requests/+server.ts POST': {
		guards: ['screenAnonymous'],
		reason:
			'The public request form asks a caller with no session for the form token, and counts them, before the body ' +
			"(card 2115's ALLOWED); it reads no row, and the writeAs that saves the request decides with caller === null."
	}
};

/** (d): the handlers that ask for the current password, whose write runs in `whilePasswordHolds`. */
const CURRENT_PASSWORD = [
	'src/routes/api/account/password/+server.ts PUT',
	'src/routes/api/account/email/+server.ts PUT',
	'src/routes/api/account/api-keys/+server.ts POST'
];

/**
 * The write handlers the card's later slices move to `writeAs` or
 * `stillCallerNow` (section 5.3 of the plan), by file and method. Each slice
 * takes its own off; the list is empty after slice 2253-7. A handler not on it
 * that breaks the rule fails, and so does an entry that already keeps it, so
 * the list can only shrink. An `inTransaction` outside any write handler (a
 * helper, a `GET`) is let stand only in a file that still has a handler here.
 */
const NOT_YET: string[] = [
	// Slice 2253-2 (cards and what is on them, internal): all 30 moved.
	// Slice 2253-3 (boards, groupings, teams, goals, templates, internal): all 21 moved.
	// Slice 2253-4 (accounts, users, requests, reports, internal): all 19 moved.
	// Slice 2253-5: the superadmin's and administrators' routes (13).
	'src/routes/api/admin/backup/+server.ts PUT',
	'src/routes/api/admin/backup/+server.ts POST',
	'src/routes/api/admin/backup/gdrive/auth/+server.ts POST',
	'src/routes/api/admin/backup/test/+server.ts POST',
	'src/routes/api/admin/boards/[id]/clear-cards/+server.ts POST',
	'src/routes/api/admin/boards/[id]/clear-categories/+server.ts POST',
	'src/routes/api/admin/import/+server.ts POST',
	'src/routes/api/admin/purge-archived/+server.ts POST',
	'src/routes/api/admin/reset-xp/+server.ts POST',
	'src/routes/api/admin/reset/+server.ts POST',
	'src/routes/api/admin/smtp/+server.ts PUT',
	'src/routes/api/admin/smtp/+server.ts POST',
	'src/routes/api/admin/vacuum/+server.ts POST',
	// Slice 2253-6: boards side of /api/v1 (16).
	'src/routes/api/v1/board-categories/+server.ts POST',
	'src/routes/api/v1/board-categories/[categoryId]/+server.ts PUT',
	'src/routes/api/v1/board-categories/[categoryId]/+server.ts DELETE',
	'src/routes/api/v1/boards/+server.ts POST',
	'src/routes/api/v1/boards/[boardId]/+server.ts PUT',
	'src/routes/api/v1/boards/[boardId]/+server.ts DELETE',
	'src/routes/api/v1/boards/[boardId]/cards/+server.ts POST',
	'src/routes/api/v1/boards/[boardId]/categories/+server.ts POST',
	'src/routes/api/v1/boards/[boardId]/columns/+server.ts POST',
	'src/routes/api/v1/boards/[boardId]/labels/+server.ts POST',
	'src/routes/api/v1/categories/[categoryId]/+server.ts PUT',
	'src/routes/api/v1/categories/[categoryId]/+server.ts DELETE',
	'src/routes/api/v1/columns/[columnId]/+server.ts PUT',
	'src/routes/api/v1/columns/[columnId]/+server.ts DELETE',
	'src/routes/api/v1/labels/[labelId]/+server.ts PUT',
	'src/routes/api/v1/labels/[labelId]/+server.ts DELETE',
	// Slice 2253-7: cards side of /api/v1 (28).
	'src/routes/api/v1/cards/[cardId]/+server.ts PUT',
	'src/routes/api/v1/cards/[cardId]/+server.ts DELETE',
	'src/routes/api/v1/cards/[cardId]/assignees/+server.ts POST',
	'src/routes/api/v1/cards/[cardId]/assignees/+server.ts DELETE',
	'src/routes/api/v1/cards/[cardId]/comments/+server.ts POST',
	'src/routes/api/v1/cards/[cardId]/dependencies/+server.ts POST',
	'src/routes/api/v1/cards/[cardId]/dependencies/+server.ts DELETE',
	'src/routes/api/v1/cards/[cardId]/labels/+server.ts POST',
	'src/routes/api/v1/cards/[cardId]/labels/+server.ts DELETE',
	'src/routes/api/v1/cards/[cardId]/move/+server.ts PUT',
	'src/routes/api/v1/cards/[cardId]/subtasks/+server.ts POST',
	'src/routes/api/v1/cards/[cardId]/tokens/+server.ts POST',
	'src/routes/api/v1/comments/[commentId]/+server.ts PUT',
	'src/routes/api/v1/dependencies/bulk/+server.ts POST',
	'src/routes/api/v1/milestones/+server.ts POST',
	'src/routes/api/v1/milestones/[milestoneId]/+server.ts PATCH',
	'src/routes/api/v1/milestones/[milestoneId]/+server.ts DELETE',
	'src/routes/api/v1/milestones/[milestoneId]/cards/+server.ts POST',
	'src/routes/api/v1/milestones/[milestoneId]/cards/+server.ts DELETE',
	'src/routes/api/v1/milestones/[milestoneId]/cards/bulk/+server.ts POST',
	'src/routes/api/v1/milestones/[milestoneId]/cards/bulk/+server.ts DELETE',
	'src/routes/api/v1/subtasks/[subtaskId]/+server.ts PUT',
	'src/routes/api/v1/subtasks/[subtaskId]/+server.ts DELETE',
	'src/routes/api/v1/subtasks/[subtaskId]/dependencies/+server.ts POST',
	'src/routes/api/v1/subtasks/[subtaskId]/dependencies/+server.ts DELETE',
	'src/routes/api/v1/subtasks/[subtaskId]/tokens/+server.ts POST',
	'src/routes/api/v1/tokens/[entryId]/+server.ts DELETE',
	'src/routes/api/v1/tokens/bulk/+server.ts POST'
];

type WriteFinding = { file: string; handler: string | null; finding: string };

type WriteReading = {
	/** Every handler exported, by `file METHOD`, and whether it changes something. */
	handlers: { key: string; writing: boolean }[];
	/** What breaks the rule: by the handler it is in, or null for the file outside any handler. */
	findings: WriteFinding[];
};

/** `true` when `inner` lies wholly inside `outer`. */
const within = (inner: ts.Node, outer: ts.Node) => inner.getStart() >= outer.getStart() && inner.getEnd() <= outer.getEnd();

/** Every await in `node`, not looking into a function written inside it. */
function awaitsIn(node: ts.Node): ts.AwaitExpression[] {
	const found: ts.AwaitExpression[] = [];
	const visit = (at: ts.Node): void => {
		if (ts.isAwaitExpression(at)) found.push(at);
		ts.forEachChild(at, (child) => {
			if (!ts.isFunctionLike(child)) visit(child);
		});
	};
	visit(node);
	return found;
}

/** Whether an identifier is a name used as one, and not a property's name after a dot, in an object or in a pattern. */
function usedAsName(id: ts.Identifier): boolean {
	const parent = id.parent;
	return !(
		(ts.isPropertyAccessExpression(parent) && parent.name === id) ||
		(ts.isPropertyAssignment(parent) && parent.name === id) ||
		(ts.isBindingElement(parent) && parent.propertyName === id)
	);
}

/** The names a declaration binds: one, or each in a pattern. */
function boundNames(name: ts.BindingName): string[] {
	if (ts.isIdentifier(name)) return [name.text];
	return name.elements.flatMap((element) => (ts.isBindingElement(element) ? boundNames(element.name) : []));
}

/** A function literal handed to a call: what a `writeAs` callback must be for this test to read it. */
type Callback = ts.ArrowFunction | ts.FunctionExpression;
const isCallback = (node: ts.Node | undefined): node is Callback => node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

/**
 * A write to the database, by its callee as written: an insert, an update or
 * a delete, anything asked of the connection itself, or a statement run.
 */
const WRITE_CALL = /^db\.(insert|update|delete)$|^sqlite\.|\.run$/;

/** The names a scope declares itself, each with its declaration: a function's parameters, a block's statements, a loop's or a catch's variable. */
function declaredIn(scope: ts.Node): { name: string; node: ts.Node }[] {
	const found: { name: string; node: ts.Node }[] = [];
	const fromList = (list: ts.VariableDeclarationList) => {
		for (const declaration of list.declarations) for (const name of boundNames(declaration.name)) found.push({ name, node: declaration });
	};
	if (ts.isFunctionLike(scope)) {
		for (const parameter of scope.parameters) for (const name of boundNames(parameter.name)) found.push({ name, node: parameter });
	}
	if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
		for (const statement of scope.statements) if (ts.isVariableStatement(statement)) fromList(statement.declarationList);
	}
	if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
		fromList(scope.initializer);
	}
	if (ts.isCatchClause(scope) && scope.variableDeclaration) {
		for (const name of boundNames(scope.variableDeclaration.name)) found.push({ name, node: scope.variableDeclaration });
	}
	return found;
}

/** Whether an identifier is the name a declaration or a parameter binds, and not a use of one. */
function isDeclaredName(id: ts.Identifier): boolean {
	const parent = id.parent;
	return (
		((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === id) ||
		(ts.isBindingElement(parent) && parent.name === id)
	);
}

/** One handler of card 2253's rule: what it breaks, if anything. */
function judgeWrite(file: string, method: string, tree: ts.SourceFile, fn: HandlerFunction): string[] {
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const byStart = (a: ts.Node, b: ts.Node) => a.getStart(tree) - b.getStart(tree);
	const key = `${file} ${method}`;
	const at = `${file}:${line(fn)} ${method}`;
	const findings: string[] = [];
	if (!fn.body) return [`${at} has no body this test can read`];
	const body = fn.body;
	const given = givenTo(fn);
	const { isTheRequest, isTheLocals, localsNames } = given;
	const read = bodyReadOf(tree, fn, isTheRequest);
	const named = (call: ts.CallExpression, name: string) => calleeOf(call, tree) === name;
	const givenLocals = (call: ts.CallExpression) => call.arguments.length > 0 && isTheLocals(call.arguments[0]);
	const listed = STILL_CALLER_NOW[key];
	const quickChecks = [...QUICK_CHECKS, ...(QUICK_CHECKS_IN[key]?.guards ?? [])];
	const DECIDE = ': decide inside writeAs with caller';

	// The locals by every name they are given: `const { locals } = event`,
	// `const l = locals`. Found first, so that writeAs(locals, …) is known
	// whatever the handler calls them.
	const declarations: ts.VariableDeclaration[] = [];
	const assignments: (ts.BinaryExpression & { left: ts.Identifier })[] = [];
	const gather = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node)) declarations.push(node);
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
			assignments.push(node as ts.BinaryExpression & { left: ts.Identifier });
		}
		ts.forEachChild(node, gather);
	};
	gather(body);
	/** The elements of a pattern that take `property`: `{ user }`, `{ user: who }`. */
	const taking = (pattern: ts.ObjectBindingPattern, property: string) =>
		pattern.elements.filter((element) => {
			const key = element.propertyName ?? element.name;
			return ts.isIdentifier(key) && key.text === property;
		});
	for (let changed = true; changed; ) {
		changed = false;
		for (const declaration of declarations) {
			const value = declaration.initializer && bare(declaration.initializer);
			if (!value) continue;
			const names: string[] = [];
			if (given.eventName && ts.isIdentifier(value) && value.text === given.eventName && ts.isObjectBindingPattern(declaration.name)) {
				for (const element of taking(declaration.name, 'locals')) if (ts.isIdentifier(element.name)) names.push(element.name.text);
			} else if (isTheLocals(value) && ts.isIdentifier(declaration.name)) {
				names.push(declaration.name.text);
			}
			for (const name of names) {
				if (localsNames.has(name)) continue;
				localsNames.add(name);
				changed = true;
			}
		}
	}

	// The writeAs calls that run: made in the handler itself, and not in a
	// function written inside it, which may never be called; and, for (d), in
	// whilePasswordHolds's write, which it calls. The same for the checks.
	const ownCalls = callsIn(body).sort(byStart);
	const holds = CURRENT_PASSWORD.includes(key) ? callsIn(body, true).find((call) => named(call, 'whilePasswordHolds')) : undefined;
	const holdsWrite = holds && isCallback(holds.arguments[3]) ? holds.arguments[3] : undefined;
	const writeAsCalls = [...ownCalls, ...(holdsWrite ? callsIn(holdsWrite.body) : [])].filter((call) => named(call, 'writeAs'));
	const callbacks = writeAsCalls.map((call) => call.arguments[1]).filter(isCallback);
	const checks = ownCalls.filter((call) => named(call, 'stillCallerNow'));
	const insideCallback = (node: ts.Node) => callbacks.find((callback) => within(node, callback));
	// Where the body has been read: the end of the read, or, for a handler
	// with no body, its first writeAs or check.
	const firstAsk = [...writeAsCalls, ...checks].sort(byStart)[0];
	const boundary = read ? read.getEnd() : firstAsk ? firstAsk.getStart(tree) : body.getEnd();

	// The names bound from locals.user, followed through every declaration
	// and assignment: `const user = locals.user`, `requireUser(locals.user)`
	// bound, `const { user } = locals`, `{ locals: { user } }`, `me = locals.user`,
	// and any name bound from one of those. Each is where it was bound, by line.
	const tainted = new Map<string, ts.Node>();
	const bindings = new Set<ts.Node>();
	/** The reads that made a binding, reported as the binding and not again. */
	const consumed = new Set<ts.Node>();
	const [parameter] = fn.parameters;
	for (const name of given.userNames) tainted.set(name, parameter);
	if (given.userNames.size > 0) bindings.add(parameter);
	const isUserRead = (node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
		(ts.isPropertyAccessExpression(node) && node.name.text === 'user') ||
		(ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'user');
	const isLocalsUser = (node: ts.Node) => isUserRead(node) && isTheLocals(node.expression);
	/** The reads of locals.user, and the uses of names bound from it, in `node`. */
	const fromUser = (node: ts.Node): ts.Node[] => {
		const hits: ts.Node[] = [];
		const visit = (inner: ts.Node): void => {
			if (isLocalsUser(inner)) {
				hits.push(inner);
				return;
			}
			if (ts.isIdentifier(inner) && tainted.has(inner.text) && usedAsName(inner) && !isDeclaredName(inner)) {
				// Only where the name is the one bound from locals.user, and not a name of the same spelling declared closer.
				const declaration = declarationOf(inner, inner.text);
				if (declaration === undefined || bindings.has(declaration)) hits.push(inner);
			}
			ts.forEachChild(inner, visit);
		};
		visit(node);
		return hits;
	};
	/** The declaration a name used at `id` resolves to, inside the handler's body: the nearest scope that declares it. */
	const declarationOf = (id: ts.Node, name: string): ts.Node | undefined => {
		for (let scope: ts.Node | undefined = id.parent; scope && scope !== fn; scope = scope.parent) {
			const found = declaredIn(scope).find((declared) => declared.name === name);
			if (found) return found.node;
		}
		return undefined;
	};
	const taint = (name: string, binding: ts.Node, declaration: ts.Node = binding): boolean => {
		if (tainted.has(name)) return false;
		tainted.set(name, binding);
		bindings.add(binding);
		bindings.add(declaration);
		return true;
	};
	for (let changed = true; changed; ) {
		changed = false;
		for (const declaration of declarations) {
			if (bindings.has(declaration)) continue;
			const value = declaration.initializer && bare(declaration.initializer);
			if (!value) continue;
			const fromEvent = given.eventName && ts.isIdentifier(value) && value.text === given.eventName;
			if (ts.isObjectBindingPattern(declaration.name) && (isTheLocals(value) || fromEvent)) {
				// `const { user } = locals`, or `const { locals: { user } } = event`.
				const patterns = fromEvent
					? taking(declaration.name, 'locals').flatMap((element) => (ts.isObjectBindingPattern(element.name) ? [element.name] : []))
					: [declaration.name];
				for (const pattern of patterns) {
					for (const element of taking(pattern, 'user')) for (const name of boundNames(element.name)) changed = taint(name, declaration) || changed;
				}
				continue;
			}
			const hits = fromUser(value);
			if (hits.length === 0) continue;
			for (const name of boundNames(declaration.name)) changed = taint(name, declaration) || changed;
			for (const hit of hits) consumed.add(hit);
		}
		for (const assignment of assignments) {
			if (bindings.has(assignment)) continue;
			const hits = fromUser(assignment.right);
			if (hits.length === 0) continue;
			const name = assignment.left.text;
			changed = taint(name, assignment, declarationOf(assignment, name)) || changed;
			for (const hit of [...hits, assignment.left]) consumed.add(hit);
		}
	}

	// The writeAs calls themselves.
	const writeAsWithLocals = writeAsCalls.filter(givenLocals);
	if (writeAsWithLocals.length === 0 && checks.length === 0) {
		findings.push(`${at} calls neither writeAs(locals, …) nor stillCallerNow(locals)`);
	}
	for (const call of writeAsCalls) {
		if (!givenLocals(call)) findings.push(`${at} calls writeAs at line ${line(call)} with something other than the locals it is given`);
		const callback = call.arguments[1];
		if (!isCallback(callback)) {
			findings.push(`${at} gives writeAs at line ${line(call)} a function this test cannot read`);
		}
		if (read && call.getStart(tree) < read.getEnd()) findings.push(`${at} calls writeAs at line ${line(call)} before it reads its body`);
		if (!isCallback(callback)) continue;
		const own = callback.parameters.flatMap((p) => boundNames(p.name));
		const usesIt = own.some((name) => {
			let used = false;
			const visit = (node: ts.Node): void => {
				if (used) return;
				if (ts.isIdentifier(node) && node.text === name && usedAsName(node) && !isDeclaredName(node)) used = true;
				else ts.forEachChild(node, visit);
			};
			visit(callback.body);
			return used;
		});
		if (!usesIt) findings.push(`${at} gives writeAs at line ${line(call)} a callback that never uses its caller${DECIDE}`);
		if (ts.getModifiers(callback)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
			findings.push(`${at} gives writeAs at line ${line(call)} an async callback`);
		}
	}

	// Decisions on the caller as the gate read it, anywhere, in source order.
	const decisions: { node: ts.Node; finding: string }[] = [];
	for (const [name, binding] of tainted) {
		decisions.push({ node: binding, finding: `${at} binds ${name} from locals.user at line ${line(binding)}; quick checks bind no name${DECIDE}` });
	}
	const visit = (node: ts.Node): void => {
		if (isUserRead(node) && !consumed.has(node)) {
			const callback = insideCallback(node);
			const ownParameter =
				callback !== undefined && ts.isIdentifier(node.expression) && callback.parameters.some((p) => boundNames(p.name).includes((node.expression as ts.Identifier).text));
			const quickCheck =
				isLocalsUser(node) &&
				ts.isCallExpression(node.parent) &&
				node.parent.arguments.includes(node as ts.Expression) &&
				ts.isExpressionStatement(node.parent.parent) &&
				quickChecks.includes(calleeOf(node.parent, tree));
			if (node.getStart(tree) < boundary) {
				if (!quickCheck) {
					decisions.push({
						node,
						finding: `${at} reads ${node.getText(tree)} at line ${line(node)} before the body other than in a quick check that binds no name (${quickChecks.join(', ')})${DECIDE}`
					});
				}
			} else if (!ownParameter) {
				decisions.push({ node, finding: `${at} reads ${node.getText(tree)} at line ${line(node)}${DECIDE}` });
			}
		}
		if (ts.isElementAccessExpression(node) && isTheLocals(node.expression) && !ts.isStringLiteralLike(node.argumentExpression)) {
			// `locals[k]`: which of its fields is read cannot be told from here.
			decisions.push({ node, finding: `${at} reads the locals by a computed key at line ${line(node)}${DECIDE}` });
		}
		if ((ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && isTheLocals(node.expression)) {
			decisions.push({ node, finding: `${at} copies the locals at line ${line(node)}${DECIDE}` });
		}
		if (ts.isCallExpression(node) && !named(node, 'writeAs') && !named(node, 'stillCallerNow') && node.arguments.some((argument) => isTheLocals(argument))) {
			decisions.push({ node, finding: `${at} gives the locals to ${calleeOf(node, tree)} at line ${line(node)}${DECIDE}` });
		}
		if (ts.isIdentifier(node) && tainted.has(node.text) && !consumed.has(node)) {
			const name = node.text;
			const binding = tainted.get(name)!;
			const declaration = isDeclaredName(node) ? node.parent : declarationOf(node, name);
			if (isDeclaredName(node)) {
				// Declared again: inside a writeAs callback, said once, by its binding.
				if (!bindings.has(node.parent) && insideCallback(node)) {
					decisions.push({
						node,
						finding: `${at}: the name ${name} is bound from locals.user at line ${line(binding)} before the body; remove that binding (quick checks bind no name)`
					});
				}
			} else if (usedAsName(node) && (declaration === undefined || bindings.has(declaration))) {
				decisions.push({ node, finding: `${at} uses ${name}, bound from locals.user at line ${line(binding)}, at line ${line(node)}${DECIDE}` });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(body);
	for (const { finding } of decisions.sort((a, b) => byStart(a.node, b.node))) findings.push(finding);

	// The connection under another name, which the writes below would not
	// know for one: `const d = db`, `const { prepare } = sqlite`, `d = db`.
	const aliases = [
		...declarations.map((declaration) => ({ node: declaration, value: declaration.initializer && bare(declaration.initializer) })),
		...assignments.map((assignment) => ({ node: assignment, value: bare(assignment.right) }))
	];
	for (const { node, value } of aliases.sort((a, b) => byStart(a.node, b.node))) {
		if (value && ts.isIdentifier(value) && (value.text === 'db' || value.text === 'sqlite')) {
			findings.push(`${at} gives ${value.text} another name at line ${line(node)}: write with ${value.text}, inside writeAs`);
		}
	}

	// Writes outside every writeAs callback: the innermost call of each, so
	// that `db.insert(…).values(…).run()` is one. What a check guards is its
	// own (the vacuum's sqlite.exec).
	const writes = callsIn(body, true).filter((call) => WRITE_CALL.test(calleeOf(call, tree)));
	for (const call of writes.sort(byStart)) {
		if (writes.some((other) => other !== call && within(other, call))) continue;
		if (insideCallback(call)) continue;
		if (listed?.guards.some((guard) => guard.test(calleeOf(call, tree)))) continue;
		findings.push(`${at} writes outside writeAs at line ${line(call)} (${calleeOf(call, tree)})`);
	}

	// (b), and where the check sits.
	if (checks.length > 0 && !listed) findings.push(`${at} calls stillCallerNow and is not on STILL_CALLER_NOW (b)`);
	if (listed && checks.length === 0) findings.push(`${at} is on STILL_CALLER_NOW and does not call stillCallerNow(locals) (b)`);
	for (const check of checks) {
		if (!givenLocals(check)) findings.push(`${at} calls stillCallerNow at line ${line(check)} with something other than the locals it is given`);
	}
	if (listed && checks.length > 0) {
		const [first] = checks;
		const from = read ? read.getEnd() : body.getStart(tree);
		const between = [...ownCalls, ...awaitsIn(body)].filter(
			(node) => node.getStart(tree) >= from && node.getEnd() <= first.getStart(tree) && !within(node, first)
		);
		if (first.getStart(tree) < from || between.length > 0) {
			findings.push(`${at} does not ask stillCallerNow right after its ${read ? 'body' : 'first statement'} (line ${line(first)})`);
		}

		// (c): one check for each guarded call, and nothing awaited between.
		if (checks.length !== listed.guards.length) {
			findings.push(`${at} calls stillCallerNow ${checks.length} time(s) and guards ${listed.guards.length} call(s) (c)`);
		}
		const ownBody = body;
		checks.forEach((check, index) => {
			const guard = listed.guards[index];
			if (!guard) return;
			const guarded = ownCalls.find((call) => call.getStart(tree) > check.getEnd() && guard.test(calleeOf(call, tree)));
			if (!guarded) {
				findings.push(`${at} calls nothing matching ${guard} after its check at line ${line(check)} (c)`);
				return;
			}
			// An await of the guarded call itself is after it, and is not between.
			const awaited = awaitsIn(ownBody).filter(
				(node) => node.getStart(tree) > check.getEnd() && node.getStart(tree) < guarded.getStart(tree) && !within(guarded, node)
			);
			for (const node of awaited) {
				findings.push(`${at} awaits at line ${line(node)}, between its check at line ${line(check)} and ${calleeOf(guarded, tree)} at line ${line(guarded)} (c)`);
			}
		});
	}

	// (d): everything whilePasswordHolds's write does is inside its writeAs.
	if (CURRENT_PASSWORD.includes(key)) {
		const write = holdsWrite;
		if (!holds) findings.push(`${at} does not call whilePasswordHolds (d)`);
		else if (!write) {
			findings.push(`${at} gives whilePasswordHolds a write this test cannot read (d)`);
		} else {
			const inside = callsIn(write.body, true);
			const wrapping = inside.filter((call) => named(call, 'writeAs') && givenLocals(call));
			if (wrapping.length === 0) findings.push(`${at} does not call writeAs(locals, …) in whilePasswordHolds's write (d)`);
			for (const call of inside) {
				if (wrapping.includes(call) || wrapping.some((outer) => within(call, outer))) continue;
				findings.push(`${at} calls ${calleeOf(call, tree)} at line ${line(call)} in whilePasswordHolds's write, outside its writeAs (d)`);
			}
		}
	}
	// One finding said once: a name declared again in several places is one binding to remove.
	return [...new Set(findings)];
}

/** Every handler of one file, judged by card 2253's rule, and (a) for the whole file. */
function judgeWrites(file: string, source: string): WriteReading {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const reading: WriteReading = { handlers: [], findings: [] };
	const handlers = handlersOf(tree);
	for (const { method, fn, at } of handlers) {
		const key = `${file} ${method}`;
		const writing = WRITING.includes(method);
		reading.handlers.push({ key, writing });
		if (!writing) continue;
		if (!fn) {
			const line = tree.getLineAndCharacterOfPosition(at.getStart(tree)).line + 1;
			reading.findings.push({ file, handler: key, finding: `${file}:${line} ${method} is not a function this test can read` });
			continue;
		}
		for (const finding of judgeWrite(file, method, tree, fn)) reading.findings.push({ file, handler: key, finding });
	}
	// The connection imported under another name, or as a namespace: the writes would not be known for writes.
	for (const statement of tree.statements) {
		if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
		const line = tree.getLineAndCharacterOfPosition(statement.getStart(tree)).line + 1;
		const bindings = statement.importClause.namedBindings;
		if (ts.isNamespaceImport(bindings) && ts.isStringLiteral(statement.moduleSpecifier) && /server\/db$/.test(statement.moduleSpecifier.text)) {
			reading.findings.push({ file, handler: null, finding: `${file}:${line} imports ${statement.moduleSpecifier.text} as a namespace: import db by its own name` });
		}
		if (!ts.isNamedImports(bindings)) continue;
		for (const element of bindings.elements) {
			const imported = element.propertyName?.text;
			if (imported === 'db' || imported === 'sqlite') {
				reading.findings.push({ file, handler: null, finding: `${file}:${line} imports ${imported} as ${element.name.text}: import it by its own name` });
			}
		}
	}
	// (a): every mention of inTransaction, by the write handler it is in, or by the file.
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && node.text === 'inTransaction') {
			const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
			const owner = handlers.find(({ method, fn, at }) => WRITING.includes(method) && (within(node, at) || (fn !== undefined && within(node, fn))));
			reading.findings.push({
				file,
				handler: owner ? `${file} ${owner.method}` : null,
				finding: `${file}:${line} names inTransaction: write through writeAs (a)`
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return reading;
}

describe('every write handler asks who the caller is at the write (card 2253)', () => {
	const files = filesUnder('src/routes/api', (path) => path.endsWith('/+server.ts'));
	const all: WriteReading = { handlers: [], findings: [] };
	for (const file of files) {
		const reading = judgeWrites(file, readFileSync(join(ROOT, file), 'utf8'));
		all.handlers.push(...reading.handlers);
		all.findings.push(...reading.findings);
	}
	const writing = all.handlers.filter((h) => h.writing).map((h) => h.key);
	const fileOf = (key: string) => key.slice(0, key.lastIndexOf(' '));
	const filesNotYet = new Set(NOT_YET.map(fileOf));

	it('calls writeAs(locals, …), or stillCallerNow(locals) where STILL_CALLER_NOW says, in every write handler not on NOT_YET', () => {
		const unlisted = all.findings.filter(({ handler }) => handler !== null && !NOT_YET.includes(handler)).map(({ finding }) => finding);

		// Each line names the file, the line, the handler and what it breaks.
		expect(unlisted).toEqual([]);
	});

	it('names inTransaction in no route file, nor imports db or sqlite under another name, outside the files of handlers still on NOT_YET (a)', () => {
		const outside = all.findings.filter(({ file, handler }) => handler === null && !filesNotYet.has(file));

		expect(outside.map(({ finding }) => finding)).toEqual([]);
	});

	it('has nothing on NOT_YET that already keeps the rule, or is no write handler', () => {
		const breaking = new Set(all.findings.map(({ handler }) => handler));

		expect(NOT_YET.filter((key) => !writing.includes(key))).toEqual([]);
		expect(NOT_YET.filter((key) => !breaking.has(key))).toEqual([]);
		expect(new Set(NOT_YET).size).toBe(NOT_YET.length);
	});

	it('names on STILL_CALLER_NOW and CURRENT_PASSWORD only write handlers there are', () => {
		expect(Object.keys(STILL_CALLER_NOW).filter((key) => !writing.includes(key))).toEqual([]);
		expect(CURRENT_PASSWORD.filter((key) => !writing.includes(key))).toEqual([]);
		expect(Object.keys(QUICK_CHECKS_IN).filter((key) => !writing.includes(key))).toEqual([]);
		expect(Object.keys(STILL_CALLER_NOW)).toHaveLength(7);
	});

	it('was looked for in the whole tree, and finds the handlers moved so far keeping it', () => {
		expect(writing.length).toBeGreaterThanOrEqual(120);
		const keeps = (key: string) => writing.includes(key) && !all.findings.some(({ handler }) => handler === key);
		// Slice 2253-1: the four routes that asked before this card.
		for (const key of [
			'src/routes/api/report-schedules/+server.ts POST',
			'src/routes/api/report-schedules/[id]/+server.ts PUT',
			'src/routes/api/report-schedules/[id]/+server.ts DELETE',
			'src/routes/api/v1/boards/[boardId]/webhooks/+server.ts POST',
			'src/routes/api/v1/webhooks/[webhookId]/+server.ts PUT',
			'src/routes/api/v1/webhooks/[webhookId]/+server.ts DELETE',
			// Slice 2253-2: cards and what is on them (internal).
			'src/routes/api/cards/+server.ts POST',
			'src/routes/api/cards/[id]/+server.ts PUT',
			'src/routes/api/cards/[id]/+server.ts DELETE',
			'src/routes/api/cards/[id]/assignees/+server.ts POST',
			'src/routes/api/cards/[id]/assignees/+server.ts DELETE',
			'src/routes/api/cards/[id]/attachments/+server.ts POST',
			'src/routes/api/cards/[id]/attachments/[attachmentId]/+server.ts DELETE',
			'src/routes/api/cards/[id]/comments/+server.ts POST',
			'src/routes/api/cards/[id]/comments/[commentId]/+server.ts PUT',
			'src/routes/api/cards/[id]/comments/[commentId]/+server.ts DELETE',
			'src/routes/api/cards/[id]/dependencies/+server.ts POST',
			'src/routes/api/cards/[id]/dependencies/+server.ts DELETE',
			'src/routes/api/cards/[id]/restore/+server.ts POST',
			'src/routes/api/cards/reorder/+server.ts PUT',
			'src/routes/api/categories/+server.ts POST',
			'src/routes/api/categories/[id]/+server.ts PUT',
			'src/routes/api/categories/[id]/+server.ts DELETE',
			'src/routes/api/columns/+server.ts POST',
			'src/routes/api/columns/[id]/+server.ts PUT',
			'src/routes/api/columns/[id]/+server.ts DELETE',
			'src/routes/api/columns/reorder/+server.ts PUT',
			'src/routes/api/labels/+server.ts POST',
			'src/routes/api/labels/+server.ts PATCH',
			'src/routes/api/labels/+server.ts PUT',
			'src/routes/api/labels/+server.ts DELETE',
			'src/routes/api/subtasks/+server.ts POST',
			'src/routes/api/subtasks/[id]/+server.ts PUT',
			'src/routes/api/subtasks/[id]/+server.ts DELETE',
			'src/routes/api/subtasks/[id]/dependencies/+server.ts POST',
			'src/routes/api/subtasks/[id]/dependencies/+server.ts DELETE',
			// Slice 2253-3: boards, groupings, teams, goals, templates (internal).
			'src/routes/api/board-categories/+server.ts POST',
			'src/routes/api/board-categories/[id]/+server.ts PUT',
			'src/routes/api/board-categories/[id]/+server.ts DELETE',
			'src/routes/api/boards/+server.ts POST',
			'src/routes/api/boards/[id]/+server.ts PUT',
			'src/routes/api/boards/[id]/+server.ts DELETE',
			'src/routes/api/boards/[id]/archive/+server.ts POST',
			'src/routes/api/boards/[id]/favourite/+server.ts POST',
			'src/routes/api/boards/[id]/share/+server.ts POST',
			'src/routes/api/boards/[id]/share/+server.ts PATCH',
			'src/routes/api/boards/[id]/share/+server.ts DELETE',
			'src/routes/api/milestones/+server.ts POST',
			'src/routes/api/milestones/[id]/+server.ts PATCH',
			'src/routes/api/milestones/[id]/+server.ts DELETE',
			'src/routes/api/teams/+server.ts POST',
			'src/routes/api/teams/[id]/+server.ts PUT',
			'src/routes/api/teams/[id]/+server.ts DELETE',
			'src/routes/api/teams/[id]/members/[userId]/+server.ts POST',
			'src/routes/api/teams/[id]/members/[userId]/+server.ts DELETE',
			'src/routes/api/templates/+server.ts POST',
			'src/routes/api/templates/[id]/+server.ts DELETE',
			// Slice 2253-4: accounts, users, requests, reports (internal).
			'src/routes/api/account/api-keys/+server.ts POST',
			'src/routes/api/account/api-keys/[id]/+server.ts DELETE',
			'src/routes/api/account/email/+server.ts PUT',
			'src/routes/api/account/emoji/+server.ts PUT',
			'src/routes/api/account/notifications/+server.ts PUT',
			'src/routes/api/account/password/+server.ts PUT',
			'src/routes/api/reports/+server.ts POST',
			'src/routes/api/reports/email/+server.ts POST',
			'src/routes/api/requests/+server.ts POST',
			'src/routes/api/requests/[id]/+server.ts PATCH',
			'src/routes/api/requests/[id]/+server.ts DELETE',
			'src/routes/api/requests/[id]/confirm/+server.ts POST',
			'src/routes/api/requests/[id]/link/+server.ts POST',
			'src/routes/api/requests/[id]/messages/+server.ts POST',
			'src/routes/api/users/+server.ts POST',
			'src/routes/api/users/[id]/+server.ts PUT',
			'src/routes/api/users/[id]/+server.ts DELETE',
			'src/routes/api/users/[id]/invite/+server.ts POST',
			'src/routes/api/users/[id]/password/+server.ts PUT'
		]) {
			expect(keeps(key), key).toBe(true);
		}
	});
});

describe("card 2253's rule itself", () => {
	const judged = (code: string, file = 'src/routes/api/example/+server.ts') => judgeWrites(file, code).findings.map(({ finding }) => finding);

	it('passes a handler that writes through writeAs after its body, deciding with caller, and one with no body', () => {
		const code = [
			"import { writeAs } from '$lib/server/write-as';",
			'export const PUT = async ({ params, request, locals }) => {',
			'\trequireUser(locals.user);',
			'\tconst id = pathId(params.id, "card");',
			'\tconst body = await readBody(request);',
			'\tconst row = writeAs(locals, (caller) => {',
			// Names of its own inside, bound from caller: no binding outside to hide.
			'\t\tconst user = requireUser(caller);',
			'\t\tdb.update(cards).set(body).run();',
			'\t\treturn [requireCard(user, id, "edit")].map((user) => user);',
			'\t});',
			'\treturn json(row);',
			'};',
			'export const DELETE = async ({ params, locals }) => {',
			'\twriteAs(locals, (caller) => requireCard(caller, Number(params.id), "edit"));',
			'\treturn json({ success: true });',
			'};',
			// A read may do as it likes.
			'export const GET = async ({ locals }) => json(locals.user);'
		].join('\n');

		expect(judged(code)).toEqual([]);
	});

	it('finds a write handler that calls neither, and one that calls writeAs before its body', () => {
		const code = [
			'export const POST = async ({ request, locals }) => {',
			'\tconst body = await readBody(request);',
			'\treturn json(db.insert(cards).values(body).run());',
			'};',
			'export const PATCH = async ({ request, locals }) => {',
			'\tconst row = writeAs(locals, (caller) => requireCard(caller, 1, "edit"));',
			'\tconst body = await readBody(request);',
			'};'
		].join('\n');

		expect(judged(code)).toEqual([
			'src/routes/api/example/+server.ts:1 POST calls neither writeAs(locals, …) nor stillCallerNow(locals)',
			'src/routes/api/example/+server.ts:1 POST writes outside writeAs at line 3 (db.insert)',
			'src/routes/api/example/+server.ts:5 PATCH calls writeAs at line 6 before it reads its body'
		]);
	});

	it('finds a write outside every writeAs callback, and counts no writeAs written inside a function that may never be called (probe 1)', () => {
		const code = [
			'export const POST = async ({ request, locals }) => {',
			'\tconst body = await readBody(request);',
			'\twriteAs(locals, (caller) => requireBoard(caller, 1, "edit"));',
			'\tdb.insert(webhooks).values(body).run();',
			'\tsqlite.prepare("DELETE FROM webhooks").run();',
			'\tstatement.run();',
			'\treturn json({});',
			'};',
			'export const PUT = async ({ request, locals }) => {',
			'\tconst body = await readBody(request);',
			'\tconst later = () => writeAs(locals, (caller) => db.update(cards).set(body).run());',
			'\treturn json({});',
			'};'
		].join('\n');

		expect(judged(code)).toEqual([
			'src/routes/api/example/+server.ts:1 POST writes outside writeAs at line 4 (db.insert)',
			'src/routes/api/example/+server.ts:1 POST writes outside writeAs at line 5 (sqlite.prepare)',
			'src/routes/api/example/+server.ts:1 POST writes outside writeAs at line 6 (statement.run)',
			'src/routes/api/example/+server.ts:9 PUT calls neither writeAs(locals, …) nor stillCallerNow(locals)',
			'src/routes/api/example/+server.ts:9 PUT writes outside writeAs at line 11 (db.update)'
		]);
	});

	it('finds a decision on the caller the gate read, between the body and writeAs and after writeAs returns (probes 2 and 3)', () => {
		const code = [
			'export const POST = async ({ params, request, locals }) => {',
			'\tconst user = requireUser(locals.user);',
			'\tconst body = await readBody(request);',
			'\trequireBoard(user, 1, "edit");',
			'\tconst hook = writeAs(locals, (caller) => {',
			'\t\trequireUser(caller);',
			'\t\treturn db.insert(webhooks).values(body).returning().get();',
			'\t});',
			'\treturn json(presentWebhook(hook, canSeeWebhookSecret(user, 1)));',
			'};'
		].join('\n');

		expect(judged(code)).toEqual([
			'src/routes/api/example/+server.ts:1 POST binds user from locals.user at line 2; quick checks bind no name: decide inside writeAs with caller',
			'src/routes/api/example/+server.ts:1 POST uses user, bound from locals.user at line 2, at line 4: decide inside writeAs with caller',
			'src/routes/api/example/+server.ts:1 POST uses user, bound from locals.user at line 2, at line 9: decide inside writeAs with caller'
		]);
	});

	it('finds locals.user assigned, the locals copied or handed on, taken out of the event, and read as event.locals.user (probes 2 and 3)', () => {
		const code = [
			'export const PUT = async (event) => {',
			'\tconst { locals } = event;',
			'\tconst body = await event.request.json();',
			'\tlet me;',
			'\tme = locals.user;',
			'\tconst copy = { ...locals };',
			'\tremember(locals);',
			'\twriteAs(locals, (caller) => {',
			'\t\trequireCard(caller, 1, "edit");',
			'\t\trequireCard(copy.user, 1, "edit");',
			'\t\trequireCard(event.locals.user, 1, "edit");',
			'\t\trequireCard(me, 1, "edit");',
			'\t});',
			'};'
		].join('\n');

		expect(judged(code)).toEqual([
			'src/routes/api/example/+server.ts:1 PUT binds me from locals.user at line 5; quick checks bind no name: decide inside writeAs with caller',
			'src/routes/api/example/+server.ts:1 PUT copies the locals at line 6: decide inside writeAs with caller',
			'src/routes/api/example/+server.ts:1 PUT gives the locals to remember at line 7: decide inside writeAs with caller',
			'src/routes/api/example/+server.ts:1 PUT reads copy.user at line 10: decide inside writeAs with caller',
			'src/routes/api/example/+server.ts:1 PUT reads event.locals.user at line 11: decide inside writeAs with caller',
			'src/routes/api/example/+server.ts:1 PUT uses me, bound from locals.user at line 5, at line 12: decide inside writeAs with caller'
		]);
	});

	it('lets locals.user be read before the body only by a call that binds no name', () => {
		const code = [
			'export const POST = async ({ request, locals }) => {',
			'\trequireUser(locals.user);',
			'\tif (!locals.user) throw error(401, "Not authenticated");',
			'\tconst body = await readBody(request);',
			'\twriteAs(locals, (caller) => requireCard(caller, 1, "edit"));',
			'};'
		].join('\n');

		expect(judged(code)).toEqual([
			'src/routes/api/example/+server.ts:1 POST reads locals.user at line 3 before the body other than in a quick check that binds no name (requireUser, requireSuperadmin, requireAdmin, refuseOwnAccount): decide inside writeAs with caller'
		]);
	});

	it('lets only the guards of QUICK_CHECKS take locals.user before the body, and requireCard only in the upload (re-check 3)', () => {
		const code = [
			'export const POST = async ({ request, locals }) => {',
			'\trequireUser(locals.user);',
			'\trequireSuperadmin(locals.user);',
			'\trequireAdmin(locals.user, "Admin only");',
			'\trefuseOwnAccount(locals.user, 2, "Not your own");',
			'\tremember(locals.user);',
			'\trequireCard(locals.user, 1, "view");',
			'\tscreenAnonymous(locals.user, null, () => "");',
			'\tconst body = await readBody(request);',
			'\twriteAs(locals, (caller) => requireCard(caller, 1, "edit"));',
			'};'
		].join('\n');
		const upload = 'src/routes/api/cards/[id]/attachments/+server.ts';
		const form = 'src/routes/api/requests/+server.ts';
		const QUICK = 'requireUser, requireSuperadmin, requireAdmin, refuseOwnAccount';

		expect(judged(code)).toEqual([
			`src/routes/api/example/+server.ts:1 POST reads locals.user at line 6 before the body other than in a quick check that binds no name (${QUICK}): decide inside writeAs with caller`,
			`src/routes/api/example/+server.ts:1 POST reads locals.user at line 7 before the body other than in a quick check that binds no name (${QUICK}): decide inside writeAs with caller`,
			`src/routes/api/example/+server.ts:1 POST reads locals.user at line 8 before the body other than in a quick check that binds no name (${QUICK}): decide inside writeAs with caller`
		]);
		expect(judged(code, upload)).toEqual([
			`${upload}:1 POST reads locals.user at line 6 before the body other than in a quick check that binds no name (${QUICK}, requireCard): decide inside writeAs with caller`,
			`${upload}:1 POST reads locals.user at line 8 before the body other than in a quick check that binds no name (${QUICK}, requireCard): decide inside writeAs with caller`
		]);
		// The public request form's screen of a caller with no session, there alone (slice 2253-4).
		expect(judged(code, form)).toEqual([
			`${form}:1 POST reads locals.user at line 6 before the body other than in a quick check that binds no name (${QUICK}, screenAnonymous): decide inside writeAs with caller`,
			`${form}:1 POST reads locals.user at line 7 before the body other than in a quick check that binds no name (${QUICK}, screenAnonymous): decide inside writeAs with caller`
		]);
	});

	it('finds the locals read by a computed key (re-check 1)', () => {
		const code = [
			'export const POST = async ({ request, locals }) => {',
			"\tconst k = 'user';",
			'\tconst body = await readBody(request);',
			'\twriteAs(locals, (caller) => requireCard(locals[k] ?? caller, 1, "edit"));',
			'};'
		].join('\n');

		expect(judged(code)).toEqual([
			'src/routes/api/example/+server.ts:1 POST reads the locals by a computed key at line 4: decide inside writeAs with caller'
		]);
	});

	it('finds db or sqlite given another name, in a handler or by its import (re-check 2)', () => {
		const code = [
			"import { db as store, sqlite } from '$lib/server/db';",
			'export const POST = async ({ request, locals }) => {',
			'\tconst body = await readBody(request);',
			'\tconst d = db;',
			'\tconst { prepare } = sqlite;',
			'\twriteAs(locals, (caller) => requireCard(caller, 1, "edit"));',
			'\td.insert(cards).values(body);',
			'};'
		].join('\n');
		const file = 'src/routes/api/example/+server.ts';

		expect(judgeWrites(file, code).findings).toEqual([
			{ file, handler: `${file} POST`, finding: `${file}:2 POST gives db another name at line 4: write with db, inside writeAs` },
			{ file, handler: `${file} POST`, finding: `${file}:2 POST gives sqlite another name at line 5: write with sqlite, inside writeAs` },
			{ file, handler: null, finding: `${file}:1 imports db as store: import it by its own name` }
		]);
		expect(judged("import * as connection from '$lib/server/db';")).toEqual([
			`${file}:1 imports $lib/server/db as a namespace: import db by its own name`
		]);
	});

	it('finds a writeAs callback that never uses its caller, and one that is async (probe 5)', () => {
		const code = [
			'export const DELETE = async ({ locals }) => {',
			'\twriteAs(locals, () => db.delete(cards).run());',
			'\twriteAs(locals, (caller) => db.delete(cards).run());',
			'\twriteAs(locals, async (caller) => requireCard(caller, 1, "edit"));',
			'};'
		].join('\n');

		expect(judged(code)).toEqual([
			'src/routes/api/example/+server.ts:1 DELETE gives writeAs at line 2 a callback that never uses its caller: decide inside writeAs with caller',
			'src/routes/api/example/+server.ts:1 DELETE gives writeAs at line 3 a callback that never uses its caller: decide inside writeAs with caller',
			'src/routes/api/example/+server.ts:1 DELETE gives writeAs at line 4 an async callback'
		]);
	});

	it('sees a handler exported by name, and cannot be passed by one it cannot read (probe 4)', () => {
		const code = [
			'const handler = async ({ request, locals }) => { const body = await readBody(request); db.insert(cards).values(body).run(); };',
			'async function remove({ locals }) { writeAs(locals, (caller) => requireCard(caller, 1, "edit")); }',
			'export { handler as POST, remove as DELETE };',
			"export { PUT } from './elsewhere';"
		].join('\n');

		expect(judged(code)).toEqual([
			'src/routes/api/example/+server.ts:1 POST calls neither writeAs(locals, …) nor stillCallerNow(locals)',
			'src/routes/api/example/+server.ts:1 POST writes outside writeAs at line 1 (db.insert)',
			'src/routes/api/example/+server.ts:4 PUT is not a function this test can read'
		]);
		// Card 2115's rule reads the same handlers.
		const reading = readFile('src/routes/api/example/+server.ts', code);
		expect(reading.handlers.map(({ method, reads }) => [method, reads])).toEqual([
			['POST', true],
			['DELETE', false]
		]);
		expect(reading.unread).toEqual(['src/routes/api/example/+server.ts:4 PUT is not a function this test can read']);
	});

	it('says to remove a binding from locals.user that a writeAs callback declares again, and stays quiet on the names it hides (probe 6)', () => {
		const code = [
			'export const PUT = async ({ request, locals }) => {',
			'\tconst user = requireUser(locals.user);',
			'\tconst body = await readBody(request);',
			'\twriteAs(locals, (caller) => {',
			'\t\tconst user = requireUser(caller);',
			'\t\treturn [user.id].map((user) => user + 1);',
			'\t});',
			'\twriteAs(locals, (user) => requireCard(user, 1, "edit"));',
			'};'
		].join('\n');

		expect(judged(code)).toEqual([
			'src/routes/api/example/+server.ts:1 PUT binds user from locals.user at line 2; quick checks bind no name: decide inside writeAs with caller',
			'src/routes/api/example/+server.ts:1 PUT: the name user is bound from locals.user at line 2 before the body; remove that binding (quick checks bind no name)'
		]);
	});

	it('finds locals.user, and every name bound from it, used inside writeAs', () => {
		const code = [
			'export const PUT = async ({ request, locals }) => {',
			'\tconst user = requireUser(locals.user);',
			'\tconst same = user;',
			'\tconst { user: who } = locals;',
			'\tconst body = await readBody(request);',
			'\twriteAs(locals, (caller) => {',
			'\t\trequireCard(user, 1, "edit");',
			'\t\trequireCard(same, 1, "edit");',
			'\t\trequireCard(who, 1, "edit");',
			'\t\trequireCard(locals.user, 1, "edit");',
			'\t\trequireCard(caller, 1, "edit");',
			'\t});',
			'};',
			'export const DELETE = async ({ locals: { user } }) => {',
			'\twriteAs(locals, () => requireCard(user, 1, "edit"));',
			'};'
		].join('\n');

		const at = 'src/routes/api/example/+server.ts';
		expect(judged(code)).toEqual([
			`${at}:1 PUT binds user from locals.user at line 2; quick checks bind no name: decide inside writeAs with caller`,
			`${at}:1 PUT binds same from locals.user at line 3; quick checks bind no name: decide inside writeAs with caller`,
			`${at}:1 PUT binds who from locals.user at line 4; quick checks bind no name: decide inside writeAs with caller`,
			`${at}:1 PUT uses user, bound from locals.user at line 2, at line 7: decide inside writeAs with caller`,
			`${at}:1 PUT uses same, bound from locals.user at line 3, at line 8: decide inside writeAs with caller`,
			`${at}:1 PUT uses who, bound from locals.user at line 4, at line 9: decide inside writeAs with caller`,
			`${at}:1 PUT reads locals.user at line 10: decide inside writeAs with caller`,
			// The DELETE is given no `locals` by that name: its writeAs is not given the locals either.
			`${at}:14 DELETE calls neither writeAs(locals, …) nor stillCallerNow(locals)`,
			`${at}:14 DELETE calls writeAs at line 15 with something other than the locals it is given`,
			`${at}:14 DELETE gives writeAs at line 15 a callback that never uses its caller: decide inside writeAs with caller`,
			`${at}:14 DELETE binds user from locals.user at line 14; quick checks bind no name: decide inside writeAs with caller`,
			`${at}:14 DELETE uses user, bound from locals.user at line 14, at line 15: decide inside writeAs with caller`
		]);
	});

	it('finds writeAs given a function it cannot read', () => {
		const code = 'export const POST = async ({ locals }) => {\n\twriteAs(locals, write);\n};';

		expect(judged(code)).toEqual(['src/routes/api/example/+server.ts:1 POST gives writeAs at line 2 a function this test cannot read']);
	});

	it('finds inTransaction imported or called, in a write handler or outside one (a)', () => {
		const code = [
			"import { inTransaction } from '$lib/server/db/transaction';",
			'const helper = () => inTransaction(() => 1);',
			'export const POST = async ({ request, locals }) => {',
			'\tconst body = await readBody(request);',
			'\twriteAs(locals, (caller) => inTransaction(() => requireCard(caller, 1, "edit")));',
			'};'
		].join('\n');

		const file = 'src/routes/api/example/+server.ts';

		expect(judgeWrites(file, code).findings).toEqual([
			{ file, handler: null, finding: `${file}:1 names inTransaction: write through writeAs (a)` },
			{ file, handler: null, finding: `${file}:2 names inTransaction: write through writeAs (a)` },
			{ file, handler: `${file} POST`, finding: `${file}:5 names inTransaction: write through writeAs (a)` }
		]);
	});

	it('finds stillCallerNow in a handler not on STILL_CALLER_NOW, and one on it that does not call it (b)', () => {
		const stray = 'export const POST = async ({ request, locals }) => {\n\tconst body = await readBody(request);\n\tconst caller = stillCallerNow(locals);\n};';
		const missing = 'export const POST = async ({ request, locals }) => {\n\tconst body = await readBody(request);\n\twriteAs(locals, (caller) => runBackup(caller));\n};';

		expect(judged(stray)).toEqual(['src/routes/api/example/+server.ts:1 POST calls stillCallerNow and is not on STILL_CALLER_NOW (b)']);
		expect(judged(missing, 'src/routes/api/admin/backup/+server.ts')).toEqual([
			'src/routes/api/admin/backup/+server.ts:1 POST is on STILL_CALLER_NOW and does not call stillCallerNow(locals) (b)'
		]);
	});

	it('passes the report mail checked right after its body and again before the send, with nothing awaited between either and what it guards', () => {
		const code = [
			'export const POST = async ({ request, locals }) => {',
			'\trequireUser(locals.user);',
			'\tconst body = await readBody(request);',
			'\tconst caller = stillCallerNow(locals);',
			'\tconst user = requireUser(caller);',
			'\tconst data = generateBoardReport(1, user);',
			'\tconst pdf = await generateReportPdf(data);',
			'\tstillCallerNow(locals);',
			'\tawait sendEmailWithAttachment("a@example.test", pdf);',
			'};'
		].join('\n');

		expect(judged(code, 'src/routes/api/reports/email/+server.ts')).toEqual([]);
	});

	it('finds the check not right after the body, a decision after it on the gate’s caller, and an await before what it guards (b, c)', () => {
		const late = [
			'export const POST = async ({ request, locals }) => {',
			'\tconst user = locals.user;',
			'\tconst body = await readBody(request);',
			'\tlog(body);',
			'\tconst caller = stillCallerNow(locals);',
			'\tif (user.role !== "superadmin") throw error(403);',
			'\tawait settle();',
			'\tawait runBackup(caller);',
			'};'
		].join('\n');
		const once = [
			'export const POST = async ({ request, locals }) => {',
			'\tconst body = await readBody(request);',
			'\tconst caller = stillCallerNow(locals);',
			'\tconst data = generateBoardReport(1, caller);',
			'\tconst pdf = await generateReportPdf(data);',
			'\tawait sendEmailWithAttachment("a@example.test", pdf);',
			'};'
		].join('\n');

		expect(judged(late, 'src/routes/api/admin/backup/+server.ts')).toEqual([
			'src/routes/api/admin/backup/+server.ts:1 POST binds user from locals.user at line 2; quick checks bind no name: decide inside writeAs with caller',
			'src/routes/api/admin/backup/+server.ts:1 POST uses user, bound from locals.user at line 2, at line 6: decide inside writeAs with caller',
			'src/routes/api/admin/backup/+server.ts:1 POST does not ask stillCallerNow right after its body (line 5)',
			'src/routes/api/admin/backup/+server.ts:1 POST awaits at line 7, between its check at line 5 and runBackup at line 8 (c)'
		]);
		expect(judged(once, 'src/routes/api/reports/email/+server.ts')).toEqual([
			'src/routes/api/reports/email/+server.ts:1 POST calls stillCallerNow 1 time(s) and guards 2 call(s) (c)'
		]);
	});

	it('finds a check with nothing after it that it guards (c)', () => {
		const code = 'export const POST = async ({ locals }) => {\n\tconst caller = stillCallerNow(locals);\n\treturn json({});\n};';

		expect(judged(code, 'src/routes/api/admin/vacuum/+server.ts')).toEqual([
			'src/routes/api/admin/vacuum/+server.ts:1 POST calls nothing matching /^sqlite\\.exec$/ after its check at line 2 (c)'
		]);
	});

	it("passes a current-password route whose write is all inside writeAs, and finds one that is not (d)", () => {
		const route = (write: string) =>
			[
				'export const PUT = async ({ request, locals }) => {',
				'\tconst body = await readBody(request);',
				`\tconst done = await whilePasswordHolds(1, body.password, hash, ${write}, wrong);`,
				'\treturn json(done);',
				'};'
			].join('\n');
		const file = 'src/routes/api/account/password/+server.ts';

		expect(judged(route('(current) => writeAs(locals, (caller) => setPassword(caller, current))'), file)).toEqual([]);
		expect(judged(route('(current) => { setPassword(current); return writeAs(locals, (caller) => caller); }'), file)).toEqual([
			"src/routes/api/account/password/+server.ts:1 PUT calls setPassword at line 3 in whilePasswordHolds's write, outside its writeAs (d)"
		]);
		expect(judged(route('(current) => setPassword(current)'), file)).toEqual([
			'src/routes/api/account/password/+server.ts:1 PUT calls neither writeAs(locals, …) nor stillCallerNow(locals)',
			"src/routes/api/account/password/+server.ts:1 PUT does not call writeAs(locals, …) in whilePasswordHolds's write (d)",
			"src/routes/api/account/password/+server.ts:1 PUT calls setPassword at line 3 in whilePasswordHolds's write, outside its writeAs (d)"
		]);
	});

	it('cannot be passed by a write handler it cannot read', () => {
		expect(judged('export const DELETE = makeHandler();')).toEqual(['src/routes/api/example/+server.ts:1 DELETE is not a function this test can read']);
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
