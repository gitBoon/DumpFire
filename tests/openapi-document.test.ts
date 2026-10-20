/**
 * The OpenAPI document says what the handlers do.
 *
 * `src/routes/api/v1/openapi.json/+server.ts` is written by hand, and the
 * public `/docs` page is drawn from it. A review in October 2026 found it
 * wrong in 45 of its 57 operations: statuses a handler answers and the
 * document did not list, three answers described in a shape the handler has
 * never returned, query parameters that were read and not documented, and
 * schemas that had fallen behind the tables they describe. Every one of those
 * can be found by a machine, and this file is the machine.
 *
 * It reads the document as a caller is given it, through its own route, and
 * it reads the handlers as source, with the TypeScript compiler. For each
 * operation in the document it finds the handler, in the `+server.ts` the path
 * names, and works out from the source:
 *
 *   - every status it can answer: `error(N, ...)`, `json(..., { status: N })`
 *     and `new Response(..., { status: N })`, in the handler, in the functions
 *     of the same file that it calls, and in whatever it calls from `$lib`
 *     (the guards in `route-guards.ts` and the dependency refusals in
 *     `dependency-refusals.ts` above all), followed as far as they go;
 *   - for `error(e.status, ...)` under `if (e instanceof SomeError)`, every
 *     status that error is constructed with in the file that declares it;
 *   - whether it reads a body, and which query parameters it reads;
 *   - every text it can answer with: the string literals and the templates in
 *     the same functions, read with the literal arguments each is called with.
 *
 * and holds the document to that. The thirteen checks are the `it`s of the
 * first `describe`, each failing with one line for each operation it fails on.
 *
 * What a machine cannot find in the source is the shape of an answer, so a
 * later `describe` calls real routes and compares the top-level keys of each
 * answer with the schema the document gives for it. Every one of those calls
 * is also held to the `required` lists of the schema documented for the
 * status it was answered with, at every depth: see `api` below.
 *
 * The first nine checks are made of the operations the document has. The
 * tenth holds the document to the route tree: every `+server.ts` under
 * `src/routes/api/v1/` and every method it exports has an entry, and every
 * entry has a route and a method. The document describes itself, at
 * `GET /api/v1/openapi.json`, so that check has no list of exceptions.
 *
 * The last three were added for a caller who generates a client from the
 * document: a count of tokens is a 64-bit integer (11), every schema of an
 * answer says which of its properties are always there (12), and the text of
 * every example of a refusal is one its operation can answer (13).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, getTableColumns, type Table } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	activityLog,
	boardCategories,
	boards,
	cardComments,
	cards,
	categories,
	columns,
	labels,
	milestones,
	subtasks,
	tokenUsage,
	webhooks
} from '$lib/server/db/schema';
import { MAX_TOKENS_PER_ENTRY } from '$lib/server/tokens';
import { stamp } from '$lib/timestamps';
import { api as call, routeMethods, routePatterns, type ApiOptions, type ApiResult } from './helpers/api';
import {
	addBoardMember,
	assignCard,
	makeBoard,
	makeCard,
	makeComment,
	makeDependency,
	makeLabel,
	makeMilestone,
	makeSubtask,
	makeUser,
	resetDb
} from './helpers/fixtures';

const ROOT = process.cwd();
const KIT = '@sveltejs/kit';
/**
 * The v1 API's own `json` (card 2095, plan R1): SvelteKit's, given the same
 * body and options, with each stored timestamp in ISO 8601. A call of it is
 * read as a call of SvelteKit's `json` is, by the options written where it is
 * made.
 */
const V1_JSON = '$lib/server/v1-json';

/**
 * How many operations the document has.
 *
 * Written as a number so that a parser which finds none, or a document that
 * has lost some, fails. Adding operations to the document means changing it,
 * knowingly.
 */
const OPERATIONS = 81;

// ─── The document ────────────────────────────────────────────────────────────

/** The document is read as it is served, so it has no type here. */
type Json = any;

/** The document as a caller is given it. */
const spec: Json = (await call('GET', '/api/v1/openapi.json')).body;

/** What a `$ref` names, or undefined if it names nothing. */
function lookup(ref: string): Json {
	if (!ref.startsWith('#/')) return undefined;
	let at: Json = spec;
	for (const part of ref.slice(2).split('/')) {
		at = at?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
	}
	return at;
}

/** `node`, or what it refers to if it is a `$ref`. */
function deref(node: Json): Json {
	for (let hops = 0; node && typeof node.$ref === 'string'; hops++) {
		if (hops > 20) throw new Error(`$ref ${node.$ref} goes round in a circle`);
		node = lookup(node.$ref);
	}
	return node;
}

/** Every object and array in `node`, with the path that leads to it and the key it is under. */
function* everyNode(node: Json, path = '#', under = ''): Generator<{ node: Json; path: string; under: string }> {
	if (node === null || typeof node !== 'object') return;
	yield { node, path, under };
	for (const [key, value] of Object.entries(node)) yield* everyNode(value, `${path}/${key}`, key);
}

// ─── The handlers, as source ─────────────────────────────────────────────────

type Source = {
	tree: ts.SourceFile;
	/** What each imported name is called where it comes from, and where that is. */
	imports: Map<string, { module: string; name: string }>;
	/** The file's own functions: declarations, and constants that hold a function. */
	functions: Map<string, ts.Node>;
	/** The file's constants that hold a text written out (`const NO_EDIT = '…'`), by name (card 2012). */
	consts: Map<string, string>;
};

const sources = new Map<string, Source | null>();

/** The imports and the functions of one source file. */
function parse(file: string, text: string): Source {
	const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const imports: Source['imports'] = new Map();
	const functions: Source['functions'] = new Map();
	const consts: Source['consts'] = new Map();
	for (const statement of tree.statements) {
		if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) {
			for (const declared of statement.declarationList.declarations) {
				if (ts.isIdentifier(declared.name) && declared.initializer && ts.isStringLiteralLike(declared.initializer)) {
					consts.set(declared.name.text, declared.initializer.text);
				}
			}
		}
		if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
			const named = statement.importClause?.namedBindings;
			if (named && ts.isNamedImports(named)) {
				for (const element of named.elements) {
					imports.set(element.name.text, {
						module: statement.moduleSpecifier.text,
						name: (element.propertyName ?? element.name).text
					});
				}
			}
		} else if (ts.isFunctionDeclaration(statement) && statement.name) {
			functions.set(statement.name.text, statement);
		} else if (ts.isVariableStatement(statement)) {
			for (const declared of statement.declarationList.declarations) {
				const holds = declared.initializer;
				if (ts.isIdentifier(declared.name) && holds && (ts.isArrowFunction(holds) || ts.isFunctionExpression(holds))) {
					functions.set(declared.name.text, holds);
				}
			}
		}
	}
	return { tree, imports, functions, consts };
}

/** A source file, parsed once. `file` is a path from the repository root with forward slashes. */
function read(file: string): Source | null {
	if (!sources.has(file)) {
		sources.set(file, existsSync(join(ROOT, file)) ? parse(file, readFileSync(join(ROOT, file), 'utf8')) : null);
	}
	return sources.get(file) ?? null;
}

/** The file an import names, if it is one of the repository's own. */
function fileOf(from: string, module: string): string | null {
	let base: string;
	if (module.startsWith('$lib/')) base = `src/lib/${module.slice('$lib/'.length)}`;
	else if (module.startsWith('.')) base = posix.join(posix.dirname(from), module);
	else return null;
	return [`${base}.ts`, `${base}/index.ts`].find((candidate) => read(candidate) !== null) ?? null;
}

/**
 * The class `name` is known to be an instance of where `node` is: the
 * `SomeError` of an enclosing `if (name instanceof SomeError)`.
 */
function typedErrorAt(node: ts.Node, name: string): string | null {
	for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
		if (!ts.isIfStatement(parent) || parent.thenStatement !== child) continue;
		const test = parent.expression;
		if (
			ts.isBinaryExpression(test) &&
			test.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
			ts.isIdentifier(test.left) &&
			test.left.text === name &&
			ts.isIdentifier(test.right)
		) {
			return test.right.text;
		}
	}
	return null;
}

/**
 * Every status a typed error is made with: the numbers in `new SomeError(N,
 * ...)` throughout the file that declares it. `file` is where the name is
 * used. An error made from another's status (`new A(e.status, ...)` under
 * `e instanceof B`) has that one's too.
 */
function statusesOfTypedError(file: string, className: string, seen = new Set<string>()): Set<number> {
	const statuses = new Set<number>();
	const imported = read(file)?.imports.get(className);
	const home = imported ? fileOf(file, imported.module) : file;
	const declared = imported ? imported.name : className;
	const source = home ? read(home) : null;
	if (!home || !source || seen.has(`${home}#${declared}`)) return statuses;
	seen.add(`${home}#${declared}`);

	const visit = (node: ts.Node) => {
		if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === declared) {
			const status = node.arguments?.[0];
			if (status && ts.isNumericLiteral(status)) {
				statuses.add(Number(status.text));
			} else if (status && ts.isPropertyAccessExpression(status) && ts.isIdentifier(status.expression)) {
				const from = typedErrorAt(node, status.expression.text);
				if (from) for (const s of statusesOfTypedError(home, from, seen)) statuses.add(s);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source.tree);
	return statuses;
}

/** What one function can be seen to do, with everything it calls. */
type Reading = {
	/** Every status it can answer, successes included. */
	statuses: Set<number>;
	/** It calls `request.json()`. */
	readsBody: boolean;
	/** The names it gives to `url.searchParams.get(...)`. */
	query: Set<string>;
	/** What it does that cannot be read from the source, as `file:line what`. */
	unread: string[];
};

const readings = new Map<string, Reading>();

/**
 * Read the function `name` of `file`.
 *
 * A call of one of the file's own functions, or of a function imported from
 * the repository, is read in turn and counted as this function's. That is how
 * a status thrown by `requireCard` is known to be one of the handler's. It
 * errs towards more: a status the callee answers on a branch this caller can
 * never reach is counted too. A function that calls itself is read once.
 *
 * As `textsOf` does, it reads a function as called with what it was handed,
 * where that is written out (`known`), and leaves out a branch that rules
 * out: a shared service handed `{ source: 'api' }` and no `allowMove` is not
 * answering its move's statuses for that caller (card 2012).
 */
function reading(file: string, name: string, known: Known = {}): Reading {
	const key = `${file}#${name}#${JSON.stringify(Object.entries(known).sort())}`;
	const already = readings.get(key);
	if (already) return already;

	const found: Reading = { statuses: new Set(), readsBody: false, query: new Set(), unread: [] };
	readings.set(key, found);

	const source = read(file);
	const body = source?.functions.get(name);
	if (!source || !body) return found;

	const cannot = (node: ts.Node, what: string) => {
		const line = source.tree.getLineAndCharacterOfPosition(node.getStart(source.tree)).line + 1;
		found.unread.push(`${file}:${line} ${what}`);
	};
	const take = (other: Reading) => {
		for (const status of other.statuses) found.statuses.add(status);
		for (const param of other.query) found.query.add(param);
		found.readsBody ||= other.readsBody;
		found.unread.push(...other.unread);
	};
	const fromKit = (called: string) => {
		const imported = source.imports.get(called);
		if (imported?.module === V1_JSON && imported.name === 'json') return 'json';
		return imported?.module === KIT ? imported.name : null;
	};

	/** The status of `json(body, init)` or `new Response(body, init)`: 200 unless it says otherwise. */
	const answered = (node: ts.Node, init: ts.Expression | undefined) => {
		if (init === undefined) return void found.statuses.add(200);
		if (!ts.isObjectLiteralExpression(init) || init.properties.some((p) => ts.isSpreadAssignment(p))) {
			return cannot(node, 'answers with options that are not written out here, so its status cannot be read');
		}
		const given = init.properties.find((p) => p.name !== undefined && p.name.getText(source.tree) === 'status');
		if (given === undefined) return void found.statuses.add(200);
		if (!ts.isPropertyAssignment(given) || !ts.isNumericLiteral(given.initializer)) {
			return cannot(node, 'answers with a status that is not a number');
		}
		found.statuses.add(Number(given.initializer.text));
	};

	const visit = (node: ts.Node): void => {
		// A branch that what the function was called with rules out is not read.
		if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
			const [whenTrue, whenFalse] = ts.isIfStatement(node) ? [node.thenStatement, node.elseStatement] : [node.whenTrue, node.whenFalse];
			const [first, second] = branchesOf(node, known, source.consts);
			visit(ts.isIfStatement(node) ? node.expression : node.condition);
			if (first) visit(whenTrue);
			if (second && whenFalse) visit(whenFalse);
			return;
		}
		if (ts.isCallExpression(node)) {
			const called = node.expression;
			if (ts.isIdentifier(called)) {
				const imported = source.imports.get(called.text);
				if (fromKit(called.text) === 'error') {
					const status = node.arguments[0];
					if (status && ts.isNumericLiteral(status)) {
						found.statuses.add(Number(status.text));
					} else {
						const of =
							status && ts.isPropertyAccessExpression(status) && ts.isIdentifier(status.expression)
								? typedErrorAt(node, status.expression.text)
								: null;
						const statuses = of ? statusesOfTypedError(file, of) : new Set<number>();
						if (statuses.size === 0) cannot(node, 'error() with a status that is neither a number nor a typed error\'s');
						for (const s of statuses) found.statuses.add(s);
					}
				} else if (fromKit(called.text) === 'json') {
					answered(node, node.arguments[1]);
				} else if (source.functions.has(called.text)) {
					take(reading(file, called.text, calledWith(source.functions.get(called.text), node, known, source.consts)));
				} else if (imported) {
					const target = fileOf(file, imported.module);
					if (target) take(reading(target, imported.name, calledWith(read(target)?.functions.get(imported.name), node, known, source.consts)));
				}
			} else if (ts.isPropertyAccessExpression(called)) {
				if (called.name.text === 'json' && ts.isIdentifier(called.expression) && called.expression.text === 'request') {
					found.readsBody = true;
				}
				if (
					['get', 'getAll', 'has'].includes(called.name.text) &&
					ts.isPropertyAccessExpression(called.expression) &&
					called.expression.name.text === 'searchParams'
				) {
					const param = node.arguments[0];
					if (param && ts.isStringLiteralLike(param)) found.query.add(param.text);
					else cannot(node, 'reads a query parameter whose name is not written out here');
				}
			}
		} else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Response') {
			answered(node, node.arguments?.[1]);
		}
		ts.forEachChild(node, visit);
	};
	visit(body);
	return found;
}

/**
 * Operations whose query parameters are read somewhere the reading above
 * cannot follow, as `'METHOD /path': { where they are read, and why }`.
 *
 * One entry. An entry is not a pass: the names are read from the function it
 * points at, and compared with the document like any other.
 */
const QUERY_READ_ELSEWHERE: Record<string, { file: string; fn: string; params: string; why: string }> = {
	'GET /api/v1/burndown': {
		file: 'src/lib/server/burndown.ts',
		fn: 'parseBurndownQuery',
		params: 'params',
		why:
			'The handler hands url.searchParams whole to parseBurndownQuery, which reads most of them through its ' +
			'own helpers (idList(params, "boardIds"), dayParam(params, "from")). The name is then an argument of a ' +
			'helper and not of searchParams.get, so it is read here as: any text that follows `params` in a call, ' +
			'and any text given to params.get().'
	}
};

/**
 * Statuses the reading finds for an operation which that operation never
 * answers, as `'METHOD /path': { the statuses, and why not }`.
 *
 * `error(e.status, ...)` under `e instanceof SomeError` is read as every
 * status that error is made with anywhere in the file that declares it: the
 * reading does not follow which of them can reach the handler. One operation
 * is answered by a function that catches some of them on the way.
 *
 * One entry. An entry is not a pass. Check 4 fails if the reading no longer
 * finds a status listed here, because the entry has then outlived its reason,
 * and fails if the document lists one, because nothing answers it. And a test
 * at the end of this file calls the route and shows what is answered instead.
 */
const READ_AND_NEVER_ANSWERED: Record<string, { statuses: number[]; why: string }> = {
	'POST /api/v1/tokens/bulk': {
		statuses: [403, 404],
		why:
			'The handler turns a TokenError into error(e.status), and TokenError is made with 400, 403 and 404 in tokens.ts. ' +
			'The 403 and the 404 are made by resolveTarget, for an entry whose card or subtask does not exist or is on a ' +
			'board the caller cannot edit. recordTokenUsageBatch calls it inside a try for each entry and turns what it ' +
			'throws into a line of `problems`, so the batch is answered 409 with that entry listed. Only its three 400s, ' +
			'thrown before the entries are looked at, reach the handler.'
	}
};

