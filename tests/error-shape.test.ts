/**
 * Every failure the API answers has one shape: JSON with a `message`.
 *
 * It used to have two. SvelteKit's `error(status, text)` answers `{ message }`,
 * and 49 answers written by hand as `json({ error: ... }, { status })` or as
 * `new Response(JSON.stringify({ error: ... }), ...)` answered `{ error }`, so
 * a caller had to know which route it was talking to before it could read why
 * it had been refused. All of them carry `message` now, and this test is what
 * keeps it so: there is no helper to call and nothing between a handler and
 * the wire.
 *
 * It reads the source, not the answers. Every `+server.ts` under
 * `src/routes/api`, `src/hooks.server.ts` and every file under
 * `src/lib/server` is parsed with the TypeScript compiler, and each place that
 * answers a failure is looked at:
 *
 *   - `json(...)`, `Response.json(...)`, `new Response(...)` and `text(...)`
 *     with a status of 400 or above. The body must be an object written out
 *     where the answer is made, with a `message` key and no `error` key. For
 *     `new Response` that object is looked for inside `JSON.stringify(...)`;
 *     a body that is plain text has no `message` and fails.
 *   - `error(status, ...)` from `@sveltejs/kit`. It must be given a text, or an
 *     object with a `message`.
 *
 * What it cannot read it does not pass. A status that is not written as a
 * number, a body that is a variable, a spread in a body: each fails, because
 * the answer it makes cannot be known from the source. The one status that is
 * not a number and is understood is `e.status` where `e` has just been found
 * to be one of the typed errors (`if (e instanceof CardMoveError) throw
 * error(e.status, e.message)`).
 *
 * A legitimate answer that cannot be written so that this test can read it
 * goes on `ALLOWED` below, by file and line and with the reason. The rule is
 * not loosened for it.
 *
 * It needs no database. `tests/setup.ts` still runs, as it does for every file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/**
 * Answers this test cannot classify and that are right as they are, as
 * `'path/from/the/repository/root.ts:line': 'why'`.
 *
 * Three entries. An entry that no longer matches a finding fails the test, so
 * that the list cannot outlive its reasons.
 */
const ALLOWED: Record<string, string> = {
	'src/lib/server/api-errors.ts:236':
		'jsonInPlaceOf: the JSON the gate puts in place of a failure that was not JSON. Its status is the ' +
		'status of the answer it replaces, which cannot be written as a number, and its body is { message } ' +
		'and nothing else. tests/gate.test.ts holds what it answers.',
	'src/lib/server/v1-json.ts:76':
		"json, the v1 API's own: SvelteKit's json given its caller's body and options, with each stored " +
		'timestamp in ISO 8601 (card 2095, plan R1). Each call of it is read where it is made, as a call of ' +
		"SvelteKit's json is: the import of it is read as one below.",
	'src/hooks.server.ts:394':
		'the 400 "Malformed URI" for an address that cannot be decoded, in plain text: what SvelteKit itself ' +
		'answered before it called the gate, up to 2.60, and which the gate now answers in its place, word for ' +
		'word, since SvelteKit 2.61 hands it such an address (card 2227). It is no route, under /api/ or not. ' +
		'tests/gate.test.ts holds what it answers.'
};

/**
 * Fewer than this many `error()` calls found means the parser is not seeing the tree.
 *
 * It was 600. Card 2117 moves each handler's refusals of its fields into the
 * readers of `src/lib/server/request-body.ts`, which answer all of them in a
 * few calls between them, so the count falls with each of its slices: 536
 * after the second, 496 after the third. 400 was below where card 2117 would
 * end, and far above what a parser that saw nothing would find. Card 2012
 * merges the two API trees' call sites into one service each, so the count
 * falls again (371 after its slice A3): 300.
 */
const LEAST_ERROR_CALLS = 300;
/** Likewise for `json(...)` answers that state a status. */
const LEAST_JSON_WITH_STATUS = 30;

type Finding = {
	/** `src/routes/api/labels/+server.ts:110`. */
	at: string;
	what: string;
};

type Found = {
	findings: Finding[];
	/** Calls of `error` as imported from `@sveltejs/kit`. */
	errorCalls: number;
	/** `json(...)` answers that state a status, of any value. */
	jsonWithStatus: number;
	/** Answers of 400 or above that are returned and not thrown. */
	returnedFailures: number;
};

/** The names of an object literal's keys, or null if one of them cannot be read. */
function keysOf(object: ts.ObjectLiteralExpression): string[] | null {
	const keys: string[] = [];
	for (const property of object.properties) {
		if (ts.isSpreadAssignment(property)) return null;
		const name = property.name;
		if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) keys.push(name.text);
		else return null;
	}
	return keys;
}

