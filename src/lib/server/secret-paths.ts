/**
 * secret-paths.ts — the addresses that carry a secret in their path, and how
 * the system log writes them down.
 *
 * The gate writes every request's path to the system log, and an invite's
 * token is the last part of its address: `GET /invite/<token>` put a live
 * invite, which sets its account's password, in `system_logs`, where any
 * administrator could read it from `GET /api/logs` and every backup kept it.
 * So such a path is written down with the secret masked (`pathToLog`), and
 * what the log already holds is masked the same way (`maskSecretsInLog`): in
 * a backup's copy, by `withoutSecrets` in backup.ts, and in the running
 * database's own log once at every start, by startup-checks.ts.
 *
 * Only the path is ever written down, never the query, so a token sent as
 * `?token=` (the public request form's links, `/request/[id]/reply` and
 * `/request/[id]/confirm`, and what their pages ask of `/api/requests/[id]`
 * and `/api/requests/[id]/messages`) is not written down to begin with.
 * tests/gate.test.ts holds both. A line that holds such a link all the same,
 * written some other way, has its token masked with the rest.
 *
 * And a failed sign-in at a name that was no account (card 2193): sign-in
 * wrote `Failed login attempt for "<what was typed>" from IP …`, which held a
 * password typed into the name box in clear. It writes only the name's length
 * now, and what the log already holds is rewritten that way
 * (`maskFailedSignIn`), by the same two callers.
 */
import type Database from 'better-sqlite3';

/**
 * Each route whose path holds a secret, by route id, with the part of the
 * address that comes before the secret.
 */
const SECRET_IN_PATH: readonly { routeId: string; before: string }[] = [{ routeId: '/invite/[token]', before: '/invite/' }];

/**
 * The path to write to the log for a request: `sent`, the address as it was
 * sent, unless it is under one of `SECRET_IN_PATH`. Then it is the route's id,
 * `/invite/[token]`, which names what was asked for and holds nothing of the
 * secret.
 *
 * `routed` is the path the gate decided on (`routedPath` in hooks.server.ts):
 * the route's id where one matched, and the decoded address where none did.
 * A path under `/invite/` that is no route is masked the same way, encoded or
 * not, because what follows `/invite/` may still be a token.
 */
export function pathToLog(sent: string, routed: string): string {
	for (const { routeId, before } of SECRET_IN_PATH) {
		if (routed === routeId || routed.startsWith(before)) return routeId;
	}
	return sent;
}

/**
 * `text` with every secret in a path masked as `pathToLog` masks it: what
 * follows `/invite/`, up to the next `/`, `?`, `#`, quote or space, becomes
 * `[token]`. For a log line that was written before the gate masked it.
 *
 * And a request link's token in a query: what follows `?token=` or
 * `&token=`, up to the next `&`, `#`, quote or space, becomes `[token]` too.
 * Masked text is left as it is, so masking twice changes nothing.
 */
export function maskSecretPaths(text: string): string {
	let masked = text;
	for (const { routeId, before } of SECRET_IN_PATH) {
		const secret = new RegExp(`${before.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[^/?#"'\\s]+`, 'g');
		masked = masked.replace(secret, routeId);
	}
	return masked.replace(/([?&]token=)[^&#"'\s]+/g, '$1[token]');
}

/** How a failed sign-in line began before card 2193, when it held the name as typed. */
export const OLD_FAILED_SIGN_IN = 'Failed login attempt for "';

/**
 * An old failed sign-in line for a name that was no account, the name greedy
 * to the last `" from IP `, line breaks and quotes in it included (the
 * review's R7): sign-in wrote the name exactly as it was typed.
 */
const OLD_FAILED_SIGN_IN_LINE = /^Failed login attempt for "([\s\S]*)" from IP (.*)$/;

/**
 * `message` with the name an old failed sign-in line holds taken out: the
 * line for a name that was no account becomes the one sign-in writes now,
 * `Failed login attempt for a name that is no account (N characters) from IP
 * …`, N being how long what was between the quotes was. A line ending
 * ` (bad password)` was at an account and is left as it is, as is any other
 * line; and a line in the new form does not begin as the old did, so
 * rewriting twice changes nothing.
 */
export function maskFailedSignIn(message: string): string {
	if (message.endsWith(' (bad password)')) return message;
	const old = OLD_FAILED_SIGN_IN_LINE.exec(message);
	if (!old) return message;
	return `Failed login attempt for a name that is no account (${old[1].length} characters) from IP ${old[2]}`;
}

/** The text `maskSecretPaths` looks for, for a query to find the lines it would change. */
export const SECRET_PATH_MARKERS: readonly string[] = [...SECRET_IN_PATH.map(({ before }) => before), 'token='];

/**
 * Mask every secret in the `system_logs` of `database`, and return how many
 * changes that made: 0 when there was nothing to mask.
 *
 * Three things, in this order:
 *
 *   - The token of every invite not yet used, wherever a line holds it,
 *     becomes `[token]`. Asked of `invite_tokens`, so a token the log wrote
 *     some other way than in an address is found too.
 *   - Every line is masked as `maskSecretPaths` masks it: an invite's
 *     address, whatever its token, and a request link's `token=`.
 *   - Every old failed sign-in line at a name that was no account loses the
 *     name, as `maskFailedSignIn` takes it out.
 *
 * Only a line that would change is written, so a second run over the same
 * log changes nothing. The log is capped at 50,000 lines (logger.ts), and a
 * line is looked at by SQLite's `instr` before anything here is asked of it.
 *
 * Run over a backup's copy by `withoutSecrets` in backup.ts, and over the
 * running database at start by `maskLiveLog` in startup-checks.ts: one rule,
 * so that the log a backup holds and the log an administrator reads cannot
 * differ. A table that is not there is skipped; anything else that goes
 * wrong is thrown, for the caller to decide.
 */
export function maskSecretsInLog(database: Database.Database): number {
	const has = (table: string) =>
		!!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
	if (!has('system_logs')) return 0;

	let changes = 0;
	if (has('invite_tokens')) {
		const unused = database.prepare('SELECT token FROM invite_tokens WHERE used = 0').pluck().all() as string[];
		const replace = database.prepare(
			"UPDATE system_logs SET message = replace(message, @token, '[token]'), meta = replace(meta, @token, '[token]') " +
				'WHERE instr(message, @token) > 0 OR instr(meta, @token) > 0'
		);
		for (const token of unused) if (token) changes += replace.run({ token }).changes;
	}

	database.function('mask_secret_paths', (text: unknown) => (typeof text === 'string' ? maskSecretPaths(text) : text));
	const holds = SECRET_PATH_MARKERS.map(() => 'instr(message, ?) > 0 OR instr(meta, ?) > 0').join(' OR ');
	changes += database
		.prepare(
			'UPDATE system_logs SET message = mask_secret_paths(message), meta = mask_secret_paths(meta) ' +
				`WHERE (${holds}) AND (mask_secret_paths(message) IS NOT message OR mask_secret_paths(meta) IS NOT meta)`
		)
		.run(...SECRET_PATH_MARKERS.flatMap((marker) => [marker, marker])).changes;

	database.function('mask_failed_sign_in', (text: unknown) => (typeof text === 'string' ? maskFailedSignIn(text) : text));
	changes += database
		.prepare(
			'UPDATE system_logs SET message = mask_failed_sign_in(message) ' +
				'WHERE substr(message, 1, ?) = ? AND mask_failed_sign_in(message) IS NOT message'
		)
		.run(OLD_FAILED_SIGN_IN.length, OLD_FAILED_SIGN_IN).changes;
	return changes;
}