/** The query parameter names `fn` reads from the URLSearchParams it calls `params`. */
function queryNamesReadBy(file: string, fn: string, params: string): Set<string> {
	const names = new Set<string>();
	const body = read(file)?.functions.get(fn);
	if (!body) return names;

	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node)) {
			const called = node.expression;
			const [first, second] = node.arguments;
			const onParams =
				ts.isPropertyAccessExpression(called) && ts.isIdentifier(called.expression) && called.expression.text === params;
			if (onParams && first && ts.isStringLiteralLike(first)) names.add(first.text);
			if (first && ts.isIdentifier(first) && first.text === params && second && ts.isStringLiteralLike(second)) {
				names.add(second.text);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(body);
	return names;
}

// ─── The texts a handler can answer with ─────────────────────────────────────

/**
 * An object literal a function was handed (card 2012: a service's options),
 * with each property it was written with: its literal, or null where the
 * value is not one. A property it was not written with is absent, and reads
 * as `undefined`.
 */
type KnownObject = { object: Record<string, string | boolean | null> };

/** What a function was called with, where that was written out: a parameter's name, and the literal or object literal given for it. */
type Known = Record<string, string | boolean | KnownObject>;

/**
 * What an expression is known to be, from what the function was called with
 * and its file's constants: `{ value }`, `undefined` among the values for a
 * property an object literal was not written with; null when it is not known.
 */
function valueOf(node: ts.Expression, known: Known, consts: ReadonlyMap<string, string>): { value: string | boolean | undefined | KnownObject } | null {
	if (ts.isParenthesizedExpression(node)) return valueOf(node.expression, known, consts);
	if (ts.isStringLiteralLike(node)) return { value: node.text };
	if (node.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
	if (node.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
	if (ts.isIdentifier(node)) {
		if (node.text in known) return { value: known[node.text] };
		return consts.has(node.text) ? { value: consts.get(node.text) } : null;
	}
	if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
		const held = known[node.expression.text];
		if (typeof held !== 'object') return null;
		if (!(node.name.text in held.object)) return { value: undefined };
		const value = held.object[node.name.text];
		return value === null ? null : { value };
	}
	if (ts.isObjectLiteralExpression(node)) {
		const object: KnownObject['object'] = {};
		for (const property of node.properties) {
			if (ts.isSpreadAssignment(property) || !property.name) return null;
			const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : null;
			if (key === null) return null;
			const given = ts.isPropertyAssignment(property)
				? valueOf(property.initializer, known, consts)
				: ts.isShorthandPropertyAssignment(property)
					? valueOf(property.name, known, consts)
					: null;
			const value = given?.value;
			object[key] = typeof value === 'string' || typeof value === 'boolean' ? value : null;
		}
		return { value: { object } };
	}
	return null;
}

/** What the function `target` is called with by `node`, as far as it is written out. */
function calledWith(target: ts.Node | undefined, node: ts.CallExpression, known: Known, consts: ReadonlyMap<string, string>): Known {
	const given: Known = {};
	const parameters = target && ts.isFunctionLike(target) ? target.parameters : [];
	for (let i = 0; i < parameters.length; i++) {
		const parameter = parameters[i];
		if (node.arguments.slice(0, i + 1).some((argument) => ts.isSpreadElement(argument))) break;
		if (!ts.isIdentifier(parameter.name)) continue;
		const value = i < node.arguments.length ? literalOf(node.arguments[i], known, consts) : literalOf(parameter.initializer, {});
		if (value !== undefined) given[parameter.name.text] = value;
	}
	return given;
}

/**
 * A branch that what the function was called with rules out, by the
 * condition of an `if` or a `?:`: `[read the first, read the second]`.
 */
function branchesOf(node: ts.IfStatement | ts.ConditionalExpression, known: Known, consts: ReadonlyMap<string, string>): [boolean, boolean] {
	const outcome = decided(ts.isIfStatement(node) ? node.expression : node.condition, known, consts);
	return [outcome !== false, outcome !== true];
}

/**
 * The texts a function can be seen to answer with, and everything it calls.
 *
 * `exact` holds its string literals. `built` holds each text that is put
 * together where it is written, a template or strings joined with `+`, as a
 * pattern in which a part worked out at run time may be anything.
 */
type Texts = { exact: Set<string>; built: Map<string, RegExp> };

const textReadings = new Map<string, Texts>();

/** What a part worked out at run time may be: anything, or nothing. */
const ANYTHING = '[\\s\\S]*';

/**
 * The fewest fixed characters a built text must have to be read as a message.
 * `${a} ${b}` would otherwise be a pattern that any two words satisfy.
 */
const FEWEST_FIXED = 8;

/** `text` as the source of a pattern that matches it and nothing else. */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A text put together where it is written: the source of its pattern, and the
 * characters of it that are fixed. Null if `node` is not text at all.
 */
function builtText(node: ts.Expression): { source: string; fixed: string } | null {
	if (ts.isParenthesizedExpression(node)) return builtText(node.expression);
	if (ts.isStringLiteralLike(node)) return { source: literally(node.text), fixed: node.text };
	if (ts.isTemplateExpression(node)) {
		let source = literally(node.head.text);
		let fixed = node.head.text;
		for (const span of node.templateSpans) {
			source += ANYTHING + literally(span.literal.text);
			fixed += span.literal.text;
		}
		return { source, fixed };
	}
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const left = builtText(node.left);
		const right = builtText(node.right);
		if (!left && !right) return null;
		return { source: (left?.source ?? ANYTHING) + (right?.source ?? ANYTHING), fixed: (left?.fixed ?? '') + (right?.fixed ?? '') };
	}
	return null;
}

/**
 * Whether a condition is true, where that follows from what the function was
 * called with: `need === 'edit'` when `need` is known to be 'view', a bare
 * `forEdit` or `!forEdit`, and `&&` and `||` of those. And of the object a
 * function was handed (card 2012): `opts.allowMove`, false where the object
 * was written without it, and `opts.source === 'api'`. Undefined when it does
 * not follow, which is nearly always.
 */
function decided(test: ts.Expression, known: Known, consts: ReadonlyMap<string, string> = new Map()): boolean | undefined {
	if (ts.isParenthesizedExpression(test)) return decided(test.expression, known, consts);
	if (ts.isIdentifier(test) || ts.isPropertyAccessExpression(test)) {
		const held = valueOf(test, known, consts);
		if (held === null) return undefined;
		return typeof held.value === 'object' ? true : Boolean(held.value);
	}
	if (ts.isPrefixUnaryExpression(test) && test.operator === ts.SyntaxKind.ExclamationToken) {
		const value = decided(test.operand, known, consts);
		return value === undefined ? undefined : !value;
	}
	if (!ts.isBinaryExpression(test)) return undefined;

	const operator = test.operatorToken.kind;
	if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
		const settles = operator === ts.SyntaxKind.BarBarToken;
		const left = decided(test.left, known, consts);
		const right = decided(test.right, known, consts);
		if (left === settles || right === settles) return settles;
		return left === undefined || right === undefined ? undefined : !settles;
	}
	if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
		const left = valueOf(test.left, known, consts);
		const right = valueOf(test.right, known, consts);
		if (left !== null && right !== null && typeof left.value !== 'object' && typeof right.value !== 'object') {
			return (left.value === right.value) === (operator === ts.SyntaxKind.EqualsEqualsEqualsToken);
		}
	}
	return undefined;
}

/**
 * The literal an expression is, if it is a string or `true` or `false`
 * written out, a name known to be one or a constant of the file holding one,
 * a property of an object known to hold one, or an object literal.
 */
function literalOf(node: ts.Expression | undefined, known: Known, consts: ReadonlyMap<string, string> = new Map()): string | boolean | KnownObject | undefined {
	if (!node) return undefined;
	return valueOf(node, known, consts)?.value;
}

/**
 * Read the texts of the function `name` of `file`, called with `known`.
 *
 * It follows what `reading` follows: the file's own functions and the
 * functions imported from the repository. Where a call gives a parameter a
 * literal, or leaves out one whose default is a literal, the function is read
 * as called with it, and a branch its condition rules out is not read. That is
 * how `requireBoard(user, id, 'view')` is known to answer "No access to this
 * board" and never "No edit access to this board", which is in the same line.
 *
 * It errs towards more, as `reading` does: a text on a branch the caller can
 * never reach for a reason this cannot see is counted. And it reads every
 * string of a function, not only the ones given to `error()`: a refusal's
 * text is often made in one function and thrown by another. A parameter is
 * taken to keep the value it was called with.
 *
 * With `within`, a call is followed only into those files.
 */
function textsOf(file: string, name: string, known: Known = {}, within?: readonly string[]): Texts {
	const key = `${file}#${name}#${JSON.stringify(Object.entries(known).sort())}#${within?.join() ?? ''}`;
	const seen = textReadings.get(key);
	if (seen) return seen;

	const found: Texts = { exact: new Set(), built: new Map() };
	textReadings.set(key, found);

	const source = read(file);
	const body = source?.functions.get(name);
	if (!source || !body) return found;

	const take = (other: Texts) => {
		for (const text of other.exact) found.exact.add(text);
		for (const [pattern, matcher] of other.built) found.built.set(pattern, matcher);
	};

	const visit = (node: ts.Node): void => {
		// A branch that what the function was called with rules out is not read.
		if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
			const test = ts.isIfStatement(node) ? node.expression : node.condition;
			const [whenTrue, whenFalse] = ts.isIfStatement(node) ? [node.thenStatement, node.elseStatement] : [node.whenTrue, node.whenFalse];
			const [first, second] = branchesOf(node, known, source.consts);
			visit(test);
			if (first) visit(whenTrue);
			if (second && whenFalse) visit(whenFalse);
			return;
		}

		// `a ?? b` with `a` known to be a text: `b` is never what it answers (card 2012, a tree's `says`).
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
			const left = valueOf(node.left, known, source.consts);
			visit(node.left);
			if (left === null || left.value === undefined) visit(node.right);
			return;
		}

		// A constant of the file that holds a text, used here: its text (card 2012).
		if (ts.isIdentifier(node) && source.consts.has(node.text) && !(node.text in known)) {
			const parent = node.parent;
			const declared = (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) && parent.name === node;
			const property = ts.isPropertyAccessExpression(parent) && parent.name === node;
			if (!declared && !property) found.exact.add(source.consts.get(node.text)!);
		}

		// A text put together here is read whole, and not as its pieces.
		if (ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
			const built = builtText(node);
			if (built) {
				if (built.fixed.trim().length >= FEWEST_FIXED) found.built.set(built.source, new RegExp(`^${built.source}$`));
				const pieces = (piece: ts.Expression): void => {
					if (ts.isParenthesizedExpression(piece)) return pieces(piece.expression);
					if (ts.isBinaryExpression(piece) && piece.operatorToken.kind === ts.SyntaxKind.PlusToken) {
						pieces(piece.left);
						pieces(piece.right);
					} else if (ts.isTemplateExpression(piece)) {
						for (const span of piece.templateSpans) visit(span.expression);
					} else if (!ts.isStringLiteralLike(piece)) {
						visit(piece);
					}
				};
				pieces(node);
				return;
			}
		}

		if (ts.isStringLiteralLike(node)) found.exact.add(node.text);

		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
			const called = node.expression.text;
			const imported = source.imports.get(called);
			if (source.functions.has(called)) {
				take(textsOf(file, called, calledWith(source.functions.get(called), node, known, source.consts), within));
			} else if (imported) {
				const target = fileOf(file, imported.module);
				if (target && (!within || within.includes(target))) {
					take(textsOf(target, imported.name, calledWith(read(target)?.functions.get(imported.name), node, known, source.consts), within));
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(body);
	return found;
}

/** Whether `message` is one of `texts`: a literal of it, or a text one of its patterns makes. */
const isOneOf = (texts: Texts, message: string) => texts.exact.has(message) || [...texts.built.values()].some((pattern) => pattern.test(message));

/**
 * The gate: `src/hooks.server.ts`, and the functions of `api-errors.ts` it
 * answers with. What they answer is not in any handler.
 */
const GATE = ['src/hooks.server.ts', 'src/lib/server/api-errors.ts'] as const;

/** Every text the gate can answer with: the strings of its two files, and of nothing they call elsewhere. */
function gateTexts(): Texts {
	const all: Texts = { exact: new Set(), built: new Map() };
	for (const file of GATE) {
		for (const name of read(file)?.functions.keys() ?? []) {
			const texts = textsOf(file, name, {}, GATE);
			for (const text of texts.exact) all.exact.add(text);
			for (const [pattern, matcher] of texts.built) all.built.set(pattern, matcher);
		}
	}
	return all;
}

/**
 * Examples of a refusal whose text is in no source file as it is answered,
 * because it is put together at run time from pieces this file cannot join, as
 * `'METHOD /path status'`: the text, and why it cannot be read.
 *
 * Empty. Every example the document has is a literal or a template of its
 * handler, and the reading above finds each. An entry is not a pass for the
 * operation: check 13 fails on one whose text the reading does find, or which
 * names an example the document no longer has, because it has then outlived
 * its reason.
 */
const BUILT_AT_RUN_TIME: Record<string, { message: string; why: string }> = {};

// ─── The operations ──────────────────────────────────────────────────────────

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

type Operation = {
	/** `PUT /api/v1/cards/{cardId}/move`: what a failure is named by. */
	name: string;
	method: string;
	path: string;
	/** The document's entry. */
	entry: Json;
	/** The route file the path names. */
	file: string;
	/** What its handler can be seen to do, or null if the file has no such handler. */
	handler: Reading | null;
};

const OPS: Operation[] = [];
for (const [path, item] of Object.entries<Json>(spec.paths ?? {})) {
	for (const method of METHODS) {
		if (!item[method]) continue;
		const file = `src/routes${path.replace(/\{(\w+)\}/g, '[$1]')}/+server.ts`;
		const exported = method.toUpperCase();
		OPS.push({
			name: `${exported} ${path}`,
			method,
			path,
			entry: item[method],
			file,
			handler: read(file)?.functions.has(exported) ? reading(file, exported) : null
		});
	}
}

/** An operation that says it needs no key: `security: []`. The gate asks it for none and does not count it. */
const isPublic = (op: Operation) => Array.isArray(op.entry.security) && op.entry.security.length === 0;

/** The statuses an operation documents, as numbers. */
const documented = (op: Operation) => Object.keys(op.entry.responses ?? {}).map(Number);

/**
 * What can be answered for an operation without its handler saying so: by the
 * gate in `hooks.server.ts`, by SvelteKit reading the body, and by anything
 * that goes wrong.
 */
function answeredAroundTheHandler(op: Operation): Set<number> {
	// 500: any handler can fail.
	const statuses = new Set([500]);
	// 401 and 429: the key check and the rate limit, for everything that needs a key.
	if (!isPublic(op)) for (const s of [401, 429]) statuses.add(s);
	// 400 and 413: a body that is missing, is not JSON or is not an object, and a body over the size limit.
	if (op.handler?.readsBody) for (const s of [400, 413]) statuses.add(s);
	return statuses;
}

/** The query parameter names an operation's handler reads. */
function queryNamesRead(op: Operation): Set<string> {
	const names = new Set(op.handler?.query ?? []);
	const elsewhere = QUERY_READ_ELSEWHERE[op.name];
	if (elsewhere) for (const n of queryNamesReadBy(elsewhere.file, elsewhere.fn, elsewhere.params)) names.add(n);
	return names;
}

const sorted = <T>(values: Iterable<T>) => [...values].sort();

// ─── What every answer always has ────────────────────────────────────────────

/** Whether a schema describes an object with named properties. */
const hasProperties = (schema: Json) =>
	schema !== null && typeof schema === 'object' && !Array.isArray(schema) && schema.properties !== null && typeof schema.properties === 'object';

/**
 * Every schema that describes an object in an answer, with a name to fail by:
 * the component schemas, and the schemas written into an operation's
 * responses, each with the objects inside it. `Card.subtasks[]` is the items
 * of the `subtasks` property of `Card`.
 *
 * A request body is not an answer and is not among them: its `required` is
 * what the handler refuses to go without, and may be nothing.
 */
function answerObjects(): { where: string; schema: Json }[] {
	const found: { where: string; schema: Json }[] = [];
	const walk = (schema: Json, where: string) => {
		if (schema === null || typeof schema !== 'object' || typeof schema.$ref === 'string') return;
		if (hasProperties(schema)) {
			found.push({ where, schema });
			for (const [key, property] of Object.entries<Json>(schema.properties)) walk(property, `${where}.${key}`);
		}
		if (schema.items) walk(schema.items, `${where}[]`);
		if (schema.additionalProperties && typeof schema.additionalProperties === 'object') walk(schema.additionalProperties, `${where}{}`);
	};
	for (const [name, schema] of Object.entries<Json>(spec.components?.schemas ?? {})) walk(schema, name);
	for (const op of OPS) {
		for (const [status, response] of Object.entries<Json>(op.entry.responses ?? {})) {
			if (typeof response?.$ref === 'string') continue;
			for (const media of Object.values<Json>(response?.content ?? {})) walk(media?.schema, `${op.name} ${status}`);
		}
	}
	return found;
}

/**
 * The properties an answer does not always have, as the name `answerObjects`
 * gives the schema: each property, and when it is left out. Every other
 * property of every schema of an answer is in its `required`, and check 12
 * holds the document to exactly that: a property is required or it is here.
 *
 * The schemas that mirror a table say the same in `MIRRORS`, as
 * `sometimesAbsent`.
 */
const SOMETIMES_ABSENT: Record<string, Record<string, string>> = {
	CardDependencies: {
		blockedBy: 'GET /cards/{cardId}/dependencies leaves it out with direction=blocks',
		blocks: 'and this one with direction=blocked-by'
	},
	DependencyConflict: { cycle: 'cycleAnswer sends it for a link that would close a loop; a link already recorded is the message alone' },
	'DependencyBatchRejected.rejected[]': { cycle: 'validateDependencyBatch sets it only when the reason is cycle' },
	PlanNode: {
		parentCardId: 'loadPlanNodes sets it on a subtask and not on a card, and withhold leaves it off a subtask on a board the caller cannot open'
	},
	MilestoneNode: { parentCardId: 'the same node, with its place in the plan' },
	MilestoneSummary: {
		graph: 'GET /milestones/{milestoneId}/summary leaves it out with compact=true',
		cardTitles: 'and sends this one only then',
		subtaskTitles: 'and this one'
	},
	ActivityReportCard: { comments: 'buildActivityReport attaches it only with include=comments' },
	'ActivityReportCard.subtasks': { items: 'only with include=subtasks, and only on a card that has subtasks' },
	BurndownResult: { options: 'getBurndown attaches it only with options=true' }
};

/**
 * What `value` lacks of what `schema` says an answer always has, at every
 * depth: one line for each property in a `required` that is not there. A null
 * where the schema allows one has nothing to lack.
 */
function missingRequired(schema: Json, value: Json, where: string): string[] {
	schema = deref(schema);
	if (!schema || value === null || typeof value !== 'object') return [];
	if (Array.isArray(value)) {
		return schema.items ? value.flatMap((item, i) => missingRequired(schema.items, item, `${where}[${i}]`)) : [];
	}
	const missing: string[] = [];
	for (const key of schema.required ?? []) {
		if (!(key in value)) missing.push(`${where}: has no \`${key}\`, which its schema says is always there`);
	}
	for (const [key, property] of Object.entries<Json>(schema.properties ?? {})) {
		if (key in value) missing.push(...missingRequired(property, value[key], `${where}.${key}`));
	}
	return missing;
}

/**
 * What `value` has that `schema` does not document, at every depth: one line
 * for each property of an object that its schema's `properties` does not list
 * (card 2254). An array's items are held to `items`. A key not listed passes
 * only where the schema says the object is a map: `additionalProperties: true`
 * lets any value through, and a schema there holds each value to itself. An
 * object schema with neither lists nothing, so every key it is given is named:
 * a field the document leaves out is one a caller cannot know about.
 */
function undocumentedProperties(schema: Json, value: Json, where: string): string[] {
	schema = deref(schema);
	if (!schema || value === null || typeof value !== 'object') return [];
	if (Array.isArray(value)) {
		return schema.items ? value.flatMap((item, i) => undocumentedProperties(schema.items, item, `${where}[${i}]`)) : [];
	}
	const types: string[] = [schema.type ?? []].flat();
	if (!types.includes('object') && !schema.properties && schema.additionalProperties === undefined) {
		// A schema of another type describes nothing in an object; one with no type is not looked at.
		return types.length ? [`${where}: is an object, which its schema does not describe`] : [];
	}
	const found: string[] = [];
	for (const [key, item] of Object.entries<Json>(value)) {
		const property = schema.properties?.[key];
		if (property) found.push(...undocumentedProperties(property, item, `${where}.${key}`));
		else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
			found.push(...undocumentedProperties(schema.additionalProperties, item, `${where}.${key}`));
		} else if (schema.additionalProperties !== true) found.push(`${where}: has \`${key}\`, which its schema does not list`);
	}
	return found;
}

