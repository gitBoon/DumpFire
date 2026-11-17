/**
 * startup-checks.ts — fourteen things about an installation that are said in the
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
 * off nothing else says so. The fourteenth, in a built server only, is an
 * `http:` `ORIGIN` behind an `https:` App URL (card 2850): every request is
 * then taken as plain HTTP, so cookies go without Secure and sign-in forms
 * from the https address are refused.
 *
 * And two that do stop the server, after the migrations and before it
 * listens: `refuseUserlessBesideAnother`, when the database in use has no
 * users while another database is beside it; and `checkMfaKeyAtStart` (card
 * 2768), straight after it, when the key that protects authenticator secrets
 * does not load (under the production rules `MFA_KEY_FILE` must name it) or
 * is not the key the stored second factors were made with. It also records
 * the key's check when factors are stored without one, names at ERROR each
 * factor that does not open, and warns on the console of a key file others
 * can read or one kept in the database's own folder. With
 * `MFA_KEY_FILE_PREVIOUS` set it changes the key (card 2773): every factor of
 * the old key is sealed again under the new one before the server listens.
 *
 * And five things that are changed at start, beside them: `maskLiveLog`,
 * which masks the secrets an older gate wrote into the system log;
 * `removeSettingsOfNonAdministrators`, which removes the mail settings, App
 * URL and backup destinations set by someone who is no longer an
 * administrator (card 2406); `endPlainInvites`, which ends the unused
 * invites an older image kept in plain and replaces the token of the used ones
 * (card 2849); `endPlainSessions`, which ends the sessions an older image
 * kept in plain (card 2775); and `endPlainRequestLinks`, which, when an older
 * image has written requester links in plain, empties them and ends every
 * link (card 2870), and which stops the server, alone of the five, when it
 * can neither look nor end every link. And one thing said once, at the first start
 * after card 2751: `announceReportSchedules`, which tells each owner of a
 * report schedule that is on which of theirs are running.
 */
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { dev } from '$app/environment';
import { createdAtStart, getDbPath, otherDatabaseAtStart, sqlite } from './db';
import { DatabaseLocationError, described, heldInContainerLayer, type OtherDatabase } from './db/location';
import { PLACEHOLDER_ORIGIN, configuredOrigin, getAppUrl, isSmtpConfigured, smtpPasswordMissing } from './email';
import { securityNoticeSent, type NoticeSchedule } from './notifications';
import { reportCovers } from './reports';
import { schedulerSetting } from './schedulers';
import { reportRecipients } from '$lib/report-recipients';
// `printable` is the logger's cleaner (card 2214), which `emit` applies to
// every line as well. Names are still put through it where they sit inside
// quotes, and the line printed past LOG_LEVEL below does not go through `emit`.
import { createLogger, isLogged, printable } from './logger';
import { maskSecretsInLog } from './secret-paths';
import { NOT_IN_HASH_FORM, REPLACE_PLAIN_USED_INVITES } from './invites';
import { SESSION_NOT_IN_HASH_FORM, httpsOnlyCookie } from './auth';
import { END_PLAIN_REQUEST_LINKS } from './request-tokens';
import { signInsOneAtATime } from './known-browsers';
import { cspMode } from './gate-answers';
import { boardsInLoops } from './sub-boards';
import { secretsToEnter, secretsToEnterSentence, unconfirmedHostKeys } from './backup-secrets';
import { parseAllowInside } from './webhook-address';
import { activeWebhooksRefused, boardsOverWebhookCap, MAX_WEBHOOKS_PER_BOARD } from './webhooks';
import { removeSettingsOfFormerAdministrators } from './setting-setters';
import {
	MFA_KEY_CHECK_SETTING,
	loadPreviousMfaKey,
	mfaKeyLoad,
	mfaStartVerdict,
	type FactorAtStart,
	type KeyLoad,
	type PreviousKeyLoad
} from './mfa-key';
import { factorAad, openSealed, sealWith } from './mfa-crypto';
import { readMfaKeyCheck } from './mfa-store';

const log = createLogger('STARTUP');
const authLog = createLogger('AUTH');
const reportsLog = createLogger('REPORTS');
const requestsLog = createLogger('REQUESTS');

