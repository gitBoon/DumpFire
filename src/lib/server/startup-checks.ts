/**
 * startup-checks.ts — six things about an installation that are said in the
 * system log when the server starts, because nothing else would say them.
 *
 * None stops the server and none changes anything. They are looked for by
 * `reportInstallation`, which hooks.server.ts calls once as the server loads,
 * after the migrations. Importing this module looks for nothing. The
 * rehearsal (scripts/rehearse.mjs) takes the migration runner over a copy and
 * never loads the hook, so it says none of them. The third, a board beneath
 * one of its own cards, is said by the import route too, as soon as a restore
 * that brought one is committed. The last three are about where the database
 * is (card 2083): that it was new at this start, that it is not on a mounted
 * volume, and that another database is beside the one in use. What was found
 * before the open is kept by db/index.ts, which looks before it opens and
 * refuses to start when a new database would hide one it can see
 * (db/location.ts). The new-database and off-volume lines are written to the
 * console whatever LOG_LEVEL is, because the deploy checks look for them in
 * `docker logs`.
 *
 * And one that does stop the server, after the migrations and before it
 * listens: `refuseUserlessBesideAnother`, when the database in use has no
 * users while another database is beside it.
 *
 * And one thing that is changed at start, beside them: `maskLiveLog`, which
 * masks the secrets an older gate wrote into the system log.
 */
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { createdAtStart, getDbPath, otherDatabaseAtStart, sqlite } from './db';
import { DatabaseLocationError, described, heldInContainerLayer, type OtherDatabase } from './db/location';
import { PLACEHOLDER_ORIGIN, configuredOrigin, getAppUrl } from './email';
import { createLogger, isLogged } from './logger';
import { maskSecretsInLog } from './secret-paths';
import { boardsInLoops } from './sub-boards';

const log = createLogger('STARTUP');

/**
 * One CRITICAL line when there are user accounts and none of them is the
 * superadmin. Returns whether it was said.
 *
 * The export, the import, the reset, the backup destinations and the mail
 * settings are the superadmin's alone, `superadmin` is written by set-up and
 * by nothing else, and set-up is closed while there is any user. So such an
 * installation has nobody who can do any of them, and no page on which to put
 * that right: the way back is from the host, and the line says where it is
 * written down.
 *
 * With no users at all there is nothing to say: set-up is open, and whoever
 * completes it is the superadmin.
 */
export function reportNoSuperadmin(): boolean {
	const found = sqlite
		.prepare("SELECT COUNT(*) AS users, COALESCE(SUM(role = 'superadmin'), 0) AS superadmins FROM users")
		.get() as { users: number; superadmins: number };
	if (found.users === 0 || found.superadmins > 0) return false;

	log.critical(
		`There are ${found.users} user account(s) and none of them is the superadmin. Nobody can export, import ` +
			'or reset the database, or change the backup and mail settings. Make one account the superadmin from the ' +
			'host: the command is in docs/deployment.md, under "If nobody can sign in as the superadmin".'
	);
	return true;
}

/**
 * One WARN line when `ORIGIN` is the address the image is built with and no
 * App URL is set. Returns whether it was said.
 *
 * A link in a mail begins with the App URL or, failing that, with `ORIGIN`
 * (`linkBaseUrl` in email.ts). An installation that really is served at
 * `http://localhost:3000` is right as it is. One behind a proxy that never
 * set `ORIGIN` mails links nobody can follow, and this is the only place that
 * says so.
 */
export function reportPlaceholderOrigin(origin: string | undefined = process.env.ORIGIN): boolean {
	if (configuredOrigin(origin) !== PLACEHOLDER_ORIGIN || getAppUrl() !== null) return false;

	log.warn(
		`ORIGIN is ${PLACEHOLDER_ORIGIN}, the address the image is built with, and no App URL is set, so every ` +
			`link in a mail will begin with ${PLACEHOLDER_ORIGIN}. If this server is reached at another address, ` +
			'start it with ORIGIN set to that address, or set the App URL on the admin page under Application Settings.'
	);
	return true;
}

/** How many boards the line names. The rest are counted; the admin guide has the query for all of them. */
const LOOP_BOARDS_NAMED = 20;

/**
 * A name or a title as the line prints it: each control character, a line
 * break above all, as a space. Names are printed as stored, and one holding a
 * line break would split the console line and could forge one after it.
 */
const printable = (text: string): string => text.replace(/[\x00-\x1f\x7f]/g, ' ');

/**
 * One WARN line when any board hangs beneath one of its own cards, naming each
 * such board, the card it hangs from and the board that card is on, and the
 * way out. Returns whether it was said.
 *
 * Such a board is in a loop with no top, so it is on no dashboard and in no
 * list of top-level boards, and the card it hangs from can never be completed.
 * Since card 2141 no move makes one, but a move made before it or a restored
 * backup can have left one, and nothing else would say so. Opening the board
 * is safe (card 2142). The repair is to move the card, in All Tasks, onto a
 * board outside the loop, once for each loop: the line says so, and where the
 * rest is written down. An archived card is not in All Tasks, so the line
 * marks one, to be restored from the Archived page first. And it warns
 * against the delete that looks like a way out: any delete that reaches a
 * board of a loop takes every board of it and every board below it.
 *
 * Every start says it again while a loop is there, and so does a restore of a
 * backup, at once, with the import's own logger (`by`). It names the first 20
 * boards by id, and counts the rest. The boards come from `boardsInLoops`,
 * one read and a walk that looks at each board once, so it costs next to
 * nothing however deep the boards nest.
 */