/**
 * Where `value` is not of the type its schema gives, at every depth: one line
 * for each value whose JSON type is not among the schema's `type`, or that is
 * not in its `enum`. An integer is a number too. A property the schema does not
 * name is not looked at: `undocumentedProperties` is for that.
 */
function typeFaults(schema: Json, value: Json, where: string): string[] {
	schema = deref(schema);
	if (!schema) return [];
	const actual =
		value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
	const types: string[] = [schema.type ?? []].flat();
	const faults: string[] = [];
	if (types.length > 0 && !types.includes(actual) && !(actual === 'integer' && types.includes('number'))) {
		faults.push(`${where}: ${JSON.stringify(value)} is not ${types.join(' or ')}`);
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		faults.push(`${where}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
	}
	if (actual === 'array' && schema.items) {
		value.forEach((item: Json, i: number) => faults.push(...typeFaults(schema.items, item, `${where}[${i}]`)));
	}
	if (actual === 'object') {
		for (const [key, item] of Object.entries<Json>(value)) {
			const property = schema.properties?.[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
			if (property) faults.push(...typeFaults(property, item, `${where}.${key}`));
		}
	}
	return faults;
}

/** The operation a request is for: the one whose path it fits with the most fixed segments. */
function operationFor(method: string, pathname: string): Operation | undefined {
	const parts = pathname.split('/');
	let best: { op: Operation; fixed: number } | undefined;
	for (const op of OPS) {
		if (op.method.toUpperCase() !== method) continue;
		const segments = op.path.split('/');
		if (segments.length !== parts.length) continue;
		if (!segments.every((segment, i) => segment.startsWith('{') || segment === parts[i])) continue;
		const fixed = segments.filter((segment) => !segment.startsWith('{')).length;
		if (!best || fixed > best.fixed) best = { op, fixed };
	}
	return best?.op;
}

/** The operations whose answers were held to their `required`, and how many answers in all. */
const heldToRequired = { operations: new Set<string>(), answers: 0 };

/**
 * Call a route, as `./helpers/api` does, and hold the answer to the document.
 *
 * Whatever a test below asks of an answer, this asks first: every property
 * that the schema documented for this operation and this status lists in a
 * `required`, at every depth, is in the answer; and the answer has no property
 * the schema does not list (card 2254). It fails the test that made the call,
 * naming each property that is not there or not documented. An answer whose status the
 * document has no JSON schema for is passed on as it is: the PDF, above all.
 */
async function api(method: Parameters<typeof call>[0], path: string, opts: ApiOptions = {}): Promise<ApiResult> {
	const res = await call(method, path, opts);
	const op = operationFor(method, new URL(path, 'http://localhost').pathname);
	const schema = deref(op?.entry.responses?.[res.status])?.content?.['application/json']?.schema;
	if (op && schema) {
		heldToRequired.operations.add(op.name);
		heldToRequired.answers++;
		expect(missingRequired(schema, res.body, `${op.name} ${res.status}`)).toEqual([]);
		expect(undocumentedProperties(schema, res.body, `${op.name} ${res.status}`)).toEqual([]);
	}
	return res;
}

// ─── Schemas that mirror a table ─────────────────────────────────────────────

/**
 * Each schema here describes a row of a table as the API answers it. Its
 * property names must be the table's columns, give or take what is listed:
 * `adds` is what the API puts beside the row, `withholds` is a column it does
 * not send. Each with the reason, and with the handler that does it.
 *
 * A column added to a table fails this until the schema has it or this list
 * says why not, which is how `Card` came to lack eighteen of them.
 *
 * Each property that is a column must also have the column's type: `integer`
 * for an integer column, `number` for a real one, `boolean`, `string`, and
 * `null` beside it exactly when the column may hold one. `retyped` lists a
 * column the API answers as something else, with the reason.
 *
 * And its `required` must be every one of its properties: a row is answered
 * whole, a column that holds null as a null. `sometimesAbsent` lists a
 * property an answer can lack altogether, with the reason.
 */
type Mirror = {
	table: Table;
	adds?: Record<string, string>;
	withholds?: Record<string, string>;
	retyped?: Record<string, string>;
	sometimesAbsent?: Record<string, string>;
};

const MIRRORS: Record<string, Mirror> = {
	Board: { table: boards },
	BoardDetail: {
		table: boards,
		adds: { columns: 'GET /boards/{boardId} and POST /boards answer the board with its columns' }
	},
	Column: { table: columns },
	Card: { table: cards },
	CardListItem: {
		table: cards,
		adds: {
			columnTitle: 'GET /boards/{boardId}/cards names the column each card is in',
			subtaskCount: 'and counts its subtasks, so that a report need not fetch every card',
			subtaskCompleted: 'and how many of them are done'
		}
	},
	MovedCard: {
		table: cards,
		adds: {
			columnTitle: 'PUT /cards/{cardId}/move names the column the card is now in',
			boardId: 'and the board, which is another board after a move across boards',
			leftMilestone: 'and the milestone of the board it left that a move across boards took it out of (card 2155, the review\'s O3)'
		}
	},
	CardDetail: {
		table: cards,
		adds: {
			boardId: 'GET /cards/{cardId} says which board the card is on',
			columnTitle: 'and names its column',
			subtasks: 'with its subtasks',
			labelIds: 'the ids of its labels',
			assignees: 'who it is assigned to',
			isBlocked: 'whether anything it waits on is unfinished',
			blockedBy: 'what it waits on',
			blocks: 'and what waits on it'
		}
	},
	Subtask: { table: subtasks },
	Label: { table: labels },
	Category: { table: categories },
	BoardCategory: { table: boardCategories },
	Comment: {
		table: cardComments,
		adds: {
			username: 'every comment answer names its author',
			userEmoji: 'and carries their emoji'
		}
	},
	Webhook: {
		table: webhooks,
		// `secret` and `url` are columns and are in the schema: each is sent to the
		// board's owner, to an administrator, and to whoever has just created the webhook.
		adds: {
			hasSecret: 'presentWebhook says whether a secret is set, to callers it does not show the secret to',
			lastDelivery: 'presentWebhook gives what the last delivery came to, held in memory and never stored (card 2178)',
			pausedBecause: 'presentWebhook says why a webhook that is on is not sent to, worked out when the answer is made and never stored (card 2325)'
		},
		retyped: { events: 'stored as JSON text, and answered by presentWebhook as the array of event names it holds' },
		withholds: { setBy: 'presentWebhook leaves it out for every caller: it is what a password reset reads (card 2168)' },
		sometimesAbsent: {
			secret: 'presentWebhook leaves it out unless the caller is the board owner or an administrator, or has just created the webhook',
			url: 'presentWebhook leaves the address out with the secret, for the same callers (card 2133)',
			lastDelivery: 'presentWebhook leaves it out with the address, for the same callers: the people told it fails are the people who may change where it sends (card 2178)',
			pausedBecause: 'presentWebhook leaves it out with the address, for the same callers: the people told it is held are the people who may take it over (card 2325)'
		}
	},
	AuditLogEntry: {
		table: activityLog,
		adds: {
			rawAction: 'GET /audit-log gives the action as stored, beside the canonical name in `action`',
			boardName: 'and names the board'
		},
		retyped: {
			source: 'the column is null on rows older than it; GET /audit-log answers readSource(), which is never null'
		}
	},
	Milestone: { table: milestones },
	MilestoneListItem: {
		table: milestones,
		adds: {
			boardName: 'GET /milestones names the board each milestone belongs to',
			cardCount: 'counts its cards',
			doneCount: 'and those of them that are in a Complete column',
			boardIds: 'and lists the boards its cards are on, which for a milestone that spans boards is the only place they are named'
		}
	},
	MilestoneDetail: {
		table: milestones,
		adds: { cards: 'GET /milestones/{milestoneId} answers the milestone with the cards in it' }
	},
	TokenEntry: {
		table: tokenUsage,
		adds: { subtaskTitle: 'getCardTokenEntries names the subtask an entry is on, beside its id' },
		withholds: {
			reportedByUserId:
				'who reported an entry is stored, and getCardTokenEntries, which is the one place an entry is answered, does not select it'
		}
	}
};

// ─── The checks ──────────────────────────────────────────────────────────────

describe('the OpenAPI document, against the handlers', () => {
	it('1. says every operation can be answered 401 and 429, unless it needs no key, and 500', () => {
		const faults: string[] = [];
		for (const op of OPS) {
			const has = new Set(documented(op));
			for (const status of [401, 429]) {
				if (!isPublic(op) && !has.has(status)) faults.push(`${op.name}: no ${status}`);
			}
			if (!has.has(500)) faults.push(`${op.name}: no 500`);
		}

		expect(faults).toEqual([]);
	});

	it('2. gives an operation a request body exactly when its handler reads one, and then a 400 and a 413', () => {
		const faults: string[] = [];
		for (const op of OPS) {
			if (!op.handler) continue;
			const has = new Set(documented(op));
			if (op.handler.readsBody && !op.entry.requestBody) faults.push(`${op.name}: the handler reads a body and none is documented`);
			if (!op.handler.readsBody && op.entry.requestBody) faults.push(`${op.name}: a body is documented and the handler reads none`);
			if (op.handler.readsBody) {
				for (const status of [400, 413]) if (!has.has(status)) faults.push(`${op.name}: reads a body and has no ${status}`);
			}
		}

		expect(faults).toEqual([]);
	});

	it('3. declares every {parameter} of a path, and has no $ref that names nothing', () => {
		const faults: string[] = [];
		for (const op of OPS) {
			const inPath = sorted([...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
			const declared: string[] = sorted(
				(op.entry.parameters ?? [])
					.map(deref)
					.filter((p: Json) => p?.in === 'path')
					.map((p: Json) => p.name as string)
			);
			if (inPath.join() !== declared.join()) {
				faults.push(`${op.name}: the path has {${inPath.join('}, {')}} and declares [${declared.join(', ')}]`);
			}
			for (const p of (op.entry.parameters ?? []).map(deref)) {
				if (p?.in === 'path' && p.required !== true) faults.push(`${op.name}: path parameter ${p.name} is not required`);
			}
		}
		for (const { node, path } of everyNode(spec)) {
			if (typeof node.$ref === 'string' && lookup(node.$ref) === undefined) faults.push(`${path}: $ref ${node.$ref} names nothing`);
		}

		expect(faults).toEqual([]);
	});

	it('4. documents every status a handler can answer, the success it returns, and no failure it cannot answer', () => {
		const faults: string[] = [];
		for (const op of OPS) {
			if (!op.handler) continue;
			const has = new Set(documented(op));
			// What the reading found, less what it is known to find and the operation never answers.
			const never = new Set(READ_AND_NEVER_ANSWERED[op.name]?.statuses ?? []);
			const answers = new Set([...op.handler.statuses].filter((status) => !never.has(status)));

			for (const what of op.handler.unread) faults.push(`${op.name}: cannot be read: ${what}`);

			// Every failure the handler, the guards it calls and the typed errors it catches can answer.
			for (const status of sorted(answers)) {
				if (status >= 400 && !has.has(status)) faults.push(`${op.name}: the handler answers ${status} and it is not documented`);
			}

			// The successes: the ones documented are the ones returned.
			const returned = sorted(answers).filter((s) => s < 400);
			const said = sorted(has).filter((s) => s < 400);
			if (returned.join() !== said.join()) {
				faults.push(`${op.name}: the handler returns ${returned.join(', ') || 'no success'} and the document says ${said.join(', ') || 'none'}`);
			}

			// And nothing the caller will never be answered.
			const around = answeredAroundTheHandler(op);
			for (const status of sorted(has)) {
				if (status >= 400 && !answers.has(status) && !around.has(status)) {
					faults.push(`${op.name}: documents ${status}, which neither the handler nor the gate answers`);
				}
			}
		}
		// An exemption that names no operation, or a status the reading no longer finds, has outlived its reason.
		for (const [name, { statuses }] of Object.entries(READ_AND_NEVER_ANSWERED)) {
			const op = OPS.find((o) => o.name === name);
			if (!op) faults.push(`READ_AND_NEVER_ANSWERED names ${name}, which the document does not have`);
			for (const status of statuses) {
				if (op && !op.handler?.statuses.has(status)) {
					faults.push(`READ_AND_NEVER_ANSWERED: ${name} is no longer read as answering ${status}`);
				}
			}
		}

		expect(faults).toEqual([]);
	});

	it('5. documents the query parameters a handler reads, and no others', () => {
		const faults: string[] = [];
		for (const op of OPS) {
			if (!op.handler) continue;
			const read = sorted(queryNamesRead(op));
			const said: string[] = sorted(
				(op.entry.parameters ?? [])
					.map(deref)
					.filter((p: Json) => p?.in === 'query')
					.map((p: Json) => p.name as string)
			);
			for (const name of read) if (!said.includes(name)) faults.push(`${op.name}: reads ?${name} and does not document it`);
			for (const name of said) if (!read.includes(name)) faults.push(`${op.name}: documents ?${name} and does not read it`);
		}
		// An exemption that names no operation, or reads nothing, has outlived its reason.
		for (const [name, where] of Object.entries(QUERY_READ_ELSEWHERE)) {
			if (!OPS.some((op) => op.name === name)) faults.push(`QUERY_READ_ELSEWHERE names ${name}, which the document does not have`);
			if (queryNamesReadBy(where.file, where.fn, where.params).size === 0) {
				faults.push(`QUERY_READ_ELSEWHERE: no query parameter is read by ${where.fn} in ${where.file}`);
			}
		}

		expect(faults).toEqual([]);
	});

	it('6. tags every operation with a tag the document lists, and lists no tag without an operation', () => {
		// The /docs page lists an operation only under a tag in `tags`.
		const listed: string[] = (spec.tags ?? []).map((t: Json) => t.name);
		const faults: string[] = [];
		for (const op of OPS) {
			const tags: string[] = op.entry.tags ?? [];
			if (tags.length === 0) faults.push(`${op.name}: has no tag, so /docs does not list it`);
			for (const tag of tags) if (!listed.includes(tag)) faults.push(`${op.name}: tag "${tag}" is not in the document's tags, so /docs does not list it`);
		}
		for (const tag of listed) {
			if (!OPS.some((op) => (op.entry.tags ?? []).includes(tag))) faults.push(`tag "${tag}" has no operation`);
		}
		if (new Set(listed).size !== listed.length) faults.push('a tag is listed twice');

		expect(faults).toEqual([]);
	});

	it('7. answers every failure as an object with a required `message`, with no `error` in an example, in plain schemas', () => {
		const faults: string[] = [];

		/** A failure's response: its examples have no `error`, and its schema has a required string `message`. */
		const failure = (where: string, response: Json) => {
			const media = response?.content?.['application/json'];
			if (!media) return void faults.push(`${where}: has no application/json body, and every failure is JSON`);

			const examples = [media.example, ...Object.values<Json>(media.examples ?? {}).map((e) => e?.value)];
			for (const example of examples) {
				for (const { node } of everyNode(example)) {
					if (!Array.isArray(node) && 'error' in node) faults.push(`${where}: an example has an \`error\` key`);
				}
			}

			const schema = deref(media.schema);
			const types = ([] as string[]).concat(schema?.type ?? []);
			if (!schema) return void faults.push(`${where}: has no schema`);
			if (!types.includes('object')) faults.push(`${where}: its schema is not an object`);
			if (deref(schema.properties?.message)?.type !== 'string') faults.push(`${where}: its schema has no string \`message\``);
			if (!(schema.required ?? []).includes('message')) faults.push(`${where}: \`message\` is not required in its schema`);
		};

		for (const op of OPS) {
			for (const [status, response] of Object.entries<Json>(op.entry.responses ?? {})) {
				if (Number(status) >= 400) failure(`${op.name} ${status}`, deref(response));
			}
		}
		// The shared responses, whether or not an operation refers to them yet: all of them are failures.
		for (const [name, response] of Object.entries<Json>(spec.components?.responses ?? {})) {
			failure(`components.responses.${name}`, response);
		}

		// The document is OpenAPI 3.1, where a value that may be null is `type: ['string', 'null']`
		// and `nullable` means nothing. And the /docs page draws an example from a schema by its
		// `type` and `properties`: a composed schema is drawn as `null`.
		for (const { node, path, under } of everyNode(spec)) {
			// A property that happens to be called `nullable`, and what an example holds, are not keywords.
			if (Array.isArray(node) || under === 'properties' || /\/examples?(\/|$)/.test(path)) continue;
			for (const keyword of ['nullable', 'allOf', 'oneOf', 'anyOf']) {
				if (keyword in node) faults.push(`${path}: uses \`${keyword}\``);
			}
		}

		expect(faults).toEqual([]);
	});

	it('8. gives each schema that mirrors a table that table\'s columns, each with the column\'s type, and requires all of them', () => {
		const faults: string[] = [];
		for (const [name, mirror] of Object.entries(MIRRORS)) {
			const schema = spec.components?.schemas?.[name];
			if (!schema) {
				faults.push(`${name}: the document has no such schema`);
				continue;
			}
			const table = getTableColumns(mirror.table);
			const tableColumns = Object.keys(table);
			const adds = Object.keys(mirror.adds ?? {});
			const withholds = Object.keys(mirror.withholds ?? {});
			const retyped = Object.keys(mirror.retyped ?? {});

			// The lists themselves: an addition that has become a column, or a column that is gone.
			for (const key of adds) if (tableColumns.includes(key)) faults.push(`${name}: MIRRORS adds ${key}, which is a column of the table`);
			for (const key of [...withholds, ...retyped]) {
				if (!tableColumns.includes(key)) faults.push(`${name}: MIRRORS lists ${key}, which is not a column of the table`);
			}

			const expected = sorted([...tableColumns.filter((c) => !withholds.includes(c)), ...adds]);
			const properties = sorted(Object.keys(schema.properties ?? {}));
			for (const key of expected) if (!properties.includes(key)) faults.push(`${name}: lacks ${key}`);
			for (const key of properties) if (!expected.includes(key)) faults.push(`${name}: has ${key}, which is neither a column nor a listed addition`);

			// The type of each column that is there.
			for (const key of tableColumns) {
				const property = schema.properties?.[key];
				if (!property || retyped.includes(key)) continue;
				const column = table[key];
				const type =
					column.dataType === 'number' ? (column.columnType === 'SQLiteReal' ? 'number' : 'integer') : column.dataType;
				const types = ([] as string[]).concat(deref(property).type ?? []);
				const wanted = column.notNull ? [type] : [type, 'null'];
				if (sorted(types).join() !== sorted(wanted).join()) {
					faults.push(`${name}.${key}: is ${JSON.stringify(types)} and the column is ${JSON.stringify(wanted)}`);
				}
			}

			// A row is answered whole: every property is required, but for the ones listed as sometimes absent.
			const absent = Object.keys(mirror.sometimesAbsent ?? {});
			for (const key of absent) if (!properties.includes(key)) faults.push(`${name}: MIRRORS lists ${key} as sometimes absent, and the schema has no such property`);
			const required: string[] = schema.required ?? [];
			for (const key of properties) {
				if (absent.includes(key) && required.includes(key)) faults.push(`${name}: requires ${key}, which MIRRORS lists as sometimes absent`);
				if (!absent.includes(key) && !required.includes(key)) faults.push(`${name}: does not require ${key}`);
			}
		}

		expect(faults).toEqual([]);
	});

	it('9. was made of every operation: each has a handler that was read, and a status was found in each', () => {
		expect(OPS).toHaveLength(OPERATIONS);

		const faults: string[] = [];
		for (const op of OPS) {
			if (!op.handler) faults.push(`${op.name}: ${op.file} exports no ${op.method.toUpperCase()}`);
			else if (op.handler.statuses.size === 0) faults.push(`${op.name}: no status was found in its handler`);
		}
		expect(faults).toEqual([]);

		// The reading sees through what a handler calls. If it stopped doing so the
		// checks above would pass on less than the handlers do.
		const statusesOf = (name: string) => sorted(OPS.find((op) => op.name === name)?.handler?.statuses ?? []);
		// The guards in route-guards.ts, a typed error (CardMoveError: 404 and 409), and the handler's own 400.
		expect(statusesOf('PUT /api/v1/cards/{cardId}/move')).toEqual([200, 400, 401, 403, 404, 409]);
		// dependency-refusals.ts: the duplicate and the cycle (409), an end that waits on itself (400).
		expect(statusesOf('POST /api/v1/cards/{cardId}/dependencies')).toEqual([201, 400, 401, 403, 404, 409]);
		// A handler with no status of its own beyond the 400: all of it comes from requireBoard.
		expect(statusesOf('GET /api/v1/boards/{boardId}/webhooks')).toEqual([200, 400, 401, 403, 404]);
		// A typed error whose statuses are three (MilestoneError), and a same-file helper.
		expect(statusesOf('PUT /api/v1/cards/{cardId}')).toEqual([200, 400, 401, 403, 404]);

		// More than half of the operations read a body, and some read the query string.
		expect(OPS.filter((op) => op.handler?.readsBody).length).toBeGreaterThanOrEqual(25);
		expect(OPS.filter((op) => queryNamesRead(op).size > 0).length).toBeGreaterThanOrEqual(5);
		// 13 when this was written: the burndown's, which are read in $lib.
		expect(queryNamesRead(OPS.find((op) => op.name === 'GET /api/v1/burndown')!).size).toBeGreaterThanOrEqual(13);
	});

	it('10. has an entry for every route under /api/v1/ and every method it exports, and no entry without one', async () => {
		const V1 = '/api/v1/';

		// The tree, written as the document writes an operation: `GET /api/v1/cards/{cardId}`.
		// Every route file under src/routes/api/v1/, the document's own included, and
		// each of the five methods it exports.
		const inTree: string[] = [];
		const patterns = routePatterns().filter((pattern) => pattern.startsWith(V1));
		for (const pattern of patterns) {
			const path = pattern.replace(/\[(\w+)\]/g, '{$1}');
			for (const method of await routeMethods(pattern)) inTree.push(`${method} ${path}`);
		}
		const inDocument = OPS.map((op) => op.name);

		const faults: string[] = [];
		// One way: a route a caller can reach and the document does not describe.
		for (const name of sorted(inTree)) {
			if (!inDocument.includes(name)) faults.push(`${name}: is a route, and the document has no entry for it`);
		}
		// The other: an entry a caller would be answered 404 or 405 for.
		for (const name of sorted(inDocument)) {
			if (!inTree.includes(name)) faults.push(`${name}: is in the document, and there is no such route or it has no such method`);
		}
		// And nothing in the document that neither list would hold: a path that is
		// not under /api/v1/, or a method that is not one of the five OPS is made of.
		for (const [path, item] of Object.entries<Json>(spec.paths ?? {})) {
			if (!path.startsWith(V1)) faults.push(`${path}: is not under ${V1}`);
			for (const key of Object.keys(item)) {
				if (!(METHODS as readonly string[]).includes(key)) faults.push(`${path}: has \`${key}\`, which is not a method this file reads`);
			}
		}

		expect(faults).toEqual([]);

		// The tree was found, and it is the size the document is. The document is one of its routes.
		expect(inTree).toHaveLength(OPERATIONS);
		expect(new Set(inTree).size).toBe(inTree.length);
		expect(inTree).toContain('GET /api/v1/openapi.json');
	});

	it('11. says a count of tokens is a 64-bit integer, wherever one is sent or answered', () => {
		// One entry may hold ten thousand million tokens, and a total is a sum of entries.
		// A client generated from `type: integer` alone holds it in 32 bits, which end at 2,147,483,647.
		expect(MAX_TOKENS_PER_ENTRY).toBeGreaterThan(2 ** 31 - 1);

		/** The integer properties of the token schemas that count tokens. */
		const COUNTS = [
			'tokens', 'total', 'direct', 'fromSubtasks', 'unpricedTokens', 'cardTotal',
			'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens'
		];
		/** And the ones that do not: ids, and counts of entries, of calls and of places in a list. */
		const NOT_COUNTS = ['id', 'cardId', 'subtaskId', 'entryId', 'deleted', 'entries', 'apiCalls', 'written', 'index'];

		// Where token counts are: the component schemas of the token operations, and what those
		// operations write into their own request bodies and answers.
		const scopes: { where: string; schema: Json }[] = Object.entries<Json>(spec.components?.schemas ?? {})
			.filter(([name]) => name.startsWith('Token') || name === 'CardTokens')
			.map(([name, schema]) => ({ where: name, schema }));
		for (const op of OPS.filter((o) => (o.entry.tags ?? []).includes('Tokens'))) {
			const body = op.entry.requestBody?.content?.['application/json']?.schema;
			if (body) scopes.push({ where: `${op.name} body`, schema: body });
			for (const [status, response] of Object.entries<Json>(op.entry.responses ?? {})) {
				const schema = response?.content?.['application/json']?.schema;
				if (schema) scopes.push({ where: `${op.name} ${status}`, schema });
			}
		}

		const faults: string[] = [];
		let counts = 0;
		for (const scope of scopes) {
			for (const { node, path, under } of everyNode(scope.schema, scope.where)) {
				if (under !== 'properties') continue;
				for (const [key, property] of Object.entries<Json>(node)) {
					if (!([] as string[]).concat(property?.type ?? []).includes('integer')) continue;
					if (COUNTS.includes(key)) {
						counts++;
						if (property.format !== 'int64') faults.push(`${path}/${key}: counts tokens and is not \`format: 'int64'\``);
					} else if (!NOT_COUNTS.includes(key)) {
						faults.push(`${path}/${key}: is an integer this check knows neither as a count of tokens nor as anything else`);
					}
				}
			}
		}

		expect(faults).toEqual([]);
		// 41 when this was written: the six of an entry, the five of each of three totals, the two of the
		// batch and of the subtask's answer, and the six of each of the three request bodies.
		expect(counts).toBeGreaterThanOrEqual(41);
	});

	it('12. says of every property of an answer whether it is always there: required, or listed with the reason it is not', () => {
		const faults: string[] = [];
		const objects = answerObjects();
		const mirrored = Object.keys(MIRRORS);

		for (const { where, schema } of objects) {
			const properties = Object.keys(schema.properties);
			if (!Array.isArray(schema.required)) {
				faults.push(`${where}: has no \`required\`, so a generated client takes every property of it to be optional`);
				continue;
			}
			const required: string[] = schema.required;
			if (new Set(required).size !== required.length) faults.push(`${where}: lists a property twice in \`required\``);
			for (const key of required) if (!properties.includes(key)) faults.push(`${where}: requires ${key}, which is not one of its properties`);

			// The mirrors are held to MIRRORS by check 8, which names what each may lack.
			if (mirrored.includes(where)) continue;
			const absent = Object.keys(SOMETIMES_ABSENT[where] ?? {});
			for (const key of properties) {
				if (absent.includes(key) && required.includes(key)) faults.push(`${where}: requires ${key}, which SOMETIMES_ABSENT says an answer can lack`);
				if (!absent.includes(key) && !required.includes(key)) {
					faults.push(`${where}: does not require ${key}, and SOMETIMES_ABSENT does not say when it is left out`);
				}
			}
		}
		// An entry that names no schema, or no property of it, has outlived its reason. So has one for a mirror.
		for (const [where, absent] of Object.entries(SOMETIMES_ABSENT)) {
			const object = objects.find((o) => o.where === where);
			if (!object) faults.push(`SOMETIMES_ABSENT names ${where}, which is not a schema of an answer`);
			if (mirrored.includes(where)) faults.push(`SOMETIMES_ABSENT names ${where}, which is a mirror: say it in MIRRORS`);
			for (const key of Object.keys(absent)) {
				if (object && !(key in object.schema.properties)) faults.push(`SOMETIMES_ABSENT: ${where} has no property ${key}`);
			}
		}

		expect(faults).toEqual([]);
		// The 58 component schemas, the objects inside them and the ones written into an operation.
		expect(objects.length).toBeGreaterThanOrEqual(100);
	});

	it('13. gives no example of a refusal whose text its operation cannot answer', () => {
		const gate = gateTexts();
		// The gate was read: the body faults, the keys, the rate limit and the wrong method.
		for (const text of ['The request body is missing or is not valid JSON', 'Invalid or expired API key', 'Rate limit exceeded', 'Payload Too Large', 'Not found']) {
			expect(gate.exact).toContain(text);
		}
		expect(isOneOf(gate, 'PATCH method not allowed')).toBe(true);

		/** Whether the gate answers this status for this operation: see answeredAroundTheHandler. */
		const gateAnswers = (op: Operation, status: number) =>
			status === 404 || status === 405 || ((status === 401 || status === 429) && !isPublic(op)) || ((status === 400 || status === 413) && !!op.handler?.readsBody);

		const faults: string[] = [];
		let examples = 0;
		const needed = new Set<string>();
		for (const op of OPS) {
			if (!op.handler) continue;
			const own = textsOf(op.file, op.method.toUpperCase());
			for (const [status, response] of Object.entries<Json>(op.entry.responses ?? {})) {
				if (Number(status) < 400 || Number(status) > 499) continue;
				const media = deref(response)?.content?.['application/json'];
				const given = [media?.example, ...Object.values<Json>(media?.examples ?? {}).map((e) => e?.value)].filter((e) => e !== undefined);
				for (const example of given) {
					examples++;
					const message = example?.message;
					if (typeof message !== 'string') {
						faults.push(`${op.name} ${status}: an example has no \`message\``);
						continue;
					}
					const answered = isOneOf(own, message) || (gateAnswers(op, Number(status)) && isOneOf(gate, message));
					const listed = BUILT_AT_RUN_TIME[`${op.name} ${status}`];
					if (listed?.message === message) {
						needed.add(`${op.name} ${status}`);
						if (answered) faults.push(`BUILT_AT_RUN_TIME: "${message}" of ${op.name} ${status} is found in the source, so the entry is not needed`);
					} else if (!answered) {
						faults.push(`${op.name} ${status}: "${message}" is not a text its handler, what that calls, or the gate for this status can answer`);
					}
				}
			}
		}
		for (const name of Object.keys(BUILT_AT_RUN_TIME)) {
			if (!needed.has(name)) faults.push(`BUILT_AT_RUN_TIME names ${name}, and the document has no such example there`);
		}

		expect(faults).toEqual([]);
		// Every operation that needs a key has a 401 and a 429 with an example, so: two for each at the least.
		expect(examples).toBeGreaterThanOrEqual(2 * (OPERATIONS - 1));
	});
});

