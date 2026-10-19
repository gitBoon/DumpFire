/**
 * startup-checks.ts — thirteen things about an installation that are said in the
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
 * `docker logs`. The seventh, that sign-ins from browsers not remembered are
 * not held to one at a time (`SIGN_IN_ONE_AT_A_TIME=off`, card 2194), is
 * written there too: it is meant to be set for one sign-in and removed. So is
 * the eighth, that pages are sent their Content-Security-Policy to report only
 * (`CSP_MODE=report-only`, card 2162), or that `CSP_MODE` holds a value that
 * is neither mode: it is meant for the policy's first deploy, and removed.
 * The ninth is the secrets a backup does not hold and this installation still
 * lacks (card 2169): a database put in place by hand from a backup, or one an
 * import restored onto another server, has no mail password, no destination
 * credentials and its signed webhooks off until they are entered. The tenth
 * is each entry of `WEBHOOK_ALLOW_INSIDE` that is ignored (card 2161): the
 * list is read at every registration and every delivery, where a line would
 * be written once for each webhook judged, so it is named here, once, at the
 * start that read it. The eleventh is each board with more webhooks than the
 * 10 a board may have (card 2201): they were made before the cap, are kept and
 * still sent, and nothing else says why no webhook can be added to one. The
 * twelfth is each webhook that is on and is refused as its address is written
 * (the review of card 2161, O1): it is not sent at any event, and a board's
 * owner may not know why until an event's line says so. The thirteenth is
 * each SFTP backup destination with no confirmed host key (card 2250): no
 * backup is sent to it until its key is confirmed, and where failure mail is
 * off nothing else says so.
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
// `printable` is the logger's cleaner (card 2214), which `emit` applies to
// every line as well. Names are still put through it where they sit inside
// quotes, and the line printed past LOG_LEVEL below does not go through `emit`.
import { createLogger, isLogged, printable } from './logger';
import { maskSecretsInLog } from './secret-paths';
import { signInsOneAtATime } from './known-browsers';
import { cspMode } from './gate-answers';
import { boardsInLoops } from './sub-boards';
import { secretsToEnter, secretsToEnterSentence, unconfirmedHostKeys } from './backup-secrets';
import { parseAllowInside } from './webhook-address';
import { activeWebhooksRefused, boardsOverWebhookCap, MAX_WEBHOOKS_PER_BOARD } from './webhooks';

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

/**
 * One WARN line for each entry of `WEBHOOK_ALLOW_INSIDE` that is ignored,
 * naming it and why (card 2161, the plan's R-S2). Returns whether any was
 * said.
 *
 * The list names receivers inside the network that webhooks may reach. An
 * entry that does not read (a port, a wildcard, `127.1`), or that is wider
 * than one inside range (`0.0.0.0/0`, or `10.0.0.0/2` for `/24`, which would
 * let every webhook reach this server and the metadata service), or that holds
 * `0.0.0.0` or `::` (`0.0.0.0/8`, `::/8`, `::ffff:10.0.5.0/24`, which is
 * `::/24`), is ignored, and the rest of the list applies. In production the variable changes only
 * with a restart, so this is when it can be wrong.
 */
export function reportWebhookAllowInside(value: string | undefined = process.env.WEBHOOK_ALLOW_INSIDE): boolean {
	if (!value) return false;
	const { bad } = parseAllowInside(value);
	for (const { entry, why } of bad) log.warn(`WEBHOOK_ALLOW_INSIDE: ${JSON.stringify(printable(entry))} ignored: ${why}`);
	return bad.length > 0;
}

/** How many boards the line names. The rest are counted; the admin guide has the query for all of them. */
const LOOP_BOARDS_NAMED = 20;

/** How many boards the line of boards over the webhook cap names. The rest are counted. */
const OVER_CAP_BOARDS_NAMED = 20;

/**
 * One WARN line when any board has more webhooks than the 10 a board may have
 * (card 2201, decision 24), naming each by id and count, never an address
 * (one can carry a token). Returns whether it was said.
 *
 * Such a board was filled before the cap. Its webhooks are kept and every
 * active one is still sent, since which to drop would be a guess, and no
 * webhook can be added to it until it has fewer than 10. Every start says it
 * again until then. The first 20 boards are named, and the rest counted.
 */
