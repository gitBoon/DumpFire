/**
 * backup-failure.ts — what a backup destination's failure is, and how it is said (card 3080).
 *
 * Every failure a destination gives (an upload, a Keep Last listing or delete, a Test, a Connect) is read here from
 * its structured fields: whether it passes (`failureOf`: a 408, 429 or 5xx, a dropped, refused or silent connection),
 * and one plain sentence for Backup History, the mail, the toast and the log (`plainFailure`), with any HTML page
 * dropped, every secret of the destination masked (`masked`) and the whole capped. The run's retry loop
 * (`runBackup`, backup.ts) asks `failureOf` whether to try again and `retryWaitMs` how long to wait. The ERROR line
 * carries the facts alone (`logFacts`), and the far end's raw words go only to a DEBUG line (`rawForLog`).
 *
 * Read from structured fields, then from the few library phrases named in its plan (section 4.2), never from any
 * other message text. Nothing here imports backup.ts or backup-destinations.ts: DumpFire's own error classes are
 * told by name.
 */

import { SECRET_FIELDS, SECRET_MASK } from './backup-secrets';
import { serviceAccountKey } from './service-account-json';
import { HOST_KEY_NOT_CONFIRMED } from './ssh-host-key';
import { CREDENTIALS_NOT_ENTERED, GDRIVE_NOT_CONNECTED, SERVICE_ACCOUNT_NOT_A_KEY } from './backup-secrets';
import { DRIVE_REFUSAL, FOLDER_PATH_REFUSAL, ONEDRIVE_DRIVE_NOT_SET } from './onedrive-address';

// ─── Constants ───────────────────────────────────────────────────────────────

/** How many times a destination is tried in one run: the first try and two more. */
export const UPLOAD_TRIES = 3;
/** The waits before the 2nd and the 3rd try. */
export const UPLOAD_RETRY_WAITS_MS = [30_000, 60_000] as const;
/** The longest Retry-After honoured; a longer one waits this long. */
export const RETRY_AFTER_CAP_MS = 120_000;
/** The most of the far end's reason a permanent failure's sentence carries. */
export const REASON_MAX = 200;
/** The most of the far end's message the DEBUG line carries. */
export const RAW_LOG_MAX = 2_000;
/** The most a sentence carries in all: as `cappedMessage` (backup-destinations.ts, card 2941's R10). */
const SENTENCE_MAX = 300;

// ─── DumpFire's own errors ───────────────────────────────────────────────────

/** A destination put on hold while it was being reached (card 2922, R-B): its words are the held words. */
export class HeldMeanwhile extends Error {
	constructor(words: string) {
		super(words);
		this.name = 'HeldMeanwhile';
	}
}

/** A destination removed or changed in the settings while its run waited to try it again (R-C). */
export class ChangedMeanwhile extends Error {
	constructor() {
		super(CHANGED_MEANWHILE_WORDS);
		this.name = 'ChangedMeanwhile';
	}
}

/** What a destination removed or changed while its run waited is not tried again for. */
export const CHANGED_MEANWHILE_WORDS = 'the destination was removed or changed meanwhile';

/** The names of DumpFire's own error classes (R-H): their words are kept. */
const OWN_NAMES = new Set([
	'HostKeyNotConfirmed',
	'HostKeyMismatch',
	'HostKeyTypeNotOffered',
	'HostKeySignatureFailed',
	'NoAnswer',
	'HeldMeanwhile',
	'ChangedMeanwhile',
	'DriveStoredOtherwise',
	'DriveSessionElsewhere'
]);

/**
 * DumpFire's own errors that pass (card 3080's fix pass, A): a Google Drive session that took a chunk and held no
 * more of the copy. Its words are kept, and the try is resumed or tried again.
 */
const OWN_PASSING = new Set(['DriveStalled']);

