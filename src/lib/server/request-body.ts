/**
 * request-body.ts — one way for a handler to read its request body, its path
 * ids and its query parameters, and to refuse what it cannot use.
 *
 * Each handler used to read `await request.json()` and use the fields as they
 * came. A field of the wrong type then went one of three ways: it was stored
 * (`"top"` as a position, `"false"` as true), it was a 500 (`.trim` called on
 * a number), or it named something that did not exist. The twins in the two
 * API trees each checked what they checked in their own words, and drifted.
 *
 *     readBody(request)              the body, a JSON object, its fields unknown
 *     readText(body, 'title', rule)  one field, checked, as it is to be written
 *     readColour(body, 'color', rule)  a colour, `#rrggbb` and nothing else
 *     readCover(body, 'coverUrl', rule)  a card's cover: a colour or a preset gradient
 *     pathId(params.id, 'card')      an id in the path, or 400 Invalid card ID
 *     readLimit(url.searchParams.get('limit'), { max, fallback })
 *
 * `readBody` hands back `Record<string, unknown>`, so the type check refuses a
 * field used as text, a number or anything else before a reader has looked at
 * it. It does not refuse a field passed on as it is to something that takes
 * `unknown`, which is how `updateData[key] = body[key]` copies fields
 * unchecked, nor a field turned into another type by `Number()` and the like.
 * tests/request-body.test.ts looks for the shapes of those that it names (see
 * the end of this comment); what it does not name is the review's to see.
 *
 * Every reader takes `(body, name, rule)` and gives back the value exactly as
 * it is to be written, or `undefined` when the field was not sent and is not
 * required. Each refuses with `error(400, ...)` and a text that names the
 * field. The type is looked at before anything else, so `["x".repeat(600)]`
 * is not one element long enough to pass a length check.
 *
 * What every reader's `rule` may say:
 *
 *     required  not sent is `<name> is required`
 *     nullable  `null` is read as null: the column can be empty. Anywhere
 *               else `null` is the wrong type
 *     keep      the value the row holds now. A value sent that is the same
 *               (`===`, so the same JSON type and value; a list by its JSON) is
 *               handed back as it is, unchecked. That is how a card whose
 *               stored priority no rule allows can still be saved by a page
 *               that sends it back
 *     says      texts in place of the reader's own: one text for every
 *               refusal, or one for each of `missing`, `type`, `empty` and
 *               `invalid`. It is how the texts tests and documents quote are
 *               kept
 *
 * A number written as text that is exactly a number (`"5"`, `"-2.5"`) is read
 * as that number wherever a number is read. Nothing else is turned into
 * anything: text is never a boolean and a number is never text.
 *
 * The query readers take the value and not the name of the parameter
 * (`readLimit(url.searchParams.get('limit'), ...)`), so that the name stays
 * written in the handler, where tests/openapi-document.test.ts reads it.
 *
 * tests/request-body.test.ts holds every reader to its rule. It also reads
 * every `+server.ts` under src/routes and every module under src/lib/server,
 * and fails:
 *
 *   - on a body read from the request (`json()`, `text()`, `arrayBuffer()`,
 *     `blob()`, `bytes()`, `formData()` or its `.body`) anywhere but here and
 *     in api-errors.ts, unless its file is on the test's `STILL_READING` (a
 *     JSON read not yet moved onto `readBody`) or the read is on `NOT_JSON`
 *     (a body that is not JSON: the import, the upload, the gate's count);
 *   - on a cast of what `readBody` or `readObjects` hands back, or of a field
 *     of it, or a type written on the name a body is kept in;
 *   - on a body, or an entry of `readObjects`, kept in a name and then read by
 *     a key that is not written out, spread, handed to `Object.assign`,
 *     `Object.keys`, `Object.entries` or `Object.values`, walked with
 *     `for…in`, or with a field turned by `Number()`, `String()`, `Boolean()`
 *     or `!!`.
 *
 * It finds a body by the names it is kept in, in the function it is kept in,
 * so a body handed whole to another function and used there is not followed.
 */
import { error } from '@sveltejs/kit';
import { isCoverValue, isHexColour } from '$lib/colours';
import { reportRecipients } from '$lib/report-recipients';
import { parseStamp, toStamp, type Edge, type Stamp } from '$lib/timestamps';

/** A request body: a JSON object, none of whose fields has been looked at. */
export type RequestBody = Record<string, unknown>;

/** The refusals a text in `says` can take the place of. */
export type Refusal = 'missing' | 'type' | 'empty' | 'invalid';

/**
 * Texts in place of a reader's own: one text for every refusal, or one for
 * each refusal named.
 *
 *     missing  required, and not sent
 *     type     the wrong JSON type, `null` where it is not allowed among them
 *     empty    text that is empty, after trimming, where some is needed; a
 *              list with nothing in it where something is needed
 *     invalid  the right type, and not what the field may hold: too long,
 *              out of range, not one of the choices, not a real date, an
 *              entry of a list that is not what the list holds
 */
