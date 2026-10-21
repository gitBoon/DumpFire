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
import { join, posix } from 'node:path';
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
 * with a body. For the handlers card 2012 moves onto a service, the rule
 * after this one sees it, by import.
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
	'src/routes/api/admin/backup/gdrive/auth/+server.ts POST': { reason: 'The code goes to Google.', guards: [/(^|\.)getToken$/] },
	'src/routes/api/admin/smtp/+server.ts POST': {
		reason: 'The test mail leaves the process, and the route writes nothing (slice 2253-5, as the review ruled).',
		guards: [/^sendTestEmail$/]
	}
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

/**
 * By handler, the statements asked of `sqlite` outside writeAs that only read
 * (slice 2253-5, the reviewer to agree): `sqlite.prepare` of a SELECT written
 * in the handler, run with `.all()` or `.get()`. Anywhere else, anything asked
 * of `sqlite` outside writeAs is taken for a write.
 */
const READS_IN: Record<string, string> = {
	'src/routes/api/admin/import/+server.ts POST':
		'The safety copy reads every table the restore replaces, after the check and before the restore, outside any ' +
		'transaction, as the restore itself must run outside one; it writes nothing to the database.'
};

/**
 * By handler, the objects whose field named `user` is no account, read and
 * set inside writeAs (slice 2253-5, the reviewer to agree). Anywhere else, a
 * `.user` read after the body is taken for the caller as the gate read it.
 */
const USER_FIELDS_IN: Record<string, { of: string[]; reason: string }> = {
	'src/routes/api/admin/smtp/+server.ts PUT': {
		of: ['existing', 'config'],
		reason: "`user` there is the mail server's user name (SmtpConfig.user): the stored one kept, and the one sent saved."
	}
};

/**
 * By handler, where `locals.user` may be read after the body for a log line
 * alone: inside a catch clause, and nowhere else in it (the slices 5–7 review).
 * Names bound from it there are not followed; the catch decides nothing.
 */