/** DumpFire's own sentences (R-H): a message that equals or starts with one is DumpFire's, and its words are kept. */
const OWN_SENTENCES = (): string[] => [
	HOST_KEY_NOT_CONFIRMED,
	CREDENTIALS_NOT_ENTERED,
	GDRIVE_NOT_CONNECTED,
	SERVICE_ACCOUNT_NOT_A_KEY,
	'Google Drive OAuth not configured',
	DRIVE_REFUSAL,
	FOLDER_PATH_REFUSAL,
	ONEDRIVE_DRIVE_NOT_SET
];

/**
 * DumpFire's own sentences that hold a number or sit in backup-destinations.ts (which imports this file): the
 * three listing page limits, `S3_NOT_LISTED` and `GDRIVE_NOT_LISTED`.
 */
const OWN_PATTERNS = [
	/^(?:S3|Google Drive|OneDrive) listing of the backup (?:prefix|folder) went on for more than \d+ pages/,
	/^(?:S3|Google Drive) removes only a backup it has just listed for retention/
];

// ─── Reading an error ────────────────────────────────────────────────────────

/** What a destination's failure is (section 4.2). */
export interface Failure {
	/** Whether it passes, so that the destination is tried again. */
	temporary: boolean;
	/** The HTTP status the far end answered, where it answered one. */
	status?: number;
	/** The network or library code (`ECONNRESET`, `TimeoutError`, `ERR_GENERIC_CLIENT`). */
	code?: string;
	/** The far end's short code (`rateLimitExceeded`, `SlowDown`, `itemNotFound`, `invalid_grant`). */
	reason?: string;
	/** The far end's request id (S3, OneDrive). */
	requestId?: string;
	/** A Retry-After of a whole number of seconds from 1, as milliseconds, capped at `RETRY_AFTER_CAP_MS`. */
	retryAfterMs?: number;
	/** DumpFire's own error (R-H): its words are kept. */
	own: boolean;
	/** The network group, where it is one (rule 5). */
	group?: NetworkGroup;
	/** A refused sign-in (rule 2). */
	signIn?: 'drive-grant' | 'sftp-auth' | 'other';
}

type NetworkGroup = 'refused' | 'unreachable' | 'dropped' | 'silent' | 'lookup';

/** A destination, or several (a Test or a Connect masks with what was stored and what was sent), or a secret alone. */
export type MaskSource = object | string | null | undefined | ReadonlyArray<object | string | null | undefined>;

const TEMPORARY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const DRIVE_RATE_LIMITS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

const NETWORK_CODES: Record<string, { group: NetworkGroup; temporary: boolean }> = {
	ECONNREFUSED: { group: 'refused', temporary: true },
	ENETUNREACH: { group: 'unreachable', temporary: true },
	EHOSTUNREACH: { group: 'unreachable', temporary: true },
	ECONNRESET: { group: 'dropped', temporary: true },
	EPIPE: { group: 'dropped', temporary: true },
	ECONNABORTED: { group: 'dropped', temporary: true },
	ERR_STREAM_PREMATURE_CLOSE: { group: 'dropped', temporary: true },
	UND_ERR_SOCKET: { group: 'dropped', temporary: true },
	ERR_NOT_CONNECTED: { group: 'dropped', temporary: true },
	ETIMEDOUT: { group: 'silent', temporary: true },
	TimeoutError: { group: 'silent', temporary: true },
	UND_ERR_CONNECT_TIMEOUT: { group: 'silent', temporary: true },
	UND_ERR_HEADERS_TIMEOUT: { group: 'silent', temporary: true },
	UND_ERR_BODY_TIMEOUT: { group: 'silent', temporary: true },
	EAI_AGAIN: { group: 'lookup', temporary: true },
	ENOTFOUND: { group: 'lookup', temporary: false }
};

/** S3 error names that say nothing of their own. */
const S3_PLAIN_NAMES = new Set(['Error', 'Unknown', 'UnknownError', 'S3ServiceException', 'ServiceException']);

