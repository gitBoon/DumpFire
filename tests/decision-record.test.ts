/**
 * A decision's permanent record and lifecycle (card 2675, slice 1): the
 * insert-only rule, read from the source; the status every reader shows and
 * the query that agrees with it; the transitions; the record's reads; and the
 * personal link's resolver and expiry.
 *
 * The modules are `src/lib/server/decision-record.ts`, `decision-status.ts`
 * and `decision-links.ts`. They take no caller and are called here directly.
 * The cases are the plan's, `docs/planning/card-2675-decision-service.md`,
 * section 6, by number.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isHttpError } from '@sveltejs/kit';
import ts from 'typescript';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, sqlite } from '$lib/server/db';
import { decisions, type Decision } from '$lib/server/db/schema';
import { appendEvent, appendVersion, currentRound, SYSTEM_ACTOR } from '$lib/server/decision-record';
import { issueLink, participantForLink } from '$lib/server/decision-links';
import { awaitingRulingSql, decisionStatus, linkUsable, requireTransition, TRANSITIONS } from '$lib/server/decision-status';
import { stamp } from '$lib/timestamps';
import { linkHashOf, makeDecision, makeParticipant, makePerson, makeUser, resetDb } from './helpers/fixtures';

const ROOT = process.cwd();

beforeEach(resetDb);

// ─── The insert-only scan (decision 27, R6) ──────────────────────────────────

/**
 * The insert-only tables, as SQL names them and as the schema exports them:
 * the decision record's four, and `people_changes`, the record of every change
 * to the people directory (card 2681, migration 0064, the code review's S1).
 */
const RECORD_TABLES: Readonly<Record<string, string>> = {
	decisionVersions: 'decision_versions',
	decisionResponses: 'decision_responses',
	decisionRulings: 'decision_rulings',
	decisionEvents: 'decision_events',
	peopleChanges: 'people_changes'
};

/** The people directory's record (card 2681): the one table of RECORD_TABLES that is not the decision record's. */
const PEOPLE_RECORD = 'people_changes';

/**
 * The settled-once table (card 2678, decision 7), as SQL names it and as the
 * schema exports it: inserted once, in the two files that may insert, and
 * updated only by the record module's three guarded updates, each one's
 * `.set` keys and `WHERE` guard pinned in `SETTLED_UPDATES`. Never deleted
 * but by the cascade, the restore and the generic writers, as the four are.
 */
const SETTLED_TABLES: Readonly<Record<string, string>> = {
	decisionQuestions: 'decision_questions'
};

/** Each record table, the settled-once table and `decisions` by its SQL name, as the schema exports it: what `sql.identifier('decision_events')` names. */
const SQL_EXPORTS: Readonly<Record<string, string>> = {
	...Object.fromEntries(Object.entries({ ...RECORD_TABLES, ...SETTLED_TABLES }).map(([exported, name]) => [name, exported])),
	decisions: 'decisions'
};

/** The one file that may update the settled-once table, by the updates pinned below. */
const SETTLED_WRITER = 'src/lib/server/decision-record.ts';

/**
 * The settled-once table's updates, by the function each is in (card 2678,
 * decision 7, S4): the keys its `.set` writes, a literal boolean value with
 * its key, and its `WHERE` guard, as written with the white space taken out.
 * Each changes the row only from the state its guard names, and either
 * settling of a draft leaves the row outside both draft guards.
 */
const SETTLED_UPDATES: Readonly<Record<string, { set: string[]; where: string }>> = {
	recordAnswer: {
		set: ['answer', 'answerAgentDrafted', 'answeredAt', 'answeredBy', 'answeredByName'],
		where: 'and(eq(decisionQuestions.id,questionId),isNull(decisionQuestions.answer))'
	},
	recordDraftPublished: {
		set: ['answerReviewedAt', 'answerReviewedBy'],
		where:
			'and(eq(decisionQuestions.id,questionId),isNotNull(decisionQuestions.answer),eq(decisionQuestions.answerAgentDrafted,true),isNull(decisionQuestions.answerReviewedAt))'
	},
	recordDraftReplaced: {
		set: ['answer', 'answerAgentDrafted:false', 'answeredAt', 'answeredBy', 'answeredByName'],
		where: 'and(eq(decisionQuestions.id,questionId),eq(decisionQuestions.answerAgentDrafted,true),isNull(decisionQuestions.answerReviewedAt))'
	}
};

/** The files that may hold a decision record table's name, or the settled-once table's, as text. */
const NAMES_ALLOWED = [
	'src/lib/server/db/schema.ts',
	'src/lib/server/db/expected-schema.ts',
	'src/lib/server/decision-record.ts',
	'src/lib/server/db/restore.ts'
];

/** The files that may hold `people_changes` as text: the model and its export alone (card 2681). */
const PEOPLE_NAMES_ALLOWED = ['src/lib/server/db/schema.ts', 'src/lib/server/db/expected-schema.ts'];

/** The files that may insert into a decision record table. */
const INSERTS_ALLOWED = ['src/lib/server/decision-record.ts', 'src/lib/server/db/restore.ts'];

/** The one file that may insert into `people_changes`, by its one insert, `recordChange` (card 2681, the code review's S1). */
const PEOPLE_INSERTS_ALLOWED = ['src/lib/server/people.ts'];

/** The files that may hold a record table's name as text, and that may insert into it, by its SQL name. */
const namesAllowedFor = (sqlName: string) => (sqlName === PEOPLE_RECORD ? PEOPLE_NAMES_ALLOWED : NAMES_ALLOWED);
const insertsAllowedFor = (sqlName: string) => (sqlName === PEOPLE_RECORD ? PEOPLE_INSERTS_ALLOWED : INSERTS_ALLOWED);

/** The one file that may delete a decision, which cascades through its record: the lifecycle service's (card 2713, D6 row 12). */
const DECISION_DELETES_ALLOWED = 'src/lib/server/decision-lifecycle-writes.ts';