export function reportWebhooksOverCap(): boolean {
	const over = boardsOverWebhookCap();
	if (over.length === 0) return false;

	const named = over
		.slice(0, OVER_CAP_BOARDS_NAMED)
		.map((b) => `board ${b.boardId} has ${b.webhooks}`)
		.join(', ');
	const more = over.length > OVER_CAP_BOARDS_NAMED ? `, and ${over.length - OVER_CAP_BOARDS_NAMED} more` : '';
	log.warn(
		`${over.length} board(s) have more webhooks than the ${MAX_WEBHOOKS_PER_BOARD} a board may have: ${named}${more}. ` +
			`All of them are still sent, and none can be added to such a board until it has fewer than ${MAX_WEBHOOKS_PER_BOARD}.`
	);
	return true;
}

/** How many webhooks the line of webhooks refused as written names. The rest are counted. */
const REFUSED_WEBHOOKS_NAMED = 20;

/**
 * One WARN line when any webhook that is on is refused as its address is
 * written (the review of card 2161, O1): an address inside the network that
 * `WEBHOOK_ALLOW_INSIDE` does not name, one that carries a user name or
 * password, or one that is not an http or https URL. Names each by webhook
 * and board, with why, never the path or the query (one can carry a token).
 * Returns whether it was said.
 *
 * No name is looked up: a name that resolves inside is named by the first
 * event's line. The first 20 are named, and the rest counted. Every start says
 * it again while one is on.
 */
export function reportWebhooksRefused(): boolean {
	const refused = activeWebhooksRefused();
	if (refused.length === 0) return false;

	const named = refused
		.slice(0, REFUSED_WEBHOOKS_NAMED)
		.map((w) => `webhook ${w.id} on board ${w.boardId} (${printable(w.reason)})`)
		.join('; ');
	const more = refused.length > REFUSED_WEBHOOKS_NAMED ? `; and ${refused.length - REFUSED_WEBHOOKS_NAMED} more` : '';
	log.warn(
		`${refused.length} webhook(s) that are on are not sent, whatever their names resolve to: ${named}${more}. ` +
			'Each is refused at every event until its address is changed or it is switched off; one inside the network ' +
			'can instead be named in WEBHOOK_ALLOW_INSIDE.'
	);
	return true;
}

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
	if (!isLogged('WARN')) console.warn(`[${new Date().toISOString()}] [WARN] [STARTUP] ${printable(message)}`);
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
 * request link's token a line holds, and the name typed at every failed
 * sign-in at a name that was no account (card 2193), by the rule a backup's
 * copy is masked with (`maskSecretsInLog`, in secret-paths.ts). Returns how
 * many changes it made, or null when it could not be done. Called once, from
 * hooks.server.ts, as the server loads, after the migrations.
 *
 * The gate wrote `GET /invite/<token>` into the log, a live invite in every
 * such line, until 2026-10-14, and any administrator reads that log through
 * `GET /api/logs`. Masking the backups alone left the running log as it was.
 * So an installation that ran the older gate has its log masked at its first
 * start on this one, and every start after finds nothing to change: masked
 * text is not masked again. The log holds at most 50,000 lines, and the only
 * lines rewritten are those holding an unused invite's token, or an invite's
 * address or a `token=` not masked yet, or a failed sign-in's name as typed.
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
				`The system log could not be masked of the invite and request-link tokens, and the names typed at failed sign-ins, it may hold: ` +
					`${(err as Error)?.message ?? err}. GET /api/logs may still show them.`
			);
		} catch {
			// Nothing more to be done about it.
		}
		return null;
	}
}

/**
 * One WARN line at every start while `SIGN_IN_ONE_AT_A_TIME` is `off`
 * (decision 29), to the console whatever LOG_LEVEL is. Returns whether it was
 * said.
 *
 * Off, a guesser who sends many attempts at once at an account is slowed by
 * its waits alone. It is the way back for an owner an attack keeps out of
 * every browser not remembered for the account, the superadmin above all,
 * whom no invite reaches: set it, restart, sign in on the browser needed
 * (which is then remembered), remove it and restart. This line is what says
 * it was left set.
 */
export function reportSignInsNotOneAtATime(off: boolean = !signInsOneAtATime()): boolean {
	if (!off) return false;

	warnOnConsoleAlways(
		'SIGN_IN_ONE_AT_A_TIME=off: sign-ins from browsers not remembered are not held to one at a time. Remove it ' +
			'and restart once the sign-in it was set for is made: see docs/deployment.md, under "If an Attack Keeps an ' +
			'Owner Out".'
	);
	return true;
}