// ─── The reading itself ──────────────────────────────────────────────────────

describe('the reading of a handler', () => {
	const IMPORT = "import { json, error } from '@sveltejs/kit';\n";
	let made = 0;

	/** Source that exists only here, read as if it were the file named. */
	const given = (file: string, code: string) => void sources.set(file, parse(file, IMPORT + code));

	it('finds what a handler answers, in its own file and in what it calls, and what it reads', () => {
		given(
			'example/things/+server.ts',
			`import { requireThing, ThingError } from './guards';
			function own(id: number) { if (!id) throw error(404, 'No such thing'); }
			export const POST = async ({ request, url, locals }) => {
				if (!locals.user) throw error(401, 'Not authenticated');
				const body = await request.json();
				own(body.id);
				requireThing(body.id);
				const wanted = url.searchParams.get('wanted') ?? url.searchParams.getAll('also');
				try { act(wanted); } catch (e) { if (e instanceof ThingError) throw error(e.status, e.message); throw e; }
				if (body.again) return json({ message: 'Already there' });
				return json(body, { status: 201 });
			};
			export const GET = async () => new Response('a file');`
		);
		given(
			'example/things/guards.ts',
			`export class ThingError extends Error { constructor(public status: number, message: string) { super(message); } }
			export function requireThing(id: number) { if (id < 0) throw error(403, 'Not yours'); deeper(id); }
			function deeper(id: number) { if (id > 9) throw new ThingError(409, 'Taken'); if (id > 99) throw new ThingError(410, 'Gone'); }`
		);

		const post = reading('example/things/+server.ts', 'POST');
		// Its own 401, 200 and 201; its helper's 404; the guard's 403; and the typed error's 409 and 410.
		expect(sorted(post.statuses)).toEqual([200, 201, 401, 403, 404, 409, 410]);
		expect(post.readsBody).toBe(true);
		expect(sorted(post.query)).toEqual(['also', 'wanted']);
		expect(post.unread).toEqual([]);

		const get = reading('example/things/+server.ts', 'GET');
		expect(sorted(get.statuses)).toEqual([200]);
		expect(get.readsBody).toBe(false);
		expect(sorted(get.query)).toEqual([]);
	});

	it('finds the texts a handler can answer with, and leaves out a branch its arguments rule out', () => {
		given(
			'example/texts/+server.ts',
			`import { requireThing, refuse } from './guards';
			function own(id: number, forEdit: boolean) {
				if (!id) throw error(404, 'No such thing');
				if (forEdit) throw error(403, 'Not yours to change'); else throw error(403, 'Not yours to see');
			}
			export const GET = async ({ params, locals }) => {
				own(Number(params.id), false);
				requireThing(locals.user, 'view');
				refuse(Number(params.id), 3);
				return json({});
			};
			export const PUT = async ({ params, locals }) => {
				own(Number(params.id), true);
				requireThing(locals.user, 'edit');
				return json({});
			};
			export const DELETE = async ({ locals }) => { requireThing(locals.user); return json({}); };`
		);
		given(
			'example/texts/guards.ts',
			`export function requireThing(user: unknown, need = 'edit', strict = false) {
				if (!user) throw error(401, 'Not authenticated');
				deeper(need);
				if (strict && need === 'edit') throw error(403, 'Strictly not');
			}
			function deeper(need: string) { throw error(403, need === 'edit' ? 'No edit access to this thing' : 'No access to this thing'); }
			export function refuse(id: number, count: number) {
				throw error(409, \`Thing #\${id} has \${count} part\${count > 1 ? 's' : ''} that must be finished first\`);
			}
			export function long(max: number) { throw error(400, \`too many (max \${max} at once). \` + 'Send fewer, ' + max + ' or less.'); }
			export function short(a: string, b: string) { return \`\${a} \${b}\`; }`
		);

		const get = textsOf('example/texts/+server.ts', 'GET');
		// Its own helper called with `false`, the guard called with 'view' and handed on, and a template.
		expect(isOneOf(get, 'No such thing')).toBe(true);
		expect(isOneOf(get, 'Not yours to see')).toBe(true);
		expect(isOneOf(get, 'Not yours to change')).toBe(false);
		expect(isOneOf(get, 'No access to this thing')).toBe(true);
		expect(isOneOf(get, 'No edit access to this thing')).toBe(false);
		expect(isOneOf(get, 'Thing #12 has 3 parts that must be finished first')).toBe(true);
		expect(isOneOf(get, 'Thing #12 has 3 parts that must be started first')).toBe(false);
		// A parameter with a literal default that the call leaves out is read as that default: `strict` is false.
		expect(isOneOf(get, 'Strictly not')).toBe(false);

		const put = textsOf('example/texts/+server.ts', 'PUT');
		expect(isOneOf(put, 'Not yours to change')).toBe(true);
		expect(isOneOf(put, 'Not yours to see')).toBe(false);
		expect(isOneOf(put, 'No edit access to this thing')).toBe(true);
		expect(isOneOf(put, 'No access to this thing')).toBe(false);
		// What the handler does not call is not its text.
		expect(isOneOf(put, 'Thing #12 has 3 parts that must be finished first')).toBe(false);

		// `need` left out: its default, 'edit'.
		const del = textsOf('example/texts/+server.ts', 'DELETE');
		expect(isOneOf(del, 'No edit access to this thing')).toBe(true);
		expect(isOneOf(del, 'No access to this thing')).toBe(false);

		// Strings joined with `+` are one text, with what is worked out between them.
		const long = textsOf('example/texts/guards.ts', 'long');
		expect(isOneOf(long, 'too many (max 500 at once). Send fewer, 500 or less.')).toBe(true);
		expect(isOneOf(long, 'Send fewer, ')).toBe(false);
		// A template with next to nothing fixed in it is not read as a message: it would match any two words.
		expect(isOneOf(textsOf('example/texts/guards.ts', 'short'), 'Card not found')).toBe(false);

		// With `within`, a call into another file is not followed.
		const alone = textsOf('example/texts/+server.ts', 'GET', {}, ['example/texts/+server.ts']);
		expect(isOneOf(alone, 'No such thing')).toBe(true);
		expect(isOneOf(alone, 'No access to this thing')).toBe(false);
	});

	it('reads a shared function as each caller calls it: the options it is handed as an object, and the constants of its file (card 2012)', () => {
		given(
			'example/options/shared.ts',
			`export class MoveError extends Error { constructor(public status: number, message: string) { super(message); } }
			function lost() { throw new MoveError(410, 'Gone'); }
			function guard(id: number, says?: string) { if (!id) throw error(403, says ?? 'No edit access to this thing'); }
			export function change(caller: unknown, at: { id: number }, opts: { source: string; says?: string; allowMove?: boolean }) {
				guard(at.id, opts.says);
				if (opts.allowMove && at.id) {
					try { lost(); } catch (e) { if (e instanceof MoveError) throw error(e.status, e.message); throw e; }
					throw error(409, 'Moved too far');
				}
				if (opts.source === 'api') throw error(422, 'Only through the API');
			}`
		);
		given(
			'example/options/+server.ts',
			`import { change } from './shared';
			const NO_EDIT = "No edit access to this thing's board";
			export const PUT = async () => { change(null, { id: 1 }, { source: 'api', says: NO_EDIT }); return json({}); };
			export const POST = async () => { change(null, { id: 1 }, { source: 'ui', allowMove: true }); return json({}); };`
		);

		// Handed `says` and no `allowMove`: the branch the option rules out, and the default `??` would give, are not its own.
		expect(sorted(reading('example/options/+server.ts', 'PUT').statuses)).toEqual([200, 403, 422]);
		const put = textsOf('example/options/+server.ts', 'PUT');
		expect(isOneOf(put, "No edit access to this thing's board")).toBe(true);
		expect(isOneOf(put, 'No edit access to this thing')).toBe(false);
		expect(isOneOf(put, 'Moved too far')).toBe(false);
		expect(isOneOf(put, 'Only through the API')).toBe(true);

		// Handed `allowMove: true` and no `says`: the move's statuses and texts, the default words, and not v1's branch.
		expect(sorted(reading('example/options/+server.ts', 'POST').statuses)).toEqual([200, 403, 409, 410]);
		const post = textsOf('example/options/+server.ts', 'POST');
		expect(isOneOf(post, 'Moved too far')).toBe(true);
		expect(isOneOf(post, 'No edit access to this thing')).toBe(true);
		expect(isOneOf(post, "No edit access to this thing's board")).toBe(false);
		expect(isOneOf(post, 'Only through the API')).toBe(false);

		// And the card update both trees share: v1's handler, handed its words in a constant and no move, answers
		// neither the move's 409 nor its words, nor the guard's default words; the internal handler, handed the move, does.
		const v1 = 'src/routes/api/v1/cards/[cardId]/+server.ts';
		const internal = 'src/routes/api/cards/[id]/+server.ts';
		expect(sorted(reading(v1, 'PUT').statuses)).toEqual([200, 400, 401, 403, 404]);
		expect(isOneOf(textsOf(v1, 'PUT'), "No edit access to this card's board")).toBe(true);
		expect(isOneOf(textsOf(v1, 'DELETE'), "No edit access to this card's board")).toBe(true);
		expect(isOneOf(textsOf(v1, 'DELETE'), 'No edit access to this board')).toBe(false);
		expect(isOneOf(textsOf(v1, 'PUT'), 'Target column not found')).toBe(false);
		expect(isOneOf(textsOf(internal, 'PUT'), 'Target column not found')).toBe(true);
		expect(sorted(reading(internal, 'PUT').statuses)).toContain(409);
	});

	// What it cannot read it says, and check 4 fails on it: a status it could not
	// see is a status the document was never held to.
	it.each<[string, string, RegExp]>([
		['an error() whose status is a variable', "throw error(code, 'x');", /neither a number nor a typed error/],
		[
			'an error() with the status of something not known to be a typed error',
			"try { act(); } catch (e) { throw error(e.status, 'x'); }",
			/neither a number nor a typed error/
		],
		[
			'an error() with the status of a typed error that is made nowhere with a number',
			"try { act(); } catch (e) { if (e instanceof Mystery) throw error(e.status, 'x'); }",
			/neither a number nor a typed error/
		],
		['an answer whose options are a variable', 'return json(body, init);', /options that are not written out/],
		['an answer whose options have a spread', 'return json(body, { ...init });', /options that are not written out/],
		['an answer whose status is a variable', 'return json(body, { status });', /status that is not a number/],
		['an answer whose status is worked out', 'return json(body, { status: made ? 201 : 200 });', /status that is not a number/],
		['a query parameter whose name is a variable', 'return json(url.searchParams.get(name));', /query parameter whose name is not written out/]
	])('says that it cannot read %s', (_name, code, what) => {
		const file = `example/unread-${++made}/+server.ts`;
		given(file, `export const GET = async ({ url }) => { ${code} };`);

		const found = reading(file, 'GET');

		expect(found.unread).toHaveLength(1);
		expect(found.unread[0]).toMatch(what);
		expect(found.unread[0]).toContain(`${file}:2 `);
	});
});