/** A record table's name, or the settled-once table's, as text. `idx_decision_events_…` and `idx_people_changes_…` are indexes' names, not the tables'. */
const NAMES_A_TABLE = /\b(decision_(?:versions|responses|rulings|events|questions)|people_changes)\b/g;

/** A record table's name, or the settled-once table's, in SQL, quoted or not: SQL may not update either (card 2678, S4). */
const TABLE = '[`"\\[]?(decision_(?:versions|responses|rulings|events|questions)|people_changes)[`"\\]]?(?![\\w])';

/** What SQL may not do to a record table anywhere, by what the finding calls it. */
const SQL_WRITES: readonly [string, RegExp][] = [
	['SQL UPDATE', new RegExp(`\\bUPDATE\\s+(?:OR\\s+\\w+\\s+)?${TABLE}`, 'i')],
	['SQL DELETE FROM', new RegExp(`\\bDELETE\\s+FROM\\s+${TABLE}`, 'i')],
	['SQL REPLACE INTO', new RegExp(`\\bREPLACE\\s+INTO\\s+${TABLE}`, 'i')],
	['SQL INSERT OR …', new RegExp(`\\bINSERT\\s+OR\\s+\\w+\\s+INTO\\s+${TABLE}`, 'i')],
	['SQL ON CONFLICT', new RegExp(`\\bINSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${TABLE}[\\s\\S]*\\bON\\s+CONFLICT\\b`, 'i')]
];

/** An SQL insert into a record table, the table's name its first group. Global: read with `matchAll`. */
const SQL_INSERT = new RegExp(`\\bINSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${TABLE}`, 'gi');