export function reportBoardLoops(by: Pick<typeof log, 'warn'> = log): boolean {
	const looped = boardsInLoops();
	if (looped.length === 0) return false;

	const named = looped
		.slice(0, LOOP_BOARDS_NAMED)
		.map(
			(b) =>
				`board ${b.boardId} "${printable(b.boardName)}", under card ${b.cardId} "${printable(b.cardTitle)}"` +
				`${b.cardArchived ? ' (archived: restore it from Archived first)' : ''} on board ${b.cardBoardId}`
		)
		.join('; ');
	const more = looped.length > LOOP_BOARDS_NAMED ? `; and ${looped.length - LOOP_BOARDS_NAMED} more` : '';
	by.warn(
		`${looped.length} board(s) hang beneath one of their own cards, so they are on no dashboard and the card each ` +
			`hangs from cannot be completed: ${named}${more}. To put one right, open All Tasks, find the card and move it ` +
			'onto a board outside the loop: one move for each loop is enough. Do not delete a board, card or column of a ' +
			'loop to clear it: that deletes every board of the loop and every board below it. See docs/admin-guide.md, ' +
			'under "A board beneath one of its own cards".'
	);
	return true;
}

const isMemory = (dbPath: string) => dbPath === ':memory:' || dbPath === '';

/**
 * A WARN line the deploy checks look for in `docker logs`: kept in the system
 * log when LOG_LEVEL lets a WARN line through (not at ERROR or CRITICAL), and
 * written to the console whatever LOG_LEVEL is, as the location refusal is. A
 * LOG_LEVEL of ERROR must not hide the alarm.
 */
function warnOnConsoleAlways(message: string): void {
	log.warn(message);
	if (!isLogged('WARN')) console.warn(`[${new Date().toISOString()}] [WARN] [STARTUP] ${message}`);
}

/**
 * One WARN line when there was no database file, or an empty one, before this
 * start opened it: a new, empty database was made. Returns whether it was
 * said.
 *
 * A new installation says it once. On an installation that should have had
 * data it is the alarm: the database it had is somewhere this server did not
 * look, and set-up is open to whoever comes first. The line says to stop the
 * container before anyone opens the site.
 */
export function reportNewDatabase(isNew: boolean = createdAtStart(), dbPath: string = getDbPath()): boolean {
	if (!isNew || isMemory(dbPath)) return false;

	warnOnConsoleAlways(
		`No database was at ${dbPath}: a new, empty one was created at this start. If this installation had data, ` +
			'stop the container now, before anyone opens the site and is offered set-up, and see docs/deployment.md, ' +
			'under "Moving the database onto the volume".'
	);
	return true;
}

/**
 * One WARN line at every start when the folder the database is in is held by
 * the container's own file system and not by a mounted volume
 * (`heldInContainerLayer`, from `/proc/self/mountinfo`). Returns whether it
 * was said.
 *
 * Such a database, and the uploads beside it, are lost when the container is
 * replaced. An in-memory database has no folder, so there is nothing to say
 * and mountinfo is not read: the image's builder stage runs the tests on an
 * overlay with nothing mounted, and must say nothing. Where mountinfo cannot
 * be read (Windows, macOS) nothing is said either, and this never throws.
 */
export function reportDatabaseOffVolume(
	dbPath: string = getDbPath(),
	readMountinfo: () => string = () => readFileSync('/proc/self/mountinfo', 'utf8'),
	cwd: string = process.cwd()
): boolean {
	if (isMemory(dbPath)) return false;

	let mountinfo: string;
	try {
		mountinfo = readMountinfo();
	} catch {
		return false;
	}
	// mountinfo is Linux's, so the path is worked out as Linux reads it.
	const dir = posix.dirname(posix.resolve(cwd, dbPath));
	if (!heldInContainerLayer(dir, mountinfo)) return false;

	warnOnConsoleAlways(
		`The database, ${dbPath}, is in the container's own file system and not on a mounted volume, so it and the ` +
			'uploads kept beside it are lost when the container is replaced (a restart keeps them). Before the ' +
			`container is replaced, move them onto a volume mounted at ${dir}: see docs/deployment.md, under ` +
			'"Moving the database onto the volume". Mounting an empty volume there without moving them first hides them.'
	);
	return true;
}

/**
 * One WARN line at every start when a database file is at
 * `<working directory>/dumpfire.db` beside the image's one in use
 * (`/app/data/dumpfire.db`), naming both, with each one's size and when it
 * was last written (the one in use as it was before this start opened it), so
 * that the operator can tell which is live. Returns whether it was said.
 *
 * The server opens the volume's: it has data, and `DB_PATH` may have been
 * given on purpose. But an installation that kept its database at
 * `/app/dumpfire.db` and once made one on the volume as well is now running
 * on the wrong one, and this is the only place that says so. (When the one in
 * use has no users at all, `refuseUserlessBesideAnother` has already stopped
 * the server.)
 */