// ─── The answers themselves ──────────────────────────────────────────────────

/** The schema the document gives for one answer of an operation. */
function answerSchema(name: string, status: number): Json {
	const op = OPS.find((o) => o.name === name);
	if (!op) throw new Error(`The document has no ${name}`);
	const schema = deref(deref(op.entry.responses?.[status])?.content?.['application/json']?.schema);
	if (!schema) throw new Error(`${name} documents no JSON schema for a ${status}`);
	return schema;
}

/** The example the document gives for one answer of an operation. */
function answerExample(name: string, status: number): Json {
	const op = OPS.find((o) => o.name === name);
	const example = deref(op?.entry.responses?.[status])?.content?.['application/json']?.example;
	if (example === undefined) throw new Error(`${name} documents no example for a ${status}`);
	return structuredClone(example);
}

/** The example the document gives for an operation's request body: a copy, for a test to put its own ids into. */
function requestExample(name: string): Json {
	const op = OPS.find((o) => o.name === name);
	const example = op?.entry.requestBody?.content?.['application/json']?.example;
	if (example === undefined) throw new Error(`${name} documents no example of a request body`);
	return structuredClone(example);
}

/** The property names of a schema, sorted. */
const propertiesOf = (schema: Json) => sorted(Object.keys(deref(schema)?.properties ?? {}));

/** The keys of an answer, sorted. */
const keysOf = (value: object) => sorted(Object.keys(value));

