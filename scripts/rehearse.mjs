/**
 * rehearse.mjs — takes the migration runner over a copy of a real database.
 *
 *     npm run rehearse                          a copy of ./dumpfire.db
 *     npm run rehearse -- path/to/backup.db     a copy of any database file
 *     npm run rehearse -- path/to/backup.db --keep     and leave the copy to look at
 *
 * The first start on new code changes the structure of the database it opens:
 * it applies the migration files that database has not had, and rebuilds any
 * of six tables that is not in the model's shape. This shows what that start
 * will do to a particular database, on a copy, before it is allowed to.
 *
 * The file named is opened read-only and is not changed, and neither is its
 * `-wal` file. (Its `-shm` file may get a new modified time: that is SQLite's
 * index of the `-wal` file, which even a reader maps, and holds no data.)
 * `VACUUM INTO` writes a complete, consistent copy into a temporary folder,
 * even while a server has the database open, and the runner is taken over
 * that copy by
 * tests/rehearsal/copy.rehearsal.ts, which says what has to hold. No server
 * and no scheduler is started, so a copy of production sends no report and
 * uploads no backup. The copy holds whatever the database holds, password
 * hashes and credentials included; it is deleted afterwards unless --keep is
 * given.
 *
 * Exit code 0 if the runner brought the copy up to date and lost nothing; 1 if
 * not. A table left in the shape it has, or a difference from the model, is
 * printed and is not a failure: the server starts with either.
 *
 * What this does not rehearse is the image: that the built server stops on a
 * failed migration, and that `docker build` produces one that starts. That is
 * the rehearsal in docs/deployment.md.
 */
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const named = args.find((arg) => !arg.startsWith('--'));
const source = resolve(named ?? join(root, 'dumpfire.db'));

if (!existsSync(source)) {
	console.error(`There is no file at ${source}.`);
	process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'dumpfire-rehearsal-'));
const copy = join(dir, 'copy.db');
const reportPath = join(dir, 'report.json');
let failed = true;