const USER_FOR_A_LINE_IN: Record<string, string> = {
	'src/routes/api/admin/reset/+server.ts POST':
		'The failure line names who reset; when a fault in the database stops the first writeAs asking who that is now, ' +
		'the line names the account the gate let in. The reset has failed by then, and the catch answers 500.'
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
	// Slice 2253-5 (the superadmin's and administrators' routes): all 13 moved.
	// Slice 2253-6 (boards side of /api/v1): all 16 moved.
	// Slice 2253-7 (cards side of /api/v1): all 28 moved. Every write handler
	// keeps the rule; the list stays, empty, as the guard that a handler put
	// back on it must break the rule.
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

/**
 * By handler, a writeAs callback that lets its caller out, with why (card
 * 2012, the re-check of A1). An entry that lets nothing out fails. Empty
 * since slice A3: the one there was, the bulk milestone attach, returns the
 * name and id its plan-created mail reads, not the account.
 */
const CALLER_LET_OUT_IN: Record<string, string> = {};

/** What hands a function on to run later, by the last part of the callee's name. */
const RUNS_LATER = ['afterCommit', 'setTimeout', 'setImmediate', 'setInterval', 'queueMicrotask', 'then', 'catch', 'finally', 'on', 'once', 'addEventListener'];

/**
 * Where a writeAs callback lets its caller out (card 2012, the re-check of
 * A1, 3): the account it is handed is the account as it is now, for this
 * write, and is decided on inside the callback alone. Out of it, it is the
 * caller as the gate read it all over again. Its caller is the parameter, and
 * any name the callback binds to it or to `requireUser(` it `)`. Let out:
 * assigned to anything not declared in the callback; returned, or put in what
 * is returned (a call's result is that call's, not the caller); or kept by a
 * function that is returned, assigned out, or handed to something that runs it
 * later (`afterCommit`, a timer, a promise). A function run there and then
 * (`.map`) lets nothing out.
 */
function escapesOf(callback: Callback, tree: ts.SourceFile): { line: number; how: string }[] {
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const [parameter] = callback.parameters;
	if (!parameter || !ts.isIdentifier(parameter.name)) return [];
	const names = new Set([parameter.name.text]);
	const isCallerName = (node: ts.Node) => ts.isIdentifier(node) && names.has(node.text) && usedAsName(node) && !isDeclaredName(node);
	// The names bound to the caller, followed until none is added.
	for (let added = true; added; ) {
		added = false;
		const visit = (node: ts.Node): void => {
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && !names.has(node.name.text)) {
				const value = bare(node.initializer);
				const isCaller =
					isCallerName(value) || (ts.isCallExpression(value) && calleeOf(value, tree) === 'requireUser' && value.arguments.length > 0 && isCallerName(bare(value.arguments[0])));
				if (isCaller) {
					names.add(node.name.text);
					added = true;
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(callback.body);
	}
	/** Whether `node` uses the caller anywhere in it. */
	const usesCaller = (node: ts.Node): boolean => {
		if (isCallerName(node)) return true;
		return ts.forEachChild(node, usesCaller) === true;
	};
	/**
	 * What a value lets out: the caller itself, a function that keeps it, or
	 * nothing. A call's result is its own, and so is a field read off the
	 * caller (`user.username`): a name or an id, not the account.
	 */
	const exposes = (node: ts.Node): 'value' | 'closure' | null => {
		if (isCallerName(node)) return 'value';
		if (ts.isFunctionLike(node)) return usesCaller(node) ? 'closure' : null;
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) return null;
		if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isCallerName(bare(node.expression))) return null;
		let found: 'value' | 'closure' | null = null;
		ts.forEachChild(node, (child) => {
			found ??= exposes(child);
		});
		return found;
	};
	/** Whether a name is declared between `node` and the callback, the callback's parameters among them. */
	const declaredInside = (node: ts.Node, name: string) => {
		for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
			if (declaredIn(scope).some((declared) => declared.name === name)) return true;
			if (scope === callback) return false;
		}
		return false;
	};
	const found: { line: number; how: string }[] = [];
	const said = (kind: 'value' | 'closure', what: string) => (kind === 'value' ? `it is ${what}` : `a function that keeps it is ${what}`);
	// What it returns: its expression body, or each return not inside a function of its own.
	const returns: ts.Expression[] = [];
	if (!ts.isBlock(callback.body)) returns.push(callback.body);
	const visitReturns = (node: ts.Node): void => {
		if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
		if (!ts.isFunctionLike(node)) ts.forEachChild(node, visitReturns);
	};
	if (ts.isBlock(callback.body)) ts.forEachChild(callback.body, visitReturns);
	const visit = (node: ts.Node): void => {
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			const kind = exposes(node.right);
			const outside = !ts.isIdentifier(node.left) || !declaredInside(node, node.left.text);
			if (kind && outside) found.push({ line: line(node), how: `${kind === 'value' ? '' : 'a function that keeps it is '}assigned to ${node.left.getText(tree)}, outside the callback` });
		}
		if (ts.isCallExpression(node)) {
			const callee = calleeOf(node, tree);
			const last = callee.split('.').at(-1)!;
			if (RUNS_LATER.includes(last) && node.arguments.some((argument) => ts.isFunctionLike(argument) && usesCaller(argument))) {
				found.push({ line: line(node), how: `a function that keeps it is handed to ${callee}` });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(callback.body);
	for (const returned of returns) {
		const kind = exposes(returned);
		if (kind) found.push({ line: line(returned), how: said(kind, 'returned') });
	}
	return found.sort((a, b) => a.line - b.line);
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
	/** Inside a catch clause of a handler USER_FOR_A_LINE_IN names: where `locals.user` may name a log line. */
	const forALine = (node: ts.Node): boolean => {
		if (USER_FOR_A_LINE_IN[key] === undefined) return false;
		for (let scope: ts.Node | undefined = node.parent; scope && scope !== fn; scope = scope.parent) if (ts.isCatchClause(scope)) return true;
		return false;
	};
	for (let changed = true; changed; ) {
		changed = false;
		for (const declaration of declarations) {
			if (bindings.has(declaration) || forALine(declaration)) continue;
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
			if (bindings.has(assignment) || forALine(assignment)) continue;
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
		const escapes = escapesOf(callback, tree);
		if (CALLER_LET_OUT_IN[key] === undefined) {
			for (const escape of escapes) findings.push(`${at} lets its writeAs callback's caller out at line ${escape.line}: ${escape.how}`);
		} else if (escapes.length === 0) {
			findings.push(`${at} is on CALLER_LET_OUT_IN and lets its caller out nowhere`);
		}
	}

	/** Whether `node` is the handler's own event, by the name its parameter gives it. */
	const ownEvent = (node: ts.Expression) => {
		const held = bare(node);
		return given.eventName !== undefined && ts.isIdentifier(held) && held.text === given.eventName;
	};
	/** A read of a field named `locals`: `x.locals`, `x['locals']`. */
	const isLocalsRead = (node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
		(ts.isPropertyAccessExpression(node) && node.name.text === 'locals') ||
		(ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'locals');
	/** Whether `node` takes anything from any locals: the handler's by a name, any `.locals`, or the request event. */
	const fromLocals = (node: ts.Node): boolean => {
		let found = false;
		const look = (inner: ts.Node): void => {
			if (found) return;
			if ((ts.isIdentifier(inner) && isTheLocals(inner)) || isLocalsRead(inner)) found = true;
			else if (ts.isCallExpression(inner) && /(^|\.)getRequestEvent$/.test(calleeOf(inner, tree))) found = true;
			else ts.forEachChild(inner, look);
		};
		look(node);
		return found;
	};
	/**
	 * Whether a name resolves, by scope, to a const or let declared inside
	 * `callback`, from something that is not the locals, and never assigned
	 * again: what USER_FIELDS_IN's names must be.
	 */
	const declaredHereFromNoLocals = (id: ts.Identifier, callback: Callback): boolean => {
		const declaration = declarationOf(id, id.text);
		if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || !within(declaration, callback)) return false;
		if (!declaration.initializer || fromLocals(declaration.initializer)) return false;
		return !assignments.some((assignment) => assignment.left.text === id.text && declarationOf(assignment, id.text) === declaration);
	};

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
			// A field named `user` that USER_FIELDS_IN says is no account: on a name
			// that resolves, by scope, to a const or let declared inside this
			// writeAs callback, from something that is not the locals, and never
			// assigned again (the slices 5–7 review).
			const notAnAccount =
				callback !== undefined &&
				ts.isPropertyAccessExpression(node) &&
				ts.isIdentifier(node.expression) &&
				(USER_FIELDS_IN[key]?.of ?? []).includes(node.expression.text) &&
				declaredHereFromNoLocals(node.expression, callback);
			if (notAnAccount || (isLocalsUser(node) && forALine(node))) {
				// Let stand.
			} else if (node.getStart(tree) < boundary) {
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
		// The locals under a name given by assignment, which is not followed as a
		// declaration is, and any locals but the handler's own (the slices 5–7
		// review): `held = locals`, `getRequestEvent().locals`, `other.locals`.
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isTheLocals(node.right)) {
			decisions.push({ node, finding: `${at} assigns the locals to ${node.left.getText(tree)} at line ${line(node)}${DECIDE}` });
		}
		if (isLocalsRead(node) && !ownEvent(node.expression)) {
			decisions.push({ node, finding: `${at} reads ${node.getText(tree)} at line ${line(node)}, not the locals the handler is given${DECIDE}` });
		}
		if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && taking(node.name, 'locals').length > 0 && !ownEvent(node.initializer)) {
			decisions.push({
				node,
				finding: `${at} takes locals out of ${node.initializer.getText(tree)} at line ${line(node)}, not the locals the handler is given${DECIDE}`
			});
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
	/** `sqlite.prepare('SELECT …').all()` or `.get()`, the SQL written there: a read, where READS_IN lets one stand. */
	const isSelect = (call: ts.CallExpression) => {
		const [sql] = call.arguments;
		const text = sql && (ts.isStringLiteralLike(sql) ? sql.text : ts.isTemplateExpression(sql) ? sql.head.text : undefined);
		const run = call.parent;
		return (
			calleeOf(call, tree) === 'sqlite.prepare' &&
			text !== undefined &&
			/^\s*SELECT\s/i.test(text) &&
			ts.isPropertyAccessExpression(run) &&
			(run.name.text === 'all' || run.name.text === 'get') &&
			ts.isCallExpression(run.parent) &&
			run.parent.expression === run
		);
	};
	for (const call of writes.sort(byStart)) {
		if (writes.some((other) => other !== call && within(other, call))) continue;
		if (insideCallback(call)) continue;
		if (listed?.guards.some((guard) => guard.test(calleeOf(call, tree)))) continue;
		if (READS_IN[key] !== undefined && isSelect(call)) continue;
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

	it('asks the import once, with nothing awaited between its check and the restore (the slices 5–7 review)', () => {
		// (c) holds the import only to its first guarded call, the temporary copy;
		// the restore after it must run on the same check, with nothing awaited.
		const file = 'src/routes/api/admin/import/+server.ts';
		const tree = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
		const post = handlersOf(tree).find(({ method }) => method === 'POST')?.fn;
		const body = post?.body;
		expect(body).toBeDefined();
		const calls = callsIn(body!, true);
		const checks = calls.filter((call) => calleeOf(call, tree) === 'stillCallerNow');
		const restores = calls.filter((call) => calleeOf(call, tree) === 'restoreFromBackup');
		expect(checks).toHaveLength(1);
		expect(restores).toHaveLength(1);
		const [check] = checks;
		const [restore] = restores;
		expect(check.getEnd()).toBeLessThan(restore.getStart(tree));

		const awaited: string[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isAwaitExpression(node) && node.getStart(tree) > check.getEnd() && node.getStart(tree) < restore.getStart(tree)) awaited.push(node.getText(tree));
			ts.forEachChild(node, visit);
		};
		visit(body!);
		expect(awaited).toEqual([]);
	});

	it('names on STILL_CALLER_NOW and CURRENT_PASSWORD only write handlers there are', () => {
		expect(Object.keys(STILL_CALLER_NOW).filter((key) => !writing.includes(key))).toEqual([]);
		expect(CURRENT_PASSWORD.filter((key) => !writing.includes(key))).toEqual([]);
		expect(Object.keys(QUICK_CHECKS_IN).filter((key) => !writing.includes(key))).toEqual([]);
		expect(Object.keys(READS_IN).filter((key) => !writing.includes(key))).toEqual([]);
		expect(Object.keys(USER_FIELDS_IN).filter((key) => !writing.includes(key))).toEqual([]);
		expect(Object.keys(USER_FOR_A_LINE_IN).filter((key) => !writing.includes(key))).toEqual([]);
		expect(Object.keys(CALLER_LET_OUT_IN).filter((key) => !writing.includes(key))).toEqual([]);
		// R2's seven, and the test mail (slice 2253-5).
		expect(Object.keys(STILL_CALLER_NOW)).toHaveLength(8);
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
			'src/routes/api/users/[id]/password/+server.ts PUT',
			// Slice 2253-5: the superadmin's and administrators' routes.
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
			// Slice 2253-6: boards side of /api/v1.
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
			// Slice 2253-7: cards side of /api/v1.
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
			// Card 2283: the v1 comment delete, new, keeping it from the start.
			'src/routes/api/v1/comments/[commentId]/+server.ts DELETE',
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

	it('lets a SELECT asked of sqlite outside writeAs stand only where READS_IN says, and nothing else asked of it (slice 2253-5)', () => {
		const code = [
			'export const POST = async ({ request, locals }) => {',
			'\tconst buffer = await request.arrayBuffer();',
			'\trequireSuperadmin(stillCallerNow(locals));',
			'\twriteFileSync("restore.db", buffer);',
			'\tsqlite.prepare("SELECT * FROM cards").all();',
			'\tsqlite.prepare(`SELECT * FROM "${table}"`).get(1);',
			'\tsqlite.prepare("DELETE FROM cards").all();',
			'\tsqlite.prepare("SELECT 1").run();',
			'\tsqlite.exec("SELECT 1");',
			'\treturn json({});',
			'};'
		].join('\n');
		const restore = 'src/routes/api/admin/import/+server.ts';

		expect(judged(code)).toEqual([
			'src/routes/api/example/+server.ts:1 POST writes outside writeAs at line 5 (sqlite.prepare)',
			'src/routes/api/example/+server.ts:1 POST writes outside writeAs at line 6 (sqlite.prepare)',
			'src/routes/api/example/+server.ts:1 POST writes outside writeAs at line 7 (sqlite.prepare)',
			'src/routes/api/example/+server.ts:1 POST writes outside writeAs at line 8 (sqlite.prepare)',
			'src/routes/api/example/+server.ts:1 POST writes outside writeAs at line 9 (sqlite.exec)',
			'src/routes/api/example/+server.ts:1 POST calls stillCallerNow and is not on STILL_CALLER_NOW (b)'
		]);
		expect(judged(code, restore)).toEqual([
			`${restore}:1 POST writes outside writeAs at line 7 (sqlite.prepare)`,
			`${restore}:1 POST writes outside writeAs at line 8 (sqlite.prepare)`,
			`${restore}:1 POST writes outside writeAs at line 9 (sqlite.exec)`
		]);
	});

	it('lets a field named user stand only on the objects USER_FIELDS_IN names, declared inside writeAs (slice 2253-5)', () => {
		const code = [
			'export const PUT = async ({ request, locals }) => {',
			'\tconst body = await readBody(request);',
			'\tconst other = read();',
			'\tconst saved = writeAs(locals, (caller) => {',
			'\t\trequireSuperadmin(caller);',
			'\t\tconst existing = read();',
			'\t\tconst config = {};',
			'\t\tconfig.user = existing?.user;',
			'\t\treturn other.user;',
			'\t});',
			'\treturn json(saved.user);',
			'};'
		].join('\n');
		const mail = 'src/routes/api/admin/smtp/+server.ts';
		const DECIDE = ': decide inside writeAs with caller';

		expect(judged(code)).toEqual([
			`src/routes/api/example/+server.ts:1 PUT reads config.user at line 8${DECIDE}`,
			`src/routes/api/example/+server.ts:1 PUT reads existing?.user at line 8${DECIDE}`,
			`src/routes/api/example/+server.ts:1 PUT reads other.user at line 9${DECIDE}`,
			`src/routes/api/example/+server.ts:1 PUT reads saved.user at line 11${DECIDE}`
		]);
		expect(judged(code, mail)).toEqual([`${mail}:1 PUT reads other.user at line 9${DECIDE}`, `${mail}:1 PUT reads saved.user at line 11${DECIDE}`]);
	});

	it('lets no field named user stand in the mail save on a name declared outside the callback, reassigned, or taken from the locals (the slices 5–7 review probes)', () => {
		const code = [
			'export const PUT = async ({ request, locals }) => {',
			'\tlet config = {};',
			'\tconfig = locals;',
			'\tconst body = await readBody(request);',
			'\twriteAs(locals, (caller) => {',
			'\t\trequireSuperadmin(caller);',
			'\t\tconst existing = getRequestEvent().locals;',
			'\t\tlet other = read();',
			'\t\tother = read();',
			'\t\treturn [config.user.id, existing.user, other.user];',
			'\t});',
			'};'
		].join('\n');
		const mail = 'src/routes/api/admin/smtp/+server.ts';
		const DECIDE = ': decide inside writeAs with caller';

		expect(judged(code, mail)).toEqual([
			`${mail}:1 PUT assigns the locals to config at line 3${DECIDE}`,
			`${mail}:1 PUT reads getRequestEvent().locals at line 7, not the locals the handler is given${DECIDE}`,
			`${mail}:1 PUT reads config.user at line 10${DECIDE}`,
			`${mail}:1 PUT reads existing.user at line 10${DECIDE}`,
			`${mail}:1 PUT reads other.user at line 10${DECIDE}`
		]);
	});

	it('lets locals.user name a log line only inside a catch, and only in the reset (the slices 5–7 review)', () => {
		const code = [
			'export const POST = async ({ locals }) => {',
			'\tlet actor;',
			'\ttry {',
			'\t\tactor = writeAs(locals, (caller) => requireSuperadmin(caller));',
			'\t} catch (e) {',
			'\t\tconst who = actor ?? locals.user;',
			'\t\tlog.error(`failed for ${who?.username}`);',
			'\t\tthrow e;',
			'\t}',
			'\treturn json({ by: locals.user.id });',
			'};'
		].join('\n');
		const reset = 'src/routes/api/admin/reset/+server.ts';
		const DECIDE = ': decide inside writeAs with caller';

		expect(judged(code)).toEqual([
			`src/routes/api/example/+server.ts:1 POST binds who from locals.user at line 6; quick checks bind no name${DECIDE}`,
			`src/routes/api/example/+server.ts:1 POST uses who, bound from locals.user at line 6, at line 7${DECIDE}`,
			`src/routes/api/example/+server.ts:1 POST reads locals.user at line 10${DECIDE}`
		]);
		expect(judged(code, reset)).toEqual([`${reset}:1 POST reads locals.user at line 10${DECIDE}`]);
	});

	it('finds the locals assigned to a name, and any locals but the handler’s own read, in every handler (the slices 5–7 review)', () => {
		const code = [
			'export const POST = async ({ request, locals }) => {',
			'\tconst body = await readBody(request);',
			'\tlet held;',
			'\theld = locals;',
			'\tconst event = getRequestEvent();',
			'\tconst { locals: other } = getRequestEvent();',
			'\twriteAs(locals, (caller) => requireCard(caller, event.locals ? 1 : event["locals"] ? 2 : 3, "edit"));',
			'};',
			'export const PUT = async (event) => {',
			'\tconst { locals } = event;',
			'\tconst body = await event.request.json();',
			'\twriteAs(event.locals, (caller) => requireCard(caller, 1, "edit"));',
			'};'
		].join('\n');
		const DECIDE = ': decide inside writeAs with caller';
		const at = 'src/routes/api/example/+server.ts:1 POST';

		// The handler's own event, its locals taken out of it, pass (PUT).
		expect(judged(code)).toEqual([
			`${at} assigns the locals to held at line 4${DECIDE}`,
			`${at} takes locals out of getRequestEvent() at line 6, not the locals the handler is given${DECIDE}`,
			`${at} reads event.locals at line 7, not the locals the handler is given${DECIDE}`,
			`${at} reads event["locals"] at line 7, not the locals the handler is given${DECIDE}`
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
		expect(judged(route('(current) => { setPassword(current); return writeAs(locals, (caller) => caller.id); }'), file)).toEqual([
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

	it("finds the callback's caller let out: assigned outside, returned, or kept by a function returned or handed on to run later (card 2012, the re-check, 3)", () => {
		const code = [
			'export const POST = async ({ request, locals }) => {',
			'\tconst body = await readBody(request);',
			'\tlet u;',
			'\twriteAs(locals, (caller) => { u = caller; return 0; });',
			'\tsetThing(u, body);',
			'\treturn json({});',
			'};',
			'export const PUT = async ({ request, locals }) => {',
			'\tconst body = await readBody(request);',
			'\tconst later = writeAs(locals, (caller) => () => requireCard(caller, 1, "edit"));',
			'\tconst who = writeAs(locals, (caller) => ({ by: caller, at: 1 }));',
			'\tconst me = writeAs(locals, (caller) => { const user = requireUser(caller); afterCommit(() => notify(user)); return 0; });',
			// Used and let go inside the callback: a guard, a list worked through there and then, a card returned.
			'\tconst card = writeAs(locals, (caller) => { const user = requireUser(caller); [1, 2].map((id) => requireCard(user, id, "edit")); return requireCard(caller, 1, "edit").card; });',
			'\treturn json({ who, me, later, card });',
			'};'
		].join('\n');

		expect(judged(code)).toEqual([
			"src/routes/api/example/+server.ts:1 POST lets its writeAs callback's caller out at line 4: assigned to u, outside the callback",
			"src/routes/api/example/+server.ts:8 PUT lets its writeAs callback's caller out at line 10: a function that keeps it is returned",
			"src/routes/api/example/+server.ts:8 PUT lets its writeAs callback's caller out at line 11: it is returned",
			"src/routes/api/example/+server.ts:8 PUT lets its writeAs callback's caller out at line 12: a function that keeps it is handed to afterCommit"
		]);
	});
});

// ─── One service per action, written only inside writeAs (card 2012) ────────

/*
 * Card 2012 moves each pair of handlers, the internal one and its /api/v1
 * twin, onto one service in src/lib/server/ that both call, handed `caller`
 * inside the handler's writeAs callback. Card 2253's rule above could not see
 * a service the handler calls outside its callback that writes. This one
 * decides by import, not by a list of names (R5 of the plan,
 * docs/planning/card-2012-service-layer-and-pages.md), read from the source
 * and failing closed:
 *
 *   1. in every write handler that calls a service (one moved onto it), each
 *      call after its body to a function imported from `$lib/server/**` is
 *      inside a writeAs callback, unless it is on OUTSIDE_WRITE with its
 *      reason; what shapes the answer is made inside and returned; and a
 *      service write is handed, first, the caller its own callback was
 *      handed, as it is or through requireUser (the review of A1, 8);
 *   2. each module on SERVICES has an explicit `READS` export naming its
 *      read functions; every other function it exports is a write, and the
 *      first statement of each is `inWrite();`; it exports nothing else in
 *      any form, no default, no value that is not a function written there,
 *      nothing from elsewhere. In a route file, a write is called only inside
 *      a writeAs callback, and a read only in a GET or inside a callback;
 *   3. no module on SERVICES names `inTransaction`, under any name, but in a
 *      write, after its `inWrite()`; a read inserts, updates, deletes or runs
 *      nothing; and none names `locals`, `App.Locals`, `RequestEvent` or
 *      `getRequestEvent`, or imports `$app/server`;
 *   4. SERVICES names every module under src/lib/server/ that imports
 *      `inWrite` or exports, in any form, a function handed the caller (a
 *      first parameter `caller` that is an account, or any first parameter
 *      typed `SessionUser | null`), but those on NOT_SERVICES with why, and
 *      nothing else; no module re-exports a service, and nothing imports one
 *      with `import()`. A service write's options are an object written out
 *      at the call, and a `says` among them words written out (the review, 4);
 *   5. the rule itself, against made-up source.
 *
 * At run time `inWrite()` (src/lib/server/write-as.ts) refuses a service
 * write outside a writeAs callback, a job's bare inTransaction among them
 * (tests/write-as.test.ts). Card 2253's walks of
 * tests/access-every-route.test.ts ("asked again at the write") are the
 * behavioural backstop, run unchanged.
 */

/**
 * The modules both API trees' handlers call for their work, each written to
 * the rule above. Slice A1: the cards; A2: what is on a card; A3: dependencies,
 * a card's cost and the token writes, milestones; A4: boards, dashboard
 * groupings, columns, card categories and labels.
 */
const SERVICES = [
	'src/lib/server/cards.ts',
	'src/lib/server/card-assignees.ts',
	'src/lib/server/card-comments.ts',
	'src/lib/server/card-labels.ts',
	'src/lib/server/subtasks.ts',
	'src/lib/server/work-dependencies.ts',
	'src/lib/server/token-service.ts',
	'src/lib/server/milestone-service.ts',
	'src/lib/server/boards.ts',
	'src/lib/server/board-groupings.ts',
	'src/lib/server/columns.ts',
	'src/lib/server/card-categories.ts',
	'src/lib/server/labels.ts',
	// Card 2337: the card window's files, the web application's alone.
	'src/lib/server/card-attachments.ts'
];

/**
 * What a handler that calls a service may call from `$lib/server/**` after
 * its body outside its writeAs callback, by name, with why. Nothing it
 * calls there reads a row a guard decides on, or writes.
 */
const OUTSIDE_WRITE: Record<string, string> = {
	pathId: 'The id in the path, read as a number: no row. A handler with no body reads it before its writeAs.',
	linkBaseUrl:
		"The address the mail a write sends links to: the configured App URL or the server's origin, read before the " +
		'transaction, as it decides nothing about the caller or the row.',
	json: "v1's answer (`$lib/server/v1-json`), made from what the callback returned, once the write is committed.",
	attachmentPath:
		"A path in the card's folder (`$lib/server/uploads`): no row, read before and after the transaction for the file " +
		'itself, which an upload writes before its row and removes again if the row is not written (card 2337).',
	cardDir:
		"The card's folder (`$lib/server/uploads`): no row, made before the transaction for the file and removed after a " +
		'failed one if the upload made it (card 2337).'
};

/** The source file a `$lib/server/...` import names, or null for any other import. */
function serverFileOf(specifier: string): string | null {
	if (specifier !== '$lib/server' && !specifier.startsWith('$lib/server/')) return null;
	const rest = specifier.slice('$lib/server'.length);
	for (const candidate of [`src/lib/server${rest}.ts`, `src/lib/server${rest}/index.ts`]) {
		try {
			readFileSync(join(ROOT, candidate));
			return candidate;
		} catch {
			// Not that one.
		}
	}
	return `src/lib/server${rest}.ts`;
}

/** A module's imports from `$lib/server/**`: each local name, with the file and the name it is exported under. */
function serverImportsOf(tree: ts.SourceFile): { names: Map<string, { file: string; name: string }>; namespaces: { file: string; line: number }[] } {
	const names = new Map<string, { file: string; name: string }>();
	const namespaces: { file: string; line: number }[] = [];
	for (const statement of tree.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const clause = statement.importClause;
		const file = serverFileOf(statement.moduleSpecifier.text);
		if (!file || !clause || clause.isTypeOnly) continue;
		if (clause.name) names.set(clause.name.text, { file, name: 'default' });
		const bindings = clause.namedBindings;
		if (bindings && ts.isNamespaceImport(bindings)) {
			namespaces.push({ file, line: tree.getLineAndCharacterOfPosition(statement.getStart(tree)).line + 1 });
		} else if (bindings) {
			for (const element of bindings.elements) {
				if (!element.isTypeOnly) names.set(element.name.text, { file, name: (element.propertyName ?? element.name).text });
			}
		}
	}
	return { names, namespaces };
}

/** What a service module exports and what breaks the rule in it: its reads, its writes, and the findings (2 and 3). */
type ServiceReading = { reads: string[]; writes: string[]; findings: string[] };

/**
 * Everything a module exports, in source order, in every form it can
 * (the review of A1, 1): its functions by name (`export function f`,
 * `export const f = (…) =>`, `export { f }` of a function written here),
 * its default export, every other value it exports (a constant, a class,
 * `once((caller) => …)`), and what it re-exports from elsewhere. Types are
 * left out: they write nothing.
 */
type ExportReading = {
	functions: { name: string; fn: HandlerFunction; at: ts.Node }[];
	defaults: { fn: HandlerFunction | undefined; value: ts.Node | undefined; at: ts.Node }[];
	values: { name: string; value: ts.Node | undefined; at: ts.Node }[];
	reexports: { specifier: string; at: ts.Node }[];
};

function exportsOf(tree: ts.SourceFile): ExportReading {
	const reading: ExportReading = { functions: [], defaults: [], values: [], reexports: [] };
	const asFunction = (node: ts.Node | undefined): HandlerFunction | undefined => {
		const value = node && ts.isExpression(node) ? bare(node) : node;
		return value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isFunctionDeclaration(value)) ? value : undefined;
	};
	/** What a name written in this file is: its function, or the value it is declared with. */
	const local = (name: string): { fn: HandlerFunction | undefined; value: ts.Node | undefined } => {
		for (const statement of tree.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return { fn: statement, value: statement };
			if ((ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name?.text === name) return { fn: undefined, value: statement };
			if (!ts.isVariableStatement(statement)) continue;
			for (const declared of statement.declarationList.declarations) {
				if (ts.isIdentifier(declared.name) && declared.name.text === name) return { fn: asFunction(declared.initializer), value: declared.initializer };
			}
		}
		return { fn: undefined, value: undefined };
	};
	for (const statement of tree.statements) {
		if (ts.isExportDeclaration(statement)) {
			if (statement.isTypeOnly) continue;
			if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
				reading.reexports.push({ specifier: statement.moduleSpecifier.text, at: statement });
				continue;
			}
			if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
			for (const element of statement.exportClause.elements) {
				if (element.isTypeOnly) continue;
				const { fn, value } = local((element.propertyName ?? element.name).text);
				if (fn) reading.functions.push({ name: element.name.text, fn, at: element });
				else reading.values.push({ name: element.name.text, value, at: element });
			}
			continue;
		}
		if (ts.isExportAssignment(statement)) {
			reading.defaults.push({ fn: asFunction(statement.expression), value: statement.expression, at: statement });
			continue;
		}
		const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
		if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
		const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
		if (ts.isFunctionDeclaration(statement)) {
			if (isDefault || !statement.name) reading.defaults.push({ fn: statement, value: statement, at: statement });
			else reading.functions.push({ name: statement.name.text, fn: statement, at: statement });
		} else if (ts.isVariableStatement(statement)) {
			for (const declared of statement.declarationList.declarations) {
				const fn = asFunction(declared.initializer);
				const name = ts.isIdentifier(declared.name) ? declared.name.text : declared.name.getText(tree);
				if (fn && ts.isIdentifier(declared.name)) reading.functions.push({ name, fn, at: declared });
				else reading.values.push({ name, value: declared.initializer, at: declared });
			}
		} else if (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
			if (isDefault) reading.defaults.push({ fn: undefined, value: statement, at: statement });
			else reading.values.push({ name: statement.name?.text ?? 'default', value: statement, at: statement });
		}
	}
	return reading;
}

/**
 * Whether a function is handed the caller first, as a service is: a first
 * parameter `caller` that is an account (its type names `SessionUser`, or is
 * not written), or one of any name whose type is exactly `SessionUser | null`,
 * what a writeAs callback hands on. A guard's `SessionUser | null |
 * undefined`, a helper's `SessionUser`, and gdrive-connect's `caller:
 * ConnectCaller` are not.
 */
function handedTheCaller(fn: ts.SignatureDeclaration, tree: ts.SourceFile): boolean {
	const [first] = fn.parameters;
	if (!first || !ts.isIdentifier(first.name)) return false;
	if (first.type === undefined) return first.name.text === 'caller';
	const members = typeMembers(first.type.getText(tree), typeAliasesOf(tree));
	if (first.name.text === 'caller' && members.has('SessionUser')) return true;
	return members.size === 2 && members.has('SessionUser') && members.has('null');
}

/**
 * The type names a file writes for another (the re-check of A1, 3): its own
 * `type Caller = SessionUser | null`, and an import of `SessionUser` under
 * another name (`SessionUser as Account`), so that a caller's type is read
 * through them.
 */
function typeAliasesOf(tree: ts.SourceFile): Map<string, string> {
	const aliases = new Map<string, string>();
	for (const statement of tree.statements) {
		if (ts.isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement.type.getText(tree));
		const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
		if (bindings && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				if (element.propertyName?.text === 'SessionUser') aliases.set(element.name.text, 'SessionUser');
			}
		}
	}
	return aliases;
}

/** The members of a union written as text, each alias read through to what it names: `Caller | undefined` → SessionUser, null, undefined. */
function typeMembers(type: string, aliases: ReadonlyMap<string, string>, seen = new Set<string>()): Set<string> {
	const members = new Set<string>();
	for (const part of type.replace(/[()\s]/g, '').split('|').filter(Boolean)) {
		const target = aliases.get(part);
		if (target !== undefined && !seen.has(part)) {
			for (const member of typeMembers(target, aliases, new Set([...seen, part]))) members.add(member);
		} else {
			members.add(part);
		}
	}
	return members;
}

/** The file a module specifier names, from the file that names it: `$lib/server/…`, `$lib/…`, or a relative path. */
function moduleFileOf(from: string, specifier: string): string | null {
	if (specifier === '$lib/server' || specifier.startsWith('$lib/server/')) return serverFileOf(specifier);
	let base: string;
	if (specifier.startsWith('$lib/')) base = `src/lib/${specifier.slice('$lib/'.length)}`;
	else if (specifier.startsWith('.')) base = posix.join(posix.dirname(from), specifier);
	else return null;
	for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
		try {
			readFileSync(join(ROOT, candidate));
			return candidate;
		} catch {
			// Not that one.
		}
	}
	return `${base}.ts`;
}

/**
 * Rule 4 and its bans, over the modules given (the review of A1, 1): a
 * module under src/lib/server/ that imports `inWrite`, or exports in any form
 * a function handed the caller, must be on SERVICES, and one on SERVICES must
 * be one of those; no module re-exports a service's functions, and nothing
 * imports a service with `import()`, nor, in a route file, imports anything
 * with an `import()` whose module is not written out.
 */
function judgeServiceModules(
	files: { file: string; source: string }[],
	services: readonly string[],
	notServices: Record<string, string> = {}
): string[] {
	const findings: string[] = [];
	const stillGiven = new Set<string>();
	for (const { file, source } of files) {
		const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;

		if (file.startsWith('src/lib/server/') && file !== 'src/lib/server/write-as.ts') {
			const reasons: string[] = [];
			const writeAsNamespaces = new Set<string>();
			for (const statement of tree.statements) {
				if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
				const bindings = statement.importClause?.namedBindings;
				const fromWriteAs = /(^|\/)write-as$/.test(statement.moduleSpecifier.text);
				if (fromWriteAs && bindings && ts.isNamedImports(bindings) && bindings.elements.some((e) => (e.propertyName ?? e.name).text === 'inWrite')) {
					reasons.push('it imports inWrite');
				}
				if (fromWriteAs && bindings && ts.isNamespaceImport(bindings)) writeAsNamespaces.add(bindings.name.text);
			}
			// inWrite through a namespace: `w.inWrite()` (the re-check of A1, 3).
			let throughNamespace = false;
			const lookForInWrite = (node: ts.Node): void => {
				if (ts.isPropertyAccessExpression(node) && node.name.text === 'inWrite' && ts.isIdentifier(node.expression) && writeAsNamespaces.has(node.expression.text)) {
					throughNamespace = true;
				}
				ts.forEachChild(node, lookForInWrite);
			};
			lookForInWrite(tree);
			if (throughNamespace && !reasons.includes('it imports inWrite')) reasons.push('it imports inWrite');
			const exported = exportsOf(tree);
			const literals = (node: ts.Node | undefined): ts.SignatureDeclaration[] => {
				const found: ts.SignatureDeclaration[] = [];
				const visit = (inner: ts.Node): void => {
					if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner) || ts.isFunctionDeclaration(inner)) found.push(inner);
					ts.forEachChild(inner, visit);
				};
				if (node) visit(node);
				return found;
			};
			const given = [
				...exported.functions.map(({ name, fn }) => ({ name, fns: [fn] })),
				...exported.defaults.map(({ fn, value }) => ({ name: 'default', fns: fn ? [fn] : literals(value) })),
				...exported.values.map(({ name, value }) => ({ name, fns: literals(value) }))
			];
			for (const { name, fns } of given) {
				if (fns.some((fn) => handedTheCaller(fn, tree))) reasons.push(`it exports ${name}, whose first parameter is the caller`);
			}
			const listed = services.includes(file);
			// A module that is handed the caller and writes nothing, with why: only for a function, never for inWrite.
			const excused = file in notServices && reasons.length > 0 && !reasons.includes('it imports inWrite');
			if (excused) stillGiven.add(file);
			if (!listed && !excused) for (const reason of reasons) findings.push(`${file} must be on SERVICES: ${reason} (4)`);
			if (listed && reasons.length === 0) {
				findings.push(`${file} is on SERVICES and is no service: it imports no inWrite and exports no function handed the caller (4)`);
			}
		}

		const reexported = (target: string, at: ts.Node) =>
			findings.push(`${file}:${line(at)} re-exports ${target}, a service: import its functions by name where they are called`);
		const exported = exportsOf(tree);
		for (const { specifier, at } of exported.reexports) {
			const target = moduleFileOf(file, specifier);
			if (target && services.includes(target)) reexported(target, at);
		}
		// And a name imported from a service, exported again: `export { createCard }`,
		// `export const make = createCard`, `export default createCard` (the re-check of A1, 4).
		const fromService = new Map<string, string>();
		for (const statement of tree.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
			const target = moduleFileOf(file, statement.moduleSpecifier.text);
			const clause = statement.importClause;
			if (!target || !services.includes(target) || !clause || clause.isTypeOnly) continue;
			if (clause.name) fromService.set(clause.name.text, target);
			if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) fromService.set(clause.namedBindings.name.text, target);
			if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
				for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) fromService.set(element.name.text, target);
			}
		}
		const namesAService = (node: ts.Node | undefined): string | undefined => {
			const value = node && ts.isExpression(node) ? bare(node) : undefined;
			if (!value) return undefined;
			if (ts.isIdentifier(value)) return fromService.get(value.text);
			if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)) return fromService.get(value.expression.text);
			return undefined;
		};
		for (const statement of tree.statements) {
			if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
				for (const element of statement.exportClause.elements) {
					const target = fromService.get((element.propertyName ?? element.name).text);
					if (target) reexported(target, element);
				}
			}
		}
		for (const { value, at } of [...exported.values, ...exported.defaults]) {
			const target = namesAService(value);
			if (target) reexported(target, at);
		}
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				const [module] = node.arguments;
				if (module && ts.isStringLiteralLike(module)) {
					const target = moduleFileOf(file, module.text);
					if (target && services.includes(target)) findings.push(`${file}:${line(node)} imports ${target}, a service, with import(): import its functions by name`);
				} else if (file.startsWith('src/routes/') || file.startsWith('src/lib/server/')) {
					findings.push(`${file}:${line(node)} calls import() with a module that is not written out`);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(tree);
	}
	for (const service of services) {
		if (!files.some(({ file }) => file === service)) findings.push(`SERVICES names ${service}, which is not a module here (4)`);
	}
	for (const file of Object.keys(notServices)) {
		if (!stillGiven.has(file)) findings.push(`NOT_SERVICES names ${file}, which no longer exports a function handed the caller (or imports inWrite) (4)`);
	}
	return findings;
}