/** Is `node` inside the `then` of an `if (<name> instanceof Something)`? */
function knownToBeTypedError(node: ts.Node, name: string): boolean {
	for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
		if (!ts.isIfStatement(parent) || parent.thenStatement !== child) continue;
		const test = parent.expression;
		if (
			ts.isBinaryExpression(test) &&
			test.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
			ts.isIdentifier(test.left) &&
			test.left.text === name
		) {
			return true;
		}
	}
	return false;
}

/** Everything in one file that answers a failure in a shape other than `{ message }`. */
function check(file: string, source: string): Found {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const found: Found = { findings: [], errorCalls: 0, jsonWithStatus: 0, returnedFailures: 0 };

	// What this file calls `error`, `json` and `text` from @sveltejs/kit. A
	// file that does not import one of them has no such call: `error` is also
	// what a catch clause is often named. The `json` of `$lib/server/v1-json`,
	// which every v1 handler answers with (card 2095), is SvelteKit's given
	// the same body and options, and is read as it is.
	const kit = new Map<string, string>();
	for (const statement of tree.statements) {
		if (
			ts.isImportDeclaration(statement) &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			statement.importClause?.namedBindings &&
			ts.isNamedImports(statement.importClause.namedBindings)
		) {
			const from = statement.moduleSpecifier.text;
			for (const element of statement.importClause.namedBindings.elements) {
				const imported = (element.propertyName ?? element.name).text;
				if (from === '@sveltejs/kit' || (from === '$lib/server/v1-json' && imported === 'json')) {
					kit.set(element.name.text, imported);
				}
			}
		}
	}

	const report = (node: ts.Node, what: string) => {
		const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
		found.findings.push({ at: `${file}:${line}`, what });
	};

	/** An `error(status, body)` call. */
	const errorCall = (call: ts.CallExpression) => {
		found.errorCalls++;
		const [status, body] = call.arguments;

		const rethrown =
			status !== undefined &&
			ts.isPropertyAccessExpression(status) &&
			status.name.text === 'status' &&
			ts.isIdentifier(status.expression) &&
			knownToBeTypedError(call, status.expression.text);
		if (status === undefined || !(ts.isNumericLiteral(status) || rethrown)) {
			report(call, 'cannot be classified: the status of this error() is not a number, nor the status of a typed error');
		}

		if (body === undefined) {
			report(call, 'error(status) with no text answers "Error: <status>": say what went wrong');
		} else if (ts.isObjectLiteralExpression(body)) {
			const keys = keysOf(body);
			if (keys === null) report(call, 'cannot be classified: the object given to error() has a spread or a computed key');
			else if (!keys.includes('message')) report(call, 'error(status, { ... }) with an object that has no `message`');
			else if (keys.includes('error')) report(call, 'error(status, { ... }) with an `error` key: the text goes in `message`');
		}
	};

	/** An answer made by hand: `how` for the report, its body and its options. */
	const answer = (
		node: ts.Node,
		how: 'json' | 'Response.json' | 'new Response' | 'text',
		body: ts.Expression | undefined,
		init: ts.Expression | undefined
	) => {
		// No options, or options with no status, is a 200.
		if (init === undefined) return;
		if (!ts.isObjectLiteralExpression(init)) {
			report(node, `cannot be classified: the options of this ${how} are not written out here, so its status cannot be read`);
			return;
		}
		if (init.properties.some((p) => ts.isSpreadAssignment(p))) {
			report(node, `cannot be classified: the options of this ${how} have a spread, so its status cannot be read`);
			return;
		}
		const given = init.properties.find((p) => p.name !== undefined && p.name.getText(tree) === 'status');
		if (given === undefined) return;
		if (!ts.isPropertyAssignment(given) || !ts.isNumericLiteral(given.initializer)) {
			report(node, `cannot be classified: the status of this ${how} is not a number`);
			return;
		}
		if (how === 'json') found.jsonWithStatus++;
		const status = Number(given.initializer.text);
		if (status < 400) return;
		found.returnedFailures++;

		// `new Response(JSON.stringify({ ... }), ...)`: the object is one call in.
		let object = body;
		if (
			how === 'new Response' &&
			object !== undefined &&
			ts.isCallExpression(object) &&
			object.expression.getText(tree) === 'JSON.stringify'
		) {
			object = object.arguments[0];
		}
		if (how === 'text' || object === undefined || !ts.isObjectLiteralExpression(object)) {
			report(
				node,
				how === 'text' || (object !== undefined && ts.isStringLiteralLike(object))
					? `a ${status} answered as text, with no \`message\`: answer { message } as JSON`
					: `cannot be classified: the body of this ${status} is not an object written out here, so its keys cannot be read`
			);
			return;
		}
		const keys = keysOf(object);
		if (keys === null) {
			report(node, `cannot be classified: the body of this ${status} has a spread or a computed key`);
			return;
		}
		if (keys.includes('error')) report(node, `a ${status} whose body has an \`error\` key: the text goes in \`message\``);
		if (!keys.includes('message')) report(node, `a ${status} whose body has no \`message\` key`);
	};

	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node)) {
			const called = ts.isIdentifier(node.expression) ? kit.get(node.expression.text) : undefined;
			if (called === 'error') errorCall(node);
			else if (called === 'json' || called === 'text') answer(node, called, node.arguments[0], node.arguments[1]);
			else if (node.expression.getText(tree) === 'Response.json') {
				answer(node, 'Response.json', node.arguments[0], node.arguments[1]);
			}
		} else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Response') {
			answer(node, 'new Response', node.arguments?.[0], node.arguments?.[1]);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);

	return found;
}