const isObject = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null;
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const httpStatus = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;

/** `err`'s message, or what was thrown, as text. */
function messageOf(err: unknown): string {
	if (err instanceof Error) return err.message ?? '';
	if (isObject(err) && typeof err.message === 'string') return err.message;
	return typeof err === 'string' ? err : '';
}

/** A header of `headers` (a fetch `Headers`, or a plain record), any case. */
function headerOf(headers: unknown, name: string): string | undefined {
	if (!isObject(headers)) return undefined;
	if (typeof headers.get === 'function') {
		try {
			const value = headers.get(name);
			if (typeof value === 'string') return value;
		} catch {
			// Not a Headers.
		}
	}
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name.toLowerCase()) return Array.isArray(value) ? String(value[0]) : typeof value === 'string' ? value : undefined;
	}
	return undefined;
}

/** A Retry-After header's wait (R-J): a whole number of seconds from 1, capped; a date, 0, negative or not a number is none. */
function retryAfterOf(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const seconds = Number(trimmed);
	if (!Number.isFinite(seconds) || seconds < 1) return undefined;
	return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
}

/** Every string code on `err` and its causes, up to three levels down, nearest first. */
function codesOf(err: unknown): string[] {
	const codes: string[] = [];
	let at: unknown = err;
	for (let depth = 0; depth <= 3 && isObject(at); depth++) {
		if (typeof at.code === 'string') codes.push(at.code);
		if (at.name === 'TimeoutError') codes.push('TimeoutError');
		at = at.cause;
	}
	return codes;
}

/** The type of destination `source` names first, or ''. */
function typeOf(source: MaskSource): string {
	const first: unknown = Array.isArray(source) ? source.find(isObject) : source;
	return isObject(first) && typeof first.type === 'string' ? first.type : '';
}

/** What a destination's failure is (section 4.2): passing or not, and the facts it carries. */
export function failureOf(config: MaskSource, err: unknown): Failure {
	const type = typeOf(config);
	const message = messageOf(err);
	const e: Record<string, any> = isObject(err) ? err : {};

	if (typeof e.name === 'string' && OWN_PASSING.has(e.name)) return { temporary: true, own: true };
	if ((typeof e.name === 'string' && OWN_NAMES.has(e.name)) || isOwnSentence(message)) return { temporary: false, own: true };

	// The status, from each library's field.
	const status =
		httpStatus(e.status) ??
		httpStatus(e.response?.status) ??
		httpStatus(e.$metadata?.httpStatusCode) ??
		httpStatus(e.statusCode) ??
		httpStatus(e.code);
	const codes = codesOf(err);
	const code = codes.find((c) => c in NETWORK_CODES) ?? codes[0];

	// The far end's short code.
	let reason: string | undefined;
	const driveReason = text(e.cause?.errors?.[0]?.reason) ?? text(e.response?.data?.error?.errors?.[0]?.reason);
	const oauthError = text(e.response?.data?.error);
	if (type === 'gdrive' || driveReason !== undefined || oauthError !== undefined) reason = driveReason ?? oauthError;
	if (reason === undefined && type === 's3' && status !== undefined) {
		const name = text(e.Code) ?? text(e.name);
		if (name !== undefined && !S3_PLAIN_NAMES.has(name)) reason = name;
	}
	if (reason === undefined && type === 'onedrive' && status !== undefined && typeof e.code === 'string') reason = e.code;

	const requestId = text(e.$metadata?.requestId) ?? text(e.requestId);
	const retryAfterMs = retryAfterOf(headerOf(e.response?.headers, 'retry-after') ?? headerOf(e.$response?.headers, 'retry-after') ?? headerOf(e.headers, 'retry-after'));
	const facts = { status, code, reason, requestId, retryAfterMs, own: false };

	// Sign-in (rule 2): never passing.
	if (oauthError === 'invalid_grant') return { ...facts, temporary: false, signIn: 'drive-grant' };
	if (/All configured authentication methods failed/.test(message) || codes.includes('ERR_BAD_AUTH')) return { ...facts, temporary: false, signIn: 'sftp-auth' };
	// Azure AD's sign-in that answered 429 or 5xx passes (the fix pass, I): Microsoft's sign-in was busy or down, not
	// refusing. Any other refused sign-in does not.
	if (e.name === 'AuthenticationError' && status !== undefined && (status === 429 || (status >= 500 && status <= 599))) {
		return { ...facts, temporary: true };
	}
	if (status === 401 || e.name === 'AuthenticationError') return { ...facts, temporary: false, signIn: 'other' };

	if (status !== undefined) {
		if (TEMPORARY_STATUSES.has(status)) return { ...facts, temporary: true };
		if (status === 403 && reason !== undefined && DRIVE_RATE_LIMITS.has(reason)) return { ...facts, temporary: true };
		if (status === 400 && reason === 'RequestTimeout') return { ...facts, temporary: true };
		return { ...facts, temporary: false };
	}

	// OneDrive's fetch that failed before any answer.
	if (e.statusCode === -1 && e.code === 'TypeError') return { ...facts, temporary: true, group: 'unreachable' };
	const network = codes.map((c) => NETWORK_CODES[c]).find((n) => n !== undefined);
	if (network !== undefined) return { ...facts, temporary: network.temporary, group: network.group };
	// The SFTP library's phrases, named in the plan.
	if (/Unexpected (?:end|close) event/.test(message) && codes.includes('ERR_GENERIC_CLIENT')) return { ...facts, temporary: true, group: 'dropped' };
	if (/No response from server/.test(message) && codes.includes('ERR_GENERIC_CLIENT')) return { ...facts, temporary: true, group: 'silent' };
	if (/Timed out while waiting for handshake/.test(message)) return { ...facts, temporary: true, group: 'silent' };
	return { ...facts, temporary: false };
}