export function reportOtherDatabase(
	other: OtherDatabase | null = otherDatabaseAtStart(),
	dbPath: string = getDbPath()
): boolean {
	if (other === null) return false;

	log.warn(
		`Another database file is at ${other.path} (${described(other)}), beside ${dbPath} ` +
			`(${described(other.inUse)}, before this start), which is the one in use. ` +
			`If ${other.path} is this installation's database, stop the container and start it with ` +
			`DB_PATH=${other.path}, or move it onto the volume (docs/deployment.md, under "Moving the database onto ` +
			'the volume"). If it is not, move it out of that folder, and this line is not said again.'
	);
	return true;
}

/**
 * Stop the server, before it listens, when the database in use has no user
 * accounts while another database is beside it (`otherDatabaseAtStart`):
 * writes one `[CRITICAL] [DB]` line to the console, naming both files with
 * their sizes and times, and throws. Called once, from hooks.server.ts, after
 * the migrations, as a bare call: the throw is what stops a built server
 * (exit code 1), as a failed migration's is.
 *
 * The guard in db/location.ts refuses a new database beside another. But one
 * start without it (an older image, or a `DB_PATH` it did not guard) leaves a
 * database on the volume that is not empty and has nobody in it, and after
 * that the guard sees a database with data and opens it: set-up is open to
 * whoever comes first while the real database is beside it. A healthy
 * installation has users, so this never stops one that is running on its own
 * database with an old file beside it; `reportOtherDatabase` says that one.
 */
export function refuseUserlessBesideAnother(
	other: OtherDatabase | null = otherDatabaseAtStart(),
	users: () => number = countUsers
): void {
	if (other === null || users() > 0) return;

	const inUse = other.inUse;
	const message =
		`The server will not start. The database in use, ${inUse.path} (${described(inUse)}, before this start), has ` +
		'no user accounts, so every page would offer set-up to whoever opens the site first. And another database ' +
		`file is at ${other.path} (${described(other)}), which may be this installation's. If it is, start the ` +
		`container with DB_PATH=${other.path}; or, with the container stopped, move ${inUse.path} (with its -wal and ` +
		`-shm files) aside into a folder of its own, and move ${other.path} onto the volume as ${inUse.path}, with ` +
		`its -wal and -shm files and the uploads folder ${posix.join(posix.dirname(other.path), 'uploads')}. If it is ` +
		"not, move it out of that folder. Nothing was served. See docs/deployment.md, under \"Moving the database " +
		'onto the volume".';
	const line = `[${new Date().toISOString()}] [CRITICAL] [DB] ${message}`;
	console.error(line);
	throw new DatabaseLocationError(message, line);
}

function countUsers(): number {
	return (sqlite.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

/**
 * Mask, in the running database's own system log, every invite's token and
 * request link's token a line holds, by the rule a backup's copy is masked
 * with (`maskSecretsInLog`, in secret-paths.ts). Returns how many changes it
 * made, or null when it could not be done. Called once, from hooks.server.ts,
 * as the server loads, after the migrations.
 *
 * The gate wrote `GET /invite/<token>` into the log, a live invite in every
 * such line, until 2026-10-14, and any administrator reads that log through
 * `GET /api/logs`. Masking the backups alone left the running log as it was.
 * So an installation that ran the older gate has its log masked at its first
 * start on this one, and every start after finds nothing to change: masked
 * text is not masked again. The log holds at most 50,000 lines, and the only
 * lines rewritten are those holding an unused invite's token, or an invite's
 * address or a `token=` not masked yet.
 *
 * It never throws: a log that cannot be masked is no reason not to start. It
 * is said at WARN, and the server starts.
 */
export function maskLiveLog(): number | null {
	try {
		return maskSecretsInLog(sqlite);
	} catch (err) {
		try {
			log.warn(
				`The system log could not be masked of the invite and request-link tokens it may hold: ` +
					`${(err as Error)?.message ?? err}. GET /api/logs may still show them.`
			);
		} catch {
			// Nothing more to be done about it.
		}
		return null;
	}
}

/**
 * Say all six, if they are so. Called once, from hooks.server.ts, as the
 * server loads.
 *
 * It never throws, whatever goes wrong in looking: a fault here must not be
 * what keeps a server from starting. A check that could not be made is said
 * on the console and nowhere else.
 */
export function reportInstallation(): void {
	for (const check of [
		reportNoSuperadmin,
		() => reportPlaceholderOrigin(),
		reportBoardLoops,
		() => reportNewDatabase(),
		() => reportDatabaseOffVolume(),
		() => reportOtherDatabase()
	]) {
		try {
			check();
		} catch (err) {
			try {
				console.error(`[STARTUP] A check of the installation could not be made: ${(err as Error)?.message ?? err}`);
			} catch {
				// Nothing more to be done about it.
			}
		}
	}
}