/**
 * One WARN line at every start while `CSP_MODE` is not `enforce` or unset
 * (card 2162, decision 10), to the console whatever LOG_LEVEL is. Returns
 * whether it was said.
 *
 * `report-only` sends every page its Content-Security-Policy to report, not to
 * enforce (`secured` in gate-answers.ts): meant for the first deploy of the
 * policy, while its pages are walked with the browser's console open, and then
 * removed. This line is what says it was left set. Any other value is a typing
 * slip: the policy is enforced, and the line names the value so that it can be
 * put right.
 */
export function reportCspMode(value: string | undefined = process.env.CSP_MODE): boolean {
	if (value === undefined || value === 'enforce') return false;

	if (cspMode(value) === 'report-only') {
		warnOnConsoleAlways(
			'CSP_MODE=report-only: pages are sent the Content-Security-Policy to report only, not to enforce; ' +
				'remove CSP_MODE once the trial is over. See docs/deployment.md.'
		);
	} else {
		warnOnConsoleAlways(
			`CSP_MODE is ${JSON.stringify(printable(value))}, which is neither enforce nor report-only: the ` +
				'Content-Security-Policy is enforced.'
		);
	}
	return true;
}

/**
 * One WARN line at every start while anything a backup does not hold is
 * still to enter (card 2169, decision 7): the mail settings name a host and a
 * user and hold no password; a destination lacks its credentials (as
 * `runBackup` asks it, so not an SFTP one); a webhook listed in this
 * database's `webhook_secrets_left_out` is still there, off and with no
 * secret. Returns whether it was said.
 *
 * A database put in place by hand from a backup has none of them, and nothing
 * else would say so until a backup failed or a receiver noticed. A list that
 * cannot be read is said on the console alone. It reads and it logs, and
 * writes nothing: what to do about a database put in place by hand is the
 * operator's, and the line says where it is written down.
 */
export function reportSecretsToEnter(): boolean {
	const { toEnter, problems } = secretsToEnter(sqlite);
	for (const problem of problems) console.error(`[STARTUP] ${problem}.`);
	const sentence = secretsToEnterSentence(toEnter, true);
	if (sentence === null) return false;

	log.warn(
		`${sentence} A database put in place by hand from a backup has none of them: see docs/admin-guide.md, ` +
			'Restoring from Backup.'
	);
	return true;
}

/** How many SFTP destinations the line of destinations with no confirmed host key names. The rest are counted. */
const UNCONFIRMED_HOST_KEYS_NAMED = 20;

/**
 * One WARN line at every start while any SFTP backup destination has no
 * confirmed host key (card 2250, decision 7), naming each, the first 20 and
 * then how many more. Returns whether it was said.
 *
 * `runBackup` does not try such a destination, and says so in Backup History
 * and the failure mail; where mail is off, this line in `docker logs` is what
 * tells the deploy that every SFTP destination needs Test and Confirm before
 * its scheduled backups go again. A destination with neither password nor key
 * is named too: it would still upload the database to whoever answers.
 */
export function reportUnconfirmedHostKeys(): boolean {
	const names = unconfirmedHostKeys(sqlite);
	if (names.length === 0) return false;

	const named = names
		.slice(0, UNCONFIRMED_HOST_KEYS_NAMED)
		.map((name) => `"${printable(name)}"`)
		.join(', ');
	const more = names.length > UNCONFIRMED_HOST_KEYS_NAMED ? `; and ${names.length - UNCONFIRMED_HOST_KEYS_NAMED} more` : '';
	log.warn(
		`${names.length} SFTP backup destination(s) have no confirmed host key, and nothing is sent to them until one is ` +
			`confirmed: ${named}${more}. In Admin, Scheduled Backups, press Test on each and confirm the key it shows.`
	);
	return true;
}

/**
 * Say all thirteen, if they are so. Called once, from hooks.server.ts, as the
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
		() => reportOtherDatabase(),
		() => reportSignInsNotOneAtATime(),
		() => reportCspMode(),
		reportSecretsToEnter,
		() => reportWebhookAllowInside(),
		reportWebhooksOverCap,
		reportWebhooksRefused,
		reportUnconfirmedHostKeys
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