/**
 * The modules that export a function handed the caller and are not services,
 * by file, with why. Each writes nothing; one that imports inWrite cannot be
 * here, and an entry whose module no longer exports such a function fails.
 */
const NOT_SERVICES: Record<string, string> = {
	'src/lib/server/request-access.ts':
		'requireRequest is a guard: it reads the request and refuses, and writes nothing. Its first parameter is ' +
		'`SessionUser | null` because the public request routes are called by nobody signed in.'
};

/** Rules 2 and 3 for one service module. */
function judgeService(file: string, source: string): ServiceReading {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const findings: string[] = [];

	// READS: an exported const, a list of names written out.
	let reads: string[] | undefined;
	for (const statement of tree.statements) {
		if (!ts.isVariableStatement(statement) || !ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
		for (const declared of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declared.name) || declared.name.text !== 'READS') continue;
			let value = declared.initializer;
			while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression;
			if (value && ts.isArrayLiteralExpression(value) && value.elements.every((element) => ts.isStringLiteralLike(element))) {
				reads = value.elements.map((element) => (element as ts.StringLiteralLike).text);
			} else {
				findings.push(`${file}:${line(declared)} READS is not a list of names written out`);
				reads = [];
			}
		}
	}
	if (reads === undefined) {
		findings.push(`${file} has no READS export naming its read functions`);
		reads = [];
	}

	// Where inWrite comes from: write-as, by its own name. And every name
	// inTransaction is imported under (the review of A1, 3).
	const imported = new Map<string, string>();
	const transactionNames = new Set(['inTransaction']);
	for (const statement of tree.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const bindings = statement.importClause?.namedBindings;
		if (bindings && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				imported.set(element.name.text, `${statement.moduleSpecifier.text} ${(element.propertyName ?? element.name).text}`);
				if ((element.propertyName ?? element.name).text === 'inTransaction') transactionNames.add(element.name.text);
			}
		}
		if (statement.moduleSpecifier.text === '$app/server') findings.push(`${file}:${line(statement)} imports $app/server (3)`);
	}
	/** `inTransaction` under any name it is imported by, or reached through a namespace: `t.inTransaction`. */
	const namesTransaction = (node: ts.Node): boolean =>
		(ts.isIdentifier(node) && transactionNames.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) ||
		(ts.isPropertyAccessExpression(node) && node.name.text === 'inTransaction');
	const isInWrite = (statement: ts.Statement | undefined) =>
		statement !== undefined &&
		ts.isExpressionStatement(statement) &&
		ts.isCallExpression(statement.expression) &&
		ts.isIdentifier(statement.expression.expression) &&
		statement.expression.expression.text === 'inWrite' &&
		statement.expression.arguments.length === 0 &&
		/(^|\/)write-as inWrite$/.test(imported.get('inWrite') ?? '');

	const exported = exportsOf(tree);
	const writes: string[] = [];
	/** Each write's body after its inWrite(): where inTransaction may be named. */
	const afterInWrite: ts.Node[] = [];
	for (const { name, fn, at } of exported.functions) {
		if (reads.includes(name)) continue;
		writes.push(name);
		const first = fn.body && ts.isBlock(fn.body) ? fn.body.statements[0] : undefined;
		if (!isInWrite(first)) {
			findings.push(`${file}:${line(at)} ${name} is a write (it is not on READS) and its first statement is not inWrite() (2)`);
			continue;
		}
		afterInWrite.push(...(fn.body as ts.Block).statements.slice(1));
	}
	// Nothing else is exported but READS: no default, no value a test cannot read for a write, nothing from elsewhere.
	for (const { at } of exported.defaults) findings.push(`${file}:${line(at)} has a default export: a service exports its functions by name (2)`);
	for (const { name, at } of exported.values) {
		if (name !== 'READS') findings.push(`${file}:${line(at)} exports ${name}, which is not a function written here: a service exports its functions and READS alone (2)`);
	}
	for (const { specifier, at } of exported.reexports) findings.push(`${file}:${line(at)} re-exports from ${specifier}: a service exports only what it writes here (2)`);
	for (const name of reads) {
		if (!exported.functions.some((e) => e.name === name)) findings.push(`${file} names ${name} on READS, and exports no such function (2)`);
	}

	// (3): a read writes nothing: no insert, update, delete, run, exec or statement
	// prepared (the re-check of A1, 5), and no transaction of its own; nor does a
	// function of the module it calls, followed one level.
	const writesIn = (body: ts.Node) => {
		const writing = callsIn(body, true).filter((call) => {
			const callee = call.expression;
			return (ts.isPropertyAccessExpression(callee) && ['insert', 'update', 'delete', 'run', 'exec', 'prepare'].includes(callee.name.text)) || namesTransaction(callee);
		});
		return writing.filter((call) => !writing.some((other) => other !== call && within(call, other)));
	};
	/** A function written in this module, by name: a declaration, or a constant that holds one. */
	const moduleFunction = (name: string): HandlerFunction | undefined => {
		for (const statement of tree.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
			if (!ts.isVariableStatement(statement)) continue;
			for (const declared of statement.declarationList.declarations) {
				const value = declared.initializer && bare(declared.initializer);
				if (ts.isIdentifier(declared.name) && declared.name.text === name && value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) return value;
			}
		}
		return undefined;
	};
	for (const { name, fn } of exported.functions) {
		if (!reads.includes(name) || !fn.body) continue;
		const direct = new Set(writesIn(fn.body));
		for (const call of callsIn(fn.body, true)) {
			if (direct.has(call)) {
				findings.push(`${file}:${line(call)} ${name} is on READS and writes: ${calleeOf(call, tree)} (3)`);
				continue;
			}
			const helper = ts.isIdentifier(call.expression) ? moduleFunction(call.expression.text) : undefined;
			if (!helper?.body || helper === fn) continue;
			for (const inner of writesIn(helper.body)) {
				findings.push(`${file}:${line(inner)} ${name} is on READS and writes: ${calleeOf(inner, tree)} (through ${call.expression.getText(tree)}) (3)`);
			}
		}
	}

	// (3): inTransaction only after a write's inWrite(); nothing of the request.
	const visit = (node: ts.Node): void => {
		if (namesTransaction(node) && !ts.isImportSpecifier(node.parent) && !afterInWrite.some((statement) => within(node, statement))) {
			// Its import is no use of it.
			const as = node.getText(tree);
			findings.push(`${file}:${line(node)} names inTransaction${as === 'inTransaction' ? '' : ` (as ${as})`} other than in a write after its inWrite() (3)`);
		}
		if (ts.isIdentifier(node)) {
			if (['locals', 'RequestEvent', 'getRequestEvent'].includes(node.text)) findings.push(`${file}:${line(node)} names ${node.text} (3)`);
			if (node.text === 'App' && ts.isQualifiedName(node.parent) && node.parent.right.text === 'Locals') findings.push(`${file}:${line(node)} names App.Locals (3)`);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return { reads, writes, findings: [...new Set(findings)] };
}

/**
 * Rules 1 and 2 for one route file: the calls of every write handler in it
 * that calls a service, and every call of a service's function anywhere in
 * it. `services` is each service module's file with its reads and writes.
 */
function judgeServiceCalls(file: string, source: string, services: Map<string, { reads: string[]; writes: string[] }>): string[] {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const findings: string[] = [];
	const { names, namespaces } = serverImportsOf(tree);
	for (const namespace of namespaces) {
		if (services.has(namespace.file)) findings.push(`${file}:${namespace.line} imports ${namespace.file} as a namespace: import its functions by name`);
	}
	const serviceOf = (local: string) => {
		const from = names.get(local);
		const service = from && services.get(from.file);
		if (!from || !service) return undefined;
		return { ...from, read: service.reads.includes(from.name), write: service.writes.includes(from.name) };
	};
	if (![...names.keys()].some((local) => serviceOf(local))) return findings;

	const handlers = handlersOf(tree);
	const writeAsCallbacks = callsIn(tree, true)
		.filter((call) => calleeOf(call, tree) === 'writeAs')
		.map((call) => call.arguments[1])
		.filter(isCallback);
	const insideCallback = (node: ts.Node) => writeAsCallbacks.some((callback) => within(node, callback));
	/** The file's constants that hold a text written out: what a `says` may name. */
	const texts = new Set<string>();
	for (const statement of tree.statements) {
		if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
		for (const declared of statement.declarationList.declarations) {
			if (ts.isIdentifier(declared.name) && declared.initializer && ts.isStringLiteralLike(declared.initializer)) texts.add(declared.name.text);
		}
	}

	/**
	 * (1), the review of A1, 8: a write is handed the caller its own writeAs
	 * callback was handed, as it is or through requireUser, and nothing else.
	 * (4): its options are an object written out at the call, and a `says`
	 * among them a text written out, or a constant of the file that holds one:
	 * never words made from data.
	 */
	/** Whether a name used at `node` is declared by something nearer than the file: a scope between them declares it. */
	const declaredNearer = (node: ts.Node, name: string) => {
		for (let scope: ts.Node | undefined = node.parent; scope && !ts.isSourceFile(scope); scope = scope.parent) {
			if (declaredIn(scope).some((declared) => declared.name === name)) return true;
		}
		return false;
	};
	const judgeWriteCall = (call: ts.CallExpression, name: string) => {
		const callback = writeAsCallbacks.filter((c) => within(call, c)).sort((a, b) => b.getStart(tree) - a.getStart(tree))[0];
		const [parameter] = callback?.parameters ?? [];
		const callerName = parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
		const isCaller = (node: ts.Expression | undefined) => node !== undefined && callerName !== undefined && ts.isIdentifier(node) && node.text === callerName;
		const [first] = call.arguments;
		const handed =
			isCaller(first) || (first !== undefined && ts.isCallExpression(first) && calleeOf(first, tree) === 'requireUser' && isCaller(first.arguments[0]));
		if (!handed) {
			findings.push(`${file}:${line(call)} calls ${name} with ${first ? first.getText(tree) : 'nothing'} first, not the caller its writeAs callback is handed (1)`);
		}
		// The caller is known by its name, so the name must mean it (the re-check of A1, 1): the call
		// sits in the callback itself, with no function between them, and nothing in the callback
		// declares the name again or assigns to it.
		if (callback) {
			for (let at: ts.Node | undefined = call.parent; at && at !== callback; at = at.parent) {
				if (ts.isFunctionLike(at)) {
					findings.push(`${file}:${line(call)} calls ${name} inside a function written in its writeAs callback: call it in the callback itself (1)`);
					break;
				}
			}
			const visit = (node: ts.Node): void => {
				if (ts.isIdentifier(node) && node.text === callerName) {
					if (isDeclaredName(node) || (ts.isFunctionDeclaration(node.parent) && node.parent.name === node)) {
						findings.push(`${file}:${line(node)} declares ${callerName} again inside its writeAs callback (1)`);
					}
					const parent = node.parent;
					const assigned =
						(ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
						((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
							(parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken));
					if (assigned) findings.push(`${file}:${line(node)} assigns to ${callerName}, the caller its writeAs callback is handed (1)`);
				}
				ts.forEachChild(node, visit);
			};
			visit(callback.body);
		}
		const options = call.arguments[call.arguments.length - 1];
		if (!options || !ts.isObjectLiteralExpression(options) || options.properties.some((p) => ts.isSpreadAssignment(p))) {
			findings.push(`${file}:${line(call)} hands ${name} options that are not an object written out at the call (4)`);
			return;
		}
		for (const property of options.properties) {
			if (property.name && ts.isComputedPropertyName(property.name)) {
				findings.push(`${file}:${line(call)} hands ${name} options with a computed key (4)`);
				continue;
			}
			// The key by its name, quoted or not.
			const key = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name)) ? property.name.text : undefined;
			if (key !== 'says') continue;
			const value = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
			// A name only if it is the file's constant: nothing nearer declares it.
			const written =
				value !== undefined &&
				(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) || (ts.isIdentifier(value) && texts.has(value.text) && !declaredNearer(value, value.text)));
			if (!written) findings.push(`${file}:${line(call)} hands ${name} a says that is not a text written out (4)`);
		}
	};

	// (2): each use of a service's function: called, and where.
	const visitUses = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && usedAsName(node) && !isDeclaredName(node) && !ts.isImportSpecifier(node.parent) && !ts.isImportClause(node.parent)) {
			const service = serviceOf(node.text);
			if (service) {
				const call = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : undefined;
				const handler = handlers.find(({ fn }) => fn !== undefined && within(node, fn));
				if (!call) {
					findings.push(`${file}:${line(node)} uses ${node.text} of ${service.file} other than by calling it`);
				} else if (service.write && !insideCallback(call)) {
					findings.push(`${file}:${line(call)} calls ${node.text}, a write of ${service.file}, outside a writeAs callback (2)`);
				} else if (service.write) {
					judgeWriteCall(call, node.text);
				} else if (service.read && !insideCallback(call) && handler?.method !== 'GET') {
					findings.push(`${file}:${line(call)} calls ${node.text}, a read of ${service.file}, outside a GET and outside a writeAs callback (2)`);
				} else if (!service.read && !service.write) {
					findings.push(`${file}:${line(call)} calls ${node.text}, which ${service.file} exports as neither a read nor a write`);
				}
			}
		}
		ts.forEachChild(node, visitUses);
	};
	visitUses(tree);

	// (1): in each write handler that uses a service, every call after its body
	// to $lib/server/** inside a callback, or on OUTSIDE_WRITE.
	for (const { method, fn } of handlers) {
		if (!WRITING.includes(method) || !fn?.body) continue;
		let usesAService = false;
		const look = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && usedAsName(node) && serviceOf(node.text)) usesAService = true;
			else ts.forEachChild(node, look);
		};
		look(fn.body);
		if (!usesAService) continue;
		// Where the body has been read, as card 2253's rule has it: the end of the
		// read, or, for a handler with no body, its first writeAs. What comes
		// before is card 2115's rule's, and a quick check's.
		const read = bodyReadOf(tree, fn, givenTo(fn).isTheRequest);
		const firstWrite = callsIn(fn.body)
			.filter((call) => calleeOf(call, tree) === 'writeAs')
			.sort((a, b) => a.getStart(tree) - b.getStart(tree))[0];
		const from = read ? read.getEnd() : (firstWrite?.getStart(tree) ?? fn.body.getEnd());
		for (const call of callsIn(fn.body, true)) {
			if (call.getStart(tree) < from || insideCallback(call)) continue;
			const callee = calleeOf(call, tree);
			const root = callee.split('.')[0].split('(')[0];
			if (!names.has(root) || ['writeAs', 'stillCallerNow'].includes(root) || root in OUTSIDE_WRITE) continue;
			findings.push(`${file}:${line(call)} ${method} calls ${callee} after its body outside its writeAs callback (1)`);
		}
	}
	return [...new Set(findings)];
}