/**
 * One CRITICAL line when there are user accounts and none of them is the
 * superadmin. Returns whether it was said.
 *
 * The export, the import and the reset are the superadmin's alone (the
 * backup and mail settings are every administrator's since card 2395),
 * `superadmin` is written by set-up and
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
			'or reset the database. Make one account the superadmin from the ' +
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
 *
 * Kept under STARTUP unless it is given another context: the line of a key
 * change is AUTH's (card 2773, decision 18).
 */
function warnOnConsoleAlways(message: string, context: 'STARTUP' | 'AUTH' = 'STARTUP'): void {
	// One path for both contexts (card 2773's review), so the two cannot drift apart.
	const logger = context === 'AUTH' ? authLog : log;
	logger.warn(message);
	if (isLogged('WARN')) return;
	const line = context === 'AUTH' ? `[WARN] [AUTH] ${printable(message)}` : `[WARN] [STARTUP] ${printable(message)}`;
	console.warn(`[${new Date().toISOString()}] ${line}`);
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

/** What `checkMfaKeyAtStart` throws, carrying the `[CRITICAL] [AUTH]` line it wrote to the console. */
export class MfaKeyError extends Error {
	constructor(
		message: string,
		readonly line: string
	) {
		super(message);
		this.name = 'MfaKeyError';
	}
}

/** How many unreadable factors the ERROR line names one by one. */
const UNREADABLE_NAMED = 20;

/**
 * Stop the server, before it listens, when the key that protects
 * authenticator secrets does not load, or is not the key the stored second
 * factors were made with (`mfaStartVerdict`, in mfa-key.ts): writes one
 * `[CRITICAL] [AUTH]` line to the console and throws an `MfaKeyError`. Called
 * once, from hooks.server.ts, straight after `refuseUserlessBesideAnother`,
 * as a bare call: the throw is what stops a built server (exit code 1).
 *
 * When it starts: records the key's check if factors are stored without one,
 * writes one AUTH ERROR line naming the factors that do not open (each can
 * still sign in with a recovery code, and none is a wrong code), says, when
 * this start made a new key, where it is and that it must be backed up apart
 * from the database, and writes each warning to the console whatever
 * LOG_LEVEL is. The line names paths and
 * reasons, through `printable`, and never anything the key file holds.
 *
 * And the key is changed here (card 2773, decision 1): with
 * `MFA_KEY_FILE_PREVIOUS` naming the old key (`previous`, read afresh at every
 * call and never kept), every factor that opens with it is sealed again under
 * this server's key, with a new nonce and the same additional data, its
 * `factor_uid` and `last_step` kept; every pending enrolment sealed under the
 * old key is deleted, as it can no longer be opened; and this key's check is
 * recorded. All of it in one `BEGIN IMMEDIATE` transaction that reads the
 * factors and the check again and decides again, so that another instance
 * still running on the old key cannot write between the read and the commit
 * (decision 16): a database another instance holds fails the start, which
 * changes nothing, and starting again is safe. What was opened, and the keys
 * derived from the old one, are zeroed once used (decision 17). `seal` is a
 * seam for the tests, to fail partway.
 */
export function checkMfaKeyAtStart(
	load: KeyLoad = mfaKeyLoad(),
	factors: () => readonly FactorAtStart[] = readFactorsAtStart,
	storedCheck: () => string | null = () => readMfaKeyCheck(sqlite),
	previous: PreviousKeyLoad = loadPreviousMfaKey({ keyFile: process.env.MFA_KEY_FILE_PREVIOUS }),
	seal: typeof sealWith = sealWith
): void {
	try {
		startWithMfaKey(load, factors, storedCheck, previous, seal);
	} finally {
		// The old key is needed for nothing after this (decision 17).
		if (previous.ok && previous.key !== null) previous.key.encryptionKey.fill(0);
	}
}

/** The one `[CRITICAL] [AUTH]` line of a start refused, written to the console, and the error to throw. */
function mfaKeyRefusal(reason: string): MfaKeyError {
	const message = `The server will not start. ${reason}`;
	const line = `[${new Date().toISOString()}] [CRITICAL] [AUTH] ${printable(message)}`;
	console.error(line);
	return new MfaKeyError(message, line);
}

function startWithMfaKey(
	load: KeyLoad,
	factors: () => readonly FactorAtStart[],
	storedCheck: () => string | null,
	previous: PreviousKeyLoad,
	seal: typeof sealWith
): void {
	let verdict = mfaStartVerdict({ load, factors: factors(), storedCheck: storedCheck(), previous });
	if (verdict.refuse !== null) throw mfaKeyRefusal(verdict.refuse);

	const old = previous.ok ? previous.key : null;
	// Card 2773: an enrolment sealed under the previous key is deleted even on a
	// start with nothing to seal again and no check to record (a second start
	// with MFA_KEY_FILE_PREVIOUS still set, say), as nothing opens it any more.
	const staleChallenges =
		old !== null && sqlite.prepare('SELECT 1 FROM sign_in_challenges WHERE key_id = ? LIMIT 1').get(old.id) !== undefined;
	if (load.ok && (verdict.reseal.length > 0 || verdict.recordCheck !== null || staleChallenges)) {
		const key = load.key;
		try {
			verdict = sqlite
				.transaction(() => {
					// Read and decided again, under the write lock: what was read above
					// may have been changed by another instance since (decision 16).
					const stored = factors();
					const again = mfaStartVerdict({ load, factors: stored, storedCheck: storedCheck(), previous });
					if (again.refuse !== null) throw mfaKeyRefusal(again.refuse);

					if (again.reseal.length > 0 && old !== null) {
						const byId = new Map(stored.map((factor) => [factor.id, factor]));
						const update = sqlite.prepare(
							'UPDATE mfa_factors SET key_id = ?, secret_nonce = ?, secret_ciphertext = ? WHERE id = ? AND key_id = ?'
						);
						for (const id of again.reseal) {
							const factor = byId.get(id)!;
							const aad = factorAad(factor.userId, factor.factorUid);
							const secret = openSealed(old, factor, aad);
							if (secret === null) throw new Error(`factor ${id} no longer opens with the previous key`);
							try {
								const sealed = seal(key, secret, aad);
								if (update.run(sealed.keyId, sealed.nonce, sealed.ciphertext, id, old.id).changes !== 1) {
									throw new Error(`factor ${id} was changed while it was sealed again`);
								}
							} finally {
								secret.fill(0);
							}
						}
					}

					// A secret being set up, sealed under the old key, opens with nothing now.
					if (old !== null) sqlite.prepare('DELETE FROM sign_in_challenges WHERE key_id = ?').run(old.id);

					if (again.recordCheck !== null) {
						sqlite
							.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
							.run(MFA_KEY_CHECK_SETTING, again.recordCheck);
					}
					return again;
				})
				.immediate();
		} catch (err) {
			if (err instanceof MfaKeyError) throw err;
			throw mfaKeyRefusal(
				`The second factors could not be sealed again under the new MFA key (${(err as Error)?.message ?? String(err)}). ` +
					'Nothing was changed, and starting again is safe; if another instance is running on this database, ' +
					'stop it first. See docs/deployment.md, The Key That Protects Authenticator Secrets.'
			);
		}

		// Said whatever LOG_LEVEL is: the new key is now the only one that opens
		// the factors, and no backup holds it (decision 18).
		if (verdict.reseal.length > 0) {
			warnOnConsoleAlways(
				`Rotated ${verdict.reseal.length} second factor(s) to the new MFA key. Back up the new key now, then remove ` +
					'MFA_KEY_FILE_PREVIOUS; keep the old key file offline for as long as you keep backups made before today.',
				'AUTH'
			);
		}
	}

	if (verdict.unreadable.length > 0) {
		const named = verdict.unreadable
			.slice(0, UNREADABLE_NAMED)
			.map((factor) => `factor ${factor.id} of user ${factor.userId}`)
			.join(', ');
		const more = verdict.unreadable.length > UNREADABLE_NAMED ? `, and ${verdict.unreadable.length - UNREADABLE_NAMED} more` : '';
		authLog.error(
			`${verdict.unreadable.length} second factor(s) could not be opened with this server's MFA key: ${named}${more}. ` +
				'None is counted as a wrong code; each account can sign in with a recovery code, or have its two-step ' +
				'sign-in reset.',
			{ unreadable: verdict.unreadable.length }
		);
	}

	// A key this start made (development and test only, mfa-key.ts) is said
	// whatever LOG_LEVEL is: it is the only copy, and no backup holds it.
	if (load.ok && load.made && load.path !== null) {
		warnOnConsoleAlways(
			`The server made a new MFA key at ${printable(load.path)}. Back it up apart from the database: no backup ` +
				'holds it, and without it every second factor is lost. See docs/deployment.md, The Key That Protects ' +
				'Authenticator Secrets.'
		);
	}

	for (const warning of verdict.warnings) warnOnConsoleAlways(warning);
}

function readFactorsAtStart(): FactorAtStart[] {
	return sqlite
		.prepare(
			'SELECT id, user_id AS userId, factor_uid AS factorUid, key_id AS keyId, secret_ciphertext AS ciphertext, ' +
				'secret_nonce AS nonce FROM mfa_factors ORDER BY id'
		)
		.all() as FactorAtStart[];
}

/**
 * Mask, in the running database's own system log, every invite's address and
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
 * lines rewritten are those holding an invite's address or a `token=` not
 * masked yet, or a failed sign-in's name as typed.
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
 * Remove what each setter who is no longer an administrator set: their mail
 * settings, App URL and backup destinations, by card 2397's rule (card 2406,
 * `removeSettingsOfFormerAdministrators` in setting-setters.ts). Returns how
 * many such setters were found, or null when it could not be done. Called
 * once, from hooks.server.ts, after the migrations and before the schedulers
 * start, so that no scheduled backup is sent to such a destination first.
 *
 * A role written to `user` from the host runs no application code, and nor
 * does a delete made there with foreign keys off: each left that person's
 * settings in force. Each removal is a WARN line under SMTP or BACKUP, as a
 * demotion on the admin page is. An account deleted from the host with
 * foreign keys on takes its setter rows with it, and its settings cannot be
 * told from ones nobody is recorded for: they stay.
 *
 * It never throws: what cannot be removed is no reason not to start. It is
 * said at WARN, and the server starts.
 */
export function removeSettingsOfNonAdministrators(): number | null {
	try {
		return removeSettingsOfFormerAdministrators().length;
	} catch (err) {
		try {
			log.warn(
				`The settings of setters who are no longer administrators could not be checked: ${(err as Error)?.message ?? err}. ` +
					'Mail and backups may still go where such a person set them.'
			);
		} catch {
			// Nothing more to be done about it.
		}
		return null;
	}
}

/**
 * End every invite not yet used that is held in plain (card 2849, plan
 * decision 9), give every used one held in plain 0068's replacement token,
 * and return how many rows that changed, or null when it could not be done.
 * Called once, from hooks.server.ts, after the migrations.
 *
 * From card 2849 an invite's token is kept only as its SHA-256, 32 bytes as a
 * BLOB. An image from before it, started on this database after going back,
 * keeps the token as mailed, as text: this image never matches it, but it is
 * readable, and it would work again if that older image were started again.
 * Its link shows the page for a link that no longer works. A used one is no
 * credential, but no row is to hold a token as it was mailed, so it is given
 * 0068's replacement and keeps its row, marked used. At the release this
 * finds nothing: 0068 has run.
 *
 * Both in one transaction, so that a replacement that fails takes the deletes
 * back with it. One WARN line under AUTH, built from what changed, when it
 * changed any; nothing when it did not, so a second start says nothing. It
 * never throws: a failure is said at WARN, and the server starts.
 */
export function endPlainInvites(): number | null {
	try {
		const [ended, replaced] = sqlite.transaction(() => [
			sqlite.prepare(`DELETE FROM invite_tokens WHERE used = 0 AND ${NOT_IN_HASH_FORM}`).run().changes,
			sqlite.prepare(REPLACE_PLAIN_USED_INVITES).run().changes
		])();
		const said: string[] = [];
		if (ended > 0) {
			said.push(
				`Ended ${ended} invite(s) held in plain, written by an older image: their links no longer work. ` +
					'Send again, from User Management, the invites still wanted.'
			);
		}
		if (replaced > 0) {
			said.push(
				`Replaced the token of ${replaced} used invite(s) held in plain, written by an older image, with 32 random bytes.`
			);
		}
		if (said.length > 0) authLog.warn(said.join(' '));
		return ended + replaced;
	} catch (err) {
		try {
			authLog.warn(
				`Invites held in plain by an older image could not be ended: ${(err as Error)?.message ?? err}. ` +
					'They do not work on this image, and would work again on the older one.'
			);
		} catch {
			// Nothing more to be done about it.
		}
		return null;
	}
}

/** The `settings` key that says the report schedules running at the release were announced (card 2751, D14). */
export const REPORT_SCHEDULES_ANNOUNCED = 'report_schedules_announced';

/**
 * Tell each owner of a report schedule that is on, once, which of theirs are
 * running (card 2751, S1, D14). Resolves to how many owners there were once
 * the flag is written, 0 when it was already there, and null when it was not
 * written, so that the next start does it again. Called once, from
 * hooks.server.ts, after `endPlainInvites` and before the schedulers start,
 * and not awaited: the start does not wait on the mail server. The lines are
 * written, and every notice begun, before it first waits.
 *
 * A schedule made before the release was made with no password, perhaps by
 * someone holding the owner's session, and keeps sending. So, at the first
 * start: one WARN line under REPORTS for each schedule that is on, its owner
 * as the line's user, naming the owner, the schedule, what it covers and
 * every address (WARN, so that LOG_LEVEL=WARN keeps them, CS3); then one
 * `report-schedules-running` notice to each owner, listing theirs; then, once
 * every notice has been answered and every one went,
 * `settings.report_schedules_announced`, the date, is written, with `INSERT
 * OR IGNORE`, as two instances may both get there. With it there, nothing is
 * done and 0 is returned. A notice that did not go leaves the flag unwritten
 * (CS1): one WARN line names the owners not told, and the next start says it
 * all again, to every owner. A start that stops before the flag says it again
 * too, never not at all. A restore of a backup from before the release has no
 * flag, and the next start says it again.
 *
 * Only where the schedulers run, by the decision `startSchedulers` makes
 * (CS2): under the dev server, or with SCHEDULERS=off, one INFO line says it
 * was not done, nothing is sent and no flag is written, so that a rehearsal
 * or a dev copy of production's data mails nobody, and the first start that
 * runs the schedulers says it.
 *
 * With no mail set up no notice is sent: one WARN line says how many owners,
 * and which, were not told, the lines above being the record, and the flag
 * is written all the same. It never rejects: a failure is said at WARN, the
 * flag is not written, and the next start tries again.
 */
export async function announceReportSchedules(
	value: string | undefined = process.env.SCHEDULERS,
	isDev: boolean = dev
): Promise<number | null> {
	try {
		if (sqlite.prepare('SELECT 1 FROM settings WHERE key = ?').get(REPORT_SCHEDULES_ANNOUNCED)) return 0;
		const setting = schedulerSetting(value, isDev);
		if (!setting.run) {
			reportsLog.info(
				`The owners of report schedules that are on were not told of them, as the schedulers are off (${setting.reason}). ` +
					'The first start that runs the schedulers tells them.'
			);
			return null;
		}
		const running = sqlite
			.prepare(
				`SELECT s.id, s.user_id AS userId, s.name, s.scope, s.scope_id AS scopeId, s.recipients, u.username
				 FROM report_schedules s JOIN users u ON u.id = s.user_id
				 WHERE s.enabled = 1 ORDER BY s.user_id, s.id`
			)
			.all() as { id: number; userId: number; name: string; scope: string; scopeId: number | null; recipients: string; username: string }[];
		const owners = new Map<number, { username: string; schedules: NoticeSchedule[] }>();
		for (const schedule of running) {
			const covers = reportCovers(schedule.scope, schedule.scopeId);
			const addresses = reportRecipients(schedule.recipients).addresses;
			reportsLog.warn(
				`Report schedule ${schedule.id} "${schedule.name}" of "${schedule.username}" (user ${schedule.userId}) is on at this release, ` +
					`a report of ${covers}, sent to: ${addresses.length === 0 ? 'no address' : addresses.join(', ')}`,
				{ scheduleId: schedule.id },
				{ userId: schedule.userId }
			);
			const owner = owners.get(schedule.userId) ?? { username: schedule.username, schedules: [] };
			owner.schedules.push({ name: schedule.name, covers, addresses });
			owners.set(schedule.userId, owner);
		}
		const at = new Date();
		const named = (list: { username: string }[]) => list.map((owner) => `"${owner.username}"`).join(', ');
		if (owners.size > 0 && (!isSmtpConfigured() || smtpPasswordMissing())) {
			reportsLog.warn(
				`${owners.size} owner(s) of report schedules that are on were not told of them, as mail is not set up: ` +
					`${named([...owners.values()])}. The WARN lines above name each schedule and its addresses.`
			);
		} else {
			// Every notice begun before the first wait; each answers whether it went, and never rejects.
			const told = [...owners].map(([userId, owner]) =>
				securityNoticeSent(userId, 'report-schedules-running', { at, address: null, schedules: owner.schedules })
			);
			const answers = await Promise.allSettled(told);
			const notTold = [...owners.values()].filter((_, i) => {
				const answer = answers[i];
				return answer.status !== 'fulfilled' || answer.value !== true;
			});
			if (notTold.length > 0) {
				reportsLog.warn(
					`${notTold.length} owner(s) of report schedules that are on were not told of them, as the mail did not go: ` +
						`${named(notTold)}. The WARN lines above name each schedule and its addresses. The next start tells every owner again.`
				);
				return null;
			}
		}
		sqlite.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(REPORT_SCHEDULES_ANNOUNCED, at.toISOString());
		return owners.size;
	} catch (err) {
		try {
			reportsLog.warn(
				`The owners of report schedules that are on could not be told of them: ${(err as Error)?.message ?? err}. ` +
					'The next start tries again.'
			);
		} catch {
			// Nothing more to be done about it.
		}
		return null;
	}
}

/**
 * End every session held in plain (card 2775, plan decision 3), and return
 * how many, or null when it could not be done. Called once, from
 * hooks.server.ts, after the migrations and before `cleanExpiredSessions`,
 * so that an expired one is counted here and not deleted unsaid.
 *
 * From card 2775 a session's code is kept only as its SHA-256, 32 bytes as a
 * BLOB. An image from before it, started on this database after going back,
 * keeps the code as the cookie holds it, as text: this image never matches
 * it, but it would sign its holder in again if that older image were started
 * again. At the release this finds nothing: 0067 has ended every session.
 *
 * One WARN line under AUTH when it ended any; nothing when it did not, so a
 * second start says nothing. It never throws: a failure is said at WARN, and
 * the server starts.
 */
export function endPlainSessions(): number | null {
	try {
		const ended = sqlite.prepare(`DELETE FROM sessions WHERE ${SESSION_NOT_IN_HASH_FORM}`).run().changes;
		if (ended > 0) {
			authLog.warn(`Ended ${ended} session(s) held in plain, written by an older image: those browsers sign in again.`);
		}
		return ended;
	} catch (err) {
		try {
			authLog.warn(
				`Sessions held in plain by an older image could not be ended: ${(err as Error)?.message ?? err}. ` +
					'They do not sign anyone in on this image, and would on the older one.'
			);
		} catch {
			// Nothing more to be done about it.
		}
		return null;
	}
}

/**
 * End every requester link when an older image has run (card 2870, decision
 * 11), and return how many rows that changed, or null when it could not be
 * done. Called once, from hooks.server.ts, after the migrations.
 *
 * From card 2870 a request's links are kept only as hashes, in
 * `request_links`, and the retired `task_requests.access_token` is always
 * NULL. An image from before it, started on this database after going back,
 * gives every request a new plain token there at its start: no link opens
 * with it here, but it is readable, and it would work again if that older
 * image were started again. So any plain value is set back to NULL. And while
 * the older image ran, `request_links` was outside its rules: its restore or
 * its reset may have replaced the requests and left the table as it was, so
 * a kept link could open somebody else's thread. Finding any plain value, it
 * therefore deletes every link too (fail closed); each requester asks for a
 * new one from the page their link opens. At the release this finds nothing:
 * 0070 has run. A start after no older image changes nothing.
 *
 * Both in one transaction. One WARN line under REQUESTS when it changed any
 * row; nothing when it did not, so a second start says nothing.
 *
 * When that fails, for any reason, every link is ended on its own (`DELETE
 * FROM request_links`, fail closed; the code review's CS3), since whether an
 * older image ran is then not known: it returns null, and one WARN line says
 * both, and the server starts. When that fails too, it throws, before the
 * server listens, as `ensureFormSecret` does: the server refuses to start
 * rather than run with links that may open other people's threads.
 */
export function endPlainRequestLinks(): number | null {
	try {
		const [plain, ended] = sqlite.transaction(() => {
			const plain = sqlite.prepare(END_PLAIN_REQUEST_LINKS).run().changes;
			// An older image has run: end every link, kept or not (decision 11).
			const ended = plain > 0 ? sqlite.prepare('DELETE FROM request_links').run().changes : 0;
			return [plain, ended];
		})();
		if (plain > 0) {
			requestsLog.warn(
				`Ended the links of ${plain} request(s) held in plain by an older image, and ${ended} link(s) kept as hashes: ` +
					'no request link mailed before this start works. Each requester can have a new one sent from the page a link opens.'
			);
		}
		return plain + ended;
	} catch (err) {
		const why = (err as Error)?.message ?? err;
		let ended: number;
		try {
			ended = sqlite.prepare('DELETE FROM request_links').run().changes;
		} catch (again) {
			throw new Error(
				`Request links held in plain by an older image could not be looked for (${why}), and the links kept as ` +
					`hashes could not be ended either (${(again as Error)?.message ?? again}). The server does not start ` +
					"while a kept link may open somebody else's request."
			);
		}
		try {
			requestsLog.warn(
				`Request links held in plain by an older image could not be looked for: ${why}. Every link kept as a ` +
					`hash was ended instead (${ended}): no request link mailed before this start works, and each ` +
					'requester can have a new one sent from the page a link opens. Any plain value is still in ' +
					'task_requests.access_token, where it opens nothing on this image, and would on the older one.'
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
 * One WARN line in a built server whose App URL is `https:` while `ORIGIN`
 * is set and `http:`, and a plain-HTTP request would get no Secure cookie
 * (card 2850, decision 4). Returns whether it was said.
 *
 * With `ORIGIN` set, the node adapter takes every request's address from it,
 * whatever the proxy in front says. So behind an HTTPS proxy every request
 * counts as plain HTTP: a sign-in form posted from the https address is
 * refused by the framework's origin check, and the cookies set elsewhere (the
 * set-up link's, a password change's) go without Secure unless
 * `COOKIE_SECURE` or `NODE_ENV` asks for it. With `ORIGIN` `https:` every
 * cookie is Secure, and with it unset the scheme is the proxy's to say, so
 * neither is judged here. Not under the dev server, which is plain HTTP.
 */
export function reportPlainOriginBehindHttps(isDev: boolean = dev, origin: string | undefined = process.env.ORIGIN): boolean {
	if (isDev) return false;
	const appUrl = getAppUrl();
	if (!appUrl || !/^https:\/\//i.test(appUrl)) return false;
	const plain = configuredOrigin(origin);
	if (!plain || !plain.startsWith('http:')) return false;
	if (httpsOnlyCookie(new URL(plain))) return false;

	log.warn(
		`ORIGIN is ${plain} but the App URL is ${appUrl}: every request is taken as plain HTTP, so cookies are not ` +
			'marked Secure and sign-in forms from the https address are refused. Start the server with ORIGIN set to ' +
			'the https address.'
	);
	return true;
}

/**
 * Say all fourteen, if they are so. Called once, from hooks.server.ts, as the
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
		reportUnconfirmedHostKeys,
		() => reportPlainOriginBehindHttps()
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
