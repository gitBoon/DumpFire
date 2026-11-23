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
 * A decision's personal link, `/decision-link/<token>` (card 2675, plan
 * decision 9, R3), is masked the same way: its token lets someone with no
 * account see a decision and answer it, and a mail server's refusal can quote
 * it, which `maskMailText` in email.ts masks by this list before the line is
 * logged. Its page is card 2677's. The holder's response and seen are sent to
 * `/api/decision-by-link/responses` and `/api/decision-by-link/seen`, a
 * concern about the ruling to `/api/decision-by-link/concerns` (card 2679),
 * a clarification question to `/api/decision-by-link/questions` (card 2678),
 * and an objection or request to talk to `/api/decision-by-link/flags` (card
 * 2684), the token in the body (card 2677, decision 4): their paths hold no secret, and do not
 * contain `/decision-link/`, which `maskSecretPaths`, matching anywhere in a
 * line, would rewrite (F2).
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
import { hostOf } from './webhook-address';

/**
 * Each route whose path holds a secret, by route id, with the part of the
 * address that comes before the secret.
 */
const SECRET_IN_PATH: readonly { routeId: string; before: string }[] = [
	{ routeId: '/invite/[token]', before: '/invite/' },
	{ routeId: '/decision-link/[token]', before: '/decision-link/' },
	// An enrolment link (card 2773, F1): its token, with the account's password,
	// sets up the account's second factor. Masked before its page exists (card
	// 2769), so that no link opened is ever written down.
	{ routeId: '/enrol/[token]', before: '/enrol/' }
];

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
 *
 * `anyCase` finds the path in any case too, `/DECISION-LINK/<token>` among
 * them: a mail server's reply may quote a link in capitals (`maskMailText`,
 * card 2675's code review, S1). Not for the log at start, whose lines the
 * gate wrote as it routed them.
 */
export function maskSecretPaths(text: string, { anyCase = false }: { anyCase?: boolean } = {}): string {
	let masked = text;
	for (const { routeId, before } of SECRET_IN_PATH) {
		const secret = new RegExp(`${before.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[^/?#"'\\s]+`, anyCase ? 'gi' : 'g');
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
 * How every line began that an image before `35491fc` wrote when a webhook's
 * delivery failed, followed by the webhook's id, ` → ` and its whole address
 * (card 2928, N1): a Slack, Teams or Discord address holds its secret in its
 * path, and those lines sat in the system log, and in every backup's copy of
 * it.
 */
export const OLD_WEBHOOK_FAILURE = 'Webhook delivery failed for hook ';

/** What such a line's `meta` is replaced by, whole (R16): the error it held could quote the address too. */
export const MASKED_WEBHOOK_META = '{"error":"[masked]"}';

/**
 * Such a line with its address replaced by its host (`hostOf`: "an address
 * that is not a URL" for text that is none). Any other line as it is.
 */
export function maskOldWebhookAddress(message: string): string {
	const arrow = ' → ';
	const at = message.indexOf(arrow);
	if (!message.startsWith(OLD_WEBHOOK_FAILURE) || at < 0) return message;
	return message.slice(0, at + arrow.length) + hostOf(message.slice(at + arrow.length));
}

/**
 * Rewrite every old line of `database`'s system log that quoted a webhook's
 * whole address (card 2928, R16): its message to the host, its `meta` to
 * `{"error":"[masked]"}`. A line already masked (its `meta` so) is left, so a
 * second run changes nothing. Answers how many lines it changed. A database
 * with no system log changes nothing. Run by `maskSecretsInLog`, over every
 * backup's copy and the live log at every start, and first, alone, inside the
 * start's sealing transaction (startup-checks.ts), so that the scrub that
 * follows takes the old text out of the file.
 */
export function maskOldWebhookAddresses(database: Database.Database): number {
	if (!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_logs'").get()) return 0;
	database.function('mask_old_webhook_address', (text: unknown) => (typeof text === 'string' ? maskOldWebhookAddress(text) : text));
	return database
		.prepare(
			'UPDATE system_logs SET message = mask_old_webhook_address(message), meta = ? ' +
				'WHERE substr(message, 1, ?) = ? AND meta IS NOT ?'
		)
		.run(MASKED_WEBHOOK_META, OLD_WEBHOOK_FAILURE.length, OLD_WEBHOOK_FAILURE, MASKED_WEBHOOK_META).changes;
}

/**
 * Mask every secret in the `system_logs` of `database`, and return how many
 * changes that made: 0 when there was nothing to mask.
 *
 * Three things, in this order:
 *
 *   - Every line is masked as `maskSecretPaths` masks it: an invite's
 *     address, whatever its token, and a request link's `token=`.
 *   - Every old line that quoted a webhook's whole address is given its host
 *     alone, its `meta` replaced (`maskOldWebhookAddresses`, card 2928).
 *   - Every old failed sign-in line at a name that was no account loses the
 *     name, as `maskFailedSignIn` takes it out.
 *
 * An invite's token is kept only as its hash (card 2849), so there is no
 * token here to look for: an invite's address is masked by the first rule,
 * and a bare token in a line is not looked for. No code writes one anywhere
 * but in an address, and every token a line written before the card can hold
 * is dead after migration 0068, which ended every unused invite and replaced
 * the token of every used one.
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
	database.function('mask_secret_paths', (text: unknown) => (typeof text === 'string' ? maskSecretPaths(text) : text));
	const holds = SECRET_PATH_MARKERS.map(() => 'instr(message, ?) > 0 OR instr(meta, ?) > 0').join(' OR ');
	changes += database
		.prepare(
			'UPDATE system_logs SET message = mask_secret_paths(message), meta = mask_secret_paths(meta) ' +
				`WHERE (${holds}) AND (mask_secret_paths(message) IS NOT message OR mask_secret_paths(meta) IS NOT meta)`
		)
		.run(...SECRET_PATH_MARKERS.flatMap((marker) => [marker, marker])).changes;

	// Card 2928: the old lines that quoted a webhook's whole address.
	changes += maskOldWebhookAddresses(database);

	database.function('mask_failed_sign_in', (text: unknown) => (typeof text === 'string' ? maskFailedSignIn(text) : text));
	changes += database
		.prepare(
			'UPDATE system_logs SET message = mask_failed_sign_in(message) ' +
				'WHERE substr(message, 1, ?) = ? AND mask_failed_sign_in(message) IS NOT message'
		)
		.run(OLD_FAILED_SIGN_IN.length, OLD_FAILED_SIGN_IN).changes;
	return changes;
}