/** An SQL delete of decisions. */
const SQL_DELETE_DECISIONS = /\bDELETE\s+FROM\s+[`"[]?decisions[`"\]]?(?![\w])/i;

/**
 * SQL that writes a table named only at run time: `UPDATE "${table}" SET`,
 * `DELETE FROM ${t}`, `INSERT INTO ${quoted(t)}`, as the scan reads a
 * template, each name it cannot resolve written `${…}`. Such a writer walks
 * tables it reads from `sqlite_master` or a list, the record's among them,
 * where the scan cannot see which (the code review's S5).
 */
const GENERIC_WRITE = /\b(?:UPDATE\s+(?:OR\s+\w+\s+)?[`"[]?\$\{…\}[`"\]]?\s+SET|DELETE\s+FROM\s+[`"[]?\$\{…\}|(?:INSERT\s+(?:OR\s+\w+\s+)?|REPLACE\s+)INTO\s+[`"[]?\$\{…\})/i;

/**
 * The files that write a table named only at run time, each with why it may
 * reach a record table (S5). A new one fails the scan until it is named here,
 * and one named here that no longer is one fails it too.
 */
const GENERIC_WRITERS: Readonly<Record<string, string>> = {
	'src/lib/server/db/timestamps.ts':
		"normaliseTimestamps, which migrate.ts runs at every start: it brings every moment in every table's `_at` columns to the stored form, " +
		'the same moment to the second, so a record row says what it said.',
	'src/lib/server/db/migrate.ts':
		"A migration's rebuild of a table, every row copied to the new shape and back as it was, and its probes of a column on a scratch table.",
	'src/lib/server/db/restore.ts': "The restore's wholesale replacement (plan 4.8): every table cleared and copied whole from the backup, or nothing committed.",
	'src/routes/api/admin/reset/+server.ts':
		"The superadmin's reset, which empties every table but the system log and the backup log: the record goes whole, with its decisions, " +
		'and people_changes with the directory it records (card 2681).',
	'src/lib/server/deletes.ts':
		"USER_REFERENCES, a list written out whose names the scan reads as text (a record table's name there is a finding): it names none."
};

type ScanFile = { file: string; source: string };
type Scan = { findings: string[]; inserts: string[]; generic: string[]; settledInserts: string[]; settledUpdates: string[] };

/**
 * What one `.update(<the settled-once table>)` chain writes (card 2678, S4):
 * the function it is in, the keys of its `.set`, each literal boolean value
 * written with its key, sorted, and its `.where`'s guard with the white space
 * taken out (`<none>` for no `.where`).
 */
function settledUpdateOf(update: ts.CallExpression, tree: ts.SourceFile): { fn: string; set: string[]; where: string } {
	let set: ts.Expression | undefined;
	let where: ts.Expression | undefined;
	let link: ts.Node = update;
	while (ts.isPropertyAccessExpression(link.parent) && ts.isCallExpression(link.parent.parent) && link.parent.parent.expression === link.parent) {
		const call = link.parent.parent;
		if (link.parent.name.text === 'set') set = call.arguments[0];
		if (link.parent.name.text === 'where') where = call.arguments[0];
		link = call;
	}
	let fn = '<top level>';
	for (let up: ts.Node | undefined = update.parent; up !== undefined; up = up.parent) {
		if ((ts.isFunctionDeclaration(up) || ts.isFunctionExpression(up)) && up.name) {
			fn = up.name.text;
			break;
		}
		if ((ts.isArrowFunction(up) || ts.isFunctionExpression(up)) && ts.isVariableDeclaration(up.parent) && ts.isIdentifier(up.parent.name)) {
			fn = up.parent.name.text;
			break;
		}
	}
	const keys: string[] = [];
	if (set === undefined || !ts.isObjectLiteralExpression(set)) {
		keys.push('<not an object written out>');
	} else {
		for (const property of set.properties) {
			if (ts.isShorthandPropertyAssignment(property)) keys.push(property.name.text);
			else if (ts.isPropertyAssignment(property)) {
				const name = property.name.getText(tree);
				const value = property.initializer.kind;
				keys.push(value === ts.SyntaxKind.TrueKeyword ? `${name}:true` : value === ts.SyntaxKind.FalseKeyword ? `${name}:false` : name);
			} else keys.push(`<${property.getText(tree)}>`);
		}
	}
	return { fn, set: keys.sort(), where: where === undefined ? '<none>' : where.getText(tree).replace(/\s+/g, '') };
}

/**
 * Every way the source could write a record table other than by an insert
 * where one is allowed, or delete a decision outside its service: Drizzle's
 * `.update(`, `.delete(` and `onConflict…` on the tables, an insert outside
 * the two files allowed it, a table's name as text outside the files allowed
 * it, and SQL text that updates, deletes, replaces or upserts. A table is
 * known by its import, renamed or not, a `const` alias, a property or an
 * element of a namespace, and `sql.identifier` or `sql.raw` of its name (S5).
 * A write to a table named only at run time is a finding outside
 * `GENERIC_WRITERS`, and `generic` names each file seen making one. A
 * `.svelte` file's scripts are read as TypeScript. `inserts` names each file
 * seen inserting into a record table, so that a scan that sees nothing fails.
 */
function scanRecordWrites(files: ScanFile[]): Scan {
	const findings: string[] = [];
	const inserts: string[] = [];
	const generic: string[] = [];
	const settledInserts: string[] = [];
	const settledUpdates: string[] = [];
	for (const { file, source } of files) {
		for (const { code, firstLine } of scriptsOf(file, source)) {
			const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
			const at = (node: ts.Node) => `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + firstLine}`;

			// What each local name stands for: a record table, `decisions`, or neither.
			const aliases = new Map<string, string>();
			for (const statement of tree.statements) {
				const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
				if (!bindings || !ts.isNamedImports(bindings)) continue;
				for (const element of bindings.elements) {
					const exported = (element.propertyName ?? element.name).text;
					if (exported in RECORD_TABLES || exported in SETTLED_TABLES || exported === 'decisions') aliases.set(element.name.text, exported);
				}
			}
			const isExport = (name: string) => name in RECORD_TABLES || name in SETTLED_TABLES || name === 'decisions';
			/**
			 * The schema export an expression names: `decisionEvents`, `schema.decisionEvents`,
			 * `schema['decisionEvents']`, `sql.identifier('decision_events')` or `sql.raw(…)` of one,
			 * or an alias of one, imported or a `const` (S5).
			 */
			const named = (node: ts.Node | undefined): string | undefined => {
				if (!node) return undefined;
				if (ts.isIdentifier(node)) return aliases.get(node.text) ?? (isExport(node.text) ? node.text : undefined);
				if (ts.isPropertyAccessExpression(node)) return isExport(node.name.text) ? node.name.text : undefined;
				if (ts.isElementAccessExpression(node)) {
					const key = node.argumentExpression;
					return ts.isStringLiteralLike(key) && isExport(key.text) ? key.text : undefined;
				}
				if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return named(node.expression);
				if (
					ts.isCallExpression(node) &&
					ts.isPropertyAccessExpression(node.expression) &&
					(node.expression.name.text === 'identifier' || node.expression.name.text === 'raw') &&
					ts.isIdentifier(node.expression.expression) &&
					node.expression.expression.text === 'sql'
				) {
					const argument = node.arguments[0];
					if (argument === undefined || !ts.isStringLiteralLike(argument)) return undefined;
					return SQL_EXPORTS[argument.text.replace(/[`"[\]]/g, '').trim()];
				}
				return undefined;
			};
			// `const t = decisionEvents`, and an alias of an alias: until nothing more is found.
			let more = true;
			const collectAliases = (node: ts.Node): void => {
				if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && !aliases.has(node.name.text)) {
					const target = named(node.initializer);
					if (target !== undefined) {
						aliases.set(node.name.text, target);
						more = true;
					}
				}
				ts.forEachChild(node, collectAliases);
			};
			while (more) {
				more = false;
				collectAliases(tree);
			}
			/** The `.insert(…)` call a chain is built on, if there is one. */
			const insertUnder = (node: ts.Expression): ts.CallExpression | undefined => {
				let inner: ts.Expression = node;
				while (true) {
					if (ts.isCallExpression(inner)) {
						if (ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === 'insert') return inner;
						inner = inner.expression;
					} else if (ts.isPropertyAccessExpression(inner)) {
						inner = inner.expression;
					} else {
						return undefined;
					}
				}
			};
			const checkText = (node: ts.Node, literal: string, withTables: string) => {
				// Each table by its own list (card 2681): people_changes' name and inserts are allowed in fewer files.
				for (const [, sqlName] of literal.matchAll(NAMES_A_TABLE)) {
					if (!namesAllowedFor(sqlName).includes(file)) findings.push(`${at(node)} names a record table as text`);
				}
				for (const [what, pattern] of SQL_WRITES) if (pattern.test(withTables)) findings.push(`${at(node)} ${what} on a record table`);
				for (const [, sqlName] of withTables.matchAll(SQL_INSERT)) {
					if (insertsAllowedFor(sqlName.toLowerCase()).includes(file)) inserts.push(file);
					else findings.push(`${at(node)} SQL INSERT into a record table`);
				}
				if (SQL_DELETE_DECISIONS.test(withTables) && file !== DECISION_DELETES_ALLOWED) findings.push(`${at(node)} SQL DELETE FROM decisions`);
				if (GENERIC_WRITE.test(withTables)) {
					generic.push(file);
					if (!(file in GENERIC_WRITERS)) findings.push(`${at(node)} writes a table named only at run time: name the table, or put the file on GENERIC_WRITERS with why`);
				}
			};

			const visit = (node: ts.Node): void => {
				if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
					checkText(node, node.text, node.text);
				} else if (ts.isTemplateExpression(node)) {
					// The text, and the text with each table written in as SQL would hold it: sql`UPDATE ${decisionEvents} …`.
					const literal = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
					const exported = (span: ts.TemplateSpan) => named(span.expression);
					const withTables =
						node.head.text +
						node.templateSpans
							.map((span) => {
								const name = exported(span);
								return (name === undefined ? '${…}' : (RECORD_TABLES[name] ?? SETTLED_TABLES[name] ?? name)) + span.literal.text;
							})
							.join('');
					checkText(node, literal, withTables);
				} else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
					const method = node.expression.name.text;
					const target = named(node.arguments[0]);
					if ((method === 'update' || method === 'delete') && target !== undefined && target in RECORD_TABLES) {
						findings.push(`${at(node)} .${method}(${target})`);
					}
					if (method === 'delete' && target === 'decisions' && file !== DECISION_DELETES_ALLOWED) findings.push(`${at(node)} .delete(decisions)`);
					if (method === 'insert' && target !== undefined && target in RECORD_TABLES) {
						if (insertsAllowedFor(RECORD_TABLES[target]).includes(file)) inserts.push(file);
						else findings.push(`${at(node)} .insert(${target})`);
					}
					// Card 2678 (decision 7, S4): the settled-once table, inserted where a record table may be, never deleted, and
					// updated only in the record module, by its pinned updates.
					if (target !== undefined && target in SETTLED_TABLES) {
						if (method === 'insert') {
							if (INSERTS_ALLOWED.includes(file)) settledInserts.push(file);
							else findings.push(`${at(node)} .insert(${target})`);
						}
						if (method === 'delete') findings.push(`${at(node)} .delete(${target})`);
						if (method === 'update') {
							if (file !== SETTLED_WRITER) findings.push(`${at(node)} .update(${target})`);
							else {
								const update = settledUpdateOf(node, tree);
								settledUpdates.push(update.fn);
								const pinned = Object.hasOwn(SETTLED_UPDATES, update.fn) ? SETTLED_UPDATES[update.fn] : undefined;
								if (pinned === undefined) findings.push(`${at(node)} .update(${target}) in ${update.fn}, which is none of its pinned updates`);
								else {
									if (JSON.stringify(update.set) !== JSON.stringify([...pinned.set].sort())) {
										findings.push(`${at(node)} .update(${target}) in ${update.fn} sets ${update.set.join(', ')}: not its pinned keys`);
									}
									if (update.where !== pinned.where) findings.push(`${at(node)} .update(${target}) in ${update.fn} is guarded by ${update.where}: not its pinned guard`);
								}
							}
						}
					}
					if (method === 'onConflictDoUpdate' || method === 'onConflictDoNothing') {
						const insert = insertUnder(node.expression.expression);
						const into = insert ? named(insert.arguments[0]) : undefined;
						if (into !== undefined && (into in RECORD_TABLES || into in SETTLED_TABLES)) findings.push(`${at(node)} .${method}() on an insert into ${into}`);
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(tree);
		}
	}
	return { findings, inserts, generic: [...new Set(generic)].sort(), settledInserts, settledUpdates };
}