describe('what a route answers, against the schema the document gives for it', () => {
	beforeEach(resetDb);

	/** An administrator, a board and two cards on it. An administrator passes every access check. */
	function fixture() {
		const admin = makeUser({ role: 'admin' });
		const { board, cols } = makeBoard({ owner: admin });
		const first = makeCard(cols['To Do']);
		const second = makeCard(cols['To Do']);
		return { admin, board, cols, first, second };
	}

	it('undocumentedProperties names each property an answer has that its schema does not list, at every depth (card 2254)', () => {
		const card = {
			type: 'object',
			properties: { id: { type: 'integer' }, tags: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } } }
		};
		expect(undocumentedProperties(card, { id: 1, tags: [{ name: 'a' }] }, 'card')).toEqual([]);
		// An extra key, named with the path that leads to it: at the top, and in an array item.
		expect(undocumentedProperties(card, { id: 1, setBy: 7, tags: [{ name: 'a' }, { name: 'b', colour: 'red' }] }, 'card')).toEqual([
			'card: has `setBy`, which its schema does not list',
			'card.tags[1]: has `colour`, which its schema does not list'
		]);
		// additionalProperties: true lets any key through; a schema there holds each value to itself.
		expect(undocumentedProperties({ type: 'object', additionalProperties: true }, { anything: { at: 'all' } }, 'map')).toEqual([]);
		const byName = { type: 'object', additionalProperties: { type: 'object', properties: { url: { type: 'string' } } } };
		expect(undocumentedProperties(byName, { a: { url: 'x' }, b: { url: 'y', secret: 's' } }, 'map')).toEqual([
			'map.b: has `secret`, which its schema does not list'
		]);
		// An object schema that lists no properties documents none: every key it is given is a fault.
		expect(undocumentedProperties({ type: 'object' }, { a: 1, b: 2 }, 'bare')).toEqual([
			'bare: has `a`, which its schema does not list',
			'bare: has `b`, which its schema does not list'
		]);
		// A null, or a schema that is not of an object, has nothing to list.
		expect(undocumentedProperties({ type: ['object', 'null'], properties: {} }, null, 'none')).toEqual([]);
		expect(undocumentedProperties({ type: 'string' }, 'text', 'text')).toEqual([]);
		// An object where the schema says something else is not skipped: nothing in it is described.
		expect(undocumentedProperties({ type: 'string' }, { secret: 's' }, 'text')).toEqual([
			'text: is an object, which its schema does not describe'
		]);
		expect(undocumentedProperties({ type: 'array', items: { type: ['integer', 'null'] } }, [1, { id: 2 }], 'ids')).toEqual([
			'ids[1]: is an object, which its schema does not describe'
		]);
	});

	it('GET /me/stats', async () => {
		const { admin, board, cols } = fixture();
		// Something for recentActivity to hold.
		await api('POST', `/api/v1/boards/${board.id}/cards`, { user: admin, body: { columnId: cols['To Do'].id, title: 'Raised' } });

		const res = await api('GET', '/api/v1/me/stats', { user: admin });

		expect(res.status).toBe(200);
		const schema = answerSchema('GET /api/v1/me/stats', 200);
		expect(keysOf(res.body)).toEqual(propertiesOf(schema));
		expect(keysOf(res.body.cardsCompleted)).toEqual(propertiesOf(schema.properties.cardsCompleted));
		expect(res.body.recentActivity).toHaveLength(1);
		expect(keysOf(res.body.recentActivity[0])).toEqual(propertiesOf(deref(schema.properties.recentActivity).items));
	});

	it('GET /audit-log', async () => {
		const { admin, board, cols } = fixture();
		await api('POST', `/api/v1/boards/${board.id}/cards`, { user: admin, body: { columnId: cols['To Do'].id, title: 'Raised' } });

		const res = await api('GET', '/api/v1/audit-log', { user: admin });

		expect(res.status).toBe(200);
		const schema = answerSchema('GET /api/v1/audit-log', 200);
		expect(keysOf(res.body)).toEqual(propertiesOf(schema));
		expect(res.body.data).toHaveLength(1);
		expect(keysOf(res.body.data[0])).toEqual(propertiesOf(deref(schema.properties.data).items));
		expect(keysOf(res.body.pagination)).toEqual(propertiesOf(schema.properties.pagination));
	});

	it('POST /cards/{cardId}/labels: a label that is assigned, and one that already was', async () => {
		const { admin, board, first } = fixture();
		const label = makeLabel(board);
		const name = 'POST /api/v1/cards/{cardId}/labels';

		const assigned = await api('POST', `/api/v1/cards/${first.id}/labels`, { user: admin, body: { labelId: label.id } });
		expect(assigned.status).toBe(201);
		expect(keysOf(assigned.body)).toEqual(propertiesOf(answerSchema(name, 201)));

		const again = await api('POST', `/api/v1/cards/${first.id}/labels`, { user: admin, body: { labelId: label.id } });
		expect(again.status).toBe(200);
		expect(keysOf(again.body)).toEqual(propertiesOf(answerSchema(name, 200)));
	});

	it('GET /cards/{cardId}/dependencies, in both directions and in one', async () => {
		const { admin, first, second } = fixture();
		makeDependency({ blocked: first, blocker: second, createdBy: admin });
		const schema = answerSchema('GET /api/v1/cards/{cardId}/dependencies', 200);

		const both = await api('GET', `/api/v1/cards/${first.id}/dependencies`, { user: admin });
		expect(both.status).toBe(200);
		expect(keysOf(both.body)).toEqual(propertiesOf(schema));
		expect(both.body.blockedBy).toHaveLength(1);
		expect(keysOf(both.body.blockedBy[0])).toEqual(propertiesOf(deref(schema.properties.blockedBy).items));

		// With a direction the other list is left out, not sent empty: the document says so.
		const one = await api('GET', `/api/v1/cards/${second.id}/dependencies?direction=blocks`, { user: admin });
		expect(keysOf(one.body)).toEqual(propertiesOf(schema).filter((key) => key !== 'blockedBy'));
		expect(keysOf(one.body.blocks[0])).toEqual(propertiesOf(deref(schema.properties.blocks).items));
		expect(schema.required).toEqual(['cardId', 'isBlocked']);
	});

	it('POST /cards/{cardId}/dependencies: a link that is made, one that is already there, and one that would close a loop', async () => {
		const { admin, first, second } = fixture();
		const name = 'POST /api/v1/cards/{cardId}/dependencies';

		const made = await api('POST', `/api/v1/cards/${first.id}/dependencies`, { user: admin, body: { dependsOnCardId: second.id } });
		expect(made.status).toBe(201);
		const created = answerSchema(name, 201);
		expect(keysOf(made.body)).toEqual(propertiesOf(created));
		expect(keysOf(made.body.blocked)).toEqual(propertiesOf(created.properties.blocked));
		expect(keysOf(made.body.blocker)).toEqual(propertiesOf(created.properties.blocker));

		// Both refusals are 409 and share the one schema: `cycle` is there for a loop only.
		const conflict = answerSchema(name, 409);
		expect(conflict.required).toEqual(['message']);

		const again = await api('POST', `/api/v1/cards/${first.id}/dependencies`, { user: admin, body: { dependsOnCardId: second.id } });
		expect(again.status).toBe(409);
		expect(keysOf(again.body)).toEqual(['message']);

		const loop = await api('POST', `/api/v1/cards/${second.id}/dependencies`, { user: admin, body: { dependsOnCardId: first.id } });
		expect(loop.status).toBe(409);
		expect(keysOf(loop.body)).toEqual(propertiesOf(conflict));
		expect(loop.body.cycle.length).toBeGreaterThan(0);
		expect(keysOf(loop.body.cycle[0])).toEqual(propertiesOf(deref(conflict.properties.cycle).items));
	});

	it('DELETE /cards/{cardId}/dependencies', async () => {
		const { admin, first, second } = fixture();
		makeDependency({ blocked: first, blocker: second });

		const res = await api('DELETE', `/api/v1/cards/${first.id}/dependencies`, { user: admin, body: { dependsOnCardId: second.id } });

		expect(res.status).toBe(200);
		expect(keysOf(res.body)).toEqual(propertiesOf(answerSchema('DELETE /api/v1/cards/{cardId}/dependencies', 200)));
	});

	// One card, five answers, four shapes: the row alone from create and update,
	// and the row with something beside it from the list, the move and the read.
	it('a card, as each of the five operations that answer one gives it', async () => {
		const { admin, board, cols, first } = fixture();
		makeDependency({ blocked: first, blocker: makeCard(cols['To Do']) });

		const created = await api('POST', `/api/v1/boards/${board.id}/cards`, { user: admin, body: { columnId: cols['To Do'].id, title: 'New' } });
		expect(created.status).toBe(201);
		expect(keysOf(created.body)).toEqual(propertiesOf(answerSchema('POST /api/v1/boards/{boardId}/cards', 201)));

		const updated = await api('PUT', `/api/v1/cards/${first.id}`, { user: admin, body: { title: 'Renamed' } });
		expect(updated.status).toBe(200);
		expect(keysOf(updated.body)).toEqual(propertiesOf(answerSchema('PUT /api/v1/cards/{cardId}', 200)));

		const listed = await api('GET', `/api/v1/boards/${board.id}/cards`, { user: admin });
		expect(listed.status).toBe(200);
		expect(keysOf(listed.body[0])).toEqual(propertiesOf(answerSchema('GET /api/v1/boards/{boardId}/cards', 200).items));

		const moved = await api('PUT', `/api/v1/cards/${first.id}/move`, { user: admin, body: { columnId: cols['In Progress'].id } });
		expect(moved.status).toBe(200);
		expect(keysOf(moved.body)).toEqual(propertiesOf(answerSchema('PUT /api/v1/cards/{cardId}/move', 200)));

		const read = await api('GET', `/api/v1/cards/${first.id}`, { user: admin });
		expect(read.status).toBe(200);
		const detail = answerSchema('GET /api/v1/cards/{cardId}', 200);
		expect(keysOf(read.body)).toEqual(propertiesOf(detail));
		expect(read.body.blockedBy).toHaveLength(1);
		expect(keysOf(read.body.blockedBy[0])).toEqual(propertiesOf(deref(detail.properties.blockedBy).items));
	});

	it('a board, with its columns from create and read and without them from update', async () => {
		const { admin, board } = fixture();

		const created = await api('POST', '/api/v1/boards', { user: admin, body: { name: 'New' } });
		expect(created.status).toBe(201);
		expect(keysOf(created.body)).toEqual(propertiesOf(answerSchema('POST /api/v1/boards', 201)));

		const read = await api('GET', `/api/v1/boards/${board.id}`, { user: admin });
		expect(keysOf(read.body)).toEqual(propertiesOf(answerSchema('GET /api/v1/boards/{boardId}', 200)));

		const updated = await api('PUT', `/api/v1/boards/${board.id}`, { user: admin, body: { name: 'Renamed' } });
		expect(keysOf(updated.body)).toEqual(propertiesOf(answerSchema('PUT /api/v1/boards/{boardId}', 200)));
	});

	// ─── Milestones ──────────────────────────────────────────────────────────

	it('a milestone, as each of the seven operations on one and on one card of it answers', async () => {
		const { admin, board, first } = fixture();

		const created = await api('POST', '/api/v1/milestones', { user: admin, body: { name: 'Goal', boardId: board.id } });
		expect(created.status).toBe(201);
		expect(keysOf(created.body)).toEqual(propertiesOf(answerSchema('POST /api/v1/milestones', 201)));
		const path = `/api/v1/milestones/${created.body.id}`;

		const attached = await api('POST', `${path}/cards`, { user: admin, body: { cardId: first.id } });
		expect(attached.status).toBe(200);
		expect(keysOf(attached.body)).toEqual(propertiesOf(answerSchema('POST /api/v1/milestones/{milestoneId}/cards', 200)));
		expect(attached.body.milestoneId).toBe(created.body.id);

		const read = await api('GET', path, { user: admin });
		expect(read.status).toBe(200);
		const detail = answerSchema('GET /api/v1/milestones/{milestoneId}', 200);
		expect(keysOf(read.body)).toEqual(propertiesOf(detail));
		expect(read.body.cards).toHaveLength(1);
		expect(keysOf(read.body.cards[0])).toEqual(propertiesOf(detail.properties.cards.items));

		const listed = await api('GET', `/api/v1/milestones?boardId=${board.id}&status=open`, { user: admin });
		expect(listed.status).toBe(200);
		expect(listed.body).toHaveLength(1);
		expect(keysOf(listed.body[0])).toEqual(propertiesOf(answerSchema('GET /api/v1/milestones', 200).items));
		expect(listed.body[0]).toMatchObject({ boardName: board.name, cardCount: 1, doneCount: 0, boardIds: [board.id] });

		const updated = await api('PATCH', path, { user: admin, body: { status: 'closed' } });
		expect(updated.status).toBe(200);
		expect(keysOf(updated.body)).toEqual(propertiesOf(answerSchema('PATCH /api/v1/milestones/{milestoneId}', 200)));
		expect(updated.body.status).toBe('closed');

		const detached = await api('DELETE', `${path}/cards`, { user: admin, body: { cardId: first.id } });
		expect(detached.status).toBe(200);
		expect(keysOf(detached.body)).toEqual(propertiesOf(answerSchema('DELETE /api/v1/milestones/{milestoneId}/cards', 200)));
		expect(detached.body.milestoneId).toBeNull();

		// Deleting it releases its cards: the document says so, and the answer counts them.
		await api('POST', `${path}/cards`, { user: admin, body: { cardId: first.id } });
		const deleted = await api('DELETE', path, { user: admin });
		expect(deleted.status).toBe(200);
		expect(keysOf(deleted.body)).toEqual(propertiesOf(answerSchema('DELETE /api/v1/milestones/{milestoneId}', 200)));
		expect(deleted.body).toEqual({ success: true, cardsReleased: 1 });
		const released = await api('GET', `/api/v1/cards/${first.id}`, { user: admin });
		expect(released.status).toBe(200);
		expect(released.body.milestoneId).toBeNull();
	});

	it('a batch of cards put into a milestone and taken out of it: done, and rejected with every card at fault', async () => {
		const { admin, first, second } = fixture();
		const elsewhere = makeMilestone({ createdBy: admin, cards: [second] });
		const milestone = makeMilestone({ createdBy: admin });
		const path = `/api/v1/milestones/${milestone.id}/cards/bulk`;
		const name = (method: string) => `${method} /api/v1/milestones/{milestoneId}/cards/bulk`;

		// One card that is not there refuses the batch: 409, and not the 404 one card alone is answered.
		const refused = await api('POST', path, { user: admin, body: { cardIds: [first.id, 999999] } });
		expect(refused.status).toBe(409);
		const rejected = answerSchema(name('POST'), 409);
		expect(keysOf(refused.body)).toEqual(propertiesOf(rejected));
		expect(refused.body).toMatchObject({ attached: 0, wouldAttach: 1, wouldSkipAlreadyIn: 0 });
		expect(refused.body.problems).toHaveLength(1);
		expect(keysOf(refused.body.problems[0])).toEqual(propertiesOf(rejected.properties.problems.items));
		// Nothing was written: the card that was acceptable is not in the milestone.
		expect((await api('GET', `/api/v1/milestones/${milestone.id}`, { user: admin })).body.cards).toEqual([]);

		const done = await api('POST', path, { user: admin, body: { cardIds: [first.id, second.id] } });
		expect(done.status).toBe(200);
		const attached = answerSchema(name('POST'), 200);
		expect(keysOf(done.body)).toEqual(propertiesOf(attached));
		expect(done.body.attached).toBe(2);
		// The card that was in another milestone is moved, and named.
		expect(done.body.movedFromOtherGoal).toHaveLength(1);
		expect(keysOf(done.body.movedFromOtherGoal[0])).toEqual(propertiesOf(attached.properties.movedFromOtherGoal.items));
		expect(done.body.movedFromOtherGoal[0]).toMatchObject({ cardId: second.id, fromMilestoneId: elsewhere.id });

		const refusedOut = await api('DELETE', path, { user: admin, body: { cardIds: [first.id, 999999] } });
		expect(refusedOut.status).toBe(409);
		const rejectedOut = answerSchema(name('DELETE'), 409);
		expect(keysOf(refusedOut.body)).toEqual(propertiesOf(rejectedOut));
		expect(keysOf(refusedOut.body.problems[0])).toEqual(propertiesOf(rejectedOut.properties.problems.items));

		const out = await api('DELETE', path, { user: admin, body: { cardIds: [first.id, second.id] } });
		expect(out.status).toBe(200);
		expect(keysOf(out.body)).toEqual(propertiesOf(answerSchema(name('DELETE'), 200)));
		expect(out.body.detached).toBe(2);
	});

	it('GET /milestones/{milestoneId}/summary, whole and compact', async () => {
		const { admin, cols, first, second } = fixture();
		// Three cards in the milestone: `first` waits on `second`, which waits on a card
		// outside it, and `free` waits on nothing. A subtask of `first` waits on `second` too.
		const free = makeCard(cols['To Do']);
		const outside = makeCard(cols['To Do']);
		const step = makeSubtask(first);
		const milestone = makeMilestone({ createdBy: admin, cards: [first, second, free] });
		makeDependency({ blocked: first, blocker: second });
		makeDependency({ blocked: second, blocker: outside });
		makeDependency({ blocked: step, blocker: second });

		const schema = answerSchema('GET /api/v1/milestones/{milestoneId}/summary', 200);
		const all = propertiesOf(schema);
		const graph = schema.properties.graph;
		// A node has `parentCardId` only when it is a subtask: both schemas say so.
		const ofNode = (node: Json, kind: Json) => propertiesOf(node).filter((key) => key !== 'parentCardId' || kind === 'subtask');
		const milestoneNode = (n: Json) => ofNode(graph.properties.nodes.items, n.kind);
		const planNode = (n: Json) => ofNode(schema.properties.criticalPathNodes.items, n.kind);

		const whole = await api('GET', `/api/v1/milestones/${milestone.id}/summary`, { user: admin });
		expect(whole.status).toBe(200);
		expect(keysOf(whole.body)).toEqual(all.filter((key) => key !== 'cardTitles' && key !== 'subtaskTitles'));
		expect(keysOf(whole.body.milestone)).toEqual(propertiesOf(schema.properties.milestone));

		const progress = schema.properties.progress;
		expect(keysOf(whole.body.progress)).toEqual(propertiesOf(progress));
		expect(whole.body.progress).toMatchObject({ total: 3, done: 0, percent: 0, openSubtasks: 1 });
		expect(keysOf(whole.body.progress.byColumn[0])).toEqual(propertiesOf(progress.properties.byColumn.items));
		expect(keysOf(whole.body.progress.boards[0])).toEqual(propertiesOf(progress.properties.boards.items));

		expect(keysOf(whole.body.graph)).toEqual(propertiesOf(graph));
		// The three cards, the subtask that has a link, and the card outside that one of them waits on.
		expect(whole.body.graph.nodes).toHaveLength(5);
		for (const node of whole.body.graph.nodes) expect(keysOf(node)).toEqual(milestoneNode(node));
		expect(whole.body.graph.nodes.filter((n: Json) => n.kind === 'subtask').map((n: Json) => n.id)).toEqual([step.id]);
		expect(whole.body.graph.nodes.filter((n: Json) => n.external).map((n: Json) => n.id)).toEqual([outside.id]);
		const end = propertiesOf(graph.properties.edges.items.properties.from);
		expect(whole.body.graph.edges).toHaveLength(3);
		expect(keysOf(whole.body.graph.edges[0])).toEqual(propertiesOf(graph.properties.edges.items));
		expect(keysOf(whole.body.graph.edges[0].from)).toEqual(end);
		expect(keysOf(whole.body.graph.layers[0][0])).toEqual(propertiesOf(graph.properties.layers.items.items));
		expect(whole.body.graph.unordered).toEqual([free.id]);

		// The longest chain of unfinished work: the card outside, `second`, then what waits on it.
		expect(whole.body.criticalPathNodes).toHaveLength(3);
		expect(whole.body.criticalPath.slice(0, 2)).toEqual([outside.id, second.id]);
		for (const node of whole.body.criticalPathNodes) expect(keysOf(node)).toEqual(planNode(node));

		expect(whole.body.nextActionable.map((n: Json) => n.id)).toEqual([free.id]);
		expect(keysOf(whole.body.nextActionable[0])).toEqual(milestoneNode(whole.body.nextActionable[0]));

		const blocked = schema.properties.blocked.items;
		expect(whole.body.blocked).toHaveLength(3);
		for (const waiting of whole.body.blocked) {
			expect(keysOf(waiting)).toEqual(propertiesOf(blocked));
			expect(keysOf(waiting.card)).toEqual(milestoneNode(waiting.card));
			expect(waiting.blockers).toHaveLength(1);
			expect(keysOf(waiting.blockers[0])).toEqual(planNode(waiting.blockers[0]));
		}

		// Compact: no graph, and the titles the ids refer to in its place: a
		// card's under its id, and a subtask's apart (card 2117), where the two
		// took one key between them when their ids were the same.
		const compact = await api('GET', `/api/v1/milestones/${milestone.id}/summary?compact=true`, { user: admin });
		expect(compact.status).toBe(200);
		expect(keysOf(compact.body)).toEqual(all.filter((key) => key !== 'graph'));
		expect(compact.body.cardTitles[free.id]).toBe(free.title);
		const titlesOf = (kind: string) =>
			Object.fromEntries(whole.body.graph.nodes.filter((n: Json) => n.kind === kind).map((n: Json) => [n.id, n.title]));
		expect(compact.body.cardTitles).toEqual(titlesOf('card'));
		expect(compact.body.subtaskTitles).toEqual({ [step.id]: step.title });
		// Which is why none of the three is required, and everything else is.
		expect(sorted(schema.required)).toEqual(all.filter((key) => key !== 'graph' && key !== 'cardTitles' && key !== 'subtaskTitles'));
	});

	// The progress panel read "193 open subtasks" with nothing to judge it against
	// (card 2225): the summary gives every subtask of the same cards beside it.
	it('GET /milestones/{milestoneId}/summary counts every subtask of its cards beside the open ones', async () => {
		const { admin, cols, first, second } = fixture();
		const archived = makeCard(cols['To Do']);
		const outside = makeCard(cols['To Do']);
		makeSubtask(first, { completed: true });
		makeSubtask(first, { completed: true });
		makeSubtask(first);
		makeSubtask(second);
		// Neither an archived member's subtasks nor those of a card outside the milestone that one of its cards waits on.
		makeSubtask(archived);
		makeSubtask(archived, { completed: true });
		makeSubtask(outside);
		makeSubtask(outside, { completed: true });
		const milestone = makeMilestone({ createdBy: admin, cards: [first, second, archived] });
		makeDependency({ blocked: first, blocker: outside });
		db.update(cards).set({ archivedAt: stamp() }).where(eq(cards.id, archived.id)).run();
		const empty = makeMilestone({ createdBy: admin, cards: [makeCard(cols['To Do'])] });

		const schema = answerSchema('GET /api/v1/milestones/{milestoneId}/summary', 200);
		expect(schema.properties.progress.required).toContain('totalSubtasks');
		for (const compact of ['', '?compact=true']) {
			const res = await api('GET', `/api/v1/milestones/${milestone.id}/summary${compact}`, { user: admin });
			expect(res.status).toBe(200);
			expect(res.body.progress).toMatchObject({ total: 2, openSubtasks: 2, totalSubtasks: 4 });
			expect(typeFaults(schema, res.body, `summary${compact}`)).toEqual([]);
		}
		const none = await api('GET', `/api/v1/milestones/${empty.id}/summary`, { user: admin });
		expect(none.body.progress).toMatchObject({ total: 1, openSubtasks: 0, totalSubtasks: 0 });
	});

	// The checks above read an administrator's answers, in which nothing is
	// withheld, and compare keys. A caller who cannot open a board is given its
	// work with nulls in it (card 2129): this holds each value to its type.
	it('work on a board the caller cannot open, as a dependency end and in a plan, holds to the type of each property', async () => {
		const { admin, board, first, second } = fixture();
		const viewer = makeUser();
		addBoardMember(board, viewer, 'viewer');
		const elsewhere = makeBoard({ owner: admin });
		const hidden = makeCard(elsewhere.cols['To Do']);
		const hiddenStep = makeSubtask(hidden);
		const milestone = makeMilestone({ board, createdBy: admin, cards: [first, second] });
		makeDependency({ blocked: first, blocker: hidden });
		makeDependency({ blocked: first, blocker: hiddenStep });
		// A member card moved to the other board keeps the milestone (found nearby 9), with a subtask that has a link.
		const movedStep = makeSubtask(second);
		makeDependency({ blocked: first, blocker: movedStep });
		db.update(cards).set({ columnId: elsewhere.cols['To Do'].id }).where(eq(cards.id, second.id)).run();

		const deps = await api('GET', `/api/v1/cards/${first.id}/dependencies`, { user: viewer });
		expect(deps.status).toBe(200);
		expect(deps.body.blockedBy).toHaveLength(3);
		expect(deps.body.blockedBy.map((end: Json) => end.withheld)).toEqual([true, true, true]);
		expect(typeFaults(answerSchema('GET /api/v1/cards/{cardId}/dependencies', 200), deps.body, 'dependencies')).toEqual([]);

		const summarySchema = answerSchema('GET /api/v1/milestones/{milestoneId}/summary', 200);
		const summary = await api('GET', `/api/v1/milestones/${milestone.id}/summary`, { user: viewer });
		expect(summary.status).toBe(200);
		const withheld = summary.body.graph.nodes.filter((n: Json) => n.withheld);
		expect(withheld.map((n: Json) => `${n.kind}:${n.id}`).sort()).toEqual(
			[`card:${hidden.id}`, `subtask:${hiddenStep.id}`, `card:${second.id}`, `subtask:${movedStep.id}`].sort()
		);
		// A withheld subtask has no `parentCardId`, as a card has none: SOMETIMES_ABSENT says so.
		for (const node of withheld) expect(keysOf(node)).toEqual(propertiesOf(summarySchema.properties.graph.properties.nodes.items).filter((key) => key !== 'parentCardId'));
		expect(summary.body.progress.boards).toContainEqual({ id: null, name: 'A board you cannot open', cardCount: 1 });
		expect(typeFaults(summarySchema, summary.body, 'summary')).toEqual([]);

		const compact = await api('GET', `/api/v1/milestones/${milestone.id}/summary?compact=true`, { user: viewer });
		expect(typeFaults(summarySchema, compact.body, 'compact summary')).toEqual([]);

		// The milestone's own read lists the moved card withheld too (card 2129's review).
		const detail = await api('GET', `/api/v1/milestones/${milestone.id}`, { user: viewer });
		expect(detail.status).toBe(200);
		expect(detail.body.cards.map((card: Json) => [card.id, card.withheld])).toEqual([
			[first.id, false],
			[second.id, true]
		]);
		expect(typeFaults(answerSchema('GET /api/v1/milestones/{milestoneId}', 200), detail.body, 'milestone')).toEqual([]);
	});

	it('GET /milestones/{milestoneId}/pdf: a PDF file when it succeeds, and JSON when it does not', async () => {
		const { admin, first } = fixture();
		const milestone = makeMilestone({ createdBy: admin, name: 'Security hardening', cards: [first] });
		const op = OPS.find((o) => o.name === 'GET /api/v1/milestones/{milestoneId}/pdf')!;

		const res = await api('GET', `/api/v1/milestones/${milestone.id}/pdf`, { user: admin });
		expect(res.status).toBe(200);
		expect(Object.keys(op.entry.responses['200'].content)).toEqual(['application/pdf']);
		expect(res.headers.get('content-type')).toBe('application/pdf');
		expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="plan-Security-hardening-\d{4}-\d{2}-\d{2}\.pdf"$/);
		expect(res.body.startsWith('%PDF-')).toBe(true);

		const missing = await api('GET', '/api/v1/milestones/999999/pdf', { user: admin });
		expect(missing.status).toBe(404);
		expect(keysOf(missing.body)).toEqual(propertiesOf(answerSchema(op.name, 404)));
	});

	// ─── Tokens ──────────────────────────────────────────────────────────────

	// The bodies sent are the document's own examples, and the answers are held to
	// its examples of the answers: an example that is not true fails here.
	it('token entries: one added to a card and one to a subtask, the card\'s list, and one removed', async () => {
		const { admin, first, second } = fixture();
		const step = makeSubtask(first);
		const onCard = 'POST /api/v1/cards/{cardId}/tokens';
		const onSubtask = 'POST /api/v1/subtasks/{subtaskId}/tokens';
		const list = 'GET /api/v1/cards/{cardId}/tokens';
		const remove = 'DELETE /api/v1/tokens/{entryId}';
		// A cost is a sum of fractions of a dollar: compared to ten places, and the rest exactly.
		const sameBut = (answer: Json, example: Json, ids: Json) => {
			expect({ ...answer, costUsd: null }).toEqual({ ...example, ...ids, costUsd: null });
			expect(answer.costUsd).toBeCloseTo(example.costUsd, 10);
		};

		const added = await api('POST', `/api/v1/cards/${first.id}/tokens`, { user: admin, body: requestExample(onCard) });
		expect(added.status).toBe(201);
		expect(keysOf(added.body)).toEqual(propertiesOf(answerSchema(onCard, 201)));
		sameBut(added.body, answerExample(onCard, 201), { entryId: added.body.entryId, cardId: first.id });

		const stepAdded = await api('POST', `/api/v1/subtasks/${step.id}/tokens`, { user: admin, body: requestExample(onSubtask) });
		expect(stepAdded.status).toBe(201);
		expect(keysOf(stepAdded.body)).toEqual(propertiesOf(answerSchema(onSubtask, 201)));
		expect(stepAdded.body).toEqual({
			...answerExample(onSubtask, 201),
			entryId: stepAdded.body.entryId,
			subtaskId: step.id,
			cardId: first.id
		});

		const read = await api('GET', `/api/v1/cards/${first.id}/tokens`, { user: admin });
		expect(read.status).toBe(200);
		const schema = answerSchema(list, 200);
		expect(keysOf(read.body)).toEqual(propertiesOf(schema));
		expect(keysOf(read.body.byModel[0])).toEqual(propertiesOf(schema.properties.byModel.items));
		expect(read.body.entryList).toHaveLength(2);
		for (const entry of read.body.entryList) expect(keysOf(entry)).toEqual(propertiesOf(schema.properties.entryList.items));
		// The example's two entries are these two, so its totals are these totals.
		const { entryList: exampleEntries, ...exampleTotals } = answerExample(list, 200);
		const { entryList: entries, ...totals } = read.body;
		sameBut(totals, exampleTotals, { cardId: first.id });
		expect(entries.map((e: Json) => ({ ...e, id: 0, cardId: 0, subtaskId: 0, subtaskTitle: '', createdAt: '' }))).toEqual(
			exampleEntries.map((e: Json) => ({ ...e, id: 0, cardId: 0, subtaskId: 0, subtaskTitle: '', createdAt: '' }))
		);

		const removed = await api('DELETE', `/api/v1/tokens/${stepAdded.body.entryId}`, { user: admin });
		expect(removed.status).toBe(200);
		expect(keysOf(removed.body)).toEqual(propertiesOf(answerSchema(remove, 200)));
		sameBut(removed.body, answerExample(remove, 200), { deleted: stepAdded.body.entryId, cardId: first.id });

		// A card nobody has reported on: the same shape, and `recorded` false.
		const unrecorded = await api('GET', `/api/v1/cards/${second.id}/tokens`, { user: admin });
		expect(keysOf(unrecorded.body)).toEqual(propertiesOf(schema));
		expect(unrecorded.body).toMatchObject({ recorded: false, entries: 0, entryList: [] });
	});

	it('POST /tokens/bulk: a batch that is recorded, and one that is rejected with every entry at fault', async () => {
		const { admin, board, first } = fixture();
		const step = makeSubtask(first);
		const name = 'POST /api/v1/tokens/bulk';
		const send = (user: Json, entries: Json) => api('POST', '/api/v1/tokens/bulk', { user, body: { entries } });

		// The document's example, to this card and this subtask of it.
		const body = requestExample(name);
		body.entries[0].cardId = first.id;
		body.entries[1].subtaskId = step.id;
		const made = await api('POST', '/api/v1/tokens/bulk', { user: admin, body });
		expect(made.status).toBe(201);
		const recorded = answerSchema(name, 201);
		expect(keysOf(made.body)).toEqual(propertiesOf(recorded));
		expect(keysOf(made.body.cardTotals[0])).toEqual(propertiesOf(recorded.properties.cardTotals.items));
		const example = answerExample(name, 201);
		example.boardsTouched = [board.id];
		example.cardTotals[0].cardId = first.id;
		expect(made.body).toEqual(example);

		const refused = await send(admin, [
			{ cardId: first.id, tokens: 100 },
			{ cardId: 999999, tokens: 100 },
			{ subtaskId: step.id, tokens: 0 }
		]);
		expect(refused.status).toBe(409);
		const rejected = answerSchema(name, 409);
		expect(keysOf(refused.body)).toEqual(propertiesOf(rejected));
		expect(refused.body.written).toBe(0);
		expect(refused.body.problems.map((p: Json) => p.index)).toEqual([1, 2]);
		expect(keysOf(refused.body.problems[0])).toEqual(propertiesOf(rejected.properties.problems.items));
		// Nothing was written, the entry that was acceptable included.
		expect((await api('GET', `/api/v1/cards/${first.id}/tokens`, { user: admin })).body.entries).toBe(2);

		// What READ_AND_NEVER_ANSWERED says of this operation: a card that is not there, and a
		// board the caller cannot edit, are entries at fault in a 409, and never a 404 or a 403.
		expect(READ_AND_NEVER_ANSWERED[name].statuses).toEqual([403, 404]);
		const missing = await send(admin, [{ cardId: 999999, tokens: 100 }]);
		expect(missing.status).toBe(409);
		expect(missing.body.problems).toEqual([{ index: 0, reason: 'Card #999999 does not exist' }]);
		const forbidden = await send(makeUser(), [{ cardId: first.id, tokens: 100 }]);
		expect(forbidden.status).toBe(409);
		expect(forbidden.body.problems).toEqual([{ index: 0, reason: `No edit access to the board holding card #${first.id}` }]);
	});

	// ─── Dependencies, of a subtask and in a batch ───────────────────────────

	it('a subtask\'s dependencies, as reading them, adding a link and removing one answer, and the two links that are refused', async () => {
		const { admin, first, second } = fixture();
		const step = makeSubtask(first);
		const path = `/api/v1/subtasks/${step.id}/dependencies`;
		const name = (method: string) => `${method} /api/v1/subtasks/{subtaskId}/dependencies`;

		const added = await api('POST', path, { user: admin, body: { dependsOnCardId: second.id } });
		expect(added.status).toBe(201);
		const state = answerSchema(name('POST'), 201);
		expect(keysOf(added.body)).toEqual(propertiesOf(state));
		expect(added.body.blockedBy).toHaveLength(1);
		expect(keysOf(added.body.blockedBy[0])).toEqual(propertiesOf(state.properties.blockedBy.items));
		expect(added.body).toMatchObject({ subtaskId: step.id, cardId: first.id, isBlocked: true, blocks: [] });

		const read = await api('GET', path, { user: admin });
		expect(read.status).toBe(200);
		expect(keysOf(read.body)).toEqual(propertiesOf(answerSchema(name('GET'), 200)));
		expect(read.body).toEqual(added.body);

		// Both refusals are 409 and share the card route's schema: `cycle` is there for a loop only.
		const conflict = answerSchema(name('POST'), 409);
		const again = await api('POST', path, { user: admin, body: { dependsOnCardId: second.id } });
		expect(again.status).toBe(409);
		expect(keysOf(again.body)).toEqual(['message']);
		const loop = await api('POST', path, { user: admin, body: { blocksCardId: second.id } });
		expect(loop.status).toBe(409);
		expect(keysOf(loop.body)).toEqual(propertiesOf(conflict));
		expect(keysOf(loop.body.cycle[0])).toEqual(propertiesOf(conflict.properties.cycle.items));

		const removed = await api('DELETE', path, { user: admin, body: { dependsOnCardId: second.id } });
		expect(removed.status).toBe(200);
		expect(keysOf(removed.body)).toEqual(propertiesOf(answerSchema(name('DELETE'), 200)));
		expect(removed.body).toMatchObject({ isBlocked: false, blockedBy: [], blocks: [] });

		const gone = await api('DELETE', path, { user: admin, body: { dependsOnCardId: second.id } });
		expect(gone.status).toBe(404);
	});

	it('POST /dependencies/bulk: a batch that is recorded, and three that are rejected', async () => {
		const { admin, cols, first, second } = fixture();
		const third = makeCard(cols['To Do']);
		const step = makeSubtask(third);
		const name = 'POST /api/v1/dependencies/bulk';
		const send = (user: Json, body: Json) => api('POST', '/api/v1/dependencies/bulk', { user, body });

		// `second` waits on `first`, and a subtask waits on `second`: the three ways of writing an end.
		const made = await send(admin, {
			links: [
				{ blocked: second.id, blocker: first.id },
				{ blocked: `subtask:${step.id}`, blocker: { kind: 'card', id: second.id } }
			]
		});
		expect(made.status).toBe(201);
		const created = answerSchema(name, 201);
		expect(keysOf(made.body)).toEqual(propertiesOf(created));
		expect(made.body).toMatchObject({ created: 2, skippedAsDuplicate: 0 });
		for (const link of made.body.links) expect(keysOf(link)).toEqual(propertiesOf(created.properties.links.items));
		expect(made.body.links[1]).toEqual({ blocked: step.id, blockedType: 'subtask', blocker: second.id, blockerType: 'card' });

		// The same batch again is not a fault: every link is skipped, and it is still a 201.
		const again = await send(admin, { chain: [first.id, second.id] });
		expect(again.status).toBe(201);
		expect(again.body).toMatchObject({ created: 0, skippedAsDuplicate: 1, links: [] });

		const rejected = answerSchema(name, 409);
		const item = rejected.properties.rejected.items;

		// A chain that closes a loop: `first` would wait on the subtask, which waits on `second`, which waits on `first`.
		const loop = await send(admin, { chain: [`subtask:${step.id}`, first.id] });
		expect(loop.status).toBe(409);
		expect(keysOf(loop.body)).toEqual(propertiesOf(rejected));
		expect(sorted(rejected.required)).toEqual(propertiesOf(rejected));
		expect(loop.body.rejected).toHaveLength(1);
		expect(keysOf(loop.body.rejected[0])).toEqual(propertiesOf(item));
		expect(loop.body.rejected[0].reason).toBe('cycle');
		expect(keysOf(loop.body.rejected[0].link)).toEqual(propertiesOf(item.properties.link));
		expect(keysOf(loop.body.rejected[0].cycle[0])).toEqual(propertiesOf(item.properties.cycle.items));

		// An end that is not there is a reason in the 409, with no `cycle`, and not a 404.
		const missing = await send(admin, { links: [{ blocked: first.id, blocker: 999999 }] });
		expect(missing.status).toBe(409);
		expect(keysOf(missing.body.rejected[0])).toEqual(propertiesOf(item).filter((key) => key !== 'cycle'));
		expect(item.properties.reason.enum).toContain(missing.body.rejected[0].reason);

		// And a board the caller cannot edit is `forbidden` in the 409, and not a 403.
		const forbidden = await send(makeUser(), { links: [{ blocked: third.id, blocker: first.id }] });
		expect(forbidden.status).toBe(409);
		expect(forbidden.body.rejected).toEqual([]);
		expect(forbidden.body.forbidden).toHaveLength(1);
		expect(keysOf(forbidden.body.forbidden[0])).toEqual(propertiesOf(rejected.properties.forbidden.items));
	});

	// ─── Reports ─────────────────────────────────────────────────────────────

	it('GET /reports/activity: with no parameters, and with everything it can include', async () => {
		const { admin, board, cols, first } = fixture();
		const done = makeCard(cols['Complete'], { completedAt: stamp() });
		makeMilestone({ board, cards: [done] });
		makeSubtask(first);
		makeComment(first, admin);

		const schema = answerSchema('GET /api/v1/reports/activity', 200);
		const boardSchema = deref(schema.properties.boards.items);
		const cardSchema = deref(boardSchema.properties.cards.items);
		const cardOf = (report: Json) => report.boards[0].cards.find((c: Json) => c.id === first.id);

		const bare = await api('GET', '/api/v1/reports/activity', { user: admin });
		expect(bare.status).toBe(200);
		expect(keysOf(bare.body)).toEqual(propertiesOf(schema));
		expect(bare.body.user).toBeNull();
		for (const key of ['period', 'totals', 'meta']) expect(keysOf(bare.body[key])).toEqual(propertiesOf(schema.properties[key]));
		expect(bare.body.boards).toHaveLength(1);
		expect(keysOf(bare.body.boards[0])).toEqual(propertiesOf(boardSchema));
		expect(keysOf(bare.body.boards[0].totals)).toEqual(propertiesOf(boardSchema.properties.totals));
		// Without `include` a card has its subtask counts and neither list.
		expect(keysOf(cardOf(bare.body))).toEqual(propertiesOf(cardSchema).filter((key) => key !== 'comments'));
		expect(keysOf(cardOf(bare.body).subtasks)).toEqual(propertiesOf(cardSchema.properties.subtasks).filter((key) => key !== 'items'));
		expect(cardSchema.properties.bucket.enum).toContain(cardOf(bare.body).bucket);
		// The milestone whose one card was completed in the window.
		expect(bare.body.milestones).toHaveLength(1);
		expect(keysOf(bare.body.milestones[0])).toEqual(propertiesOf(schema.properties.milestones.items));

		const full = await api('GET', `/api/v1/reports/activity?userId=${admin.id}&include=subtasks,comments&commentLimit=5`, { user: admin });
		expect(full.status).toBe(200);
		expect(keysOf(full.body.user)).toEqual(propertiesOf(schema.properties.user));
		expect(keysOf(cardOf(full.body))).toEqual(propertiesOf(cardSchema));
		expect(keysOf(cardOf(full.body).subtasks)).toEqual(propertiesOf(cardSchema.properties.subtasks));
		expect(keysOf(cardOf(full.body).subtasks.items[0])).toEqual(propertiesOf(cardSchema.properties.subtasks.properties.items.items));
		expect(keysOf(cardOf(full.body).comments[0])).toEqual(propertiesOf(cardSchema.properties.comments.items));
	});

	it('GET /cards/{cardId}/board-history', async () => {
		const { admin, board, first } = fixture();

		const res = await api('GET', `/api/v1/cards/${first.id}/board-history`, { user: admin });

		expect(res.status).toBe(200);
		const schema = answerSchema('GET /api/v1/cards/{cardId}/board-history', 200);
		expect(keysOf(res.body)).toEqual(propertiesOf(schema));
		expect(res.body.history).toHaveLength(1);
		expect(keysOf(res.body.history[0])).toEqual(propertiesOf(schema.properties.history.items));
		expect(res.body.history[0]).toMatchObject({ boardId: board.id, to: null, current: true });
	});

	// ─── The document itself ─────────────────────────────────────────────────

	it('GET /openapi.json: answered to a caller with no key, as version 1.2.0, and listing itself', async () => {
		const name = 'GET /api/v1/openapi.json';

		// No user: the one route under /api/v1/ that is reached without a key.
		const res = await api('GET', '/api/v1/openapi.json');

		expect(res.status).toBe(200);
		expect(res.body.info.version).toBe('1.2.0');
		const schema = answerSchema(name, 200);
		expect(keysOf(res.body)).toEqual(propertiesOf(schema));
		expect(keysOf(res.body.info)).toEqual(propertiesOf(schema.properties.info));
		expect(res.headers.get('cache-control')).toBe('public, max-age=10');
		expect(res.headers.get('access-control-allow-origin')).toBe('*');

		// It lists itself, as the one operation that needs no key and so has neither a 401 nor a 429.
		const itself = res.body.paths['/api/v1/openapi.json'].get;
		expect(itself.security).toEqual([]);
		expect(sorted(Object.keys(itself.responses))).toEqual(['200', '500']);
		expect(OPS.filter(isPublic).map((op) => op.name)).toEqual([name]);
		// And under a tag, so that the /docs page lists it too.
		expect(res.body.tags.map((t: Json) => t.name)).toContain(itself.tags[0]);
	});

	// ─── What is said in words, and can be tried ─────────────────────────────

	it('GET /reports/activity: commentLimit=0 gives each card an empty `comments` list, and a negative one is a 400, as the document says', async () => {
		const { admin, first } = fixture();
		makeComment(first, admin);
		const cardOf = (report: Json) => report.boards[0].cards.find((c: Json) => c.id === first.id);

		const some = await api('GET', '/api/v1/reports/activity?include=comments', { user: admin });
		expect(cardOf(some.body).comments).toHaveLength(1);

		// 0 was read as 3, and -1 left the key out (card 2117, decision 17).
		const none = await api('GET', '/api/v1/reports/activity?include=comments&commentLimit=0', { user: admin });
		expect(none.status).toBe(200);
		expect(cardOf(none.body).comments).toEqual([]);

		const negative = await api('GET', '/api/v1/reports/activity?include=comments&commentLimit=-1', { user: admin });
		expect(negative.status).toBe(400);
		expect(negative.body).toEqual({ message: 'commentLimit must be a whole number of 0 or more' });

		const said = OPS.find((o) => o.name === 'GET /api/v1/reports/activity')!.entry.parameters.find((p: Json) => p.name === 'commentLimit');
		expect(said.description).toMatch(/0 gives each card an empty `comments` list/);
		expect(said.description).toMatch(/negative number, or one that is not whole, is 400/);
	});

	it('POST /dependencies/bulk: a link written as cardId and dependsOnCardId, which the document lists beside blocked and blocker', async () => {
		const { admin, first, second } = fixture();
		const link = OPS.find((o) => o.name === 'POST /api/v1/dependencies/bulk')!.entry.requestBody.content['application/json'].schema.properties.links.items;
		// Every spelling the handler reads, and no other.
		expect(propertiesOf(link)).toEqual(['blocked', 'blockedType', 'blocker', 'blockerType', 'cardId', 'dependsOnCardId']);

		const made = await api('POST', '/api/v1/dependencies/bulk', { user: admin, body: { links: [{ cardId: second.id, dependsOnCardId: first.id }] } });

		expect(made.status).toBe(201);
		expect(made.body.links).toEqual([{ blocked: second.id, blockedType: 'card', blocker: first.id, blockerType: 'card' }]);
	});

	// ─── The rest ────────────────────────────────────────────────────────────

	// No test above asks anything of these answers. Each is called once here, so that `api`
	// holds it to its `required`: a row answered whole, and the burndown at every depth.
	it('the operations no test above calls: each answer has what its schema says is always there', async () => {
		const { admin, board, cols, first, second } = fixture();
		const label = makeLabel(board);
		const step = makeSubtask(first);
		const comment = makeComment(first, admin);
		assignCard(first, admin);
		makeCard(cols['Complete'], { completedAt: stamp() });
		// A second board with open work, so that the burndown spans two and estimates each.
		makeCard(makeBoard({ owner: admin }).cols['To Do']);

		/** Call it, and return what was answered. A refusal fails the test with the call that was refused. */
		const ok = async (method: Parameters<typeof api>[0], path: string, body?: Json) => {
			const res = await api(method, path, { user: admin, body });
			expect(`${method} ${path}: ${res.status}`).toMatch(/: 20[01]$/);
			return res.body;
		};

		expect((await ok('GET', '/api/v1/me')).id).toBe(admin.id);
		expect(await ok('GET', '/api/v1/boards')).toHaveLength(2);

		expect(await ok('GET', `/api/v1/boards/${board.id}/columns`)).toHaveLength(Object.keys(cols).length);
		const column = await ok('POST', `/api/v1/boards/${board.id}/columns`, { title: 'Review' });
		await ok('GET', `/api/v1/columns/${column.id}`);
		await ok('PUT', `/api/v1/columns/${column.id}`, { wipLimit: 3 });
		await ok('DELETE', `/api/v1/columns/${column.id}`);

		expect(await ok('GET', `/api/v1/cards/${first.id}/assignees`)).toHaveLength(1);
		await ok('POST', `/api/v1/cards/${second.id}/assignees`, { userId: admin.id });
		await ok('DELETE', `/api/v1/cards/${second.id}/assignees`, { userId: admin.id });

		expect(await ok('GET', `/api/v1/cards/${first.id}/subtasks`)).toHaveLength(1);
		const made = await ok('POST', `/api/v1/cards/${first.id}/subtasks`, { title: 'A step' });
		await ok('PUT', `/api/v1/subtasks/${step.id}`, { completed: true });
		await ok('DELETE', `/api/v1/subtasks/${made.id}`);

		expect(await ok('GET', `/api/v1/cards/${first.id}/comments`)).toHaveLength(1);
		const said = await ok('POST', `/api/v1/cards/${first.id}/comments`, { content: 'Said' });
		await ok('GET', `/api/v1/comments/${comment.id}`);
		await ok('PUT', `/api/v1/comments/${comment.id}`, { content: 'Said again' });
		await ok('DELETE', `/api/v1/comments/${said.id}`);

		expect(await ok('GET', `/api/v1/boards/${board.id}/labels`)).toHaveLength(1);
		const urgent = await ok('POST', `/api/v1/boards/${board.id}/labels`, { name: 'Urgent' });
		await ok('GET', `/api/v1/labels/${label.id}`);
		await ok('PUT', `/api/v1/labels/${label.id}`, { name: 'Soon' });
		await ok('POST', `/api/v1/cards/${first.id}/labels`, { labelId: label.id });
		expect(await ok('GET', `/api/v1/cards/${first.id}/labels`)).toHaveLength(1);
		await ok('DELETE', `/api/v1/cards/${first.id}/labels`, { labelId: label.id });
		await ok('DELETE', `/api/v1/labels/${urgent.id}`);

		const category = await ok('POST', `/api/v1/boards/${board.id}/categories`, { name: 'Bug' });
		expect(await ok('GET', `/api/v1/boards/${board.id}/categories`)).toHaveLength(1);
		await ok('GET', `/api/v1/categories/${category.id}`);
		await ok('PUT', `/api/v1/categories/${category.id}`, { name: 'Fault' });
		await ok('DELETE', `/api/v1/categories/${category.id}`);

		const grouping = await ok('POST', '/api/v1/board-categories', { name: 'Clients' });
		expect(await ok('GET', '/api/v1/board-categories')).toHaveLength(1);
		await ok('GET', `/api/v1/board-categories/${grouping.id}`);
		await ok('PUT', `/api/v1/board-categories/${grouping.id}`, { name: 'Customers' });
		// The burndown of a board category, so that its `scope.boardCategory` is not null and is held
		// to its schema at every depth (card 2254's review).
		await ok('PUT', `/api/v1/boards/${board.id}`, { categoryId: grouping.id });
		const ofGrouping = await ok('GET', `/api/v1/burndown?boardCategoryId=${grouping.id}`);
		expect(ofGrouping.scope.boardCategory).toMatchObject({ id: grouping.id, name: 'Customers' });
		await ok('PUT', `/api/v1/boards/${board.id}`, { categoryId: null });
		await ok('DELETE', `/api/v1/board-categories/${grouping.id}`);

		// The one who has just created a webhook, and an administrator, are shown its secret.
		const hook = await ok('POST', `/api/v1/boards/${board.id}/webhooks`, { url: 'https://example.com/hook', secret: 's3cret', events: ['card.created'] });
		expect(hook.secret).toBe('s3cret');
		expect(await ok('GET', `/api/v1/boards/${board.id}/webhooks`)).toHaveLength(1);
		await ok('GET', `/api/v1/webhooks/${hook.id}`);
		await ok('PUT', `/api/v1/webhooks/${hook.id}`, { active: false });
		await ok('DELETE', `/api/v1/webhooks/${hook.id}`);

		// The burndown as it is with nothing asked, and with a group for each board, a target and the options.
		const plain = await ok('GET', '/api/v1/burndown');
		expect(plain.target).toBeNull();
		expect('options' in plain).toBe(false);
		const grouped = await ok('GET', '/api/v1/burndown?groupBy=board&target=2030-01-01&options=true');
		expect(grouped.groups).toHaveLength(2);
		expect(grouped.target.source).toBe('query');
		expect(grouped.delivery.method).toBe('slowest-board');
		expect(grouped.delivery.parts.length).toBeGreaterThan(0);
		// And of a milestone, so that its `scope.milestone` is not null.
		const goal = makeMilestone({ board, createdBy: admin, cards: [first] });
		const ofGoal = await ok('GET', `/api/v1/burndown?milestoneId=${goal.id}`);
		expect(ofGoal.scope.milestone).toMatchObject({ id: goal.id, name: goal.name, boardId: board.id });

		await ok('DELETE', `/api/v1/cards/${second.id}`);
		await ok('DELETE', `/api/v1/boards/${board.id}`);
	});

	// ─── Every call above ────────────────────────────────────────────────────

	it('held every answer above to the `required` lists of its schema and to the properties it lists, in every operation the document has', () => {
		// `api` in this file asks both of each call. This says that it was asked, and of what: an answer of
		// every operation. For the one that answers a file, the answer held is its 404, which is JSON.
		// It reads what the tests above it did, so it is run with them and not alone.
		const notHeld = OPS.map((op) => op.name).filter((name) => !heldToRequired.operations.has(name));
		expect(notHeld).toEqual([]);
		// 110 answers when this was written.
		expect(heldToRequired.answers).toBeGreaterThanOrEqual(100);
	});
});