export type Says = string | Partial<Record<Refusal, string>>;

/** What every reader's rule may say. */
export type Rule = {
	required?: boolean;
	nullable?: boolean;
	/** What the row holds now, on an update. */
	keep?: unknown;
	says?: Says;
};

/**
 * What a reader hands back under `rule`: never `undefined` for a field that is
 * required, and `null` only for one that is nullable.
 *
 * A kept value is handed back as the row holds it, and is typed as what the
 * reader reads. It may not be: a priority no rule allows, a position stored
 * as text. Written back, it changes nothing.
 */
export type Read<T, R extends Rule> =
	| T
	| (R extends { required: true } ? never : undefined)
	| (R extends { nullable: true } ? null : never);

/** A number written as text, exactly: `5`, `-2.5`. Not `1e3`, `0x10`, `Infinity` or empty text. */
const NUMBER_AS_TEXT = /^-?\d+(\.\d+)?$/;
/** A whole number written as text: digits, and nothing after a point but zeros (`7`, `1.0`). */
const WHOLE_AS_TEXT = /^-?\d+(\.0+)?$/;
/** An id in a path or a query string: digits and nothing else. */
const ID_AS_TEXT = /^\d+$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
/**
 * Something, an @, and something, with no space anywhere, and none of
 * `, ; < > " ( )`: the mailer reads `victim,attacker@evil.test` as two
 * addresses, and the others mark a name, a group or a comment round one.
 */
const EMAIL_ADDRESS = /^[^\s@,;<>"()]+@[^\s@,;<>"()]+$/;

// ─── The body ────────────────────────────────────────────────────────────────