/** Whether `message` is one of DumpFire's own sentences, or starts with one. */
function isOwnSentence(message: string): boolean {
	if (message === '') return false;
	return OWN_SENTENCES().some((sentence) => message.startsWith(sentence)) || OWN_PATTERNS.some((pattern) => pattern.test(message));
}

// ─── Secrets ─────────────────────────────────────────────────────────────────

/** The shortest stored secret masked by its value (R-I): a shorter one would mask ordinary words. */
const SHORTEST_MASKED = 8;

/** Every secret value `source` holds: its type's secret fields, and a service account's private key. */
function secretsOf(source: MaskSource): string[] {
	const values: string[] = [];
	for (const item of Array.isArray(source) ? source : [source]) {
		if (typeof item === 'string') {
			values.push(item);
			continue;
		}
		if (!isObject(item)) continue;
		const type = typeof item.type === 'string' ? item.type : '';
		const fields = SECRET_FIELDS[type] ?? [...new Set(Object.values(SECRET_FIELDS).flat())];
		for (const field of fields) if (typeof item[field] === 'string') values.push(item[field]);
		if (typeof item.serviceAccountJson === 'string' && item.serviceAccountJson !== '') {
			const key = serviceAccountKey(item.serviceAccountJson);
			if (key !== null) values.push(key.key);
		}
	}
	return values.filter((value) => value.length >= SHORTEST_MASKED && value !== SECRET_MASK);
}

/** The patterns masked whatever the destination (R-I). */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, SECRET_MASK],
	[/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${SECRET_MASK}`],
	[/\bya29\.[A-Za-z0-9\-_.]+/g, SECRET_MASK],
	[/\b1\/\/[A-Za-z0-9\-_.]+/g, SECRET_MASK],
	[/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, SECRET_MASK],
	[/\bupload_id=[^&\s"'<>]+/gi, `upload_id=${SECRET_MASK}`],
	[/\bX-Amz-Signature=[^&\s"'<>]+/gi, `X-Amz-Signature=${SECRET_MASK}`],
	[/\bX-Amz-Credential=[^&\s"'<>]+/gi, `X-Amz-Credential=${SECRET_MASK}`],
	// The fix pass, H: an OAuth access token, an STS session token, a SAS signature and Graph's tempauth.
	[/\b(access_token|X-Amz-Security-Token|Signature|sig|tempauth)=[^&\s"'<>]+/gi, `$1=${SECRET_MASK}`],
	[/(\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${SECRET_MASK}@`]
];

