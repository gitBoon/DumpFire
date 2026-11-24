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
import { db, sqlite } from '$lib/server/db';
import { restorableTables } from '$lib/server/db/restore';
import { OUTBOUND_READS } from '$lib/server/outbound-changes';
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
	forgetFirstRunFlags,
	resetDb,
	type BoardFixture
} from './helpers/fixtures';
import { watchReads } from './helpers/reads';
import { DECISION_SERVICE, handlersOf as exportedHandlers, SERVICE_HELPERS, SERVICES, type HandlerFunction } from './helpers/source-scan';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

beforeEach(resetDb);
// Each first-run pass in full, as before migration 0084 seeded their flags (card 3064, R23).
beforeEach(() => forgetFirstRunFlags());

// ─── The rule, read from the source ─────────────────────────────────────────

const ROOT = process.cwd();

/** The methods a route exports that answer a request. */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * What may be called before the body is read: what reads no row. A refusal,
 * the id in the path, the session the gate has already read, and that
 * session's hash in the credential the gate recorded (`sessionHashIn`, card
 * 2775), which the routes that ask for a password count wrong ones against.
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
	'sessionHashIn',
	// Card 2677, decision 24: same-origin JSON only, from the request's headers and its address alone.
	'requireSameOriginJson'
];

/** The request's own methods that read its body. */
const READER_METHODS = ['json', 'formData', 'arrayBuffer', 'text', 'blob', 'bytes'];

/**
 * The functions known to read the body when they are given the request. Any
 * other function given the request is taken for a read and fails, by name, so
 * that a new helper cannot read the body unseen.
 */
const BODY_READERS = [
	'readBody',
	// Card 2910's code review (CS2): an upload's read, given its deadline; the read it is handed is the request's own.
	'readBodyWithin',
	// Card 2687's code review (C-S-L1, C-S-L2): a body that may be left out, read with readBody when it is sent as JSON;
	// it looks at the request's headers alone first, and reads no row.
	'readOptionalBody'
];

/**
 * The handlers that ask something else before their body, by file and method,
 * with why. An entry that no longer matches a handler that does fails, so the
 * list can only shrink.
 */
const ALLOWED: Record<string, string> = {
	'src/routes/api/cards/[id]/attachments/+server.ts POST':
		'The upload asks before it reads 25 MB, so that a caller with no access is not sent it, and asks again with the row inside ' +
		'the transaction that attaches it (docs/authentication-security.md, "An upload is the one request that checks twice"); ' +
		'and, for every file, takes a place in flight and counts the upload against the account\'s hour in memory before the form ' +
		'is read (takeUploadPlace and takeUploadCount, 429 answered by tooMany, card 2910), so that a caller who would be refused ' +
		'is not sent the form. The place and the count read no row.',
	'src/routes/api/v1/cards/[cardId]/attachments/+server.ts POST':
		"A key's image upload (card 2754), the card window's upload's twin: it asks for the card and edit access before it reads " +
		'5 MB, as the card window does, and again with the row inside the transaction that attaches it; it reads the declared type ' +
		'from the request\'s header (415, imageTypeOf), takes a place in flight (takeUploadPlace, card 2910) and counts the upload ' +
		'against the key\'s user\'s hour in memory (takeUploadCount, 429 answered by tooMany), so that a caller who would be refused ' +
		'is not sent the body. The type, the place and the count read no row.',
	'src/routes/api/requests/+server.ts POST':
		'The public request form: the form token and the rate limits are asked before the body. They read no row.',
	'src/routes/api/requests/[id]/confirm/+server.ts POST':
		'The confirmation link: the rate limit is asked before the body. It reads no row.',
	'src/routes/api/requests/[id]/link/+server.ts POST':
		'The new link a requester asks for (card 2158): the rate limit per address is asked before the body, so that every ask ' +
		'is counted. It reads no row.',
	'src/routes/api/decision-by-link/responses/+server.ts POST':
		"A personal link's response (card 2677, decision 8): the address a wrong link is counted against is read before the " +
		'body, from the request alone. It reads no row and counts nothing.',
	'src/routes/api/decision-by-link/seen/+server.ts POST':
		"A personal link's seen (card 2677, decision 8): the address a wrong link is counted against is read before the body, " +
		'from the request alone. It reads no row and counts nothing.',
	'src/routes/api/decision-by-link/concerns/+server.ts POST':
		"A personal link's concern about the ruling (card 2679, decision 4): the address a wrong link is counted against is read " +
		'before the body, from the request alone. It reads no row and counts nothing.',
	'src/routes/api/decision-by-link/questions/+server.ts POST':
		"A personal link's clarification question (card 2678, decision 17): the address a wrong link is counted against is read " +
		'before the body, from the request alone. It reads no row and counts nothing.',
	'src/routes/api/decision-by-link/flags/+server.ts POST':
		"A personal link's objection or request to talk (card 2684, R3): the address a wrong link is counted against is read " +
		'before the body, from the request alone. It reads no row and counts nothing.',
	'src/routes/api/admin/import/+server.ts POST':
		'The import settles `outside` and the media type before it reads the upload, and answers either before any of it is read. ' +
		'Who may import is requireSuperadmin, the session. Then it takes the confirmation of the password (card 2701, decision 8), ' +
		'from the header string and the session cookie, never the request, before the upload: takeImportConfirmation reads no row.'
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

/**
 * The function each exported handler of `METHODS` is (`handlersOf` in
 * ./helpers/source-scan.ts, shared with tests/gate.test.ts): one that is not a
 * function written here has no function (`fn` undefined), and is reported as
 * one this test cannot read.
 */
function handlersOf(tree: ts.SourceFile): { method: string; fn: HandlerFunction | undefined; at: ts.Node }[] {
	return exportedHandlers(tree, METHODS);
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
 *     nor handed to anything but `writeAs` and `stillCallerNow`, and
 *     `confirmStepUp` (card 2701), whose guard is read as a writeAs callback;
 *   - (a) no `inTransaction` in a route file, imported or called;
 *   - (b) `stillCallerNow` only in the handlers on STILL_CALLER_NOW, and each
 *     of them calls it, right after its body, or after its `confirmStepUp`
 *     where it asks for the password again (card 2701);
 *   - (c) nothing awaited between each `stillCallerNow` and the call it
 *     guards;
 *   - (d) the routes that ask for a current password (CURRENT_PASSWORD)
 *     check inside `whilePasswordHolds`'s write: everything that write does
 *     is inside its `writeAs`.
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
	// The VACUUM and the checkpoint after it that empties the write-ahead log (card 2898, S6), in one call.
	'src/routes/api/admin/vacuum/+server.ts POST': { reason: 'VACUUM cannot run in a transaction.', guards: [/^vacuumAndScrub$/] },
	'src/routes/api/admin/import/+server.ts POST': {
		reason:
			'The restore opens its own transaction, and files are written before it: the first is .restore-temp.db. ' +
			'No writeAs after the restore: the database it would ask is no longer the one the caller was let in by. ' +
			'Both files are written through writeImportFile (card 2925).',
		guards: [/^writeImportFile$/]
	},
	'src/routes/api/reports/+server.ts POST': {
		reason: 'It only reads, after a body, and builds a PDF with an await.',
		guards: [/^generate\w*Report$/]
	},
	'src/routes/api/reports/email/+server.ts POST': {
		reason:
			'Mail leaves the process, after a PDF built with an await: checked after the password, and again before every send ' +
			'(card 2751, S5), with the password held unchanged there too.',
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
	},
	// Card 2701, decision 17: a POST since it asks for the password, a GET before.
	'src/routes/api/admin/export/+server.ts POST': {
		reason: 'VACUUM INTO cannot run in a transaction, and the copy leaves the process: checked after the password, before the copy.',
		guards: [/^generateBackupData$/]
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

/**
 * And, by handler, a guard that reads a row and is asked before the body there too, with why. `binds` names a guard
 * of them that answers something the handler keeps, and the one name it may bind it to, as a const, from
 * `locals.user` alone (card 2910): what it answers decides nothing about the caller, and the name is not followed as
 * one bound from `locals.user`.
 */
const QUICK_CHECKS_IN: Record<string, { guards: string[]; binds?: Record<string, string>; reason: string }> = {
	'src/routes/api/cards/[id]/attachments/+server.ts POST': {
		guards: ['requireCard', 'takeUploadPlace', 'takeUploadCount'],
		binds: { takeUploadPlace: 'release' },
		reason:
			'The upload asks before it reads 25 MB, so that a caller with no access is not sent it (card 2115\'s ALLOWED), ' +
			'and asks again with caller inside the writeAs that attaches it (decision 7). Before the body too (card 2910): it ' +
			'takes a place in flight for the account the gate read and counts the upload against its hour, in memory, so that ' +
			'a caller who would be refused is not sent the form. takeUploadPlace binds `release`, which gives back the places ' +
			'it took, in the finally of the try that opens after it, and reads no row; takeUploadCount binds no name.'
	},
	'src/routes/api/v1/cards/[cardId]/attachments/+server.ts POST': {
		guards: ['requireCard', 'takeUploadPlace', 'takeUploadCount'],
		binds: { takeUploadPlace: 'release' },
		reason:
			"A key's image upload (card 2754) asks for the card before it reads 5 MB, as the card window's upload does, and asks " +
			'again with caller inside the writeAs that attaches it; and takes a place in flight (card 2910) and counts the ' +
			"upload against the hour of the account the gate read, before the body (the review's S2): an account whose key is " +
			'revoked meanwhile is refused at the write, and its count stays taken, as any refusal after it leaves it. ' +
			'takeUploadPlace binds `release`, which gives back the places it took, in the finally of the try that opens after ' +
			'it, and reads no row; the others bind no name.'
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
const USER_FIELDS_IN: Record<string, { of: string[]; reason: string; in?: string[] }> = {
	'src/routes/api/admin/smtp/+server.ts PUT': {
		of: ['existing', 'config'],
		reason: "`user` there is the mail server's user name (SmtpConfig.user): the stored one kept, and the one sent saved.",
		// Card 2701: the save's reads, one function asked by the step-up's guard
		// and again inside the write's writeAs.
		in: ['readSave']
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
	'src/routes/api/account/api-keys/+server.ts POST',
	// Card 2772 (D5): Keep this key.
	'src/routes/api/account/api-keys/[id]/keep/+server.ts POST',
	// Card 2772 (D1-D3, D6): the two-step section's step-ups, and That was me.
	'src/routes/api/account/two-step/authenticators/+server.ts POST',
	'src/routes/api/account/two-step/authenticators/[id]/+server.ts DELETE',
	'src/routes/api/account/two-step/recovery-codes/+server.ts POST',
	'src/routes/api/account/two-step/banner/+server.ts DELETE',
	// Card 3064 (R8, R10): setting up two-step sign-in while it is dormant, and requiring it.
	'src/routes/api/account/two-step/set-up/+server.ts POST',
	'src/routes/api/admin/two-step/require/+server.ts POST',
	// Card 2701, slice 1: the admin actions that ask for it again (confirmStepUp).
	'src/routes/api/admin/reset/+server.ts POST',
	'src/routes/api/admin/purge-archived/+server.ts POST',
	'src/routes/api/admin/boards/[id]/clear-cards/+server.ts POST',
	'src/routes/api/admin/boards/[id]/clear-categories/+server.ts POST',
	'src/routes/api/admin/reset-xp/+server.ts POST',
	// Slice 2a: the account routes.
	'src/routes/api/users/+server.ts POST',
	'src/routes/api/users/[id]/+server.ts PUT',
	'src/routes/api/users/[id]/+server.ts DELETE',
	'src/routes/api/users/[id]/password/+server.ts PUT',
	'src/routes/api/users/[id]/invite/+server.ts POST',
	// Card 2773: another account's two-step sign-in reset.
	'src/routes/api/users/[id]/mfa/reset/+server.ts POST',
	// Card 2671: an account disabled, and enabled again.
	'src/routes/api/users/[id]/disable/+server.ts POST',
	'src/routes/api/users/[id]/enable/+server.ts POST',
	// Slice 2b: the board and column deletes.
	'src/routes/api/boards/[id]/+server.ts DELETE',
	'src/routes/api/columns/[id]/+server.ts DELETE',
	// Slice 2c: the saves that send the database or the mail elsewhere.
	'src/routes/api/admin/backup/+server.ts PUT',
	'src/routes/api/admin/backup/gdrive/auth/+server.ts POST',
	'src/routes/api/admin/smtp/+server.ts PUT',
	// Card 2922: a setting held for review kept or removed, the superadmin's alone.
	'src/routes/api/admin/settings/held/+server.ts POST',
	// Card 3020 (R4, R5): a request's held requester mail released, by an administrator.
	'src/routes/api/requests/held/+server.ts POST',
	// Card 2697, B2b (Q31): the administrator's participant actions, and a person's address or account.
	'src/routes/api/decisions/[id]/participants/[participantId]/account/+server.ts PUT',
	'src/routes/api/decisions/[id]/participants/[participantId]/address/+server.ts PUT',
	'src/routes/api/people/[id]/+server.ts PUT',
	// Card 2697's code review, part B (S1): the add, the delete and Add from accounts of the people directory.
	'src/routes/api/people/+server.ts POST',
	'src/routes/api/people/[id]/+server.ts DELETE',
	'src/routes/api/people/from-accounts/+server.ts POST',
	// Card 2697, B4 (Q31): the delete and the withdrawal of a decision that was ever opened.
	'src/routes/api/decisions/[id]/+server.ts DELETE',
	'src/routes/api/decisions/[id]/withdraw/+server.ts POST',
	// Card 2679 (decision 2): the ruling and the release of its results.
	'src/routes/api/decisions/[id]/rule/+server.ts POST',
	'src/routes/api/decisions/[id]/release/+server.ts POST',
	// Card 2751 (D8): a report schedule made, and a change that adds an address, turns one on or widens its filter.
	'src/routes/api/report-schedules/+server.ts POST',
	'src/routes/api/report-schedules/[id]/+server.ts PUT'
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
	// whilePasswordHolds(userId, checkedHash, write): the write is its third (card 2701's code review, S2).
	const holdsWrite = holds && isCallback(holds.arguments[2]) ? holds.arguments[2] : undefined;
	const writeAsCalls = [...ownCalls, ...(holdsWrite ? callsIn(holdsWrite.body) : [])].filter((call) => named(call, 'writeAs'));
	// confirmStepUp(locals, …, guard) (card 2701) runs its guard inside a
	// writeAs of its own, read only: the guard is read as a writeAs callback,
	// and the locals are handed to it, as to writeAs, in the open.
	const stepUps = ownCalls.filter((call) => named(call, 'confirmStepUp'));
	const callbacks = [...writeAsCalls.map((call) => call.arguments[1]), ...stepUps.map((call) => call.arguments[4])].filter(isCallback);
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
	/**
	 * The `locals.user` of `const <name> = <guard>(locals.user)` before the body, where QUICK_CHECKS_IN's `binds`
	 * lets that guard bind that name (card 2910): a quick check, and the name is not one bound from locals.user.
	 */
	const binds = QUICK_CHECKS_IN[key]?.binds ?? {};
	const quickBinding = (declaration: ts.VariableDeclaration): ts.Node | undefined => {
		const value = declaration.initializer && bare(declaration.initializer);
		if (!value || !ts.isCallExpression(value) || !ts.isIdentifier(declaration.name)) return undefined;
		if ((declaration.parent.flags & ts.NodeFlags.Const) === 0 || declaration.getStart(tree) >= boundary) return undefined;
		const [argument, ...rest] = value.arguments;
		const guard = calleeOf(value, tree);
		// Only a guard the handler's entry lists (the code review): `binds` names no call it does not also allow.
		if (!quickChecks.includes(guard) || binds[guard] !== declaration.name.text) return undefined;
		if (rest.length > 0 || !argument || !isLocalsUser(argument)) return undefined;
		return argument;
	};
	const boundQuickly = new Set(declarations.flatMap((declaration) => quickBinding(declaration) ?? []));
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
			if (bindings.has(declaration) || forALine(declaration) || quickBinding(declaration)) continue;
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

	// The step-up's calls (card 2701): given the locals, after the body, and a
	// guard that is a quick check by name or a function this test can read,
	// held to what a writeAs callback is held to.
	for (const call of stepUps) {
		if (!givenLocals(call)) findings.push(`${at} calls confirmStepUp at line ${line(call)} with something other than the locals it is given`);
		if (read && call.getStart(tree) < read.getEnd()) findings.push(`${at} calls confirmStepUp at line ${line(call)} before it reads its body`);
		const guard = call.arguments[4];
		if (guard !== undefined && ts.isIdentifier(guard) && QUICK_CHECKS.includes(guard.text)) continue;
		if (!isCallback(guard)) {
			findings.push(`${at} gives confirmStepUp at line ${line(call)} a guard this test cannot read`);
			continue;
		}
		const [parameter] = guard.parameters;
		const own = parameter ? boundNames(parameter.name) : [];
		const usesIt = own.some((name) => {
			let used = false;
			const visit = (node: ts.Node): void => {
				if (used) return;
				if (ts.isIdentifier(node) && node.text === name && usedAsName(node) && !isDeclaredName(node)) used = true;
				else ts.forEachChild(node, visit);
			};
			visit(guard.body);
			return used;
		});
		if (!usesIt) findings.push(`${at} gives confirmStepUp at line ${line(call)} a guard that never uses its caller${DECIDE}`);
		if (ts.getModifiers(guard)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
			findings.push(`${at} gives confirmStepUp at line ${line(call)} an async guard`);
		}
		for (const escape of escapesOf(guard, tree)) findings.push(`${at} lets its confirmStepUp guard's caller out at line ${escape.line}: ${escape.how}`);
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

	// A function of the handler's own that USER_FIELDS_IN names (card 2701), read
	// as a writeAs callback for its fields named `user`: an arrow or function
	// declared as a const, used nowhere but in calls inside a writeAs callback or
	// the step-up's guard.
	const readsAsCallback: Callback[] = [];
	for (const name of USER_FIELDS_IN[key]?.in ?? []) {
		const declaration = declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
		const fn = declaration?.initializer && bare(declaration.initializer);
		if (!declaration || !isCallback(fn) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) {
			findings.push(`${at} names ${name} on USER_FIELDS_IN, which is no const function of its own this test can read`);
			continue;
		}
		const uses: ts.Identifier[] = [];
		const gatherUses = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && node.text === name && node !== declaration.name && declarationOf(node, name) === declaration) uses.push(node);
			ts.forEachChild(node, gatherUses);
		};
		gatherUses(body);
		const calledInside = (use: ts.Identifier) =>
			ts.isCallExpression(use.parent) && use.parent.expression === use && callbacks.some((callback) => within(use, callback));
		if (uses.length === 0 || !uses.every(calledInside)) {
			findings.push(`${at} uses ${name} other than by calling it inside a writeAs callback or the step-up's guard`);
			continue;
		}
		readsAsCallback.push(fn);
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
				boundQuickly.has(node) ||
				(isLocalsUser(node) &&
					ts.isCallExpression(node.parent) &&
					node.parent.arguments.includes(node as ts.Expression) &&
					ts.isExpressionStatement(node.parent.parent) &&
					quickChecks.includes(calleeOf(node.parent, tree)));
			// A field named `user` that USER_FIELDS_IN says is no account: on a name
			// that resolves, by scope, to a const or let declared inside this
			// writeAs callback, from something that is not the locals, and never
			// assigned again (the slices 5–7 review).
			const readIn = callback ?? readsAsCallback.find((fn) => within(node, fn));
			const notAnAccount =
				readIn !== undefined &&
				ts.isPropertyAccessExpression(node) &&
				ts.isIdentifier(node.expression) &&
				(USER_FIELDS_IN[key]?.of ?? []).includes(node.expression.text) &&
				declaredHereFromNoLocals(node.expression, readIn);
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
		if (
			ts.isCallExpression(node) &&
			!named(node, 'writeAs') &&
			!named(node, 'stillCallerNow') &&
			!named(node, 'confirmStepUp') &&
			node.arguments.some((argument) => isTheLocals(argument))
		) {
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
		// A handler that asks for the password again (card 2701) asks right
		// after the step-up instead: confirmStepUp decides on the caller in a
		// writeAs of its own, and the check must follow the awaited password
		// check, with nothing between.
		const stepUpEnd = stepUps.reduce((end, call) => Math.max(end, call.getEnd()), -1);
		const from = Math.max(read ? read.getEnd() : body.getStart(tree), stepUpEnd);
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
		// R2's seven, the test mail (slice 2253-5), and the export (card 2701).
		expect(Object.keys(STILL_CALLER_NOW)).toHaveLength(9);
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
			// Card 2772 (D5): Keep this key.
			'src/routes/api/account/api-keys/[id]/keep/+server.ts POST',
			// Card 2772 (D1-D3, D6): the two-step section, the new phone's code (no step-up) among them, and That was me.
			'src/routes/api/account/two-step/authenticators/+server.ts POST',
			'src/routes/api/account/two-step/authenticators/[id]/+server.ts DELETE',
			'src/routes/api/account/two-step/authenticators/confirm/+server.ts POST',
			'src/routes/api/account/two-step/recovery-codes/+server.ts POST',
			'src/routes/api/account/two-step/banner/+server.ts DELETE',
			// Card 3064 (R8, R10): setting up two-step sign-in while it is dormant, and requiring it.
			'src/routes/api/account/two-step/set-up/+server.ts POST',
			'src/routes/api/admin/two-step/require/+server.ts POST',
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
			// Card 3020 (R4): a request's held requester mail released.
			'src/routes/api/requests/held/+server.ts POST',
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
			// Card 2754: a key's image upload, new, keeping it from the start.
			'src/routes/api/v1/cards/[cardId]/attachments/+server.ts POST',
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
			// The upload's place and count (card 2910) are its quick checks too.
			`${upload}:1 POST reads locals.user at line 6 before the body other than in a quick check that binds no name (${QUICK}, requireCard, takeUploadPlace, takeUploadCount): decide inside writeAs with caller`,
			`${upload}:1 POST reads locals.user at line 8 before the body other than in a quick check that binds no name (${QUICK}, requireCard, takeUploadPlace, takeUploadCount): decide inside writeAs with caller`
		]);
		// The public request form's screen of a caller with no session, there alone (slice 2253-4).
		expect(judged(code, form)).toEqual([
			`${form}:1 POST reads locals.user at line 6 before the body other than in a quick check that binds no name (${QUICK}, screenAnonymous): decide inside writeAs with caller`,
			`${form}:1 POST reads locals.user at line 7 before the body other than in a quick check that binds no name (${QUICK}, screenAnonymous): decide inside writeAs with caller`
		]);
	});

	// Card 2910's code review (CR2): `binds` lets one const of one guard stand, in the handler it names, and nothing near it.
	it("lets the upload's place bind `release` from locals.user before the body, and reports every other form of it (card 2910)", () => {
		const upload = 'src/routes/api/cards/[id]/attachments/+server.ts';
		const handler = (before: string[], after: string[] = [], name = 'release') =>
			[
				'export const POST = async ({ request, locals }) => {',
				'\trequireUser(locals.user);',
				...before,
				'\ttry {',
				'\t\tconst body = await readBody(request);',
				...after,
				'\t\twriteAs(locals, (caller) => requireCard(caller, 1, "edit"));',
				'\t} finally {',
				`\t\t${name}();`,
				'\t}',
				'};'
			].join('\n');
		const bound = handler(['\tconst release = takeUploadPlace(locals.user);']);

		/** What the rule says of a name bound from locals.user at `at`, and used in the finally at `use`. */
		const reported = (file: string, name: string, at: number, use: number) => [
			`${file}:1 POST binds ${name} from locals.user at line ${at}; quick checks bind no name: decide inside writeAs with caller`,
			`${file}:1 POST uses ${name}, bound from locals.user at line ${at}, at line ${use}: decide inside writeAs with caller`
		];

		expect(judged(bound, upload)).toEqual([]);
		// Another name.
		expect(judged(handler(['\tconst leave = takeUploadPlace(locals.user);'], [], 'leave'), upload)).toEqual(reported(upload, 'leave', 3, 8));
		// A let, declared with it or assigned after.
		expect(judged(handler(['\tlet release = takeUploadPlace(locals.user);']), upload)).toEqual(reported(upload, 'release', 3, 8));
		expect(judged(handler(['\tlet release;'], ['\t\trelease = takeUploadPlace(locals.user);']), upload)).toEqual(reported(upload, 'release', 6, 9));
		// Bound after the body is read.
		expect(judged(handler([], ['\t\tconst release = takeUploadPlace(locals.user);']), upload)).toEqual(reported(upload, 'release', 5, 8));
		// Given something beside locals.user.
		expect(judged(handler(['\tconst release = takeUploadPlace(locals.user, 3);']), upload)).toEqual(reported(upload, 'release', 3, 8));
		// The same code in a handler whose entry has no `binds`.
		expect(judged(bound)).toEqual(reported('src/routes/api/example/+server.ts', 'release', 3, 8));
		// Every name `binds` gives is a guard's of the same entry.
		for (const [key, entry] of Object.entries(QUICK_CHECKS_IN)) {
			for (const guard of Object.keys(entry.binds ?? {})) expect(entry.guards, key).toContain(guard);
		}
	});

	it('lets a SELECT asked of sqlite outside writeAs stand only where READS_IN says, and nothing else asked of it (slice 2253-5)', () => {
		const code = [
			'export const POST = async ({ request, locals }) => {',
			'\tconst buffer = await request.arrayBuffer();',
			'\trequireSuperadmin(stillCallerNow(locals));',
			'\twriteImportFile("restore.db", buffer);',
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
		// The mail save asks for the current password since card 2701, through
		// its readSave: this one, with neither, is held to that as well.
		expect(judged(code, mail)).toEqual([
			`${mail}:1 PUT names readSave on USER_FIELDS_IN, which is no const function of its own this test can read`,
			`${mail}:1 PUT reads other.user at line 9${DECIDE}`,
			`${mail}:1 PUT reads saved.user at line 11${DECIDE}`,
			`${mail}:1 PUT does not call whilePasswordHolds (d)`
		]);
	});

	it('reads the mail save’s readSave as a writeAs callback only where it is called inside one or the step-up’s guard (card 2701)', () => {
		const code = (outside: string) =>
			[
				'export const PUT = async ({ request, locals, cookies }) => {',
				'\tconst body = await readBody(request);',
				'\tconst readSave = (caller) => {',
				'\t\trequireAdmin(caller);',
				'\t\tconst existing = read();',
				'\t\tconst config = {};',
				'\t\tconfig.user = existing?.user;',
				'\t\treturn config;',
				'\t};',
				"\tconst { userId, hash } = await confirmStepUp(locals, cookies, body, 'PUT /api/admin/smtp', (caller) => readSave(caller));",
				'\tawait whilePasswordHolds(userId, hash, () => writeAs(locals, (caller) => save(readSave(caller))));',
				outside,
				'};'
			].join('\n');
		const mail = 'src/routes/api/admin/smtp/+server.ts';
		const DECIDE = ': decide inside writeAs with caller';

		expect(judged(code(''), mail)).toEqual([]);
		expect(judged(code('\treturn json(readSave(null));'), mail)).toEqual([
			`${mail}:1 PUT uses readSave other than by calling it inside a writeAs callback or the step-up's guard`,
			`${mail}:1 PUT reads config.user at line 7${DECIDE}`,
			`${mail}:1 PUT reads existing?.user at line 7${DECIDE}`
		]);
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

		// The two of card 2701 as well, as in the case above.
		expect(judged(code, mail)).toEqual([
			`${mail}:1 PUT names readSave on USER_FIELDS_IN, which is no const function of its own this test can read`,
			`${mail}:1 PUT assigns the locals to config at line 3${DECIDE}`,
			`${mail}:1 PUT reads getRequestEvent().locals at line 7, not the locals the handler is given${DECIDE}`,
			`${mail}:1 PUT reads config.user at line 10${DECIDE}`,
			`${mail}:1 PUT reads existing.user at line 10${DECIDE}`,
			`${mail}:1 PUT reads other.user at line 10${DECIDE}`,
			`${mail}:1 PUT does not call whilePasswordHolds (d)`
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
		// The reset asks for the current password since card 2701: this one,
		// with no whilePasswordHolds, is held to that as well.
		expect(judged(code, reset)).toEqual([
			`${reset}:1 POST reads locals.user at line 10${DECIDE}`,
			`${reset}:1 POST does not call whilePasswordHolds (d)`
		]);
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
			'src/routes/api/admin/vacuum/+server.ts:1 POST calls nothing matching /^vacuumAndScrub$/ after its check at line 2 (c)'
		]);
	});

	it("passes a current-password route whose write is all inside writeAs, and finds one that is not (d)", () => {
		const route = (write: string) =>
			[
				'export const PUT = async ({ request, locals }) => {',
				'\tconst body = await readBody(request);',
				`\tconst done = await whilePasswordHolds(1, hash, ${write});`,
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
 *      handed, as it is or through requireUser (the review of A1, 8).
 *      `confirmStepUp`'s guard (card 2701), which runs in a writeAs of its
 *      own, is read as a callback for a read, and never for a write;
 *   2. each module on SERVICES has an explicit `READS` export naming its
 *      read functions; every other function it exports is a write, and the
 *      first statement of each is `inWrite();`; it exports nothing else in
 *      any form, no default, no value that is not a function written there,
 *      nothing from elsewhere, but a page route's options for one of its
 *      writes, `<NAME>_PAGE_OPTIONS`, an object written out whose values are
 *      each a text, true or false (the card 2296 review: the route and a new
 *      card's nested write share it). In a route file, a write is called only inside
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
 *      at the call, and a `says` among them words written out (the review, 4),
 *      or the write's own module's `_PAGE_OPTIONS` constant, whole or spread
 *      into an object written out (the card 2296 review);
 *   5. the rule itself, against made-up source.
 *
 * At run time `inWrite()` (src/lib/server/write-as.ts) refuses a service
 * write outside a writeAs callback, a job's bare inTransaction among them
 * (tests/write-as.test.ts). Card 2253's walks of
 * tests/access-every-route.test.ts ("asked again at the write") are the
 * behavioural backstop, run unchanged.
 */

// The modules both API trees' handlers call for their work (SERVICES), and the modules the decision services share
// pieces through (SERVICE_HELPERS), are tests/helpers/source-scan.ts's, which tests/decisions-api.test.ts case 3 reads too
// (card 2713, R5).

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
	writeUploadFile:
		"An upload's file, written into the card's folder before the transaction (`$lib/server/uploads`, card 2754's D19, " +
		'the card window route\'s own code until then): no row, and it decides nothing about the caller; the row is the ' +
		"service's, written after in a writeAs, which asks the card and the caller's access again (card 2337).",
	removeUploadFile:
		"The file `writeUploadFile` wrote, removed after a refused or failed transaction, and the card's folder if the " +
		'upload made it (`$lib/server/uploads`, card 2754): no row.',
	checkImage:
		'An uploaded image, from either tree, checked against its declared type and its metadata taken out ' +
		'(`$lib/server/image-check`, cards 2754 and 2761): the bytes alone, no imports, no row; it decides nothing about the ' +
		'caller, who is asked for in the writeAs that charges the bytes and again in the one that writes the row.',
	imageTypeOf:
		"The card window's upload's declared type, read from the form as one of the four image types or none " +
		'(`$lib/server/image-check`, card 2761, D1): a string alone, no row; it decides which path the file takes, not ' +
		'anything about the caller.',
	bytesRead:
		"What was read of the card window's upload, the length its request declared or the gate's count of a body sent in " +
		'chunks (`$lib/server/body-limits`, card 2910, S4): the request alone, no row; it is charged to the day in the writeAs ' +
		'that follows, which asks for the caller.',
	bytesCounted:
		"What the gate's count read of an upload's body whose read failed, was cut off or ran out of time " +
		'(`$lib/server/body-limits`, card 2910\'s code review, CS1): the request alone, no row; it is charged to the day in ' +
		'the writeAs that follows, which asks for the caller.',
	fileName:
		"The name the card window's upload of a file that is not an image is stored with, cleaned and cut, its extension " +
		'kept (`$lib/server/attachment-names`, card 2910, D11): strings alone, no row, no caller, and not a service; the ' +
		'row is written in the writeAs that follows.',
	storedType:
		"The type that file is stored with, the declared one when it is plain, else application/octet-stream " +
		'(`$lib/server/attachment-names`, card 2910, D12): a string alone, no row, no caller, and not a service.',
	refuseWrongLink:
		'A personal link that opened no decision, counted in memory against the address once the write has refused it ' +
		'(`$lib/server/decision-view`, card 2677, decision 8): it reads no row and writes none, but one WARN line in the log ' +
		'the first time an address is over the limit in a window.',
	confirmStepUp:
		"The caller's password, asked for again before a delete that cannot be taken back (`$lib/server/step-up`, card " +
		'2701): it runs its guard in a writeAs of its own, read only, read here as a writeAs callback, and then counts the ' +
		"check on the session's row; the write it guards is made after, in a writeAs.",
	whilePasswordHolds:
		'Runs the write it is given, a writeAs whose callback calls the service, only while the stored hash is the one the ' +
		"password was checked against (`$lib/server/auth`, card 2701): it reads the caller's account row in its own " +
		'transaction, and decides nothing else.',
	holdDrawing:
		"The one place on the server where a decision's PDF is drawn (`$lib/server/decision-report`, card 2688, R9a), an " +
		"in-memory place in flight as an upload's is: no row and no caller. Taken between the writeAs that asks whether the " +
		'caller may take the copy and the one that reads the projection, so that a caller refused never holds it (card ' +
		"2688's code review, S-M1).",
	generateDecisionPdf:
		"Draws a decision's PDF from the projection the writeAs before it read (`$lib/server/decision-report`, card 2688): " +
		'no row and no caller, and asynchronous, so it cannot run inside a transaction; the full record\'s entry is written ' +
		'after it, in a writeAs that asks `record` again.',
	decisionPdfFilename:
		"The download's file name, from the decision's title, the copy and the export date (`$lib/server/decision-report`, " +
		'card 2688): a string alone, no row, no caller.'
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

/**
 * A module's imports from src/lib/server: each local name, with the file and the name it is exported under. By
 * `$lib/server/…` or any other specifier that names a file there, a relative one or one ending `.js` among them
 * (`moduleFileOf`; card 2681, the code review's S2).
 */
function serverImportsOf(
	tree: ts.SourceFile,
	from: string
): { names: Map<string, { file: string; name: string }>; namespaces: { file: string; line: number }[] } {
	const names = new Map<string, { file: string; name: string }>();
	const namespaces: { file: string; line: number }[] = [];
	for (const statement of tree.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const clause = statement.importClause;
		const target = moduleFileOf(from, statement.moduleSpecifier.text);
		const file = target !== null && (target.startsWith('src/lib/server/') || target === 'src/lib/server.ts') ? target : null;
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
type ServiceReading = {
	reads: string[];
	writes: string[];
	pageOptions: string[];
	findings: string[];
	/** Card 2713 (C1): the helper sources and the writers the reading was handed, as handed. */
	helpers: readonly { file: string; source: string }[];
	writers: Writers;
};

/** A page route's options for a service's write, exported by the service (the card 2296 review). */
const PAGE_OPTIONS = /^[A-Z][A-Z0-9_]*_PAGE_OPTIONS$/;

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

/** The file of each path `moduleFileOf` has looked for, by the path (card 2702, code review K19). */
const MODULE_FILES = new Map<string, string>();

/**
 * The file a module specifier names, from the file that names it: `$lib/server/…`, `$lib/…`, or a relative path.
 * A `.js` or `.ts` written on the end names the same module, and a `..` is followed, so that a scan that reads
 * imports by this sees `'../../lib/server/people'` and `'$lib/server/people.js'` as `src/lib/server/people.ts`
 * (card 2681, the code review's S2). Each path is looked for once, its file kept (card 2702, code review K19).
 */
function moduleFileOf(from: string, specifier: string): string | null {
	const named = specifier.replace(/\.(?:js|ts)$/, '');
	let base: string;
	if (named === '$lib' || named.startsWith('$lib/')) base = posix.normalize(`src/lib/${named.slice('$lib/'.length)}`).replace(/\/$/, '');
	else if (named.startsWith('.')) base = posix.join(posix.dirname(from), named);
	else return null;
	const kept = MODULE_FILES.get(base);
	if (kept !== undefined) return kept;
	const found = moduleFileAt(base);
	MODULE_FILES.set(base, found);
	return found;
}

/** The file a module path names: under src/lib/server by `serverFileOf`, else the path's `.ts`, or its `index.ts` where only that is there. */
function moduleFileAt(base: string): string {
	if (base === 'src/lib/server' || base.startsWith('src/lib/server/')) return serverFileOf(`$lib/server${base.slice('src/lib/server'.length)}`) as string;
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

/** Exported writers, by module file: what `writersOf` reads from the source, with RECORD_WRITERS added. */
type Writers = ReadonlyMap<string, ReadonlySet<string>>;

/** The database module and the transaction module, as `moduleFileOf` names them. */
const DB_MODULE = 'src/lib/server/db/index.ts';
const TRANSACTION_MODULE = 'src/lib/server/db/transaction.ts';
/** What a call on the database writes with: a statement written, or one prepared or run. */
const DB_WRITES = ['insert', 'update', 'delete', 'run', 'exec', 'prepare', 'transaction'];
/** The allowance in memory a read must not take (card 2713, R2, C3). */
const ALLOWANCE = { file: 'src/lib/server/rate-limit.ts', name: 'takeAllowance' };

/**
 * Card 2713 (C5): whether an identifier refers to a value bound elsewhere:
 * not a property's name (`x.appendEvent`, `{ appendEvent: 1 }`), a
 * declaration's own name, a label, or the exported name of `export { a as
 * b }`. `{ appendEvent }` and `export { appendEvent }` refer to it.
 */
function isValueReference(node: ts.Identifier): boolean {
	const parent = node.parent;
	if (!parent) return false;
	if (ts.isShorthandPropertyAssignment(parent)) return parent.name === node;
	if (ts.isExportSpecifier(parent)) return (parent.propertyName ?? parent.name) === node;
	if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
	if (ts.isQualifiedName(parent) || ts.isMetaProperty(parent)) return false;
	if ((ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && parent.label === node) return false;
	if ((ts.isBindingElement(parent) || ts.isImportSpecifier(parent)) && parent.propertyName === node) return false;
	return (parent as { name?: ts.Node }).name !== node;
}

/**
 * Card 2713 (C5): every identifier in `root` that refers to a value, in source
 * order: a call's callee, a callback handed on (`ids.forEach(appendEvent)`),
 * `appendEvent.call(…)`, a name assigned (`const w = appendEvent`), a
 * namespace (`record` of `record.appendRuling`). An import declaration, a
 * re-export from another module and every type position are left out: they
 * run nothing.
 */
function referencesIn(root: ts.Node): ts.Identifier[] {
	const found: ts.Identifier[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return;
		if (ts.isExportDeclaration(node) && (node.moduleSpecifier !== undefined || node.isTypeOnly)) return;
		if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
		if (ts.isIdentifier(node) && isValueReference(node)) found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(root);
	return found;
}

/**
 * Card 2713 (C2, C4, C5): the exported functions of the modules given that
 * write, by file, read from their source. A function writes when, with
 * `database` (the default), it calls `insert`, `update`, `delete`, `run`,
 * `exec`, `prepare` or `transaction` on the database (a name its module
 * imports from src/lib/server/db, or `db` or `sqlite`); and always when it
 * names `inTransaction` (under any name, or through a namespace), or refers
 * to a function that writes: one of its own module, followed on, or an
 * exported writer of another of the modules (`seeds` among them), imported by
 * name under any name or reached through a namespace import, or the
 * namespace itself handed on whole. Referring is any reference, not only a
 * call: a callback (`es.forEach(appendEvent)`), `.call`, a name assigned
 * (C5). Re-exported by name, from another module or as an import exported
 * again, a writer stays one. Read to a fixed point, so a writer reached
 * through a chain of modules is one. A `.update` on a hash or a `.delete` on
 * a Map is no write here: only a call on the database is, which
 * RECORD_WRITERS holds to its named writers (`judgeWriterList`). Without
 * `database` it reads what reaches a writer of `seeds` or `inTransaction`
 * (`reachingWriters`, C4).
 */
function writersOf(
	files: readonly { file: string; source: string }[],
	options: { database?: boolean; seeds?: Writers } = {}
): Map<string, Set<string>> {
	const database = options.database ?? true;
	type Unit = { direct: boolean; own: string[]; imported: { file: string; name: string }[] };
	type Module = {
		units: Map<ts.Node, Unit>;
		local: Map<string, ts.Node>;
		exported: Map<string, ts.Node>;
		reexported: Map<string, { file: string; name: string }>;
	};
	const modules = new Map<string, Module>();
	for (const { file, source } of files) {
		if (!file.endsWith('.ts')) continue;
		const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		const dbNames = new Set(['db', 'sqlite']);
		const transactionNames = new Set(['inTransaction']);
		const named = new Map<string, { file: string; name: string }>();
		const namespaces = new Map<string, string>();
		const reexported = new Map<string, { file: string; name: string }>();
		for (const statement of tree.statements) {
			if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
				const target = moduleFileOf(file, statement.moduleSpecifier.text);
				if (target !== null && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
					for (const element of statement.exportClause.elements) reexported.set(element.name.text, { file: target, name: (element.propertyName ?? element.name).text });
				}
				continue;
			}
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
			const target = moduleFileOf(file, statement.moduleSpecifier.text);
			const clause = statement.importClause;
			if (target === null || !clause || clause.isTypeOnly) continue;
			const bindings = clause.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, target);
			else if (bindings) {
				for (const element of bindings.elements) {
					if (element.isTypeOnly) continue;
					const name = (element.propertyName ?? element.name).text;
					if (target === DB_MODULE) dbNames.add(element.name.text);
					if (name === 'inTransaction') transactionNames.add(element.name.text);
					named.set(element.name.text, { file: target, name });
				}
			}
		}
		// C5: an import exported again, `export { appendEvent as relayed }`, is a re-export of it.
		for (const statement of tree.statements) {
			if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
			for (const element of statement.exportClause.elements) {
				const from = named.get((element.propertyName ?? element.name).text);
				if (from && !element.isTypeOnly) reexported.set(element.name.text, from);
			}
		}
		/** What a chain of calls and properties starts from: `db` of `db.insert(t).values(v).run`. */
		const rootOf = (node: ts.Expression): ts.Expression => {
			let at = bare(node);
			while (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at) || ts.isCallExpression(at)) at = bare(at.expression);
			return at;
		};
		/** What a function's body, or a constant's value (`withDatabase` false), calls and refers to. */
		const unitOf = (body: ts.Node | undefined, withDatabase: boolean): Unit => {
			const unit: Unit = { direct: false, own: [], imported: [] };
			if (!body) return unit;
			for (const call of callsIn(body, true)) {
				const callee = bare(call.expression);
				if (!ts.isPropertyAccessExpression(callee)) continue;
				const root = rootOf(callee.expression);
				if (withDatabase && DB_WRITES.includes(callee.name.text) && ts.isIdentifier(root) && dbNames.has(root.text)) unit.direct = true;
				if (callee.name.text === 'inTransaction') unit.direct = true;
			}
			for (const reference of referencesIn(body)) {
				if (transactionNames.has(reference.text)) unit.direct = true;
				const space = namespaces.get(reference.text);
				if (space !== undefined) {
					const parent = reference.parent;
					if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) unit.imported.push({ file: space, name: parent.name.text });
					else if (ts.isElementAccessExpression(parent) && parent.expression === reference && ts.isStringLiteralLike(parent.argumentExpression)) {
						unit.imported.push({ file: space, name: parent.argumentExpression.text });
					} else unit.imported.push({ file: space, name: '*' });
					continue;
				}
				const from = named.get(reference.text);
				if (from) unit.imported.push(from);
				else unit.own.push(reference.text);
			}
			return unit;
		};
		// Each name declared at the top of the module: a function, or a constant's value (`const w = appendEvent`, C5).
		const local = new Map<string, ts.Node>();
		const units = new Map<ts.Node, Unit>();
		for (const statement of tree.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name) {
				local.set(statement.name.text, statement);
				if (!units.has(statement)) units.set(statement, unitOf(statement.body, database));
			}
			if (!ts.isVariableStatement(statement)) continue;
			for (const declared of statement.declarationList.declarations) {
				const value = declared.initializer && bare(declared.initializer);
				if (!ts.isIdentifier(declared.name) || !value) continue;
				const isFunction = ts.isArrowFunction(value) || ts.isFunctionExpression(value);
				local.set(declared.name.text, value);
				units.set(value, isFunction ? unitOf((value as HandlerFunction).body, database) : unitOf(value, false));
			}
		}
		const exported = new Map<string, ts.Node>();
		const reading = exportsOf(tree);
		for (const { name, fn } of reading.functions) exported.set(name, fn);
		for (const { fn } of reading.defaults) if (fn) exported.set('default', fn);
		for (const { fn } of [...reading.functions, ...reading.defaults]) if (fn && !units.has(fn)) units.set(fn, unitOf(fn.body, database));
		// An exported constant that holds a writer, `export const w = appendEvent` (C5), is one.
		for (const { name, value } of reading.values) {
			const held = value && ts.isExpression(value) ? bare(value) : undefined;
			if (held && units.has(held)) exported.set(name, held);
		}
		modules.set(file, { units, local, exported, reexported });
	}
	const writers = new Map<string, Set<string>>();
	/** The nodes of the writers found or seeded, so that a module's own call of one is a write (C4). */
	const writerNodes = new Set<ts.Node>();
	const add = (file: string, name: string) => {
		writers.set(file, (writers.get(file) ?? new Set()).add(name));
		const node = modules.get(file)?.exported.get(name);
		if (node) writerNodes.add(node);
	};
	for (const [file, names] of options.seeds ?? []) for (const name of names) add(file, name);
	const isWriter = (file: string, name: string, depth = 0): boolean => {
		// A namespace handed on whole is a write if its module has one.
		if (name === '*') return (writers.get(file)?.size ?? 0) > 0;
		if (writers.get(file)?.has(name)) return true;
		const again = modules.get(file)?.reexported.get(name);
		return again !== undefined && depth < 10 && isWriter(again.file, again.name, depth + 1);
	};
	const reaches = (module: Module, node: ts.Node, seen: Set<ts.Node>): boolean => {
		if (writerNodes.has(node)) return true;
		if (seen.has(node)) return false;
		seen.add(node);
		const unit = module.units.get(node);
		if (!unit) return false;
		if (unit.direct || unit.imported.some(({ file, name }) => isWriter(file, name))) return true;
		return unit.own.some((name) => {
			const inner = module.local.get(name);
			return inner !== undefined && reaches(module, inner, seen);
		});
	};
	for (let changed = true; changed; ) {
		changed = false;
		for (const [file, module] of modules) {
			for (const [name, node] of module.exported) {
				if (writers.get(file)?.has(name) || !reaches(module, node, new Set())) continue;
				add(file, name);
				changed = true;
			}
			for (const [name, { file: from, name: original }] of module.reexported) {
				if (writers.get(file)?.has(name) || !isWriter(from, original)) continue;
				add(file, name);
				changed = true;
			}
		}
	}
	return writers;
}

/**
 * Card 2713 (C2): the writers the decision services and their helper call
 * of the record, the activity log, the links and the mail queue, named. Each
 * is a write wherever rule 3 looks and in the helper pin; `judgeWriterList`
 * holds the list to what `writersOf` reads, both ways, so that a writer
 * renamed, moved or no longer read as one fails, and one added to these
 * modules is listed.
 */
const RECORD_WRITERS: Readonly<Record<string, readonly string[]>> = {
	'src/lib/server/decision-record.ts': [
		'appendEvent',
		'appendVersion',
		'appendResponse',
		'appendRuling',
		'appendQuestion',
		'recordAnswer',
		'recordDraftPublished',
		'recordDraftReplaced',
		// Card 2684 (R2): a flag's one insert and its one guarded reply. Its reads are decision-flags.ts's, which log.
		'appendFlag',
		'recordFlagReply'
	],
	'src/lib/server/logActivity.ts': ['logActivity', 'logUiActivity'],
	// Card 2922's code review (C2): `revokeEveryLink`, a Remove of held mail or a held App URL ending every link.
	'src/lib/server/decision-links.ts': ['issueLink', 'revokeLinks', 'revokeEveryLink'],
	// C5: `queueDryRun` queues the dry run's mail after the commit (card 2697); read by reference, its `afterCommit`
	// reaches the transaction module's `log`, which writes system_logs, so it is a writer and is listed.
	'src/lib/server/decision-mail.ts': ['queueRecordMails', 'queueDryRun']
};

/**
 * Card 2713 (C2): RECORD_WRITERS against what `writersOf` reads, over the
 * files given. A module named that is not there, a writer it no longer
 * exports, one it exports that no longer writes as read here, and a writer
 * of a module named that is not on the list are each a finding: the list
 * fails closed.
 */
function judgeWriterList(files: readonly { file: string; source: string }[], derived: Writers, listed: Readonly<Record<string, readonly string[]>>): string[] {
	const findings: string[] = [];
	for (const [file, names] of Object.entries(listed)) {
		const given = files.find((candidate) => candidate.file === file);
		if (!given) {
			findings.push(`RECORD_WRITERS names ${file}, which is not a module here (writers)`);
			continue;
		}
		const exported = new Set(exportsOf(ts.createSourceFile(file, given.source, ts.ScriptTarget.Latest, true)).functions.map(({ name }) => name));
		for (const name of names) {
			if (!exported.has(name)) findings.push(`RECORD_WRITERS names ${file}#${name}, which it no longer exports (writers)`);
			else if (!derived.get(file)?.has(name)) findings.push(`RECORD_WRITERS names ${file}#${name}, which no longer writes as this scan reads it (writers)`);
		}
		for (const name of derived.get(file) ?? []) {
			if (!names.includes(name)) findings.push(`${file}#${name} writes and is not on RECORD_WRITERS (writers)`);
		}
	}
	return findings;
}

/**
 * The writers rule 3 and the helper pin count (C2): of each module on
 * RECORD_WRITERS, what `writersOf` read of it, with each writer the list
 * names added, so that a writer named is one even where the reading misses
 * it. Other modules' raw database calls are left out: read this way a
 * lazily made signing key (`formSecret`) and a `sqlite.prepare` of a SELECT
 * are writes too, which the record's rule is not about. What of theirs
 * reaches one of these, or `inTransaction`, is added by `reachingWriters` (C4).
 */
function listedWriters(derived: Writers, listed: Readonly<Record<string, readonly string[]>>): Writers {
	const writers = new Map<string, Set<string>>();
	for (const [file, names] of Object.entries(listed)) writers.set(file, new Set([...(derived.get(file) ?? []), ...names]));
	return writers;
}

/**
 * Card 2713 (C4): the writers rule 3 and the helper pin count, over the files
 * given: the listed modules' writers (`listedWriters`) and `inTransaction`,
 * and every exported function of any other module, a service among them,
 * that reaches one of them, through its own functions, imports under any
 * name, namespaces and re-exports, to a fixed point (`writersOf` without
 * `database`). So
 * `runDecisionRemindersOnce`, which appends to the record, and
 * `stillCallerNow`, which opens a transaction, are writers; a raw database
 * call outside the listed modules still is not, so that `formSecret`'s
 * signing key made once and a `sqlite.prepare` of a SELECT stay out.
 */
function reachingWriters(files: readonly { file: string; source: string }[], derived: Writers, listed: Readonly<Record<string, readonly string[]>>): Writers {
	const seeds = listedWriters(derived, listed) as Map<string, Set<string>>;
	seeds.set(TRANSACTION_MODULE, new Set(['inTransaction']));
	return writersOf(files, { database: false, seeds });
}

/** What a reference in a module refers to that writes (`importedWriteOf`): which kind, and the node that names it. */
type ImportedWrite = { kind: 'writer' | 'allowance'; node: ts.Node };

/**
 * Card 2713 (C2, C3, C5): what a reference in `tree` (the module `file`,
 * `referencesIn`) refers to of another module that writes, and the node that
 * names it. A reference, not only a call: a callback handed on, `.call`, a
 * name assigned (C5). `writer`: a function on `writers`, imported by name
 * under any name or reached through a namespace import (`record.appendRuling`
 * or `record['appendRuling']`), or a namespace of a module with a writer
 * handed on whole. `allowance`: `takeAllowance` of src/lib/server/rate-limit.ts
 * under any name, or any function called `takeAllowance`, the allowance in
 * memory a read must not take (R2). Undefined for any other reference.
 */
function importedWriteOf(tree: ts.SourceFile, file: string, writers: Writers): (reference: ts.Identifier) => ImportedWrite | undefined {
	const named = new Map<string, { file: string; name: string }>();
	const namespaces = new Map<string, string>();
	for (const statement of tree.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const target = moduleFileOf(file, statement.moduleSpecifier.text);
		const bindings = statement.importClause?.namedBindings;
		if (target === null || !bindings) continue;
		if (ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, target);
		else for (const element of bindings.elements) named.set(element.name.text, { file: target, name: (element.propertyName ?? element.name).text });
	}
	const kindOf = (target: string, name: string, written: string): ImportedWrite['kind'] | undefined => {
		if (writers.get(target)?.has(name)) return 'writer';
		if ((target === ALLOWANCE.file && name === ALLOWANCE.name) || written === ALLOWANCE.name) return 'allowance';
		return undefined;
	};
	return (reference) => {
		const space = namespaces.get(reference.text);
		if (space !== undefined) {
			const parent = reference.parent;
			let kind: ImportedWrite['kind'] | undefined;
			if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) kind = kindOf(space, parent.name.text, parent.name.text);
			else if (ts.isElementAccessExpression(parent) && parent.expression === reference && ts.isStringLiteralLike(parent.argumentExpression)) {
				kind = kindOf(space, parent.argumentExpression.text, parent.argumentExpression.text);
			} else {
				// The namespace handed on whole: a write if its module has one.
				kind = (writers.get(space)?.size ?? 0) > 0 ? 'writer' : space === ALLOWANCE.file ? 'allowance' : undefined;
				return kind && { kind, node: reference };
			}
			return kind && { kind, node: parent };
		}
		const from = named.get(reference.text);
		const kind = from ? kindOf(from.file, from.name, reference.text) : reference.text === ALLOWANCE.name ? 'allowance' : undefined;
		return kind && { kind, node: reference };
	};
}

/** A write as it is written: a call's callee (`db.insert(t).values(v).run`), or the name referred to. */
function writeText(node: ts.Node, tree: ts.SourceFile): string {
	return ts.isCallExpression(node) ? calleeOf(node, tree) : node.getText(tree).replace(/\s+/g, '');
}

/** A module a node names, and in which form: an import, a re-export, `import()`, or `import x = require()` or `require()`. */
type ModuleNaming = { specifier: string; form: 'import' | 'export' | 'import()' | 'require' };

/**
 * The module `node` names, in every form a module can be named (card 2713, R3;
 * card 2702, code review K9), with its specifier as written; undefined when
 * `node` names none, or names one by an expression that is not a string.
 * Shared by the helper pin and the webhook-writer rule.
 */
function moduleNamedBy(node: ts.Node): ModuleNaming | undefined {
	let named: { specifier: ts.Expression | undefined; form: ModuleNaming['form'] } | undefined;
	if (ts.isImportDeclaration(node)) named = { specifier: node.moduleSpecifier, form: 'import' };
	else if (ts.isExportDeclaration(node) && node.moduleSpecifier) named = { specifier: node.moduleSpecifier, form: 'export' };
	else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) named = { specifier: node.arguments[0], form: 'import()' };
	else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) named = { specifier: node.moduleReference.expression, form: 'require' };
	else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') named = { specifier: node.arguments[0], form: 'require' };
	return named?.specifier && ts.isStringLiteralLike(named.specifier) ? { specifier: named.specifier.text, form: named.form } : undefined;
}

/**
 * Card 2713 (D2, D6 row 5): the helper pin, over the files given. Each module
 * on `helpers` is imported only by a decision service (a module on `services`
 * named `src/lib/server/decision*.ts`, `DECISION_SERVICE`), and only by name
 * under its own name: never as a namespace, a default or under another name
 * (R4), never re-exported and never by `import()`, `import x = require()` or
 * `require()` (`moduleNamedBy`), through whatever specifier names it, `$lib/server/…`, a relative path or a
 * `.js` ending (`moduleFileOf`, R3). A `.svelte` file is read as text, and
 * one that names a helper is a finding. A helper is on neither `services` nor
 * `notServices`, imports no service, declares no `READS`, calls no `insert`,
 * `update`, `delete`, `run`, `exec` or `prepare` (R2), nor refers to any
 * writer on `writers` (`reachingWriters`: of any module, C4) it imports,
 * under any name or through a namespace, by a call or otherwise: a callback,
 * `.call`, a name assigned, the namespace whole (C2, C5), and keeps
 * rule 3's file-wide bans: no `inTransaction` at all, no `locals`,
 * `App.Locals`, `RequestEvent` or `getRequestEvent`, no `$app/server`. And no
 * decision service imports another decision service (R6). Its
 * `takeAllowance`, the caller's mail allowance taken inside a write, is no
 * finding here; rule 3 counts it as a write where a read reaches it (R2, C3).
 */
function judgeServiceHelpers(
	files: { file: string; source: string }[],
	services: readonly string[],
	helpers: readonly string[],
	writers: Writers,
	notServices: Record<string, string> = {}
): string[] {
	const findings: string[] = [];
	const decisionServices = services.filter((file) => DECISION_SERVICE.test(file));
	for (const helper of helpers) {
		if (services.includes(helper)) findings.push(`${helper} is a service helper and is on SERVICES (helper pin)`);
		if (helper in notServices) findings.push(`${helper} is a service helper and is on NOT_SERVICES (helper pin)`);
		if (!files.some(({ file }) => file === helper)) findings.push(`SERVICE_HELPERS names ${helper}, which is not a module here (helper pin)`);
	}
	for (const { file, source } of files) {
		if (file.endsWith('.svelte')) {
			for (const helper of helpers) {
				if (source.includes(posix.basename(helper, '.ts'))) findings.push(`${file} names ${helper}, a service helper, which only a decision service imports (helper pin)`);
			}
			continue;
		}
		const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		const at = (node: ts.Node) => `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`;
		const isDecisionService = decisionServices.includes(file);
		const isHelper = helpers.includes(file);
		const notByName = (node: ts.Node, target: string) =>
			findings.push(`${at(node)} imports ${target}, a service helper, other than by name: import each function by its own name (helper pin)`);
		const visit = (node: ts.Node): void => {
			// Each module this file names, in every form (`moduleNamedBy`).
			const named = moduleNamedBy(node);
			const target = named ? moduleFileOf(file, named.specifier) : null;
			if (named && target !== null && helpers.includes(target)) {
				if (!isDecisionService) {
					findings.push(`${at(node)} imports ${target}, a service helper, which only a decision service on SERVICES may import (helper pin)`);
				} else if (named.form === 'export') {
					findings.push(`${at(node)} re-exports ${target}, a service helper (helper pin)`);
				} else if (named.form !== 'import' || !ts.isImportDeclaration(node)) {
					notByName(node, target);
				} else {
					const clause = node.importClause;
					const bindings = clause?.namedBindings;
					if (!clause || clause.name || !bindings || !ts.isNamedImports(bindings)) notByName(node, target);
					else {
						for (const element of bindings.elements) {
							if (element.propertyName && element.propertyName.text !== element.name.text) {
								findings.push(`${at(element)} imports ${element.propertyName.text} of ${target} as ${element.name.text}: import it under its own name (helper pin)`);
							}
						}
					}
				}
			}
			if (named && target !== null && services.includes(target)) {
				if (isHelper) findings.push(`${at(node)} imports ${target}, a service: a service helper imports none (helper pin)`);
				if (isDecisionService && target !== file && decisionServices.includes(target)) {
					findings.push(`${at(node)} imports ${target}: a decision service imports no other decision service (helper pin)`);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(tree);
		if (!isHelper) continue;
		// What the helper itself may not do: write, declare READS, or name a transaction or the request.
		const writing: ts.Node[] = [];
		// C5: any reference to an imported writer, called or handed on, is a write.
		const importedWrite = importedWriteOf(tree, file, writers);
		for (const reference of referencesIn(tree)) {
			const hit = importedWrite(reference);
			if (hit?.kind === 'writer') writing.push(hit.node);
		}
		const inHelper = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['insert', 'update', 'delete', 'run', 'exec', 'prepare'].includes(node.expression.name.text)) {
				writing.push(node);
			}
			if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '$app/server') findings.push(`${at(node)} imports $app/server (helper pin)`);
			if (ts.isIdentifier(node)) {
				if (node.text === 'READS') findings.push(`${at(node)} names READS: a service helper declares none (helper pin)`);
				if (['inTransaction', 'locals', 'RequestEvent', 'getRequestEvent'].includes(node.text)) findings.push(`${at(node)} names ${node.text} (helper pin)`);
				if (node.text === 'App' && ts.isQualifiedName(node.parent) && node.parent.right.text === 'Locals') findings.push(`${at(node)} names App.Locals (helper pin)`);
			}
			ts.forEachChild(node, inHelper);
		};
		inHelper(tree);
		writing.sort((a, b) => a.getStart(tree) - b.getStart(tree));
		for (const node of writing) {
			if (writing.some((other) => other !== node && within(node, other))) continue;
			const called = ts.isCallExpression(node) || (ts.isCallExpression(node.parent) && node.parent.expression === node);
			findings.push(`${at(node)} ${called ? 'calls' : 'refers to'} ${writeText(node, tree)}: a service helper writes nothing (helper pin)`);
		}
	}
	return findings;
}

/**
 * Rules 2 and 3 for one service module. `helpers` is the source of each
 * module on SERVICE_HELPERS, always handed (card 2713, D6 row 4, R1), so that
 * no call can leave rule 3's follow out: a read is followed through every
 * function of its own module and of a module on SERVICE_HELPERS it reaches,
 * called or referred to, at any depth and from one into the other, each
 * function read once so that a cycle ends (R2, C6). `writers` is each
 * module's exported writers (`reachingWriters`: RECORD_WRITERS, and what of
 * any module reaches one or `inTransaction`), always handed too (C2, C4).
 * Wherever rule 3 looks, any reference to an imported writer, called or
 * not, and to `takeAllowance` is a write (C2, C3, C5). The reading keeps the
 * `helpers` and `writers` it was handed, so that the suite can show its own
 * wiring was the one used (C1).
 */
function judgeService(file: string, source: string, helpers: readonly { file: string; source: string }[], writers: Writers): ServiceReading {
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
	// A page route's options (the card 2296 review): an object written out, each value a text, true or false.
	const pageOptions: string[] = [];
	for (const { name, value, at } of exported.values) {
		if (name === 'READS') continue;
		if (!PAGE_OPTIONS.test(name)) {
			findings.push(`${file}:${line(at)} exports ${name}, which is not a function written here: a service exports its functions and READS alone (2)`);
			continue;
		}
		let object = value && ts.isExpression(value) ? value : undefined;
		while (object && (ts.isAsExpression(object) || ts.isSatisfiesExpression(object) || ts.isParenthesizedExpression(object))) object = object.expression;
		// Exported where it is declared, as a const: nothing can change it after.
		const writtenOut =
			ts.isVariableDeclaration(at) &&
			ts.isVariableDeclarationList(at.parent) &&
			(at.parent.flags & ts.NodeFlags.Const) !== 0 &&
			object !== undefined &&
			ts.isObjectLiteralExpression(object) &&
			object.properties.every(
				(p) =>
					ts.isPropertyAssignment(p) &&
					(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
					(ts.isStringLiteral(p.initializer) || p.initializer.kind === ts.SyntaxKind.TrueKeyword || p.initializer.kind === ts.SyntaxKind.FalseKeyword)
			);
		if (writtenOut) pageOptions.push(name);
		else findings.push(`${file}:${line(at)} exports ${name}, page options that are not an object written out of texts, true and false (2)`);
	}
	for (const { specifier, at } of exported.reexports) findings.push(`${file}:${line(at)} re-exports from ${specifier}: a service exports only what it writes here (2)`);
	for (const name of reads) {
		if (!exported.functions.some((e) => e.name === name)) findings.push(`${file} names ${name} on READS, and exports no such function (2)`);
	}

	// (3): a read writes nothing: no insert, update, delete, run, exec or statement
	// prepared (the re-check of A1, 5), no transaction of its own, no imported
	// writer referred to and no allowance taken (card 2713, C2, C3, C5); nor
	// does anything it reaches through its module and the helpers (C6).
	const importedWrites = new Map<ts.SourceFile, (reference: ts.Identifier) => ImportedWrite | undefined>();
	/**
	 * The writes in `body`, written in the module `writtenIn`, in source order:
	 * a call of a statement or a transaction, and any reference, called or not,
	 * to an imported writer or the allowance (C5), whose imports say which.
	 */
	const writesIn = (body: ts.Node, writtenIn: ts.SourceFile): ts.Node[] => {
		const importedWrite = importedWrites.get(writtenIn) ?? importedWriteOf(writtenIn, writtenIn.fileName, writers);
		importedWrites.set(writtenIn, importedWrite);
		const writing: ts.Node[] = callsIn(body, true).filter((call) => {
			const callee = call.expression;
			return (ts.isPropertyAccessExpression(callee) && ['insert', 'update', 'delete', 'run', 'exec', 'prepare'].includes(callee.name.text)) || namesTransaction(callee);
		});
		for (const reference of referencesIn(body)) {
			const hit = importedWrite(reference);
			if (hit) writing.push(hit.node);
		}
		writing.sort((a, b) => a.getStart(writtenIn) - b.getStart(writtenIn));
		return writing.filter((node) => !writing.some((other) => other !== node && within(node, other)));
	};
	/** What a name declared at the top of a module runs: a function's body, or a constant's value (`const w = appendEvent`, C5). */
	const bodyIn = (source: ts.SourceFile, name: string): ts.Node | undefined => {
		for (const statement of source.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement.body;
			if (!ts.isVariableStatement(statement)) continue;
			for (const declared of statement.declarationList.declarations) {
				const value = declared.initializer && bare(declared.initializer);
				if (!ts.isIdentifier(declared.name) || declared.name.text !== name || !value) continue;
				return ts.isArrowFunction(value) || ts.isFunctionExpression(value) ? value.body : value;
			}
		}
		return undefined;
	};
	const helperTrees = new Map(helpers.map(({ file: helperFile, source: helperSource }) => [helperFile, ts.createSourceFile(helperFile, helperSource, ts.ScriptTarget.Latest, true)]));
	// Card 2713 (D6 row 4): each function a module, this one or a helper, imports from a module on SERVICE_HELPERS, by its local name.
	const fromHelpers = new Map<ts.SourceFile, Map<string, { file: string; name: string }>>();
	const fromHelperOf = (source: ts.SourceFile) => {
		const known = fromHelpers.get(source);
		if (known) return known;
		const imports = new Map<string, { file: string; name: string }>();
		for (const statement of source.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
			const target = moduleFileOf(source.fileName, statement.moduleSpecifier.text);
			const bindings = statement.importClause?.namedBindings;
			if (target === null || !helperTrees.has(target) || !bindings || !ts.isNamedImports(bindings)) continue;
			for (const element of bindings.elements) imports.set(element.name.text, { file: target, name: (element.propertyName ?? element.name).text });
		}
		fromHelpers.set(source, imports);
		return imports;
	};
	for (const { name, fn } of exported.functions) {
		if (!reads.includes(name) || !fn.body) continue;
		// Card 2713 (R2, C6): the read, and on through every function of its own module and of a helper module it reaches,
		// called or referred to, at any depth: this module's functions and each helper's are named on the way, a helper's
		// own functions are not. Each function is read once, so a cycle ends.
		const seen = new Set<ts.Node>([fn.body]);
		const follow = (body: ts.Node, at: ts.SourceFile, path: string[], leaving: ts.Node | undefined): void => {
			const writes = writesIn(body, at);
			const steps: { node: ts.Node; next?: () => void }[] = writes.map((node) => ({ node }));
			for (const reference of referencesIn(body)) {
				if (writes.some((write) => within(reference, write))) continue;
				const imported = fromHelperOf(at).get(reference.text);
				const target = imported ? helperTrees.get(imported.file)! : at;
				const inner = bodyIn(target, imported ? imported.name : reference.text);
				if (!inner || seen.has(inner)) continue;
				seen.add(inner);
				const hop = imported ? `${imported.file}#${imported.name}` : at === tree ? reference.text : undefined;
				steps.push({ node: reference, next: () => follow(inner, target, hop ? [...path, hop] : path, at === tree ? reference : leaving) });
			}
			steps.sort((a, b) => a.node.getStart(at) - b.node.getStart(at));
			for (const { node, next } of steps) {
				if (next) {
					next();
					continue;
				}
				const where = at === tree ? node : leaving!;
				findings.push(`${file}:${line(where)} ${name} is on READS and writes: ${writeText(node, at)}${path.length > 0 ? ` (through ${path.join(' → ')})` : ''} (3)`);
			}
		};
		follow(fn.body, tree, [], undefined);
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
	return { reads, writes, pageOptions, findings: [...new Set(findings)], helpers, writers };
}

/**
 * Rules 1 and 2 for one route file: the calls of every write handler in it
 * that calls a service, and every call of a service's function anywhere in
 * it. `services` is each service module's file with its reads and writes.
 */
function judgeServiceCalls(file: string, source: string, services: Map<string, { reads: string[]; writes: string[]; pageOptions?: string[] }>): string[] {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const findings: string[] = [];
	const { names, namespaces } = serverImportsOf(tree, file);
	for (const namespace of namespaces) {
		if (services.has(namespace.file)) findings.push(`${file}:${namespace.line} imports ${namespace.file} as a namespace: import its functions by name`);
	}
	const serviceOf = (local: string) => {
		const from = names.get(local);
		const service = from && services.get(from.file);
		if (!from || !service) return undefined;
		return {
			...from,
			read: service.reads.includes(from.name),
			write: service.writes.includes(from.name),
			pageOptions: service.pageOptions?.includes(from.name) ?? false
		};
	};
	/** The uses of a page route's options constant that are the options of a write of its own module (the card 2296 review). */
	const pageOptionsHanded = new Set<ts.Node>();
	if (![...names.keys()].some((local) => serviceOf(local))) return findings;

	const handlers = handlersOf(tree);
	const writeAsCallbacks = callsIn(tree, true)
		.filter((call) => calleeOf(call, tree) === 'writeAs')
		.map((call) => call.arguments[1])
		.filter(isCallback);
	// confirmStepUp's guard (card 2701) runs in a writeAs of its own, read only:
	// a read in it is as one in a writeAs callback, and a write is refused.
	const stepUpGuards = callsIn(tree, true)
		.filter((call) => calleeOf(call, tree) === 'confirmStepUp')
		.map((call) => call.arguments[4])
		.filter(isCallback);
	const insideGuard = (node: ts.Node) => stepUpGuards.some((guard) => within(node, guard));
	const insideCallback = (node: ts.Node) => writeAsCallbacks.some((callback) => within(node, callback)) || insideGuard(node);
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
		// Or the write's own module's page options, whole or spread into an object
		// written out (the card 2296 review): written out there, and read there.
		const ownPageOptions = (node: ts.Expression) => {
			if (!ts.isIdentifier(node) || declaredNearer(node, node.text)) return false;
			const constant = serviceOf(node.text);
			return constant !== undefined && constant.pageOptions && constant.file === serviceOf(name)?.file;
		};
		if (options && ownPageOptions(options)) {
			pageOptionsHanded.add(options);
			return;
		}
		const spreads = options && ts.isObjectLiteralExpression(options) ? options.properties.filter(ts.isSpreadAssignment) : [];
		if (!options || !ts.isObjectLiteralExpression(options) || spreads.some((spread) => !ownPageOptions(spread.expression))) {
			findings.push(`${file}:${line(call)} hands ${name} options that are not an object written out at the call (4)`);
			return;
		}
		for (const spread of spreads) pageOptionsHanded.add(spread.expression);
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
			if (service?.pageOptions) {
				// Its call was judged first: the callee comes before the options in the tree.
				if (!pageOptionsHanded.has(node)) {
					findings.push(`${file}:${line(node)} uses ${node.text} of ${service.file} other than as the options of a write of that module (4)`);
				}
			} else if (service) {
				const call = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : undefined;
				const handler = handlers.find(({ fn }) => fn !== undefined && within(node, fn));
				if (!call) {
					findings.push(`${file}:${line(node)} uses ${node.text} of ${service.file} other than by calling it`);
				} else if (service.write && (!insideCallback(call) || insideGuard(call))) {
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

/**
 * Card 2681 (S1 of its plan review): every call, in a v1 route file, of a
 * write of a module on SERVICES hands as its fourth argument an object written
 * out at the call whose `source` is the literal `'api'`. The people service
 * refuses a key by the credential as well (`writingWithKey()`), but a v1 route
 * that passed `'ui'` would have its activity and its refusals recorded as the
 * page's. Answers the findings and how many calls were read.
 */
function judgeV1Sources(
	file: string,
	source: string,
	services: Map<string, { reads: string[]; writes: string[] }>
): { findings: string[]; calls: number } {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const { names } = serverImportsOf(tree, file);
	const findings: string[] = [];
	let calls = 0;
	for (const call of callsIn(tree, true)) {
		if (!ts.isIdentifier(call.expression)) continue;
		const from = names.get(call.expression.text);
		if (!from || !services.get(from.file)?.writes.includes(from.name)) continue;
		calls++;
		const where = `${file}:${line(call)} ${call.expression.text}`;
		const options = call.arguments[3] && bare(call.arguments[3]);
		if (!options || !ts.isObjectLiteralExpression(options)) {
			findings.push(`${where} is not handed its options as an object written out at the call`);
			continue;
		}
		if (options.properties.some((p) => ts.isSpreadAssignment(p))) findings.push(`${where} is handed options with a spread: write source out`);
		const said = options.properties.find((p) => p.name !== undefined && p.name.getText(tree) === 'source');
		if (!said) findings.push(`${where} is handed no source`);
		else if (!ts.isPropertyAssignment(said) || !ts.isStringLiteral(said.initializer) || said.initializer.text !== 'api') {
			findings.push(`${where} is handed source ${said.getText(tree)}, not 'api'`);
		}
	}
	return { findings, calls };
}

/**
 * Card 2682 (D7, plan review fit D5): the reads under src/routes/api/v1 that
 * take the tree a request came through, each by the index of its options
 * argument. `writingWithKey()` is false outside a `writeAs` callback, so a
 * read cannot ask the credential: it rests on the route's word, which must be
 * the literal `'api'`, as a write's must (`judgeV1Sources`). Keyed by
 * `<module>#<name>` (code review F7), so that a function of the same name in
 * another module is not passed by this one's entry.
 */
const V1_READS: Record<string, number> = {
	'src/lib/server/decision-register.ts#readRegister': 2,
	'src/lib/server/decision-authoring.ts#readDecisionForKey': 2,
	'src/lib/server/decision-questions.ts#readQuestions': 2,
	'src/lib/server/decision-results.ts#readSummary': 2,
	'src/lib/server/decision-register.ts#readRecord': 3
};

/** The reads whose argument at the index is a mode written out, `'api'` under v1 (card 2680's `registerQueryOf`), by `<module>#<name>`. */
const V1_MODES: Record<string, number> = { 'src/lib/server/decision-register.ts#registerQueryOf': 1 };

/**
 * The functions a v1 route imports whose parameter holds a `source` that is
 * not the tree the request came through, by `<module>#<name>`, with why: the
 * completeness rule of `judgeV1Reads` passes them, and nothing else.
 */
const V1_SOURCE_NOT_THE_TREE: Record<string, string> = {
	'src/lib/server/audit-log.ts#queryAuditLog':
		"Its `params.source` is the audit log's filter of entries by the tree they were written through (`?source=`), " +
		'which the caller chooses; the read gives the same entries to every tree.'
};

/** The key the three maps above are read by: the module's file and the function's exported name (code review F7). */
const v1Key = (from: { file: string; name: string }) => `${from.file}#${from.name}`;

/**
 * Whether an exported function of `tree` named `name` has a parameter typed
 * with a `source` property: an object type literal holding one, or
 * `ServiceOptions`, read through the file's own type aliases, intersections,
 * unions and the type arguments of a generic (`Pick<…>`, `Readonly<…>`).
 * Every declaration counts, an overload's among them.
 */
function takesASource(tree: ts.SourceFile, name: string): boolean {
	const aliases = new Map<string, ts.TypeNode>();
	for (const statement of tree.statements) if (ts.isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement.type);
	const holds = (type: ts.TypeNode | undefined, seen: ReadonlySet<string>): boolean => {
		if (type === undefined) return false;
		if (ts.isTypeLiteralNode(type)) return type.members.some((member) => member.name !== undefined && member.name.getText(tree).replace(/['"]/g, '') === 'source');
		if (ts.isIntersectionTypeNode(type) || ts.isUnionTypeNode(type)) return type.types.some((inner) => holds(inner, seen));
		if (ts.isParenthesizedTypeNode(type)) return holds(type.type, seen);
		if (ts.isTypeReferenceNode(type)) {
			const named = type.typeName.getText(tree);
			if (named === 'ServiceOptions') return true;
			const alias = aliases.get(named);
			if (alias !== undefined && !seen.has(named)) return holds(alias, new Set([...seen, named]));
			return (type.typeArguments ?? []).some((inner) => holds(inner, seen));
		}
		return false;
	};
	const exported = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
	const signatures: ts.SignatureDeclaration[] = [];
	for (const statement of tree.statements) {
		if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && exported(statement)) signatures.push(statement);
		if (ts.isVariableStatement(statement) && exported(statement)) {
			for (const declared of statement.declarationList.declarations) {
				const value = declared.initializer && bare(declared.initializer);
				if (ts.isIdentifier(declared.name) && declared.name.text === name && value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) signatures.push(value);
			}
		}
	}
	return signatures.some((fn) => fn.parameters.some((parameter) => holds(parameter.type, new Set())));
}

/**
 * D7 for the reads of one v1 route file: each call of a read on `V1_READS`
 * hands, at its index, an object written out at the call whose `source` is
 * the literal `'api'`, with no spread; each call of one on `V1_MODES` hands
 * the literal `'api'` at its index; neither is used but by calling it. And
 * the completeness rule: a function the file imports from src/lib/server
 * that takes a source (`takesASource`) and is not a write of a module on
 * SERVICES must be on `V1_READS`. `signatureOf(file, name)` answers whether
 * the module's export takes a source. Answers the findings and how many read
 * and mode calls were read.
 */
function judgeV1Reads(
	file: string,
	source: string,
	services: Map<string, { reads: string[]; writes: string[] }>,
	signatureOf: (module: string, name: string) => boolean
): { findings: string[]; reads: number; modes: number } {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const { names } = serverImportsOf(tree, file);
	const findings: string[] = [];
	let reads = 0;
	let modes = 0;

	for (const [local, from] of names) {
		if (services.get(from.file)?.writes.includes(from.name)) continue;
		const key = v1Key(from);
		if (Object.hasOwn(V1_READS, key) || Object.hasOwn(V1_MODES, key) || Object.hasOwn(V1_SOURCE_NOT_THE_TREE, key)) continue;
		if (signatureOf(from.file, from.name)) findings.push(`${file} imports ${local} from ${from.file}, which takes a source: name it on V1_READS`);
	}

	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && usedAsName(node) && !isDeclaredName(node) && !ts.isImportSpecifier(node.parent) && !ts.isImportClause(node.parent)) {
			const from = names.get(node.text);
			const key = from === undefined ? undefined : v1Key(from);
			const index = key === undefined ? undefined : Object.hasOwn(V1_READS, key) ? V1_READS[key] : Object.hasOwn(V1_MODES, key) ? V1_MODES[key] : undefined;
			if (from !== undefined && key !== undefined && index !== undefined) {
				const call = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : undefined;
				const where = `${file}:${line(node)} ${node.text}`;
				const argument = call?.arguments[index] && bare(call.arguments[index]);
				if (!call) {
					findings.push(`${where} is used other than by calling it`);
				} else if (Object.hasOwn(V1_MODES, key)) {
					modes++;
					if (!argument || !ts.isStringLiteral(argument) || argument.text !== 'api') findings.push(`${where} is handed the mode ${argument ? argument.getText(tree) : 'nothing'}, not 'api'`);
				} else {
					reads++;
					if (!argument || !ts.isObjectLiteralExpression(argument)) {
						findings.push(`${where} is not handed its options as an object written out at the call`);
					} else {
						if (argument.properties.some((p) => ts.isSpreadAssignment(p))) findings.push(`${where} is handed options with a spread: write source out`);
						const said = argument.properties.find((p) => p.name !== undefined && p.name.getText(tree) === 'source');
						if (!said) findings.push(`${where} is handed no source`);
						else if (!ts.isPropertyAssignment(said) || !ts.isStringLiteral(said.initializer) || said.initializer.text !== 'api') {
							findings.push(`${where} is handed source ${said.getText(tree)}, not 'api'`);
						}
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return { findings, reads, modes };
}

/**
 * Card 2681 (the code review's S2): a route file imports a module of
 * src/lib/server only as `$lib/server/<path>`, with no `.js` or `.ts` on the
 * end and no `.` or `..` in it, by `import`, `export … from` and `import()`
 * alike. The scans read imports through `moduleFileOf`, which sees through the
 * other forms; this keeps every route written the one way the tests and a
 * reader search for.
 */
function judgeServerImportForms(file: string, source: string): string[] {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const findings: string[] = [];
	const judge = (specifier: ts.StringLiteralLike) => {
		const text = specifier.text;
		const target = moduleFileOf(file, text);
		if (target === null || !(target.startsWith('src/lib/server/') || target === 'src/lib/server.ts')) return;
		const parts = text.split('/');
		const written = (text === '$lib/server' || text.startsWith('$lib/server/')) && !/\.(?:js|ts)$/.test(text) && !parts.includes('..') && !parts.includes('.');
		if (!written) findings.push(`${file}:${line(specifier)} imports ${target} as '${text}': import src/lib/server only as $lib/server/<path>, with no extension (S2)`);
	};
	const visit = (node: ts.Node): void => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) judge(node.moduleSpecifier);
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
			judge(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return findings;
}

/**
 * Card 2682 (D33, plan review S8): the writes the page asks the caller's
 * password for once the decision was ever opened, each keyed `module#name`
 * (card 2713, D6 row 7: by the module that exports it, not by a path a move
 * could leave empty). Every route outside src/routes/api/v1 that calls either
 * must be a handler on CURRENT_PASSWORD; v1 is refused by the credential in
 * the service (D5). Since card 2726 the service also refuses an opened one at
 * run time unless `passwordHeld()` (`requirePasswordHeld`); this scan stays
 * as the earlier warning, on the source, before any request (card 2726, D5).
 */
const PASSWORD_WRITES = ['src/lib/server/decision-lifecycle-writes.ts#deleteDecision', 'src/lib/server/decision-lifecycle-writes.ts#withdrawDecision'];

/** The modules `PASSWORD_WRITES` names. */
const PASSWORD_MODULES = [...new Set(PASSWORD_WRITES.map((key) => key.slice(0, key.indexOf('#'))))];

/**
 * D33 for one file under src/routes outside v1: each handler that calls a
 * write of `PASSWORD_WRITES` (as the imported function, by any local name) is
 * on `listed`; a call outside every handler, a namespace import of a module
 * `PASSWORD_WRITES` names, and any import of one by a file that is no
 * `+server.ts` (a page's server file, a helper) are findings outright.
 */
function judgePasswordWrites(file: string, source: string, listed: readonly string[]): string[] {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const { names, namespaces } = serverImportsOf(tree, file);
	const findings: string[] = [];
	for (const namespace of namespaces) {
		if (PASSWORD_MODULES.includes(namespace.file)) findings.push(`${file}:${namespace.line} imports ${namespace.file} as a namespace (D33)`);
	}
	const locals = new Map([...names].filter(([, from]) => PASSWORD_WRITES.includes(v1Key(from))).map(([local, from]) => [local, from.name]));
	if (locals.size === 0) return findings;
	if (!file.endsWith('/+server.ts')) {
		return [...findings, ...[...locals.values()].map((name) => `${file} imports ${name}, which only a handler on CURRENT_PASSWORD may call (D33)`)];
	}
	const handlers = handlersOf(tree);
	for (const call of callsIn(tree, true)) {
		if (!ts.isIdentifier(call.expression) || !locals.has(call.expression.text)) continue;
		const name = locals.get(call.expression.text)!;
		const handler = handlers.find(({ fn }) => fn !== undefined && within(call, fn));
		if (!handler) findings.push(`${file}:${line(call)} calls ${name} outside every handler (D33)`);
		else if (!listed.includes(`${file} ${handler.method}`)) findings.push(`${file}:${line(call)} ${handler.method} calls ${name} and is not on CURRENT_PASSWORD (D33)`);
	}
	return findings;
}

/**
 * Card 2726's code review (2026-11-05): the two ways a write is held to the
 * password a handler has just checked, each by the file that defines it.
 * `whilePasswordHolds` is also what sets `passwordHeld()`, which
 * `deleteDecision` and `withdrawDecision` ask for themselves. The proof takes
 * the hash as an argument, and any server code can read that from the row,
 * so what gives it its meaning is where it may be written: only in a handler
 * allowed it (`judgePasswordProofs`), which asks for the password before it.
 */
const PROOF_DEFINED_IN: Record<string, string> = {
	whilePasswordHolds: 'src/lib/server/auth.ts',
	requirePasswordUnchanged: 'src/lib/server/step-up.ts'
};

/**
 * The handlers that ask for the current password but hold what they guard with
 * `requirePasswordUnchanged` alone, since it cannot run in a transaction: the
 * import's restore, the export's copy, a backup run and the report mail's
 * sends (card 2751). They are not on
 * CURRENT_PASSWORD, whose (d) holds a handler to `whilePasswordHolds`, and may
 * not use it.
 */
const PASSWORD_UNCHANGED_ONLY = [
	'src/routes/api/admin/import/+server.ts POST',
	'src/routes/api/admin/export/+server.ts POST',
	'src/routes/api/admin/backup/+server.ts POST',
	// Card 2751 (D8, S5): the report mail, whose every send is held to the hash checked.
	'src/routes/api/reports/email/+server.ts POST'
];

/** By proof, the handlers that may use it, and the lists they are on, for the findings. */
const PROOF_ALLOWED: Record<string, { keys: readonly string[]; lists: string }> = {
	whilePasswordHolds: { keys: CURRENT_PASSWORD, lists: 'CURRENT_PASSWORD' },
	requirePasswordUnchanged: { keys: [...CURRENT_PASSWORD, ...PASSWORD_UNCHANGED_ONLY], lists: 'CURRENT_PASSWORD or PASSWORD_UNCHANGED_ONLY' }
};

/**
 * What asks for the current password, one of which a handler allowed a proof
 * calls before it. The Account page's three routes asked through
 * `checkCurrentPassword` until card 2771, and through `confirmStepUp` since:
 * the check itself, `checkCurrentProof`, is the step-up's alone (T12, below).
 */
const ASKS_PASSWORD = ['confirmStepUp', 'takeImportConfirmation'];

/**
 * Card 2771 (D5, S6): where the current password's check may be named, by
 * name: `checkCurrentProof` and `refuseWrongPassword` in auth.ts, which
 * declares them, and step-up.ts, which imports and calls them; the check they
 * replaced, nowhere.
 */
const PROOF_CHECK_NAMED_IN: Readonly<Record<string, readonly string[]>> = {
	checkCurrentProof: ['src/lib/server/auth.ts', 'src/lib/server/step-up.ts'],
	refuseWrongPassword: ['src/lib/server/auth.ts', 'src/lib/server/step-up.ts'],
	checkCurrentPassword: []
};

/** Card 2771 (S6): the files that may call `checkPassword` (passwords.ts): sign-in, and the current password's check. */
const CHECK_PASSWORD_CALLED_IN = ['src/routes/login/+page.server.ts', 'src/lib/server/auth.ts'];

/** Every identifier of a source, with its line: a TypeScript file's, or those of each `<script>` of a Svelte file. Comments name nothing. */
function identifiersOf(file: string, source: string): { id: ts.Identifier; line: number; tree: ts.SourceFile }[] {
	const scripts = file.endsWith('.svelte')
		? [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => ({ text: match[1], offset: source.slice(0, match.index).split('\n').length - 1 }))
		: [{ text: source, offset: 0 }];
	const found: { id: ts.Identifier; line: number; tree: ts.SourceFile }[] = [];
	for (const { text, offset } of scripts) {
		const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		const visit = (node: ts.Node) => {
			if (ts.isIdentifier(node)) found.push({ id: node, line: offset + tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, tree });
			ts.forEachChild(node, visit);
		};
		visit(tree);
	}
	return found;
}

/**
 * Card 2771 (D5, S6; T12) for one file under src: the current password's
 * check is named only where `PROOF_CHECK_NAMED_IN` lets it be, no file
 * re-exports every name of auth.ts, and `checkPassword` is called only in
 * `CHECK_PASSWORD_CALLED_IN`. A right password found any other way would be
 * a password check without its code.
 */
function judgeProofCheck(file: string, source: string): string[] {
	const findings: string[] = [];
	const ids = identifiersOf(file, source);
	for (const [name, allowed] of Object.entries(PROOF_CHECK_NAMED_IN)) {
		if (allowed.includes(file)) continue;
		for (const { line } of ids.filter(({ id }) => id.text === name)) findings.push(`${file}:${line} names ${name} (card 2771)`);
	}
	if (file !== 'src/lib/server/auth.ts' && !file.endsWith('.svelte')) {
		const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		for (const statement of tree.statements) {
			if (
				ts.isExportDeclaration(statement) &&
				!statement.exportClause &&
				statement.moduleSpecifier &&
				ts.isStringLiteral(statement.moduleSpecifier) &&
				/(^|\/)auth$/.test(statement.moduleSpecifier.text)
			) {
				findings.push(`${file}:${tree.getLineAndCharacterOfPosition(statement.getStart(tree)).line + 1} re-exports every name of auth.ts, checkCurrentProof among them (card 2771)`);
			}
		}
	}
	if (!CHECK_PASSWORD_CALLED_IN.includes(file)) {
		for (const { id, line } of ids.filter(({ id }) => id.text === 'checkPassword')) {
			const call = ts.isPropertyAccessExpression(id.parent) && id.parent.name === id ? id.parent.parent : id.parent;
			const callee = ts.isPropertyAccessExpression(id.parent) && id.parent.name === id ? id.parent : id;
			if (ts.isCallExpression(call) && call.expression === callee) findings.push(`${file}:${line} calls checkPassword (card 2771, S6)`);
		}
	}
	return findings;
}

/**
 * Card 2726's code review for one file under src: each use of a proof of
 * `PROOF_DEFINED_IN` (a call, a reference, a property or a text naming it) is
 * inside a handler of a `+server.ts` that `allowed` lets use it. In the file
 * that defines it, only its own declaration names it. A plain import names it
 * and does nothing; one under another name, a re-export of every name of the
 * defining file, and any `.svelte` file naming it are findings outright, so
 * a page action, a `$lib` helper and a handler not listed are all found.
 */
function judgePasswordProofs(file: string, source: string, allowed: Readonly<Record<string, { keys: readonly string[]; lists: string }>>): string[] {
	const proofs = Object.keys(PROOF_DEFINED_IN);
	if (file.endsWith('.svelte')) {
		return proofs.filter((name) => new RegExp(`\\b${name}\\b`).test(source)).map((name) => `${file} names ${name}, which only a handler on ${allowed[name].lists} may use (card 2726)`);
	}
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const handlers = file.endsWith('/+server.ts') ? handlersOf(tree) : [];
	const findings: string[] = [];
	const judge = (node: ts.Identifier | ts.StringLiteralLike, name: string): void => {
		const at = `${file}:${line(node)}`;
		if (file === PROOF_DEFINED_IN[name]) {
			const declared = ts.isFunctionDeclaration(node.parent) && node.parent.name === node;
			if (!declared) findings.push(`${at} uses ${name} outside its own declaration (card 2726)`);
			return;
		}
		if (ts.isImportSpecifier(node.parent)) {
			if (node.parent.propertyName === node) findings.push(`${at} imports ${name} under another name (card 2726)`);
			return;
		}
		const handler = handlers.find(({ fn }) => fn !== undefined && within(node, fn));
		if (!handler) findings.push(`${at} uses ${name} outside every handler on ${allowed[name].lists} (card 2726)`);
		else if (!allowed[name].keys.includes(`${file} ${handler.method}`)) findings.push(`${at} ${handler.method} uses ${name} and is not on ${allowed[name].lists} (card 2726)`);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			const target = moduleFileOf(file, node.moduleSpecifier.text);
			for (const name of proofs) {
				if (target === PROOF_DEFINED_IN[name]) findings.push(`${file}:${line(node)} re-exports every name of ${target}, ${name} among them (card 2726)`);
			}
		}
		const isModuleName = node.parent !== undefined && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) && node.parent.moduleSpecifier === node;
		if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && !isModuleName && proofs.includes(node.text)) judge(node, node.text);
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return findings;
}

// ─── Card 2702: who may write the webhooks table ────────────────────────────

/** What a webhook writer may do: only switch webhooks off (or blank a secret), or set an address, a secret or on. */
type WebhookWriter = { does: 'switches off only' | 'sets'; writes: number; why: string };

/**
 * Card 2702 (decisions 4 and 5, plan review P1, P6, P7): every function that
 * writes the webhooks table, keyed `file#function` (the innermost named
 * function round the write), with what it does and how many writes it holds.
 * A webhook sends a board's events to an address its setter chose, so a write
 * that can set the address or the secret, or switch one on, is a way out for
 * the board's data. Today only an API key reaches one (v1 reads no session,
 * and a key takes the current password to make); a screen that writes one
 * must ask the current password first. Deletes reduce access and are not
 * writes here.
 */
const WEBHOOK_WRITERS: Record<string, WebhookWriter> = {
	'src/routes/api/v1/boards/[boardId]/webhooks/+server.ts#POST': {
		does: 'sets',
		writes: 2,
		why:
			'Creates a webhook. Only an API key reaches it: the gate reads no session under /api/v1/, and a key takes the current password to make. What a key may do is card 2703. ' +
			'The second write seals its secret, bound to the id the insert gave it, in the same transaction (card 2898, decision 19).'
	},
	'src/routes/api/v1/webhooks/[webhookId]/+server.ts#PUT': {
		does: 'sets',
		writes: 1,
		why: 'Changes a webhook: its address, secret, events or on and off. Only an API key reaches it, as for POST; card 2703.'
	},
	'src/lib/server/webhooks.ts#holdInScope': {
		does: 'switches off only',
		writes: 1,
		why:
			"An administrator's password set, an invite used, a holder's own change that ends their keys, a disable (card 2671), a reset of the two-step sign-in (card 2915) and a delete switch off the webhooks the account set (card 2168), recording the hold 'setter access ended' (card 2752's code review, CS4); " +
			"those already switched off without a hold are held in the same statement, active left off (card 2923); with them every webhook whose secret the account could read as an owner or administrator, and the same for a lowered role and the start pass (card 2935); " +
				'and every webhook with a secret an API key was given, when that key is revoked, expires or passes its deadline (card 2947). The one statement of all of them (card 2923\'s code review, E4).'
	},
	'src/lib/server/webhooks.ts#holdUnheldOfGoneSetters': {
		does: 'switches off only',
		writes: 1,
		why: "Holds, 'setter access ended', webhooks already switched off without a hold, active left off: those whose setter is disabled or not recorded at every start and in every restore, every one once (card 2923, S3; its code review, S2, S3, E3)."
	},
	'src/lib/server/db/restore.ts#switchOffOutside': {
		does: 'switches off only',
		writes: 1,
		why: 'A restore kept apart from the outside switches every webhook off.'
	},
	'src/lib/server/backup-secrets.ts#clearSecrets': {
		does: 'switches off only',
		writes: 2,
		why:
			"Blanks the signing secrets in a backup's working copy and switches those webhooks off; never the running database (card 2169). " +
			'And blanks every address there the same way, in a statement of its own (card 2928).'
	},
	'src/lib/server/backup-secrets.ts#fillSecretGaps': {
		does: 'sets',
		writes: 2,
		why:
			"An import's restore refills a secret from this server's own, for the same webhook only, and sets it on or off as the backup had it, never on where it is held off here or in the restored row, whose hold it keeps (card 2752). " +
			'The second write switches on a webhook whose address alone the backup left out, once that address is filled and opens, after the holds are carried (card 2928, R19). ' +
			'It runs behind the import’s confirmation of the password (POST /api/admin/import/confirm, on STEP_UP_ACTIONS); its importers are pinned (WEBHOOK_WRITER_IMPORTERS).'
	},
	'src/lib/server/backup-secrets.ts#fillAddressGaps': {
		does: 'sets',
		writes: 1,
		why:
			"An import's restore refills an address a backup left out from this server's own, sealed, byte for byte, for the same webhook only (its id, board, receiver, setter and the backup's match of the address), switching nothing on (card 2928). " +
			'Behind the same confirmation of the password as fillSecretGaps; pinned to the restore.'
	},
	'src/lib/server/webhooks.ts#switchOffHeld': {
		does: 'switches off only',
		writes: 1,
		why: "Switches a webhook off for good when its setter can no longer open the board, recording why and when (card 2752): active off, held_because and held_at, and nothing else."
	},
	// Card 2995 (R8): a key the restore left out, or a disabled account's key it deleted, named by no webhook.
	'src/lib/server/db/restore.ts#forgetSetByKey': {
		does: 'switches off only',
		writes: 1,
		why: "A restore empties set_by_key on every webhook a key it deleted set, as the foreign key's ON DELETE SET NULL does with the foreign keys on; the hold rule reads that as 'key ended' (card 2995, R8)."
	},
	'src/lib/server/db/restore.ts#carryHolds': {
		does: 'switches off only',
		writes: 1,
		why:
			"A restore carries this server's hold onto the same webhook restored, so that no restore switches back on one held off here (card 2752's code review, CS5): active off, held_because and held_at. " +
			"The same webhook by its id and creation time, or by its id alone where either time names no moment, whatever board, address or setter the backup's copy names (card 3004, plan 3.6, R16 Q2). " +
			"A row card 3012 held for a backup whose seal did not verify takes this server's reason only where both addresses open and are equal, and keeps its own otherwise (R3): held either way."
	},
	// Card 3004 (plan 3.4, R10): a restore closing each restored webhook to this server's state and record.
	'src/lib/server/db/restore.ts#applyOutboundWebhooks': {
		does: 'switches off only',
		writes: 3,
		why:
			"A restore closes each restored webhook to its state here and this server's record of where it sends: one deleted here, not in the record or re-pointed held for good, active off, held_because and held_at; " +
			"its secret discarded, active off, in a second statement; and one switched off here, or recorded off, switched off with no hold in a third (card 3004)."
	},
	// Card 3004 (plan 3.10, R4): the start's and five-minute pass closing each live webhook to this server's record.
	'src/lib/server/startup-checks.ts#holdOutboundAtStart': {
		does: 'switches off only',
		writes: 3,
		why:
			"The start's and five-minute pass closes each live webhook with no hold to this server's record of where it sends, only where a row of its own names it: one recorded deleted, re-pointed or held is held for good, active off, held_because and held_at; " +
			"one recorded deleted or re-pointed has its secret discarded, active off, in a second statement; and one recorded off is switched off with no hold in a third (card 3004)."
	},
	// Card 3012 (R1, R2): a restore of a backup whose seal did not verify.
	'src/lib/server/db/restore.ts#holdUnsealedWebhooks': {
		does: 'switches off only',
		writes: 2,
		why:
			"A restore of a backup whose seal did not verify holds every restored webhook with an address, its secret blanked: active off, secret '', held_because and held_at (R1); " +
			'and switches off every one with no address, not held, in a second statement (R2).'
	},
	// Card 2898 (E15): the start's sealing of the stored secrets, each the same secret as it was.
	'src/lib/server/stored-secrets.ts#sealPlainSecrets': {
		does: 'sets',
		writes: 1,
		why:
			'Seals, at every start, each webhook secret held in plain: the same secret, sealed in place, matched on the plain value it read (card 2898, decision 6); ' +
			'and each address held in plain with its receiver worked out again, in the same statement (card 2928).'
	},
	'src/lib/server/stored-secrets.ts#resealStoredSecrets': {
		does: 'sets',
		writes: 1,
		why: 'Seals each webhook secret of the previous MFA key again under the new one at a start that changes the key: the same secret, matched on the envelope it read (card 2898, decision 12).'
	},
	'src/lib/server/stored-secrets.ts#forgetStoredSecrets': {
		does: 'switches off only',
		writes: 2,
		why:
			"Forgets, at a start with no key check stored and nothing sealed opening, each webhook's secret as a backup does: blanked, switched off and listed (card 2898, decision 10); " +
			'and each webhook address the same way, in a second statement (card 2928).'
	},
	'src/lib/server/stored-secrets.ts#forgetSecretsBesideNoAddress': {
		does: 'switches off only',
		writes: 1,
		why:
			"Forgets, at every start that finds one, each webhook secret held in plain beside an address that is '' or does not open, which is never sealed against it: blanked, switched off and listed (card 2928, R5; its code review, C2)."
	}
};

/**
 * A listed writer reachable from elsewhere, and the only `file#function`s that may refer to it, each once
 * (plan review P7; code review K5): any other reference, in its own module too, is a finding, and only the
 * callers' files may import it.
 */
const WEBHOOK_WRITER_CALLERS: Record<string, readonly string[]> = {
	'src/lib/server/backup-secrets.ts#fillSecretGaps': ['src/lib/server/db/restore.ts#restoreInOneSnapshot'],
	// Card 2928: the restore alone fills an address a backup left out.
	'src/lib/server/backup-secrets.ts#fillAddressGaps': ['src/lib/server/db/restore.ts#restoreInOneSnapshot'],
	// Card 2923 (S3): the start-up pass and the restore (a working copy included, its code review's S3).
	'src/lib/server/webhooks.ts#holdUnheldOfGoneSetters': [
		'src/lib/server/startup-checks.ts#holdAlreadyOffWebhooksAtStart',
		'src/lib/server/db/restore.ts#holdRestoredAlreadyOff'
	],
	// Card 2935: the one hold statement (`holdInScope`, not exported, so reachable from no other file) is held to its
	// three exported callers below, each pinned to its own callers.
	// Card 2923's code review (E4): the endings of an account's access.
	'src/lib/server/webhooks.ts#holdWebhooksOfSetter': ['src/lib/server/auth.ts#endAccountAccess', 'src/lib/server/deletes.ts#deleteUser'],
	// Card 2935 (P2): the two writes that lower an owner's or an administrator's role.
	// Card 2996 (R5): the role change's body, shared by PUT /api/users/{id} and the start's pass, in account-ending-bodies.ts.
	// Card 3002 (R3, R6): and the start's access pass, for an owner row it lowered or removed, or a creator it cleared.
	'src/lib/server/webhooks.ts#holdNoLongerReadable': [
		'src/lib/server/account-ending-bodies.ts#changeAccountRole',
		'src/routes/api/boards/[id]/share/+server.ts#POST',
		'src/routes/api/boards/[id]/share/+server.ts#DELETE',
		'src/lib/server/startup-checks.ts#capAccessAtStart'
	],
	// Card 2996 (R7): what every account the record of account endings ended or lowered in a restore could read, held
	// on the restore's own connection.
	'src/lib/server/webhooks.ts#holdNoLongerReadableIn': ['src/lib/server/db/restore.ts#restoreInOneSnapshot'],
	// Card 3004 (comment 3): what an account the restore's password reset ended set or could read, held on its own connection.
	'src/lib/server/webhooks.ts#holdResetSettersIn': ['src/lib/server/db/restore.ts#restoreInOneSnapshot'],
	// Card 2935 (P4, P12): the start pass and the restore.
	'src/lib/server/webhooks.ts#coverReadable': ['src/lib/server/startup-checks.ts#holdReadableWebhooksAtStart', 'src/lib/server/db/restore.ts#holdRestoredReadable'],
	// Card 2947 (R3): what an API key was given, held by its revoke and by the sweep of ended keys, which the start
	// and its five-minute timer run.
	// And by the server's own restore (R1, R2), never failing open.
	// Card 2995 (R7): the revoke's body, extracted as revokeApiKeys, which the revoke and the start's pass for a present
	// key the record of ended keys names both run.
	'src/lib/server/webhooks.ts#holdRevealed': ['src/lib/server/api-key-revoke.ts#revokeApiKeys'],
	// Its code review (FP1): the restore holds on its own connection, a working copy's included.
	'src/lib/server/webhooks.ts#holdRevealedIn': ['src/lib/server/db/restore.ts#restoreInOneSnapshot'],
	'src/lib/server/webhooks.ts#holdRevealsOfEndedKeys': ['src/lib/server/startup-checks.ts#sweepEndedKeyReveals', 'src/lib/server/db/restore.ts#restoreInOneSnapshot'],
	// Card 2898 (E15): the start alone seals, seals again and forgets the stored secrets.
	'src/lib/server/stored-secrets.ts#sealPlainSecrets': ['src/lib/server/startup-checks.ts#sealStoredSecretsAtStart'],
	'src/lib/server/stored-secrets.ts#resealStoredSecrets': ['src/lib/server/startup-checks.ts#startWithMfaKey'],
	'src/lib/server/stored-secrets.ts#forgetStoredSecrets': ['src/lib/server/startup-checks.ts#startWithMfaKey'],
	// Card 2928 (R5; its code review, C2): the start's sealing step alone.
	'src/lib/server/stored-secrets.ts#forgetSecretsBesideNoAddress': ['src/lib/server/startup-checks.ts#sealStoredSecretsAtStart']
};

/** The made-up files of the rule's own examples (card 2702), in place of auth.ts and deletes.ts. */
const EXAMPLE_AUTH = 'src/lib/server/example-auth.ts';
const EXAMPLE_DELETES = 'src/lib/server/example-deletes.ts';

/**
 * The rule's own examples (card 2702) were written as auth.ts's endAccountAccess and deletes.ts's deleteUser, each
 * listed as switching off only, until card 2923's code review (E4) moved their one write into webhooks.ts
 * (`holdWebhooksOfSetter`): the inventory as it is, with the two kept as examples, in made-up files of their own.
 */
const EXAMPLE_WRITERS: Record<string, WebhookWriter> = {
	...WEBHOOK_WRITERS,
	[`${EXAMPLE_AUTH}#endAccountAccess`]: { does: 'switches off only', writes: 1, why: "The rule's example of a Drizzle switch-off." },
	[`${EXAMPLE_DELETES}#deleteUser`]: { does: 'switches off only', writes: 1, why: "The rule's example of a SQL switch-off." }
};

/**
 * Card 2702 (code review K2): every string whose whole text is the table's name, by the `file#function`
 * round it, with how many it holds. A string that is the name is how a write is built round the rest of
 * the rule (`'UPDATE ' + 'webhooks'`, `sql.identifier('webhooks')`, `sql.raw('webhooks')`, a second
 * `sqliteTable('webhooks', …)`), so any other is a finding, and so is a listed key holding more or fewer.
 */
const WEBHOOK_NAME_STRINGS: Record<string, { count: number; why: string }> = {
	'src/lib/server/db/schema.ts#(top level)': { count: 1, why: "The table's declaration, sqliteTable('webhooks', …)." },
	'src/lib/server/backup-secrets.ts#clearSecrets': {
		count: 3,
		why:
			"hasColumns(copy, 'webhooks', …): whether a backup's working copy has the columns before its secrets are blanked; " +
			'and twice for its addresses, whether the copy has the columns to read who was on and to blank them (card 2928).'
	},
	'src/lib/server/backup-secrets.ts#readSecretsHere': {
		count: 5,
		why:
			"hasColumns(live, 'webhooks', …) three times, whether this server has the columns before its secrets are read, the hold's of card 2752 among them; " +
			"the type SecretsHere['webhooks']; and once whether it has the columns before its addresses are read (card 2928)."
	},
	'src/lib/server/backup-secrets.ts#fillSecretGaps': {
		count: 5,
		why:
			"hasColumns(live, 'webhooks', …) three times: whether this server has the columns before a secret is refilled, the hold's of card 2752 among them; " +
			'and twice before a webhook whose address alone was left out is switched on, its hold column among them (card 2928).'
	},
	'src/lib/server/backup-secrets.ts#fillAddressGaps': {
		count: 2,
		why: "hasColumns(live, 'webhooks', …) twice: whether this server has the columns before an address is refilled, the setter's among them (card 2928)."
	},
	'src/lib/server/backup-secrets.ts#withHeldApart': {
		count: 1,
		why: "hasColumns(database, 'webhooks', …): whether the database has the hold column before the webhooks held for good are set apart from those to enter (card 2923's code review, E1)."
	},
	'src/lib/server/backup-secrets.ts#secretsToEnter': {
		count: 2,
		why: "hasColumns(database, 'webhooks', …): whether the database has the columns before the webhooks left without a secret are read, and those without an address (card 2928)."
	},
	'src/lib/server/db/restore.ts#switchOffOutside': { count: 1, why: "hasColumns('webhooks', 'active'): whether the restored copy has the column before it is switched off." },
	'src/lib/server/webhooks.ts#(top level)': { count: 1, why: "createLogger('Webhooks'): the label of the module's log lines (the name in another case, which SQLite reads as the same)." },
	'src/routes/api/v1/openapi.json/+server.ts#(top level)': { count: 6, why: "The OpenAPI document's tag 'Webhooks': five operations' tags and the tag's own entry." },
	// Card 2898 (E15): whether a database has the columns before its stored secrets are read, sealed or forgotten.
	'src/lib/server/stored-secrets.ts#anythingSealed': { count: 1, why: "hasColumns(database, 'webhooks', 'secret'): whether a webhook's secret is to be counted as sealed." },
	'src/lib/server/stored-secrets.ts#storedSecretsAtStart': { count: 1, why: "hasColumns(database, 'webhooks', …): whether the webhooks' sealed secrets are to be read at start." },
	// Card 2928: whether a database has the receiver beside each sealed address (migration 0073).
	'src/lib/server/stored-secrets.ts#receiverColumn': { count: 1, why: "hasColumns(database, 'webhooks', 'receiver'): whether a database's webhooks have the receiver column, else '' for each." },
	'src/lib/server/stored-secrets.ts#sealPlainSecrets': {
		count: 2,
		why: "hasColumns(database, 'webhooks', …): whether the webhooks' plain secrets are to be sealed, and whether they have the receiver their plain addresses are sealed against (card 2928)."
	},
	'src/lib/server/stored-secrets.ts#forgetStoredSecrets': { count: 1, why: "hasColumns(database, 'webhooks', …): whether the webhooks' secrets are to be forgotten." },
	'src/lib/server/stored-secrets.ts#sealedForRestore': { count: 1, why: "name === 'webhooks': which of a backup's tables its webhook rows are, whose plain secrets are sealed as a restore reads them (card 2898, S7)." },
	'src/lib/server/db/restore.ts#rowsToRestore': { count: 1, why: "name === 'webhooks': the backup's webhook rows, each secret held in plain sealed as it is read (card 2898, S7)." }
};

/**
 * A string that is the table's name and nothing else: bare, quoted, single-quoted, backticked or bracketed,
 * with a schema before it or not, in any case (SQLite reads names in any case), white space round it allowed.
 * A template's piece is held to the name exactly, white space not allowed: its text is judged as SQL whole.
 */
const WEBHOOK_NAME_STRING = /^\s*(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?webhooks["'`\]]?\s*$/i;

/**
 * Card 2702 (code review K3): where SQL may make a table called webhooks (CREATE TABLE, ALTER TABLE … RENAME
 * TO), by `file#function`, with how many; such SQL anywhere else is a write. The migration runner's alone.
 */
const WEBHOOK_TABLE_MADE: Record<string, { count: number; why: string }> = {
	'src/lib/server/db/expected-schema.ts#(top level)': {
		count: 1,
		why:
			"The migration runner's model of schema.ts (generated by drizzle-kit export, checked by a test and by the build), which it compares the live database with; " +
			'it rebuilds only boards, columns, categories, settings, user_xp and invite_tokens from it.'
	}
};

/** The schema module, and the one module that may import it as a namespace (to hand it to Drizzle whole). */
const WEBHOOK_SCHEMA = 'src/lib/server/db/schema.ts';
const SCHEMA_AS_NAMESPACE = 'src/lib/server/db/index.ts';

/** Between two words of SQL: white space, or a comment, which SQLite reads as white space (code review K3). */
const SQL_GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|--[^\n]*(?:\n|$))`;

/**
 * A write to the table in SQL text (code review K3): INSERT (OR …) INTO, REPLACE INTO, UPDATE (OR …),
 * CREATE (TEMP) TABLE (IF NOT EXISTS) and ALTER TABLE … RENAME TO, the name bare, double- or
 * single-quoted, backticked or bracketed, with a schema before it or not, in any case, across lines and
 * with comments between the words. A longer name (`webhooks_old`) is another table. CREATE and ALTER
 * are writes outside the migration runner's model (WEBHOOK_TABLE_MADE).
 */
const WEBHOOK_SQL_WRITE = new RegExp(
	String.raw`\b(INSERT(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+INTO|REPLACE${SQL_GAP}+INTO|UPDATE(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?` +
		String.raw`|CREATE(?:${SQL_GAP}+TEMP(?:ORARY)?)?${SQL_GAP}+TABLE(?:${SQL_GAP}+IF${SQL_GAP}+NOT${SQL_GAP}+EXISTS)?` +
		String.raw`|ALTER${SQL_GAP}+TABLE[^;]*?${SQL_GAP}RENAME${SQL_GAP}+TO)${SQL_GAP}+` +
		String.raw`(?:["'\x60[]?\w+["'\x60\]]?${SQL_GAP}*\.${SQL_GAP}*)?["'\x60[]?webhooks["'\x60\]]?(?![\w$])`,
	'gi'
);

/**
 * What a switch-off-only writer may set: `active` off, or `secret` blank, or `url` blank (card 2928: an address left
 * out, to enter), or `set_by_key` NULL (card 2995, R8: the key that set it ended, which the hold rule reads as `key
 * ended`, as the foreign key's ON DELETE SET NULL leaves it).
 */
const SWITCH_OFF_SQL = /^["`[]?(?:active["`\]]?\s*=\s*0|(?:secret|url)["`\]]?\s*=\s*''|set_by_key["`\]]?\s*=\s*NULL)$/i;

/** What a switch-off-only writer may also set, to any value, beside `active` off: why and when it was held off (card 2752, E11). */
const HOLD_SQL = /^["`[]?held_(?:because|at)["`\]]?\s*=\s*\S[\s\S]*$/i;

/** `active` off, as a switch-off-only writer sets it in SQL. */
const ACTIVE_OFF_SQL = /^["`[]?active["`\]]?\s*=\s*0$/i;

/** The hold's two columns, as a switch-off-only writer may set them in Drizzle beside `active: false` (card 2752, E11). */
const HOLD_FIELDS = ['heldBecause', 'heldAt'];

/** The Drizzle methods whose first argument reads the table. */
const READS_TABLE = ['from', 'innerJoin', 'leftJoin', 'rightJoin', 'fullJoin', 'crossJoin'];

/** The Drizzle methods whose first argument is a table. */
const TAKES_TABLE = [...READS_TABLE, 'insert', 'update', 'delete'];

/** The names through which Drizzle hands out its tables: the relational queries and the schema it was given (code review K1, K13). */
const DRIZZLE_SCHEMA_WORDS = ['query', '_', 'fullSchema', 'schema'];

/** The Drizzle methods an object literal of columns may be handed to, as the fields read or returned (code review K17). */
const TAKES_FIELDS = ['select', 'selectDistinct', 'returning', 'orderBy', 'groupBy'];

/** What a use of the table outside a column, a read on the database and a delete on the database is told. */
const USES_WEBHOOKS = 'uses webhooks other than by a column, or by .from(), a join, .delete() or .$count() on the database';

/** What a column used anywhere but in a drizzle-orm call or as a field of a read on the database is told (code review K17). */
const COLUMN_ELSEWHERE = 'uses a column of webhooks other than in a drizzle-orm call with nothing taken off it, or as a field handed to a read on the database';

/** What `eval` or `Function` is told (code review K16). */
const RUNS_TEXT = 'names eval or Function, which run code built from a string that no rule reads';

/** What an unlisted writer is told. */
const ASK_FIRST =
	"a write that can set a webhook's address or secret, or switch one on, asks the current password first " +
	'(STEP_UP_ACTIONS; a service write with requirePasswordHeld, card 2726), and is then listed with why (card 2702)';

/** A `.svelte` file with everything outside its `<script>` blocks blanked, its lines kept. */
function scriptsOf(source: string): string {
	let kept = source.replace(/[^\n]/g, ' ');
	for (const found of source.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/g)) {
		const start = (found.index ?? 0) + found[1].length;
		kept = kept.slice(0, start) + found[2] + kept.slice(start + found[2].length);
	}
	return kept;
}

/** The innermost named function round `node`: a declaration, or a function given to a name; `(top level)` if none. */
function writerNameOf(node: ts.Node): string {
	for (let at = node.parent; at; at = at.parent) {
		if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name && ts.isIdentifier(at.name)) return at.name.text;
		if (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) {
			const holder = at.parent;
			if ((ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder) || ts.isPropertyDeclaration(holder)) && holder.initializer === at && ts.isIdentifier(holder.name)) {
				return holder.name.text;
			}
		}
	}
	return '(top level)';
}

type WebhookReading = {
	/** Every write found, listed or not, by its key. */
	writes: { key: string; line: number; what: string }[];
	/** The keys of WEBHOOK_WRITER_CALLERS this file imports or names, in any form. */
	reaches: string[];
	/** Each reference to a key of WEBHOOK_WRITER_CALLERS, by the `file#function` it is in. */
	refers: { key: string; by: string }[];
	findings: string[];
};

/** The files the webhook-writer rule walks under src (code review K6): every script, and a `.svelte` file's `<script>` blocks. */
const WEBHOOK_WALKED = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|svelte)$/;

/** What a pinned writer is, in its findings. */
const SETS_SECRET = "which sets a webhook's secret and switches it on";

/**
 * What a pinned writer does, as its findings say it, keyed per writer (card 2928's code review, C10):
 * `fillAddressGaps` sets an address and switches nothing on; any other is said as `SETS_SECRET`.
 */
const WHAT_IT_DOES: Record<string, string> = {
	'src/lib/server/backup-secrets.ts#fillAddressGaps': "which sets a webhook's address and switches nothing on"
};
const doesOf = (key: string) => WHAT_IT_DOES[key] ?? SETS_SECRET;

/**
 * Card 2702 for one file under src (plan section 6; code review K1 to K6, K9,
 * K12 to K18): the `webhooks` table of db/schema, found by its local name (in
 * db/schema itself, by its declaration), is written only by a function on
 * `writers`, as many times as it says, and a switch-off-only writer only
 * switches off, on the database itself. Every value reference to the table
 * is a write unless it is a column where a column may be (`columnPlaced`: an
 * argument of a drizzle-orm import with nothing taken off its result, or a
 * field handed to `select`, `selectDistinct`, `returning`, `orderBy` or
 * `groupBy` on the database; K17), or the first argument of `.from()` or a
 * join on a select that starts at the database or a transaction's handle
 * (after a `.with()` or not, K18), or of `.delete()` or `.$count()` on one,
 * with no `.table` or `.config` off the builder. `_`, `fullSchema`, `schema`
 * or `query` off the database, a transaction's handle or any name of
 * db/index.ts, by access, by a string key or by destructuring, and any key
 * worked out at run time off one of those names, is a write (K13), but for
 * `<database>.query.<table>.findFirst()` and `.findMany()` called directly;
 * so is a property `webhooks` off Drizzle's schema. Every string built from
 * literals (one, a template, or pieces joined by `+`, each piece that is not
 * a literal a word of its own, K14) is a write for each match of
 * `WEBHOOK_SQL_WRITE`, and every string, or whole joined text (K15), that is
 * the table's name alone is on WEBHOOK_NAME_STRINGS. The table imported under
 * another name; db/schema as a namespace outside db/index.ts, by `import x =
 * require()` or `require()`, re-exported or by `import()`; the namespace used
 * whole other than as drizzle()'s schema; a pinned writer imported by a file
 * not allowed it, or named other than by an import; any reference to it
 * outside its callers; and `eval` or `Function` (K16), are findings
 * outright. Not seen (plan section 2): a table name worked out at run time
 * (`['web', 'hooks'].join('')`, `String.fromCharCode`), the SQL verb held in
 * a variable, the table renamed away and written under its new name, a
 * builder or a drizzle-orm call's result held in a variable or handed on, the
 * database or a transaction's handle held in a variable or handed on, and the
 * migrations.
 */
function judgeWebhookWrites(file: string, source: string, writers: Readonly<Record<string, WebhookWriter>>): WebhookReading {
	const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const tree = ts.createSourceFile(file, file.endsWith('.svelte') ? scriptsOf(source) : source, ts.ScriptTarget.Latest, true, kind);
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const reading: WebhookReading = { writes: [], reaches: [], refers: [], findings: [] };
	const fileOf = (key: string) => key.slice(0, key.indexOf('#'));
	const nameOf = (key: string) => key.slice(key.indexOf('#') + 1);
	const keyOf = (node: ts.Node) => `${file}#${writerNameOf(node)}`;

	// Every name the file declares, each with its declarations: an import is a handle only where nothing else takes its name.
	const declared = new Map<string, ts.Node[]>();
	const collect = (node: ts.Node): void => {
		const name = (node as { name?: ts.Node }).name;
		const declares =
			ts.isVariableDeclaration(node) ||
			ts.isParameter(node) ||
			ts.isBindingElement(node) ||
			ts.isFunctionDeclaration(node) ||
			ts.isFunctionExpression(node) ||
			ts.isClassDeclaration(node) ||
			ts.isClassExpression(node) ||
			ts.isEnumDeclaration(node) ||
			ts.isImportEqualsDeclaration(node) ||
			ts.isImportSpecifier(node) ||
			ts.isNamespaceImport(node) ||
			ts.isImportClause(node);
		if (declares && name && ts.isIdentifier(name)) declared.set(name.text, [...(declared.get(name.text) ?? []), node]);
		ts.forEachChild(node, collect);
	};
	collect(tree);

	// Each module the file names, in every form (`moduleNamedBy`, code review K9), resolved once (K10).
	const tables = new Set<string>(file === WEBHOOK_SCHEMA ? ['webhooks'] : []);
	const namespaces = new Set<string>();
	/** Every name the file imports from db/index.ts, and of them the Drizzle database, `db`. */
	const fromDatabase = new Set<string>();
	const databases = new Set<string>();
	/** The local names of each pinned writer, and the namespaces of its module, by its key. */
	const pinnedNames = new Map<string, string>();
	const pinnedSpaces = new Map<string, string>();
	for (const key of Object.keys(WEBHOOK_WRITER_CALLERS)) if (fileOf(key) === file) pinnedNames.set(nameOf(key), key);
	const reach = (key: string, node: ts.Node, how: string) => {
		reading.reaches.push(key);
		const allowed = WEBHOOK_WRITER_CALLERS[key].map(fileOf);
		if (!allowed.includes(file)) reading.findings.push(`${file}:${line(node)} imports ${nameOf(key)}${how}, ${doesOf(key)}: only ${allowed.join(', ')} may (card 2702)`);
	};
	const naming = (node: ts.Node): void => {
		const named = moduleNamedBy(node);
		const target = named ? moduleFileOf(file, named.specifier) : null;
		const clause = ts.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly ? node.importClause : undefined;
		const bindings = clause?.namedBindings;
		const valueRequire = ts.isImportEqualsDeclaration(node) && !node.isTypeOnly;
		if (named && target === WEBHOOK_SCHEMA) {
			if (named.form === 'export') reading.findings.push(`${file}:${line(node)} re-exports from ${WEBHOOK_SCHEMA}: import webhooks from there by its own name (card 2702)`);
			if (named.form === 'import()') reading.findings.push(`${file}:${line(node)} imports ${WEBHOOK_SCHEMA} with import(): import webhooks by its own name (card 2702)`);
			if (named.form === 'require') reading.findings.push(`${file}:${line(node)} imports ${WEBHOOK_SCHEMA} with require(): import webhooks by its own name (card 2702)`);
			if (valueRequire) namespaces.add(node.name.text);
			if (bindings && ts.isNamespaceImport(bindings)) {
				namespaces.add(bindings.name.text);
				if (file !== SCHEMA_AS_NAMESPACE) reading.findings.push(`${file}:${line(node)} imports ${WEBHOOK_SCHEMA} as a namespace: import webhooks by its own name (card 2702)`);
			} else if (bindings) {
				for (const element of bindings.elements) {
					if (element.isTypeOnly || (element.propertyName ?? element.name).text !== 'webhooks') continue;
					tables.add(element.name.text);
					if (element.propertyName) reading.findings.push(`${file}:${line(node)} imports webhooks as ${element.name.text}: import it by its own name (card 2702)`);
				}
			}
		}
		if (named && target === DB_MODULE) {
			if (clause?.name) fromDatabase.add(clause.name.text);
			if (valueRequire) fromDatabase.add(node.name.text);
			if (bindings && ts.isNamespaceImport(bindings)) fromDatabase.add(bindings.name.text);
			else if (bindings) {
				for (const element of bindings.elements) {
					if (element.isTypeOnly) continue;
					fromDatabase.add(element.name.text);
					if ((element.propertyName ?? element.name).text === 'db') databases.add(element.name.text);
				}
			}
		}
		for (const key of Object.keys(WEBHOOK_WRITER_CALLERS)) {
			if (!named || target !== fileOf(key)) continue;
			const name = nameOf(key);
			if (bindings && ts.isNamespaceImport(bindings)) {
				reach(key, node, ' as a namespace');
				pinnedSpaces.set(bindings.name.text, key);
			} else if (bindings) {
				for (const element of bindings.elements) {
					if (element.isTypeOnly || (element.propertyName ?? element.name).text !== name) continue;
					reach(key, node, '');
					pinnedNames.set(element.name.text, key);
				}
			} else if (valueRequire) {
				reach(key, node, ' with import x = require()');
				pinnedSpaces.set(node.name.text, key);
			} else if (named.form === 'import()' || named.form === 'require') {
				reading.reaches.push(key);
				const how = named.form === 'require' ? 'require()' : named.form;
				reading.findings.push(`${file}:${line(node)} imports ${fileOf(key)} with ${how}, which holds ${name}, ${doesOf(key)}: import it by its own name, only in its callers' files (card 2702)`);
			} else if (named.form === 'export' && ts.isExportDeclaration(node) && !node.isTypeOnly) {
				const clauseOut = node.exportClause;
				const exported = !clauseOut || ts.isNamespaceExport(clauseOut) || clauseOut.elements.some((element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === name);
				if (exported) {
					reading.reaches.push(key);
					reading.findings.push(`${file}:${line(node)} re-exports ${name}, ${doesOf(key)}: no file may (card 2702)`);
				}
			}
		}
		ts.forEachChild(node, naming);
	};
	naming(tree);

	// The database: `db` of db/index.ts, under the name it is imported by, where the file declares that name nowhere else (code review K4).
	for (const name of [...databases]) if ((declared.get(name) ?? []).length !== 1) databases.delete(name);
	const isDatabase = (node: ts.Node) => ts.isIdentifier(node) && databases.has(node.text);
	/** The callback `declaration` is the first parameter of, where that callback is handed to `<database>.transaction(…)`. */
	const transactionOf = (declaration: ts.Node): ts.Node | undefined => {
		const callback = declaration.parent;
		const call = callback?.parent;
		if (!ts.isParameter(declaration) || !callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || callback.parameters[0] !== declaration) return undefined;
		if (!call || !ts.isCallExpression(call) || call.arguments[0] !== callback || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'transaction') return undefined;
		return isDatabase(call.expression.expression) ? callback : undefined;
	};
	/** The database, or a transaction's handle: a name the file declares only as the first parameter of callbacks handed to `<database>.transaction(…)`, inside one. */
	const isHandle = (node: ts.Node): boolean => {
		if (!ts.isIdentifier(node)) return false;
		if (databases.has(node.text)) return true;
		const callbacks = (declared.get(node.text) ?? []).map(transactionOf);
		return callbacks.length > 0 && callbacks.every((callback) => callback !== undefined) && callbacks.some((callback) => within(node, callback as ts.Node));
	};
	/** The name `node` is imported under from drizzle-orm (or one of its paths), by name, where the file declares that name nowhere else; undefined if it is not one. */
	const drizzleImportOf = (node: ts.Node): string | undefined => {
		const declarations = ts.isIdentifier(node) ? (declared.get(node.text) ?? []) : [];
		const [only] = declarations;
		if (declarations.length !== 1 || !ts.isImportSpecifier(only) || only.isTypeOnly || only.parent.parent.isTypeOnly) return undefined;
		const specifier = only.parent.parent.parent.moduleSpecifier;
		const fromDrizzle = ts.isStringLiteral(specifier) && (specifier.text === 'drizzle-orm' || specifier.text.startsWith('drizzle-orm/'));
		return fromDrizzle ? (only.propertyName ?? only.name).text : undefined;
	};
	/** `drizzle` of drizzle-orm, imported by its own name, where the file declares that name nowhere else. */
	const isDrizzle = (node: ts.Node): boolean => drizzleImportOf(node) === 'drizzle';

	/** `node`, and what wraps it without changing it: parentheses, `as`, `!`, `satisfies`, `<T>`. */
	const unwrappedUp = (node: ts.Node): ts.Node => {
		let at = node;
		while (ts.isParenthesizedExpression(at.parent) || ts.isAsExpression(at.parent) || ts.isNonNullExpression(at.parent) || ts.isSatisfiesExpression(at.parent) || ts.isTypeAssertionExpression(at.parent)) {
			at = at.parent;
		}
		return at;
	};
	/** Whether a table is reached off `node` (code review K1): `.table` or `.config` along the accesses and calls that hang off it, or an element access other than by a number. */
	const hangsTable = (node: ts.Node): boolean => {
		for (let at = unwrappedUp(node); ; ) {
			const up = at.parent;
			if (ts.isPropertyAccessExpression(up) && up.expression === at) {
				if (up.name.text === 'table' || up.name.text === 'config' || up.name.text === 'tableConfig') return true;
			} else if (ts.isElementAccessExpression(up) && up.expression === at) {
				if (!ts.isNumericLiteral(up.argumentExpression)) return true;
			} else if (!(ts.isCallExpression(up) && up.expression === at)) {
				return false;
			}
			at = unwrappedUp(up);
		}
	};
	/**
	 * Whether `receiver` is `<handle>.select…(…)`, or `<handle>.with(…).select…(…)`, and calls and accesses after it: a read that starts at the
	 * database or a transaction's handle (code review K4, K18).
	 */
	const selectsFromDatabase = (receiver: ts.Expression): boolean => {
		let at = receiver;
		const names: string[] = [];
		while (ts.isCallExpression(at) || ts.isPropertyAccessExpression(at)) {
			if (ts.isPropertyAccessExpression(at)) names.unshift(at.name.text);
			at = at.expression;
		}
		const [first, second] = names;
		const select = (name: string | undefined) => name !== undefined && /^select(Distinct(On)?)?$/.test(name);
		return isHandle(at) && (select(first) || (first === 'with' && select(second)));
	};
	/** `node` without what wraps it without changing it: parentheses, `as`, `!`, `satisfies`, `<T>`. */
	const unwrappedDown = (node: ts.Expression): ts.Expression => {
		let at = node;
		while (ts.isParenthesizedExpression(at) || ts.isAsExpression(at) || ts.isNonNullExpression(at) || ts.isSatisfiesExpression(at) || ts.isTypeAssertionExpression(at)) at = at.expression;
		return at;
	};
	/** The steps of the chain of accesses and calls `node` ends, from `node` in to where it starts, through what wraps them. */
	const chainOf = (node: ts.Expression): ts.Expression[] => {
		const steps: ts.Expression[] = [];
		for (let at = unwrappedDown(node); ; at = unwrappedDown(at.expression)) {
			steps.push(at);
			if (!(ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at) || ts.isCallExpression(at))) return steps;
		}
	};
	/** Whether `node` is the database or a transaction's handle, or any name of db/index.ts, or a chain of accesses and calls that starts at one (code review K13). */
	const offDatabase = (node: ts.Expression): boolean => {
		const steps = chainOf(node);
		const start = steps[steps.length - 1];
		return ts.isIdentifier(start) && (fromDatabase.has(start.text) || isHandle(start));
	};
	/** Whether `node` is the database or a transaction's handle, or a name of db/index.ts, itself. */
	const isDatabaseName = (node: ts.Expression): boolean => {
		const at = unwrappedDown(node);
		return ts.isIdentifier(at) && (fromDatabase.has(at.text) || isHandle(at));
	};
	/** `<handle>.query.<table>.findFirst(…)` or `.findMany(…)`, called directly with no table reached off it: the one use of `query` allowed (code review K1, K13). */
	const findsDirectly = (query: ts.PropertyAccessExpression): boolean => {
		const table = query.parent;
		const finder = table?.parent;
		return (
			isHandle(query.expression) &&
			ts.isPropertyAccessExpression(table) &&
			table.expression === query &&
			ts.isPropertyAccessExpression(finder) &&
			finder.expression === table &&
			(finder.name.text === 'findFirst' || finder.name.text === 'findMany') &&
			ts.isCallExpression(finder.parent) &&
			finder.parent.expression === finder &&
			!hangsTable(finder.parent)
		);
	};
	/**
	 * Whether `node` takes Drizzle's schema off the database (code review K13): `_`, `fullSchema` or `schema` off the database, a transaction's
	 * handle or a name of db/index.ts, or a chain that starts at one, by access or by a string key; `query` the same, but in `findsDirectly`; or
	 * any key worked out at run time off one of those names itself.
	 */
	const takesSchema = (node: ts.Node): boolean => {
		if (ts.isPropertyAccessExpression(node)) {
			if (!DRIZZLE_SCHEMA_WORDS.includes(node.name.text) || !offDatabase(node.expression)) return false;
			return node.name.text !== 'query' || !findsDirectly(node);
		}
		if (!ts.isElementAccessExpression(node)) return false;
		const key = node.argumentExpression;
		if (ts.isStringLiteralLike(key)) return DRIZZLE_SCHEMA_WORDS.includes(key.text) && offDatabase(node.expression);
		return !ts.isNumericLiteral(key) && isDatabaseName(node.expression);
	};
	/** Whether a step of the chain `node` ends takes Drizzle's schema: what is found there once, at the step nearest where the chain starts. */
	const schemaTakenIn = (node: ts.Expression): boolean => chainOf(node).some(takesSchema);
	/** Whether `node` is, or hangs off, the database, a transaction's handle, any name of db/index.ts, or Drizzle's schema (code review K1). */
	const reachesDrizzleSchema = (node: ts.Expression): boolean => {
		let at = node;
		for (;;) {
			if (ts.isPropertyAccessExpression(at) && DRIZZLE_SCHEMA_WORDS.includes(at.name.text)) return true;
			if (
				ts.isPropertyAccessExpression(at) ||
				ts.isElementAccessExpression(at) ||
				ts.isCallExpression(at) ||
				ts.isParenthesizedExpression(at) ||
				ts.isAsExpression(at) ||
				ts.isNonNullExpression(at) ||
				ts.isSatisfiesExpression(at) ||
				ts.isTypeAssertionExpression(at)
			) {
				at = at.expression;
			} else {
				return ts.isIdentifier(at) && (fromDatabase.has(at.text) || isHandle(at) || DRIZZLE_SCHEMA_WORDS.includes(at.text));
			}
		}
	};

	/** One write: on the list under its key, and, for a switch-off-only writer, one that `switchesOff`. */
	const write = (node: ts.Node, what: string, switchesOff: () => boolean) => {
		const key = keyOf(node);
		reading.writes.push({ key, line: line(node), what });
		const listed = writers[key];
		if (!listed) reading.findings.push(`${file}:${line(node)} ${what} in ${writerNameOf(node)}, which is not on WEBHOOK_WRITERS: ${ASK_FIRST}`);
		else if (listed.does === 'switches off only' && !switchesOff()) {
			reading.findings.push(`${file}:${line(node)} ${what} in ${writerNameOf(node)}, which WEBHOOK_WRITERS lists as switching off only, and does more (card 2702)`);
		}
	};
	/**
	 * `<handle>.update(table).set({ active: false })`, or with `secret: ''`, and nothing else, with no table reached off it; and,
	 * beside `active: false` alone, `heldBecause` and `heldAt` at any value (card 2752, E11).
	 */
	const switchesOffInDrizzle = (update: ts.CallExpression): boolean => {
		if (!ts.isPropertyAccessExpression(update.expression) || !isHandle(update.expression.expression) || hangsTable(update)) return false;
		const set = update.parent;
		if (!ts.isPropertyAccessExpression(set) || set.name.text !== 'set' || !ts.isCallExpression(set.parent)) return false;
		const [values] = set.parent.arguments;
		if (!values || !ts.isObjectLiteralExpression(values) || values.properties.length === 0) return false;
		const offOrBlank = (property: ts.PropertyAssignment) =>
			ts.isIdentifier(property.name) &&
			((property.name.text === 'active' && property.initializer.kind === ts.SyntaxKind.FalseKeyword) ||
				(property.name.text === 'secret' && ts.isStringLiteralLike(property.initializer) && property.initializer.text === ''));
		const holds = (property: ts.PropertyAssignment) => ts.isIdentifier(property.name) && HOLD_FIELDS.includes(property.name.text);
		const activeOff = (property: ts.PropertyAssignment) =>
			ts.isIdentifier(property.name) && property.name.text === 'active' && property.initializer.kind === ts.SyntaxKind.FalseKeyword;
		const assigned = values.properties.filter(ts.isPropertyAssignment);
		if (assigned.length !== values.properties.length) return false;
		if (!assigned.every((property) => offOrBlank(property) || holds(property))) return false;
		return !assigned.some(holds) || assigned.some(activeOff);
	};
	/** Whether the chain `node` ends starts at the database or a transaction's handle. */
	const startsAtHandle = (node: ts.Expression): boolean => {
		const steps = chainOf(node);
		return isHandle(steps[steps.length - 1]);
	};
	/**
	 * Whether a column is where a column may be (code review K17): an argument of a drizzle-orm import (`eq`, `and`, `inArray`, …) with
	 * nothing taken off what it returns; or a value of an object literal handed directly to `select`, `selectDistinct`, `returning`,
	 * `orderBy` or `groupBy` on a chain that starts at the database or a transaction's handle; or, in db/schema.ts, a foreign key, the
	 * whole body of an arrow handed to `.references()`.
	 */
	const columnPlaced = (column: ts.Expression): boolean => {
		const at = unwrappedUp(column);
		const holder = at.parent;
		if (ts.isCallExpression(holder) && holder.arguments.some((argument) => argument === at) && drizzleImportOf(holder.expression) !== undefined) {
			const result = unwrappedUp(holder);
			const off = result.parent;
			return !((ts.isPropertyAccessExpression(off) || ts.isElementAccessExpression(off)) && off.expression === result);
		}
		if (ts.isPropertyAssignment(holder) && holder.initializer === at) {
			const fields = holder.parent;
			const call = fields.parent;
			return (
				ts.isCallExpression(call) &&
				call.arguments.some((argument) => argument === fields) &&
				ts.isPropertyAccessExpression(call.expression) &&
				TAKES_FIELDS.includes(call.expression.name.text) &&
				startsAtHandle(call.expression.expression)
			);
		}
		if (file === WEBHOOK_SCHEMA && ts.isArrowFunction(holder) && holder.body === at) {
			const call = holder.parent;
			return ts.isCallExpression(call) && call.arguments[0] === holder && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'references';
		}
		return false;
	};
	/** A reference to the table, by its local name or through the namespace: a column, a read, a count or a delete on the database, or a write. */
	const judgeReference = (reference: ts.Expression) => {
		const parent = reference.parent;
		if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
			// A column: none where the table is reached off it or it is handed on as a table (code review K1), and only where a column may be (K17).
			const outer = unwrappedUp(parent);
			const call = outer.parent;
			const handedOn = ts.isCallExpression(call) && call.arguments[0] === outer && ts.isPropertyAccessExpression(call.expression) && TAKES_TABLE.includes(call.expression.name.text);
			if (hangsTable(parent) || handedOn) write(reference, 'reaches the webhooks table through a column', () => false);
			else if (!columnPlaced(parent)) write(reference, COLUMN_ELSEWHERE, () => false);
			return;
		}
		if (ts.isCallExpression(parent) && parent.arguments[0] === reference && ts.isPropertyAccessExpression(parent.expression)) {
			const method = parent.expression.name.text;
			if (method === 'insert') return write(reference, 'inserts into webhooks', () => false);
			if (method === 'update') return write(reference, 'updates webhooks', () => switchesOffInDrizzle(parent));
			// A read, a count or a delete only on the database or a transaction's handle, with no table reached off the builder (code review K1, K4, K18).
			const reads = READS_TABLE.includes(method) && selectsFromDatabase(parent.expression.expression);
			const counts = method === '$count' && isHandle(parent.expression.expression);
			const deletes = method === 'delete' && isHandle(parent.expression.expression);
			if ((reads || counts || deletes) && !hangsTable(parent)) return;
		}
		if (ts.isTemplateSpan(parent) && parent.expression === reference && ts.isTaggedTemplateExpression(parent.parent.parent)) {
			return write(reference, 'interpolates webhooks into a sql template', () => false);
		}
		write(reference, USES_WEBHOOKS, () => false);
	};
	/** A reference to db/schema's namespace: a property of it, or, in db/index.ts alone, drizzle()'s schema (code review K6). */
	const judgeNamespace = (reference: ts.Identifier) => {
		const parent = reference.parent;
		if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
			if (parent.name.text === 'webhooks') judgeReference(parent);
			return;
		}
		const property = ts.isShorthandPropertyAssignment(parent) || (ts.isPropertyAssignment(parent) && parent.initializer === reference) ? parent : undefined;
		const options = property?.parent;
		const call = options?.parent;
		const asSchema =
			file === SCHEMA_AS_NAMESPACE &&
			property !== undefined &&
			ts.isIdentifier(property.name) &&
			property.name.text === 'schema' &&
			call !== undefined &&
			ts.isCallExpression(call) &&
			call.arguments[1] === options &&
			isDrizzle(call.expression);
		if (!asSchema) reading.findings.push(`${file}:${line(reference)} uses ${WEBHOOK_SCHEMA} whole, other than as drizzle()'s schema in ${SCHEMA_AS_NAMESPACE}: name each table (card 2702)`);
	};
	/** A reference to a pinned writer: only in its callers (code review K5). */
	const refer = (key: string, node: ts.Node) => {
		const by = keyOf(node);
		reading.refers.push({ key, by });
		const callers = WEBHOOK_WRITER_CALLERS[key];
		if (!callers.includes(by)) reading.findings.push(`${file}:${line(node)} refers to ${nameOf(key)} in ${writerNameOf(node)}, ${doesOf(key)}: only ${callers.join(', ')} may (card 2702)`);
	};
	/** A reference to a pinned writer's module as a namespace: its writer by name, or another of its names; never the module whole. */
	const judgePinnedSpace = (key: string, reference: ts.Identifier) => {
		const parent = reference.parent;
		const name = nameOf(key);
		if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
			if (parent.name.text === name) refer(key, parent);
			return;
		}
		if (ts.isElementAccessExpression(parent) && parent.expression === reference && ts.isStringLiteralLike(parent.argumentExpression)) {
			if (parent.argumentExpression.text === name) refer(key, parent);
			return;
		}
		reading.findings.push(`${file}:${line(reference)} uses ${fileOf(key)} whole, which holds ${name}, ${doesOf(key)}: import it by its own name (card 2702)`);
	};

	/**
	 * The text of a string built from literals (one, a template, or pieces joined by `+`), ` _ ` for each piece that is not a literal (a
	 * word of its own, so that a name before or after it is still a name: code review K14), and whether there is none.
	 */
	const textOf = (node: ts.Expression): { text: string; whole: boolean } => {
		if (ts.isStringLiteralLike(node)) return { text: node.text, whole: true };
		if (ts.isParenthesizedExpression(node)) return textOf(node.expression);
		if (ts.isTemplateExpression(node)) {
			const spans = node.templateSpans.map((span) => ({ inner: textOf(span.expression), tail: span.literal.text }));
			return { text: node.head.text + spans.map(({ inner, tail }) => inner.text + tail).join(''), whole: spans.every(({ inner }) => inner.whole) };
		}
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
			const [left, right] = [textOf(node.left), textOf(node.right)];
			return { text: left.text + right.text, whole: left.whole && right.whole };
		}
		return { text: ' _ ', whole: false };
	};
	/** Whether `node` is a piece of a larger string: joined by `+`, or a template's substitution. */
	const isTextPart = (node: ts.Node): boolean => {
		const parent = node.parent;
		return (
			(ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
			(ts.isTemplateSpan(parent) && parent.expression === node) ||
			(ts.isParenthesizedExpression(parent) && isTextPart(parent))
		);
	};
	/** The SQL writes in a string's text, each a write of the string; a switch-off only where the string is literals alone. */
	const judgeText = (node: ts.Node, { text, whole }: { text: string; whole: boolean }) => {
		for (const found of text.matchAll(WEBHOOK_SQL_WRITE)) {
			// A table made: in the migration runner's model alone, as many times as it says (code review K3).
			if (/^(CREATE|ALTER)\b/i.test(found[1]) && keyOf(node) in WEBHOOK_TABLE_MADE) {
				tablesMade.push(keyOf(node));
				continue;
			}
			const rest = text.slice(found.index ?? 0);
			const assigned = /\bSET\s+([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|\bFROM\b|;|$)/i.exec(rest)?.[1];
			// `active` off or `secret` blank; and, beside `active` off, the hold's two columns at any value (card 2752, E11).
			const parts = (assigned ?? '').split(',').map((part) => part.trim());
			const switchesOff = () =>
				whole &&
				/^UPDATE\b/i.test(found[1]) &&
				assigned !== undefined &&
				parts.every((part) => SWITCH_OFF_SQL.test(part) || HOLD_SQL.test(part)) &&
				(!parts.some((part) => HOLD_SQL.test(part)) || parts.some((part) => ACTIVE_OFF_SQL.test(part)));
			write(node, 'writes webhooks in SQL', switchesOff);
		}
	};
	/** Each string that is the table's name (code review K2), and each table made in SQL (K3), by its key. */
	const nameStrings: string[] = [];
	const tablesMade: string[] = [];

	/** A string, or a template's piece exactly, whose text is the table's name alone (code review K2). */
	const isNamePiece = (node: ts.Node): boolean => {
		const piece = ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
		return (ts.isStringLiteralLike(node) || piece) && WEBHOOK_NAME_STRING.test(node.text) && (!piece || node.text.trim() === node.text);
	};
	/** Whether `node` is, or holds, such a string or piece. */
	const namesInside = (node: ts.Node): boolean => isNamePiece(node) || (ts.forEachChild(node, (child) => namesInside(child) || undefined) ?? false);
	/** A string that is the table's name, counted under its key, and a finding where the key is not on WEBHOOK_NAME_STRINGS. */
	const nameFound = (node: ts.Node) => {
		nameStrings.push(keyOf(node));
		if (!(keyOf(node) in WEBHOOK_NAME_STRINGS)) {
			reading.findings.push(
				`${file}:${line(node)} names the webhooks table in a string in ${writerNameOf(node)}, which is not on WEBHOOK_NAME_STRINGS: a string that is the name builds a write round this rule; use the table by its import (card 2702)`
			);
		}
	};
	const SCHEMA_TAKEN = "reaches the webhooks table through Drizzle's schema";
	/**
	 * Whether a binding element of an object pattern takes Drizzle's schema off the database (code review K13): `_`, `fullSchema`, `schema` or
	 * `query` out of a chain that starts at the database, a transaction's handle or a name of db/index.ts; or, at the top of the pattern,
	 * a computed key or the rest out of one of those names itself.
	 */
	const takesSchemaApart = (element: ts.BindingElement, top: boolean, from: ts.Expression): boolean => {
		if (!ts.isObjectBindingPattern(element.parent) || !offDatabase(from)) return false;
		const taken = element.propertyName ?? element.name;
		if (element.dotDotDotToken || ts.isComputedPropertyName(taken)) return top && isDatabaseName(from);
		return (ts.isIdentifier(taken) || ts.isStringLiteralLike(taken)) && DRIZZLE_SCHEMA_WORDS.includes(taken.text);
	};
	/** The same for a property of an object assigned to by destructuring (`({ query: q } = db)`), at its top. */
	const assignsSchemaApart = (property: ts.ObjectLiteralElementLike, from: ts.Expression): boolean => {
		if (ts.isSpreadAssignment(property) || (property.name !== undefined && ts.isComputedPropertyName(property.name))) return isDatabaseName(from);
		const name = property.name;
		return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && DRIZZLE_SCHEMA_WORDS.includes(name.text);
	};
	/**
	 * `eval` or `Function`, by name, as a property, or by a string key (code
	 * review K16); and `constructor` as a property or key, which off any
	 * function is `Function` itself (card 2702, after the K13 to K19 pass).
	 */
	const RUN_TEXT = ['eval', 'Function'];
	const RUN_KEYS = [...RUN_TEXT, 'constructor'];
	const runsText = (node: ts.Node): boolean =>
		(ts.isIdentifier(node) && references.has(node) && RUN_TEXT.includes(node.text)) ||
		(ts.isPropertyAccessExpression(node) && RUN_KEYS.includes(node.name.text)) ||
		(ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && RUN_KEYS.includes(node.argumentExpression.text));

	const references = new Set(referencesIn(tree));
	const visit = (node: ts.Node): void => {
		// K2: a string, or a template's piece exactly, that is the table's name alone.
		if (isNamePiece(node)) nameFound(node);
		// SQL, in the whole text of a string built from literals, judged once.
		const joined = ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken);
		if ((ts.isStringLiteralLike(node) || joined) && !isTextPart(node)) {
			const text = textOf(node as ts.Expression);
			judgeText(node, text);
			// K15: the whole text of a template or of pieces joined by `+` that is the name, where no piece of it is.
			if (joined && WEBHOOK_NAME_STRING.test(text.text) && !namesInside(node)) nameFound(node);
		}
		// K16: eval and Function, anywhere.
		if (runsText(node)) reading.findings.push(`${file}:${line(node)} ${RUNS_TEXT} in ${writerNameOf(node)} (card 2702)`);
		// K13: Drizzle's schema taken off the database, a transaction's handle or a name of db/index.ts, found once, nearest where the chain starts.
		if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && takesSchema(node) && !schemaTakenIn(node.expression)) {
			write(node, SCHEMA_TAKEN, () => false);
		}
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(unwrappedDown(node.left))) {
			const from = node.right;
			const pattern = unwrappedDown(node.left) as ts.ObjectLiteralExpression;
			if (offDatabase(from) && !schemaTakenIn(from)) for (const property of pattern.properties) if (assignsSchemaApart(property, from)) write(property, SCHEMA_TAKEN, () => false);
		}
		// K1: a property `webhooks` off the database, a transaction's handle or Drizzle's schema, but a relational read called directly; not again where K13 found the schema taken.
		if (
			ts.isPropertyAccessExpression(node) &&
			node.name.text === 'webhooks' &&
			!(ts.isIdentifier(node.expression) && namespaces.has(node.expression.text)) &&
			reachesDrizzleSchema(node.expression) &&
			!schemaTakenIn(node.expression)
		) {
			const query = node.expression;
			const finds = ts.isPropertyAccessExpression(query) && query.name.text === 'query' && findsDirectly(query);
			if (!finds) write(node, SCHEMA_TAKEN, () => false);
		}
		// K1, K13: `webhooks`, or Drizzle's schema, taken out of the database, a transaction's handle or Drizzle's schema by destructuring.
		if (ts.isBindingElement(node)) {
			const outer: ts.BindingElement[] = [];
			let at: ts.Node = node.parent;
			while (ts.isObjectBindingPattern(at) || ts.isArrayBindingPattern(at) || ts.isBindingElement(at)) {
				if (ts.isBindingElement(at)) outer.push(at);
				at = at.parent;
			}
			const from = ts.isVariableDeclaration(at) || ts.isParameter(at) ? at.initializer : undefined;
			const takenBefore = from !== undefined && (schemaTakenIn(from) || outer.some((element, index) => takesSchemaApart(element, index === outer.length - 1, from)));
			if (from && !takenBefore && takesSchemaApart(node, outer.length === 0, from)) write(node, SCHEMA_TAKEN, () => false);
			const taken = node.propertyName ?? node.name;
			const path = outer.map((element) => element.propertyName ?? element.name).flatMap((name) => (ts.isIdentifier(name) ? [name.text] : []));
			if (ts.isIdentifier(taken) && taken.text === 'webhooks' && from && !takenBefore && (path.some((name) => DRIZZLE_SCHEMA_WORDS.includes(name)) || reachesDrizzleSchema(from))) {
				write(node, "takes webhooks out of Drizzle's schema", () => false);
			}
		}
		// Each value reference (`referencesIn`, code review K9): to the table, to db/schema's namespace, to a pinned writer or its module.
		if (ts.isIdentifier(node) && references.has(node)) {
			if (tables.has(node.text)) judgeReference(node);
			if (namespaces.has(node.text)) judgeNamespace(node);
			const pinnedName = pinnedNames.get(node.text);
			if (pinnedName !== undefined) refer(pinnedName, node);
			const pinnedSpace = pinnedSpaces.get(node.text);
			if (pinnedSpace !== undefined) judgePinnedSpace(pinnedSpace, node);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);

	// Each listed writer of this file holds exactly its count; so does each listed key of strings that are the name, and each caller of a pinned writer refers to it once.
	for (const [key, { writes }] of Object.entries(writers)) {
		if (fileOf(key) !== file) continue;
		const found = reading.writes.filter((each) => each.key === key).length;
		if (found !== writes) reading.findings.push(`${key} writes the webhooks table ${found} time(s), and WEBHOOK_WRITERS says ${writes} (card 2702)`);
	}
	for (const [key, { count }] of Object.entries(WEBHOOK_NAME_STRINGS)) {
		if (fileOf(key) !== file) continue;
		const found = nameStrings.filter((each) => each === key).length;
		if (found !== count) reading.findings.push(`${key} names the webhooks table in a string ${found} time(s), and WEBHOOK_NAME_STRINGS says ${count} (card 2702)`);
	}
	for (const [key, { count }] of Object.entries(WEBHOOK_TABLE_MADE)) {
		if (fileOf(key) !== file) continue;
		const found = tablesMade.filter((each) => each === key).length;
		if (found !== count) reading.findings.push(`${key} makes a table called webhooks in SQL ${found} time(s), and WEBHOOK_TABLE_MADE says ${count} (card 2702)`);
	}
	for (const [key, callers] of Object.entries(WEBHOOK_WRITER_CALLERS)) {
		for (const caller of callers) {
			if (fileOf(caller) !== file) continue;
			const found = reading.refers.filter((each) => each.key === key && each.by === caller).length;
			if (found !== 1) reading.findings.push(`${caller} refers to ${nameOf(key)} ${found} time(s), and WEBHOOK_WRITER_CALLERS says once (card 2702)`);
		}
	}
	return reading;
}

describe('the webhooks table is written only by the writers listed, each as listed (card 2702)', () => {
	const walked = filesUnder('src', (path) => WEBHOOK_WALKED.test(path)).map((file) => ({ file, source: readFileSync(join(ROOT, file), 'utf8') }));
	const readings = new Map(walked.map(({ file, source }) => [file, judgeWebhookWrites(file, source, WEBHOOK_WRITERS)] as const));
	const fileOf = (key: string) => key.slice(0, key.indexOf('#'));

	it('finds no writer in src that is not on WEBHOOK_WRITERS, or does more than it is listed for, and nothing reaching fillSecretGaps but the restore (case 3)', () => {
		// Each names the file, the line, the write and the function. A write that
		// can set a webhook's address or secret, or switch one on, asks the
		// current password first; then list it with why.
		expect([...readings.values()].flatMap(({ findings }) => findings)).toEqual([]);
		// Walked: every file under src, the file of every listed key among them (code review K10: the walk's own list).
		expect(walked.length).toBeGreaterThan(300);
		const listed = [...Object.keys(WEBHOOK_WRITERS), ...Object.keys(WEBHOOK_NAME_STRINGS), ...Object.keys(WEBHOOK_TABLE_MADE), ...Object.values(WEBHOOK_WRITER_CALLERS).flat()];
		for (const key of listed) expect(readings.has(fileOf(key)), key).toBe(true);
		// The pinned writer is reached by exactly its callers' files, and referred to by exactly its callers, each once (code review K5).
		for (const [key, callers] of Object.entries(WEBHOOK_WRITER_CALLERS)) {
			const reaching = [...readings].filter(([, { reaches }]) => reaches.includes(key)).map(([file]) => file);
			expect(reaching.sort(), key).toEqual([...new Set(callers.map(fileOf))].sort());
			const referring = [...readings.values()].flatMap(({ refers }) => refers.filter((each) => each.key === key).map(({ by }) => by));
			expect(referring.sort(), key).toEqual([...callers].sort());
		}
	});

	it('walks every kind of script under src (code review K6)', () => {
		for (const path of ['a.ts', 'a.mts', 'a.cts', 'a.tsx', 'a.js', 'a.mjs', 'a.cjs', 'a.jsx', 'a.svelte']) expect(WEBHOOK_WALKED.test(`src/${path}`), path).toBe(true);
	});

	it('holds on WEBHOOK_WRITERS exactly the writers the walk found, each with the writes it has (case 5)', () => {
		const counted: Record<string, number> = {};
		for (const { writes } of readings.values()) for (const { key } of writes) counted[key] = (counted[key] ?? 0) + 1;

		expect(counted).toEqual(Object.fromEntries(Object.entries(WEBHOOK_WRITERS).map(([key, { writes }]) => [key, writes])));
	});

	describe('the rule itself (case 4)', () => {
		const EXAMPLE = 'src/lib/server/example.ts';
		/** `code` as line 4 of a made-up module that imports the table, the connection and Drizzle's conditions, in `reopen`. */
		const inReopen = (code: string) =>
			[
				"import { db, sqlite } from '$lib/server/db'; import { and, eq, inArray } from 'drizzle-orm';",
				"import { webhooks, boards } from '$lib/server/db/schema';",
				'export function reopen(column: string) {',
				`\t${code}`,
				'}'
			].join('\n');
		const findingsOf = (code: string) => judgeWebhookWrites(EXAMPLE, inReopen(code), WEBHOOK_WRITERS).findings;
		const unlisted = (what: string, at = 4, name = 'reopen', file = EXAMPLE) => `${file}:${at} ${what} in ${name}, which is not on WEBHOOK_WRITERS: ${ASK_FIRST}`;
		const named = (at = 4, name = 'reopen', file = EXAMPLE) =>
			`${file}:${at} names the webhooks table in a string in ${name}, which is not on WEBHOOK_NAME_STRINGS: a string that is the name builds a write round this rule; use the table by its import (card 2702)`;
		const IN_SQL = 'writes webhooks in SQL';
		const THROUGH_COLUMN = 'reaches the webhooks table through a column';
		const THROUGH_SCHEMA = "reaches the webhooks table through Drizzle's schema";
		const TAKEN = "takes webhooks out of Drizzle's schema";
		const refill = `which sets a webhook's secret and switches it on: only src/lib/server/db/restore.ts may (card 2702)`;
		/** Card 2928's address refill, said as what it does (its code review, C10). */
		const addressRefill = `which sets a webhook's address and switches nothing on: only src/lib/server/db/restore.ts may (card 2702)`;
		const referred = (at: number, name: string, file: string) =>
			`${file}:${at} refers to fillSecretGaps in ${name}, which sets a webhook's secret and switches it on: only src/lib/server/db/restore.ts#restoreInOneSnapshot may (card 2702)`;
		const ran = (at = 4, name = 'reopen', file = EXAMPLE) => `${file}:${at} ${RUNS_TEXT} in ${name} (card 2702)`;
		const whole = (at: number, file = SCHEMA_AS_NAMESPACE) => `${file}:${at} uses ${WEBHOOK_SCHEMA} whole, other than as drizzle()'s schema in ${SCHEMA_AS_NAMESPACE}: name each table (card 2702)`;

		it.each([
			{ form: 'a Drizzle insert', code: "db.insert(webhooks).values({ boardId: 1, url: 'https://x.test' }).run();", what: 'inserts into webhooks' },
			{ form: 'a Drizzle update', code: "db.update(webhooks).set({ url: 'https://x.test' }).run();", what: 'updates webhooks' },
			{ form: 'INSERT INTO', code: "sqlite.prepare('INSERT INTO webhooks (board_id, url) VALUES (?, ?)').run(1, 'x');", what: IN_SQL },
			{ form: 'INSERT OR REPLACE INTO', code: "sqlite.prepare('INSERT OR REPLACE INTO webhooks (id, url) VALUES (?, ?)').run(1, 'x');", what: IN_SQL },
			{ form: 'REPLACE INTO', code: "sqlite.prepare('REPLACE INTO webhooks (id, url) VALUES (?, ?)').run(1, 'x');", what: IN_SQL },
			{ form: 'UPDATE', code: "sqlite.prepare('UPDATE webhooks SET url = ?').run('x');", what: IN_SQL },
			{ form: 'UPDATE OR IGNORE', code: "sqlite.prepare('UPDATE OR IGNORE webhooks SET url = ?').run('x');", what: IN_SQL },
			{ form: 'lower case', code: "sqlite.prepare('update webhooks set active = 1').run();", what: IN_SQL },
			{ form: 'a double-quoted name', code: `sqlite.prepare('UPDATE "webhooks" SET url = ?').run('x');`, what: IN_SQL },
			{ form: 'a backticked name', code: "sqlite.prepare('UPDATE `webhooks` SET url = ?').run('x');", what: IN_SQL },
			{ form: 'a bracketed name', code: "sqlite.prepare('UPDATE [webhooks] SET url = ?').run('x');", what: IN_SQL },
			{ form: 'a schema before the name', code: "sqlite.prepare('UPDATE main.webhooks SET url = ?').run('x');", what: IN_SQL },
			{ form: 'a quoted schema and name', code: `sqlite.prepare('INSERT INTO "main"."webhooks" (url) VALUES (?)').run('x');`, what: IN_SQL },
			{ form: 'across lines', code: 'sqlite.prepare(`UPDATE\n\t\twebhooks\n\tSET active = 1`).run();', what: IN_SQL },
			{ form: 'a template with a substitution', code: 'sqlite.prepare(`UPDATE webhooks SET ${column} = ?`).run(1);', what: IN_SQL },
			{ form: 'a sql template', code: 'db.run(sql`UPDATE webhooks SET active = 1`);', what: IN_SQL },
			{ form: 'the table interpolated into a sql template', code: 'db.run(sql`UPDATE ${webhooks} SET active = 1`);', what: 'interpolates webhooks into a sql template' },
			{ form: 'the table held in a variable', code: 'const table = webhooks;', what: USES_WEBHOOKS },
			{ form: 'the table handed to a function', code: 'copyRows(webhooks, rows);', what: USES_WEBHOOKS }
		])('finds $form, on its line, in its function', ({ code, what }) => {
			expect(findingsOf(code)).toEqual([unlisted(what)]);
		});

		// Code review K1 to K4: each a way round the rule the security review found or that its fix opened.
		it.each([
			// K1: the table reached through a column, a builder or Drizzle's schema.
			{ form: "a column's table", code: 'db.update(webhooks.id.table).set({ url: column }).run();', found: [unlisted(THROUGH_COLUMN)] },
			{ form: 'a column handed on as a table', code: 'db.update(webhooks.url as never).set({ url: column }).run();', found: [unlisted(THROUGH_COLUMN)] },
			{ form: "Drizzle's full schema", code: 'db.insert(db._.fullSchema.webhooks).values({ boardId: 1, url: column }).run();', found: [unlisted(THROUGH_SCHEMA)] },
			{ form: "a relational query's table", code: 'db.update((db.query.webhooks as any).table).set({ url: column }).run();', found: [unlisted(THROUGH_SCHEMA)] },
			{ form: 'the table taken out of the relational queries', code: 'const { webhooks: hooks } = db.query;', found: [unlisted(THROUGH_SCHEMA)] },
			{ form: "a delete's builder's table", code: 'db.update(db.delete(webhooks).config.table).set({ url: column }).run();', found: [unlisted(USES_WEBHOOKS)] },
			{ form: "a read's builder's table", code: 'db.update(db.select().from(webhooks).config.table).set({ url: column }).run();', found: [unlisted(USES_WEBHOOKS)] },
			{ form: "a read's builder's tableConfig", code: 'db.update((Object.values((db.select().from(webhooks) as any).tableConfig.columns)[0] as any).table).set({ url: column }).run();', found: [unlisted(USES_WEBHOOKS)] },
			// K4: a read or a delete is one only on the database or a transaction's handle.
			{ form: "a made-up object's from()", code: 'const copy = { from: (t: typeof webhooks) => db.update(t).set({ url: column }).run() }; copy.from(webhooks);', found: [unlisted(USES_WEBHOOKS)] },
			{ form: "a made-up object's delete()", code: 'const w = { delete: (t: typeof webhooks) => db.insert(t).values({ boardId: 1, url: column }).run() }; w.delete(webhooks);', found: [unlisted(USES_WEBHOOKS)] },
			{ form: 'a join on a chain that does not start at the database', code: 'other.select().from(boards).innerJoin(webhooks, eq(webhooks.boardId, boards.id)).all();', found: [unlisted(USES_WEBHOOKS)] },
			{ form: "the database's name taken by a made-up object", code: 'const db = { delete: (t: unknown) => t }; db.delete(webhooks);', found: [unlisted(USES_WEBHOOKS)] },
			// K2: a string that is the table's name.
			{ form: 'a second table declared on the name', code: "const hooks = sqliteTable('webhooks', { id: integer('id') }); db.update(hooks).set({ url: column }).run();", found: [named()] },
			{ form: 'sql.identifier', code: "db.run(sql`UPDATE ${sql.identifier('webhooks')} SET url = ${column}`);", found: [named()] },
			{ form: 'sql.raw', code: "db.run(sql`UPDATE ${sql.raw('webhooks')} SET url = ${column}`);", found: [named()] },
			{ form: 'the name in another case', code: "db.run(sql`UPDATE ${sql.raw('WEBHOOKS')} SET url = ${column}`);", found: [named()] },
			{ form: 'the name joined by +', code: "sqlite.prepare('UPDATE ' + 'webhooks' + ' SET url = ?').run(column);", found: [unlisted(IN_SQL), named()] },
			{ form: 'a write joined by + from pieces none of which is the name', code: "sqlite.prepare('UPDATE web' + 'hooks SET url = ?').run(column);", found: [unlisted(IN_SQL)] },
			{ form: "the name as a template's substitution", code: "sqlite.prepare(`UPDATE ${'webhooks'} SET url = ?`).run(column);", found: [unlisted(IN_SQL), named()] },
			// K3: SQL that names the table in any way SQLite reads it.
			{ form: 'a single-quoted name', code: `sqlite.prepare("UPDATE 'webhooks' SET url = ?").run(column);`, found: [unlisted(IN_SQL)] },
			{ form: 'a block comment between the words', code: "sqlite.prepare('UPDATE /**/ webhooks SET url = ?').run(column);", found: [unlisted(IN_SQL)] },
			{ form: 'a line comment between the words', code: "sqlite.prepare('UPDATE -- the table\\n webhooks SET url = ?').run(column);", found: [unlisted(IN_SQL)] },
			{ form: 'a table renamed to the name', code: "sqlite.exec('CREATE TABLE webhooks2 AS SELECT * FROM webhooks; DROP TABLE webhooks; ALTER TABLE webhooks2 RENAME TO webhooks');", found: [unlisted(IN_SQL)] },
			{ form: 'a table made on the name', code: "sqlite.exec('CREATE TABLE webhooks AS SELECT * FROM webhooks_old');", found: [unlisted(IN_SQL)] },
			// K13: Drizzle's schema taken off the database or a transaction's handle, however it is reached after.
			{ form: "Drizzle's full schema's values (K13)", code: 'db.update(Object.values(db._.fullSchema)[17] as never).set({ url: column }).run();', found: [unlisted(THROUGH_SCHEMA)] },
			{
				form: "a transaction's full schema (K13)",
				code: 'db.transaction((tx) => { tx.update(Object.values(tx._.fullSchema)[17] as never).set({ url: column }).run(); });',
				found: [unlisted(THROUGH_SCHEMA)]
			},
			{ form: 'the relational queries by a key worked out (K13)', code: "const k = ['web', 'hooks'].join(''); db.update(((db.query as any)[k]).table).set({ url: column }).run();", found: [unlisted(THROUGH_SCHEMA)] },
			{ form: 'the relational queries held in a variable (K13)', code: 'const b: any = db.query; db.update(b.webhooks.table).set({ url: column }).run();', found: [unlisted(THROUGH_SCHEMA)] },
			{ form: 'the relational queries taken apart (K13)', code: 'const { query: q } = db; db.update((q as any).webhooks.table).set({ url: column }).run();', found: [unlisted(THROUGH_SCHEMA)] },
			{ form: 'the relational queries assigned apart (K13)', code: 'let q: any; ({ query: q } = db); db.update(q.webhooks.table).set({ url: column }).run();', found: [unlisted(THROUGH_SCHEMA)] },
			{ form: 'a key worked out off the database (K13)', code: "const k = '_'; db.update(Object.values(((db as any)[k]).fullSchema)[17] as never).set({ url: column }).run();", found: [unlisted(THROUGH_SCHEMA)] },
			// K14: the name with a piece that is not a literal straight after it.
			{ form: 'the name then a piece that is not a literal, joined by + (K14)', code: "const rest = ' SET url = ?'; sqlite.prepare('UPDATE webhooks' + rest).run(column);", found: [unlisted(IN_SQL)] },
			{ form: "the name then a template's substitution (K14)", code: 'sqlite.prepare(`UPDATE webhooks${column}`).run();', found: [unlisted(IN_SQL)] },
			{ form: 'the name then a substitution in a sql template (K14)', code: 'db.run(sql`UPDATE webhooks${sql.raw(column)}`);', found: [unlisted(IN_SQL)] },
			// K15: the name joined from pieces none of which is the name.
			{ form: 'sql.raw of pieces joined by + (K15)', code: "db.run(sql`UPDATE ${sql.raw('web' + 'hooks')} SET url = ${column}`);", found: [named()] },
			{ form: 'sql.identifier of pieces joined by + (K15)', code: "db.run(sql`UPDATE ${sql.identifier('web' + 'hooks')} SET url = ${column}`);", found: [named()] },
			{ form: 'a second table declared on pieces joined by + (K15)', code: "const h = sqliteTable('web' + 'hooks', {}); db.update(h).set({}).run();", found: [named()] },
			{ form: 'sql.raw of a template of pieces (K15)', code: "db.run(sql`UPDATE ${sql.raw(`${'web'}hooks`)} SET url = ${column}`);", found: [named()] },
			// K16: code built from a string.
			{ form: 'eval (K16)', code: "eval('db.update(webhooks).set({ url: column }).run()');", found: [ran()] },
			{ form: 'new Function (K16)', code: "new Function('d', 'w', 'd.update(w).set({ url: 1 }).run()');", found: [ran()] },
			{ form: 'Function called (K16)', code: "Function('return 1')();", found: [ran()] },
			{ form: 'eval off globalThis (K16)', code: "globalThis.eval('1');", found: [ran()] },
			{ form: "a function's constructor (K16)", code: "(() => 0).constructor('return 1')();", found: [ran()] },
			{ form: "a function's constructor by key (K16)", code: "(() => 0)['constructor']('return 1')();", found: [ran()] },
			// K17: a column anywhere but a drizzle-orm call with nothing taken off it, or a field handed to a read on the database.
			{ form: 'a column held in a variable (K17)', code: 'const c: any = webhooks.id; db.update(c.table).set({ url: column }).run();', found: [unlisted(COLUMN_ELSEWHERE)] },
			{ form: 'a column handed to another function (K17)', code: 'function up(c: any) { return db.update(c.table); } up(webhooks.id).set({ url: column }).run();', found: [unlisted(COLUMN_ELSEWHERE)] },
			{ form: 'a column in an object literal held in a variable (K17)', code: 'const f: any = { c: webhooks.id }; db.update(f.c.table).set({ url: column }).run();', found: [unlisted(COLUMN_ELSEWHERE)] },
			{ form: "something taken off a drizzle-orm call's result (K17)", code: 'db.update((eq(webhooks.id, 1) as any).queryChunks[1].table).set({ url: column }).run();', found: [unlisted(COLUMN_ELSEWHERE)] },
			{
				form: 'a field handed to a select not on the database (K17)',
				code: 'const fake: any = { select: (o: any) => db.update(o.c.table) }; fake.select({ c: webhooks.id }).set({ url: column }).run();',
				found: [unlisted(COLUMN_ELSEWHERE)]
			}
		])('finds $form (code review)', ({ code, found }) => {
			expect(findingsOf(code)).toEqual(found);
		});

		it.each([
			{ form: 'a SELECT', code: "sqlite.prepare('SELECT id, url FROM webhooks WHERE board_id = ?').all(1);" },
			{ form: '.from() and its columns', code: 'db.select({ id: webhooks.id }).from(webhooks).where(eq(webhooks.boardId, 1)).all();' },
			{ form: 'a join', code: 'db.select().from(boards).innerJoin(webhooks, eq(webhooks.boardId, boards.id)).all();' },
			{ form: 'a Drizzle delete', code: 'db.delete(webhooks).where(eq(webhooks.id, 1)).run();' },
			{ form: "a read on a transaction's handle (K4)", code: 'db.transaction((tx) => tx.select().from(webhooks).where(eq(webhooks.id, 1)).all());' },
			{ form: "a delete on a transaction's handle (K4)", code: 'db.transaction((tx) => tx.delete(webhooks).where(eq(webhooks.id, 1)).run());' },
			{ form: 'a relational read (K1)', code: 'db.query.webhooks.findMany();' },
			{ form: 'a relational read of one (K1)', code: 'db.query.webhooks.findFirst({ where: eq(webhooks.id, 1) });' },
			{ form: 'DELETE FROM', code: "sqlite.prepare('DELETE FROM webhooks WHERE id = ?').run(1);" },
			{ form: 'a longer name', code: "sqlite.prepare('UPDATE webhooks_old SET url = ?').run('x');" },
			{ form: 'the word in words (K2)', code: 'const words = `${column} webhooks`;' },
			{ form: 'a type', code: 'const row: typeof webhooks.$inferSelect | undefined = undefined;' },
			{ form: 'a property named webhooks', code: 'return { webhooks: 2 } as { webhooks: number };' },
			{ form: 'a count on the database (K18)', code: 'db.$count(webhooks, eq(webhooks.boardId, 1));' },
			{ form: "a count on a transaction's handle (K18)", code: 'db.transaction((tx) => tx.$count(webhooks));' },
			{ form: 'a read after a with (K18)', code: "const s = db.$with('s').as(db.select().from(boards)); db.with(s).select().from(webhooks).all();" }
		])('finds nothing in $form', ({ code }) => {
			expect(findingsOf(code)).toEqual([]);
		});

		it('finds the table by another name, a namespace, a re-export or import(), in a page script, a new or busier function in a listed file, a switch-off writer doing more, and fillSecretGaps imported elsewhere', () => {
			// Imported under another name, and as a namespace: each import a finding, and the write found through it.
			const aliased = ["import { webhooks as hooks } from '$lib/server/db/schema';", 'export const reopen = () => db.insert(hooks).values({}).run();'].join('\n');
			expect(judgeWebhookWrites(EXAMPLE, aliased, WEBHOOK_WRITERS).findings).toEqual([
				`${EXAMPLE}:1 imports webhooks as hooks: import it by its own name (card 2702)`,
				unlisted('inserts into webhooks', 2)
			]);
			const namespace = ["import * as schema from './db/schema';", 'export const reopen = () => db.update(schema.webhooks).set({}).run();'].join('\n');
			expect(judgeWebhookWrites(EXAMPLE, namespace, WEBHOOK_WRITERS).findings).toEqual([
				`${EXAMPLE}:1 imports ${WEBHOOK_SCHEMA} as a namespace: import webhooks by its own name (card 2702)`,
				unlisted('updates webhooks', 2)
			]);
			const elsewhere = ["export * from '$lib/server/db/schema';", "export { webhooks } from './db/schema';", "const later = () => import('$lib/server/db/schema');"].join('\n');
			expect(judgeWebhookWrites(EXAMPLE, elsewhere, WEBHOOK_WRITERS).findings).toEqual([
				`${EXAMPLE}:1 re-exports from ${WEBHOOK_SCHEMA}: import webhooks from there by its own name (card 2702)`,
				`${EXAMPLE}:2 re-exports from ${WEBHOOK_SCHEMA}: import webhooks from there by its own name (card 2702)`,
				`${EXAMPLE}:3 imports ${WEBHOOK_SCHEMA} with import(): import webhooks by its own name (card 2702)`
			]);

			// A page's script, and not its words.
			const PAGE = 'src/routes/example/+page.svelte';
			const page = ['<p>We update webhooks for you.</p>', '<script lang="ts">', "\tconst sent = 'UPDATE webhooks SET url = ?';", '</script>'].join('\n');
			expect(judgeWebhookWrites(PAGE, page, WEBHOOK_WRITERS).findings).toEqual([unlisted(IN_SQL, 3, '(top level)', PAGE)]);

			// A listed file: its writer as listed passes; a new function, a second write and a write that does more are found.
			// Made-up files (card 2923's code review, E4): auth.ts and deletes.ts now hold no write of their own.
			const AUTH = EXAMPLE_AUTH;
			const endAccountAccess = (body: string[]) =>
				["import { db } from './db'; import { eq } from 'drizzle-orm';", "import { webhooks } from './db/schema';", 'export function endAccountAccess(userId: number) {', ...body.map((each) => `\t${each}`), '}'];
			const offOnly = 'db.update(webhooks).set({ active: false }).where(eq(webhooks.setBy, userId)).run();';
			expect(judgeWebhookWrites(AUTH, endAccountAccess([offOnly]).join('\n'), EXAMPLE_WRITERS).findings).toEqual([]);
			const added = [...endAccountAccess([offOnly]), 'export function reopenHooks(userId: number) {', '\tdb.update(webhooks).set({ active: true }).run();', '}'];
			expect(judgeWebhookWrites(AUTH, added.join('\n'), EXAMPLE_WRITERS).findings).toEqual([unlisted('updates webhooks', 7, 'reopenHooks', AUTH)]);
			expect(judgeWebhookWrites(AUTH, endAccountAccess([offOnly, offOnly]).join('\n'), EXAMPLE_WRITERS).findings).toEqual([
				`${AUTH}#endAccountAccess writes the webhooks table 2 time(s), and WEBHOOK_WRITERS says 1 (card 2702)`
			]);
			const doesMore = (at: number, what = 'updates webhooks', file = AUTH, name = 'endAccountAccess') =>
				`${file}:${at} ${what} in ${name}, which WEBHOOK_WRITERS lists as switching off only, and does more (card 2702)`;
			const more = "db.update(webhooks).set({ active: false, url: 'https://x.test' }).run();";
			expect(judgeWebhookWrites(AUTH, endAccountAccess([more]).join('\n'), EXAMPLE_WRITERS).findings).toEqual([doesMore(4)]);
			const DELETES = EXAMPLE_DELETES;
			const onAgain = ['export function deleteUser(userId: number) {', "\tsqlite.prepare('UPDATE webhooks SET active = 1 WHERE set_by = ?').run(userId);", '}'].join('\n');
			expect(judgeWebhookWrites(DELETES, onAgain, EXAMPLE_WRITERS).findings).toEqual([doesMore(2, IN_SQL, DELETES, 'deleteUser')]);

			// Card 2752 (E11): a switch-off writer may record why and when beside active off, in either form, and the hold alone is more.
			const HOOKS = 'src/lib/server/webhooks.ts';
			const switchOffHeld = (body: string) =>
				[
					"import { db, sqlite } from './db'; import { eq } from 'drizzle-orm';",
					"import { webhooks } from './db/schema';",
					"const log = createLogger('Webhooks');",
					'export function switchOffHeld(id: number, hold: string) {',
					`\t${body}`,
					'}',
					// Card 2923: the file's other listed writer, as it is, so that only switchOffHeld is judged here.
					'export function holdUnheldOfGoneSetters() {',
					"\tsqlite.prepare(\"UPDATE webhooks SET active = 0, held_because = 'setter access ended', held_at = ? WHERE active = 0\").run('x');",
					'}',
					// Card 2923's code review (E4), card 2935: its third, the one hold statement, and its three callers.
					'function holdInScope(scope: string) {',
					"\tsqlite.prepare(\"UPDATE webhooks SET active = 0, held_because = 'setter access ended', held_at = ? WHERE set_by = ?\").run('x', scope);",
					'}',
					"export function holdWebhooksOfSetter() { holdInScope('a'); }",
					"export function holdNoLongerReadable() { holdInScope('b'); }",
					"export function coverReadable() { holdInScope('c'); }"
				].join('\n');
			const heldWith = (body: string) => judgeWebhookWrites(HOOKS, switchOffHeld(body), WEBHOOK_WRITERS).findings;
			expect(heldWith("db.update(webhooks).set({ active: false, heldBecause: hold, heldAt: '2026-11-18 00:00:00' }).where(eq(webhooks.id, id)).run();")).toEqual([]);
			expect(heldWith("sqlite.prepare('UPDATE webhooks SET active = 0, held_because = ?, held_at = ? WHERE id = ?').run(hold, 'x', id);")).toEqual([]);
			expect(heldWith('db.update(webhooks).set({ heldBecause: null, heldAt: null }).where(eq(webhooks.id, id)).run();')).toEqual([
				doesMore(5, 'updates webhooks', HOOKS, 'switchOffHeld')
			]);
			expect(heldWith("sqlite.prepare('UPDATE webhooks SET held_because = NULL, held_at = NULL WHERE id = ?').run(id);")).toEqual([
				doesMore(5, IN_SQL, HOOKS, 'switchOffHeld')
			]);
			expect(heldWith("sqlite.prepare('UPDATE webhooks SET active = 0, held_because = ?, url = ? WHERE id = ?').run(hold, 'x', id);")).toEqual([
				doesMore(5, IN_SQL, HOOKS, 'switchOffHeld')
			]);

			// The secret refill, imported by a file not allowed it: by name, under another name, and as a namespace.
			const importing = [
				"import { fillSecretGaps } from './backup-secrets';",
				"import { fillSecretGaps as fill } from '$lib/server/backup-secrets';",
				"import * as secrets from '$lib/server/backup-secrets';"
			].join('\n');
			expect(judgeWebhookWrites(EXAMPLE, importing, WEBHOOK_WRITERS).findings).toEqual([
				`${EXAMPLE}:1 imports fillSecretGaps, ${refill}`,
				`${EXAMPLE}:2 imports fillSecretGaps, ${refill}`,
				`${EXAMPLE}:3 imports fillSecretGaps as a namespace, ${refill}`,
				// And card 2928's address refill, held in the same module.
				`${EXAMPLE}:3 imports fillAddressGaps as a namespace, ${addressRefill}`
			]);
		});

		// Code review K5, K6, K9, K12: whole made-up files, each a case of its own.
		const AUTH = EXAMPLE_AUTH;
		const DELETES = EXAMPLE_DELETES;
		const SECRETS = 'src/lib/server/backup-secrets.ts';
		const RESTORE = 'src/lib/server/db/restore.ts';
		const TSX = 'src/lib/server/example.tsx';
		const doesMore = (at: number, what: string, file: string, name: string) =>
			`${file}:${at} ${what} in ${name}, which WEBHOOK_WRITERS lists as switching off only, and does more (card 2702)`;
		const endAccountAccess = (code: string) =>
			["import { db } from './db'; import { eq } from 'drizzle-orm';", "import { webhooks } from './db/schema';", 'export function endAccountAccess(userId: number) {', `\t${code}`, '}'].join('\n');
		const deleteUser = (code: string) => ["import { sqlite } from './db';", 'export function deleteUser(userId: number, extra: string) {', `\t${code}`, '}'].join('\n');
		const secrets = readFileSync(join(ROOT, SECRETS), 'utf8');
		const restore = readFileSync(join(ROOT, RESTORE), 'utf8');
		/** The line after the last of `source`'s, where a made-up line is added. */
		const after = (source: string) => source.split('\n').length + 1;
		const declaration = "export const webhooks = sqliteTable('webhooks', { id: integer('id') });";
		const deliveries = "export const deliveries = sqliteTable('webhook_deliveries', { webhookId: integer('webhook_id').references(() => webhooks.id) });";
		/** db/index.ts's namespace import, given to drizzle() as its schema on line 3, and `code` as line 4. */
		const index = (code: string) =>
			["import { drizzle } from 'drizzle-orm/better-sqlite3';", "import * as schema from './schema';", 'export const db = drizzle(sqlite, { schema });', code].join('\n');

		it.each([
			// K12, K1, K4: a switch-off writer switches off, on the database, and nothing else.
			{ form: 'a Drizzle switch-off that blanks the secret', file: AUTH, source: endAccountAccess("db.update(webhooks).set({ secret: '' }).where(eq(webhooks.setBy, userId)).run();"), found: [] },
			{ form: 'a Drizzle switch-off and a blank secret', file: AUTH, source: endAccountAccess("db.update(webhooks).set({ active: false, secret: '' }).run();"), found: [] },
			{ form: 'a Drizzle switch-off on a made-up object', file: AUTH, source: endAccountAccess('fake.update(webhooks).set({ active: false }).run();'), found: [doesMore(4, 'updates webhooks', AUTH, 'endAccountAccess')] },
			{
				form: "a Drizzle switch-off with the table reached off its builder",
				file: AUTH,
				source: endAccountAccess("db.update(db.update(webhooks).set({ active: false }).config.table).set({ url: 'x' }).run();"),
				found: [doesMore(4, 'updates webhooks', AUTH, 'endAccountAccess')]
			},
			{ form: 'the SQL switch-off', file: DELETES, source: deleteUser("sqlite.prepare('UPDATE webhooks SET active = 0 WHERE set_by = ? AND active = 1 RETURNING id').all(userId);"), found: [] },
			{ form: 'the SQL switch-off that blanks the secret', file: DELETES, source: deleteUser(`sqlite.prepare("UPDATE webhooks SET secret = '', active = 0 WHERE set_by = ?").run(userId);`), found: [] },
			{ form: 'a mixed SQL write', file: DELETES, source: deleteUser("sqlite.prepare('UPDATE webhooks SET active = 0, url = ? WHERE set_by = ?').run('x', userId);"), found: [doesMore(3, IN_SQL, DELETES, 'deleteUser')] },
			{ form: 'a SQL switch-off with a substitution', file: DELETES, source: deleteUser('sqlite.prepare(`UPDATE webhooks SET active = 0 ${extra}`).run();'), found: [doesMore(3, IN_SQL, DELETES, 'deleteUser')] },
			// K5: fillSecretGaps, referred to only by restoreInOneSnapshot, once, in its own module too.
			{ form: 'a wrapper of fillSecretGaps in backup-secrets.ts', file: SECRETS, source: `${secrets}\nexport function refillAny(a: any, b: any) { return (fillSecretGaps as any)(a, b); }`, found: [referred(after(secrets), 'refillAny', SECRETS)] },
			{ form: 'a second name for fillSecretGaps in restore.ts', file: RESTORE, source: `${restore}\nexport const again = fillSecretGaps;`, found: [referred(after(restore), '(top level)', RESTORE)] },
			{
				form: 'a second call of fillSecretGaps in restoreInOneSnapshot',
				file: RESTORE,
				source: restore.replace('const filled = fillSecretGaps(', 'fillSecretGaps(live, here, listed, {}); const filled = fillSecretGaps('),
				found: [`${RESTORE}#restoreInOneSnapshot refers to fillSecretGaps 2 time(s), and WEBHOOK_WRITER_CALLERS says once (card 2702)`]
			},
			{
				form: 'fillSecretGaps re-exported by restore.ts',
				file: RESTORE,
				source: `${restore}\nexport { fillSecretGaps } from '../backup-secrets';`,
				found: [`${RESTORE}:${after(restore)} re-exports fillSecretGaps, which sets a webhook's secret and switches it on: no file may (card 2702)`]
			},
			// K9: import x = require() and require().
			{
				form: 'db/schema by import x = require()',
				file: EXAMPLE,
				source: ["import schema = require('$lib/server/db/schema');", 'export const reopen = () => db.update(schema.webhooks).set({}).run();'].join('\n'),
				found: [`${EXAMPLE}:1 imports ${WEBHOOK_SCHEMA} with require(): import webhooks by its own name (card 2702)`, unlisted('updates webhooks', 2)]
			},
			{
				form: 'backup-secrets by import x = require()',
				file: EXAMPLE,
				source: "import secrets = require('./backup-secrets');",
				// And card 2928's address refill, pinned the same way.
				found: [`${EXAMPLE}:1 imports fillSecretGaps with import x = require(), ${refill}`, `${EXAMPLE}:1 imports fillAddressGaps with import x = require(), ${addressRefill}`]
			},
			{
				form: 'backup-secrets by require()',
				file: EXAMPLE,
				source: "const secrets = require('$lib/server/backup-secrets');",
				found: [
					`${EXAMPLE}:1 imports src/lib/server/backup-secrets.ts with require(), which holds fillSecretGaps, which sets a webhook's secret and switches it on: import it by its own name, only in its callers' files (card 2702)`,
					`${EXAMPLE}:1 imports src/lib/server/backup-secrets.ts with require(), which holds fillAddressGaps, which sets a webhook's address and switches nothing on: import it by its own name, only in its callers' files (card 2702)`
				]
			},
			// K12: db/schema.ts is judged: its declaration and its columns pass; any other name for the table is found.
			{ form: "db/schema.ts's declaration and a column of it", file: WEBHOOK_SCHEMA, source: [declaration, deliveries].join('\n'), found: [] },
			{ form: 'the table named again in db/schema.ts', file: WEBHOOK_SCHEMA, source: [declaration, 'export const hooks = webhooks;'].join('\n'), found: [unlisted(USES_WEBHOOKS, 2, '(top level)', WEBHOOK_SCHEMA)] },
			{ form: 'the table re-exported under another name in db/schema.ts', file: WEBHOOK_SCHEMA, source: [declaration, 'export { webhooks as outbound };'].join('\n'), found: [unlisted(USES_WEBHOOKS, 2, '(top level)', WEBHOOK_SCHEMA)] },
			{
				form: 'a second table on the name in db/schema.ts',
				file: WEBHOOK_SCHEMA,
				source: [declaration, "export const again = sqliteTable('webhooks', {});"].join('\n'),
				found: [`${WEBHOOK_SCHEMA}#(top level) names the webhooks table in a string 2 time(s), and WEBHOOK_NAME_STRINGS says 1 (card 2702)`]
			},
			// K6: db/index.ts gives the namespace to drizzle() as its schema, and takes it whole nowhere else.
			{
				form: "db/index.ts's namespace as drizzle()'s schema, and a column through it in a drizzle-orm call",
				file: SCHEMA_AS_NAMESPACE,
				source: index("import { eq } from 'drizzle-orm'; export const byId = (id: number) => eq(schema.webhooks.id, id);"),
				found: []
			},
			// K17: a column through the namespace held in a variable, as anywhere else.
			{
				form: 'a column through the namespace held in a variable in db/index.ts (K17)',
				file: SCHEMA_AS_NAMESPACE,
				source: index('export const column = schema.webhooks.id;'),
				found: [unlisted(COLUMN_ELSEWHERE, 4, '(top level)', SCHEMA_AS_NAMESPACE)]
			},
			{ form: "the table by the namespace's element", file: SCHEMA_AS_NAMESPACE, source: index("export const one = schema['webhooks'];"), found: [whole(4), named(4, '(top level)', SCHEMA_AS_NAMESPACE)] },
			{ form: 'the table destructured from the namespace', file: SCHEMA_AS_NAMESPACE, source: index('export const { webhooks: hooks } = schema;'), found: [unlisted(TAKEN, 4, '(top level)', SCHEMA_AS_NAMESPACE), whole(4)] },
			{ form: "the namespace's values", file: SCHEMA_AS_NAMESPACE, source: index('export const all = Object.values(schema);'), found: [whole(4)] },
			{ form: 'the namespace spread', file: SCHEMA_AS_NAMESPACE, source: index('export const copy = { ...schema };'), found: [whole(4)] },
			{ form: 'the namespace as another function\'s option', file: SCHEMA_AS_NAMESPACE, source: index('export const other = elsewhere(sqlite, { schema });'), found: [whole(4)] },
			{
				form: 'the namespace given to a made-up drizzle()',
				file: SCHEMA_AS_NAMESPACE,
				source: ['function drizzle(a: unknown, b: unknown) { return b; }', "import * as schema from './schema';", 'export const db = drizzle(sqlite, { schema });'].join('\n'),
				found: [whole(3)]
			},
			// K6: a .tsx file is read as one.
			{
				form: 'a write in a .tsx file',
				file: TSX,
				source: [
					"import { db } from '$lib/server/db';",
					"import { webhooks } from '$lib/server/db/schema';",
					"export const Panel = () => <button onClick={() => db.update(webhooks).set({ url: 'x' }).run()}>Go</button>;"
				].join('\n'),
				found: [unlisted('updates webhooks', 3, 'Panel', TSX)]
			}
		])('judges $form (code review)', ({ file, source, found }) => {
			expect(judgeWebhookWrites(file, source, EXAMPLE_WRITERS).findings).toEqual(found);
		});

	});
});

// ─── A two-step reset under src always ends the keys (card 2915, S4) ────────

/**
 * Card 2915 (S4): `resetTwoStep` ends the account's API keys and switches off
 * the webhooks it set unless told `{ apiKeys: false }`, an option that exists
 * only as the test's model of the host's `--keep-api-keys`
 * (scripts/mfa-reset.mjs; tests/mfa-reset-script.test.ts, T21 and T34). So
 * every call of it under src passes no options, or options written out whose
 * `apiKeys`, where given, is literally `true`; anything else is a finding, by
 * file and line: `false`, a variable or any other expression, a shorthand, a
 * spread or a computed name among the options, options not written out, and
 * arguments spread. Calls are found by the name called, directly, as a
 * property (`store.resetTwoStep`) or by its string (`store['resetTwoStep']`),
 * under any name an import gives it (`import { resetTwoStep as reset }`), and
 * through `as`, `satisfies` and `<T>` (card 2915's code review, CS1); any
 * `.call`, `.apply` or `.bind` of it is a finding outright, its options not
 * read. Not seen: `resetTwoStep` held in a variable or handed on and called
 * under another name.
 */
function keysKeptAtReset(file: string, source: string): { calls: number; findings: string[] } {
	const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const tree = ts.createSourceFile(file, file.endsWith('.svelte') ? scriptsOf(source) : source, ts.ScriptTarget.Latest, true, kind);
	const at = (node: ts.Node) => `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`;
	const reading = { calls: 0, findings: [] as string[] };
	// The names the file calls it by: its own, and each an import gives it.
	const names = new Set(['resetTwoStep']);
	for (const statement of tree.statements) {
		const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
		if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
		for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === 'resetTwoStep') names.add(element.name.text);
	}
	/** `node` without parentheses, `await`, `!`, `as`, `satisfies` and `<T>` round it. */
	const stripped = (node: ts.Expression): ts.Expression => {
		let inner = bare(node);
		while (ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isTypeAssertionExpression(inner)) inner = bare(inner.expression);
		return inner;
	};
	/** Whether `node` is resetTwoStep: one of its names, `x.resetTwoStep` or `x['resetTwoStep']`. */
	const isReset = (node: ts.Expression): boolean => {
		const inner = stripped(node);
		if (ts.isIdentifier(inner)) return names.has(inner.text);
		if (ts.isPropertyAccessExpression(inner)) return inner.name.text === 'resetTwoStep';
		if (ts.isElementAccessExpression(inner)) {
			const key = stripped(inner.argumentExpression);
			return (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && key.text === 'resetTwoStep';
		}
		return false;
	};
	const visit = (node: ts.Node): void => {
		if (ts.isPropertyAccessExpression(node) && ['call', 'apply', 'bind'].includes(node.name.text) && isReset(node.expression)) {
			reading.calls++;
			reading.findings.push(`${at(node)} calls resetTwoStep through .${node.name.text}, whose options cannot be read: call it directly`);
		}
		if (ts.isCallExpression(node)) {
			if (isReset(node.expression)) {
				reading.calls++;
				if (node.arguments.some(ts.isSpreadElement)) reading.findings.push(`${at(node)} calls resetTwoStep with its arguments spread`);
				const options = node.arguments[2] === undefined ? undefined : bare(node.arguments[2]);
				if (options !== undefined && !ts.isObjectLiteralExpression(options)) {
					reading.findings.push(`${at(node)} calls resetTwoStep with options that are not written out`);
				} else if (options !== undefined) {
					for (const property of options.properties) {
						const key = ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null;
						if (key === null) reading.findings.push(`${at(property)} calls resetTwoStep with an option that is not written out`);
						else if (key === 'apiKeys' && (property as ts.PropertyAssignment).initializer.kind !== ts.SyntaxKind.TrueKeyword) {
							reading.findings.push(`${at(property)} calls resetTwoStep with apiKeys not literally true: only the host keeps keys at a reset`);
						}
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return reading;
}

describe('a reset of the two-step sign-in under src always ends the keys (card 2915, S4)', () => {
	it("finds no call of resetTwoStep under src that passes apiKeys other than literally true: { apiKeys: false } is the test's model of the host's --keep-api-keys", () => {
		const readings = filesUnder('src', (path) => WEBHOOK_WALKED.test(path)).map((file) => ({ file, ...keysKeptAtReset(file, readFileSync(join(ROOT, file), 'utf8')) }));

		expect(readings.flatMap(({ findings }) => findings)).toEqual([]);
		// The route's own call is among those read: the scan is not reading nothing.
		expect(readings.find(({ file }) => file === 'src/routes/api/users/[id]/mfa/reset/+server.ts')?.calls).toBe(1);
		// And the rule finds each way of keeping them.
		const EXAMPLE = 'src/lib/server/example.ts';
		const judged = (call: string) => keysKeptAtReset(EXAMPLE, `import { resetTwoStep } from './mfa-store';\n${call}`).findings;
		expect(judged("resetTwoStep(1, 'admin-reset', { apiKeys: true });")).toEqual([]);
		expect(judged("resetTwoStep(1, 'admin-reset');")).toEqual([]);
		expect(judged("resetTwoStep(1, 'admin-reset', { apiKeys: false });")).toHaveLength(1);
		expect(judged("store.resetTwoStep(1, 'admin-reset', { 'apiKeys': keep });")).toHaveLength(1);
		expect(judged("resetTwoStep(1, 'admin-reset', { apiKeys });")).toHaveLength(1);
		expect(judged("resetTwoStep(1, 'admin-reset', { ...options });")).toHaveLength(1);
		expect(judged("resetTwoStep(1, 'admin-reset', options);")).toHaveLength(1);
		expect(judged('resetTwoStep(...args);')).toHaveLength(1);
	});

	// Card 2915's code review (CS1): each way of reaching it that the first walk did not see, one example each.
	it.each([
		{ form: 'an aliased import', source: "import { resetTwoStep as reset } from './mfa-store';\nreset(1, 'admin-reset', { apiKeys: false });" },
		{ form: '.call', source: "import { resetTwoStep } from './mfa-store';\nresetTwoStep.call(null, 1, 'admin-reset', { apiKeys: false });" },
		{ form: '.apply', source: "import { resetTwoStep } from './mfa-store';\nresetTwoStep.apply(null, [1, 'admin-reset', { apiKeys: false }]);" },
		{ form: '.bind', source: "import { resetTwoStep } from './mfa-store';\nconst keep = resetTwoStep.bind(null, 1, 'admin-reset', { apiKeys: false });" },
		{ form: 'an element access by its string', source: "import * as store from './mfa-store';\nstore['resetTwoStep'](1, 'admin-reset', { apiKeys: false });" },
		{ form: 'as', source: "import { resetTwoStep } from './mfa-store';\n(resetTwoStep as typeof resetTwoStep)(1, 'admin-reset', { apiKeys: false });" },
		{ form: 'satisfies', source: "import { resetTwoStep } from './mfa-store';\n(resetTwoStep satisfies typeof resetTwoStep)(1, 'admin-reset', { apiKeys: false });" },
		{ form: 'a <T> assertion', source: "import { resetTwoStep } from './mfa-store';\n(<typeof resetTwoStep>resetTwoStep)(1, 'admin-reset', { apiKeys: false });" }
	])('finds resetTwoStep keeping the keys reached through $form (code review, CS1)', ({ source }) => {
		const reading = keysKeptAtReset('src/lib/server/example.ts', source);

		expect(reading.calls).toBe(1);
		expect(reading.findings).toHaveLength(1);
		expect(reading.findings[0]).toMatch(/^src\/lib\/server\/example\.ts:2 calls resetTwoStep /);
	});
});

// ─── Card 2995: every delete of an API key or an account, and the record of ended keys ─────────────

/**
 * Card 2995 (R12, test 21): where an API key or an account may be deleted, or replaced, which deletes it, by
 * `file#function` (`writerNameOf`), with how many such statements and why. Deleting an account deletes its keys by the
 * foreign key, so a delete of `users` is a delete of keys. Every key deleted here is first recorded (`endApiKeys`), or
 * is one the restore leaves out of a backup, which this server did not end.
 */
const KEY_DELETERS: Record<string, { count: number; why: string }> = {
	'src/lib/server/key-revocations.ts#endApiKeys': {
		count: 1,
		why:
			"The one delete of API keys by an ending: after the record's INSERT OR IGNORE, in the same transaction, on the connection it is given (card 2995). " +
			"With `recordOnly`, which only the restore passes and only where the backup's seal did not verify (RECORD_ONLY_CALLERS), it records only this " +
			"server's own keys of the same accounts here, by id, hash and owner, and deletes the file's other keys unrecorded: this server never held them (card 3013, D4)."
	},
	'src/lib/server/db/restore.ts#leaveOut': {
		count: 1,
		why:
			"The restore's leave-out: one DELETE ... WHERE EXISTS over the record, the gate's own predicate (R6), and a working copy's every key (R4). " +
			'Keys of the backup, not ended here; those it names were recorded already, and, from a sealed backup only, the seed-matched ones are hash-recorded first (R2; card 3013, D5).'
	},
	'src/lib/server/deletes.ts#deleteUser': {
		count: 1,
		why: "DELETE FROM users, which cascades to the account's keys, after endApiKeys has recorded and deleted every key it still held (card 2995, decision 17)."
	},
	'scripts/mfa-reset.mjs#reset': {
		count: 1,
		why: "The host's two-step reset deletes the account's keys after its RECORD_ACCOUNT_KEYS_ENDED_SQL, the server's statement word for word (tests/mfa-reset-script.test.ts)."
	}
};

/**
 * Card 2995 (R12): the statements that delete from, or drop, a table named at run time, by `file#function`, with how
 * many and why. Each can reach `api_keys` or `users` without naming either.
 */
const KEY_DYNAMIC_CLEARS: Record<string, { count: number; why: string }> = {
	'src/lib/server/db/restore.ts#restoreInOneSnapshot': {
		count: 1,
		why: "The restore's clear of every restorable table, which `restorableTables` keeps the record out of: the backup's keys replace this server's, which is not an ending (decision 18); those the record names are then left out."
	},
	'src/lib/server/db/restore.ts#raiseUserCounterOverNamed': {
		count: 1,
		why: "Card 3033's code review (FP2): a restored row whose account column, which takes no NULL, names no whole number from 1 to 2^53 - 1, deleted; never in api_keys (ROWS_LEFT_AS_THEY_ARE), and users has no such column."
	},
	'src/routes/api/admin/reset/+server.ts#POST': {
		count: 1,
		why: "Reset Everything's clear of every restorable table, after endApiKeys has recorded and deleted every key, `reset` (R5); KEPT names the record."
	},
	'src/lib/server/db/migrate.ts#rebuildTable': {
		count: 1,
		why: "The migration runner's rebuild drops a table after copying its rows into its new shape; it rebuilds only boards, columns, categories, settings, user_xp and invite_tokens."
	},
	'src/lib/server/db/migrate.ts#storedSoByItsType': {
		count: 1,
		why: "The rebuild's probe drops its own temporary table (temp.<scratch>_probe), which it made a line before; never a table of the application."
	},
	'src/lib/server/db/migrate.ts#planRebuild': {
		count: 1,
		why: 'Advice in the text of an Obstacle, never run: the runner tells the host how to clear the rows that block a rebuild.'
	}
};

/** The columns an `UPDATE api_keys` may set (R12): when a key was last used, and its deadline, which Keep clears. */
const KEY_UPDATE_COLUMNS = ['last_used_at', 'deadline_at'];
const KEY_UPDATE_FIELDS = ['lastUsedAt', 'deadlineAt'];

/**
 * Card 3009 (R5): the one place an `UPDATE api_keys` may set `expires_at` too, by `file#function`, with how many and
 * why: never the hash, the owner or anything else, and only ever to an earlier moment than the key had. Every other
 * writer is held to KEY_UPDATE_COLUMNS as before.
 */
const KEY_EXPIRY_WRITERS: Record<string, { count: number; why: string }> = {
	'src/lib/server/db/restore.ts#takeEarlierEnds': {
		count: 1,
		why:
			"Card 3009, R5: a key a backup whose seal did not verify brought back, kept because this server held that very key for the same account, given " +
			"the earlier of this server's expiry and the file's (earlierEnd), so that a key expired here never comes back working from a file that says it has none. It only ever ends a key sooner."
	}
};

/** The functions that may call `endApiKeys` (R12), each once: every ender. */
const END_API_KEYS_CALLERS = [
	'src/lib/server/api-key-revoke.ts#revokeApiKeys',
	'src/lib/server/auth.ts#endAccountAccess',
	// The restore's ending of an account it disables, shared by card 2671's carry and card 2996's applyAccountEndings: the
	// function `restoredAccessEnder` makes once for a restore's connection (card 2996's code review, FP11).
	'src/lib/server/db/restore.ts#restoredAccessEnder',
	'src/lib/server/deletes.ts#deleteUser',
	'src/routes/api/admin/reset/+server.ts#POST'
];

/**
 * Card 3013 (D4, R8): the functions that may call `endApiKeys` with a fourth argument, `recordOnly`, which records only
 * the keys it lists. Only the restore's ender passes it, and the restore gives it one only where the backup's seal did
 * not verify: a sealed restore, and every other ender, records every key it ends. Case (g) of the card's tests proves
 * the sealed half in behaviour.
 */
const RECORD_ONLY_CALLERS = ['src/lib/server/db/restore.ts#restoredAccessEnder'];

/** A name of SQL's, as SQLite reads it: bare, quoted, backticked or bracketed, with a schema before it or not. */
const sqlName = (name: string) => String.raw`(?:["'\x60[]?\w+["'\x60\]]?${SQL_GAP}*\.${SQL_GAP}*)?["'\x60[]?${name}["'\x60\]]?(?![\w$])`;

/** A delete or a replace, which deletes, of api_keys or users. */
const KEY_SQL_DELETE = new RegExp(
	String.raw`\b(DELETE${SQL_GAP}+FROM|REPLACE${SQL_GAP}+INTO|INSERT${SQL_GAP}+OR${SQL_GAP}+REPLACE${SQL_GAP}+INTO|UPDATE${SQL_GAP}+OR${SQL_GAP}+REPLACE)${SQL_GAP}+(${sqlName('(?:api_keys|users)')})`,
	'gi'
);

/** A drop or an alteration of api_keys or users, by name (card 2995's code review, FP6): never anywhere under src or scripts. */
const KEY_SQL_DROP = new RegExp(
	String.raw`\b(DROP${SQL_GAP}+TABLE(?:${SQL_GAP}+IF${SQL_GAP}+EXISTS)?|ALTER${SQL_GAP}+TABLE)${SQL_GAP}+(${sqlName('(?:api_keys|users)')})`,
	'gi'
);

/** An upsert into api_keys that updates (FP6): `INSERT … INTO api_keys … ON CONFLICT … DO UPDATE`, which rewrites a key. */
const KEY_SQL_UPSERT = new RegExp(
	String.raw`\bINSERT(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+INTO${SQL_GAP}+${sqlName('api_keys')}[^;]*?\bON${SQL_GAP}+CONFLICT\b[^;]*?\bDO${SQL_GAP}+UPDATE\b`,
	'gi'
);

/** An update of api_keys, with what it sets. */
const KEY_SQL_UPDATE = new RegExp(String.raw`\bUPDATE(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+${sqlName('api_keys')}${SQL_GAP}+SET\b([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|\bFROM\b|;|$)`, 'gi');

/** Anything but an INSERT OR IGNORE of the record (R12, test g): a delete, an update, a replace, or a drop. */
const RECORD_SQL_WRITE = new RegExp(
	String.raw`\b(DELETE${SQL_GAP}+FROM|UPDATE(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?|REPLACE${SQL_GAP}+INTO|INSERT${SQL_GAP}+OR${SQL_GAP}+REPLACE${SQL_GAP}+INTO|DROP${SQL_GAP}+TABLE(?:${SQL_GAP}+IF${SQL_GAP}+EXISTS)?|ALTER${SQL_GAP}+TABLE)${SQL_GAP}+${sqlName('api_key_revocations')}`,
	'gi'
);

/** A table named at run time after DELETE FROM or DROP TABLE: `\u0000` stands for a template's substitution, or a piece that is no literal. */
const DYNAMIC_CLEAR = new RegExp(String.raw`\b(DELETE${SQL_GAP}+FROM|DROP${SQL_GAP}+TABLE(?:${SQL_GAP}+IF${SQL_GAP}+EXISTS)?)${SQL_GAP}+["'\x60[]?\u0000`, 'gi');

// ─── Card 2996: every write of an account's ending, and the record of account endings ─────────────

/** The columns of `users` an ending writes (R9 i): a role, a disable, a password. */
const USERS_ENDING_COLUMNS = ['role', 'disabled_at', 'disabled_by', 'password_hash'];
const USERS_ENDING_FIELDS = ['role', 'disabledAt', 'disabledBy', 'passwordHash'];

/**
 * Card 2996 (R9 i, vi): every write of `users` that sets a role, a disable or a password hash, or sets fields built at
 * run time, by `file#function`, with how many and why. Each is an ending of an account or a way back from one, and is
 * recorded where it ends one (`recordAccountEnding`), or is the restore's or the start's own application of the record.
 */
const USERS_ENDING_WRITES: Record<string, { count: number; why: string }> = {
	'src/lib/server/account-ending-bodies.ts#disableAccountSteps': { count: 1, why: "The disable's body (R5): disabled_at and disabled_by, recorded `disabled` in the same transaction." },
	'src/lib/server/account-ending-bodies.ts#giveDummyHash': {
		count: 1,
		why:
			"DUMMY_HASH and no enrol leave, the module's one such write (card 2997's code review, FP10): for makeInert (R5, R6), the hash it discards recorded first as replaced, " +
			"a belt row (N1); and for the start's password pass (endReplacedPasswordsPresent, S1a, R3, R4), over a hash the record already names, so no row, then endAccountAccess."
	},
	'src/lib/server/account-ending-bodies.ts#changeAccountRole': { count: 1, why: "The role change's body (R5), its fields the route's: recorded `role`, with the role after." },
	'src/lib/server/account-disable.ts#enableAccount': { count: 1, why: 'The enable: both columns cleared, recorded `enabled`; refused for an account the record names deleted.' },
	'src/routes/api/users/[id]/+server.ts#PUT': {
		count: 2,
		why:
			'The username and emoji alone (:166, the plan\'s :160), and an email change with no role change, or a role sent as the one it has (:234, the plan\'s :210): ' +
			'no disable or password is among the fields readAccountFields gives, and a role that changes goes through changeAccountRole.'
	},
	'src/routes/api/account/password/+server.ts#PUT': {
		count: 1,
		why: "The holder's own password change, with the current password (card 2701): the hash it replaces recorded first, `password`, in the same transaction (card 2997, W1)."
	},
	'src/routes/api/users/[id]/password/+server.ts#PUT': {
		count: 1,
		why: "An administrator's password set, which ends the account's access (endAccountAccess): the hash it replaces recorded first, `password` (card 2997, W2)."
	},
	'src/routes/invite/[token]/+page.server.ts#default': {
		count: 1,
		why: "An invite used to set a password, which ends the account's access (endAccountAccess): the hash it replaces recorded first, `password` (card 2997, W3)."
	},
	'src/lib/server/db/restore.ts#carryDisabled': { count: 1, why: "The restore's carry of this server's disables (card 2671): disabled_at and disabled_by, onto the same accounts restored." },
	'src/lib/server/db/restore.ts#applyAccountEndings': {
		count: 3,
		why:
			"The restore's application of the record (card 2996): an inert or before-record account, a disabled one, a lowered role. Card 3013 (D3): from a backup " +
			'whose seal did not verify, the account is ended the same way with no belt row written.'
	},
	'src/lib/server/db/restore.ts#applyPasswordRulings': {
		count: 2,
		why:
			"Card 2997 (S1b, section 13.1): the restore's password step, over a restored hash the record already names as replaced, or any, R2, from an unsealed backup, " +
			"with no row either way (card 3013, D3, removed the code review's FP6 belt: the file's hash is never recorded): this server's own hash for the same account, or DUMMY_HASH and no enrol leave, then endRestoredAccess. " +
			"Card 3009 adds no statement, only uses of the same two: from a backup whose seal did not verify, an account not the same here given DUMMY_HASH and no enrol " +
			"leave (`notTakenOne`, no row: the file's hash was never this server's, so nothing here replaced it), and the carry, `keep` giving the backup's superadmin the " +
			"importer's own hash as this server held it (section 14.1); its email write sets no ending column."
	},
	'src/lib/server/db/restore.ts#keepAccountStateHere': {
		count: 1,
		why:
			"Card 3013 (D6, R1, R2, R23), in place of card 3009's R2 step: from a backup whose seal did not verify, before the record's rulings and carryDisabled, " +
			"each account that is the same here given this server's role (a superadmin here a superadmin again), and each account of this server's id and " +
			"creation time its disabled state (disabled_at, and disabled_by as disablerFor names it; enabled where not disabled here). It puts back this " +
			"server's own state, ends nothing and records nothing; counted in accountStateAsHere (R22)."
	}
};

/** Card 2996 (R9 vi): the writers of `password_hash` among them. */
const PASSWORD_HASH_WRITERS = [
	'src/lib/server/account-ending-bodies.ts#changeAccountRole',
	// Card 2997 (code review, FP10): makeInert's and the start's password pass's DUMMY_HASH, one write.
	'src/lib/server/account-ending-bodies.ts#giveDummyHash',
	'src/lib/server/db/restore.ts#applyAccountEndings',
	// Card 2997 (S1b): the restore's password step, this server's hash or DUMMY_HASH over a hash already recorded as replaced.
	'src/lib/server/db/restore.ts#applyPasswordRulings',
	'src/routes/api/account/password/+server.ts#PUT',
	'src/routes/api/users/[id]/+server.ts#PUT',
	'src/routes/api/users/[id]/password/+server.ts#PUT',
	'src/routes/invite/[token]/+page.server.ts#default'
];

/**
 * Card 2997 (test aa, section 5): each writer of `password_hash` by its class. `records`: calls `recordPasswordReplaced`
 * before its write, in the same function and transaction, so the hash it replaces is recorded (W1, W2, W3, W7).
 * `restore`: the restore's own application of the record, over a hash already recorded or with a belt row written for
 * it (W8, W10). `start`: the start's password pass, `DUMMY_HASH` over a hash already recorded (W11; since the code
 * review's FP10 written by `giveDummyHash`, classed `records` with makeInert, so none is listed). `not a writer`:
 * listed by the scan because its `.set` is not an object literal, and never given a password (W14).
 */
const PASSWORD_HASH_CLASSES: Record<string, { kind: 'records' | 'restore' | 'start' | 'not a writer'; why: string }> = {
	'src/routes/api/account/password/+server.ts#PUT': { kind: 'records', why: 'W1, the holder’s own change: the hash it replaces recorded `here`, just before the update.' },
	'src/routes/api/users/[id]/password/+server.ts#PUT': { kind: 'records', why: 'W2, an administrator’s reset: the hash it replaces recorded `here`, just before the update.' },
	'src/routes/invite/[token]/+page.server.ts#default': { kind: 'records', why: 'W3, an invite used: the hash it replaces (a placeholder’s row is harmless) recorded `here`, just before the update.' },
	'src/lib/server/account-ending-bodies.ts#giveDummyHash': {
		kind: 'records',
		why:
			'W7 and W11 in one write (FP10): makeInert’s DUMMY_HASH, the hash it discards recorded as a `belt` row first (N1; nothing for a superadmin, R6); ' +
			'the start’s password pass, `belt: false`, over a present hash the record already names as replaced: nothing new to record.'
	},
	'src/lib/server/db/restore.ts#applyAccountEndings': {
		kind: 'restore',
		why:
			'W8, an inert or before-record account given DUMMY_HASH: a `belt` row of the restored hash written before it (N1), never for a superadmin, ' +
			'and never from a backup whose seal did not verify (card 3013, D3), whose hash was the file’s choice.'
	},
	'src/lib/server/db/restore.ts#applyPasswordRulings': {
		kind: 'restore',
		why:
			'W10, this server’s own hash for the same account, or DUMMY_HASH, over a restored hash the record already names, or one R2 discards, with no row: card 3013 (D3, R11) ' +
			'removed the FP6 belt, as that hash was the file’s choice and a row of it would reset any account here holding it. ' +
			'Card 3009, over an unsealed backup’s hash of an account not the same here: DUMMY_HASH with no row, as that hash was never this server’s and recording it would let ' +
			'a planted file fingerprint accounts for card 2996’s matcher; and the carry, the importer’s own hash as this server held it, which no row names.'
	},
	'src/lib/server/account-ending-bodies.ts#changeAccountRole': { kind: 'not a writer', why: 'W14: the route’s fields, which readAccountFields gives with no password; listed because `.set(updates)` is not written out.' },
	'src/routes/api/users/[id]/+server.ts#PUT': { kind: 'not a writer', why: 'W14: readAccountFields gives no password; listed because its `.set` is not an object literal.' }
};

/**
 * Card 2997 (test aa): the functions that may call `recordPasswordReplaced`, each once: the four writers that record
 * (W1, W2, W3, W7), the restore's belt (W8; card 3013, R11, removed R2's in W10, the code review's FP6) and Reset Everything, which
 * records every account's hash but the superadmin's before the clear (W12, decision 5). `scripts/` holds none, and writes no `password_hash` (R19): a host
 * script that ever writes a password must call `recordPasswordReplaced` before its write, and be listed here and in
 * PASSWORD_HASH_CLASSES as `records`.
 */
const RECORD_PASSWORD_REPLACED_CALLERS = [
	'src/lib/server/account-ending-bodies.ts#giveDummyHash',
	'src/lib/server/db/restore.ts#applyAccountEndings',
	'src/routes/api/account/password/+server.ts#PUT',
	'src/routes/api/admin/reset/+server.ts#POST',
	'src/routes/api/users/[id]/password/+server.ts#PUT',
	'src/routes/invite/[token]/+page.server.ts#default'
];

/**
 * Card 2997 (R19, test aa): the writes of `password_hash` found under `scripts/`, by `file#function`, which must be
 * none. One rule, asked of the walk and of the made-up script beside the rule's own examples (its code review, FP13).
 */
const scriptPasswordWrites = (readings: readonly KeyReading[]): string[] =>
	readings.flatMap(({ passwordWriters }) => passwordWriters).filter((key) => key.startsWith('scripts/'));

/**
 * Card 2996 (R9 ii): the `UPDATE users SET ${...}` built at run time, by `file#function`, with how many and why. Each
 * sets columns named in its own code, none of them a role, a disable or a password.
 */
const USERS_DYNAMIC_SETS: Record<string, { count: number; why: string }> = {
	'src/lib/server/second-step.ts#verifyStep': {
		count: 4,
		why: "A code's counters (:900, :914, :922) and a lane's pause (:947): the lane's own `*_wrong` and `*_resumes_at` columns, by name from its column table; never a role, a disable or a password."
	},
	'src/lib/server/mfa-backup.ts#restoreMfaRows': { count: 2, why: "The restore's guessing counters zeroed (:274) and the same accounts' sign-in history put back (:283): the columns of GUESSING and HISTORY." }
};

/** Card 2996 (R9 v): the functions that may call `recordAccountEnding`, each once. */
const RECORD_ACCOUNT_ENDING_CALLERS = [
	'src/lib/server/account-ending-bodies.ts#changeAccountRole',
	'src/lib/server/account-ending-bodies.ts#disableAccountSteps',
	'src/lib/server/account-ending-bodies.ts#endRecordedAccountsPresent',
	'src/lib/server/account-disable.ts#enableAccount',
	// Card 2997 (S1a): the writer of a `password` row, a thin wrapper over it; its own callers are pinned by
	// RECORD_PASSWORD_REPLACED_CALLERS (test aa).
	'src/lib/server/account-endings.ts#recordPasswordReplaced',
	'src/lib/server/db/restore.ts#applyAccountEndings',
	'src/lib/server/deletes.ts#deleteUser',
	'src/routes/api/admin/reset/+server.ts#POST',
	'src/routes/api/users/+server.ts#POST'
];

/**
 * Card 2996 (R9 iv): the only places that may INSERT INTO the record, a plain insert: the restore's union, and the
 * record's one statement, `RECORD_ACCOUNT_ENDING_SQL`, a constant at account-endings.ts's top level that
 * `recordAccountEnding` alone runs (exported for the pins, R10; its callers pinned by RECORD_ACCOUNT_ENDING_CALLERS).
 */
const ACCOUNT_RECORD_INSERTERS = ['src/lib/server/account-endings.ts#(top level)', 'src/lib/server/db/restore.ts#carryAccountEndings'];

/** An update of users, with what it sets. */
const USERS_SQL_UPDATE = new RegExp(String.raw`\bUPDATE(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+${sqlName('users')}${SQL_GAP}+SET\b([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|\bFROM\b|;|$)`, 'gi');

/** An upsert into users that updates (R9 iii): `INSERT … INTO users … ON CONFLICT … DO UPDATE`, which rewrites an account. */
const USERS_SQL_UPSERT = new RegExp(
	String.raw`\bINSERT(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+INTO${SQL_GAP}+${sqlName('users')}[^;]*?\bON${SQL_GAP}+CONFLICT\b[^;]*?\bDO${SQL_GAP}+UPDATE\b`,
	'gi'
);

/** Anything written to the record of account endings but a plain INSERT (R9 iv): a delete, an update, a replace, an insert or ignore, a drop. */
const ACCOUNT_RECORD_SQL_WRITE = new RegExp(
	String.raw`\b(DELETE${SQL_GAP}+FROM|UPDATE(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?|REPLACE${SQL_GAP}+INTO|INSERT${SQL_GAP}+OR${SQL_GAP}+\w+${SQL_GAP}+INTO|DROP${SQL_GAP}+TABLE(?:${SQL_GAP}+IF${SQL_GAP}+EXISTS)?|ALTER${SQL_GAP}+TABLE)${SQL_GAP}+${sqlName('account_endings')}`,
	'gi'
);

/** A plain INSERT INTO the record. */
const ACCOUNT_RECORD_SQL_INSERT = new RegExp(String.raw`\bINSERT${SQL_GAP}+INTO${SQL_GAP}+${sqlName('account_endings')}`, 'gi');

/** What the inventory found in one file (card 2995, R12; card 2996, R9). */
type KeyReading = {
	deletes: string[];
	clears: string[];
	enders: string[];
	/**
	 * Card 3013: each call of `endApiKeys` with a fourth argument (`recordOnly`), by `file#function`; and, as its code
	 * review's FP2 has it, each call whose arguments are spread, which may carry one.
	 */
	recordOnly: string[];
	/** Card 3013's code review (FP2): each call of `restoredAccessEnder`, by `file#function`, with its second argument's text. */
	accessEnders: { key: string; recordOnly: string | null }[];
	findings: string[];
	/** Card 2996: the writes of a role, a disable, a password or run-time fields of users, by `file#function`. */
	userWrites: string[];
	/** Card 2996: those of them that write `password_hash`. */
	passwordWriters: string[];
	/** Card 2996: the `UPDATE users SET ${...}` built at run time. */
	dynamicSets: string[];
	/** Card 2996: the callers of `recordAccountEnding`. */
	recorders: string[];
	/** Card 2997: the callers of `recordPasswordReplaced`. */
	passwordRecorders: string[];
	/** Card 2997: each such call and each write of `password_hash`, by `file#function`, where in the file it starts. */
	passwordSteps: { key: string; at: number; step: 'records' | 'writes' }[];
	/** Card 3009: each `UPDATE api_keys` that sets `expires_at`, by `file#function`. */
	expiryWrites: string[];
};

/**
 * Card 2995 (R12) for one file under src or scripts, reusing the webhook rule's ways of reading (`scriptsOf`,
 * `writerNameOf`, `SQL_GAP`): every string built from literals (one, a template, or pieces joined by `+`, each
 * substitution or piece that is not a literal read as `\u0000`) is read as SQL. A delete or replace of `api_keys` or
 * `users` is counted under its `file#function`, as is a delete or drop of a table named at run time; an `UPDATE
 * api_keys` that sets anything but `last_used_at` and `deadline_at` is a finding; and any delete, update, replace, drop
 * or alteration of `api_key_revocations` is a finding outright. In Drizzle, `.delete(apiKeys)` and `.delete(users)`
 * are counted the same way, `.update(apiKeys).set({...})` may set only `lastUsedAt` and `deadlineAt`, and
 * `.delete(apiKeyRevocations)` or `.update(apiKeyRevocations)` is a finding. Each call of `endApiKeys` is listed by its
 * `file#function`. Not seen: a table name worked out at run time other than by a template or `+`, a statement held in
 * a variable built elsewhere, a schema table under another name.
 */
function judgeKeyWrites(file: string, source: string): KeyReading {
	const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const tree = ts.createSourceFile(file, file.endsWith('.svelte') ? scriptsOf(source) : source, ts.ScriptTarget.Latest, true, kind);
	const at = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const keyOf = (node: ts.Node) => `${file}#${writerNameOf(node)}`;
	const reading: KeyReading = { deletes: [], clears: [], enders: [], recordOnly: [], accessEnders: [], findings: [], userWrites: [], passwordWriters: [], dynamicSets: [], recorders: [], passwordRecorders: [], passwordSteps: [], expiryWrites: [] };
	/** Card 2997: a write of `password_hash` at `node`, kept with where it starts. */
	const writesPassword = (node: ts.Node) => {
		reading.passwordWriters.push(keyOf(node));
		reading.passwordSteps.push({ key: keyOf(node), at: node.getStart(tree), step: 'writes' });
	};

	/** The text a string, a template or a `+` chain of them builds, a substitution or other piece read as `\u0000`. */
	const textOf = (node: ts.Expression): string => {
		const inner = bare(node);
		if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
		if (ts.isTemplateExpression(inner)) return inner.head.text + inner.templateSpans.map((span) => `\u0000${span.literal.text}`).join('');
		if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) return textOf(inner.left) + textOf(inner.right);
		return '\u0000';
	};
	const isText = (node: ts.Node): boolean =>
		ts.isStringLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node) ||
		ts.isTemplateExpression(node) ||
		(ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken);
	/** Whether `node` is a piece of a larger `+` chain, which is read whole. */
	const inChain = (node: ts.Node): boolean => {
		let parent = node.parent;
		while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
		return !!parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
	};

	const judgeSql = (node: ts.Node, text: string) => {
		for (const found of text.matchAll(KEY_SQL_DELETE)) {
			reading.deletes.push(keyOf(node));
			if (!(keyOf(node) in KEY_DELETERS)) {
				reading.findings.push(`${file}:${at(node)} ${found[1].replace(/\s+/g, ' ').toUpperCase()} ${found[2]} in ${writerNameOf(node)}, which is not on KEY_DELETERS: a key deleted unrecorded comes back with the next restore (card 2995)`);
			}
		}
		for (const found of text.matchAll(KEY_SQL_DROP)) {
			reading.findings.push(`${file}:${at(node)} ${found[1].replace(/\s+/g, ' ').toUpperCase()} ${found[2]} in ${writerNameOf(node)}: no file may drop or alter the keys or the accounts by name (card 2995)`);
		}
		for (const _found of text.matchAll(KEY_SQL_UPSERT)) {
			reading.findings.push(`${file}:${at(node)} upserts into api_keys with DO UPDATE in ${writerNameOf(node)}: a key is made, or ended, never rewritten (card 2995)`);
		}
		for (const found of text.matchAll(KEY_SQL_UPDATE)) {
			const columns = found[1].split(',').map((part) => part.trim().split(/\s*=/)[0].replace(/["`[\]]/g, '').toLowerCase());
			// Card 3009 (R5): `expires_at` too, in KEY_EXPIRY_WRITERS' functions alone, each counted.
			const expiryWriter = keyOf(node) in KEY_EXPIRY_WRITERS;
			if (columns.includes('expires_at')) reading.expiryWrites.push(keyOf(node));
			const others = columns.filter((column) => !KEY_UPDATE_COLUMNS.includes(column) && !(expiryWriter && column === 'expires_at'));
			if (others.length > 0 || /^UPDATE\s+OR\b/i.test(found[0])) {
				reading.findings.push(`${file}:${at(node)} updates api_keys (${others.join(', ') || 'OR'}) in ${writerNameOf(node)}: only last_used_at and deadline_at may be set (card 2995)`);
			}
		}
		for (const found of text.matchAll(RECORD_SQL_WRITE)) {
			reading.findings.push(`${file}:${at(node)} ${found[1].replace(/\s+/g, ' ').toUpperCase()} api_key_revocations in ${writerNameOf(node)}: the record is append-only (card 2995)`);
		}
		for (const found of text.matchAll(DYNAMIC_CLEAR)) {
			reading.clears.push(keyOf(node));
			if (!(keyOf(node) in KEY_DYNAMIC_CLEARS)) {
				reading.findings.push(`${file}:${at(node)} ${found[1].replace(/\s+/g, ' ').toUpperCase()} a table named at run time in ${writerNameOf(node)}, which is not on KEY_DYNAMIC_CLEARS: it can reach api_keys or users (card 2995)`);
			}
		}
		// Card 2996 (R9 i, ii, vi): an UPDATE users that sets a role, a disable or a password, or sets columns built at run time.
		for (const found of text.matchAll(USERS_SQL_UPDATE)) {
			if (found[1].includes('\u0000')) {
				reading.dynamicSets.push(keyOf(node));
				if (!(keyOf(node) in USERS_DYNAMIC_SETS)) {
					reading.findings.push(`${file}:${at(node)} updates users with columns built at run time in ${writerNameOf(node)}, which is not on USERS_DYNAMIC_SETS (card 2996)`);
				}
				continue;
			}
			const columns = found[1].split(',').map((part) => part.trim().split(/\s*=/)[0].replace(/["`[\]]/g, '').toLowerCase());
			if (!columns.some((column) => USERS_ENDING_COLUMNS.includes(column))) continue;
			reading.userWrites.push(keyOf(node));
			if (columns.includes('password_hash')) writesPassword(node);
			if (!(keyOf(node) in USERS_ENDING_WRITES)) {
				reading.findings.push(`${file}:${at(node)} updates users (${columns.filter((c) => USERS_ENDING_COLUMNS.includes(c)).join(', ')}) in ${writerNameOf(node)}, which is not on USERS_ENDING_WRITES (card 2996)`);
			}
		}
		for (const _found of text.matchAll(USERS_SQL_UPSERT)) {
			reading.findings.push(`${file}:${at(node)} upserts into users with DO UPDATE in ${writerNameOf(node)}: an account is made, changed by its writers, or ended, never rewritten (card 2996)`);
		}
		// Card 2996 (R9 iv): the record of account endings is append-only, written by a plain INSERT in its two writers alone.
		for (const found of text.matchAll(ACCOUNT_RECORD_SQL_WRITE)) {
			reading.findings.push(`${file}:${at(node)} ${found[1].replace(/\s+/g, ' ').toUpperCase()} account_endings in ${writerNameOf(node)}: the record is append-only, written by a plain INSERT (card 2996)`);
		}
		for (const _found of text.matchAll(ACCOUNT_RECORD_SQL_INSERT)) {
			if (!ACCOUNT_RECORD_INSERTERS.includes(keyOf(node))) {
				reading.findings.push(`${file}:${at(node)} INSERT INTO account_endings in ${writerNameOf(node)}: only recordAccountEnding and carryAccountEndings write the record (card 2996)`);
			}
		}
	};

	const visit = (node: ts.Node): void => {
		if (isText(node) && !inChain(node)) {
			const text = textOf(node as ts.Expression);
			judgeSql(node, text);
			// A chain is read whole; its pieces are not read again.
			if (ts.isBinaryExpression(node)) return;
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression.name.text;
			const [first] = node.arguments;
			const table = first !== undefined && ts.isIdentifier(bare(first)) ? (bare(first) as ts.Identifier).text : null;
			if (method === 'delete' && (table === 'apiKeys' || table === 'users')) {
				reading.deletes.push(keyOf(node));
				if (!(keyOf(node) in KEY_DELETERS)) {
					reading.findings.push(`${file}:${at(node)} .delete(${table}) in ${writerNameOf(node)}, which is not on KEY_DELETERS: a key deleted unrecorded comes back with the next restore (card 2995)`);
				}
			}
			// Drizzle's upserts on api_keys (card 2995's code review, FP6): the chain under them read down to its `.insert()`.
			if (method === 'onConflictDoUpdate' || method === 'onConflictDoNothing') {
				let link: ts.Expression = node.expression.expression;
				let inserted: string | null = null;
				while (ts.isCallExpression(link) || ts.isPropertyAccessExpression(link) || ts.isParenthesizedExpression(link) || ts.isNonNullExpression(link)) {
					if (ts.isCallExpression(link) && ts.isPropertyAccessExpression(link.expression) && link.expression.name.text === 'insert') {
						const [into] = link.arguments;
						inserted = into !== undefined && ts.isIdentifier(bare(into)) ? (bare(into) as ts.Identifier).text : null;
						break;
					}
					link = link.expression;
				}
				if (inserted === 'apiKeys' || inserted === 'apiKeyRevocations') {
					reading.findings.push(`${file}:${at(node)} .${method}() on ${inserted} in ${writerNameOf(node)}: a key or its record is inserted plainly, never upserted (card 2995)`);
				}
				// Card 2996 (R9 iii): an account is never upserted over.
				if (method === 'onConflictDoUpdate' && inserted === 'users') {
					reading.findings.push(`${file}:${at(node)} .onConflictDoUpdate() on users in ${writerNameOf(node)}: an account is made, changed by its writers, or ended, never rewritten (card 2996)`);
				}
			}
			if ((method === 'delete' || method === 'update') && table === 'apiKeyRevocations') {
				reading.findings.push(`${file}:${at(node)} .${method}(apiKeyRevocations) in ${writerNameOf(node)}: the record is append-only (card 2995)`);
			}
			// Card 2996 (R9 iv): the record of account endings is written by its two writers' SQL alone, never through Drizzle.
			if ((method === 'delete' || method === 'update' || method === 'insert') && table === 'accountEndings') {
				reading.findings.push(`${file}:${at(node)} .${method}(accountEndings) in ${writerNameOf(node)}: the record is append-only, written by recordAccountEnding (card 2996)`);
			}
			// Card 2996 (R9 i, vi): a Drizzle update of users judged by the fields it sets: a role, a disable or a password,
			// or fields not written out here, is an ending's write and must be listed.
			if (method === 'update' && table === 'users') {
				const set = node.parent;
				const values = ts.isPropertyAccessExpression(set) && set.name.text === 'set' && ts.isCallExpression(set.parent) ? set.parent.arguments[0] : undefined;
				const fields =
					values !== undefined && ts.isObjectLiteralExpression(values)
						? values.properties.map((property) =>
								(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && ts.isIdentifier(property.name) ? property.name.text : null
							)
						: [null];
				if (fields.some((field) => field === null || USERS_ENDING_FIELDS.includes(field))) {
					reading.userWrites.push(keyOf(node));
					if (fields.some((field) => field === null || field === 'passwordHash')) writesPassword(node);
					if (!(keyOf(node) in USERS_ENDING_WRITES)) {
						const named = fields.filter((field) => field === null || USERS_ENDING_FIELDS.includes(field)).map((field) => field ?? 'fields not written out here');
						reading.findings.push(`${file}:${at(node)} .update(users) setting ${named.join(', ')} in ${writerNameOf(node)}, which is not on USERS_ENDING_WRITES (card 2996)`);
					}
				}
			}
			if (method === 'update' && table === 'apiKeys') {
				const set = node.parent;
				const values = ts.isPropertyAccessExpression(set) && set.name.text === 'set' && ts.isCallExpression(set.parent) ? set.parent.arguments[0] : undefined;
				const fields =
					values !== undefined && ts.isObjectLiteralExpression(values)
						? values.properties.map((property) => (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) ? property.name.text : null))
						: [null];
				if (fields.some((field) => field === null || !KEY_UPDATE_FIELDS.includes(field))) {
					reading.findings.push(`${file}:${at(node)} .update(apiKeys) in ${writerNameOf(node)}: only lastUsedAt and deadlineAt may be set (card 2995)`);
				}
			}
		}
		if (ts.isCallExpression(node) && ts.isIdentifier(bare(node.expression)) && (bare(node.expression) as ts.Identifier).text === 'endApiKeys') {
			reading.enders.push(keyOf(node));
			// Card 3013 (d3): a fourth argument is `recordOnly`; so may a spread one be (its code review, FP2).
			if (node.arguments.length > 3 || node.arguments.some((argument) => ts.isSpreadElement(argument))) reading.recordOnly.push(keyOf(node));
		}
		if (ts.isCallExpression(node) && ts.isIdentifier(bare(node.expression)) && (bare(node.expression) as ts.Identifier).text === 'restoredAccessEnder') {
			const second = node.arguments[1];
			reading.accessEnders.push({ key: keyOf(node), recordOnly: second === undefined ? null : second.getText(tree) });
		}
		// Card 2996 (R9 v): each call of the record's one writer, by its `file#function`.
		if (ts.isCallExpression(node) && ts.isIdentifier(bare(node.expression)) && (bare(node.expression) as ts.Identifier).text === 'recordAccountEnding') {
			reading.recorders.push(keyOf(node));
		}
		// Card 2997 (test aa): each call of the password record's writer, by its `file#function` and where it starts.
		if (ts.isCallExpression(node) && ts.isIdentifier(bare(node.expression)) && (bare(node.expression) as ts.Identifier).text === 'recordPasswordReplaced') {
			reading.passwordRecorders.push(keyOf(node));
			reading.passwordSteps.push({ key: keyOf(node), at: node.getStart(tree), step: 'records' });
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return reading;
}

describe('every delete of an API key or an account, and the record of ended keys (card 2995, R12)', () => {
	const walked = [...filesUnder('src', (path) => WEBHOOK_WALKED.test(path)), ...filesUnder('scripts', (path) => WEBHOOK_WALKED.test(path))].map((file) => ({
		file,
		source: readFileSync(join(ROOT, file), 'utf8')
	}));
	const readings = walked.map(({ file, source }) => judgeKeyWrites(file, source));
	const counted = (pick: (reading: KeyReading) => string[]) => {
		const counts: Record<string, number> = {};
		for (const reading of readings) for (const key of pick(reading)) counts[key] = (counts[key] ?? 0) + 1;
		return counts;
	};

	it('test 21: finds no delete or replace of api_keys or users, no wider UPDATE api_keys, and no write of the record but an INSERT OR IGNORE, under src and scripts (g)', () => {
		expect(readings.flatMap(({ findings }) => findings)).toEqual([]);
		expect(walked.length).toBeGreaterThan(300);
		expect(walked.map(({ file }) => file)).toContain('scripts/mfa-reset.mjs');
	});

	it('test 21: holds on KEY_DELETERS and KEY_DYNAMIC_CLEARS exactly what the walk found, each as many times as listed', () => {
		expect(counted((reading) => reading.deletes)).toEqual(Object.fromEntries(Object.entries(KEY_DELETERS).map(([key, { count }]) => [key, count])));
		expect(counted((reading) => reading.clears)).toEqual(Object.fromEntries(Object.entries(KEY_DYNAMIC_CLEARS).map(([key, { count }]) => [key, count])));
	});

	it('card 3009 (R5): an UPDATE api_keys sets expires_at only in KEY_EXPIRY_WRITERS, each as many times as listed', () => {
		expect(counted((reading) => reading.expiryWrites)).toEqual(Object.fromEntries(Object.entries(KEY_EXPIRY_WRITERS).map(([key, { count }]) => [key, count])));
	});

	it('test 21: endApiKeys is called by exactly the enders, each once', () => {
		expect(readings.flatMap(({ enders }) => enders).sort()).toEqual([...END_API_KEYS_CALLERS].sort());
	});

	it('(d3) card 3013 (R8): endApiKeys is given recordOnly by exactly RECORD_ONLY_CALLERS, each once, and every one of them is an ender', () => {
		expect(readings.flatMap(({ recordOnly }) => recordOnly).sort()).toEqual([...RECORD_ONLY_CALLERS].sort());
		for (const caller of RECORD_ONLY_CALLERS) expect(END_API_KEYS_CALLERS).toContain(caller);
		// Its code review (FP2): each of the restore's three enders is made with the restore's own `recordOnly`, and none other.
		expect(readings.flatMap(({ accessEnders }) => accessEnders)).toEqual([
			{ key: 'src/lib/server/db/restore.ts#carryDisabled', recordOnly: 'recordOnly' },
			{ key: 'src/lib/server/db/restore.ts#applyAccountEndings', recordOnly: 'options.recordOnly' },
			{ key: 'src/lib/server/db/restore.ts#applyPasswordRulings', recordOnly: 'options.recordOnly' }
		]);
	});

	it("(d3) card 3013's code review (FP2): a call of endApiKeys whose arguments are spread is read as one that may give recordOnly", () => {
		const spread = judgeKeyWrites('src/lib/server/x.ts', 'export function ender(...args: Parameters<typeof endApiKeys>) { return endApiKeys(...args); }');
		expect(spread.recordOnly).toEqual(['src/lib/server/x.ts#ender']);
		const plain = judgeKeyWrites('src/lib/server/x.ts', "export function ender(live: Db) { return endApiKeys(live, { userId: 1 }, 'revoked'); }");
		expect(plain.recordOnly).toEqual([]);
	});

	it('test 21: the restore keeps the record out of the tables it clears, and Reset Everything names it among those it keeps', () => {
		expect(restorableTables(sqlite)).not.toContain('api_key_revocations');
		expect(restorableTables(sqlite)).toContain('api_keys');
		const reset = readFileSync(join(ROOT, 'src/routes/api/admin/reset/+server.ts'), 'utf8');
		expect(/const KEPT = \[[^\]]*'api_key_revocations'[^\]]*\]/.test(reset)).toBe(true);
	});

	it('test 33 (card 2996, R9 i, ii, vi): every write of a role, a disable, a password or run-time fields of users is on USERS_ENDING_WRITES, each as many times as listed; every run-time SET on USERS_DYNAMIC_SETS; the password writers listed', () => {
		expect(counted((reading) => reading.userWrites)).toEqual(Object.fromEntries(Object.entries(USERS_ENDING_WRITES).map(([key, { count }]) => [key, count])));
		expect(counted((reading) => reading.dynamicSets)).toEqual(Object.fromEntries(Object.entries(USERS_DYNAMIC_SETS).map(([key, { count }]) => [key, count])));
		expect([...new Set(readings.flatMap(({ passwordWriters }) => passwordWriters))].sort()).toEqual([...PASSWORD_HASH_WRITERS].sort());
	});

	it('test 33 (R9 v): recordAccountEnding is called by exactly the writers of an ending, each once', () => {
		expect(readings.flatMap(({ recorders }) => recorders).sort()).toEqual([...RECORD_ACCOUNT_ENDING_CALLERS].sort());
	});

	it('test 34 (R9 iv): the record of account endings is kept out of what a restore clears and named among what Reset keeps; the host script writes no ending of an account', () => {
		expect(restorableTables(sqlite)).not.toContain('account_endings');
		const reset = readFileSync(join(ROOT, 'src/routes/api/admin/reset/+server.ts'), 'utf8');
		expect(/const KEPT = \[[^\]]*'account_endings'[^\]]*\]/.test(reset)).toBe(true);
		// No role, disable, password or delete of an account in the host's scripts.
		expect(readings.flatMap(({ userWrites }) => userWrites).filter((key) => key.startsWith('scripts/'))).toEqual([]);
		expect(readings.flatMap(({ deletes }) => deletes).filter((key) => key.startsWith('scripts/') && !key.endsWith('#reset'))).toEqual([]);
	});

	it('(aa) card 2997: every writer of password_hash is in exactly one of section 5’s classes; recordPasswordReplaced is called by exactly its callers, each once, and every writer that records calls it before its write in the same function; scripts/ writes no password_hash', () => {
		// Every function the walk finds writing password_hash has one class, and every classed function writes it.
		const writers = [...new Set(readings.flatMap(({ passwordWriters }) => passwordWriters))].sort();
		expect(writers).toEqual([...PASSWORD_HASH_WRITERS].sort());
		expect(Object.keys(PASSWORD_HASH_CLASSES).sort()).toEqual([...PASSWORD_HASH_WRITERS].sort());
		for (const [key, { why }] of Object.entries(PASSWORD_HASH_CLASSES)) expect(why, key).not.toBe('');
		// The callers of the password record's writer, each once.
		expect(readings.flatMap(({ passwordRecorders }) => passwordRecorders).sort()).toEqual([...RECORD_PASSWORD_REPLACED_CALLERS].sort());
		// A writer that records calls it in the same function, before every write of password_hash there.
		const steps = readings.flatMap(({ passwordSteps }) => passwordSteps);
		const recording = Object.entries(PASSWORD_HASH_CLASSES).filter(([, { kind }]) => kind === 'records').map(([key]) => key);
		expect(recording.sort()).toEqual([
			'src/lib/server/account-ending-bodies.ts#giveDummyHash',
			'src/routes/api/account/password/+server.ts#PUT',
			'src/routes/api/users/[id]/password/+server.ts#PUT',
			'src/routes/invite/[token]/+page.server.ts#default'
		]);
		for (const key of recording) {
			const records = steps.filter((step) => step.key === key && step.step === 'records').map((step) => step.at);
			const writes = steps.filter((step) => step.key === key && step.step === 'writes').map((step) => step.at);
			expect(records, `${key} calls recordPasswordReplaced`).toHaveLength(1);
			expect(writes.length, `${key} writes password_hash`).toBeGreaterThan(0);
			expect(Math.min(...writes), `${key} records before its write`).toBeGreaterThan(records[0]);
		}
		// The restore's and the start's classes are their own files' (W8, W10, W11).
		for (const [key, { kind }] of Object.entries(PASSWORD_HASH_CLASSES)) {
			if (kind === 'restore') expect(key.startsWith('src/lib/server/db/restore.ts#'), key).toBe(true);
			if (kind === 'start') expect(key, key).toBe('src/lib/server/account-ending-bodies.ts#endReplacedPasswordsPresent');
		}
		// R19: no host script writes a password, or records one; one that ever does must call recordPasswordReplaced first.
		expect(scriptPasswordWrites(readings)).toEqual([]);
		expect(readings.flatMap(({ passwordRecorders }) => passwordRecorders).filter((key) => key.startsWith('scripts/'))).toEqual([]);
	});

	describe('the rule itself', () => {
		const EXAMPLE = 'src/lib/server/example.ts';
		/** `code` as line 4 of a made-up module, in `wipe`. */
		const inWipe = (code: string) =>
			[
				"import { db, sqlite } from '$lib/server/db'; import { eq } from 'drizzle-orm';",
				"import { accountEndings, apiKeys, apiKeyRevocations, users } from '$lib/server/db/schema';",
				'export function wipe(table: string, id: number, fields: object) {',
				`\t${code}`,
				'}'
			].join('\n');
		const findingsOf = (code: string) => judgeKeyWrites(EXAMPLE, inWipe(code)).findings;

		it('(aa) card 2997: an unlisted password write in a made-up function is a finding by file and line, even after recordPasswordReplaced, and that call is collected as one no list holds', () => {
			const code = "recordPasswordReplaced(sqlite, id); db.update(users).set({ passwordHash: 'x' }).where(eq(users.id, id)).run();";
			const reading = judgeKeyWrites(EXAMPLE, inWipe(code));
			expect(reading.findings).toEqual([`${EXAMPLE}:4 .update(users) setting passwordHash in wipe, which is not on USERS_ENDING_WRITES (card 2996)`]);
			expect(reading.passwordWriters).toEqual([`${EXAMPLE}#wipe`]);
			expect(reading.passwordRecorders).toEqual([`${EXAMPLE}#wipe`]);
			expect(RECORD_PASSWORD_REPLACED_CALLERS).not.toContain(`${EXAMPLE}#wipe`);
			expect(PASSWORD_HASH_CLASSES).not.toHaveProperty([`${EXAMPLE}#wipe`]);
		});

		it('(aa2) card 2997 (code review, FP13): a made-up host script writing password_hash in SQL is caught by the scripts/ rule, which the same source under src is not', () => {
			const script = [
				"import Database from 'better-sqlite3';",
				'export function setPassword(path, id, hash) {',
				'\tconst sqlite = new Database(path);',
				"\tsqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);",
				'}'
			].join('\n');
			const reading = judgeKeyWrites('scripts/x.mjs', script);
			expect(reading.passwordWriters).toEqual(['scripts/x.mjs#setPassword']);
			expect(scriptPasswordWrites([reading])).toEqual(['scripts/x.mjs#setPassword']);
			expect(scriptPasswordWrites([judgeKeyWrites(EXAMPLE, script)])).toEqual([]);
		});

		it('(g): a fixture holding DELETE FROM api_key_revocations is a finding by file and line', () => {
			expect(findingsOf("sqlite.prepare('DELETE FROM api_key_revocations WHERE key_id = 1').run();")).toEqual([
				`${EXAMPLE}:4 DELETE FROM api_key_revocations in wipe: the record is append-only (card 2995)`
			]);
		});

		it.each([
			{ form: 'an UPDATE of the record', code: "sqlite.prepare('UPDATE api_key_revocations SET key_hash = ?').run('x');" },
			{ form: 'a REPLACE INTO the record', code: "sqlite.prepare('REPLACE INTO api_key_revocations (key_id, key_hash) VALUES (1, ?)').run('x');" },
			{ form: 'an INSERT OR REPLACE INTO the record', code: "sqlite.prepare(`INSERT OR REPLACE INTO \"api_key_revocations\" (key_id) VALUES (${id})`).run();" },
			{ form: 'a DROP of the record, joined by +', code: "sqlite.exec('DROP TABLE ' + 'api_key_revocations');" },
			{ form: 'a Drizzle delete of the record', code: 'db.delete(apiKeyRevocations).run();' },
			{ form: 'a Drizzle update of the record', code: "db.update(apiKeyRevocations).set({ keyHash: '' }).run();" },
			{ form: 'a delete of api_keys', code: "sqlite.prepare('DELETE FROM api_keys WHERE id = ?').run(id);" },
			{ form: 'a delete of users, across lines', code: 'sqlite.prepare(`DELETE\n\t\tFROM\n\tusers WHERE id = ?`).run(id);' },
			{ form: 'a REPLACE INTO users', code: "sqlite.prepare('REPLACE INTO users (id, username) VALUES (?, ?)').run(id, 'x');" },
			{ form: 'an INSERT OR REPLACE INTO api_keys', code: "sqlite.prepare('INSERT OR REPLACE INTO main.api_keys (id) VALUES (?)').run(id);" },
			{ form: 'a Drizzle delete of api_keys', code: 'db.delete(apiKeys).where(eq(apiKeys.id, id)).run();' },
			{ form: 'a Drizzle delete of users', code: 'db.delete(users).where(eq(users.id, id)).run();' },
			{ form: 'an UPDATE api_keys of its hash', code: "sqlite.prepare('UPDATE api_keys SET key_hash = ? WHERE id = ?').run('x', id);" },
			{ form: 'a Drizzle update of a key’s hash', code: "db.update(apiKeys).set({ keyHash: 'x' }).where(eq(apiKeys.id, id)).run();" },
			{ form: 'a delete from a table named at run time', code: 'sqlite.prepare(`DELETE FROM "${table}"`).run();' },
			// Card 2995's code review (FP6): a drop or an alteration by name, an upsert that updates, Drizzle's upserts.
			{ form: 'a DROP TABLE of api_keys', code: "sqlite.exec('DROP TABLE IF EXISTS api_keys');" },
			{ form: 'a DROP TABLE of users', code: 'sqlite.exec(`DROP TABLE "users"`);' },
			{ form: 'an ALTER TABLE of api_keys', code: "sqlite.exec('ALTER TABLE api_keys RENAME TO old_keys');" },
			{ form: 'an ALTER TABLE of users', code: "sqlite.exec('ALTER TABLE main.users DROP COLUMN role');" },
			{
				form: 'an INSERT … ON CONFLICT … DO UPDATE on api_keys',
				code: "sqlite.prepare('INSERT INTO api_keys (id, key_hash) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET key_hash = excluded.key_hash').run(id, 'x');"
			},
			{ form: 'a Drizzle onConflictDoUpdate on apiKeys', code: "db.insert(apiKeys).values({ id }).onConflictDoUpdate({ target: apiKeys.id, set: { keyHash: 'x' } }).run();" },
			{ form: 'a Drizzle onConflictDoNothing on apiKeys', code: 'db.insert(apiKeys).values({ id }).onConflictDoNothing().run();' },
			// Card 2996 (R9, tests 33 and 34): an account's ending written outside its writers, and the record of account endings.
			{ form: 'an unlisted Drizzle role write', code: "db.update(users).set({ role: 'admin' }).where(eq(users.id, id)).run();" },
			{ form: 'an unlisted Drizzle write of fields built elsewhere', code: 'db.update(users).set(fields).where(eq(users.id, id)).run();' },
			{ form: 'an unlisted SQL disable', code: "sqlite.prepare('UPDATE users SET disabled_at = ?, disabled_by = ? WHERE id = ?').run('x', 1, id);" },
			{ form: 'an unlisted SQL password write', code: "sqlite.prepare('UPDATE main.users SET \"password_hash\" = ? WHERE id = ?').run('x', id);" },
			{ form: 'an unlisted UPDATE users SET built at run time', code: 'sqlite.prepare(`UPDATE users SET ${table} = 0 WHERE id = ?`).run(id);' },
			{ form: 'an upsert into users with DO UPDATE', code: "sqlite.prepare('INSERT INTO users (id, role) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET role = excluded.role').run(id, 'admin');" },
			{ form: 'a Drizzle onConflictDoUpdate on users', code: "db.insert(users).values({ id }).onConflictDoUpdate({ target: users.id, set: { role: 'admin' } }).run();" },
			{ form: 'a DELETE FROM the record of account endings', code: "sqlite.prepare('DELETE FROM account_endings WHERE user_id = ?').run(id);" },
			{ form: 'an UPDATE of the record of account endings', code: "sqlite.prepare('UPDATE account_endings SET origin = ?').run('here');" },
			{ form: 'an INSERT OR IGNORE INTO the record of account endings', code: "sqlite.prepare('INSERT OR IGNORE INTO account_endings (user_id) VALUES (?)').run(id);" },
			{ form: 'a plain INSERT INTO the record outside its writers', code: "sqlite.prepare('INSERT INTO account_endings (user_id) VALUES (?)').run(id);" },
			{ form: 'a Drizzle insert into the record', code: 'db.insert(accountEndings).values({ userId: id }).run();' }
		])('finds $form, on its line, in its function', ({ code }) => {
			const found = findingsOf(code);
			expect(found).toHaveLength(1);
			expect(found[0]).toMatch(/^src\/lib\/server\/example\.ts:4 .* in wipe[:,]/);
		});

		it.each([
			{ form: 'the record’s INSERT OR IGNORE', code: "sqlite.prepare('INSERT OR IGNORE INTO api_key_revocations (key_id, key_hash) VALUES (?, ?)').run(id, 'x');" },
			{ form: 'an update of when a key was last used', code: "sqlite.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run('x', id);" },
			{ form: 'a Drizzle clear of a key’s deadline', code: 'db.update(apiKeys).set({ deadlineAt: null }).where(eq(apiKeys.id, id)).run();' },
			{ form: 'a read of the record', code: "sqlite.prepare('SELECT 1 FROM api_key_revocations WHERE key_hash = ?').get('x');" },
			{ form: 'an update of users', code: "sqlite.prepare('UPDATE users SET email = ? WHERE id = ?').run('x', id);" }
		])('lets $form through', ({ code }) => {
			expect(findingsOf(code)).toEqual([]);
		});
	});
});

// ─── Card 3002: every write of board, team and person access, and the record of access changes ─────────────

/**
 * Card 3002 (section 5, test ee): every write under src and scripts of who may open a board, who is in a team and which
 * account a person is linked to, by `file#function` (`writerNameOf`), with how many such statements and why. Each is a
 * writer that records the change (`recordAccessChange`, W1 to W13), or one of the "record nothing" table's: content
 * deleted, the restore's own steps, which apply the record, and the start's pass, which lowers to it (R15).
 */
const ACCESS_WRITES: Record<string, { count: number; why: string }> = {
	'src/lib/server/boards.ts#createBoard': { count: 2, why: 'W1: the board, with its creator, and its owner row; recorded `board`, `board_public` and `board_member owner` after them.' },
	'src/lib/server/boards.ts#updateBoard': {
		count: 1,
		why: 'W2: `.set({ ...changed })`, only the fields that change; `board_public` where isPublic changed and `product_owner` where productOwnerUserId did.'
	},
	'src/routes/api/boards/[id]/share/+server.ts#POST': {
		count: 4,
		why: 'W3 and W4: a person’s or a team’s role, changed or given; recorded by recordShare where it differs from the role stored or from the record (R12).'
	},
	'src/routes/api/boards/[id]/share/+server.ts#PATCH': {
		count: 1,
		why: 'W5: the visibility, written whatever was sent (N8); recorded where it differs from the board as read or from the record, compared before the write (R12).'
	},
	'src/routes/api/boards/[id]/share/+server.ts#DELETE': { count: 2, why: 'W6: a person’s or a team’s share removed; `none` recorded only where a row went.' },
	'src/routes/api/teams/+server.ts#POST': { count: 1, why: 'W7: the team’s owner; recorded `team tracked` and `team_member owner` after it.' },
	'src/routes/api/teams/[id]/+server.ts#DELETE': { count: 1, why: 'W10: the team deleted, its members and shares with it; `team deleted` recorded just before, while its creation time can be read.' },
	'src/routes/api/teams/[id]/members/[userId]/+server.ts#POST': {
		count: 2,
		why: 'W8: a member added, or its role changed; recorded where it differs from the role stored or from the record (R12).'
	},
	'src/routes/api/teams/[id]/members/[userId]/+server.ts#DELETE': { count: 1, why: 'W9: a member removed; `none` recorded only where a member was there (N3).' },
	'src/lib/server/people.ts#createPerson': { count: 1, why: 'W11: a person, linked or not; `person_link` recorded after it.' },
	'src/lib/server/people.ts#updatePerson': { count: 1, why: 'W12: `.set(updates)`, the fields that change; `person_link` recorded where the link changed.' },
	'src/lib/server/people.ts#addFromAccounts': { count: 1, why: 'W13: a person made from an account; `person_link linked` recorded after it.' },
	'src/lib/server/people.ts#deletePerson': { count: 1, why: 'Records nothing: content; a person restored is capped at its last row.' },
	'src/lib/server/deletes.ts#removeUnder': { count: 1, why: 'Records nothing: a board and its sub-boards deleted, content; a board restored is capped at its last recorded state.' },
	'src/lib/server/deletes.ts#deleteBoard': { count: 1, why: 'Records nothing: content; a board restored is capped at its last recorded state.' },
	'src/lib/server/db/restore.ts#keepAccessHere': {
		count: 10,
		why: "Records nothing: an unsealed restore's same-here accounts given exactly this server's access (plan 3.6); it puts back what the record already says."
	},
	'src/lib/server/db/restore.ts#applyAccessRecord': { count: 10, why: "Records nothing: the restore's application of the record (plan 3.3), which lowers to what it says." },
	'src/lib/server/db/restore.ts#keepPersonLinksHere': { count: 1, why: "Records nothing: an unsealed restore's links put back as this server held them (plan 3.6)." },
	'src/lib/server/startup-checks.ts#capAccessAtStart': {
		count: 10,
		why: "Records nothing: the start's and five-minute pass lowers what is above the record to what it already says (R15)."
	}
};

/** Card 3002 (test ee): the functions that may call `recordAccessChange`, with how many calls: W1 to W13; card 3033's D1 to D8. */
const RECORD_ACCESS_CHANGE_CALLERS: Record<string, number> = {
	'src/lib/server/boards.ts#createBoard': 3,
	'src/lib/server/boards.ts#updateBoard': 2,
	'src/routes/api/boards/[id]/share/+server.ts#recordShare': 1,
	'src/routes/api/boards/[id]/share/+server.ts#PATCH': 1,
	'src/routes/api/boards/[id]/share/+server.ts#DELETE': 1,
	'src/routes/api/teams/+server.ts#POST': 2,
	'src/routes/api/teams/[id]/+server.ts#DELETE': 1,
	'src/routes/api/teams/[id]/members/[userId]/+server.ts#POST': 2,
	'src/routes/api/teams/[id]/members/[userId]/+server.ts#DELETE': 1,
	'src/lib/server/people.ts#createPerson': 1,
	'src/lib/server/people.ts#updatePerson': 1,
	'src/lib/server/people.ts#addFromAccounts': 1,
	// Card 3033 (section 5): D1 and D2, the decision and its decider; D3, a superseding draft's; D4 and D5, every change of
	// a place (draft and open: removed, a role, an account held); D6, a place's account; D7, an account retaken at open; D8.
	'src/lib/server/decision-authoring-writes.ts#createDecision': 2,
	'src/lib/server/decision-authoring-writes.ts#setDecider': 2,
	'src/lib/server/decision-ruling-writes.ts#supersedeDecision': 2,
	'src/lib/server/decision-participant-writes.ts#setParticipants': 10,
	'src/lib/server/decision-participant-writes.ts#setParticipantAccount': 3,
	'src/lib/server/decision-lifecycle-writes.ts#openDecision': 2,
	'src/lib/server/decision-lifecycle-writes.ts#deleteDecision': 1
};

/**
 * Card 3002 (test ff): the only places that may INSERT INTO the record, a plain insert: `accessRecordSql`, the statement
 * `recordAccessChange` alone runs, and `CARRY_ACCESS_CHANGE_SQL`, the union `carryAccessChanges` runs, a constant at
 * restore.ts's top level.
 */
const ACCESS_RECORD_INSERTERS = ['src/lib/server/access-changes.ts#accessRecordSql', 'src/lib/server/db/restore.ts#(top level)'];

/** The tables whose every row is access: a member, a share, a team member. */
const ACCESS_ROW_TABLES = ['board_members', 'team_members', 'board_teams'];
const ACCESS_ROW_SCHEMA = ['boardMembers', 'teamMembers', 'boardTeams'];

/** The access columns of `boards` and `people`, and their Drizzle fields. */
const ACCESS_COLUMNS: Record<string, string[]> = { boards: ['is_public', 'created_by', 'product_owner_user_id'], people: ['user_id'] };
const ACCESS_FIELDS: Record<string, string[]> = { boards: ['isPublic', 'createdBy', 'productOwnerUserId'], people: ['userId'] };

/** Any write of a member, a share or a team member. */
const ACCESS_ROW_SQL_WRITE = new RegExp(
	String.raw`\b(DELETE${SQL_GAP}+FROM|INSERT(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+INTO|REPLACE${SQL_GAP}+INTO|UPDATE(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?)${SQL_GAP}+(${sqlName('(?:board_members|team_members|board_teams)')})`,
	'gi'
);

/** A delete or replace of a team, a board or a person; a board or a person made. */
const ACCESS_SUBJECT_SQL_WRITE = new RegExp(
	String.raw`\b(DELETE${SQL_GAP}+FROM|REPLACE${SQL_GAP}+INTO|INSERT${SQL_GAP}+OR${SQL_GAP}+REPLACE${SQL_GAP}+INTO)${SQL_GAP}+(${sqlName('(?:teams|boards|people)')})|\b(INSERT(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+INTO)${SQL_GAP}+(${sqlName('(?:boards|people)')})`,
	'gi'
);

/** An update of boards or people, with what it sets. */
const ACCESS_SUBJECT_SQL_UPDATE = new RegExp(
	String.raw`\bUPDATE(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+(${sqlName('(?:boards|people)')})${SQL_GAP}+SET\b([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|\bFROM\b|;|$)`,
	'gi'
);

/** Anything written to the record of access changes but a plain INSERT (test ff): a delete, an update, a replace, an insert or ignore, a drop. */
const ACCESS_RECORD_SQL_WRITE = new RegExp(
	String.raw`\b(DELETE${SQL_GAP}+FROM|UPDATE(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?|REPLACE${SQL_GAP}+INTO|INSERT${SQL_GAP}+OR${SQL_GAP}+\w+${SQL_GAP}+INTO|DROP${SQL_GAP}+TABLE(?:${SQL_GAP}+IF${SQL_GAP}+EXISTS)?|ALTER${SQL_GAP}+TABLE)${SQL_GAP}+${sqlName('access_changes')}`,
	'gi'
);

/** A plain INSERT INTO the record. */
const ACCESS_RECORD_SQL_INSERT = new RegExp(String.raw`\bINSERT${SQL_GAP}+INTO${SQL_GAP}+${sqlName('access_changes')}`, 'gi');

/** An upsert into the record that updates: `INSERT … INTO access_changes … ON CONFLICT … DO UPDATE`. */
const ACCESS_RECORD_SQL_UPSERT = new RegExp(
	String.raw`\bINSERT(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+INTO${SQL_GAP}+${sqlName('access_changes')}[^;]*?\bON${SQL_GAP}+CONFLICT\b`,
	'gi'
);

/** What the access inventory found in one file (card 3002). */
type AccessReading = { writes: string[]; recorders: string[]; inserts: string[]; findings: string[] };

/**
 * Card 3002 (tests ee, ff) for one file under src or scripts, read as card 2995's rule reads (`scriptsOf`,
 * `writerNameOf`, `SQL_GAP`, every string built from literals read as SQL, a substitution as `\u0000`). Counted under
 * its `file#function`, and a finding where that is not on ACCESS_WRITES: every write of `board_members`,
 * `team_members` or `board_teams`; every delete or replace of `teams`, `boards` or `people`, and every insert of
 * `boards` or `people`; every update of `boards` or `people` that sets an access column, or columns built at run time.
 * In Drizzle the same: `.insert`, `.update` or `.delete` of `boardMembers`, `teamMembers` or `boardTeams`;
 * `.delete(teams)`; `.delete` or `.insert` of `boards` or `people`; `.update(boards)` or `.update(people)` whose `.set`
 * names an access field, or is not an object literal written out, or spreads one. Any write of `access_changes` but a
 * plain INSERT, or a plain INSERT outside ACCESS_RECORD_INSERTERS, or any Drizzle write of `accessChanges`, is a finding
 * outright. Each call of `recordAccessChange` is listed by its `file#function`. Not seen: a table named at run time
 * (card 2995's KEY_DYNAMIC_CLEARS pins every delete of one), a statement held in a variable built elsewhere.
 */
function judgeAccessWrites(file: string, source: string): AccessReading {
	const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const tree = ts.createSourceFile(file, file.endsWith('.svelte') ? scriptsOf(source) : source, ts.ScriptTarget.Latest, true, kind);
	const at = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const keyOf = (node: ts.Node) => `${file}#${writerNameOf(node)}`;
	const reading: AccessReading = { writes: [], recorders: [], inserts: [], findings: [] };
	const write = (node: ts.Node, what: string) => {
		reading.writes.push(keyOf(node));
		if (!(keyOf(node) in ACCESS_WRITES)) {
			reading.findings.push(`${file}:${at(node)} ${what} in ${writerNameOf(node)}, which is not on ACCESS_WRITES: access changed unrecorded comes back with the next restore (card 3002)`);
		}
	};
	const textOf = (node: ts.Expression): string => {
		const inner = bare(node);
		if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
		if (ts.isTemplateExpression(inner)) return inner.head.text + inner.templateSpans.map((span) => `\u0000${span.literal.text}`).join('');
		if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) return textOf(inner.left) + textOf(inner.right);
		return '\u0000';
	};
	const isText = (node: ts.Node): boolean =>
		ts.isStringLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node) ||
		ts.isTemplateExpression(node) ||
		(ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken);
	const inChain = (node: ts.Node): boolean => {
		let parent = node.parent;
		while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
		return !!parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
	};
	const named = (found: string) => found.replace(/["'`[\]]/g, '').split('.').pop()!.toLowerCase();

	const judgeSql = (node: ts.Node, text: string) => {
		for (const found of text.matchAll(ACCESS_ROW_SQL_WRITE)) write(node, `${found[1].replace(/\s+/g, ' ').toUpperCase()} ${named(found[2])}`);
		for (const found of text.matchAll(ACCESS_SUBJECT_SQL_WRITE)) write(node, `${(found[1] ?? found[3]).replace(/\s+/g, ' ').toUpperCase()} ${named(found[2] ?? found[4])}`);
		for (const found of text.matchAll(ACCESS_SUBJECT_SQL_UPDATE)) {
			const table = named(found[1]);
			const columns = found[2].split(',').map((part) => part.trim().split(/\s*=/)[0].replace(/["`[\]]/g, '').toLowerCase());
			const access = found[2].includes('\u0000') ? ['columns built at run time'] : columns.filter((column) => ACCESS_COLUMNS[table].includes(column));
			if (access.length > 0) write(node, `UPDATE ${table} (${access.join(', ')})`);
		}
		for (const found of text.matchAll(ACCESS_RECORD_SQL_WRITE)) {
			reading.findings.push(`${file}:${at(node)} ${found[1].replace(/\s+/g, ' ').toUpperCase()} access_changes in ${writerNameOf(node)}: the record is append-only, written by a plain INSERT (card 3002)`);
		}
		for (const _found of text.matchAll(ACCESS_RECORD_SQL_UPSERT)) {
			reading.findings.push(`${file}:${at(node)} upserts into access_changes in ${writerNameOf(node)}: the record is append-only, written by a plain INSERT (card 3002)`);
		}
		for (const _found of text.matchAll(ACCESS_RECORD_SQL_INSERT)) {
			reading.inserts.push(keyOf(node));
			if (!ACCESS_RECORD_INSERTERS.includes(keyOf(node))) {
				reading.findings.push(`${file}:${at(node)} INSERT INTO access_changes in ${writerNameOf(node)}: only recordAccessChange and carryAccessChanges write the record (card 3002)`);
			}
		}
	};

	const visit = (node: ts.Node): void => {
		if (isText(node) && !inChain(node)) {
			judgeSql(node, textOf(node as ts.Expression));
			if (ts.isBinaryExpression(node)) return;
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression.name.text;
			const [first] = node.arguments;
			const table = first !== undefined && ts.isIdentifier(bare(first)) ? (bare(first) as ts.Identifier).text : null;
			const writes = method === 'insert' || method === 'update' || method === 'delete';
			if (writes && table !== null && ACCESS_ROW_SCHEMA.includes(table)) write(node, `.${method}(${table})`);
			if (method === 'delete' && (table === 'teams' || table === 'boards' || table === 'people')) write(node, `.delete(${table})`);
			if (method === 'insert' && (table === 'boards' || table === 'people')) write(node, `.insert(${table})`);
			if (method === 'update' && (table === 'boards' || table === 'people')) {
				const set = node.parent;
				const values = ts.isPropertyAccessExpression(set) && set.name.text === 'set' && ts.isCallExpression(set.parent) ? set.parent.arguments[0] : undefined;
				const fields =
					values !== undefined && ts.isObjectLiteralExpression(values)
						? values.properties.map((property) =>
								(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && ts.isIdentifier(property.name) ? property.name.text : null
							)
						: [null];
				const access = fields.filter((field) => field === null || ACCESS_FIELDS[table].includes(field)).map((field) => field ?? 'fields not written out here');
				if (access.length > 0) write(node, `.update(${table}) setting ${access.join(', ')}`);
			}
			if (writes && table === 'accessChanges') {
				reading.findings.push(`${file}:${at(node)} .${method}(accessChanges) in ${writerNameOf(node)}: the record is written by recordAccessChange and carryAccessChanges alone (card 3002)`);
			}
		}
		if (ts.isCallExpression(node) && ts.isIdentifier(bare(node.expression)) && (bare(node.expression) as ts.Identifier).text === 'recordAccessChange') {
			reading.recorders.push(keyOf(node));
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return reading;
}

describe('every write of board, team and person access, and the record of access changes (card 3002, tests ee and ff)', () => {
	const walked = [...filesUnder('src', (path) => WEBHOOK_WALKED.test(path)), ...filesUnder('scripts', (path) => WEBHOOK_WALKED.test(path))].map((file) => ({
		file,
		source: readFileSync(join(ROOT, file), 'utf8')
	}));
	const readings = walked.map(({ file, source }) => judgeAccessWrites(file, source));
	const counted = (pick: (reading: AccessReading) => string[]) => {
		const counts: Record<string, number> = {};
		for (const reading of readings) for (const key of pick(reading)) counts[key] = (counts[key] ?? 0) + 1;
		return counts;
	};

	it('(ee) every write of a member, a share, a team member, a team’s delete, a board’s or a person’s access is on ACCESS_WRITES, each as many times as listed, with its reason', () => {
		expect(readings.flatMap(({ findings }) => findings)).toEqual([]);
		expect(walked.length).toBeGreaterThan(300);
		expect(counted((reading) => reading.writes)).toEqual(Object.fromEntries(Object.entries(ACCESS_WRITES).map(([key, { count }]) => [key, count])));
		for (const [key, { why }] of Object.entries(ACCESS_WRITES)) expect(why, key).not.toBe('');
		// The "record nothing" table: the restore's steps and the start's pass among them (R15).
		for (const key of ['src/lib/server/db/restore.ts#applyAccessRecord', 'src/lib/server/db/restore.ts#keepAccessHere', 'src/lib/server/startup-checks.ts#capAccessAtStart']) {
			expect(ACCESS_WRITES[key]?.why, key).toMatch(/^Records nothing/);
		}
	});

	it('(ee) recordAccessChange is called by exactly the writers W1 to W13, each as many times as listed; no host script records or writes access', () => {
		expect(counted((reading) => reading.recorders)).toEqual(RECORD_ACCESS_CHANGE_CALLERS);
		expect(readings.flatMap(({ writes }) => writes).filter((key) => key.startsWith('scripts/'))).toEqual([]);
	});

	it('(ff) the record is append-only: no DELETE, UPDATE, REPLACE or upsert of it; a plain INSERT only in accessRecordSql and the carry; Reset keeps it; the carry is bounded by MOST_OTHER_ROWS', () => {
		expect(readings.flatMap(({ findings }) => findings).filter((line) => line.includes('access_changes') || line.includes('accessChanges'))).toEqual([]);
		expect([...new Set(readings.flatMap(({ inserts }) => inserts))].sort()).toEqual([...ACCESS_RECORD_INSERTERS].sort());
		expect(restorableTables(sqlite)).not.toContain('access_changes');
		const reset = readFileSync(join(ROOT, 'src/routes/api/admin/reset/+server.ts'), 'utf8');
		expect(/const KEPT = \[[^\]]*'access_changes'[^\]]*\]/.test(reset)).toBe(true);
		// R17 Q6: the carry names the shared bound, argued from it rather than built.
		const restore = readFileSync(join(ROOT, 'src/lib/server/db/restore.ts'), 'utf8');
		const tree = ts.createSourceFile('restore.ts', restore, ts.ScriptTarget.Latest, true);
		const carry = tree.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'carryAccessChanges');
		expect(carry, 'carryAccessChanges').toBeDefined();
		expect(/\bMOST_OTHER_ROWS\b/.test(carry!.getText(tree))).toBe(true);
		// The carry's one statement is the union constant, run in carryAccessChanges alone.
		expect(/\bCARRY_ACCESS_CHANGE_SQL\b/.test(carry!.getText(tree))).toBe(true);
		const uses: ts.Identifier[] = [];
		const find = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && node.text === 'CARRY_ACCESS_CHANGE_SQL') uses.push(node);
			ts.forEachChild(node, find);
		};
		find(tree);
		expect(uses.map((use) => writerNameOf(use))).toEqual(['(top level)', 'carryAccessChanges']);
	});

	describe('the rule itself', () => {
		const EXAMPLE = 'tests/helpers/fixtures.ts';
		/** `code` as line 4 of a made-up fixture, in `seed`. */
		const inSeed = (code: string) =>
			[
				"import { db, sqlite } from '$lib/server/db'; import { eq } from 'drizzle-orm';",
				"import { accessChanges, boardMembers, boards, people, teams } from '$lib/server/db/schema';",
				'export function seed(id: number, fields: object) {',
				`\t${code}`,
				'}'
			].join('\n');
		const findingsOf = (code: string) => judgeAccessWrites(EXAMPLE, inSeed(code)).findings;

		it.each([
			{ form: 'a fixture adding a member in Drizzle', code: "db.insert(boardMembers).values({ boardId: id, userId: 2, role: 'owner' }).run();" },
			{ form: 'a fixture raising a role in SQL', code: "sqlite.prepare(\"UPDATE board_members SET role = 'owner' WHERE user_id = ?\").run(id);" },
			{ form: 'an INSERT OR IGNORE of a share', code: "sqlite.prepare('INSERT OR IGNORE INTO main.\"board_teams\" (board_id, team_id, role) VALUES (?, 1, ?)').run(id, 'editor');" },
			{ form: 'a team member removed across lines', code: 'sqlite.prepare(`DELETE\n\t\tFROM team_members WHERE user_id = ?`).run(id);' },
			{ form: 'a board made public in SQL', code: "sqlite.prepare('UPDATE boards SET name = ?, is_public = 1 WHERE id = ?').run('x', id);" },
			{ form: 'a Drizzle link of a person', code: 'db.update(people).set({ userId: 2 }).where(eq(people.id, id)).run();' },
			{ form: 'a Drizzle update of a board with fields built elsewhere', code: 'db.update(boards).set(fields).where(eq(boards.id, id)).run();' },
			{ form: 'a Drizzle delete of a team', code: 'db.delete(teams).where(eq(teams.id, id)).run();' },
			{ form: 'an UPDATE people SET built at run time', code: 'sqlite.prepare(`UPDATE people SET ${String(fields)} = ? WHERE id = ?`).run(2, id);' },
			{ form: 'a DELETE FROM the record', code: "sqlite.prepare('DELETE FROM access_changes WHERE seq = ?').run(id);" },
			{ form: 'an UPDATE of the record', code: "sqlite.prepare('UPDATE access_changes SET access = ?').run('owner');" },
			{ form: 'a REPLACE INTO the record', code: "sqlite.prepare('REPLACE INTO access_changes (seq) VALUES (?)').run(id);" },
			{ form: 'a plain INSERT INTO the record outside its writers', code: "sqlite.prepare('INSERT INTO access_changes (kind) VALUES (?)').run('board');" },
			{ form: 'a Drizzle insert into the record', code: "db.insert(accessChanges).values({ kind: 'board' }).run();" }
		])('(ee, ff) finds $form, on its line, in its function', ({ code }) => {
			const found = findingsOf(code);
			expect(found).toHaveLength(1);
			expect(found[0]).toMatch(/^tests\/helpers\/fixtures\.ts:4 .* in seed[:,]/);
		});

		it.each([
			{ form: 'a board renamed', code: "sqlite.prepare('UPDATE boards SET name = ? WHERE id = ?').run('x', id);" },
			{ form: 'a Drizzle update of a board’s grouping', code: 'db.update(boards).set({ categoryId: null }).where(eq(boards.id, id)).run();' },
			{ form: 'a person marked left', code: "sqlite.prepare(\"UPDATE people SET status = 'left' WHERE id = ?\").run(id);" },
			{ form: 'a read of the members', code: 'sqlite.prepare("SELECT role FROM board_members WHERE user_id = ?").get(id);' },
			{ form: 'a read of the record', code: "sqlite.prepare('SELECT access FROM access_changes WHERE subject_id = ?').get(id);" }
		])('(ee, ff) lets $form through', ({ code }) => {
			expect(findingsOf(code)).toEqual([]);
		});
	});
});

// ─── Card 3033: every write of a decision role, and the record of access changes ─────────────

/**
 * Card 3033 (section 5, test dd): every write under src and scripts of a decision role, by `file#function`
 * (`writerNameOf`), with how many such statements and why: each row of `decision_participants` (a place, its role,
 * its removal and its account), a decision made or deleted, and a decision's author or decider. Each is a writer that
 * records the change (`recordAccessChange`, D1 to D8), or one of section 5's "record nothing": reach and links, content,
 * the restore's own steps, which apply the record, and the start's pass, which lowers to it.
 */
const DECISION_ROLE_WRITES: Record<string, { count: number; why: string }> = {
	'src/lib/server/decision-authoring-writes.ts#createDecision': { count: 1, why: 'D1: the decision, its author and decider; `decision tracked` and `decision_decider yes` recorded after it (R14: 409 first).' },
	'src/lib/server/decision-authoring-writes.ts#setDecider': {
		count: 1,
		why: 'D2: `.set` spreads the key flag beside deciderUserId; `decision_decider yes` recorded after it, and for the decider it has where the record names another or none (R15).'
	},
	'src/lib/server/decision-authoring-writes.ts#updateDraft': {
		count: 1,
		why: 'Records nothing: `.set` spreads title, closesAt, voteMode and workingContent, content; it names no author or decider.'
	},
	'src/lib/server/decision-ruling-writes.ts#supersedeDecision': { count: 1, why: 'D3: the superseding draft, its author and decider; `decision tracked` and `decision_decider yes` recorded after it (R14: 409 first).' },
	'src/lib/server/decision-participant-writes.ts#setParticipants': {
		count: 8,
		why: 'D4 and D5: a place deleted from a draft (`removed`, recorded before), re-roled, inserted, removed, brought back or added; each recorded with its role, and `held` for the account it comes with. Card 2684 (R18): a draft place a table of the shared list names marked removed rather than deleted, recorded `removed` before, as one deleted.'
	},
	'src/lib/server/decision-participant-writes.ts#setParticipantAccount': { count: 2, why: "D6: a place's account attached (`held`, and `none` for the one it held) or cleared (`none`)." },
	'src/lib/server/decision-participant-writes.ts#changeParticipantAddress': { count: 1, why: "Records nothing: a place's address, reach; an unsealed restore puts it back as this server held it (plan 3.7)." },
	'src/lib/server/decision-lifecycle-writes.ts#openDecision': {
		count: 1,
		why: "D7: the live places' snapshots taken again (R10); where a place's account changed, `none` for the old and `held` for the new."
	},
	'src/lib/server/decision-lifecycle-writes.ts#republishDecision': { count: 1, why: 'Records nothing: `.set` built from what the publish changes, its status and version; it names no author or decider.' },
	'src/lib/server/decision-lifecycle-writes.ts#deleteDecision': { count: 1, why: 'D8: the decision deleted, its places with it; `decision deleted` recorded just before, while its creation time can be read.' },
	'src/lib/server/decision-links.ts#issueLink': { count: 1, why: "Records nothing: a place's link, reach; a restore ends every link." },
	'src/lib/server/decision-links.ts#revokeLinks': { count: 1, why: "Records nothing: a place's link ended, reach." },
	'src/lib/server/decision-links.ts#revokeEveryLink': { count: 1, why: 'Records nothing: every link ended, reach.' },
	'src/lib/server/db/restore.ts#(top level)': {
		count: 2,
		why: "Records nothing: the restore's statements, the links it ends (card 2675) and the draft place it deletes where nothing names it (R10), run by its steps."
	},
	'src/lib/server/db/restore.ts#placeWriter': { count: 2, why: "Records nothing: the restore's removal of a place the record or this server's roles end (plan 3.6, 3.7); its statements prepared once (code review, FP10)." },
	'src/lib/server/db/restore.ts#applyDecisionRecord': { count: 4, why: "Records nothing: the restore's application of the record (plan 3.6), which lowers to what it says." },
	'src/lib/server/db/restore.ts#keepDecisionRolesHere': {
		count: 4,
		why: "Records nothing: an unsealed restore's decisions given exactly this server's roles, or none where not held (plan 3.7); it puts back what the record already says."
	},
	'src/lib/server/startup-checks.ts#capDecisionRolesAtStart': {
		count: 6,
		why: "Records nothing: the start's and five-minute pass lowers a decision role above the record to what it already says (plan 3.11)."
	}
};

/** Any write of a place on a decision, and a decision made, deleted or replaced. */
const DECISION_ROW_SQL_WRITE = new RegExp(
	String.raw`\b(DELETE${SQL_GAP}+FROM|INSERT(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+INTO|REPLACE${SQL_GAP}+INTO|UPDATE(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?)${SQL_GAP}+(${sqlName('decision_participants')})` +
		String.raw`|\b(DELETE${SQL_GAP}+FROM|INSERT(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+INTO|REPLACE${SQL_GAP}+INTO)${SQL_GAP}+(${sqlName('decisions')})`,
	'gi'
);

/** An update of decisions, with what it sets. */
const DECISION_SQL_UPDATE = new RegExp(
	String.raw`\bUPDATE(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+(${sqlName('decisions')})${SQL_GAP}+SET\b([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|\bFROM\b|;|$)`,
	'gi'
);

/** A decision's role columns, and their Drizzle fields. */
const DECISION_ROLE_COLUMNS = ['author_user_id', 'decider_user_id'];
const DECISION_ROLE_FIELDS = ['authorUserId', 'deciderUserId'];

/** What the decision role inventory found in one file (card 3033). */
type DecisionRoleReading = { writes: string[]; findings: string[] };

/**
 * Card 3033 (test dd) for one file under src or scripts, read as card 3002's `judgeAccessWrites` reads (`scriptsOf`,
 * `writerNameOf`, `SQL_GAP`, every string built from literals read as SQL, a substitution as `\u0000`). Counted under
 * its `file#function`, and a finding where that is not on DECISION_ROLE_WRITES: every write of `decision_participants`;
 * every delete, insert or replace of `decisions`; every update of `decisions` that sets `author_user_id` or
 * `decider_user_id`, or columns built at run time. In Drizzle the same: `.insert`, `.update` or `.delete` of
 * `decisionParticipants`; `.insert` or `.delete` of `decisions`; `.update(decisions)` whose `.set` names `authorUserId`
 * or `deciderUserId`, or is not an object literal written out, or spreads one. Not seen: a table named at run time (the
 * restore's copy, which card 3013's rule pins), a statement held in a variable built elsewhere.
 */
function judgeDecisionRoleWrites(file: string, source: string): DecisionRoleReading {
	const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const tree = ts.createSourceFile(file, file.endsWith('.svelte') ? scriptsOf(source) : source, ts.ScriptTarget.Latest, true, kind);
	const at = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const keyOf = (node: ts.Node) => `${file}#${writerNameOf(node)}`;
	const reading: DecisionRoleReading = { writes: [], findings: [] };
	const write = (node: ts.Node, what: string) => {
		reading.writes.push(keyOf(node));
		if (!(keyOf(node) in DECISION_ROLE_WRITES)) {
			reading.findings.push(`${file}:${at(node)} ${what} in ${writerNameOf(node)}, which is not on DECISION_ROLE_WRITES: a decision role changed unrecorded comes back with the next restore (card 3033)`);
		}
	};
	const textOf = (node: ts.Expression): string => {
		const inner = bare(node);
		if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
		if (ts.isTemplateExpression(inner)) return inner.head.text + inner.templateSpans.map((span) => `\u0000${span.literal.text}`).join('');
		if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) return textOf(inner.left) + textOf(inner.right);
		return '\u0000';
	};
	const isText = (node: ts.Node): boolean =>
		ts.isStringLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node) ||
		ts.isTemplateExpression(node) ||
		(ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken);
	const inChain = (node: ts.Node): boolean => {
		let parent = node.parent;
		while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
		return !!parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
	};
	const named = (found: string) => found.replace(/["'`[\]]/g, '').split('.').pop()!.toLowerCase();

	const judgeSql = (node: ts.Node, text: string) => {
		for (const found of text.matchAll(DECISION_ROW_SQL_WRITE)) write(node, `${(found[1] ?? found[3]).replace(/\s+/g, ' ').toUpperCase()} ${named(found[2] ?? found[4])}`);
		for (const found of text.matchAll(DECISION_SQL_UPDATE)) {
			const columns = found[2].split(',').map((part) => part.trim().split(/\s*=/)[0].replace(/["`[\]]/g, '').toLowerCase());
			const roles = found[2].includes('\u0000') ? ['columns built at run time'] : columns.filter((column) => DECISION_ROLE_COLUMNS.includes(column));
			if (roles.length > 0) write(node, `UPDATE decisions (${roles.join(', ')})`);
		}
	};

	const visit = (node: ts.Node): void => {
		if (isText(node) && !inChain(node)) {
			judgeSql(node, textOf(node as ts.Expression));
			if (ts.isBinaryExpression(node)) return;
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression.name.text;
			const [first] = node.arguments;
			const table = first !== undefined && ts.isIdentifier(bare(first)) ? (bare(first) as ts.Identifier).text : null;
			const writes = method === 'insert' || method === 'update' || method === 'delete';
			if (writes && table === 'decisionParticipants') write(node, `.${method}(${table})`);
			if ((method === 'insert' || method === 'delete') && table === 'decisions') write(node, `.${method}(${table})`);
			if (method === 'update' && table === 'decisions') {
				const set = node.parent;
				const values = ts.isPropertyAccessExpression(set) && set.name.text === 'set' && ts.isCallExpression(set.parent) ? set.parent.arguments[0] : undefined;
				const fields =
					values !== undefined && ts.isObjectLiteralExpression(values)
						? values.properties.map((property) =>
								(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && ts.isIdentifier(property.name) ? property.name.text : null
							)
						: [null];
				const roles = fields.filter((field) => field === null || DECISION_ROLE_FIELDS.includes(field)).map((field) => field ?? 'fields not written out here');
				if (roles.length > 0) write(node, `.update(decisions) setting ${roles.join(', ')}`);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return reading;
}

describe('every write of a decision role, and the record of access changes (card 3033, test dd)', () => {
	const walked = [...filesUnder('src', (path) => WEBHOOK_WALKED.test(path)), ...filesUnder('scripts', (path) => WEBHOOK_WALKED.test(path))].map((file) => ({
		file,
		source: readFileSync(join(ROOT, file), 'utf8')
	}));

	it('(dd) every write of a place, a decision made or deleted, and a decision’s author or decider is on DECISION_ROLE_WRITES, each as many times as listed, with its reason; the rule finds each form', () => {
		const readings = walked.map(({ file, source }) => judgeDecisionRoleWrites(file, source));
		expect(readings.flatMap(({ findings }) => findings)).toEqual([]);
		expect(walked.length).toBeGreaterThan(300);
		const counts: Record<string, number> = {};
		for (const reading of readings) for (const key of reading.writes) counts[key] = (counts[key] ?? 0) + 1;
		expect(counts).toEqual(Object.fromEntries(Object.entries(DECISION_ROLE_WRITES).map(([key, { count }]) => [key, count])));
		for (const [key, { why }] of Object.entries(DECISION_ROLE_WRITES)) expect(why, key).not.toBe('');
		// Every writer section 5 names records; the restore's steps and the start's pass record nothing (they apply the record).
		for (const key of Object.keys(DECISION_ROLE_WRITES)) {
			const recorder = key in RECORD_ACCESS_CHANGE_CALLERS;
			expect(recorder || /^Records nothing/.test(DECISION_ROLE_WRITES[key].why), key).toBe(true);
		}
		for (const key of ['src/lib/server/db/restore.ts#applyDecisionRecord', 'src/lib/server/db/restore.ts#keepDecisionRolesHere', 'src/lib/server/startup-checks.ts#capDecisionRolesAtStart']) {
			expect(DECISION_ROLE_WRITES[key]?.why, key).toMatch(/^Records nothing/);
		}

		// The rule itself, on a made-up fixture: each form found on its line, in its function; a content write let through.
		const inSeed = (code: string) =>
			[
				"import { db, sqlite } from '$lib/server/db'; import { eq } from 'drizzle-orm';",
				"import { decisionParticipants, decisions } from '$lib/server/db/schema';",
				'export function seed(id: number, fields: object) {',
				`\t${code}`,
				'}'
			].join('\n');
		const findingsOf = (code: string) => judgeDecisionRoleWrites('tests/helpers/fixtures.ts', inSeed(code)).findings;
		for (const code of [
			"sqlite.prepare(\"UPDATE decision_participants SET role = 'consulted' WHERE id = ?\").run(id);",
			'db.update(decisionParticipants).set({ removedAt: null }).where(eq(decisionParticipants.id, id)).run();',
			'sqlite.prepare(`UPDATE decisions\n\t\tSET decider_user_id = ? WHERE id = ?`).run(2, id);',
			'db.update(decisions).set(fields).where(eq(decisions.id, id)).run();',
			'db.update(decisions).set({ authorUserId: 2 }).where(eq(decisions.id, id)).run();',
			'db.delete(decisions).where(eq(decisions.id, id)).run();',
			"sqlite.prepare('INSERT INTO main.\"decisions\" (title) VALUES (?)').run('x');"
		]) {
			const found = findingsOf(code);
			expect(found, code).toHaveLength(1);
			expect(found[0], code).toMatch(/^tests\/helpers\/fixtures\.ts:4 .* in seed,/);
		}
		for (const code of [
			"sqlite.prepare('UPDATE decisions SET title = ? WHERE id = ?').run('x', id);",
			'db.update(decisions).set({ workingContent: null }).where(eq(decisions.id, id)).run();',
			'sqlite.prepare("SELECT role FROM decision_participants WHERE id = ?").get(id);'
		]) {
			expect(findingsOf(code), code).toEqual([]);
		}
	});
});

describe('one service per action, written only inside writeAs (card 2012)', () => {
	const helpers = SERVICE_HELPERS.map((file) => ({ file, source: readFileSync(join(ROOT, file), 'utf8') }));
	// Card 2713 (C2): the exported writers of every module under src, read from their source, with RECORD_WRITERS added.
	const sourcesUnderSrc = filesUnder('src', (path) => path.endsWith('.ts')).map((file) => ({ file, source: readFileSync(join(ROOT, file), 'utf8') }));
	const derivedWriters = writersOf(sourcesUnderSrc);
	// C4: and every function of any module that reaches one of the listed writers or inTransaction.
	const writers = reachingWriters(sourcesUnderSrc, derivedWriters, RECORD_WRITERS);
	const services = new Map(SERVICES.map((file) => [file, judgeService(file, readFileSync(join(ROOT, file), 'utf8'), helpers, writers)] as const));
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
		expect(services.get('src/lib/server/cards.ts')?.writes).toEqual(['createCard', 'updateCard', 'removeCard', 'moveCard', 'sendCard', 'moveCards', 'restoreCardFor']);
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
			'src/lib/server/boards.ts': { reads: ['listBoardsFor'], writes: ['createBoard', 'updateBoard', 'convertBoardFor', 'deleteBoardFor'] },
			'src/lib/server/board-groupings.ts': { reads: [], writes: ['createBoardGrouping', 'updateBoardGrouping', 'deleteBoardGrouping'] },
			// Card 2701: a column's delete's refusals, read before its password is asked for.
			'src/lib/server/columns.ts': { reads: ['columnDeleteGuard'], writes: ['createColumn', 'updateColumn', 'deleteColumnFor', 'reorderColumns'] },
			'src/lib/server/card-categories.ts': { reads: [], writes: ['createCardCategory', 'updateCardCategory', 'deleteCardCategory'] },
			'src/lib/server/labels.ts': { reads: ['labelsOfBoard'], writes: ['createLabel', 'updateLabel', 'deleteLabel'] },
			// Card 2337.
			'src/lib/server/card-attachments.ts': { reads: ['listAttachments'], writes: ['attachFile', 'attachImage', 'deleteAttachment'] },
			// Card 2674.
			'src/lib/server/people.ts': {
				// Card 2697 (Q21): a person's change's refusals, read before its password is asked for; and (the code
				// review's part B, S1) the add's, the delete's and Add from accounts'. Card 2681: the directory and its groups
				// as an administrator's API key reads them.
				reads: ['personUpdateGuard', 'personCreateGuard', 'personDeleteGuard', 'fromAccountsGuard', 'listPeople', 'listPeopleGroups'],
				writes: ['createPerson', 'updatePerson', 'deletePerson', 'addFromAccounts', 'createGroup', 'updateGroup', 'deleteGroup', 'setGroupMembers']
			},
			// Card 2713, slice 1: drafting, moved out of the former decision service (card 2675), in source order (plan 4.1).
			'src/lib/server/decision-authoring-writes.ts': {
				reads: [],
				writes: [
					'createDecision',
					'setDecider',
					// Card 2676: the working copy saved, and agent-drafted text marked reviewed.
					'updateDraft',
					'markReviewed',
					// Card 2697: a dry run of the working copy, mailed to the caller alone.
					'dryRunDecision'
				]
			},
			// Card 2713, slice 2: the lifecycle and the guards of the withdrawal and the delete (card 2697, Q10, Q29), read before
			// the password.
			'src/lib/server/decision-lifecycle-writes.ts': {
				reads: ['decisionWithdrawGuard', 'decisionDeleteGuard'],
				writes: ['openDecision', 'republishDecision', 'closeDecision', 'extendDecision', 'withdrawDecision', 'deleteDecision']
			},
			// Card 2713, slice 3: the participants and the guards of the administrator's two participant writes (card 2697, Q10),
			// read before the password.
			'src/lib/server/decision-participant-writes.ts': {
				reads: ['participantAccountGuard', 'participantAddressGuard'],
				writes: ['setParticipants', 'resendInvitation', 'setParticipantAccount', 'changeParticipantAddress']
			},
			// Card 2713, slice 3: card 2680's card linked to a decision, and unlinked from it.
			'src/lib/server/decision-card-link-writes.ts': { reads: [], writes: ['linkCard', 'unlinkCard'] },
			// Card 2713, slice 4: card 2677's participant's response and being recorded as having seen, signed in or by a personal
			// link.
			'src/lib/server/decision-response-writes.ts': { reads: [], writes: ['respondToDecision', 'respondByLink', 'recordSeen', 'recordSeenByLink'] },
			// Card 2713, slice 4: card 2679's ruling and release, whose guards (decision 2) their routes ask before the password; a
			// draft superseding a ruled decision; and (decision 4) a participant's concern about the ruling, signed in or by a
			// personal link.
			'src/lib/server/decision-ruling-writes.ts': {
				reads: ['decisionRuleGuard', 'resultsReleaseGuard'],
				writes: ['ruleDecision', 'releaseResults', 'supersedeDecision', 'raiseConcern', 'raiseConcernByLink']
			},
			// Card 2713, slice 5: the last of the former decision service.
			'src/lib/server/decision-question-writes.ts': {
				reads: [],
				writes: [
					// Card 2678: a participant's question, signed in, through an API key or by a personal link; its answer, an agent's
					// draft through a key; and a person publishing that draft.
					'askQuestion',
					'askQuestionByLink',
					'answerQuestion',
					'publishAnswer'
				]
			},
			// Card 2684 (R3, R7): a participant's objection or request to talk, signed in or by a personal link; the decider's reply.
			'src/lib/server/decision-flag-writes.ts': { reads: [], writes: ['raiseFlag', 'raiseFlagByLink', 'replyToFlag'] },
			// Card 2688 (R5, R6): a full record taken as a PDF, noted on the decision's record.
			'src/lib/server/decision-export-writes.ts': { reads: [], writes: ['recordExport'] }
		});
		// Card 2713 (D6 row 2): however they are split, the decision services hold the 30 writes and 6 guards between them.
		// Card 2684 adds a service of two writes, and its slice S2 a third, the reply: 33. Card 2688 adds the export's: 34.
		const decisionServices = [...services].filter(([file]) => DECISION_SERVICE.test(file));
		expect(decisionServices.flatMap(([, { writes }]) => writes)).toHaveLength(34);
		expect(decisionServices.flatMap(([, { reads }]) => reads)).toHaveLength(6);
		// The page routes' options a new card's nested writes share with them (the card 2296 review).
		expect(Object.fromEntries([...services].filter(([, { pageOptions }]) => pageOptions.length > 0).map(([file, { pageOptions }]) => [file, pageOptions]))).toEqual({
			'src/lib/server/card-assignees.ts': ['ASSIGN_PAGE_OPTIONS'],
			'src/lib/server/card-labels.ts': ['TOGGLE_LABEL_PAGE_OPTIONS'],
			'src/lib/server/subtasks.ts': ['CREATE_SUBTASK_PAGE_OPTIONS'],
			'src/lib/server/boards.ts': ['CREATE_BOARD_PAGE_OPTIONS']
		});
	});

	it('names on SERVICES every module under src/lib/server that imports inWrite or exports a function handed the caller, and nothing else; nothing re-exports a service or imports one with import() (4)', () => {
		const files = filesUnder('src', (path) => path.endsWith('.ts')).map((file) => ({ file, source: readFileSync(join(ROOT, file), 'utf8') }));

		expect(judgeServiceModules(files, SERVICES, NOT_SERVICES)).toEqual([]);
		// Read: the modules of src/lib/server, the routes, and the one that writes.
		expect(files.filter(({ file }) => file.startsWith('src/lib/server/')).length).toBeGreaterThanOrEqual(60);
		expect(files.some(({ file }) => file === 'src/lib/server/cards.ts')).toBe(true);
	});

	it('keeps each module on SERVICE_HELPERS private to the decision services: imported by name by them alone, importing none, writing nothing (card 2713, D2, D6 row 5)', () => {
		const files = filesUnder('src', (path) => /\.(ts|js|svelte)$/.test(path)).map((file) => ({ file, source: readFileSync(join(ROOT, file), 'utf8') }));

		expect(judgeServiceHelpers(files, SERVICES, SERVICE_HELPERS, writers, NOT_SERVICES)).toEqual([]);
		// Read: every file under src, and the helper among them, imported by exactly the decision services on SERVICES.
		expect(files.length).toBeGreaterThan(300);
		const decisionServices = SERVICES.filter((file) => DECISION_SERVICE.test(file));
		expect([...decisionServices].sort()).toEqual([
			'src/lib/server/decision-authoring-writes.ts',
			'src/lib/server/decision-card-link-writes.ts',
			'src/lib/server/decision-export-writes.ts',
			'src/lib/server/decision-flag-writes.ts',
			'src/lib/server/decision-lifecycle-writes.ts',
			'src/lib/server/decision-participant-writes.ts',
			'src/lib/server/decision-question-writes.ts',
			'src/lib/server/decision-response-writes.ts',
			'src/lib/server/decision-ruling-writes.ts'
		]);
		for (const helper of SERVICE_HELPERS) {
			const importers = files.filter(({ file, source }) => {
				if (file.endsWith('.svelte')) return false;
				const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
				return tree.statements.some((s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && moduleFileOf(file, s.moduleSpecifier.text) === helper);
			});
			expect(importers.map(({ file }) => file).sort()).toEqual([...decisionServices].sort());
		}
	});

	it('names on RECORD_WRITERS each writer of the record, the activity log, the links and the mail queue, each still exported and read as a write (card 2713, C2)', () => {
		expect(judgeWriterList(sourcesUnderSrc, derivedWriters, RECORD_WRITERS)).toEqual([]);
		// Read: every module under src, and each listed module's writers found in its source, not only added from the list.
		expect(sourcesUnderSrc.length).toBeGreaterThan(200);
		for (const [file, names] of Object.entries(RECORD_WRITERS)) expect([...(derivedWriters.get(file) ?? [])].sort()).toEqual([...names].sort());
		// What the rule counts is the listed modules' writers, each a write in it, and (C4) what reaches one of them or a
		// transaction from anywhere else.
		for (const [file, names] of Object.entries(RECORD_WRITERS)) for (const name of names) expect(writers.get(file)?.has(name)).toBe(true);
		expect(writers.get(TRANSACTION_MODULE)?.has('inTransaction')).toBe(true);
		expect(writers.get('src/lib/server/decision-reminders.ts')?.has('runDecisionRemindersOnce')).toBe(true);
		expect(writers.get('src/lib/server/write-as.ts')?.has('stillCallerNow')).toBe(true);
		// A raw database call outside the listed modules is none: a SELECT prepared. (The signing key made once was the
		// other example, `formSecret` through `issueFormToken`, until card 2750 moved its one write to
		// `writeFormSecret`, at start-up and inside a reset's and a restore's transaction.)
		for (const [file, name] of [['src/lib/server/tokens.ts', 'getCardTokenTotals']]) {
			expect(derivedWriters.get(file)?.has(name)).toBe(true);
			expect(writers.get(file)?.has(name) ?? false).toBe(false);
		}
		// Card 2750: the functions that sign or verify with that key only read it. `issueFormToken` made it at first
		// use, and so did every read guard that reaches `purposeKey` (`revisionOf`, `decisionRuleGuard`,
		// `resultsReleaseGuard`, `requireRevision`).
		for (const name of ['issueFormToken', 'verifyFormToken', 'purposeKey']) {
			expect(derivedWriters.get('src/lib/server/request-tokens.ts')?.has(name) ?? false, name).toBe(false);
		}
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
			'src/routes/api/cards/[id]/send/+server.ts',
			'src/routes/api/cards/reorder/+server.ts',
			'src/routes/api/v1/boards/[boardId]/cards/+server.ts',
			'src/routes/api/v1/cards/[cardId]/+server.ts',
			'src/routes/api/v1/cards/[cardId]/move/+server.ts',
			'src/routes/api/v1/cards/[cardId]/send/+server.ts'
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
			'src/routes/api/boards/[id]/convert/+server.ts',
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
			'src/routes/api/v1/boards/[boardId]/convert/+server.ts',
			'src/routes/api/v1/boards/[boardId]/labels/+server.ts',
			'src/routes/api/v1/categories/[categoryId]/+server.ts',
			'src/routes/api/v1/columns/[columnId]/+server.ts',
			'src/routes/api/v1/labels/[labelId]/+server.ts'
		]);
	});

	it("hands every service write under src/routes/api/v1 a source written out as 'api', and the rule finds one that is not (card 2681, S1)", () => {
		const v1 = routes.filter((file) => file.startsWith('src/routes/api/v1/'));
		const read = v1.map((file) => judgeV1Sources(file, readFileSync(join(ROOT, file), 'utf8'), services));

		expect(read.flatMap(({ findings }) => findings)).toEqual([]);
		// 44 calls of a service write before card 2681 (the 45th `source:` of the plan's count is a logActivity
		// entry, no service's), its four writes, and card 2682's eight of slice 2a and four of slice 2b.
		expect(read.reduce((sum, { calls }) => sum + calls, 0)).toBeGreaterThanOrEqual(60);
		expect(v1.length).toBeGreaterThan(40);

		// Against made-up source: 'ui', a variable, a spread, none, no options at all, and the one written out.
		const SERVICE = new Map([['src/lib/server/things.ts', { reads: ['listThings'], writes: ['makeThing'] }]]);
		const code = [
			"import { listThings, makeThing } from '$lib/server/things';",
			"import { makeThing as made } from '$lib/server/things';",
			'export const POST = async ({ locals }) => {',
			"\tmakeThing(caller, {}, body, { source: 'ui' });",
			'\tmakeThing(caller, {}, body, { source: SOURCE });',
			"\tmakeThing(caller, {}, body, { ...OPTIONS, source: 'api' });",
			"\tmakeThing(caller, {}, body, { says: 'No' });",
			'\tmade(caller, {}, body);',
			'\tmakeThing(caller, {}, body, { source });',
			"\tmakeThing(caller, {}, body, { source: 'api', says: 'No' });",
			"\tlistThings(locals.user, {}, { source: 'ui' });",
			// The code review's S2: a write imported by a relative path, and by `.js`, is seen all the same.
			"\trelative(caller, {}, body, { source: 'ui' });",
			"\twithJs(caller, {}, body, { source: 'ui' });",
			'};',
			"import { makeThing as relative } from '../../../../lib/server/things';",
			"import { makeThing as withJs } from '$lib/server/things.js';"
		].join('\n');
		const EXAMPLE = 'src/routes/api/v1/example/+server.ts';
		expect(judgeV1Sources(EXAMPLE, code, SERVICE)).toEqual({
			findings: [
				"src/routes/api/v1/example/+server.ts:4 makeThing is handed source source: 'ui', not 'api'",
				"src/routes/api/v1/example/+server.ts:5 makeThing is handed source source: SOURCE, not 'api'",
				"src/routes/api/v1/example/+server.ts:6 makeThing is handed options with a spread: write source out",
				'src/routes/api/v1/example/+server.ts:7 makeThing is handed no source',
				'src/routes/api/v1/example/+server.ts:8 made is not handed its options as an object written out at the call',
				"src/routes/api/v1/example/+server.ts:9 makeThing is handed source source, not 'api'",
				"src/routes/api/v1/example/+server.ts:12 relative is handed source source: 'ui', not 'api'",
				"src/routes/api/v1/example/+server.ts:13 withJs is handed source source: 'ui', not 'api'"
			],
			calls: 9
		});
	});

	it("hands every read under src/routes/api/v1 that takes a source the literal 'api', names each such read on V1_READS, and the rule finds one that is not (card 2682, D7)", () => {
		const v1 = routes.filter((file) => file.startsWith('src/routes/api/v1/'));
		const trees = new Map<string, ts.SourceFile>();
		const signatureOf = (module: string, name: string) => {
			let tree = trees.get(module);
			if (tree === undefined) {
				let text = '';
				try {
					text = readFileSync(join(ROOT, module), 'utf8');
				} catch {
					// A module that is not there takes nothing.
				}
				tree = ts.createSourceFile(module, text, ts.ScriptTarget.Latest, true);
				trees.set(module, tree);
			}
			return takesASource(tree, name);
		};
		const read = v1.map((file) => judgeV1Reads(file, readFileSync(join(ROOT, file), 'utf8'), services, signatureOf));

		expect(read.flatMap(({ findings }) => findings)).toEqual([]);
		// Slice 2a: the register and the editors' read, and the register's mode; slice 2b: the questions, the summary and the record.
		expect(read.reduce((sum, { reads }) => sum + reads, 0)).toBeGreaterThanOrEqual(5);
		expect(read.reduce((sum, { modes }) => sum + modes, 0)).toBeGreaterThanOrEqual(1);
		// Each mapped read, by its module and name (code review F7), takes a source, so its options are where V1_READS says.
		expect(Object.keys(V1_READS).sort()).toEqual(
			[
				'src/lib/server/decision-authoring.ts#readDecisionForKey',
				'src/lib/server/decision-questions.ts#readQuestions',
				'src/lib/server/decision-register.ts#readRecord',
				'src/lib/server/decision-register.ts#readRegister',
				'src/lib/server/decision-results.ts#readSummary'
			].sort()
		);
		for (const key of Object.keys(V1_READS)) {
			const [module, name] = key.split('#');
			expect(signatureOf(module, name), key).toBe(true);
		}
		// Each function passed as taking a source that is not the tree still takes one, and is still imported under v1.
		expect(Object.keys(V1_SOURCE_NOT_THE_TREE)).toEqual(['src/lib/server/audit-log.ts#queryAuditLog']);
		expect(signatureOf('src/lib/server/audit-log.ts', 'queryAuditLog')).toBe(true);
		expect(v1.some((file) => readFileSync(join(ROOT, file), 'utf8').includes('queryAuditLog('))).toBe(true);
		// Code review S3: a person's record takes a required source, so the completeness rule holds any v1 import of it to a
		// finding; it is on no map, as it refuses every source but the page's.
		expect(signatureOf('src/lib/server/decision-register.ts', 'readPersonRecord')).toBe(true);
		for (const map of [V1_READS, V1_MODES, V1_SOURCE_NOT_THE_TREE]) expect(Object.hasOwn(map, 'src/lib/server/decision-register.ts#readPersonRecord')).toBe(false);

		// Against made-up source: the options at index 2 and at 3 handed 'ui', a spread, a variable, a mode 'page', a read
		// used but not called, an unmapped import that takes { source }, and the ones written out.
		const SERVICE = new Map([['src/lib/server/things.ts', { reads: [], writes: ['makeThing'] }]]);
		const module = [
			'export function makeThing(caller, at, body, opts: ServiceOptions) {}',
			"export function peekThing(user, id: number, opts: { source: 'ui' | 'api' }) {}",
			'type Opts = { limit: number } & { source: string };',
			'export const countThings = (user, opts: Opts) => 0;',
			'export function plainThing(user, opts: { says?: string }) {}',
			"export function readRecord(user, id: number, query, opts: { source: 'ui' | 'api' }) {}"
		].join('\n');
		const moduleTree = ts.createSourceFile('src/lib/server/things.ts', module, ts.ScriptTarget.Latest, true);
		const signatures = (_file: string, name: string) => takesASource(moduleTree, name);
		// Also a read named as a mapped one from another module (F7: not passed by the name alone), and a person's record (S3).
		const code = [
			"import { makeThing, peekThing, countThings, plainThing, readRecord as thingRecord } from '$lib/server/things';",
			"import { readRegister, readRecord, registerQueryOf, readPersonRecord } from '$lib/server/decision-register';",
			'export const GET = async ({ locals, url }) => {',
			"\treadRegister(locals.user, registerQueryOf(url.searchParams, 'page'), { source: 'ui' });",
			"\treadRecord(locals.user, 1, {}, { source: 'ui', limit: 1 });",
			"\treadRecord(locals.user, 1, {}, { ...OPTIONS, source: 'api' });",
			'\treadRegister(locals.user, query, OPTIONS);',
			'\tconst later = readRecord;',
			"\treadRegister(locals.user, registerQueryOf(url.searchParams, 'api'), { source: 'api' });",
			'};'
		].join('\n');
		const EXAMPLE = 'src/routes/api/v1/example/+server.ts';
		expect(judgeV1Reads(EXAMPLE, code, SERVICE, (file, name) => (file === 'src/lib/server/things.ts' ? signatures(file, name) : signatureOf(file, name)))).toEqual({
			findings: [
				'src/routes/api/v1/example/+server.ts imports peekThing from src/lib/server/things.ts, which takes a source: name it on V1_READS',
				'src/routes/api/v1/example/+server.ts imports countThings from src/lib/server/things.ts, which takes a source: name it on V1_READS',
				'src/routes/api/v1/example/+server.ts imports thingRecord from src/lib/server/things.ts, which takes a source: name it on V1_READS',
				'src/routes/api/v1/example/+server.ts imports readPersonRecord from src/lib/server/decision-register.ts, which takes a source: name it on V1_READS',
				"src/routes/api/v1/example/+server.ts:4 readRegister is handed source source: 'ui', not 'api'",
				"src/routes/api/v1/example/+server.ts:4 registerQueryOf is handed the mode 'page', not 'api'",
				"src/routes/api/v1/example/+server.ts:5 readRecord is handed source source: 'ui', not 'api'",
				'src/routes/api/v1/example/+server.ts:6 readRecord is handed options with a spread: write source out',
				'src/routes/api/v1/example/+server.ts:7 readRegister is not handed its options as an object written out at the call',
				'src/routes/api/v1/example/+server.ts:8 readRecord is used other than by calling it'
			],
			reads: 5,
			modes: 2
		});
	});

	it('imports src/lib/server in every route file only as $lib/server/<path>, and the rule finds a relative path, a .js, a .ts and a .. (card 2681, the code review S2)', () => {
		expect(routes.flatMap((file) => judgeServerImportForms(file, readFileSync(join(ROOT, file), 'utf8')))).toEqual([]);

		const EXAMPLE = 'src/routes/api/v1/example/+server.ts';
		const code = [
			"import { json } from '$lib/server/v1-json';",
			"import { makeThing } from '../../../../lib/server/things';",
			"import { listThings } from '$lib/server/things.js';",
			"export { makeThing as made } from '$lib/server/things.ts';",
			"import { shape } from '$lib/server/../server/shapes';",
			"import type { RequestHandler } from './$types';",
			"import { stamp } from '$lib/timestamps';",
			"const later = () => import('../../../../lib/server/things');"
		].join('\n');
		expect(judgeServerImportForms(EXAMPLE, code)).toEqual([
			"src/routes/api/v1/example/+server.ts:2 imports src/lib/server/things.ts as '../../../../lib/server/things': import src/lib/server only as $lib/server/<path>, with no extension (S2)",
			"src/routes/api/v1/example/+server.ts:3 imports src/lib/server/things.ts as '$lib/server/things.js': import src/lib/server only as $lib/server/<path>, with no extension (S2)",
			"src/routes/api/v1/example/+server.ts:4 imports src/lib/server/things.ts as '$lib/server/things.ts': import src/lib/server only as $lib/server/<path>, with no extension (S2)",
			"src/routes/api/v1/example/+server.ts:5 imports src/lib/server/shapes.ts as '$lib/server/../server/shapes': import src/lib/server only as $lib/server/<path>, with no extension (S2)",
			"src/routes/api/v1/example/+server.ts:8 imports src/lib/server/things.ts as '../../../../lib/server/things': import src/lib/server only as $lib/server/<path>, with no extension (S2)"
		]);
	});

	it('lets deleteDecision and withdrawDecision be called outside src/routes/api/v1 only by a handler on CURRENT_PASSWORD, and the rule finds one that is not (card 2682, D33)', () => {
		const outside = filesUnder('src/routes', (path) => path.endsWith('.ts') && !path.startsWith('src/routes/api/v1/'));
		expect(outside.flatMap((file) => judgePasswordWrites(file, readFileSync(join(ROOT, file), 'utf8'), CURRENT_PASSWORD))).toEqual([]);
		// Today the two internal routes call them, each listed.
		const calling = outside.filter((file) => /\b(deleteDecision|withdrawDecision)\(/.test(readFileSync(join(ROOT, file), 'utf8')));
		expect(calling).toEqual(['src/routes/api/decisions/[id]/+server.ts', 'src/routes/api/decisions/[id]/withdraw/+server.ts']);
		// Card 2713 (D6 row 7): fail closed, each key's module exports a function of that name, so a move that leaves a key
		// naming a module that no longer holds the write fails here rather than finding nothing.
		for (const key of PASSWORD_WRITES) {
			const [module, name] = key.split('#');
			const tree = ts.createSourceFile(module, readFileSync(join(ROOT, module), 'utf8'), ts.ScriptTarget.Latest, true);
			expect(exportsOf(tree).functions.map((exported) => exported.name), key).toContain(name);
		}

		// Against made-up source: a listed handler passes; one not listed, a call outside every handler, a page's server
		// file and a namespace import are found.
		const LISTED = ['src/routes/api/example/+server.ts DELETE'];
		const handler = [
			"import { deleteDecision, withdrawDecision as withdraw } from '$lib/server/decision-lifecycle-writes';",
			'export const DELETE = async ({ locals }) => {',
			"\twriteAs(locals, (caller) => deleteDecision(caller, { decisionId: 1 }, null, { source: 'ui' }));",
			'};',
			'export const POST = async ({ locals }) => {',
			"\twriteAs(locals, (caller) => withdraw(caller, { decisionId: 1 }, {}, { source: 'ui' }));",
			'};',
			"const helper = (caller) => deleteDecision(caller, { decisionId: 1 }, null, { source: 'ui' });"
		].join('\n');
		expect(judgePasswordWrites('src/routes/api/example/+server.ts', handler, LISTED)).toEqual([
			'src/routes/api/example/+server.ts:6 POST calls withdrawDecision and is not on CURRENT_PASSWORD (D33)',
			'src/routes/api/example/+server.ts:8 calls deleteDecision outside every handler (D33)'
		]);
		const page = "import { withdrawDecision } from '$lib/server/decision-lifecycle-writes';\nexport const load = () => ({});";
		expect(judgePasswordWrites('src/routes/decisions/[id]/+page.server.ts', page, LISTED)).toEqual([
			'src/routes/decisions/[id]/+page.server.ts imports withdrawDecision, which only a handler on CURRENT_PASSWORD may call (D33)'
		]);
		const namespace = "import * as lifecycle from '$lib/server/decision-lifecycle-writes';";
		expect(judgePasswordWrites('src/routes/api/example/+server.ts', namespace, LISTED)).toEqual([
			'src/routes/api/example/+server.ts:1 imports src/lib/server/decision-lifecycle-writes.ts as a namespace (D33)'
		]);
	});

	it('lets whilePasswordHolds and requirePasswordUnchanged be used across src only in a handler allowed them, which asks the password first, and the rule finds one that is not (card 2726, code review)', () => {
		const everywhere = filesUnder('src', (path) => /\.(ts|js|svelte)$/.test(path));
		expect(everywhere.length).toBeGreaterThan(300);
		expect(everywhere.flatMap((file) => judgePasswordProofs(file, readFileSync(join(ROOT, file), 'utf8'), PROOF_ALLOWED))).toEqual([]);

		// Each handler allowed a proof uses it, and asks for the password before its first use: the list holds no
		// handler that does not need it, and none that would hold a write to a password it never asked for.
		const faults: string[] = [];
		for (const [name, { keys }] of Object.entries({ whilePasswordHolds: PROOF_ALLOWED.whilePasswordHolds, requirePasswordUnchanged: { keys: PASSWORD_UNCHANGED_ONLY } })) {
			for (const key of keys) {
				const [file, method] = key.split(' ');
				const tree = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
				const fn = handlersOf(tree).find((handler) => handler.method === method)?.fn;
				if (!fn) {
					faults.push(`${key}: no handler this test can read`);
					continue;
				}
				const calls = callsIn(fn, true).sort((a, b) => a.getStart(tree) - b.getStart(tree));
				const first = calls.find((call) => calleeOf(call, tree) === name);
				const asks = calls.find((call) => ASKS_PASSWORD.includes(calleeOf(call, tree)));
				if (!first) faults.push(`${key} does not call ${name}`);
				else if (!asks || asks.getStart(tree) > first.getStart(tree)) faults.push(`${key} calls ${name} before it asks for the password`);
			}
		}
		expect(faults).toEqual([]);

		// Against made-up source: a listed handler passes; a page action, a $lib helper, a handler not listed, an
		// import under another name, a re-export and a page component are found, and so is a second use in the
		// file that defines it.
		const ALLOWED = {
			whilePasswordHolds: { keys: ['src/routes/api/example/+server.ts DELETE'], lists: 'CURRENT_PASSWORD' },
			requirePasswordUnchanged: { keys: ['src/routes/api/example/+server.ts DELETE'], lists: 'CURRENT_PASSWORD or PASSWORD_UNCHANGED_ONLY' }
		};
		const handler = [
			"import { whilePasswordHolds } from '$lib/server/auth';",
			'export const DELETE = async ({ locals }) => {',
			'\tawait whilePasswordHolds(1, hash, () => writeAs(locals, (caller) => remove(caller)));',
			'};',
			'export const POST = async ({ locals }) => {',
			'\tawait whilePasswordHolds(1, hash, () => writeAs(locals, (caller) => remove(caller)));',
			'};'
		].join('\n');
		expect(judgePasswordProofs('src/routes/api/example/+server.ts', handler, ALLOWED)).toEqual([
			'src/routes/api/example/+server.ts:6 POST uses whilePasswordHolds and is not on CURRENT_PASSWORD (card 2726)'
		]);
		const action = [
			"import { whilePasswordHolds } from '$lib/server/auth';",
			'export const actions = {',
			'\tdefault: async ({ locals }) => whilePasswordHolds(1, hash, () => writeAs(locals, (caller) => remove(caller)))',
			'};'
		].join('\n');
		expect(judgePasswordProofs('src/routes/decisions/[id]/+page.server.ts', action, ALLOWED)).toEqual([
			'src/routes/decisions/[id]/+page.server.ts:3 uses whilePasswordHolds outside every handler on CURRENT_PASSWORD (card 2726)'
		]);
		const helper = [
			"import { whilePasswordHolds } from '$lib/server/auth';",
			"import { requirePasswordUnchanged as unchanged } from '$lib/server/step-up';",
			'export const removeHeld = (userId, hash) => whilePasswordHolds(userId, hash, () => remove());'
		].join('\n');
		expect(judgePasswordProofs('src/lib/server/removal.ts', helper, ALLOWED)).toEqual([
			'src/lib/server/removal.ts:2 imports requirePasswordUnchanged under another name (card 2726)',
			'src/lib/server/removal.ts:3 uses whilePasswordHolds outside every handler on CURRENT_PASSWORD (card 2726)'
		]);
		expect(judgePasswordProofs('src/lib/server/index.ts', "export * from './auth';", ALLOWED)).toEqual([
			'src/lib/server/index.ts:1 re-exports every name of src/lib/server/auth.ts, whilePasswordHolds among them (card 2726)'
		]);
		expect(judgePasswordProofs('src/lib/components/Example.svelte', '<script>const proof = "requirePasswordUnchanged";</script>', ALLOWED)).toEqual([
			'src/lib/components/Example.svelte names requirePasswordUnchanged, which only a handler on CURRENT_PASSWORD or PASSWORD_UNCHANGED_ONLY may use (card 2726)'
		]);
		const defining = ['export async function whilePasswordHolds() {}', 'export const again = () => whilePasswordHolds();'].join('\n');
		expect(judgePasswordProofs('src/lib/server/auth.ts', defining, ALLOWED)).toEqual([
			'src/lib/server/auth.ts:2 uses whilePasswordHolds outside its own declaration (card 2726)'
		]);
	});

	it("T12. lets the current password's check be the step-up's alone: checkCurrentProof and refuseWrongPassword named only in auth.ts and step-up.ts, checkCurrentPassword nowhere, checkPassword called only by sign-in and auth.ts, and the rule finds each other (card 2771, S6)", () => {
		const everywhere = filesUnder('src', (path) => /\.(ts|js|svelte)$/.test(path));
		expect(everywhere.length).toBeGreaterThan(300);
		expect(everywhere.flatMap((file) => judgeProofCheck(file, readFileSync(join(ROOT, file), 'utf8')))).toEqual([]);

		// step-up.ts imports each once and calls each once; auth.ts declares each and calls checkPassword once.
		const named = (file: string, name: string) =>
			identifiersOf(file, readFileSync(join(ROOT, file), 'utf8'))
				.filter(({ id }) => id.text === name)
				.map(({ id }) => (ts.isImportSpecifier(id.parent) ? 'import' : ts.isCallExpression(id.parent) && id.parent.expression === id ? 'call' : ts.SyntaxKind[id.parent.kind]));
		expect(named('src/lib/server/step-up.ts', 'checkCurrentProof')).toEqual(['import', 'call']);
		expect(named('src/lib/server/step-up.ts', 'refuseWrongPassword')).toEqual(['import', 'call']);
		expect(named('src/lib/server/auth.ts', 'checkCurrentProof')).toEqual(['FunctionDeclaration']);
		expect(named('src/lib/server/auth.ts', 'refuseWrongPassword')).toEqual(['FunctionDeclaration']);
		expect(named('src/lib/server/auth.ts', 'checkPassword')).toEqual(['import', 'call']);
		expect(named('src/routes/login/+page.server.ts', 'checkPassword')).toEqual(['import', 'call']);

		// Against made-up source: a route importing the check, a page naming it, a re-export, the old check, and a
		// route that compares a password itself, each a finding.
		expect(
			judgeProofCheck(
				'src/routes/api/example/+server.ts',
				["import { checkCurrentProof } from '$lib/server/auth';", 'export const PUT = async () => checkCurrentProof(session, 1, password, code, hash, where);'].join('\n')
			)
		).toEqual(['src/routes/api/example/+server.ts:1 names checkCurrentProof (card 2771)', 'src/routes/api/example/+server.ts:2 names checkCurrentProof (card 2771)']);
		expect(judgeProofCheck('src/lib/components/Example.svelte', '<p>Hi</p>\n<script lang="ts">\n\tconst check = checkCurrentProof;\n</script>')).toEqual([
			'src/lib/components/Example.svelte:3 names checkCurrentProof (card 2771)'
		]);
		expect(judgeProofCheck('src/lib/server/index.ts', "export * from './auth';")).toEqual([
			'src/lib/server/index.ts:1 re-exports every name of auth.ts, checkCurrentProof among them (card 2771)'
		]);
		expect(judgeProofCheck('src/lib/server/old.ts', 'export const old = () => checkCurrentPassword();')).toEqual(['src/lib/server/old.ts:1 names checkCurrentPassword (card 2771)']);
		expect(
			judgeProofCheck(
				'src/routes/api/example/+server.ts',
				["import { checkPassword } from '$lib/server/passwords';", 'export const PUT = async () => (await checkPassword(password, hash, "known")).matches;'].join('\n')
			)
		).toEqual(['src/routes/api/example/+server.ts:2 calls checkPassword (card 2771, S6)']);
		// A comment names nothing: the schema's and the types' comments say where the check is.
		expect(judgeProofCheck('src/lib/server/db/schema.ts', '// checkCurrentProof in auth.ts\nexport const x = 1;')).toEqual([]);
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

		it('sees a service imported by a relative path or with .js, and finds its write outside a writeAs callback (card 2681, the code review S2)', () => {
			const code = [
				...head,
				"import { makeThing as relative } from '../../../lib/server/things';",
				"import { makeThing as withJs } from '$lib/server/things.js';",
				'export const DELETE = async ({ locals }) => {',
				'\trelative(locals.user, 1, null, {});',
				'\twithJs(locals.user, 1, null, {});',
				'\twriteAs(locals, (caller) => caller);',
				'};'
			].join('\n');

			expect(calls(code)).toEqual([
				'src/routes/api/example/+server.ts:10 calls relative, a write of src/lib/server/things.ts, outside a writeAs callback (2)',
				'src/routes/api/example/+server.ts:11 calls withJs, a write of src/lib/server/things.ts, outside a writeAs callback (2)'
			]);
		});

		it("reads confirmStepUp's guard as a writeAs callback for a read, and finds a write in it (card 2701)", () => {
			const code = [
				...head,
				"import { confirmStepUp } from '$lib/server/step-up';",
				'export const DELETE = async ({ request, locals, cookies }) => {',
				'\tconst body = await readBody(request);',
				"\tconst { userId } = await confirmStepUp(locals, cookies, body, 'DELETE /api/example', (caller) => listThings(caller));",
				"\tawait confirmStepUp(locals, cookies, body, 'DELETE /api/example', (caller) => makeThing(caller, 1, null, {}));",
				'\twriteAs(locals, (caller) => makeThing(caller, userId, null, {}));',
				'};'
			].join('\n');

			expect(calls(code)).toEqual([
				'src/routes/api/example/+server.ts:11 calls makeThing, a write of src/lib/server/things.ts, outside a writeAs callback (2)'
			]);
		});

		it('leaves a handler that calls no service to card 2253\'s rule', () => {
			const code = [...head, 'export const PUT = async ({ request, locals }) => {', '\tconst body = await readBody(request);', '\treturn json(shape(body));', '};'].join('\n');

			expect(calls(code)).toEqual([]);
		});

		const service = (code: string) => judgeService('src/lib/server/things.ts', code, [], writers).findings;
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

		it('lets a service export a page route’s options written out, and finds them made of anything else, not a const, or misnamed (the card 2296 review)', () => {
			const code = [
				WRITE_AS + 'export const READS = [] as const;',
				"export const MAKE_THING_PAGE_OPTIONS = { source: 'ui', allowMore: true, says: 'No' } as const satisfies ServiceOptions;",
				'export const DROP_THING_PAGE_OPTIONS = { source: SOURCE };',
				"export let KEEP_THING_PAGE_OPTIONS = { source: 'ui' };",
				"export const THING_OPTIONS = { source: 'ui' };"
			].join('\n');

			expect(service(code)).toEqual([
				'src/lib/server/things.ts:5 exports DROP_THING_PAGE_OPTIONS, page options that are not an object written out of texts, true and false (2)',
				'src/lib/server/things.ts:6 exports KEEP_THING_PAGE_OPTIONS, page options that are not an object written out of texts, true and false (2)',
				'src/lib/server/things.ts:7 exports THING_OPTIONS, which is not a function written here: a service exports its functions and READS alone (2)'
			]);
			expect(judgeService('src/lib/server/things.ts', code, [], writers).pageOptions).toEqual(['MAKE_THING_PAGE_OPTIONS']);
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

		it('finds a read that takes an allowance itself, through a function of its own module, and under another name (card 2713, C3)', () => {
			const code = [
				"import { inWrite } from './write-as';",
				"import { takeAllowance as allow } from './rate-limit';",
				"export const READS = ['cappedGuard', 'localGuard', 'renamedGuard', 'plainGuard'];",
				'export function cappedGuard(user) { return takeAllowance(`x:${user.id}`, 1, 5, 1000); }',
				'function capOf(user) { return takeAllowance(`x:${user.id}`, 1, 5, 1000); }',
				'export function localGuard(user) { return capOf(user); }',
				'export function renamedGuard(user) { return allow(`x:${user.id}`, 1, 5, 1000); }',
				'export function plainGuard(user) { return user.id; }',
				'export function makeThing(caller) { inWrite(); allow(`x`, 1, 5, 1000); return capOf(caller); }'
			].join('\n');

			// A write may take one; a read, written here or in a function it calls, may not.
			expect(service(code)).toEqual([
				'src/lib/server/things.ts:4 cappedGuard is on READS and writes: takeAllowance (3)',
				'src/lib/server/things.ts:5 localGuard is on READS and writes: takeAllowance (through capOf) (3)',
				'src/lib/server/things.ts:7 renamedGuard is on READS and writes: allow (3)'
			]);
		});

		it('reads the writers of a module from its source, through its own functions, other modules, namespaces and re-exports, and holds RECORD_WRITERS to them (card 2713, C2)', () => {
			const RECORD = 'src/lib/server/decision-record.ts';
			const MAIL = 'src/lib/server/decision-mail.ts';
			const files = [
				{
					file: RECORD,
					source: [
						"import { db } from './db';",
						"import { createHmac } from 'node:crypto';",
						'export function appendEvent(e) { db.insert(events).values(e).run(); }',
						'export function appendNote(n) { return stampNote(n); }',
						'function stampNote(n) { db.update(notes).set(n).run(); }',
						'export function readEvents(id) { return db.select().from(events).all(); }',
						"export function hashIt(x) { const seen = new Map(); seen.delete(x); return createHmac('sha256', 'k').update(x).digest(); }"
					].join('\n')
				},
				{
					file: MAIL,
					source: [
						"import * as record from './decision-record';",
						"import { appendEvent as note } from './decision-record';",
						'export function queueA() { note({}); }',
						'export const queueB = () => record.appendNote({});',
						'export function later() { return record.readEvents(1); }'
					].join('\n')
				},
				{ file: 'src/lib/server/relay.ts', source: "export { queueA as queued, later } from './decision-mail';" },
				{ file: 'src/lib/server/wrap.ts', source: "import { inTransaction as t } from './db/transaction';\nexport const wrap = () => t(() => 1);" }
			];
			const derived = writersOf(files);

			// A Map's delete, a hash's update and a select are none.
			expect(Object.fromEntries([...derived].map(([file, names]) => [file, [...names].sort()]))).toEqual({
				[RECORD]: ['appendEvent', 'appendNote'],
				[MAIL]: ['queueA', 'queueB'],
				'src/lib/server/relay.ts': ['queued'],
				'src/lib/server/wrap.ts': ['wrap']
			});
			// The list fails closed: a writer that no longer writes, one no longer exported, a module not there, and a writer not listed.
			expect(judgeWriterList(files, derived, { [RECORD]: ['appendEvent', 'readEvents', 'appendGone'], 'src/lib/server/gone.ts': ['x'] })).toEqual([
				`RECORD_WRITERS names ${RECORD}#readEvents, which no longer writes as this scan reads it (writers)`,
				`RECORD_WRITERS names ${RECORD}#appendGone, which it no longer exports (writers)`,
				`${RECORD}#appendNote writes and is not on RECORD_WRITERS (writers)`,
				'RECORD_WRITERS names src/lib/server/gone.ts, which is not a module here (writers)'
			]);
			// A writer named is a write even where the reading misses it, and only listed modules' writers are counted.
			expect(Object.fromEntries([...listedWriters(derived, { [MAIL]: ['later'] })].map(([file, names]) => [file, [...names].sort()]))).toEqual({
				[MAIL]: ['later', 'queueA', 'queueB']
			});
		});

		it('reads as a writer any module’s function that reaches a listed writer or inTransaction, and a writer referred to without a call, but no raw database call outside the listed modules (card 2713, C4, C5)', () => {
			const RECORD = 'src/lib/server/decision-record.ts';
			const files = [
				{
					file: RECORD,
					source: [
						"import { db } from './db';",
						'export function appendEvent(e) { db.insert(events).values(e).run(); }',
						'export function appendTwice(e) { appendEvent(e); appendEvent(e); }',
						'export function readEvents(id) { return db.select().from(events).all(); }'
					].join('\n')
				},
				// C4: a module that is not listed, reaching a listed writer through its own function, an alias and a namespace, and
				// inTransaction under another name and through a namespace; and a re-export of it, and a module that calls that.
				{
					file: 'src/lib/server/reminders.ts',
					source: [
						"import { appendEvent as note } from './decision-record';",
						"import * as record from './decision-record';",
						"import { inTransaction as tx } from './db/transaction';",
						"import * as t from './db/transaction';",
						'export async function runOnce(now) { return step(now); }',
						'function step(now) { note({ now }); }',
						'export function viaSpace() { record.appendTwice({}); }',
						'export function viaTx() { return tx(() => 1); }',
						'export function viaT() { const run = t.inTransaction; return run(() => 1); }',
						'export function reading() { return record.readEvents(1); }'
					].join('\n')
				},
				{ file: 'src/lib/server/relay.ts', source: "export { runOnce as relayed } from './reminders';" },
				{ file: 'src/lib/server/caller.ts', source: "import { relayed } from './relay';\nexport function stillCaller() { return relayed(new Date()); }" },
				// C5: a writer referred to and not called: a callback, `.call`, a name assigned in a body and at the top, the
				// namespace whole, an exported constant and an import exported again. A type and a property's name are none.
				{
					file: 'src/lib/server/handed.ts',
					source: [
						"import { appendEvent } from './decision-record';",
						"import * as record from './decision-record';",
						'const w = appendEvent;',
						'export function each(es) { es.forEach(appendEvent); }',
						'export function called(e) { appendEvent.call(null, e); }',
						'export function assigned(e) { const v = appendEvent; v(e); }',
						'export function topAlias(e) { w(e); }',
						'export function whole() { return Object.values(record); }',
						'export const held = appendEvent;',
						'export { appendEvent as again };',
						'export function typed() { const none: typeof appendEvent | null = null; return none; }',
						"export function keyed() { return { appendEvent: 1 }['appendEvent']; }"
					].join('\n')
				},
				// No record write: a signing key made once, a SELECT prepared.
				{
					file: 'src/lib/server/request-tokens.ts',
					source: "import { db } from './db';\nfunction formSecret() { db.insert(settings).values({}).run(); return 'k'; }\nexport function issueFormToken() { return formSecret(); }"
				},
				{ file: 'src/lib/server/tokens.ts', source: "export function totals() { return sqlite.prepare('SELECT 1').all(); }" }
			];
			const sorted = (writers: Writers) => Object.fromEntries([...writers].map(([file, names]) => [file, [...names].sort()]));
			const derived = writersOf(files);
			const HANDED = ['again', 'assigned', 'called', 'each', 'held', 'topAlias', 'whole'];

			expect(sorted(reachingWriters(files, derived, { [RECORD]: ['appendEvent', 'appendTwice'] }))).toEqual({
				[RECORD]: ['appendEvent', 'appendTwice'],
				[TRANSACTION_MODULE]: ['inTransaction'],
				'src/lib/server/reminders.ts': ['runOnce', 'viaSpace', 'viaT', 'viaTx'],
				'src/lib/server/relay.ts': ['relayed'],
				'src/lib/server/caller.ts': ['stillCaller'],
				'src/lib/server/handed.ts': HANDED
			});
			// The reading on the database (C2) finds the raw calls, and the same references (C5).
			expect(sorted(derived)).toMatchObject({
				'src/lib/server/request-tokens.ts': ['issueFormToken'],
				'src/lib/server/tokens.ts': ['totals'],
				'src/lib/server/handed.ts': HANDED
			});
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

		it('lets a write be handed its own module’s page options, whole or spread, and finds them handed to another module’s write, beside a says made of data, or used otherwise (the card 2296 review)', () => {
			const PAGED = new Map([
				['src/lib/server/things.ts', { reads: ['listThings'], writes: ['makeThing'], pageOptions: ['MAKE_THING_PAGE_OPTIONS'] }],
				['src/lib/server/others.ts', { reads: [], writes: ['makeOther'], pageOptions: [] }]
			]);
			const code = [
				"import { readBody } from '$lib/server/request-body';",
				"import { MAKE_THING_PAGE_OPTIONS, makeThing } from '$lib/server/things';",
				"import { makeOther } from '$lib/server/others';",
				"import { writeAs } from '$lib/server/write-as';",
				'export const PUT = async ({ request, locals, url }) => {',
				'\tconst body = await readBody(request);',
				'\twriteAs(locals, (caller) => makeThing(caller, 1, body, MAKE_THING_PAGE_OPTIONS));',
				'\twriteAs(locals, (caller) => makeThing(caller, 1, body, { ...MAKE_THING_PAGE_OPTIONS, baseUrl: url.origin }));',
				'\twriteAs(locals, (caller) => makeOther(caller, 1, body, MAKE_THING_PAGE_OPTIONS));',
				'\twriteAs(locals, (caller) => makeThing(caller, 1, body, { ...MAKE_THING_PAGE_OPTIONS, says: body.why }));',
				'\tconst kept = MAKE_THING_PAGE_OPTIONS;',
				'\treturn new Response(String(kept));',
				'};'
			].join('\n');

			expect(judgeServiceCalls('src/routes/api/example/+server.ts', code, PAGED)).toEqual([
				'src/routes/api/example/+server.ts:9 hands makeOther options that are not an object written out at the call (4)',
				'src/routes/api/example/+server.ts:9 uses MAKE_THING_PAGE_OPTIONS of src/lib/server/things.ts other than as the options of a write of that module (4)',
				'src/routes/api/example/+server.ts:10 hands makeThing a says that is not a text written out (4)',
				'src/routes/api/example/+server.ts:11 uses MAKE_THING_PAGE_OPTIONS of src/lib/server/things.ts other than as the options of a write of that module (4)'
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

		it("follows a read's helper one level into a module on SERVICE_HELPERS, and on through that module's own functions, takeAllowance and an imported writer a write there (card 2713, D6 row 4, R1, R2, C2)", () => {
			const HELPER = 'src/lib/server/decision-write-shared.ts';
			const helper = {
				file: HELPER,
				source: [
					"import { appendEvent } from './decision-record';",
					'export function stampIt(id) { db.insert(stamps).values({ id }).run(); }',
					'export function readIt(id) { return db.select().from(things).where(eq(things.id, id)).get(); }',
					'export function capIt(user) { return refusalOf(user); }',
					'function refusalOf(user) { return takeAllowance(`x:${user.id}`, 1, 5, 1000); }',
					"export function participantOn(decisionId, participantId) { appendEvent(decisionId, 'seen', SYSTEM_ACTOR, {}); return null; }"
				].join('\n')
			};
			const code = [
				"import { inWrite } from './write-as';",
				"import { capIt, participantOn, readIt, stampIt } from './decision-write-shared';",
				"export const READS = ['thingGuard', 'otherGuard', 'cappedGuard', 'participantGuard'];",
				'export function thingGuard(user) { return stampIt(1); }',
				'export function otherGuard(user) { return readIt(1); }',
				'export function cappedGuard(user) { return capIt(user); }',
				'export function participantGuard(user) { return participantOn(1, 2); }',
				'export function makeThing(caller) { inWrite(); stampIt(1); capIt(caller); participantOn(1, 2); }'
			].join('\n');
			const FILE = 'src/lib/server/decision-things-writes.ts';

			expect(judgeService(FILE, code, [helper], writers).findings).toEqual([
				`${FILE}:4 thingGuard is on READS and writes: db.insert(stamps).values({id}).run (through ${HELPER}#stampIt) (3)`,
				`${FILE}:6 cappedGuard is on READS and writes: takeAllowance (through ${HELPER}#capIt) (3)`,
				`${FILE}:7 participantGuard is on READS and writes: appendEvent (through ${HELPER}#participantOn) (3)`
			]);
			// The helper's sources are what the follow reads (R1): without them the same module passes.
			expect(judgeService(FILE, code, [], writers).findings).toEqual([]);

			// Real wiring (R1, C1): every service was judged with the suite's own `helpers` and `writers`, the very values, and
			// `helpers` is SERVICE_HELPERS with each module's source as it stands, so that a call site handed `[]`, part of the
			// list or other sources fails here.
			for (const [, reading] of services) {
				expect(reading.helpers).toBe(helpers);
				expect(reading.writers).toBe(writers);
			}
			expect(helpers).toEqual(SERVICE_HELPERS.map((file) => ({ file, source: readFileSync(join(ROOT, file), 'utf8') })));
			// The real module holding the participant guards, and the suite's helpers with a write planted in the real
			// participantOn, which both guards call: an insert (R1), and the record's appendEvent imported and called (C2).
			const PARTICIPANT_ON = 'export function participantOn(decisionId: number, participantId: number): DecisionParticipant {';
			const RECORD_IMPORT = "import { accountHistory, eventsOfKind, lastMailAt, mailsSince, peopleById, recordMailsSince, snapshotOf, type RecordActor } from './decision-record';";
			const plant = (edit: (source: string) => string) =>
				helpers.map((given) => {
					if (given.file !== HELPER) return given;
					const source = edit(given.source);
					expect(source).not.toBe(given.source);
					return { file: given.file, source };
				});
			const inserted = plant((source) => source.replace(PARTICIPANT_ON, '$&\n\tdb.insert(decisionParticipants).values({}).run();'));
			const appended = plant((source) =>
				source
					.replace(RECORD_IMPORT, RECORD_IMPORT.replace('accountHistory, ', 'accountHistory, appendEvent, '))
					.replace(PARTICIPANT_ON, "$&\n\tappendEvent(decisionId, 'seen', SYSTEM_ACTOR, {});")
			);
			expect(appended.find(({ file }) => file === HELPER)!.source).toContain('accountHistory, appendEvent, ');
			const [holder] = [...services].filter(([, { reads }]) => reads.includes('participantAccountGuard')).map(([file]) => file);
			const source = readFileSync(join(ROOT, holder), 'utf8');
			const findingsWith = (given: typeof helpers) => judgeService(holder, source, given, writers).findings.map((finding) => finding.replace(/:\d+ /, ' '));
			expect(findingsWith(helpers)).toEqual([]);
			expect(findingsWith(inserted)).toEqual([
				`${holder} participantAccountGuard is on READS and writes: db.insert(decisionParticipants).values({}).run (through ${HELPER}#participantOn) (3)`,
				`${holder} participantAddressGuard is on READS and writes: db.insert(decisionParticipants).values({}).run (through ${HELPER}#participantOn) (3)`
			]);
			expect(findingsWith(appended)).toEqual([
				`${holder} participantAccountGuard is on READS and writes: appendEvent (through ${HELPER}#participantOn) (3)`,
				`${holder} participantAddressGuard is on READS and writes: appendEvent (through ${HELPER}#participantOn) (3)`
			]);
			// And the helper pin, over every file under src with the same planted helper (C2).
			const everything = filesUnder('src', (path) => /\.(ts|js|svelte)$/.test(path)).map((file) => ({ file, source: readFileSync(join(ROOT, file), 'utf8') }));
			const withPlanted = everything.map((given) => (given.file === HELPER ? appended.find(({ file }) => file === HELPER)! : given));
			expect(judgeServiceHelpers(everything, SERVICES, SERVICE_HELPERS, writers, NOT_SERVICES)).toEqual([]);
			expect(judgeServiceHelpers(withPlanted, SERVICES, SERVICE_HELPERS, writers, NOT_SERVICES).map((finding) => finding.replace(/:\d+ /, ' '))).toEqual([
				`${HELPER} calls appendEvent: a service helper writes nothing (helper pin)`
			]);
		});

		it("follows a read through its own module's functions into a helper and on into another, at any depth and round a cycle, a writer of any module and one referred to without a call a write there (card 2713, C4, C5, C6)", () => {
			const HELPER = 'src/lib/server/decision-write-shared.ts';
			const OTHER = 'src/lib/server/decision-other-shared.ts';
			const helper = {
				file: HELPER,
				source: [
					"import { appendEvent } from './decision-record';",
					"import { runDecisionRemindersOnce } from './decision-reminders';",
					"import { deeper } from './decision-other-shared';",
					'export function capIt(user) { return takeAllowance(`x:${user.id}`, 1, 5, 1000); }',
					'export function noteAll(ids) { ids.forEach(appendEvent); }',
					'export function remind(now) { return runDecisionRemindersOnce(now); }',
					'export function pingIt(n) { return n > 0 ? pongIt(n - 1) : null; }',
					'function pongIt(n) { return pingIt(n); }',
					'export function onward() { return deeper(); }'
				].join('\n')
			};
			const other = { file: OTHER, source: "import { appendRuling } from './decision-record';\nexport function deeper() { return appendRuling.call(null, {}); }" };
			const code = [
				"import { stillCallerNow } from './write-as';",
				"import { issueFormToken } from './request-tokens';",
				"import { appendEvent } from './decision-record';",
				"import { capIt, noteAll, onward, pingIt, remind } from './decision-write-shared';",
				"export const READS = ['cappedGuard', 'deepGuard', 'noteGuard', 'remindGuard', 'callerGuard', 'handedGuard', 'cycleGuard', 'onwardGuard', 'tokenGuard'];",
				'function outer(user) { return inner(user); }',
				'function inner(user) { return capIt(user); }',
				'function viaLocal(ids) { return noteAll(ids); }',
				'function loopA(n) { return n > 0 ? loopB(n - 1) : pingIt(n); }',
				'function loopB(n) { return loopA(n); }',
				// C6: guard → local → helper, and guard → local → local → helper.
				'export function cappedGuard(user) { return inner(user); }',
				'export function deepGuard(user) { return outer(user); }',
				// C5 in the follow: the helper hands appendEvent on as a callback.
				'export function noteGuard(ids) { return viaLocal(ids); }',
				// C4: a writer of a module not listed, through the helper and called directly.
				'export function remindGuard(now) { return remind(now); }',
				'export function callerGuard(given) { return stillCallerNow(given); }',
				// C5 in the read itself.
				'export function handedGuard(ids) { ids.map(appendEvent); return null; }',
				// A cycle in this module and one in the helper end, and write nothing.
				'export function cycleGuard(n) { return loopA(n); }',
				// C6: from one helper into another, which calls the record by `.call`.
				'export function onwardGuard() { return onward(); }',
				// A raw database call outside the listed modules is none (C4).
				'export function tokenGuard() { return issueFormToken(); }'
			].join('\n');
			const FILE = 'src/lib/server/decision-things-writes.ts';

			expect(judgeService(FILE, code, [helper, other], writers).findings).toEqual([
				`${FILE}:7 cappedGuard is on READS and writes: takeAllowance (through inner → ${HELPER}#capIt) (3)`,
				`${FILE}:7 deepGuard is on READS and writes: takeAllowance (through outer → inner → ${HELPER}#capIt) (3)`,
				`${FILE}:8 noteGuard is on READS and writes: appendEvent (through viaLocal → ${HELPER}#noteAll) (3)`,
				`${FILE}:14 remindGuard is on READS and writes: runDecisionRemindersOnce (through ${HELPER}#remind) (3)`,
				`${FILE}:15 callerGuard is on READS and writes: stillCallerNow (3)`,
				`${FILE}:16 handedGuard is on READS and writes: appendEvent (3)`,
				`${FILE}:18 onwardGuard is on READS and writes: appendRuling (through ${HELPER}#onward → ${OTHER}#deeper) (3)`
			]);
		});

		it('finds a service helper that calls a writer of any module, or refers to a writer without calling it (card 2713, C4, C5)', () => {
			const HELPER = 'src/lib/server/decision-write-shared.ts';
			const helper = {
				file: HELPER,
				source: [
					"import { appendEvent, appendVersion } from './decision-record';",
					"import * as record from './decision-record';",
					"import { runDecisionRemindersOnce } from './decision-reminders';",
					"import { stillCallerNow as still } from './write-as';",
					"import { issueFormToken } from './request-tokens';",
					'const w = appendVersion;',
					'export function remind(now) { return runDecisionRemindersOnce(now); }',
					'export function who(given) { return still(given); }',
					'export function each(ids) { ids.forEach(appendEvent); }',
					'export function called(e) { appendEvent.call(null, e); }',
					'export function assigned(e) { const v = appendEvent; return v(e); }',
					"export function whole() { return [Object.values(record), record['appendRuling']]; }",
					'export function token() { return issueFormToken(); }',
					'export function typed() { const none: typeof appendEvent | null = null; return none; }'
				].join('\n')
			};

			// C4: the reminders' run and the caller read again in a transaction are writers; C5: each reference is a write; the
			// signing key made once, and a type, are none.
			expect(judgeServiceHelpers([helper], [], [HELPER], writers)).toEqual([
				`${HELPER}:6 refers to appendVersion: a service helper writes nothing (helper pin)`,
				`${HELPER}:7 calls runDecisionRemindersOnce: a service helper writes nothing (helper pin)`,
				`${HELPER}:8 calls still: a service helper writes nothing (helper pin)`,
				`${HELPER}:9 refers to appendEvent: a service helper writes nothing (helper pin)`,
				`${HELPER}:10 refers to appendEvent: a service helper writes nothing (helper pin)`,
				`${HELPER}:11 refers to appendEvent: a service helper writes nothing (helper pin)`,
				`${HELPER}:12 refers to record: a service helper writes nothing (helper pin)`,
				`${HELPER}:12 refers to record['appendRuling']: a service helper writes nothing (helper pin)`
			]);
		});

		it('keeps a module on SERVICE_HELPERS to the decision services, by name, in every form of import, and writing nothing (card 2713, D6 row 5, R2 to R4, R6)', () => {
			const HELPER = 'src/lib/server/decision-write-shared.ts';
			const THINGS = 'src/lib/server/decision-things-writes.ts';
			const OTHERS = 'src/lib/server/decision-others-writes.ts';
			const LISTED = ['src/lib/server/cards.ts', THINGS, OTHERS];
			const helper = {
				file: HELPER,
				source: [
					"import { createCard } from './cards';",
					"import { inTransaction } from './db/transaction';",
					'export const READS = [];',
					'export function stampIt(id) { db.insert(stamps).values({ id }).run(); }',
					"export function runIt() { sqlite.prepare('DELETE FROM things').run(); }",
					'export function userOf(locals) { return locals.user; }',
					// C2: the record's writers, by name, under another name and through a namespace; a read of it and the caller's
					// allowance are no finding here.
					"import { appendEvent, appendVersion as v, accountHistory } from './decision-record';",
					"import * as record from './decision-record';",
					"import { takeAllowance } from './rate-limit';",
					'export function participantOn(d) { accountHistory(d); takeAllowance(`x`, 1, 5, 1000); appendEvent(d); v(d); record.appendRuling(d); }'
				].join('\n')
			};
			const files = [
				helper,
				// Passes: a decision service, by name, by either path.
				{ file: THINGS, source: "import { keyed, sourceOf } from './decision-write-shared';\nimport { decisionEntry } from '$lib/server/decision-write-shared';" },
				// R4, R6, and a decision service's re-export and import().
				{
					file: OTHERS,
					source: [
						"import * as shared from './decision-write-shared';",
						"import shared2 from './decision-write-shared';",
						"import { keyed as k } from './decision-write-shared';",
						"import { makeThing } from './decision-things-writes';",
						"export { keyed } from './decision-write-shared';",
						"const later = () => import('./decision-write-shared');"
					].join('\n')
				},
				// R3: by a route, by a relative path, by a non-decision service with .js, by a decision module that is no service,
				// by export from, export *, import(), and in a page.
				{ file: 'src/routes/api/x/+server.ts', source: "import { keyed } from '$lib/server/decision-write-shared';" },
				{ file: 'src/routes/api/y/+server.ts', source: "import { keyed } from '../../../lib/server/decision-write-shared';" },
				{ file: 'src/lib/server/cards.ts', source: "import { keyed } from './decision-write-shared.js';" },
				{ file: 'src/lib/server/decision-results.ts', source: "import { participantOn } from './decision-write-shared';" },
				{ file: 'src/lib/server/a.ts', source: "export { keyed } from './decision-write-shared';" },
				{ file: 'src/lib/server/b.ts', source: "export * from '$lib/server/decision-write-shared';" },
				{ file: 'src/lib/server/c.ts', source: "export async function load() { return import('$lib/server/decision-write-shared'); }" },
				{ file: 'src/routes/z/+page.svelte', source: "<script>import { keyed } from '$lib/server/decision-write-shared';</script>" }
			];

			expect(judgeServiceHelpers(files, LISTED, [HELPER], writers)).toEqual([
				// The helper: a service imported, a transaction, READS, the request's locals (the parameter and its read), and two writes (R2).
				`${HELPER}:1 imports src/lib/server/cards.ts, a service: a service helper imports none (helper pin)`,
				`${HELPER}:2 names inTransaction (helper pin)`,
				`${HELPER}:3 names READS: a service helper declares none (helper pin)`,
				`${HELPER}:6 names locals (helper pin)`,
				`${HELPER}:6 names locals (helper pin)`,
				`${HELPER}:4 calls db.insert(stamps).values({id}).run: a service helper writes nothing (helper pin)`,
				`${HELPER}:5 calls sqlite.prepare('DELETEFROMthings').run: a service helper writes nothing (helper pin)`,
				`${HELPER}:10 calls appendEvent: a service helper writes nothing (helper pin)`,
				`${HELPER}:10 calls v: a service helper writes nothing (helper pin)`,
				`${HELPER}:10 calls record.appendRuling: a service helper writes nothing (helper pin)`,
				// A decision service: a namespace, a default and an alias (R4), another decision service (R6), a re-export, import().
				`${OTHERS}:1 imports ${HELPER}, a service helper, other than by name: import each function by its own name (helper pin)`,
				`${OTHERS}:2 imports ${HELPER}, a service helper, other than by name: import each function by its own name (helper pin)`,
				`${OTHERS}:3 imports keyed of ${HELPER} as k: import it under its own name (helper pin)`,
				`${OTHERS}:4 imports ${THINGS}: a decision service imports no other decision service (helper pin)`,
				`${OTHERS}:5 re-exports ${HELPER}, a service helper (helper pin)`,
				`${OTHERS}:6 imports ${HELPER}, a service helper, other than by name: import each function by its own name (helper pin)`,
				// Anything else, in every form (R3).
				`src/routes/api/x/+server.ts:1 imports ${HELPER}, a service helper, which only a decision service on SERVICES may import (helper pin)`,
				`src/routes/api/y/+server.ts:1 imports ${HELPER}, a service helper, which only a decision service on SERVICES may import (helper pin)`,
				`src/lib/server/cards.ts:1 imports ${HELPER}, a service helper, which only a decision service on SERVICES may import (helper pin)`,
				`src/lib/server/decision-results.ts:1 imports ${HELPER}, a service helper, which only a decision service on SERVICES may import (helper pin)`,
				`src/lib/server/a.ts:1 imports ${HELPER}, a service helper, which only a decision service on SERVICES may import (helper pin)`,
				`src/lib/server/b.ts:1 imports ${HELPER}, a service helper, which only a decision service on SERVICES may import (helper pin)`,
				`src/lib/server/c.ts:1 imports ${HELPER}, a service helper, which only a decision service on SERVICES may import (helper pin)`,
				`src/routes/z/+page.svelte names ${HELPER}, a service helper, which only a decision service imports (helper pin)`
			]);
			// A helper listed as a service, or excused as none, and one that is not there.
			expect(judgeServiceHelpers([{ file: HELPER, source: '' }], [HELPER], [HELPER], writers, { [HELPER]: 'no' })).toEqual([
				`${HELPER} is a service helper and is on SERVICES (helper pin)`,
				`${HELPER} is a service helper and is on NOT_SERVICES (helper pin)`
			]);
			expect(judgeServiceHelpers([], [], [HELPER], writers)).toEqual([`SERVICE_HELPERS names ${HELPER}, which is not a module here (helper pin)`]);
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

	it('and a body that can be read is still refused to them, whatever is wrong in it', async () => {
		const s = scene();

		const res = await api('PUT', `/api/v1/labels/${s.label.id}`, { user: s.outsider, body: { name: 5 } });

		// The outsider cannot open the label's board: as a label that is not there (card 2719).
		expect([res.status, res.body]).toEqual([404, { message: 'Label not found' }]);
		expect(db.select({ name: labels.name }).from(labels).where(eq(labels.id, s.label.id)).get()).toEqual({ name: 'A label' });
	});
});

// ─── Card 3004: every write of where the server sends, and the record of it ─────────────

/**
 * Card 3004 (section 5, R4, test gg): every write under src and scripts of where this server sends, by `file#function`
 * (`writerNameOf`), with how many such statements and why. Each is a writer that records the change in this server's
 * record of where it sends (O1 to O19), or one of section 5's "records nothing" table. Named explicitly (R4): the
 * cascades a delete of `boards` (its webhooks) and of `users` (its report schedules) writes; `setSetting` with a key
 * that is not written out, read as a write of any setting; and the field-by-field webhook PUT, whose `.set(updates)` is
 * read as a write of `active` and `url`.
 */
const OUTBOUND_WRITES: Record<string, { count: number; why: string }> = {
	// The writers that record (O1 to O18).
	'src/routes/api/v1/boards/[boardId]/webhooks/+server.ts#POST': {
		count: 2,
		why: 'O1: the webhook made with no address, then given it sealed; recorded `on` with the keyed digest of its address after them.'
	},
	'src/routes/api/v1/webhooks/[webhookId]/+server.ts#PUT': {
		count: 1,
		why: 'O2, O3: `.set(updates)`, field by field (R4), read as a write of `active` and `url`; recorded on, off or held with the address it is left with where either changed, or the record says otherwise (3002-R12).'
	},
	'src/routes/api/v1/webhooks/[webhookId]/+server.ts#DELETE': { count: 1, why: 'O4: the webhook deleted; recorded `deleted` just before, while it can be read.' },
	'src/lib/server/webhooks.ts#holdInScope': {
		count: 1,
		why: 'O5 through holdWebhooksOfSetter, which records each webhook it held `held`; its other callers (the reset branch, the passes over readable and revealed secrets) are holds derived from access, keys and accounts, re-derived at every restore and start: they record nothing.'
	},
	'src/lib/server/deletes.ts#removeUnder': {
		count: 3,
		why: "O6: a board's schedules deleted (the statement's leading comment names it too, so it counts twice) and the sub-boards deleted, their webhooks with them by the key's cascade; each webhook and board schedule recorded `deleted` before."
	},
	'src/lib/server/deletes.ts#deleteBoard': { count: 1, why: "O6: the board deleted, its webhooks with it by the key's cascade (R4); recorded `deleted` by removeUnder before." },
	'src/routes/api/report-schedules/+server.ts#POST': { count: 1, why: 'O7: the schedule made; recorded `on` or `off`, and each address on it `added`, after it.' },
	'src/routes/api/report-schedules/[id]/+server.ts#writeChange': {
		count: 1,
		why: 'O8: `.set(updates)`, the fields that change; recorded on or off (3002-R12), and each address added or taken off, after it.'
	},
	'src/routes/api/report-schedules/[id]/+server.ts#DELETE': { count: 1, why: 'O9: the schedule deleted; recorded `deleted` just before, while it can be read.' },
	'src/lib/server/auth.ts#endAccountAccess': { count: 1, why: 'O10: the schedules of the account paused; each recorded `off` after, in one statement that always runs.' },
	'src/lib/server/backup.ts#saveBackupConfig': { count: 1, why: "O11: setSetting('backup_config'); each destination's place it removes, moves or adds recorded before and after." },
	'src/lib/server/backup.ts#setSetting': { count: 2, why: 'The definition: a setting by a key it is given (R4); its one caller, saveBackupConfig, records (O11).' },
	'src/lib/server/email.ts#saveSmtpConfig': {
		count: 7,
		why: "O12: every smtp_ setting by setSetting; the mail settings' place it moves recorded by its one caller, PUT /api/admin/smtp, before and after."
	},
	'src/lib/server/email.ts#setAppUrl': { count: 1, why: "O12: setSetting('app_url'); the App URL's place it moves recorded by its one caller, PUT /api/admin/smtp." },
	'src/lib/server/email.ts#setSetting': { count: 2, why: 'The definition: a setting by a key it is given (R4); its callers are listed with theirs.' },
	'src/lib/server/setting-setters.ts#removeSettingsSetBy': { count: 3, why: 'O13: the mail settings, the App URL and destinations an account set removed; each place removed recorded `removed`.' },
	'src/lib/server/setting-setters.ts#removeHeldSetting': { count: 3, why: 'O14: a setting held for review removed; its place recorded `removed`.' },
	'src/lib/server/deletes.ts#deleteUser': {
		count: 1,
		why: "O18 (R4): the account deleted, its report schedules with it by the key's cascade; each recorded `deleted` before, in one statement that always runs."
	},
	'scripts/mfa-reset.mjs#holdReadable': { count: 1, why: 'O17: the webhooks whose secret the account can read held; each recorded `held` by RECORD_WEBHOOKS_HELD_SQL, word for word, where the record is there.' },
	'scripts/mfa-reset.mjs#reset': {
		count: 2,
		why: 'O17: the webhooks held and the schedules paused, and the settings held; recorded `held`, `off` and `held` by the three statements, word for word, where the record is there (R8).'
	},

	// Records nothing (section 5).
	'src/lib/server/db/restore.ts#carryHolds': { count: 1, why: "Records nothing: the restore's carry of this server's holds onto the same webhooks; it applies the record." },
	'src/lib/server/db/restore.ts#holdUnsealedWebhooks': { count: 2, why: "Records nothing: the restore's hold of a backup whose seal did not verify (card 3012); it applies the record." },
	'src/lib/server/db/restore.ts#pauseUnsealedSchedules': { count: 1, why: "Records nothing: the restore's pause of a backup whose seal did not verify (card 3012)." },
	'src/lib/server/db/restore.ts#keepNotifyEmailHere': { count: 1, why: "Records nothing: `notifyEmail` alone of backup_config, not a destination (N3, its own card)." },
	'src/lib/server/db/restore.ts#restoredAccessEnder': { count: 1, why: "Records nothing: the restore's ending of restored access, a step of the restore; it applies the record." },
	'src/lib/server/db/restore.ts#applyPasswordRulings': { count: 1, why: "Records nothing: the restore's password rulings, a step of the restore." },
	'src/lib/server/db/restore.ts#applyOutboundSchedules': { count: 2, why: "Records nothing: the restore's application of the record to the schedules (plan 3.4)." },
	'src/lib/server/db/restore.ts#applyOutboundWebhooks': { count: 3, why: "Records nothing: the restore's application of the record to the webhooks (plan 3.4)." },
	'src/lib/server/db/restore.ts#switchOffOutside': { count: 5, why: 'Records nothing: a working copy switches every webhook, schedule and setting that reaches outside off; the restore applies the record.' },
	'src/lib/server/db/restore.ts#restoreInOneSnapshot': { count: 1, why: "Records nothing: whether mail was ever set up here, carried; it names no place." },
	'src/lib/server/backup-secrets.ts#clearSecrets': { count: 5, why: "Records nothing: a backup's copy, written as it is made; this server's own rows are not changed." },
	'src/lib/server/backup-secrets.ts#fillSecretGaps': { count: 5, why: "Records nothing: the restore's fill of the secrets a backup left out, a step of the restore." },
	'src/lib/server/backup-secrets.ts#fillAddressGaps': { count: 1, why: "Records nothing: the restore's fill of the addresses a backup left out, a step of the restore." },
	'src/lib/server/setting-setters.ts#removeFailureAddress': { count: 1, why: 'Records nothing: `notifyEmail` alone of backup_config, not a destination (N3, its own card).' },
	'src/lib/server/stored-secrets.ts#sealPlainSecrets': {
		count: 4,
		why: "Records nothing: the start's sealing of the mail password, each destination's secrets (:945) and settings by key (R4: setSetting with a key not written out) and webhooks, at the same places, sealed."
	},
	'src/lib/server/stored-secrets.ts#resealStoredSecrets': { count: 1, why: 'Records nothing: the same addresses sealed again under another key.' },
	'src/lib/server/stored-secrets.ts#forgetStoredSecrets': { count: 2, why: 'Records nothing: a webhook whose secret or address does not open switched off (N6, left).' },
	'src/lib/server/stored-secrets.ts#forgetSecretsBesideNoAddress': { count: 1, why: 'Records nothing: a secret beside no address forgotten, its webhook switched off; it sends nowhere.' },
	'src/lib/server/webhooks.ts#switchOffHeld': { count: 1, why: 'Records nothing: a hold derived from access, re-derived at every restore and start; a present hold is carried by identity.' },
	'src/lib/server/webhooks.ts#holdUnheldOfGoneSetters': { count: 1, why: 'Records nothing: a hold derived from accounts, re-derived at every restore and start.' },
	'src/lib/server/reports.ts#switchOffUndatable': { count: 1, why: "Records nothing: the scheduler's switch-off of a schedule it cannot date, re-derived before any send." },
	'src/lib/server/reports.ts#switchOffOverCap': { count: 1, why: "Records nothing: the scheduler's switch-off of a schedule over the cap, re-derived before any send." },
	'src/lib/server/reports.ts#pauseForDisabledOwner': { count: 1, why: "Records nothing: the scheduler's pause for a disabled owner, re-derived before any send." },
	'src/lib/server/startup-checks.ts#holdOutboundAtStart': { count: 5, why: "Records nothing: the start's and five-minute pass closes to what the record already says (plan 3.10)." },
	'src/lib/server/email.ts#recordMailEverConfigured': { count: 1, why: 'Records nothing: setSetting with a key not written out (R4), whether mail was ever set up; it names no place.' },
	'src/lib/server/known-browsers.ts#knownBrowserSecret': { count: 2, why: "Records nothing: the known-browser key's own setting, by a key it is given; never where the server sends." }
};

/**
 * Card 3004 (test gg): the functions that may call the record's writers, with how many calls: O1 to O18, and the
 * record's own helpers. The seed (O19) writes its own statements; the start pass and the restore's steps call none.
 */
const RECORD_OUTBOUND_CALLERS: Record<string, number> = {
	'src/routes/api/v1/boards/[boardId]/webhooks/+server.ts#POST': 1,
	'src/routes/api/v1/webhooks/[webhookId]/+server.ts#PUT': 1,
	'src/routes/api/v1/webhooks/[webhookId]/+server.ts#DELETE': 1,
	'src/lib/server/webhooks.ts#holdWebhooksOfSetter': 1,
	'src/lib/server/deletes.ts#removeUnder': 2,
	'src/lib/server/deletes.ts#deleteUser': 1,
	'src/routes/api/report-schedules/+server.ts#POST': 1,
	'src/routes/api/report-schedules/[id]/+server.ts#writeChange': 1,
	'src/routes/api/report-schedules/[id]/+server.ts#DELETE': 1,
	'src/lib/server/auth.ts#endAccountAccess': 1,
	'src/lib/server/backup.ts#saveBackupConfig': 1,
	'src/routes/api/admin/smtp/+server.ts#PUT': 1,
	'src/lib/server/setting-setters.ts#removeSettingsSetBy': 1,
	'src/lib/server/setting-setters.ts#removeHeldSetting': 1,
	'src/lib/server/setting-setters.ts#keepHeldSetting': 1,
	'src/lib/server/setting-setters.ts#holdSettingsSetBy': 1,
	// The record's own helpers, each in terms of recordOutboundChange.
	'src/lib/server/outbound-changes.ts#recordOutboundState': 1,
	'src/lib/server/outbound-changes.ts#recordPlacesMoved': 2,
	'src/lib/server/outbound-changes.ts#recordScheduleWritten': 3
};

/** The record's writers, by name: each call of one is pinned on RECORD_OUTBOUND_CALLERS. */
const OUTBOUND_RECORDERS = ['recordOutboundChange', 'recordOutboundState', 'recordWebhooksAs', 'recordSchedulesAs', 'recordSettingsHeldBy', 'recordPlacesMoved', 'recordScheduleWritten'];

/**
 * Card 3004 (test hh, R16 Q5): the only places that may INSERT INTO the record, a plain insert: outbound-changes.ts's
 * statements (the writers', the batch writers' and the seed's, constants at its top level), `CARRY_OUTBOUND_CHANGE_SQL`,
 * the union `carryRecord` runs for `carryOutboundChanges`, and the host's script's copies (O17, R8).
 */
const OUTBOUND_RECORD_INSERTERS = ['scripts/mfa-reset.mjs#(top level)', 'src/lib/server/db/restore.ts#(top level)', 'src/lib/server/outbound-changes.ts#(top level)'];

/** The settings that say where the server sends, as SQL names them: the backup settings, the mail settings and the App URL. */
const OUTBOUND_SETTING_KEY = /\b(?:backup_config|smtp_\w*|smtp\\*_|app_url)\b/;

/** A delete, an insert or a replace of a webhook or a report schedule; a delete or a replace of a board or an account (the cascades). */
const OUTBOUND_ROW_SQL_WRITE = new RegExp(
	String.raw`\b(DELETE${SQL_GAP}+FROM|INSERT(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+INTO|REPLACE${SQL_GAP}+INTO)${SQL_GAP}+(${sqlName('(?:webhooks|report_schedules)')})` +
		String.raw`|\b(DELETE${SQL_GAP}+FROM|REPLACE${SQL_GAP}+INTO|INSERT${SQL_GAP}+OR${SQL_GAP}+REPLACE${SQL_GAP}+INTO)${SQL_GAP}+(${sqlName('(?:boards|users)')})`,
	'gi'
);

/** An update of webhooks or report schedules, with what it sets. */
const OUTBOUND_SQL_UPDATE = new RegExp(
	String.raw`\bUPDATE(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+(${sqlName('(?:webhooks|report_schedules)')})${SQL_GAP}+SET\b([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|\bFROM\b|;|$)`,
	'gi'
);

/** The columns of each that say where it sends or whether it does, and their Drizzle fields. */
const OUTBOUND_COLUMNS: Record<string, string[]> = { webhooks: ['active', 'url'], report_schedules: ['enabled', 'recipients'] };
const OUTBOUND_FIELDS: Record<string, string[]> = { webhooks: ['active', 'url'], reportSchedules: ['enabled', 'recipients'] };

/** Any write of `settings`. */
const SETTINGS_SQL_WRITE = new RegExp(
	String.raw`\b(DELETE${SQL_GAP}+FROM|INSERT(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+INTO|REPLACE${SQL_GAP}+INTO|UPDATE(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?)${SQL_GAP}+${sqlName('settings')}`,
	'gi'
);

/** Anything written to the record but a plain INSERT (test hh): a delete, an update, a replace, an insert or ignore, a drop, an alter. */
const OUTBOUND_RECORD_SQL_WRITE = new RegExp(
	String.raw`\b(DELETE${SQL_GAP}+FROM|UPDATE(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?|REPLACE${SQL_GAP}+INTO|INSERT${SQL_GAP}+OR${SQL_GAP}+\w+${SQL_GAP}+INTO|DROP${SQL_GAP}+TABLE(?:${SQL_GAP}+IF${SQL_GAP}+EXISTS)?|ALTER${SQL_GAP}+TABLE)${SQL_GAP}+${sqlName('outbound_changes')}`,
	'gi'
);

/** A plain INSERT INTO the record. */
const OUTBOUND_RECORD_SQL_INSERT = new RegExp(String.raw`\bINSERT${SQL_GAP}+INTO${SQL_GAP}+${sqlName('outbound_changes')}`, 'gi');

/** An upsert into the record: `INSERT … INTO outbound_changes … ON CONFLICT`. */
const OUTBOUND_RECORD_SQL_UPSERT = new RegExp(
	String.raw`\bINSERT(?:${SQL_GAP}+OR${SQL_GAP}+\w+)?${SQL_GAP}+INTO${SQL_GAP}+${sqlName('outbound_changes')}[^;]*?\bON${SQL_GAP}+CONFLICT\b`,
	'gi'
);

/** What the outbound inventory found in one file (card 3004). */
type OutboundReading = { writes: string[]; recorders: string[]; inserts: string[]; seeded: string[]; texts: string[]; findings: string[] };

/**
 * Card 3004 (tests gg, hh) for one file under src or scripts, read as card 3002's rule reads (`scriptsOf`,
 * `writerNameOf`, `SQL_GAP`, every string built from literals read as SQL, a substitution as `\u0000`). Counted under
 * its `file#function`, and a finding where that is not on OUTBOUND_WRITES: every delete, insert or replace of
 * `webhooks` or `report_schedules`; every update of either that sets `active` or `url`, `enabled` or `recipients`, or
 * columns built at run time; every delete or replace of `boards` or `users` (the cascades); every write of `settings`
 * whose text names `backup_config`, an `smtp_` setting or `app_url`. In Drizzle the same, `.update` read by its `.set`
 * (one not written out here, as the webhook PUT's `updates`, is a write of every field), every `.insert`, `.update` or
 * `.delete` of `settings` (a key it is given), and every call of a `setSetting` whose key is one of those settings or
 * is not written out. Any write of `outbound_changes` but a plain INSERT, a plain INSERT outside
 * OUTBOUND_RECORD_INSERTERS, or a Drizzle write of `outboundChanges`, is a finding outright. Each call of a recorder is
 * listed by its `file#function`. Not seen: a setting's key bound as a parameter of SQL, a statement held in a variable
 * built elsewhere.
 */
function judgeOutboundWrites(file: string, source: string): OutboundReading {
	const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const tree = ts.createSourceFile(file, file.endsWith('.svelte') ? scriptsOf(source) : source, ts.ScriptTarget.Latest, true, kind);
	const at = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const keyOf = (node: ts.Node) => `${file}#${writerNameOf(node)}`;
	const reading: OutboundReading = { writes: [], recorders: [], inserts: [], seeded: [], texts: [], findings: [] };
	const write = (node: ts.Node, what: string) => {
		reading.writes.push(keyOf(node));
		if (!(keyOf(node) in OUTBOUND_WRITES)) {
			reading.findings.push(
				`${file}:${at(node)} ${what} in ${writerNameOf(node)}, which is not on OUTBOUND_WRITES: a change of where the server sends unrecorded comes back with the next restore (card 3004)`
			);
		}
	};
	const textOf = (node: ts.Expression): string => {
		const inner = bare(node);
		if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
		if (ts.isTemplateExpression(inner)) return inner.head.text + inner.templateSpans.map((span) => `\u0000${span.literal.text}`).join('');
		if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) return textOf(inner.left) + textOf(inner.right);
		return '\u0000';
	};
	const isText = (node: ts.Node): boolean =>
		ts.isStringLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node) ||
		ts.isTemplateExpression(node) ||
		(ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken);
	const inChain = (node: ts.Node): boolean => {
		let parent = node.parent;
		while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
		return !!parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
	};
	const named = (found: string) => found.replace(/["'`[\]]/g, '').split('.').pop()!.toLowerCase();

	const judgeSql = (node: ts.Node, text: string) => {
		if (/outbound_changes/i.test(text)) reading.texts.push(text);
		for (const found of text.matchAll(OUTBOUND_ROW_SQL_WRITE)) write(node, `${(found[1] ?? found[3]).replace(/\s+/g, ' ').toUpperCase()} ${named(found[2] ?? found[4])}`);
		for (const found of text.matchAll(OUTBOUND_SQL_UPDATE)) {
			const table = named(found[1]);
			const columns = found[2].split(',').map((part) => part.trim().split(/\s*=/)[0].replace(/["`[\]]/g, '').toLowerCase());
			const outbound = found[2].includes('\u0000') ? ['columns built at run time'] : columns.filter((column) => OUTBOUND_COLUMNS[table].includes(column));
			if (outbound.length > 0) write(node, `UPDATE ${table} (${outbound.join(', ')})`);
		}
		if (OUTBOUND_SETTING_KEY.test(text)) for (const found of text.matchAll(SETTINGS_SQL_WRITE)) write(node, `${found[1].replace(/\s+/g, ' ').toUpperCase()} settings`);
		for (const found of text.matchAll(OUTBOUND_RECORD_SQL_WRITE)) {
			reading.findings.push(`${file}:${at(node)} ${found[1].replace(/\s+/g, ' ').toUpperCase()} outbound_changes in ${writerNameOf(node)}: the record is append-only, written by a plain INSERT (card 3004)`);
		}
		for (const _found of text.matchAll(OUTBOUND_RECORD_SQL_UPSERT)) {
			reading.findings.push(`${file}:${at(node)} upserts into outbound_changes in ${writerNameOf(node)}: the record is append-only, written by a plain INSERT (card 3004)`);
		}
		for (const _found of text.matchAll(OUTBOUND_RECORD_SQL_INSERT)) {
			reading.inserts.push(keyOf(node));
			if (/'seeded'/.test(text)) reading.seeded.push(keyOf(node));
			if (!OUTBOUND_RECORD_INSERTERS.includes(keyOf(node))) {
				reading.findings.push(`${file}:${at(node)} INSERT INTO outbound_changes in ${writerNameOf(node)}: only the record's writers, its carry and the host's script write the record (card 3004)`);
			}
		}
	};

	const visit = (node: ts.Node): void => {
		if (isText(node) && !inChain(node)) {
			judgeSql(node, textOf(node as ts.Expression));
			if (ts.isBinaryExpression(node)) return;
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression.name.text;
			const [first] = node.arguments;
			const table = first !== undefined && ts.isIdentifier(bare(first)) ? (bare(first) as ts.Identifier).text : null;
			const writes = method === 'insert' || method === 'update' || method === 'delete';
			if (writes && (table === 'webhooks' || table === 'reportSchedules') && method !== 'update') write(node, `.${method}(${table})`);
			if (method === 'delete' && (table === 'boards' || table === 'users')) write(node, `.delete(${table})`);
			if (writes && table === 'settings') write(node, `.${method}(settings), a key it is given`);
			if (method === 'update' && (table === 'webhooks' || table === 'reportSchedules')) {
				const set = node.parent;
				const values = ts.isPropertyAccessExpression(set) && set.name.text === 'set' && ts.isCallExpression(set.parent) ? set.parent.arguments[0] : undefined;
				const fields =
					values !== undefined && ts.isObjectLiteralExpression(values)
						? values.properties.map((property) =>
								(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && ts.isIdentifier(property.name) ? property.name.text : null
							)
						: [null];
				const outbound = fields.filter((field) => field === null || OUTBOUND_FIELDS[table].includes(field)).map((field) => field ?? 'fields not written out here');
				if (outbound.length > 0) write(node, `.update(${table}) setting ${outbound.join(', ')}`);
			}
			if (writes && table === 'outboundChanges') {
				reading.findings.push(`${file}:${at(node)} .${method}(outboundChanges) in ${writerNameOf(node)}: the record is written by its writers and its carry alone (card 3004)`);
			}
		}
		if (ts.isCallExpression(node) && ts.isIdentifier(bare(node.expression))) {
			const callee = (bare(node.expression) as ts.Identifier).text;
			if (OUTBOUND_RECORDERS.includes(callee)) reading.recorders.push(keyOf(node));
			if (callee === 'setSetting') {
				const [first] = node.arguments;
				const key = first !== undefined && (ts.isStringLiteral(bare(first)) || ts.isNoSubstitutionTemplateLiteral(bare(first))) ? (bare(first) as ts.StringLiteral).text : null;
				if (key === null) write(node, 'setSetting with a key not written out');
				else if (OUTBOUND_SETTING_KEY.test(key)) write(node, `setSetting('${key}')`);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return reading;
}

describe('every write of where the server sends, and the record of it (card 3004, tests gg and hh)', () => {
	const walked = [...filesUnder('src', (path) => WEBHOOK_WALKED.test(path)), ...filesUnder('scripts', (path) => WEBHOOK_WALKED.test(path))].map((file) => ({
		file,
		source: readFileSync(join(ROOT, file), 'utf8')
	}));
	const readings = walked.map(({ file, source }) => judgeOutboundWrites(file, source));
	const counted = (pick: (reading: OutboundReading) => string[]) => {
		const counts: Record<string, number> = {};
		for (const reading of readings) for (const key of pick(reading)) counts[key] = (counts[key] ?? 0) + 1;
		return counts;
	};

	it('(gg) every write of a webhook, a report schedule, the backup, mail and App URL settings, and the named cascades, is on OUTBOUND_WRITES, each as many times as listed, with its reason', () => {
		expect(readings.flatMap(({ findings }) => findings)).toEqual([]);
		expect(walked.length).toBeGreaterThan(300);
		expect(counted((reading) => reading.writes)).toEqual(Object.fromEntries(Object.entries(OUTBOUND_WRITES).map(([key, { count }]) => [key, count])));
		for (const [key, { why }] of Object.entries(OUTBOUND_WRITES)) expect(why, key).not.toBe('');
		// Named explicitly (R4): the cascades, the variable-key setSetting, the field-by-field PUT.
		for (const key of [
			'src/lib/server/deletes.ts#removeUnder',
			'src/lib/server/deletes.ts#deleteUser',
			'src/lib/server/stored-secrets.ts#forgetStoredSecrets',
			'src/routes/api/v1/webhooks/[webhookId]/+server.ts#PUT'
		]) {
			expect(OUTBOUND_WRITES[key]?.why, key).toBeDefined();
		}
		// The "records nothing" table (section 5).
		for (const key of [
			'src/lib/server/db/restore.ts#applyOutboundWebhooks',
			'src/lib/server/db/restore.ts#applyOutboundSchedules',
			'src/lib/server/db/restore.ts#switchOffOutside',
			'src/lib/server/db/restore.ts#keepNotifyEmailHere',
			'src/lib/server/setting-setters.ts#removeFailureAddress',
			'src/lib/server/stored-secrets.ts#forgetStoredSecrets',
			'src/lib/server/startup-checks.ts#holdOutboundAtStart',
			'src/lib/server/stored-secrets.ts#sealPlainSecrets'
		]) {
			expect(OUTBOUND_WRITES[key]?.why, key).toMatch(/^Records nothing/);
		}
	});

	it('(gg) the record is written by exactly the writers O1 to O18, each as many times as listed; the start pass records nothing', () => {
		expect(counted((reading) => reading.recorders)).toEqual(RECORD_OUTBOUND_CALLERS);
	});

	it('(hh) the record is append-only: no DELETE, UPDATE, REPLACE or upsert of it; a plain INSERT only in its writers, its carry and the script; one INSERT of the marker, read only as itself; Reset and the restore keep it; the carry is bounded by MOST_OTHER_ROWS', () => {
		expect(readings.flatMap(({ findings }) => findings).filter((line) => line.includes('outbound_changes') || line.includes('outboundChanges'))).toEqual([]);
		expect([...new Set(readings.flatMap(({ inserts }) => inserts))].sort()).toEqual([...OUTBOUND_RECORD_INSERTERS].sort());
		expect(readings.flatMap(({ seeded }) => seeded)).toEqual(['src/lib/server/outbound-changes.ts#(top level)']);
		// The marker read only as kind seeded and origin here; never one of the rows after now, nor carried.
		const texts = readings.flatMap(({ texts }) => texts);
		const readsMarker = texts.filter((text) => /kind = 'seeded'/.test(text));
		expect(readsMarker.length).toBeGreaterThan(0);
		for (const text of readsMarker) expect(text).toMatch(/origin = 'here'/);
		expect(OUTBOUND_READS.futureHere).toMatch(/kind <> 'seeded'/);
		expect(restorableTables(sqlite)).not.toContain('outbound_changes');
		const reset = readFileSync(join(ROOT, 'src/routes/api/admin/reset/+server.ts'), 'utf8');
		expect(/const KEPT = \[[^\]]*'outbound_changes'[^\]]*\]/.test(reset)).toBe(true);
		const restore = readFileSync(join(ROOT, 'src/lib/server/db/restore.ts'), 'utf8');
		const restoreTree = ts.createSourceFile('restore.ts', restore, ts.ScriptTarget.Latest, true);
		const carry = restoreTree.statements.find(
			(statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'carryOutboundChanges'
		);
		expect(carry, 'carryOutboundChanges').toBeDefined();
		const carried = carry!.getText(restoreTree);
		expect(/\bMOST_OTHER_ROWS\b/.test(carried)).toBe(true);
		expect(/\bCARRY_OUTBOUND_CHANGE_SQL\b/.test(carried)).toBe(true);
		expect(carried).toContain("kind === 'seeded'");
	});

	describe('the rule itself', () => {
		const EXAMPLE = 'tests/helpers/fixtures.ts';
		/** `code` as line 4 of a made-up fixture, in `seed`. */
		const inSeed = (code: string) =>
			[
				"import { db, sqlite } from '$lib/server/db'; import { eq } from 'drizzle-orm';",
				"import { boards, outboundChanges, reportSchedules, settings, webhooks } from '$lib/server/db/schema';",
				'export function seed(id: number, updates: object) {',
				`\t${code}`,
				'}'
			].join('\n');
		const findingsOf = (code: string) => judgeOutboundWrites(EXAMPLE, inSeed(code)).findings;

		it.each([
			{ form: 'a webhook switched on in SQL', code: "sqlite.prepare('UPDATE webhooks SET active = 1 WHERE id = ?').run(id);" },
			{ form: 'a webhook re-pointed in Drizzle', code: "db.update(webhooks).set({ url: 'x' }).where(eq(webhooks.id, id)).run();" },
			{ form: 'a webhook written field by field', code: 'db.update(webhooks).set(updates).where(eq(webhooks.id, id)).run();' },
			{ form: 'a webhook deleted', code: 'db.delete(webhooks).where(eq(webhooks.id, id)).run();' },
			{ form: 'a schedule switched on in SQL', code: "sqlite.prepare('UPDATE report_schedules SET enabled = 1 WHERE id = ?').run(id);" },
			{ form: 'an address put on a schedule in Drizzle', code: "db.update(reportSchedules).set({ recipients: 'a@example.test' }).where(eq(reportSchedules.id, id)).run();" },
			{ form: 'a board deleted, its webhooks with it', code: "sqlite.prepare('DELETE FROM boards WHERE id = ?').run(id);" },
			{ form: 'an account deleted, its schedules with it', code: "sqlite.prepare('DELETE FROM users WHERE id = ?').run(id);" },
			{ form: 'the backup settings written in SQL', code: "sqlite.prepare(\"UPDATE settings SET value = ? WHERE key = 'backup_config'\").run('{}');" },
			{ form: 'the mail settings removed in SQL', code: "sqlite.prepare(\"DELETE FROM settings WHERE key LIKE 'smtp\\\\_%' ESCAPE '\\\\'\").run();" },
			{ form: 'a setting written in Drizzle', code: "db.insert(settings).values({ key: 'app_url', value: 'x' }).run();" },
			{ form: 'the App URL by setSetting', code: "setSetting('app_url', 'https://x.example.test');" },
			{ form: 'a setSetting of a key not written out', code: 'setSetting(String(id), "x");' },
			{ form: 'a DELETE FROM the record', code: "sqlite.prepare('DELETE FROM outbound_changes WHERE seq = ?').run(id);" },
			{ form: 'an UPDATE of the record', code: "sqlite.prepare(\"UPDATE outbound_changes SET state = 'on'\").run();" },
			{ form: 'a plain INSERT INTO the record outside its writers', code: "sqlite.prepare(\"INSERT INTO outbound_changes (kind) VALUES ('webhook')\").run();" },
			{ form: 'a Drizzle insert into the record', code: "db.insert(outboundChanges).values({ kind: 'webhook' }).run();" }
		])('(gg, hh) finds $form, on its line, in its function', ({ code }) => {
			const found = findingsOf(code);
			expect(found).toHaveLength(1);
			expect(found[0]).toMatch(/^tests\/helpers\/fixtures\.ts:4 .* in seed[:,]/);
		});

		it.each([
			{ form: 'a webhook renamed in its events', code: "sqlite.prepare('UPDATE webhooks SET events = ? WHERE id = ?').run('[]', id);" },
			{ form: 'a schedule renamed', code: "db.update(reportSchedules).set({ name: 'x' }).where(eq(reportSchedules.id, id)).run();" },
			{ form: 'a board renamed', code: "sqlite.prepare('UPDATE boards SET name = ? WHERE id = ?').run('x', id);" },
			{ form: 'another setting written in SQL', code: "sqlite.prepare(\"INSERT INTO settings (key, value) VALUES ('webhook_reveals_seeded', ?)\").run('x');" },
			{ form: 'another setting by setSetting', code: "setSetting('two_step_released_at', 'x');" },
			{ form: 'a read of the record', code: "sqlite.prepare(\"SELECT state FROM outbound_changes WHERE kind = 'webhook'\").get();" }
		])('(gg, hh) lets $form through', ({ code }) => {
			expect(findingsOf(code)).toEqual([]);
		});
	});
});