/** The TypeScript in a file: all of a `.ts` or `.js` file, and each `<script>` of a `.svelte` file, with the line it starts on. */
function scriptsOf(file: string, source: string): { code: string; firstLine: number }[] {
	if (!file.endsWith('.svelte')) return [{ code: source, firstLine: 1 }];
	const scripts: { code: string; firstLine: number }[] = [];
	for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
		const before = source.slice(0, (match.index ?? 0) + match[0].indexOf('>') + 1);
		scripts.push({ code: match[1], firstLine: before.split('\n').length });
	}
	return scripts;
}

/** Every source file under `src`, by its path from the repository's root. */
function sourceFiles(): ScanFile[] {
	return (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
		.map((path) => `src/${path.split('\\').join('/')}`)
		.filter((file) => /\.(ts|js|svelte)$/.test(file))
		.sort()
		.map((file) => ({ file, source: readFileSync(join(ROOT, file), 'utf8') }));
}

describe('the record is insert-only, by the source (decision 27)', () => {
	it('has no update, delete, upsert or stray insert of a record table, and no delete of a decision, anywhere in src (1)', () => {
		const files = sourceFiles();
		const { findings, inserts, generic, settledInserts, settledUpdates } = scanRecordWrites(files);

		expect(findings).toEqual([]);
		// Card 2678 (decision 7, S4): the question's one insert, and its three guarded updates, each to its pin, in the record module.
		expect(settledInserts).toEqual(['src/lib/server/decision-record.ts']);
		expect(settledUpdates).toEqual(['recordAnswer', 'recordDraftPublished', 'recordDraftReplaced']);
		// Every writer of a table named at run time is named with why, and every one named is still one (S5).
		expect(generic).toEqual(Object.keys(GENERIC_WRITERS).sort());
		// The scan saw the tree, and the record's own inserts in it.
		expect(files.length).toBeGreaterThan(200);
		expect(files.some(({ file }) => file.endsWith('.svelte'))).toBe(true);
		// The event's, the version's, card 2677 (D1), the response's, and card 2679 (decision 7), the ruling's.
		expect(inserts.filter((file) => file === 'src/lib/server/decision-record.ts')).toHaveLength(4);
		// Card 2681 (the code review's S1): people_changes' one insert, recordChange's.
		expect(inserts.filter((file) => file === 'src/lib/server/people.ts')).toHaveLength(1);
	});

	it('finds each form on made-up source, and passes what is allowed (2)', () => {
		const SERVICE = 'src/lib/server/example.ts';
		const RECORD = 'src/lib/server/decision-record.ts';
		const PEOPLE = 'src/lib/server/people.ts';
		const caught: [string, ScanFile, string][] = [
			['a Drizzle update', { file: SERVICE, source: "db.update(decisionEvents).set({ kind: 'x' }).run();" }, '.update(decisionEvents)'],
			['a Drizzle delete', { file: RECORD, source: 'db.delete(decisionVersions).run();' }, '.delete(decisionVersions)'],
			[
				'a Drizzle update through a renamed import',
				{ file: SERVICE, source: "import { decisionRulings as r } from './db/schema';\ndb.update(r).set({}).run();" },
				'.update(decisionRulings)'
			],
			[
				'onConflictDoUpdate on decisionEvents',
				{ file: RECORD, source: "db.insert(decisionEvents).values(v).onConflictDoUpdate({ target: decisionEvents.id, set: { kind: 'x' } }).run();" },
				'.onConflictDoUpdate() on an insert into decisionEvents'
			],
			[
				'onConflictDoNothing on decisionResponses',
				{ file: RECORD, source: 'db.insert(schema.decisionResponses).values(v).onConflictDoNothing().run();' },
				'.onConflictDoNothing() on an insert into decisionResponses'
			],
			[
				"'decision_events' in a list another file walks, as USER_REFERENCES would hold it",
				{ file: 'src/lib/server/deletes.ts', source: "const USER_REFERENCES = [{ table: 'decision_events', column: 'actor_user_id' }];" },
				'names a record table as text'
			],
			['a template naming a table', { file: SERVICE, source: 'const q = `SELECT * FROM decision_responses WHERE id = ${id}`;' }, 'names a record table as text'],
			['SQL UPDATE in the record module', { file: RECORD, source: "sqlite.prepare('UPDATE decision_events SET kind = ?').run(k);" }, 'SQL UPDATE'],
			['SQL DELETE FROM in the restore', { file: 'src/lib/server/db/restore.ts', source: "run('DELETE FROM `decision_versions`');" }, 'SQL DELETE FROM'],
			['SQL REPLACE INTO', { file: RECORD, source: "sqlite.prepare('REPLACE INTO decision_rulings (decision_id) VALUES (?)');" }, 'SQL REPLACE INTO'],
			['SQL INSERT OR REPLACE', { file: RECORD, source: "sqlite.prepare('INSERT OR REPLACE INTO decision_events (kind) VALUES (?)');" }, 'SQL INSERT OR'],
			[
				'SQL ON CONFLICT',
				{ file: RECORD, source: "sqlite.prepare('INSERT INTO decision_events (id, kind) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET kind = excluded.kind');" },
				'SQL ON CONFLICT'
			],
			['SQL in a Drizzle template', { file: RECORD, source: "db.run(sql`UPDATE ${decisionEvents} SET kind = 'x'`);" }, 'SQL UPDATE'],
			['a Drizzle delete of decisions in another file', { file: 'src/lib/server/boards.ts', source: 'db.delete(decisions).where(eq(decisions.id, id)).run();' }, '.delete(decisions)'],
			// Card 2713: the delete moved with the lifecycle, and no other decision service may delete one either (R10).
			['a Drizzle delete of decisions in decision-ruling-writes.ts', { file: 'src/lib/server/decision-ruling-writes.ts', source: 'db.delete(decisions).where(eq(decisions.id, id)).run();' }, '.delete(decisions)'],
			['an SQL delete of decisions in another file', { file: SERVICE, source: "sqlite.prepare('DELETE FROM decisions WHERE id = ?').run(id);" }, 'SQL DELETE FROM decisions'],
			['a Drizzle insert in another file', { file: SERVICE, source: 'db.insert(decisionEvents).values(v).run();' }, '.insert(decisionEvents)'],
			['an SQL insert in the schema', { file: 'src/lib/server/db/schema.ts', source: "const seed = 'INSERT INTO decision_events (kind) VALUES (1)';" }, 'SQL INSERT into a record table'],
			// S5: a const alias, an alias of it, an element of a namespace, and sql.identifier and sql.raw of a name.
			['a Drizzle update through a const alias', { file: SERVICE, source: 'const t = decisionEvents;\ndb.update(t).set({}).run();' }, '.update(decisionEvents)'],
			['a Drizzle delete through an alias of an alias', { file: RECORD, source: 'const t = schema.decisionVersions;\nconst u = t;\ndb.delete(u).run();' }, '.delete(decisionVersions)'],
			['a Drizzle update of an element of a namespace', { file: SERVICE, source: "db.update(schema['decisionResponses']).set({}).run();" }, '.update(decisionResponses)'],
			['a Drizzle delete of decisions through a const alias', { file: SERVICE, source: "const d = schema['decisions'];\ndb.delete(d).run();" }, '.delete(decisions)'],
			['sql.identifier of a name in a template', { file: RECORD, source: "db.run(sql`DELETE FROM ${sql.identifier('decision_events')} WHERE id = 1`);" }, 'SQL DELETE FROM'],
			['sql.raw of a name in a template', { file: RECORD, source: "db.run(sql`UPDATE ${sql.raw('\"decision_rulings\"')} SET reason = ''`);" }, 'SQL UPDATE'],
			[
				'a table named only at run time, outside GENERIC_WRITERS',
				{ file: SERVICE, source: "for (const { name } of sqlite.prepare(\"SELECT name FROM sqlite_master\").all()) sqlite.prepare(`DELETE FROM \"${name}\"`).run();" },
				'writes a table named only at run time'
			],
			[
				'a Svelte page naming a table',
				{ file: 'src/routes/example/+page.svelte', source: "<p>Hello</p>\n<script lang=\"ts\">\n\tconst t = 'decision_rulings';\n</script>" },
				'src/routes/example/+page.svelte:3 names a record table as text'
			],
			// Card 2681 (the code review's S1): people_changes, inserted by people.ts alone, never updated or deleted.
			['an update of people_changes in the people service', { file: PEOPLE, source: "db.update(peopleChanges).set({ kind: 'x' }).run();" }, '.update(peopleChanges)'],
			['a delete of people_changes in the people service', { file: PEOPLE, source: 'db.delete(peopleChanges).run();' }, '.delete(peopleChanges)'],
			['an insert of people_changes in the record module', { file: RECORD, source: 'db.insert(peopleChanges).values(v).run();' }, '.insert(peopleChanges)'],
			['an insert of people_changes in the restore', { file: 'src/lib/server/db/restore.ts', source: 'db.insert(peopleChanges).values(v).run();' }, '.insert(peopleChanges)'],
			['an insert of a decision event in the people service', { file: PEOPLE, source: 'db.insert(decisionEvents).values(v).run();' }, '.insert(decisionEvents)'],
			['SQL DELETE FROM people_changes', { file: PEOPLE, source: "sqlite.prepare('DELETE FROM people_changes WHERE id = ?').run(id);" }, 'SQL DELETE FROM'],
			['SQL UPDATE of people_changes, quoted', { file: PEOPLE, source: 'sqlite.prepare(\'UPDATE "people_changes" SET kind = ?\').run(k);' }, 'SQL UPDATE'],
			['an SQL insert into people_changes in the people service', { file: PEOPLE, source: "sqlite.prepare('INSERT INTO people_changes (kind) VALUES (?)').run(k);" }, 'names a record table as text'],
			['people_changes named as text in the record module', { file: RECORD, source: "const t = 'people_changes';" }, 'names a record table as text'],
			['an SQL insert into people_changes in the record module', { file: RECORD, source: "sqlite.prepare('INSERT INTO people_changes (kind) VALUES (?)').run(k);" }, 'SQL INSERT into a record table'],
			['a Drizzle delete of people_changes through a const alias', { file: PEOPLE, source: 'const t = schema.peopleChanges;\ndb.delete(t).run();' }, '.delete(peopleChanges)'],
			// Card 2678 (decision 7, S4, case 32): the settled-once table.
			['an update of the questions in another file', { file: SERVICE, source: "db.update(decisionQuestions).set({ answer: 'x' }).run();" }, '.update(decisionQuestions)'],
			['an insert of a question in another file', { file: SERVICE, source: 'db.insert(decisionQuestions).values(v).run();' }, '.insert(decisionQuestions)'],
			['a delete of the questions in the record module', { file: RECORD, source: 'db.delete(decisionQuestions).where(eq(decisionQuestions.id, id)).run();' }, '.delete(decisionQuestions)'],
			['SQL DELETE FROM the questions', { file: RECORD, source: "sqlite.prepare('DELETE FROM decision_questions WHERE id = ?').run(id);" }, 'SQL DELETE FROM'],
			[
				'an update in the record module setting a key outside its pinned list',
				{
					file: RECORD,
					source:
						'export function recordAnswer(questionId, answer, by, agentDrafted) {\n' +
						'\treturn db.update(decisionQuestions).set({ answer, answeredBy: by.userId, answeredByName: by.name, answeredAt: stamp(), answerAgentDrafted: agentDrafted, question: answer })\n' +
						'\t\t.where(and(eq(decisionQuestions.id, questionId), isNull(decisionQuestions.answer))).run().changes === 1;\n}'
				},
				'not its pinned keys'
			],
			[
				'an update in the record module whose WHERE lacks its guard',
				{
					file: RECORD,
					source:
						'export function recordDraftPublished(questionId, by) {\n' +
						'\treturn db.update(decisionQuestions).set({ answerReviewedBy: by.userId, answerReviewedAt: stamp() })\n' +
						'\t\t.where(and(eq(decisionQuestions.id, questionId), isNotNull(decisionQuestions.answer), eq(decisionQuestions.answerAgentDrafted, true))).run().changes === 1;\n}'
				},
				'not its pinned guard'
			]
		];
		for (const [form, file, finding] of caught) {
			const { findings } = scanRecordWrites([file]);
			expect(findings.some((line) => line.includes(finding)), `${form}: ${JSON.stringify(findings)}`).toBe(true);
		}

		const passed: ScanFile[] = [
			{
				file: RECORD,
				source: 'db.select().from(decisionEvents).where(eq(decisionEvents.decisionId, id)).all();\ndb.insert(decisionEvents).values(v).returning().get();'
			},
			{ file: 'src/lib/server/db/restore.ts', source: "const lost = [...leftOut.keys()].filter((t) => t === 'decisions' || t.startsWith('decision_'));" },
			{ file: 'src/lib/server/decision-lifecycle-writes.ts', source: 'db.delete(decisions).where(eq(decisions.id, id)).run();' },
			// An index's name, and an update of an ordinary decision table.
			{ file: SERVICE, source: "const i = 'idx_decision_events_participant_id';\nsqlite.prepare('UPDATE decision_participants SET link_token_hash = NULL');" },
			// Card 2681: people_changes' one insert, in the people service, and its indexes' names.
			{ file: PEOPLE, source: 'db.insert(peopleChanges).values(v).run();\ndb.select().from(peopleChanges).all();' },
			{ file: SERVICE, source: "const i = 'idx_people_changes_actor_user_id';" },
			// A writer of tables named at run time on GENERIC_WRITERS, and a const alias of an ordinary table.
			{ file: 'src/lib/server/db/timestamps.ts', source: 'database.prepare(`UPDATE ${t} SET ${c} = 1`).run();' },
			{ file: SERVICE, source: 'const t = decisionParticipants;\ndb.update(t).set({}).run();' },
			// Card 2678 (case 32): the questions' insert and their three updates as written, in the record module.
			{
				file: RECORD,
				source: [
					'export function appendQuestion(q) { return db.insert(decisionQuestions).values({ ...q, askedAt: stamp() }).returning().get(); }',
					'export function recordAnswer(questionId, answer, by, agentDrafted) {',
					'\treturn db.update(decisionQuestions).set({ answer, answeredBy: by.userId, answeredByName: by.name, answeredAt: stamp(), answerAgentDrafted: agentDrafted })',
					'\t\t.where(and(eq(decisionQuestions.id, questionId), isNull(decisionQuestions.answer))).run().changes === 1;',
					'}',
					'export function recordDraftPublished(questionId, by) {',
					'\treturn db.update(decisionQuestions).set({ answerReviewedBy: by.userId, answerReviewedAt: stamp() })',
					'\t\t.where(and(eq(decisionQuestions.id, questionId), isNotNull(decisionQuestions.answer), eq(decisionQuestions.answerAgentDrafted, true), isNull(decisionQuestions.answerReviewedAt)))',
					'\t\t.run().changes === 1;',
					'}',
					'export function recordDraftReplaced(questionId, answer, by) {',
					'\treturn db.update(decisionQuestions).set({ answer, answeredBy: by.userId, answeredByName: by.name, answeredAt: stamp(), answerAgentDrafted: false })',
					'\t\t.where(and(eq(decisionQuestions.id, questionId), eq(decisionQuestions.answerAgentDrafted, true), isNull(decisionQuestions.answerReviewedAt))).run().changes === 1;',
					'}'
				].join('\n')
			}
		];
		for (const file of passed) expect(scanRecordWrites([file]).findings, file.source).toEqual([]);
		expect(scanRecordWrites([passed.at(-1)!]), 'the questions as written').toMatchObject({
			settledInserts: [RECORD],
			settledUpdates: ['recordAnswer', 'recordDraftPublished', 'recordDraftReplaced']
		});
		expect(scanRecordWrites([passed[0]]).inserts).toEqual([RECORD]);
		expect(scanRecordWrites(passed).generic).toEqual(['src/lib/server/db/timestamps.ts']);
	});
});

// ─── The lifecycle ───────────────────────────────────────────────────────────

/** What a refusal was answered with, or 'passed'. */
function refusal(run: () => unknown): { status: number; message: string } | 'passed' {
	try {
		run();
		return 'passed';
	} catch (err) {
		if (isHttpError(err)) return { status: err.status, message: err.body.message };
		throw err;
	}
}

const eventCount = () => (sqlite.prepare('SELECT COUNT(*) AS n FROM decision_events').get() as { n: number }).n;

describe('the shown status (E10)', () => {
	it('is the same row by row in code and in the query, for each status (3)', () => {
		const now = '2026-11-03 12:00:00';
		const rows: [Decision, string][] = [
			[makeDecision({ status: 'draft', closesAt: '2026-11-01 00:00:00' }), 'draft'],
			[makeDecision({ status: 'open', closesAt: '2026-11-10 00:00:00' }), 'open'],
			[makeDecision({ status: 'open', closesAt: '2026-11-03 11:59:59' }), 'awaiting_ruling'],
			[makeDecision({ status: 'open', closesAt: null }), 'open'],
			[makeDecision({ status: 'closed', closesAt: '2026-11-10 00:00:00' }), 'awaiting_ruling'],
			[makeDecision({ status: 'ruled', closesAt: '2026-11-01 00:00:00' }), 'ruled'],
			[makeDecision({ status: 'superseded', closesAt: '2026-11-01 00:00:00' }), 'superseded'],
			[makeDecision({ status: 'withdrawn', closesAt: '2026-11-01 00:00:00' }), 'withdrawn']
		];

		expect(rows.map(([row]) => decisionStatus(row, now))).toEqual(rows.map(([, shown]) => shown));
		const selected = db
			.select({ id: decisions.id })
			.from(decisions)
			.where(awaitingRulingSql(now))
			.all()
			.map((row) => row.id)
			.sort((a, b) => a - b);
		expect(selected).toEqual(rows.filter(([row]) => decisionStatus(row, now) === 'awaiting_ruling').map(([row]) => row.id));
		expect(selected).toHaveLength(2);
	});

	it('names the latest version that asked again as the round: 0, then 1, still 1 after telling only, then 3 (4)', () => {
		const decision = makeDecision({ status: 'open' });
		const version = (number: number, asksAgain: boolean) =>
			appendVersion({ decisionId: decision.id, number, content: '{}', changeNote: number === 1 ? null : 'A change', asksAgain }, SYSTEM_ACTOR);

		expect(currentRound(decision.id)).toBe(0);
		version(1, true);
		expect(currentRound(decision.id)).toBe(1);
		version(2, false);
		expect(currentRound(decision.id)).toBe(1);
		version(3, true);
		expect(currentRound(decision.id)).toBe(3);
	});

	it('allows each action only from the statuses in TRANSITIONS, and refuses in the shown status’s words (5)', () => {
		expect(TRANSITIONS).toEqual({
			edit: ['draft', 'open', 'closed'],
			setDecider: ['draft', 'open', 'closed'],
			// Card 2676 (R3, decision 9).
			include: ['open', 'closed'],
			review: ['draft', 'open', 'closed'],
			open: ['draft'],
			republish: ['open', 'closed'],
			close: ['open'],
			extend: ['open', 'closed'],
			withdraw: ['draft', 'open', 'closed'],
			delete: ['draft', 'withdrawn'],
			resend: ['open', 'closed'],
			participantAccount: ['open', 'closed'],
			participantAddress: ['open', 'closed'],
			rule: ['open', 'closed'],
			// Card 2677 (decision 12).
			respond: ['open'],
			// Card 2697 (decision 5).
			dryRun: ['draft', 'open', 'closed'],
			// Card 2679: from a stored ruling alone (S4, decisions 4 and 5).
			release: ['ruled'],
			concern: ['ruled'],
			supersede: ['ruled'],
			// Card 2678 (decision 10): open, and awaiting a ruling.
			ask: ['open', 'closed'],
			answer: ['open', 'closed'],
			// Card 2680 (decision 17): never a draft, nor linked once withdrawn.
			linkCard: ['open', 'closed', 'ruled', 'superseded'],
			unlinkCard: ['open', 'closed', 'ruled', 'superseded', 'withdrawn']
		});

		const pastItsDeadline = { status: 'open', closesAt: '2026-11-01 00:00:00' };
		const now = '2026-11-03 12:00:00';
		// Stored open, so it may be closed, though it is shown as awaiting a ruling.
		expect(refusal(() => requireTransition(pastItsDeadline, 'close', now))).toBe('passed');
		expect(refusal(() => requireTransition(pastItsDeadline, 'open', now))).toEqual({
			status: 409,
			message: 'This decision is awaiting a ruling: it cannot be opened'
		});
		expect(refusal(() => requireTransition({ status: 'draft', closesAt: null }, 'close', now))).toEqual({
			status: 409,
			message: 'This decision is a draft: it cannot be closed'
		});
	});
});

// ─── The record ──────────────────────────────────────────────────────────────

describe('appendEvent', () => {
	it('refuses an event naming a participant on a draft, and writes nothing (6)', () => {
		const draft = makeDecision();
		const participant = makeParticipant(draft);

		expect(() =>
			appendEvent({ decisionId: draft.id, kind: 'included', participantId: participant.id, detail: { role: 'consulted', hadAccount: false } }, SYSTEM_ACTOR)
		).toThrow(/cannot be written on a draft/);
		expect(eventCount()).toBe(0);

		// An event naming nobody is written on a draft.
		const id = appendEvent({ decisionId: draft.id, kind: 'created', detail: { decider: 'author' } }, SYSTEM_ACTOR);
		expect(sqlite.prepare('SELECT * FROM decision_events WHERE id = ?').get(id)).toMatchObject({
			decision_id: draft.id,
			participant_id: null,
			kind: 'created',
			detail: '{"decider":"author"}',
			actor_user_id: null,
			actor_name: 'DumpFire',
			source: 'system'
		});
	});
});

// ─── Personal links ──────────────────────────────────────────────────────────

describe('participantForLink', () => {
	it('gives a live link’s participant and decision, and refuses a token never issued, a holder it no longer reaches and a link that has lapsed (7)', () => {
		const author = makeUser();
		const open = makeDecision({ status: 'open', author, closesAt: '2099-01-01 00:00:00' });
		const person = makePerson();
		const participant = makeParticipant(open, { person });

		// No account event names the participant, so the history reads false (F1: the caller hands it in).
		const token = issueLink(participant.id, SYSTEM_ACTOR, false, { person, hadAccount: false });

		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(sqlite.prepare('SELECT link_token_hash AS hash FROM decision_participants WHERE id = ?').get(participant.id)).toEqual({
			hash: linkHashOf(token)
		});
		expect(sqlite.prepare("SELECT participant_id AS p, detail FROM decision_events WHERE kind = 'link_issued'").all()).toEqual([
			{ p: participant.id, detail: '{"replaced":false}' }
		]);
		const found = participantForLink(token);
		expect('participant' in found && found.participant.id).toBe(participant.id);
		expect('decision' in found && found.decision.id).toBe(open.id);

		expect(participantForLink('a-token-that-was-never-issued-to-anyone-000')).toEqual({ refused: 'unknown' });

		// S3: asked again at use. A directory address changed by a path that did not end the link, and the link is refused; put back, it works.
		sqlite.prepare('UPDATE people SET email = ? WHERE id = ?').run('moved@example.test', person.id);
		expect(participantForLink(token)).toEqual({ refused: 'unknown' });
		sqlite.prepare('UPDATE people SET email = ? WHERE id = ?').run(person.email, person.id);
		expect('participant' in participantForLink(token)).toBe(true);

		const ninetyDaysAgo = stamp(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
		const ruled = makeDecision({ status: 'ruled', closesAt: '2026-01-01 00:00:00', ruledAt: ninetyDaysAgo });
		makeParticipant(ruled, { token: 'a-link-on-a-decision-ruled-ninety-days-ago' });
		expect(participantForLink('a-link-on-a-decision-ruled-ninety-days-ago')).toEqual({ refused: 'expired' });
	});

	it('is usable while now is before the bound plus 90 days, the bound taken from the status (8)', () => {
		const bound = '2026-01-01 00:00:00';
		const lastSecond = '2026-03-31 23:59:59';
		const ninetyDays = '2026-04-01 00:00:00';
		const row = (status: string, moments: { closesAt?: string | null; ruledAt?: string | null; withdrawnAt?: string | null }) => ({
			status,
			closesAt: moments.closesAt ?? null,
			ruledAt: moments.ruledAt ?? null,
			withdrawnAt: moments.withdrawnAt ?? null
		});
		const cases: [string, ReturnType<typeof row>, string, boolean][] = [
			['a draft, never', row('draft', { closesAt: bound }), '2025-12-01 00:00:00', false],
			['open: the last second', row('open', { closesAt: bound }), lastSecond, true],
			['open: 90 days on', row('open', { closesAt: bound }), ninetyDays, false],
			['open with no closes_at', row('open', {}), '2099-01-01 00:00:00', true],
			['closed: the last second', row('closed', { closesAt: bound }), lastSecond, true],
			['closed: 90 days on', row('closed', { closesAt: bound }), ninetyDays, false],
			['closed with no closes_at', row('closed', {}), '2025-12-01 00:00:00', false],
			['ruled: from ruled_at, past closes_at + 90 days', row('ruled', { closesAt: '2025-06-01 00:00:00', ruledAt: bound }), lastSecond, true],
			['ruled: 90 days on', row('ruled', { closesAt: '2025-06-01 00:00:00', ruledAt: bound }), ninetyDays, false],
			['superseded: the last second', row('superseded', { closesAt: '2025-06-01 00:00:00', ruledAt: bound }), lastSecond, true],
			['superseded: 90 days on', row('superseded', { ruledAt: bound }), ninetyDays, false],
			['ruled with no ruled_at', row('ruled', { closesAt: '2099-01-01 00:00:00' }), '2025-12-01 00:00:00', false],
			['withdrawn, no ruled_at: the last second', row('withdrawn', { closesAt: '2025-06-01 00:00:00', withdrawnAt: bound }), lastSecond, true],
			['withdrawn, no ruled_at: 90 days on', row('withdrawn', { withdrawnAt: bound }), ninetyDays, false]
		];
		expect(cases.map(([label, decision, now]) => [label, linkUsable(decision, now)])).toEqual(
			cases.map(([label, , , usable]) => [label, usable])
		);
	});
});