/**
 * `text` with every secret masked (R-I): each stored secret of the destination of 8 characters or more as it is, as
 * `encodeURIComponent` gives it and as `JSON.stringify` escapes it, then the patterns (a bearer token, Google's
 * `ya29.` and `1//` tokens, a JWT, a session's `upload_id`, S3's signature and credential, a PEM block, a password in
 * a URL). An SFTP password under 8 characters is not masked by its value (stated in the plan).
 */
export function masked(text: string, config: MaskSource): string {
	let said = String(text ?? '');
	const forms = new Set<string>();
	for (const secret of secretsOf(config)) {
		forms.add(secret);
		forms.add(encodeURIComponent(secret));
		forms.add(JSON.stringify(secret).slice(1, -1));
	}
	for (const form of [...forms].filter((f) => f.length >= SHORTEST_MASKED).sort((a, b) => b.length - a.length)) {
		said = said.split(form).join(SECRET_MASK);
	}
	for (const [pattern, replacement] of SECRET_PATTERNS) said = said.replace(pattern, replacement);
	return said;
}

// ─── Cleaning ────────────────────────────────────────────────────────────────

/** HTML anywhere in a text, in any case (R-I): the whole text is then dropped. */
const HTML = /<!doctype|<html|<head|<body|<title|<\/[a-z][a-z0-9-]*\s*>/i;

/** A JSON body's reason (R-I): its `message`, `error_description` or `error`. */
function jsonReason(said: string): string | null {
	const trimmed = said.trim();
	if (!trimmed.startsWith('{')) return null;
	try {
		const body = JSON.parse(trimmed);
		if (!isObject(body)) return null;
		const error = isObject(body.error) ? body.error : null;
		return text(body.message) ?? text(error?.message) ?? text(body.error_description) ?? text(body.error) ?? null;
	} catch {
		return null;
	}
}

/** `said` as a sentence carries it: HTML dropped whole, a JSON body's reason read, tags removed, masked, white space run together. */
function cleaned(said: string, config: MaskSource): string {
	if (HTML.test(said)) return '';
	const reason = jsonReason(said) ?? said;
	if (HTML.test(reason)) return '';
	// Masked before the tags are removed and again after (the fix pass, F): a secret holding `<…>` is masked whole.
	return masked(masked(reason, config).replace(/<[^>]*>/g, ' '), config).replace(/\s+/g, ' ').trim();
}

/** `said` without a trailing full stop. */
const withoutStop = (said: string) => said.replace(/\.+$/, '');

/** `said` cut to `max` characters with `…`. */
const cut = (said: string, max: number) => (said.length > max ? `${said.slice(0, max - 1)}…` : said);

/** `said` with a full stop, unless it already ends a sentence (`.`, `!`, `?` or `…`). What callers add. */
export const withStop = (said: string): string => (said === '' || /[.!?…]$/.test(said) ? said : `${said}.`);

/** `said` with its first letter in capitals. */
export const capitalised = (said: string) => (said === '' ? said : said[0].toUpperCase() + said.slice(1));

// ─── The sentence ────────────────────────────────────────────────────────────

/** What failed: an upload, Keep Last's listing or delete, a Test or a Connect. */
export type FailureWhat = 'upload' | 'listing' | 'delete' | 'test' | 'connect';