/** Files under `dir` that `keep` says yes to, as paths from the repository root with forward slashes. */
function filesUnder(dir: string, keep: (path: string) => boolean): string[] {
	return (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
		.map((path) => `${dir}/${path.split('\\').join('/')}`)
		.filter(keep)
		.sort();
}

const FILES = [
	...filesUnder('src/routes/api', (path) => path.endsWith('/+server.ts')),
	'src/hooks.server.ts',
	...filesUnder('src/lib/server', (path) => path.endsWith('.ts'))
];

describe('every failure the API answers', () => {
	const total: Found = { findings: [], errorCalls: 0, jsonWithStatus: 0, returnedFailures: 0 };
	for (const file of FILES) {
		const found = check(file, readFileSync(join(ROOT, file), 'utf8'));
		total.findings.push(...found.findings);
		total.errorCalls += found.errorCalls;
		total.jsonWithStatus += found.jsonWithStatus;
		total.returnedFailures += found.returnedFailures;
	}

	it('is JSON with a `message` and no `error`, in every route file, the gate and the server library', () => {
		const faults = total.findings.filter((f) => !(f.at in ALLOWED)).map((f) => `${f.at} ${f.what}`);

		// Each line names the file and the line of the answer.
		expect(faults).toEqual([]);
	});

	it('has nothing on its allow-list that is no longer found', () => {
		const stillFound = new Set(total.findings.map((f) => f.at));

		expect(Object.keys(ALLOWED).filter((at) => !stillFound.has(at))).toEqual([]);
	});

	it('was looked for in the whole tree: a parser that found nothing would pass the test above', () => {
		// The files it is meant to read are there to be read.
		expect(FILES).toContain('src/routes/api/v1/cards/[cardId]/+server.ts');
		expect(FILES).toContain('src/routes/api/admin/import/+server.ts');
		expect(FILES).toContain('src/lib/server/route-guards.ts');
		expect(FILES).toContain('src/lib/server/db/transaction.ts');
		expect(FILES.length).toBeGreaterThanOrEqual(150);

		// 689 and 51 when this was written.
		expect(total.errorCalls).toBeGreaterThanOrEqual(LEAST_ERROR_CALLS);
		expect(total.jsonWithStatus).toBeGreaterThanOrEqual(LEAST_JSON_WITH_STATUS);
		// 17 when this was written: the gate's four, the import's seven, the four
		// rejected batches, the cycle and the log stream's 403 are returned and
		// not thrown. The gate's four cannot be thrown, so there are never fewer.
		expect(total.returnedFailures).toBeGreaterThanOrEqual(4);
	});
});

describe('the check itself', () => {
	const KIT = "import { json, text, error } from '@sveltejs/kit';\n";
	const whats = (code: string) => check('example.ts', KIT + code).findings.map((f) => f.what);

	// The shape this test was written to end: it is wrong twice over.
	it.each<[string, string]>([
		['json', "json({ error: 'No' }, { status: 400 });"],
		['json, beside other fields', "json({ error: 'No', written: 0 }, { status: 409 });"],
		[
			'new Response(JSON.stringify(...))',
			"new Response(JSON.stringify({ error: 'No' }), { status: 401, headers: { 'Content-Type': 'application/json' } });"
		],
		['Response.json', "Response.json({ error: 'No' }, { status: 500 });"]
	])('fails on a body with `error` and no `message`: %s', (_name, code) => {
		expect(whats(code)).toEqual([
			expect.stringMatching(/whose body has an `error` key/),
			expect.stringMatching(/whose body has no `message` key/)
		]);
	});

	it.each<[string, string, RegExp]>([
		['an `error` key beside a `message`', "json({ message: 'No', error: 'No' }, { status: 400 });", /has an `error` key/],
		['no `message`', "json({ reason: 'No' }, { status: 403 });", /has no `message` key/],
		['an array for a body', 'json([], { status: 401 });', /cannot be classified: the body of this 401/],
		['a failure answered as text', "new Response('Forbidden', { status: 403 });", /answered as text/],
		['a failure answered with text()', "text('Forbidden', { status: 403 });", /answered as text/],
		['a failure with no body', 'new Response(null, { status: 404 });', /cannot be classified: the body of this 404/],
		['error() with no text', 'throw error(404);', /error\(status\) with no text/],
		['error() with an object that has no message', "throw error(400, { code: 'bad' });", /has no `message`/],
		['error() with an `error` key', "throw error(400, { message: 'x', error: 'x' });", /with an `error` key/],
		['a status that is worked out', "json({ message: 'x' }, { status: ok ? 200 : 500 });", /status of this json is not a number/],
		['a status that is a variable', "json({ message: 'x' }, { status });", /status of this json is not a number/],
		['an error() status that is a variable', "throw error(code, 'x');", /status of this error\(\) is not a number/],
		[
			'an error() status read from something not known to be a typed error',
			"try { f(); } catch (e) { throw error(e.status, 'x'); }",
			/status of this error\(\) is not a number/
		],
		['a body that is a variable', 'json(body, { status: 409 });', /cannot be classified: the body of this 409/],
		['a spread in a body', "json({ message: 'x', ...rest }, { status: 409 });", /has a spread or a computed key/],
		['options that are a variable', "json({ message: 'x' }, init);", /options of this json are not written out/],
		['a spread in the options', "json({ message: 'x' }, { ...init });", /options of this json have a spread/]
	])('fails on %s', (_name, code, what) => {
		const found = whats(code);

		expect(found).toHaveLength(1);
		expect(found[0]).toMatch(what);
	});

	it('names the file and the line', () => {
		expect(check('src/routes/api/example/+server.ts', KIT + "\nexport const GET = () => {\n\tthrow error(404);\n};\n").findings).toEqual([
			{ at: 'src/routes/api/example/+server.ts:4', what: expect.stringContaining('error(status) with no text') }
		]);
	});

	it.each<[string, string]>([
		['a text', "throw error(404, 'Card not found');"],
		['a text built where it is thrown', 'throw error(400, `${field} must be an id`);'],
		['a text held in a variable', 'throw error(400, rejected.message);'],
		['an object with a message', "throw error(403, { message: 'No' });"],
		['an error() that is not thrown, which throws by itself', "error(404, 'Column not found');"],
		[
			'the status of a caught typed error',
			'try { f(); } catch (e) { if (e instanceof CardMoveError) throw error(e.status, e.message); throw e; }'
		],
		[
			'the status of a typed error handed to a function',
			'function handle(e: unknown): never { if (e instanceof TokenError) throw error(e.status, e.message); throw e; }'
		],
		[
			'a returned failure with a message and more',
			"json({ message: 'Rate limit exceeded', retryAfterSecs: 3 }, { status: 429, headers: { 'Retry-After': '3' } });"
		],
		['a message inside new Response(JSON.stringify(...))', "new Response(JSON.stringify({ message: 'No' }), { status: 400 });"],
		['a success that has a field called error', "json({ success: false, error: 'the last backup failed' });"],
		['a success with a status', 'json(created, { status: 201 });'],
		['a stream', "new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });"],
		['a file', "new Response(new Uint8Array(pdf), { status: 200, headers: { 'Content-Type': 'application/pdf' } });"]
	])('passes %s', (_name, code) => {
		expect(whats(code)).toEqual([]);
	});

	it('counts what it finds', () => {
		const found = check(
			'example.ts',
			KIT +
				"throw error(404, 'a'); error(400, 'b');\n" +
				"json({ message: 'c' }, { status: 409 }); json(row, { status: 201 }); json(rows);\n" +
				"new Response(JSON.stringify({ message: 'd' }), { status: 500 });\n" +
				"log.error('not an answer');\n"
		);

		expect(found).toEqual({ findings: [], errorCalls: 2, jsonWithStatus: 2, returnedFailures: 2 });
	});

	it('follows the name a file gives to error, and leaves alone an error that is not SvelteKit’s', () => {
		const renamed = check('example.ts', "import { error as refuse } from '@sveltejs/kit';\nthrow refuse(404);\n");
		expect(renamed.errorCalls).toBe(1);
		expect(renamed.findings).toHaveLength(1);

		// No import: `error` here is the file's own, as in a catch clause.
		const own = check('example.ts', 'const error = (n: number) => n;\nerror(404);\n');
		expect(own.errorCalls).toBe(0);
		expect(own.findings).toEqual([]);
	});
});
