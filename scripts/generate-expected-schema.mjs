/**
 * generate-expected-schema.mjs — writes src/lib/server/db/expected-schema.ts.
 *
 *     npm run schema:expected               rewrite the module from the model
 *     npm run schema:expected -- --check    write nothing; exit 1 if the module is out of date
 *     npm run schema:expected -- --print    write nothing; print the module
 *
 * The model is src/lib/server/db/schema.ts. `drizzle-kit export` turns it into
 * the DDL for a database built from the model alone, and this script stores
 * that DDL, one statement per entry, as a TypeScript module.
 *
 * Why a checked-in module and not a call to drizzle-kit at start-up: the
 * migration runner needs the model's structure in production, and drizzle-kit
 * is a development dependency that the production image does not have. The
 * module is bundled with the server.
 *
 * The runner does two things with it, and the second is why a stale module is
 * dangerous and not merely wrong. It compares the live database with it and
 * reports what differs. And it rebuilds six tables from it (boards, columns,
 * categories, settings, user_xp, invite_tokens): where one of them differs,
 * its CREATE TABLE statement here is the statement the new table is created
 * from. A module that has fallen behind schema.ts therefore reshapes those
 * tables to a model the code no longer has, and a foreign key or a NOT NULL
 * that the stale statement lacks is removed from the live table.
 *
 * So `npm run build` runs this with --check first ("prebuild" in
 * package.json) and fails if the module is not what the model generates, and
 * two tests in tests/migrations.test.ts fail on the same thing.
 *
 * It opens no database file. The only databases here are in memory, and are
 * used to prove that the DDL was split into statements correctly.
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 'src/lib/server/db/schema.ts';
const TARGET = 'src/lib/server/db/expected-schema.ts';

/** The model's DDL, exactly as `drizzle-kit export` prints it. */
function exportModel() {
	// Run through node rather than npx: on Windows `npx` is a .cmd file, which
	// execFile cannot start.
	return execFileSync(
		process.execPath,
		[join(root, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'export', '--dialect', 'sqlite', '--schema', SCHEMA],
		{ cwd: root, encoding: 'utf8' }
	).replace(/\r\n/g, '\n');
}

/**
 * Split DDL into statements, each ending with its `;`.
 *
 * A `;` inside a string literal, a quoted name or a comment does not end a
 * statement. Triggers, whose bodies hold `;`, are not understood: drizzle-kit
 * does not write them, and `verify` below fails if it ever writes anything
 * this gets wrong.
 */
function splitStatements(ddl) {
	const statements = [];
	let start = 0;
	let i = 0;
	while (i < ddl.length) {
		const c = ddl[i];
		if (c === '-' && ddl[i + 1] === '-') {
			const newline = ddl.indexOf('\n', i);
			i = newline === -1 ? ddl.length : newline + 1;
		} else if (c === '/' && ddl[i + 1] === '*') {
			const close = ddl.indexOf('*/', i + 2);
			i = close === -1 ? ddl.length : close + 2;
		} else if (c === "'" || c === '"' || c === '`') {
			// A doubled quote inside is an escaped quote, not the end.
			i++;
			while (i < ddl.length) {
				if (ddl[i] === c) {
					if (ddl[i + 1] !== c) break;
					i++;
				}
				i++;
			}
			i++;
		} else if (c === '[') {
			const close = ddl.indexOf(']', i + 1);
			i = close === -1 ? ddl.length : close + 1;
		} else if (c === ';') {
			statements.push(ddl.slice(start, i + 1).trim());
			i++;
			start = i;
		} else {
			i++;
		}
	}
	const rest = ddl.slice(start).trim();
	if (rest.length > 0) statements.push(rest);
	return statements;
}

const masterOf = (database) =>
	JSON.stringify(database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all());

/**
 * Prove the split lost nothing: the statements, run one at a time, build the
 * same database as the export run whole. `prepare` refuses text that holds
 * more than one statement, so a piece that is really two is caught as well.
 */
function verify(ddl, statements) {
	const whole = new Database(':memory:');
	const pieces = new Database(':memory:');
	try {
		whole.exec(ddl);
		for (const statement of statements) pieces.prepare(statement).run();
		if (masterOf(whole) !== masterOf(pieces)) {
			throw new Error('the statements, run one at a time, do not build the database that the export builds');
		}
	} finally {
		whole.close();
		pieces.close();
	}
}

/** One statement as a TypeScript expression: a string, or lines joined with a newline. */
function literal(statement) {
	const lines = statement.split('\n');
	if (lines.length === 1) return `\t${JSON.stringify(statement)}`;
	return `\t[\n${lines.map((line) => `\t\t${JSON.stringify(line)}`).join(',\n')}\n\t].join('\\n')`;
}

function render(statements) {
	return `/**
 * GENERATED FILE. Do not edit it by hand.
 *
 * This is the model in \`schema.ts\`, as the DDL that \`drizzle-kit export\`
 * prints for it: one statement per entry, in the order printed. After any
 * change to \`schema.ts\`, regenerate it:
 *
 *     npm run schema:expected
 *
 * (scripts/generate-expected-schema.mjs). A test regenerates it and fails if
 * this file differs, and \`npm run build\` checks it before it builds, so a
 * change to the model that is not carried here, or an edit made here by hand,
 * fails both.
 *
 * It is checked in, and bundled with the server, because the migration runner
 * uses it at every start (see \`migrate.ts\`) and drizzle-kit is not installed
 * in production. The runner does two things with it:
 *
 * - It compares the live database with it and reports every difference.
 * - It rebuilds six tables from it: \`boards\`, \`columns\`, \`categories\`,
 *   \`settings\`, \`user_xp\` and \`invite_tokens\`. Where one of them differs,
 *   the CREATE TABLE statement below is the DDL the new table is created from.
 *
 * So a stale copy does not only misreport. It reshapes those tables to a model
 * the code no longer has, and a foreign key or a NOT NULL that the stale
 * statement lacks is taken off the live table.
 */
export const EXPECTED_SCHEMA: readonly string[] = Object.freeze([
${statements.map(literal).join(',\n')}
]);
`;
}

const ddl = exportModel();
const statements = splitStatements(ddl);
if (statements.length === 0) throw new Error('drizzle-kit export printed no statements');
verify(ddl, statements);
const source = render(statements);

const target = join(root, TARGET);
const existing = existsSync(target) ? readFileSync(target, 'utf8') : null;
// Git may have checked the file out with CRLF line endings; that is not a difference.
const upToDate = existing !== null && existing.replace(/\r\n/g, '\n') === source;

if (process.argv.includes('--print')) {
	process.stdout.write(source);
} else if (process.argv.includes('--check')) {
	if (!upToDate) {
		console.error(
			`${TARGET} is not what the model generates. ` +
				`Run "npm run schema:expected" and commit the result; do not edit the file by hand.`
		);
		process.exitCode = 1;
	}
} else if (upToDate) {
	console.log(`${TARGET} is up to date (${statements.length} statements).`);
} else {
	// Keep the line endings the file already has.
	const crlf = existing !== null && existing.includes('\r\n');
	writeFileSync(target, crlf ? source.replace(/\n/g, '\r\n') : source);
	console.log(`Wrote ${TARGET} (${statements.length} statements).`);
}