const TYPE_NAMES: Record<string, string> = { sftp: 'SFTP', s3: 'S3', gdrive: 'Google Drive', onedrive: 'OneDrive' };
const WHAT_WORDS: Record<FailureWhat, string> = { upload: 'upload', listing: 'listing', delete: 'delete', test: 'request', connect: 'request' };

/** The type's name: SFTP, S3, Google Drive, OneDrive. */
function typeName(config: MaskSource): string {
	return TYPE_NAMES[typeOf(config)] ?? 'The destination';
}

/** Where the destination is: the SFTP server at its host and port, Amazon S3 or the S3 service at its endpoint's host, Google Drive, OneDrive. */
function providerOf(config: MaskSource): string {
	const first = (Array.isArray(config) ? config.find(isObject) : config) as Record<string, any> | undefined;
	const type = typeOf(config);
	if (type === 'sftp' && isObject(first)) return `the SFTP server at ${first.host}:${first.port || 22}`;
	if (type === 's3' && isObject(first)) {
		const endpoint = text(first.endpoint);
		if (endpoint === undefined) return 'Amazon S3';
		let host = endpoint;
		try {
			host = new URL(endpoint).host || endpoint;
		} catch {
			// Not a URL: as it is.
		}
		return `the S3 service at ${masked(host, config)}`;
	}
	return TYPE_NAMES[type] ?? 'the destination';
}

/** The network group's words (rule 5). */
function groupWords(group: NetworkGroup, provider: string, what: FailureWhat): string {
	switch (group) {
		case 'refused':
			return `${provider} refused the connection`;
		case 'unreachable':
			return `${provider} could not be reached`;
		case 'dropped':
			return `the connection to ${provider} dropped during the ${WHAT_WORDS[what]}`;
		case 'silent':
			return `${provider} stopped answering`;
		case 'lookup':
			return `the server's name for ${provider} could not be looked up`;
	}
}

/** The far end's reason for a permanent failure (rule 4): not HTML, its full stop dropped, at most `REASON_MAX`. */
function reasonText(config: MaskSource, err: unknown): string {
	const said = withoutStop(cleaned(messageOf(err), config));
	return cut(said, REASON_MAX);
}

/**
 * The failure without its tail: rules 1 to 6, before "; tried N times", lower-case where it begins with a provider
 * (`the connection to Google Drive dropped…`), and with no ", a temporary …" ending. What a ⚠️ note names (R-E).
 */
export function briefFailure(config: MaskSource, err: unknown, what: FailureWhat = 'upload'): string {
	return sentenceOf(config, err, what, false);
}

function sentenceOf(config: MaskSource, err: unknown, what: FailureWhat, full: boolean): string {
	const failure = failureOf(config, err);
	const type = typeName(config);
	const provider = providerOf(config);
	if (failure.own) return withoutStop(cleaned(messageOf(err), config)) || `${type} failed without a readable reason`;
	if (failure.signIn === 'drive-grant') {
		return 'Google Drive refused the sign-in: the connection has expired or was withdrawn; press Connect on the destination again';
	}
	if (failure.signIn === 'sftp-auth') return `${provider} refused the sign-in: check the username and the password or private key`;
	if (failure.signIn === 'other') {
		const reason = reasonText(config, err);
		return `${type} refused the sign-in${failure.status !== undefined ? ` (${failure.status})` : ''}${reason ? `: ${reason}` : ''}`;
	}
	if (failure.status !== undefined && failure.temporary) {
		const short = full && failure.reason !== undefined ? ` (${cut(masked(failure.reason, config), 60)})` : '';
		return `${type} answered ${failure.status}${short}${full ? `, a temporary error at ${provider}` : ''}`;
	}
	if (failure.status !== undefined) {
		const reason = reasonText(config, err);
		return `${type} refused the ${WHAT_WORDS[what]} with ${failure.status}${reason ? `: ${reason}` : ''}`;
	}
	if (failure.group !== undefined) {
		return `${groupWords(failure.group, provider, what)}${full && failure.temporary ? ', a temporary network error' : ''}`;
	}
	return withoutStop(cleaned(messageOf(err), config)) || `${type} failed without a readable reason`;
}