try {
	const megabytes = (statSync(source).size / 1024 / 1024).toFixed(1);
	console.log(`Rehearsal on a copy of ${source} (${megabytes} MB). The file itself is opened read-only.\n`);

	const live = new Database(source, { readonly: true, fileMustExist: true });
	try {
		live.prepare('VACUUM INTO ?').run(copy);
	} finally {
		live.close();
	}

	// Through node and not npx: on Windows `npx` is a .cmd file, which
	// spawnSync cannot start without a shell.
	const run = spawnSync(
		process.execPath,
		[join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.rehearse.config.ts'],
		{ cwd: root, encoding: 'utf8', env: { ...process.env, REHEARSE_DB: copy, REHEARSE_REPORT: reportPath } }
	);

	if (!existsSync(reportPath)) {
		// The rehearsal never got as far as its own account.
		console.error('The rehearsal did not run. What vitest said:\n');
		console.error(run.stdout);
		console.error(run.stderr);
	} else {
		failed = print(JSON.parse(readFileSync(reportPath, 'utf8'))) || run.status !== 0;
	}
} finally {
	if (keep) console.log(`\nThe copy was kept: ${copy}\nIt holds everything the database holds. Delete the folder when you have looked.`);
	else rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

/** Print the account. Returns true if the rehearsal failed. */
function print(found) {
	const list = (items) => items.map((item) => `    - ${item}`).join('\n');
	const total = (rows) => Object.values(rows).reduce((sum, n) => sum + n, 0);
	const first = found.first;

	if (first) {
		console.log(`Migration files applied: ${first.applied.length}${first.applied.length ? `\n${list(first.applied)}` : ''}`);
		if (first.tolerated.length > 0) {
			console.log(`Statements skipped as already done, in the old files where that is allowed: ${first.tolerated.length}`);
		}

		console.log(`Tables rebuilt in the model's shape: ${first.rebuilt.length}`);
		for (const table of first.rebuilt) {
			const defaulted = table.defaulted.map((d) => `; ${d.rows} NULL ${d.column} became ${d.value}`).join('');
			console.log(`    - ${table.table}: ${table.rows} row(s) carried across${defaulted}`);
			for (const difference of table.differences) console.log(`        ${difference}`);
		}

		if (first.detachedSubBoards.length > 0) {
			console.log(`Sub-boards detached, because their card no longer exists: ${first.detachedSubBoards.length}`);
			console.log(list(first.detachedSubBoards.map((board) => `${board.id} (${board.name})`)));
		}
		console.log(
			`Filled in: first_completed_at on ${first.backfilled.firstCompletedAt} card(s), ` +
				`access_token on ${first.backfilled.accessTokens} request(s), ` +
				`${first.backfilled.releasedFromMilestones} card(s) taken out of a milestone of another board, ` +
				`${first.backfilled.unfiledBoards} board(s) taken out of a grouping that no longer exists`
		);
		// Which, the first 50 by card and milestone, as the start's WARN line names them.
		if (first.backfilled.released.length > 0) {
			const more = first.backfilled.releasedFromMilestones - first.backfilled.released.length;
			const named = first.backfilled.released.map((r) => `card ${r.cardId} left milestone ${r.milestoneId}`).join(', ');
			console.log(`    ${named}${more > 0 ? `; and ${more} more` : ''}`);
		}
		// And the boards, the first 50 by board and the grouping each named (card 2293).
		if (first.backfilled.unfiled.length > 0) {
			const more = first.backfilled.unfiledBoards - first.backfilled.unfiled.length;
			const named = first.backfilled.unfiled.map((u) => `board ${u.boardId} (grouping ${u.groupingId})`).join(', ');
			console.log(`    ${named}${more > 0 ? `; and ${more} more` : ''}`);
		}

		// Card 2095: what the first start converts, column by column. On an
		// export of production this is the measurement of what it holds.
		const stamps = first.timestamps;
		if (!stamps) {
			console.log('Timestamps: not converted, because the database may be newer than this build');
		} else if (stamps.failed) {
			console.log(`Timestamps: the conversion failed and changed nothing: ${stamps.failed}`);
		} else {
			const converted = Object.entries(stamps.converted);
			console.log(
				`Timestamps converted to the stored form (YYYY-MM-DD HH:MM:SS, UTC): ` +
					`${converted.reduce((sum, [, n]) => sum + n, 0)}${converted.length ? `\n${list(converted.map(([column, n]) => `${column}: ${n}`))}` : ''}`
			);
			const unreadable = Object.entries(stamps.unreadable);
			if (unreadable.length > 0) {
				console.log(
					`Timestamps in no form the conversion can read, left as they are:\n` +
						list(unreadable.map(([column, u]) => `${column}: ${u.count}, such as ${JSON.stringify(u.example)}`))
				);
			}
		}
	}

	if (found.before && found.after) {
		console.log(
			`\nRows: ${total(found.before.rows)} in ${Object.keys(found.before.rows).length} tables before, ` +
				`${total(found.after.rows)} in ${Object.keys(found.after.rows).length} after`
		);
		console.log(`Rows that break a foreign key: ${found.before.violations} before, ${found.after.violations} after`);
	}
	if (found.integrity) console.log(`Integrity check: ${found.integrity}. Foreign keys on afterwards: ${found.foreignKeysOn ? 'yes' : 'NO'}`);
	if (found.second) {
		console.log(
			`A second run: ${found.second.applied.length} file(s) applied, ${found.second.rebuilt.length} table(s) rebuilt, ` +
				`${Object.values(found.second.timestamps?.converted ?? {}).reduce((sum, n) => sum + n, 0)} timestamp(s) converted`
		);
	}
	if (found.milliseconds !== null) {
		const took = found.milliseconds < 1000 ? `${found.milliseconds} ms` : `${(found.milliseconds / 1000).toFixed(1)} s`;
		console.log(`The first run took ${took}, which is what the first start adds before it listens.`);
	}
	if (found.notes.length > 0) console.log(`\nWorth knowing:\n${list(found.notes)}`);

	// The server starts with these, and says them at every start until they are dealt with.
	const toRead = [];
	if (first) {
		if (first.reconciliationSkipped) toRead.push(`No table was compared or rebuilt: ${first.reconciliationSkipped}`);
		for (const name of first.missingFromDisk) toRead.push(`The database records ${name}, and there is no such file in drizzle/`);
		for (const left of first.leftAlone) toRead.push(`${left.table} was left as it is: ${left.reason}. ${left.whatToDo}`);
		for (const difference of first.schemaDifferences) toRead.push(`Still differs from the model: ${difference}`);
		for (const [column, u] of Object.entries(first.timestamps?.unreadable ?? {})) {
			toRead.push(`${column} holds ${u.count} value(s) in no timestamp form, such as ${JSON.stringify(u.example)}`);
		}
	}
	if (toRead.length > 0) {
		console.log(`\nThe server would start, and would log each of these as an error at every start:\n${list(toRead)}`);
	}

	if (found.problems.length > 0) {
		console.log(`\nFAILED. Do not start the new code on this database:\n${list(found.problems)}`);
		return true;
	}
	console.log(
		toRead.length > 0
			? '\nPASSED, with the lines above to read. The runner brought the copy up to date and lost nothing.'
			: '\nPASSED. The runner brought the copy up to date, lost nothing, and the result is the model exactly.'
	);
	return false;
}