/** Is `value` a JSON object: not null, and not an array? */
function isObject(value: unknown): value is RequestBody {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `value` as a body when it is a JSON object, or undefined: an entry of a list
 * that may hold objects among other things (a dependency batch's `chain`),
 * whose fields are then read with the readers, as a body's are. A spread of
 * the entry (`{ ...v }`) made one the rule test could not see; what this hands
 * back, it follows as it follows `readBody`'s.
 */
export function asObject(value: unknown): RequestBody | undefined {
	return isObject(value) ? value : undefined;
}

/**
 * The request's body, which is a JSON object, or a 400.
 *
 * The gate's guard (`guardBody` in api-errors.ts) has already answered a body
 * that is missing, is not JSON or is not an object, and a body over the size
 * limit. It is asked again here so that what is handed back is what it is
 * typed as, on a request the gate never saw as well.
 *
 * The parameter is called `request` on purpose: tests/openapi-document.test.ts
 * knows a handler reads a body by the `request.json()` in what it calls.
 */
export async function readBody(request: Request): Promise<RequestBody> {
	const body: unknown = await request.json();
	if (!isObject(body)) error(400, 'The request body must be a JSON object');
	return body;
}

// ─── What every field reader does first ──────────────────────────────────────

/** Refuse, in the text `rule.says` gives for `refusal`, or in the reader's own. */
function refuse(rule: Rule, refusal: Refusal, own: string): never {
	const says = rule.says;
	error(400, typeof says === 'string' ? says : (says?.[refusal] ?? own));
}

/** The same value, as decision 8 means it: the same JSON type and value, a list by its JSON. */
function same(sent: unknown, stored: unknown): boolean {
	if (sent === stored) return true;
	return Array.isArray(sent) && Array.isArray(stored) && JSON.stringify(sent) === JSON.stringify(stored);
}

/**
 * The field `name` of `body`, through what every reader does first: not sent,
 * kept, and null. What is left, which is neither undefined nor null, is given
 * to `check`. `wrong` is the reader's text for a value of the wrong type.
 *
 * Only the body's own fields are read: `constructor` is not a field of `{}`.
 */
function field<T>(body: RequestBody, name: string, rule: Rule, wrong: string, check: (sent: {}) => T): T | null | undefined {
	const sent = Object.hasOwn(body, name) ? body[name] : undefined;
	if (sent === undefined) {
		if (rule.required) refuse(rule, 'missing', `${name} is required`);
		return undefined;
	}
	if (rule.keep !== undefined && same(sent, rule.keep)) return sent as T;
	if (sent === null) {
		if (rule.nullable) return null;
		refuse(rule, 'type', wrong);
	}
	return check(sent);
}

// ─── Values, wherever they are found ─────────────────────────────────────────

/**
 * A finite number, or a number written as text, as a number. Anything else is
 * undefined: so is text of 400 digits, which `Number()` reads as Infinity.
 */
function numberOf(value: unknown): number | undefined {
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
	if (typeof value !== 'string') return undefined;
	const text = value.trim();
	if (!NUMBER_AS_TEXT.test(text)) return undefined;
	const number = Number(text);
	return Number.isFinite(number) ? number : undefined;
}

/**
 * A whole number of 1 or more, as a number or written as text. Anything else
 * is undefined. Text is whole only if it is written whole: `"1.0"` is 1, and
 * `"1.0000000000000001"`, which `Number()` also reads as 1, is no id.
 */
function idOf(value: unknown): number | undefined {
	if (typeof value === 'string' && !WHOLE_AS_TEXT.test(value.trim())) return undefined;
	const id = numberOf(value);
	return id !== undefined && Number.isSafeInteger(id) && id >= 1 ? id : undefined;
}

/** `YYYY-MM-DD`, and a day the calendar has: not 2026-02-30. */
function isCalendarDate(text: string): boolean {
	const parts = CALENDAR_DATE.exec(text);
	if (!parts) return false;
	const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The choice `value` is, in its spelling in `from`, or undefined. */
function choiceOf<C extends string>(value: unknown, from: readonly C[], anyCase: boolean, trim: boolean): C | undefined {
	if (typeof value !== 'string') return undefined;
	const text = trim ? value.trim() : value;
	return anyCase ? from.find((choice) => choice.toLowerCase() === text.toLowerCase()) : from.find((choice) => choice === text);
}

/** The refusal for a number outside `min` and `max`, in its own words. */
function outOfRange(name: string, rule: Rule & { min?: number; max?: number }, value: number): void {
	const { min, max } = rule;
	if ((min === undefined || value >= min) && (max === undefined || value <= max)) return;
	if (min !== undefined && max !== undefined) refuse(rule, 'invalid', `${name} must be from ${min} to ${max}`);
	if (min !== undefined) refuse(rule, 'invalid', `${name} must be at least ${min}`);
	refuse(rule, 'invalid', `${name} must be at most ${max}`);
}

// ─── Field readers ───────────────────────────────────────────────────────────

/** The rule of a text field. */
export type TextRule = Rule & {
	/** Spaces at either end are taken off before the length is counted, and are not written. */
	trim?: boolean;
	/** The fewest characters. 1 refuses empty text, as `empty`. */
	min?: number;
	/** The most characters. */
	max?: number;
};

/**
 * A text field.
 *
 *     type     not text: `<name> must be text`
 *     empty    empty, after trimming, where `min` is 1 or more: `<name> cannot be empty`
 *     invalid  `<name> must be at least <min> characters`, `<name> must be at most <max> characters`
 */
export function readText<R extends TextRule>(body: RequestBody, name: string, rule: R): Read<string, R> {
	return field(body, name, rule, `${name} must be text`, (sent) => {
		if (typeof sent !== 'string') refuse(rule, 'type', `${name} must be text`);
		const text = rule.trim ? sent.trim() : sent;
		if (rule.min !== undefined && text.length < rule.min) {
			if (text.length === 0) refuse(rule, 'empty', `${name} cannot be empty`);
			refuse(rule, 'invalid', `${name} must be at least ${rule.min} characters`);
		}
		if (rule.max !== undefined && text.length > rule.max) {
			refuse(rule, 'invalid', `${name} must be at most ${rule.max} characters`);
		}
		return text;
	}) as Read<string, R>;
}

/** The rule of a number field. */
export type NumberRule = Rule & {
	/** A whole number: 2.5 is refused, and so is one too large to be held exactly. */
	whole?: boolean;
	min?: number;
	max?: number;
};

/**
 * A number field: a finite number, or a number written as text, as a number.
 *
 *     type     no number, nor one written as text: `<name> must be a number`,
 *              or `<name> must be a whole number`
 *     invalid  a fraction where `whole` is asked for, in the same words; and
 *              `<name> must be from <min> to <max>`, `<name> must be at least <min>`,
 *              `<name> must be at most <max>`
 */
export function readNumber<R extends NumberRule>(body: RequestBody, name: string, rule: R): Read<number, R> {
	const wrong = rule.whole ? `${name} must be a whole number` : `${name} must be a number`;
	return field(body, name, rule, wrong, (sent) => {
		const value = numberOf(sent);
		if (value === undefined) refuse(rule, 'type', wrong);
		// Text is whole only if it is written whole, as for an id: `"1.0"` is 1,
		// and `"1.0000000000000001"`, which Number() also reads as 1, is not.
		const writtenWhole = typeof sent !== 'string' || WHOLE_AS_TEXT.test(sent.trim());
		if (rule.whole && (!Number.isSafeInteger(value) || !writtenWhole)) refuse(rule, 'invalid', wrong);
		outOfRange(name, rule, value);
		return value;
	}) as Read<number, R>;
}

/**
 * An id in the body: a whole number of 1 or more, or one written as text
 * that is whole as it is written (`"7"`, `" 7"`, `"007"`, `"1.0"`; not
 * `"1.0000000000000001"`). That the row it names exists is the handler's to
 * ask, inside the transaction that writes (decision 9), and not this reader's.
 *
 *     type     no number, nor one written as text: `<name> must be an id`
 *     invalid  a number that is no id, 0 and 1.5 among them, in the same words
 */
export function readId<R extends Rule>(body: RequestBody, name: string, rule: R): Read<number, R> {
	return field(body, name, rule, `${name} must be an id`, (sent) => {
		if (numberOf(sent) === undefined) refuse(rule, 'type', `${name} must be an id`);
		const id = idOf(sent);
		if (id === undefined) refuse(rule, 'invalid', `${name} must be an id`);
		return id;
	}) as Read<number, R>;
}

/**
 * `true` or `false`, and nothing else: not `"false"`, not 0.
 *
 *     type     `<name> must be true or false`
 */
export function readBoolean<R extends Rule>(body: RequestBody, name: string, rule: R): Read<boolean, R> {
	return field(body, name, rule, `${name} must be true or false`, (sent) => {
		if (typeof sent !== 'boolean') refuse(rule, 'type', `${name} must be true or false`);
		return sent;
	}) as Read<boolean, R>;
}

/** The rule of a field that holds one of a few words. */
export type ChoiceRule<C extends string> = Rule & {
	/** The words, each in the spelling that is written. */
	from: readonly C[];
	/** `High` is `high`: the spelling in `from` is what is handed back. */
	anyCase?: boolean;
	/** Spaces at either end are taken off before the word is looked for. */
	trim?: boolean;
};

/**
 * One of the words in `rule.from`, in its spelling there.
 *
 *     type     not text: `<name> must be one of: <the words, with commas>`
 *     invalid  text that is none of them, in the same words
 */
export function readChoice<C extends string, R extends ChoiceRule<C>>(body: RequestBody, name: string, rule: R & ChoiceRule<C>): Read<C, R> {
	const wrong = `${name} must be one of: ${rule.from.join(', ')}`;
	return field(body, name, rule, wrong, (sent) => {
		if (typeof sent !== 'string') refuse(rule, 'type', wrong);
		const choice = choiceOf(sent, rule.from, rule.anyCase === true, rule.trim === true);
		if (choice === undefined) refuse(rule, 'invalid', wrong);
		return choice;
	}) as Read<C, R>;
}

/**
 * A calendar date, written `YYYY-MM-DD`, of a day there is. Empty text is
 * null, which is how a page clears a date, and so is refused where null is.
 *
 *     type     not text: `<name> must be a date written YYYY-MM-DD`
 *     invalid  text that is not such a date, 2026-02-30 among them, in the same words
 */
export function readDate<R extends Rule>(body: RequestBody, name: string, rule: R): Read<string, R> {
	const wrong = `${name} must be a date written YYYY-MM-DD`;
	return field(body, name, rule, wrong, (sent) => {
		if (typeof sent !== 'string') refuse(rule, 'type', wrong);
		if (sent === '') {
			if (rule.nullable) return null;
			refuse(rule, 'type', wrong);
		}
		if (!isCalendarDate(sent)) refuse(rule, 'invalid', wrong);
		return sent;
	}) as Read<string, R>;
}

/** The rule of a time of day. */
export type TimeRule = Rule & {
	/** What empty text is read as. Without it, empty text is refused. */
	empty?: string;
};

/**
 * A time of day, `HH:MM`, from 00:00 to 23:59.
 *
 *     type     not text: `<name> must be a time written HH:MM, from 00:00 to 23:59`
 *     invalid  text that is not such a time, empty text without `empty`, in the same words
 */
export function readTime<R extends TimeRule>(body: RequestBody, name: string, rule: R): Read<string, R> {
	const wrong = `${name} must be a time written HH:MM, from 00:00 to 23:59`;
	return field(body, name, rule, wrong, (sent) => {
		if (typeof sent !== 'string') refuse(rule, 'type', wrong);
		if (sent === '' && rule.empty !== undefined) return rule.empty;
		if (!TIME_OF_DAY.test(sent)) refuse(rule, 'invalid', wrong);
		return sent;
	}) as Read<string, R>;
}

/** The rule of a timestamp. */
export type TimestampRule = Rule & {
	/** A moment that has not yet come. */
	future?: boolean;
};

/**
 * A moment, written as a date, as a date and a time with or without a zone
 * (`2027-01-01`, `2027-01-01T09:30:00+02:00`), or in the stored form
 * (`2027-01-01 09:30:00`). It is handed back in the stored form,
 * `YYYY-MM-DD HH:MM:SS` in UTC (card 2095, decision 10), because a stored
 * timestamp is compared as text, and text compares moments only within one
 * form. It was handed back as `toISOString()`, which sorts after every stored
 * value of its day.
 *
 * A time with no zone is UTC, as a date alone is and as the API's own
 * timestamps are: `2027-01-01T09:30:00` is 09:30 UTC, where `new Date()` would
 * read it in the server's own zone. A fraction of a second is dropped. A date
 * alone is the start of that day, so an API key that expires on a date stops
 * at 00:00 UTC that day, as it did.
 *
 *     type     not text: `<name> must be a timestamp, such as 2027-01-01T09:00:00Z`
 *     invalid  text that is not one, in the same words; `<name> must be in the future`
 */
export function readTimestamp<R extends TimestampRule>(body: RequestBody, name: string, rule: R): Read<Stamp, R> {
	const wrong = `${name} must be a timestamp, such as 2027-01-01T09:00:00Z`;
	return field(body, name, rule, wrong, (sent) => {
		if (typeof sent !== 'string') refuse(rule, 'type', wrong);
		const stored = toStamp(sent, 'lower');
		if (stored === null) refuse(rule, 'invalid', wrong);
		if (rule.future && parseStamp(stored)!.getTime() <= Date.now()) refuse(rule, 'invalid', `${name} must be in the future`);
		return stored;
	}) as Read<Stamp, R>;
}

/** The rule of a web address. */
export type UrlRule = Rule & {
	/** The most characters. 2,048 if not said. */
	max?: number;
	/** Empty text is allowed, and handed back as it is. */
	allowEmpty?: boolean;
	/**
	 * Text with no scheme is completed with `http://`, as `getAppUrl()` in
	 * `email.ts` completes the App URL it reads, and handed back completed:
	 * `kanban.example.com` is `http://kanban.example.com`.
	 */
	complete?: boolean;
};

/** A scheme at the start of an address: `https://`, `ftp://`. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * An `http` or `https` address, trimmed. With `complete`, text with no scheme
 * is read as `http://` and that text, and is still refused if what is left is
 * not a host: `/path` and `name:secret@host` are refused, as `ftp://host` is.
 *
 *     type     not text: `<name> must be an http or https address`
 *     invalid  any other address, or none, in the same words; `<name> must be at most <max> characters`
 */
export function readUrl<R extends UrlRule>(body: RequestBody, name: string, rule: R): Read<string, R> {
	const wrong = `${name} must be an http or https address`;
	const max = rule.max ?? 2048;
	return field(body, name, rule, wrong, (sent) => {
		if (typeof sent !== 'string') refuse(rule, 'type', wrong);
		const trimmed = sent.trim();
		if (trimmed === '' && rule.allowEmpty) return trimmed;
		const completed = rule.complete === true && !SCHEME.test(trimmed);
		const text = completed ? `http://${trimmed}` : trimmed;
		if (text.length > max) refuse(rule, 'invalid', `${name} must be at most ${max} characters`);
		let address: URL | null = null;
		try {
			address = new URL(text);
		} catch {
			// Not an address at all: refused below.
		}
		if (address === null || (address.protocol !== 'http:' && address.protocol !== 'https:')) refuse(rule, 'invalid', wrong);
		// Completed, the text must have begun with its host: `http:///path` is read
		// as the host `path`, and `http://mailto:a@b` as the host `b`.
		if (completed && (/^[/\\]/.test(trimmed) || address.username !== '' || address.password !== '')) refuse(rule, 'invalid', wrong);
		return text;
	}) as Read<string, R>;
}

/** The rule of an email address. */
export type EmailRule = Rule & {
	/** Empty text is allowed, and handed back as it is. */
	allowEmpty?: boolean;
};

/**
 * An email address, trimmed: something, an @ and something, with no space
 * and none of `, ; < > " ( )`, and at most 254 characters.
 *
 *     type     not text: `<name> must be an email address`
 *     invalid  text that is not one, in the same words
 */
export function readEmail<R extends EmailRule>(body: RequestBody, name: string, rule: R): Read<string, R> {
	return field(body, name, rule, `${name} must be an email address`, (sent) => {
		if (typeof sent !== 'string') refuse(rule, 'type', `${name} must be an email address`);
		const text = sent.trim();
		if (text === '' && rule.allowEmpty) return text;
		if (text.length > 254 || !EMAIL_ADDRESS.test(text)) refuse(rule, 'invalid', `${name} must be an email address`);
		return text;
	}) as Read<string, R>;
}

/**
 * Email addresses written as one text, as a report schedule keeps its
 * recipients and the backup settings their failure address, each held to
 * `readEmail`'s rule. They may be separated by commas, semicolons or line
 * breaks, as the report's email dialog takes them; spaces round each are
 * ignored, and so is an empty part. They are handed back separated by a comma
 * and a space, the one form the scheduler splits and the mailer takes:
 * `a@x.test;b@x.test` is `a@x.test, b@x.test`. Empty text is no addresses, `''`.
 *
 *     type     not text: `<name> must be email addresses separated by commas`
 *     invalid  `<name> must be at most <max> characters` (2,000 if not said), of
 *              the text handed back;
 *              a part that is not an address: `<name> holds "<part>", which is not an email address`
 */
export function readEmailText<R extends Rule & { max?: number }>(body: RequestBody, name: string, rule: R): Read<string, R> {
	const max = rule.max ?? 2000;
	return field(body, name, rule, `${name} must be email addresses separated by commas`, (sent) => {
		if (typeof sent !== 'string') refuse(rule, 'type', `${name} must be email addresses separated by commas`);
		const parts = sent
			.split(/[,;\r\n]/)
			.map((each) => each.trim())
			.filter((each) => each !== '');
		const text = parts.join(', ');
		if (text.length > max) refuse(rule, 'invalid', `${name} must be at most ${max} characters`);
		for (const part of parts) {
			if (!EMAIL_ADDRESS.test(part)) refuse(rule, 'invalid', `${name} holds "${part}", which is not an email address`);
		}
		return text;
	}) as Read<string, R>;
}

/**
 * A report schedule's recipients, written as one text (card 2182): read as
 * `reportRecipients` in `$lib/report-recipients` reads them, which is how the
 * scheduler sends them. They may be separated by commas, semicolons or white
 * space, and an address may be written `<address>`. They are handed back each
 * once, lower-cased, separated by a comma and a space: exactly the addresses
 * the schedule will be sent to. Empty text is no addresses, `''`. How many
 * there may be is the route's to say.
 *
 *     type     not text: `<name> must be email addresses separated by commas`
 *     invalid  `<name> must be at most <max> characters` (2,000 if not said), of
 *              the text handed back;
 *              a part that is not an address: `<name> holds "<part>", which is
 *              not an email address`, or up to five of them named, `<name> holds
 *              "<part>", "<part>" and 3 more, which are not email addresses`,
 *              each in at most 100 characters
 */
export function readReportRecipients<R extends Rule & { max?: number }>(body: RequestBody, name: string, rule: R): Read<string, R> {
	const max = rule.max ?? 2000;
	return field(body, name, rule, `${name} must be email addresses separated by commas`, (sent) => {
		if (typeof sent !== 'string') refuse(rule, 'type', `${name} must be email addresses separated by commas`);
		const { addresses, notAddresses } = reportRecipients(sent);
		// A part is named in at most 100 characters: the text may be as long as a body.
		const named = notAddresses.slice(0, 5).map((part) => `"${part.length > 100 ? `${part.slice(0, 100)}…` : part}"`);
		if (notAddresses.length === 1) refuse(rule, 'invalid', `${name} holds ${named[0]}, which is not an email address`);
		if (notAddresses.length > 1) {
			const more = notAddresses.length > 5 ? ` and ${notAddresses.length - 5} more` : '';
			refuse(rule, 'invalid', `${name} holds ${named.join(', ')}${more}, which are not email addresses`);
		}
		const text = addresses.join(', ');
		if (text.length > max) refuse(rule, 'invalid', `${name} must be at most ${max} characters`);
		return text;
	}) as Read<string, R>;
}

/** The rule of a colour. */
export type ColourRule = Rule & {
	/** Empty text is allowed, and handed back as it is: how a colour tag is cleared. */
	allowEmpty?: boolean;
};

/**
 * A colour written `#rrggbb`, trimmed, in the case it was sent in (card 2162's
 * rule, `isHexColour` in `$lib/colours.ts`). A colour is written into a
 * `style` attribute on every page that draws it, so nothing else is taken:
 * not `red`, not `#fff`, not `red;background:url(//x.io)`.
 *
 *     type     not text: `<name> must be a colour written #rrggbb`, with
 *              `, or empty` where empty text is allowed
 *     invalid  text that is not such a colour, in the same words
 */
export function readColour<R extends ColourRule>(body: RequestBody, name: string, rule: R): Read<string, R> {
	const wrong = rule.allowEmpty ? `${name} must be a colour written #rrggbb, or empty` : `${name} must be a colour written #rrggbb`;
	return field(body, name, rule, wrong, (sent) => {
		if (typeof sent !== 'string') refuse(rule, 'type', wrong);
		const text = sent.trim();
		if (text === '' && rule.allowEmpty) return text;
		if (!isHexColour(text)) refuse(rule, 'invalid', wrong);
		return text;
	}) as Read<string, R>;
}

/**
 * A card's cover: a colour written `#rrggbb`, or one of the eight gradients
 * the card window offers, exactly as it offers it (`isCoverValue` in
 * `$lib/colours.ts`, card 2010). A cover is drawn as a `background` on the
 * board for every viewer, so nothing else is taken: not `url(...)`, which
 * would have each viewer's browser fetch an address of the writer's choosing,
 * and not a gradient of the writer's own. Empty text is null, which is how
 * the card window clears a cover, and so is refused where null is.
 *
 * Card 2117 read it as text of up to 2,048 characters; card 2010's decision
 * 14 holds for this field.
 *
 *     type     not text: `<name> must be a colour written #rrggbb, one of the
 *              preset gradients, or null`, without `, or null` where null is
 *              not allowed
 *     invalid  text that is neither, in the same words
 */
export function readCover<R extends Rule>(body: RequestBody, name: string, rule: R): Read<string, R> {
	const wrong = rule.nullable
		? `${name} must be a colour written #rrggbb, one of the preset gradients, or null`
		: `${name} must be a colour written #rrggbb or one of the preset gradients`;
	return field(body, name, rule, wrong, (sent) => {
		if (typeof sent !== 'string') refuse(rule, 'type', wrong);
		if (sent === '') {
			if (rule.nullable) return null;
			refuse(rule, 'type', wrong);
		}
		if (!isCoverValue(sent)) refuse(rule, 'invalid', wrong);
		return sent;
	}) as Read<string, R>;
}

// ─── Lists ───────────────────────────────────────────────────────────────────

/** The rule of a list. */
export type ListRule = Rule & {
	/** The fewest entries. 1 refuses an empty list, as `empty`. */
	min?: number;
	/** The most entries. */
	max?: number;
};

/** The list `name`, with its length checked, for a list reader to look at each entry of. */
function list(body: RequestBody, name: string, rule: ListRule, look: (entries: unknown[]) => unknown[]): unknown[] | null | undefined {
	return field(body, name, rule, `${name} must be a list`, (sent) => {
		if (!Array.isArray(sent)) refuse(rule, 'type', `${name} must be a list`);
		if (rule.min !== undefined && sent.length < rule.min) {
			if (sent.length === 0) refuse(rule, 'empty', `${name} cannot be empty`);
			refuse(rule, 'invalid', `${name} must have at least ${rule.min} entries`);
		}
		if (rule.max !== undefined && sent.length > rule.max) {
			refuse(rule, 'invalid', `${name} must have at most ${rule.max} entries`);
		}
		return look(sent);
	});
}

/**
 * A list, whose entries are handed back as they were sent and are still to be
 * looked at, each as `unknown`. For a list of something the readers below do
 * not read.
 *
 *     type     not a list: `<name> must be a list`
 *     empty    `<name> cannot be empty`, where `min` is 1 or more
 *     invalid  `<name> must have at least <min> entries`, `<name> must have at most <max> entries`
 */
export function readList<R extends ListRule>(body: RequestBody, name: string, rule: R): Read<unknown[], R> {
	return list(body, name, rule, (entries) => entries) as Read<unknown[], R>;
}

/**
 * A list of JSON objects, each with its fields still to be read, as a body's
 * are. Refuses as `readList` does, and an entry that is not an object:
 *
 *     invalid  `<name>[<index>] must be an object`
 */
export function readObjects<R extends ListRule>(body: RequestBody, name: string, rule: R): Read<RequestBody[], R> {
	return list(body, name, rule, (entries) =>
		entries.map((entry, index) => {
			if (!isObject(entry)) refuse(rule, 'invalid', `${name}[${index}] must be an object`);
			return entry;
		})
	) as Read<RequestBody[], R>;
}

/**
 * A list of ids, each a whole number of 1 or more, or one written as text, as
 * `readId` reads one. Refuses as `readList` does, and an entry that is not an id:
 *
 *     invalid  `<name>[<index>] must be an id`
 */
export function readIds<R extends ListRule>(body: RequestBody, name: string, rule: R): Read<number[], R> {
	return list(body, name, rule, (entries) =>
		entries.map((entry, index) => {
			const id = idOf(entry);
			if (id === undefined) refuse(rule, 'invalid', `${name}[${index}] must be an id`);
			return id;
		})
	) as Read<number[], R>;
}

/**
 * A list of words, each one of `rule.from`, in its spelling there. With
 * `trim`, `" card.moved"` is `card.moved`. Refuses as `readList` does, and:
 *
 *     invalid  `<name>[<index>] must be one of: <the words, with commas>`
 */
export function readChoices<C extends string, R extends ListRule & ChoiceRule<C>>(
	body: RequestBody,
	name: string,
	rule: R & ChoiceRule<C>
): Read<C[], R> {
	return list(body, name, rule, (entries) =>
		entries.map((entry, index) => {
			const choice = choiceOf(entry, rule.from, rule.anyCase === true, rule.trim === true);
			if (choice === undefined) refuse(rule, 'invalid', `${name}[${index}] must be one of: ${rule.from.join(', ')}`);
			return choice;
		})
	) as Read<C[], R>;
}

/**
 * A list of email addresses, each trimmed and each held to `readEmail`'s
 * rule, as the report-email dialog sends them. Refuses as `readList` does, and:
 *
 *     invalid  `<name>[<index>] must be an email address`
 */
export function readEmailList<R extends ListRule>(body: RequestBody, name: string, rule: R): Read<string[], R> {
	return list(body, name, rule, (entries) =>
		entries.map((entry, index) => {
			const text = typeof entry === 'string' ? entry.trim() : '';
			if (text.length > 254 || !EMAIL_ADDRESS.test(text)) refuse(rule, 'invalid', `${name}[${index}] must be an email address`);
			return text;
		})
	) as Read<string[], R>;
}

// ─── Ids in the path ─────────────────────────────────────────────────────────

/**
 * An id in the path, `params.id` as it came: a whole number of 1 or more,
 * written in digits and nothing else. Anything else is a 400 in the guards'
 * own words, `Invalid <thing> ID`, or in `says`. `1.5`, `abc`, `0` and `1e3`
 * are refused, where `Number()` and `isNaN` let some of them through.
 */
export function pathId(value: string | undefined, thing: string, says?: string): number {
	const id = value !== undefined && ID_AS_TEXT.test(value) ? Number(value) : NaN;
	if (!Number.isSafeInteger(id) || id < 1) error(400, says ?? `Invalid ${thing} ID`);
	return id;
}

// ─── Query parameters ────────────────────────────────────────────────────────

/**
 * How many rows a list answers: `searchParams.get('limit')` as it came.
 * Never refused. Not sent, text that is not a number, and 0 are `fallback`:
 * 0 was read as not sent before card 2117 (`Number(limit) || 100`), and still
 * is. Any other number is rounded down and held between 1 and `max`, so `-1`
 * is 1 and not every row, and to the largest whole number held exactly, which
 * SQLite takes.
 */
export function readLimit(value: string | null, rule: { max: number; fallback: number }): number {
	const limit = numberOf(value);
	if (limit === undefined || limit === 0) return rule.fallback;
	return Math.min(Math.max(Math.floor(limit), 1), rule.max, Number.MAX_SAFE_INTEGER);
}

/**
 * How many rows a list skips. Never refused. Not sent, or text that is not a
 * number, is 0; a number is rounded down, and is 0 or more. It is held to the
 * largest whole number held exactly: SQLite refuses `1e20` as an offset, which
 * was a 500.
 */
export function readOffset(value: string | null): number {
	const offset = numberOf(value);
	return offset === undefined ? 0 : Math.min(Math.max(Math.floor(offset), 0), Number.MAX_SAFE_INTEGER);
}

/**
 * A count asked for in a query string: a whole number of 0 or more, written in
 * digits. Not sent, or empty, is `fallback`; more than `max` is `max`, however
 * many digits it has. Anything else is a 400, a count too large to be held
 * exactly where there is no `max` among them: `<name> must be a whole number
 * of 0 or more`, or `says`.
 */
export function readQueryCount(value: string | null, name: string, rule: { fallback: number; max?: number; says?: string }): number {
	if (value === null || value === '') return rule.fallback;
	const count = ID_AS_TEXT.test(value) ? Number(value) : NaN;
	const held = rule.max === undefined ? count : Math.min(count, rule.max);
	if (!Number.isSafeInteger(held)) error(400, rule.says ?? `${name} must be a whole number of 0 or more`);
	return held;
}

/**
 * An id in a query string, read as `pathId` reads one, and `undefined` when it
 * was not sent or is empty. `Invalid <thing> ID`, or `says`.
 */
export function readQueryId(value: string | null, thing: string, says?: string): number | undefined {
	if (value === null || value === '') return undefined;
	return pathId(value, thing, says);
}

/**
 * A date (`2026-10-14`) or a timestamp (`2026-10-14T09:00:00Z`,
 * `2026-10-14 09:00:00`) in a query string, as one end of a range, and
 * `undefined` when it was not sent or is empty. Anything else is a 400:
 * `<name> is not a date`, or `says`.
 *
 * It is handed back in the stored form, `YYYY-MM-DD HH:MM:SS` in UTC (card
 * 2095, decision 10), because a stored timestamp is compared as text: a
 * timestamp written with an offset is moved to UTC, one with no zone is UTC
 * already, as the API's own timestamps are, and a fraction is dropped. A
 * date alone is the whole of that day: its first second as the `lower` end
 * of a range, its last as the `upper` one, so a range to 14 October includes
 * the 14th. A date was handed back as it came and a timestamp in ISO, and
 * each caller compared them its own way.
 */
export function readQueryDate(value: string | null, name: string, edge: Edge = 'lower', says?: string): Stamp | undefined {
	if (value === null || value === '') return undefined;
	const stored = toStamp(value, edge);
	if (stored === null) error(400, says ?? `${name} is not a date`);
	return stored;
}