/**
 * The one sentence a failure is said in (R-E, section 4.6), with no full stop: callers add it (`withStop`). Rules, the
 * first that fits: DumpFire's own words; a refused sign-in; a passing status; a status that does not pass, with the
 * far end's reason; a network fault by its group; anything else, cleaned. Then "; tried N times" where it was tried
 * more than once, and ", resuming R times in all" where a Google Drive session resumed; the whole capped at 300.
 */
export function plainFailure(config: MaskSource, err: unknown, opts: { tries?: number; resumes?: number; what?: FailureWhat } = {}): string {
	// Capitals where DumpFire's sentence (rules 2 to 5) begins with a lower-case word (`the connection to…`, `the SFTP
	// server at…`); DumpFire's own words (rule 1) and the far end's (rule 6) are left as they are.
	const failure = failureOf(config, err);
	const sentence = sentenceOf(config, err, opts.what ?? 'upload', true);
	const composed = !failure.own && (failure.signIn !== undefined || failure.status !== undefined || failure.group !== undefined);
	let said = composed ? capitalised(sentence) : sentence;
	if ((opts.tries ?? 1) > 1) said += `; tried ${opts.tries} times`;
	if ((opts.resumes ?? 0) > 0) said += `${(opts.tries ?? 1) > 1 ? ',' : ';'} resuming ${timesWord(opts.resumes!)} in all`;
	// DumpFire's own words are kept whole (R-H, W3): a host key's refusal says what to do in more than 300 characters.
	return failure.own ? said : cut(said, SENTENCE_MAX);
}

/** `n` times in words: once, twice, then `n times`. */
export const timesWord = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** `n` as an ordinal: 1st, 2nd, 3rd, 4th. */
export const ordinal = (n: number) => {
	const tens = n % 100;
	if (tens >= 11 && tens <= 13) return `${n}th`;
	return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

// ─── Logs ────────────────────────────────────────────────────────────────────

/** The ERROR line's meta (R-G): the facts alone, never the error, its config, headers or stack. */
export function logFacts(config: MaskSource, err: unknown, tries?: number) {
	const failure = failureOf(config, err);
	const fact = (value: string | undefined) => (value === undefined ? null : cut(cleaned(value, config), REASON_MAX) || null);
	return {
		status: failure.status ?? null,
		code: fact(failure.code),
		reason: fact(failure.reason),
		requestId: fact(failure.requestId),
		tries: tries ?? 1
	};
}

/** The DEBUG line's meta (R-I): the message, status, code, name and request id only, masked, the message capped at 2,000. */
export function rawForLog(config: MaskSource, err: unknown) {
	const failure = failureOf(config, err);
	const e: Record<string, any> = isObject(err) ? err : {};
	const one = (value: unknown) => (typeof value === 'string' ? cut(masked(value, config), REASON_MAX) : null);
	return {
		message: cut(masked(messageOf(err), config), RAW_LOG_MAX),
		status: failure.status ?? null,
		code: one(failure.code),
		name: one(e.name),
		requestId: one(failure.requestId)
	};
}

// ─── Waits ───────────────────────────────────────────────────────────────────

/** How long to wait after try `tryNumber` (from 1) before the next (R-J): 30 s, then 60 s, or a Retry-After of 1 s to 120 s. */
export function retryWaitMs(tryNumber: number, failure: Pick<Failure, 'retryAfterMs'>): number {
	if (failure.retryAfterMs !== undefined && failure.retryAfterMs >= 1000) return Math.min(failure.retryAfterMs, RETRY_AFTER_CAP_MS);
	return UPLOAD_RETRY_WAITS_MS[Math.min(Math.max(tryNumber, 1), UPLOAD_RETRY_WAITS_MS.length) - 1];
}