describe('one service per action, written only inside writeAs (card 2012)', () => {
	const services = new Map(SERVICES.map((file) => [file, judgeService(file, readFileSync(join(ROOT, file), 'utf8'))] as const));
	const routes = filesUnder('src/routes', (path) => /\/\+(server|page\.server|layout\.server)\.ts$/.test(path));

	it('calls nothing from $lib/server after the body outside writeAs in a handler that calls a service, and calls a service write only in a callback (1, 2)', () => {
		const findings = routes.flatMap((file) => judgeServiceCalls(file, readFileSync(join(ROOT, file), 'utf8'), services));

		// Each names the file, the line and the call. Call it inside the
		// writeAs callback and return what the answer needs.
		expect(findings).toEqual([]);
	});

	it('writes each service to the rule: READS, inWrite() first in every write, no inTransaction before it, nothing of the request (2, 3)', () => {
		expect([...services.values()].flatMap((service) => service.findings)).toEqual([]);
		// Something was read: the cards service's six writes, and A2's modules' writes and reads.
		expect(services.get('src/lib/server/cards.ts')?.writes).toEqual(['createCard', 'updateCard', 'removeCard', 'moveCard', 'moveCards', 'restoreCardFor']);
		expect(Object.fromEntries([...services].slice(1).map(([file, { reads, writes }]) => [file, { reads, writes }]))).toEqual({
			'src/lib/server/card-assignees.ts': { reads: [], writes: ['assignToCard', 'unassignFromCard'] },
			'src/lib/server/card-comments.ts': { reads: ['listComments'], writes: ['addComment', 'editComment', 'deleteComment'] },
			'src/lib/server/card-labels.ts': { reads: [], writes: ['toggleCardLabel', 'addCardLabel', 'removeCardLabel'] },
			'src/lib/server/subtasks.ts': { reads: ['listSubtasks'], writes: ['createSubtask', 'updateSubtask', 'deleteSubtask'] },
			// Slice A3: dependencies, a card's cost and the token writes, milestones.
			'src/lib/server/work-dependencies.ts': { reads: ['readWorkDependencies'], writes: ['addWorkDependency', 'removeWorkDependency'] },
			'src/lib/server/token-service.ts': { reads: ['readCardTokens'], writes: ['recordTokens', 'removeTokenEntry', 'recordTokenBatch'] },
			'src/lib/server/milestone-service.ts': {
				reads: ['readMilestone', 'readMilestoneSummary'],
				writes: ['createMilestoneFor', 'changeMilestone', 'deleteMilestoneFor', 'attachCardToMilestone', 'detachCardFromMilestone']
			},
			// Slice A4: boards, dashboard groupings, columns, card categories and labels.
			'src/lib/server/boards.ts': { reads: ['listBoardsFor'], writes: ['createBoard', 'updateBoard', 'deleteBoardFor'] },
			'src/lib/server/board-groupings.ts': { reads: [], writes: ['createBoardGrouping', 'updateBoardGrouping', 'deleteBoardGrouping'] },
			'src/lib/server/columns.ts': { reads: [], writes: ['createColumn', 'updateColumn', 'deleteColumnFor', 'reorderColumns'] },
			'src/lib/server/card-categories.ts': { reads: [], writes: ['createCardCategory', 'updateCardCategory', 'deleteCardCategory'] },
			'src/lib/server/labels.ts': { reads: ['labelsOfBoard'], writes: ['createLabel', 'updateLabel', 'deleteLabel'] },
			// Card 2337.
			'src/lib/server/card-attachments.ts': { reads: [], writes: ['attachFile', 'deleteAttachment'] }
		});
	});

	it('names on SERVICES every module under src/lib/server that imports inWrite or exports a function handed the caller, and nothing else; nothing re-exports a service or imports one with import() (4)', () => {
		const files = filesUnder('src', (path) => path.endsWith('.ts')).map((file) => ({ file, source: readFileSync(join(ROOT, file), 'utf8') }));

		expect(judgeServiceModules(files, SERVICES, NOT_SERVICES)).toEqual([]);
		// Read: the modules of src/lib/server, the routes, and the one that writes.
		expect(files.filter(({ file }) => file.startsWith('src/lib/server/')).length).toBeGreaterThanOrEqual(60);
		expect(files.some(({ file }) => file === 'src/lib/server/cards.ts')).toBe(true);
	});

	it('was looked for: the route files, the moved handlers among them, and a service that writes', () => {
		expect(routes.length).toBeGreaterThanOrEqual(120);
		expect(routes).toContain('src/routes/api/v1/cards/[cardId]/move/+server.ts');
		const callers = routes.filter((file) => /from '\$lib\/server\/cards'/.test(readFileSync(join(ROOT, file), 'utf8')));
		expect(callers).toEqual([
			'src/routes/api/boards/[id]/archive/+server.ts',
			'src/routes/api/cards/+server.ts',
			'src/routes/api/cards/[id]/+server.ts',
			'src/routes/api/cards/[id]/restore/+server.ts',
			'src/routes/api/cards/reorder/+server.ts',
			'src/routes/api/v1/boards/[boardId]/cards/+server.ts',
			'src/routes/api/v1/cards/[cardId]/+server.ts',
			'src/routes/api/v1/cards/[cardId]/move/+server.ts'
		]);
		// Slice A2: what is on a card, both trees.
		const a2 = routes.filter((file) => /from '\$lib\/server\/(card-assignees|card-comments|card-labels|subtasks)'/.test(readFileSync(join(ROOT, file), 'utf8')));
		expect(a2).toEqual([
			'src/routes/api/cards/[id]/assignees/+server.ts',
			'src/routes/api/cards/[id]/comments/+server.ts',
			'src/routes/api/cards/[id]/comments/[commentId]/+server.ts',
			'src/routes/api/labels/+server.ts',
			'src/routes/api/subtasks/+server.ts',
			'src/routes/api/subtasks/[id]/+server.ts',
			'src/routes/api/v1/cards/[cardId]/assignees/+server.ts',
			'src/routes/api/v1/cards/[cardId]/comments/+server.ts',
			'src/routes/api/v1/cards/[cardId]/labels/+server.ts',
			'src/routes/api/v1/cards/[cardId]/subtasks/+server.ts',
			'src/routes/api/v1/comments/[commentId]/+server.ts',
			'src/routes/api/v1/subtasks/[subtaskId]/+server.ts'
		]);
		// Slice A3: dependencies, a card's cost and the token writes, milestones.
		const a3 = routes.filter((file) => /from '\$lib\/server\/(work-dependencies|token-service|milestone-service)'/.test(readFileSync(join(ROOT, file), 'utf8')));
		expect(a3).toEqual([
			'src/routes/api/cards/[id]/dependencies/+server.ts',
			'src/routes/api/cards/[id]/tokens/+server.ts',
			'src/routes/api/milestones/+server.ts',
			'src/routes/api/milestones/[id]/+server.ts',
			'src/routes/api/milestones/[id]/pdf/+server.ts',
			'src/routes/api/milestones/[id]/summary/+server.ts',
			'src/routes/api/subtasks/[id]/dependencies/+server.ts',
			'src/routes/api/v1/cards/[cardId]/dependencies/+server.ts',
			'src/routes/api/v1/cards/[cardId]/tokens/+server.ts',
			'src/routes/api/v1/milestones/+server.ts',
			'src/routes/api/v1/milestones/[milestoneId]/+server.ts',
			'src/routes/api/v1/milestones/[milestoneId]/cards/+server.ts',
			'src/routes/api/v1/milestones/[milestoneId]/pdf/+server.ts',
			'src/routes/api/v1/milestones/[milestoneId]/summary/+server.ts',
			'src/routes/api/v1/subtasks/[subtaskId]/dependencies/+server.ts',
			'src/routes/api/v1/subtasks/[subtaskId]/tokens/+server.ts',
			'src/routes/api/v1/tokens/[entryId]/+server.ts',
			'src/routes/api/v1/tokens/bulk/+server.ts'
		]);
		// Slice A4: boards, dashboard groupings, columns, card categories and labels.
		const a4 = routes.filter((file) => /from '\$lib\/server\/(boards|board-groupings|columns|card-categories|labels)'/.test(readFileSync(join(ROOT, file), 'utf8')));
		expect(a4).toEqual([
			'src/routes/api/board-categories/+server.ts',
			'src/routes/api/board-categories/[id]/+server.ts',
			'src/routes/api/boards/+server.ts',
			'src/routes/api/boards/[id]/+server.ts',
			'src/routes/api/categories/+server.ts',
			'src/routes/api/categories/[id]/+server.ts',
			'src/routes/api/columns/+server.ts',
			'src/routes/api/columns/[id]/+server.ts',
			'src/routes/api/columns/reorder/+server.ts',
			'src/routes/api/labels/+server.ts',
			'src/routes/api/v1/board-categories/+server.ts',
			'src/routes/api/v1/board-categories/[categoryId]/+server.ts',
			'src/routes/api/v1/boards/+server.ts',
			'src/routes/api/v1/boards/[boardId]/+server.ts',
			'src/routes/api/v1/boards/[boardId]/categories/+server.ts',
			'src/routes/api/v1/boards/[boardId]/columns/+server.ts',
			'src/routes/api/v1/boards/[boardId]/labels/+server.ts',
			'src/routes/api/v1/categories/[categoryId]/+server.ts',
			'src/routes/api/v1/columns/[columnId]/+server.ts',
			'src/routes/api/v1/labels/[labelId]/+server.ts'
		]);
	});

	describe('the rule itself (5)', () => {
		const SERVICE = new Map([['src/lib/server/things.ts', { reads: ['listThings'], writes: ['makeThing'] }]]);
		const calls = (code: string) => judgeServiceCalls('src/routes/api/example/+server.ts', code, SERVICE);
		const head = [
			"import { json } from '$lib/server/v1-json';",
			"import { linkBaseUrl } from '$lib/server/email';",
			"import { pathId, readBody } from '$lib/server/request-body';",
			"import { listThings, makeThing } from '$lib/server/things';",
			"import { shape } from '$lib/server/shapes';",
			"import { writeAs } from '$lib/server/write-as';"
		];

		it('finds a service write called after the body outside its callback, by file, line and callee, and lets OUTSIDE_WRITE through', () => {
			const code = [
				...head,
				'export const POST = async ({ params, request, locals, url }) => {',
				'\tconst id = pathId(params.id, "thing");',
				'\tconst body = await readBody(request);',
				'\tconst baseUrl = linkBaseUrl(url);',
				'\twriteAs(locals, (caller) => caller);',
				'\tconst made = makeThing(null, id, body, { baseUrl });',
				'\treturn json(shape(made));',
				'};'
			].join('\n');

			expect(calls(code)).toEqual([
				'src/routes/api/example/+server.ts:12 calls makeThing, a write of src/lib/server/things.ts, outside a writeAs callback (2)',
				'src/routes/api/example/+server.ts:12 POST calls makeThing after its body outside its writeAs callback (1)',
				'src/routes/api/example/+server.ts:13 POST calls shape after its body outside its writeAs callback (1)'
			]);
		});

		it('passes a handler whose service call and answer shaping are inside the callback, and a read in a GET', () => {
			const code = [
				...head,
				'export const POST = async ({ params, request, locals, url }) => {',
				'\tconst id = pathId(params.id, "thing");',
				'\tconst body = await readBody(request);',
				'\tconst baseUrl = linkBaseUrl(url);',
				'\tconst made = writeAs(locals, (caller) => shape(makeThing(caller, id, body, { baseUrl })));',
				'\treturn json(made);',
				'};',
				'export const GET = async ({ locals }) => json(listThings(locals.user));'
			].join('\n');

			expect(calls(code)).toEqual([]);
		});

		it('finds a read outside a GET and its callback, a service passed on uncalled, and a service imported as a namespace', () => {
			const code = [
				...head,
				"import * as things from '$lib/server/things';",
				'export const DELETE = async ({ locals }) => {',
				'\tconst all = listThings(locals.user);',
				'\twriteAs(locals, (caller) => [caller].map(makeThing));',
				'};'
			].join('\n');

			expect(calls(code)).toEqual([
				'src/routes/api/example/+server.ts:7 imports src/lib/server/things.ts as a namespace: import its functions by name',
				'src/routes/api/example/+server.ts:9 calls listThings, a read of src/lib/server/things.ts, outside a GET and outside a writeAs callback (2)',
				// Before the first writeAs of a handler with no body: (2)'s, not (1)'s.
				'src/routes/api/example/+server.ts:10 uses makeThing of src/lib/server/things.ts other than by calling it'
			]);
		});

		it('leaves a handler that calls no service to card 2253\'s rule', () => {
			const code = [...head, 'export const PUT = async ({ request, locals }) => {', '\tconst body = await readBody(request);', '\treturn json(shape(body));', '};'].join('\n');

			expect(calls(code)).toEqual([]);
		});

		const service = (code: string) => judgeService('src/lib/server/things.ts', code).findings;
		const WRITE_AS = "import { inWrite } from './write-as';\nimport { inTransaction } from './db/transaction';\n";

		it('passes a service written to the rule', () => {
			const code = [
				WRITE_AS + "export const READS = ['listThings'] as const;",
				'export function listThings(user) { return []; }',
				'export function makeThing(caller, id) {',
				'\tinWrite();',
				'\treturn inTransaction(() => id);',
				'}'
			].join('\n');

			expect(service(code)).toEqual([]);
		});

		it('finds a write without inWrite() first, one that opens its own transaction first, a read on no list, and the request named', () => {
			const code = [
				WRITE_AS + "import { getRequestEvent } from '$app/server';",
				'export function listThings(user) { return []; }',
				'export function makeThing(caller, id) {',
				'\treturn inTransaction(() => { inWrite(); return id; });',
				'}',
				'export const dropThing = (caller, locals: App.Locals) => inWrite();'
			].join('\n');

			expect(service(code)).toEqual([
				'src/lib/server/things.ts has no READS export naming its read functions',
				'src/lib/server/things.ts:3 imports $app/server (3)',
				'src/lib/server/things.ts:4 listThings is a write (it is not on READS) and its first statement is not inWrite() (2)',
				'src/lib/server/things.ts:5 makeThing is a write (it is not on READS) and its first statement is not inWrite() (2)',
				'src/lib/server/things.ts:8 dropThing is a write (it is not on READS) and its first statement is not inWrite() (2)',
				'src/lib/server/things.ts:3 names getRequestEvent (3)',
				'src/lib/server/things.ts:6 names inTransaction other than in a write after its inWrite() (3)',
				'src/lib/server/things.ts:8 names locals (3)',
				'src/lib/server/things.ts:8 names App.Locals (3)'
			]);
		});

		it('finds a write exported by name, a default export, an exported value that is not a function written here, and a re-export (the review, 1)', () => {
			const code = [
				WRITE_AS + 'export const READS = [] as const;',
				'function f(caller) { return caller; }',
				'export { f };',
				'export default function (caller) { inWrite(); }',
				'export const w = once((caller) => caller);',
				"export * from './elsewhere';",
				"export { g } from './elsewhere';",
				'export type Shape = { id: number };'
			].join('\n');

			expect(service(code)).toEqual([
				'src/lib/server/things.ts:5 f is a write (it is not on READS) and its first statement is not inWrite() (2)',
				'src/lib/server/things.ts:6 has a default export: a service exports its functions by name (2)',
				'src/lib/server/things.ts:7 exports w, which is not a function written here: a service exports its functions and READS alone (2)',
				'src/lib/server/things.ts:8 re-exports from ./elsewhere: a service exports only what it writes here (2)',
				'src/lib/server/things.ts:9 re-exports from ./elsewhere: a service exports only what it writes here (2)'
			]);
		});

		it('finds inTransaction under another name, and a read that writes (the review, 3)', () => {
			const code = [
				"import { inWrite } from './write-as';",
				"import { inTransaction as tx } from './db/transaction';",
				"import * as t from './db/transaction';",
				"export const READS = ['listThings'];",
				'export function listThings(user) { db.insert(things).values({}).run(); return tx(() => 1); }',
				'export function makeThing(caller) {',
				'\ttx(() => 1);',
				'\tinWrite();',
				'}',
				'export function dropThing(caller) { inWrite(); return t.inTransaction(() => 1); }',
				'export function keepThing(caller) { t.inTransaction(() => 1); }'
			].join('\n');

			expect(service(code)).toEqual([
				'src/lib/server/things.ts:6 makeThing is a write (it is not on READS) and its first statement is not inWrite() (2)',
				'src/lib/server/things.ts:11 keepThing is a write (it is not on READS) and its first statement is not inWrite() (2)',
				'src/lib/server/things.ts:5 listThings is on READS and writes: db.insert(things).values({}).run (3)',
				'src/lib/server/things.ts:5 listThings is on READS and writes: tx (3)',
				'src/lib/server/things.ts:5 names inTransaction (as tx) other than in a write after its inWrite() (3)',
				'src/lib/server/things.ts:7 names inTransaction (as tx) other than in a write after its inWrite() (3)',
				'src/lib/server/things.ts:11 names inTransaction (as t.inTransaction) other than in a write after its inWrite() (3)'
			]);
		});

		it('finds a service called with anything but its callback\'s caller first, and options or says not written out at the call (the review, 4 and 8)', () => {
			const code = [
				...head,
				'const WORDS = "Not yours";',
				'export const PUT = async ({ request, locals }) => {',
				'\tconst body = await readBody(request);',
				'\tconst made = writeAs(locals, () => makeThing(locals.user, 1, body, { says: WORDS }));',
				'\twriteAs(locals, (caller) => makeThing(requireUser(caller), 1, body, { says: `Not ${body.who}` }));',
				'\twriteAs(locals, (caller) => makeThing(caller, 1, body, opts));',
				'\twriteAs(locals, (caller) => makeThing(caller, 1, body, { ...opts }));',
				'\treturn json(made);',
				'};'
			].join('\n');

			expect(calls(code)).toEqual([
				'src/routes/api/example/+server.ts:10 calls makeThing with locals.user first, not the caller its writeAs callback is handed (1)',
				'src/routes/api/example/+server.ts:11 hands makeThing a says that is not a text written out (4)',
				'src/routes/api/example/+server.ts:12 hands makeThing options that are not an object written out at the call (4)',
				'src/routes/api/example/+server.ts:13 hands makeThing options that are not an object written out at the call (4)'
			]);
		});

		it('finds a service write called inside a function in its callback, the caller declared again inside it, or assigned to (the re-check, 1)', () => {
			const code = [
				...head,
				'export const PUT = async ({ request, locals }) => {',
				'\tconst body = await readBody(request);',
				'\twriteAs(locals, (caller) => { const run = (caller) => makeThing(caller, 1, body, {}); return run(getUser(7)); });',
				'\twriteAs(locals, (caller) => [caller].map((caller) => makeThing(caller, 1, body, {})));',
				'\twriteAs(locals, (caller) => { { const caller = getUser(7); makeThing(caller, 1, body, {}); } });',
				'\twriteAs(locals, (caller) => { caller = getUser(7); return makeThing(caller, 1, body, {}); });',
				'\twriteAs(locals, (caller) => makeThing(caller, 1, body, {}));',
				'\treturn json({});',
				'};'
			].join('\n');

			expect(calls(code)).toEqual([
				'src/routes/api/example/+server.ts:9 calls makeThing inside a function written in its writeAs callback: call it in the callback itself (1)',
				'src/routes/api/example/+server.ts:9 declares caller again inside its writeAs callback (1)',
				'src/routes/api/example/+server.ts:10 calls makeThing inside a function written in its writeAs callback: call it in the callback itself (1)',
				'src/routes/api/example/+server.ts:10 declares caller again inside its writeAs callback (1)',
				'src/routes/api/example/+server.ts:11 declares caller again inside its writeAs callback (1)',
				'src/routes/api/example/+server.ts:12 assigns to caller, the caller its writeAs callback is handed (1)'
			]);
		});

		it("finds says under a quoted key, a computed key, and a name a callback declares over the file's constant (the re-check, 2)", () => {
			const code = [
				...head,
				'const NO = "Not yours";',
				'export const PUT = async ({ request, locals }) => {',
				'\tconst body = await readBody(request);',
				"\twriteAs(locals, (caller) => makeThing(caller, 1, body, { 'says': body.t }));",
				"\twriteAs(locals, (caller) => makeThing(caller, 1, body, { ['says']: NO }));",
				'\twriteAs(locals, (caller) => { const NO = String(body.t); return makeThing(caller, 1, body, { says: NO }); });',
				'\twriteAs(locals, (caller) => makeThing(caller, 1, body, { says: NO }));',
				'\treturn json({});',
				'};'
			].join('\n');

			expect(calls(code)).toEqual([
				'src/routes/api/example/+server.ts:10 hands makeThing a says that is not a text written out (4)',
				'src/routes/api/example/+server.ts:11 hands makeThing options with a computed key (4)',
				'src/routes/api/example/+server.ts:12 hands makeThing a says that is not a text written out (4)'
			]);
		});

		it('finds inWrite through a namespace, the caller under a type alias, a service re-exported by name or as a value, and a computed import() in src/lib/server (the re-check, 3 and 4)', () => {
			const files = [
				{ file: 'src/lib/server/i.ts', source: "import * as w from './write-as';\nexport function act(x: number) { w.inWrite(); }" },
				{ file: 'src/lib/server/j.ts', source: "import type { SessionUser } from './auth';\ntype Caller = SessionUser | null;\nexport function f(caller: Caller) {}" },
				{ file: 'src/lib/server/k.ts', source: "import type { SessionUser as Account } from './auth';\nexport function g(user: Account | null) {}" },
				{ file: 'src/lib/server/l.ts', source: "import type { SessionUser as Account } from './auth';\ntype Who = Account | null | undefined;\nexport function h(caller: Who) {}" },
				{ file: 'src/lib/server/m.ts', source: "import { createCard } from './cards';\nexport { createCard };" },
				{ file: 'src/lib/server/n.ts', source: "import { createCard } from '$lib/server/cards';\nexport const make = createCard;" },
				{ file: 'src/lib/server/o.ts', source: 'export async function load(name: string) { return import(name); }' },
				{ file: 'src/lib/server/cards.ts', source: "import { inWrite } from './write-as';\nexport function createCard(caller: SessionUser | null) { inWrite(); }" }
			];

			expect(judgeServiceModules(files, ['src/lib/server/cards.ts'])).toEqual([
				'src/lib/server/i.ts must be on SERVICES: it imports inWrite (4)',
				'src/lib/server/j.ts must be on SERVICES: it exports f, whose first parameter is the caller (4)',
				'src/lib/server/k.ts must be on SERVICES: it exports g, whose first parameter is the caller (4)',
				'src/lib/server/l.ts must be on SERVICES: it exports h, whose first parameter is the caller (4)',
				'src/lib/server/m.ts:2 re-exports src/lib/server/cards.ts, a service: import its functions by name where they are called',
				'src/lib/server/n.ts:2 re-exports src/lib/server/cards.ts, a service: import its functions by name where they are called',
				'src/lib/server/o.ts:1 calls import() with a module that is not written out'
			]);
		});

		it('finds a read that execs or prepares a statement, itself or through a function of its module (the re-check, 5)', () => {
			const code = [
				"import { inWrite } from './write-as';",
				"export const READS = ['listThings', 'countThings'];",
				'function stamp() { sqlite.exec("UPDATE things SET n = 1"); }',
				'export function listThings(user) { stamp(); return sqlite.prepare("SELECT 1").all(); }',
				'export function countThings(user) { return 0; }'
			].join('\n');

			expect(service(code)).toEqual([
				'src/lib/server/things.ts:3 listThings is on READS and writes: sqlite.exec (through stamp) (3)',
				'src/lib/server/things.ts:4 listThings is on READS and writes: sqlite.prepare (3)'
			]);
		});

		it('puts on SERVICES every module that imports inWrite or exports, in any form, a function handed the caller; and bans re-exporting or import() of one (the review, 1)', () => {
			const SESSION = "import type { SessionUser } from './auth';\n";
			const files = [
				{ file: 'src/lib/server/a.ts', source: SESSION + 'function f(caller: SessionUser | null) {}\nexport { f };' },
				{ file: 'src/lib/server/b.ts', source: SESSION + 'export default function (caller: SessionUser | null) {}' },
				{ file: 'src/lib/server/c.ts', source: SESSION + 'export const w = once((caller: SessionUser | null) => caller);' },
				{ file: 'src/lib/server/d.ts', source: SESSION + 'export function act(user: SessionUser | null, id: number) {}' },
				{ file: 'src/lib/server/e.ts', source: "import { inWrite } from './write-as';\nexport function act(user: SessionUser) { inWrite(); }" },
				{
					file: 'src/lib/server/f.ts',
					source:
						SESSION +
						'export function helper(user: SessionUser, id: number) {}\nexport function guard(user: SessionUser | null | undefined) {}\nexport function connect(caller: ConnectCaller) {}'
				},
				{ file: 'src/lib/server/g.ts', source: "export * from './cards';" },
				{ file: 'src/lib/server/h.ts', source: "export { createCard as make } from '$lib/server/cards';" },
				{ file: 'src/routes/api/x/+server.ts', source: "export const POST = async () => { const { createCard } = await import('$lib/server/cards'); await import(name); };" },
				{ file: 'src/lib/server/cards.ts', source: "import { inWrite } from './write-as';\nexport function createCard(caller: SessionUser | null) { inWrite(); }" },
				{ file: 'src/lib/server/old.ts', source: 'export function x() {}' }
			];

			expect(judgeServiceModules(files, ['src/lib/server/cards.ts', 'src/lib/server/old.ts'])).toEqual([
				'src/lib/server/a.ts must be on SERVICES: it exports f, whose first parameter is the caller (4)',
				'src/lib/server/b.ts must be on SERVICES: it exports default, whose first parameter is the caller (4)',
				'src/lib/server/c.ts must be on SERVICES: it exports w, whose first parameter is the caller (4)',
				'src/lib/server/d.ts must be on SERVICES: it exports act, whose first parameter is the caller (4)',
				'src/lib/server/e.ts must be on SERVICES: it imports inWrite (4)',
				'src/lib/server/g.ts:1 re-exports src/lib/server/cards.ts, a service: import its functions by name where they are called',
				'src/lib/server/h.ts:1 re-exports src/lib/server/cards.ts, a service: import its functions by name where they are called',
				'src/routes/api/x/+server.ts:1 imports src/lib/server/cards.ts, a service, with import(): import its functions by name',
				'src/routes/api/x/+server.ts:1 calls import() with a module that is not written out',
				'src/lib/server/old.ts is on SERVICES and is no service: it imports no inWrite and exports no function handed the caller (4)'
			]);
			// NOT_SERVICES excuses a guard handed the caller, never a module that imports inWrite, and an entry that excuses nothing fails.
			const [, , , d, e, f] = files;
			expect(judgeServiceModules([d, e, f], [], { [d.file]: 'a guard', [e.file]: 'no', [f.file]: 'nothing to excuse' })).toEqual([
				'src/lib/server/e.ts must be on SERVICES: it imports inWrite (4)',
				'NOT_SERVICES names src/lib/server/e.ts, which no longer exports a function handed the caller (or imports inWrite) (4)',
				'NOT_SERVICES names src/lib/server/f.ts, which no longer exports a function handed the caller (or imports inWrite) (4)'
			]);
		});

		it('finds an inWrite that is not write-as\'s, and a name on READS that is no function', () => {
			const code = [
				"import { inWrite } from './elsewhere';",
				"export const READS = ['nothing'];",
				'export function makeThing(caller) {',
				'\tinWrite();',
				'}'
			].join('\n');

			expect(service(code)).toEqual([
				'src/lib/server/things.ts:3 makeThing is a write (it is not on READS) and its first statement is not inWrite() (2)',
				'src/lib/server/things.ts names nothing on READS, and exports no such function (2)'
			]);
		});
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
