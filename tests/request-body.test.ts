/**
 * One way to read a request body, and to refuse what a handler cannot use
 * (card 2117): the readers of `src/lib/server/request-body.ts`, and the rule
 * that every handler reads its body through them.
 *
 * The readers are called directly, each against its own rule. A wrong type is
 * a 400 that names the field: a number for text, text for a number, `"false"`
 * for a boolean, `null` where the field cannot be empty, a list, an object. A
 * number written as text is read as that number. `says` puts the texts tests
 * and documents quote in place of a reader's own, and a value equal to `keep`,
 * which is what the row holds, is handed back unchecked.
 *
 * The rule is kept by reading the source, as tests/error-shape.test.ts keeps
 * its rule. Every `+server.ts` under `src/routes` and every module under
 * `src/lib/server` is parsed with the TypeScript compiler, and the test fails
 * on:
 *
 *   - a body read from the request anywhere but in request-body.ts and
 *     api-errors.ts, in any of the ways a request is read: `json()`, `text()`,
 *     `arrayBuffer()`, `blob()`, `bytes()`, `formData()`, and its `.body`
 *     (`new Response(request.body)` among them). The request is found by what
 *     it is, not by its name: `{ request: req }`, `event.request`, a name it is
 *     kept in and a name given the type `Request` are the request too. A body
 *     that is not JSON is named in `NOT_JSON`, read by read;
 *   - a cast of what `readBody`, `readObjects` or `asObject` hands back, or of
 *     a field of it, or a type written on the name it is kept in;
 *   - a body (what `readBody` hands back, or an entry of what `readObjects`
 *     hands back) read by a key that is not written out, spread, handed to
 *     `Object.assign`, `keys`, `entries` or `values`, walked with `for…in`, or
 *     with a field turned into another type by `Number()`, `String()`,
 *     `Boolean()` or `!!`. Each, like a cast, would undo the `unknown` that
 *     makes the type check refuse a field no reader has looked at:
 *     `updateData[key] = body[key]` copies fields unchecked into a row.
 *
 * A body is followed by the names it is kept in, in the function it is kept
 * in: handed whole to another function, it is not followed there. What the
 * test does not name, the type check or the review has to see.
 *
 * While handlers were being moved onto the readers, the files that still read
 * their body as JSON themselves were named in `STILL_READING`, which failed on
 * an entry that no longer did, so it could only shrink. Card 2117's fourth
 * slice took the last of them off: it is empty, and stays so. A floor of 80
 * `readBody` calls stands in its place, so that a parser that saw nothing
 * could not pass. `NOT_JSON` fails on a read it names that is no longer there.
 *
 * The last part is the cases table: what each handler moved onto the readers
 * refuses, sent through `api()` against the in-memory database, where no
 * other test file already holds that route's refusals. The handlers of card
 * 2115 are there; the report schedule's are in tests/internal-refusals.test.ts
 * and the dependency routes' in tests/dependency-refusals.test.ts. The rest of
 * the file needs no database.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import Database from 'better-sqlite3';
import { isHttpError } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardBody } from '$lib/server/api-errors';
import { isHexColour } from '$lib/colours';
import { duplicateCard } from '$lib/board/card-actions';
import { SftpDestination } from '$lib/server/backup-destinations';
import { getAppUrl } from '$lib/server/email';
import type { CardType, ColumnType } from '$lib/types';
import { categoryToCopy, colourToCopy, dueDateToCopy, priorityToCopy } from '$lib/utils/card-utils';
import { db } from '$lib/server/db';
import {
	apiKeys,
	boardCategories,
	boardMembers,
	boards,
	cardAssignees,
	cardComments,
	cards,
	categories,
	columns,
	labels,
	milestones,
	reportSchedules,
	settings,
	subtasks,
	taskRequests,
	teamMembers,
	users,
	webhooks
} from '$lib/server/db/schema';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { makePasswordHash } from '$lib/server/passwords';
import { api, type ApiResult } from './helpers/api';
import {
	addBoardMember,
	makeBoard,
	makeCard,
	makeComment,
	makeLabel,
	makeMilestone,
	makeSubtask,
	makeTeam,
	makeUser,
	makeWebhook,
	resetDb
} from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';
import {
	pathId,
	readBody,
	readBoolean,
	readChoice,
	readChoices,
	readColour,
	readCover,
	readDate,
	readEmail,
	readEmailList,
	readEmailText,
	readId,
	readIds,
	readLimit,
	readList,
	readNumber,
	readObjects,
	readOffset,
	readQueryCount,
	readQueryDate,
	readQueryId,
	readText,
	readTime,
	readTimeZone,
	readTimestamp,
	readUrl,
	type Refusal,
	type RequestBody,
	type Rule
} from '$lib/server/request-body';

// ─── Calling a reader ────────────────────────────────────────────────────────

type Outcome = { value: unknown } | { refused: number; message: string };

/** What a reader did: the value it handed back, or the refusal it threw. Anything else it throws fails the test. */
function outcome(read: () => unknown): Outcome {
	try {
		return { value: read() };
	} catch (thrown) {
		if (isHttpError(thrown)) return { refused: thrown.status, message: thrown.body.message };
		throw thrown;
	}
}

const handed = (value: unknown): Outcome => ({ value });
const refused = (message: string): Outcome => ({ refused: 400, message });

/** An SSH host key's fingerprint as `ssh-keygen -l` prints it: SHA256: and 43 characters (card 2250). */
const FINGERPRINT = 'SHA256:s16t1ixxsjxOgoaXCXACvAIOEG1K5biSlM7GekmavrY';

/** R5's refusal of a host key, for the destination at `at` (none for a body that is one destination). */
const HOST_KEY = (at: string | null) =>
	`${at === null ? '' : `${at}.`}hostKey must be an SSH host key fingerprint with its type: the line ssh-keygen -l prints ` +
	'(256 SHA256:… root@nas (ED25519)), or the type and fingerprint (ssh-ed25519 SHA256:…), the fingerprint being SHA256: ' +
	'and 43 characters';

/** A request as the gate hands it on: its reading guarded. */
function guarded(body: string): Request {
	const request = new Request('http://localhost/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
	guardBody(request);
	return request;
}

// ─── The body ────────────────────────────────────────────────────────────────

describe('readBody', () => {
	it('hands back the JSON object the body holds', async () => {
		expect(await readBody(guarded('{"title":"x","position":2}'))).toEqual({ title: 'x', position: 2 });
		expect(await readBody(guarded('{}'))).toEqual({});
	});

	it('is refused 400 for an array, in the gate’s words, before it reaches the handler', async () => {
		await expect(readBody(guarded('[]'))).rejects.toMatchObject({ status: 400, body: { message: 'The request body must be a JSON object' } });
		await expect(readBody(guarded('[{"title":"x"}]'))).rejects.toMatchObject({ status: 400 });
	});

	it('asks again itself, so that a request the gate never saw is held to the same rule', async () => {
		for (const body of ['[]', '[1]', 'null', '5', '"x"', 'true']) {
			const unguarded = new Request('http://localhost/api/x', { method: 'POST', body });

			await expect(readBody(unguarded), body).rejects.toMatchObject({
				status: 400,
				body: { message: 'The request body must be a JSON object' }
			});
		}
	});
});

// ─── What every field reader does ────────────────────────────────────────────

/**
 * Each field reader, called for the field `f`, with a value it hands back and
 * a value that its rule refuses, refused as `badIs`: `invalid` unless it says.
 */
const FIELD_READERS: {
	name: string;
	read: (body: RequestBody, rule: Rule) => unknown;
	good: unknown;
	bad: unknown;
	badIs?: Refusal;
}[] = [
	{ name: 'readText', read: (body, rule) => readText(body, 'f', { ...rule, max: 3 }), good: 'abc', bad: 'abcd' },
	{ name: 'readNumber', read: (body, rule) => readNumber(body, 'f', { ...rule, max: 3 }), good: 3, bad: 4 },
	{ name: 'readId', read: (body, rule) => readId(body, 'f', rule), good: 3, bad: 0 },
	{ name: 'readBoolean', read: (body, rule) => readBoolean(body, 'f', rule), good: false, bad: 'false', badIs: 'type' },
	{ name: 'readChoice', read: (body, rule) => readChoice(body, 'f', { ...rule, from: ['low', 'high'] }), good: 'low', bad: 'urgent' },
	{ name: 'readDate', read: (body, rule) => readDate(body, 'f', rule), good: '2026-10-14', bad: '2026-02-30' },
	{ name: 'readTime', read: (body, rule) => readTime(body, 'f', rule), good: '09:00', bad: '24:00' },
	{ name: 'readTimeZone', read: (body, rule) => readTimeZone(body, 'f', rule), good: 'Europe/London', bad: 'Mars/Base' },
	{ name: 'readTimestamp', read: (body, rule) => readTimestamp(body, 'f', rule), good: '2026-10-14 09:00:00', bad: 'soon' },
	{ name: 'readUrl', read: (body, rule) => readUrl(body, 'f', rule), good: 'https://example.test/h', bad: 'ftp://example.test' },
	{ name: 'readEmail', read: (body, rule) => readEmail(body, 'f', rule), good: 'a@example.test', bad: 'a' },
	{ name: 'readEmailText', read: (body, rule) => readEmailText(body, 'f', rule), good: 'a@example.test, b@example.test', bad: 'a, b' },
	{ name: 'readList', read: (body, rule) => readList(body, 'f', { ...rule, max: 1 }), good: [1], bad: [1, 2] },
	{ name: 'readObjects', read: (body, rule) => readObjects(body, 'f', rule), good: [{ a: 1 }], bad: [null] },
	{ name: 'readIds', read: (body, rule) => readIds(body, 'f', rule), good: [3], bad: [0] },
	{
		name: 'readChoices',
		read: (body, rule) => readChoices(body, 'f', { ...rule, from: ['card.created', 'card.moved'] }),
		good: ['card.moved'],
		bad: ['card.lost']
	},
	{ name: 'readEmailList', read: (body, rule) => readEmailList(body, 'f', rule), good: ['a@example.test'], bad: ['a'] },
	{ name: 'readColour', read: (body, rule) => readColour(body, 'f', rule), good: '#a1B2c3', bad: 'red' },
	{ name: 'readCover', read: (body, rule) => readCover(body, 'f', rule), good: '#a1B2c3', bad: 'url(https://example.test/t.png)' }
];

describe.each(FIELD_READERS)('$name, as every field reader', ({ read, good, bad, badIs = 'invalid' }) => {
	const the = (sent: unknown, rule: Rule = {}) => outcome(() => read({ f: sent }, rule));
	const wrong = () => {
		const answer = the(bad);
		if (!('refused' in answer)) throw new Error('the bad value was not refused');
		return answer.message;
	};

	it('hands back what it was sent, as it is to be written', () => {
		expect(the(good)).toEqual(handed(good));
	});

	it('refuses a value of the right type that its rule does not allow, naming the field', () => {
		expect(the(bad)).toMatchObject({ refused: 400, message: expect.stringMatching(/^f\b/) });
	});

	it('hands back undefined for a field not sent, and refuses it when the field is required', () => {
		expect(outcome(() => read({}, {}))).toEqual(handed(undefined));
		expect(outcome(() => read({}, { required: true }))).toEqual(refused('f is required'));
	});

	it('refuses null, unless the field may be empty, when null is handed back', () => {
		expect(the(null)).toMatchObject({ refused: 400, message: expect.stringMatching(/^f /) });
		expect(the(null, { nullable: true })).toEqual(handed(null));
		// Required is about being sent: null that is allowed is sent.
		expect(the(null, { nullable: true, required: true })).toEqual(handed(null));
	});

	it('refuses an object, which no field holds, naming the field', () => {
		expect(the({})).toMatchObject({ refused: 400, message: expect.stringMatching(/^f /) });
		expect(the({ value: good })).toMatchObject({ refused: 400, message: expect.stringMatching(/^f /) });
	});

	it('hands back a value equal to `keep` as it is, unchecked, and checks any other (decision 8)', () => {
		expect(the(bad, { keep: bad })).toEqual(handed(bad));
		// The pair that shows the rule is still there: a different value the rule refuses, on the same row.
		expect(the(bad, { keep: good })).toEqual(refused(wrong()));
		// The same JSON type and value, and nothing looser.
		if (typeof bad === 'number') expect(the(String(bad), { keep: bad })).toEqual(refused(wrong()));
	});

	it('says a refusal in the words of `says`: one text for every refusal, or one for each refusal named', () => {
		expect(the(bad, { says: 'In other words' })).toEqual(refused('In other words'));
		expect(outcome(() => read({}, { required: true, says: 'In other words' }))).toEqual(refused('In other words'));
		expect(outcome(() => read({}, { required: true, says: { missing: 'Say it' } }))).toEqual(refused('Say it'));
		// A refusal not named keeps the reader's own words.
		expect(the(bad, { says: { missing: 'Say it' } })).toEqual(refused(wrong()));
		expect(the(bad, { says: { [badIs]: 'Not that' } })).toEqual(refused('Not that'));
		expect(the(null, { says: { type: 'Not null' } })).toEqual(refused('Not null'));
	});
});

describe('every field reader', () => {
	it('reads only the body’s own fields: `constructor` is not a field of `{}`', () => {
		expect(outcome(() => readText({}, 'constructor', { required: true }))).toEqual(refused('constructor is required'));
		expect(outcome(() => readText({}, 'toString', {}))).toEqual(handed(undefined));
		expect(outcome(() => readText(JSON.parse('{"__proto__":"x"}'), '__proto__', {}))).toEqual(handed('x'));
	});
});

// ─── Each field reader's own rule ────────────────────────────────────────────

describe('readText', () => {
	const text = (sent: unknown, rule: Parameters<typeof readText>[2] = {}) => outcome(() => readText({ title: sent }, 'title', rule));

	it('refuses anything that is not text, before its length is looked at', () => {
		for (const sent of [5, true, null, {}, ['x'], ['x'.repeat(600)]]) {
			expect(text(sent, { max: 500 }), JSON.stringify(sent)).toEqual(refused('title must be text'));
		}
	});

	it('trims only when asked, and counts the length after trimming', () => {
		expect(text('  x  ')).toEqual(handed('  x  '));
		expect(text('  x  ', { trim: true })).toEqual(handed('x'));
		expect(text('  abc  ', { trim: true, max: 3 })).toEqual(handed('abc'));
		expect(text('  abc  ', { max: 3 })).toEqual(refused('title must be at most 3 characters'));
	});

	it('refuses text that is empty where some is needed, and text too short or too long', () => {
		expect(text('   ', { trim: true, min: 1 })).toEqual(refused('title cannot be empty'));
		expect(text('', { min: 1 })).toEqual(refused('title cannot be empty'));
		expect(text('', {})).toEqual(handed(''));
		expect(text('a', { min: 2 })).toEqual(refused('title must be at least 2 characters'));
		expect(text('x'.repeat(501), { max: 500 })).toEqual(refused('title must be at most 500 characters'));
		expect(text('x'.repeat(500), { max: 500 })).toEqual(handed('x'.repeat(500)));
	});

	it('keeps the texts tests quote today through `says`', () => {
		const says = { missing: 'Title is required', empty: 'Title is required', invalid: 'Title too long (max 500 chars)' };
		expect(outcome(() => readText({}, 'title', { required: true, trim: true, min: 1, max: 500, says }))).toEqual(refused('Title is required'));
		expect(text(' ', { required: true, trim: true, min: 1, max: 500, says })).toEqual(refused('Title is required'));
		expect(text('x'.repeat(501), { trim: true, min: 1, max: 500, says })).toEqual(refused('Title too long (max 500 chars)'));
		// The wrong type keeps the reader's own words, which name the field.
		expect(text(5, { trim: true, min: 1, max: 500, says })).toEqual(refused('title must be text'));
	});
});

describe('readNumber', () => {
	const number = (sent: unknown, rule: Parameters<typeof readNumber>[2] = {}) => outcome(() => readNumber({ position: sent }, 'position', rule));

	it('reads a number, and a number written as text that is exactly a number', () => {
		expect(number(5)).toEqual(handed(5));
		expect(number(-2.5)).toEqual(handed(-2.5));
		expect(number('5')).toEqual(handed(5));
		expect(number('-2.5')).toEqual(handed(-2.5));
		expect(number(' 7 ')).toEqual(handed(7));
	});

	it('refuses anything else as not a number: no other way of writing one is read', () => {
		for (const sent of ['top', '', ' ', '1e3', '0x10', 'Infinity', 'NaN', '5px', '+5', '.5', true, false, [], [5], {}, null]) {
			expect(number(sent), JSON.stringify(sent)).toEqual(refused('position must be a number'));
		}
		// JSON reads 1e400 as Infinity, which is no number to store.
		expect(outcome(() => readNumber(JSON.parse('{"n":1e400}'), 'n', {}))).toEqual(refused('n must be a number'));
		// And so does Number() read text of 400 digits, which is written as a number.
		expect(number(`1${'0'.repeat(400)}`)).toEqual(refused('position must be a number'));
		expect(number(`-1${'0'.repeat(400)}`)).toEqual(refused('position must be a number'));
	});

	it('refuses a fraction, and a number too large to be held exactly, where a whole number is asked for', () => {
		expect(number(2, { whole: true })).toEqual(handed(2));
		expect(number('2', { whole: true })).toEqual(handed(2));
		expect(number(2.5, { whole: true })).toEqual(refused('position must be a whole number'));
		expect(number('2.5', { whole: true })).toEqual(refused('position must be a whole number'));
		expect(number(2 ** 53, { whole: true })).toEqual(refused('position must be a whole number'));
		expect(number('top', { whole: true })).toEqual(refused('position must be a whole number'));
	});

	it('reads text as a whole number only if it is written whole, as readId does', () => {
		expect(number('1.0', { whole: true })).toEqual(handed(1));
		expect(number(' 7 ', { whole: true })).toEqual(handed(7));
		expect(number('-3.00', { whole: true })).toEqual(handed(-3));
		// Number() reads these as 1 and 5: they are not written whole.
		for (const sent of ['1.0000000000000001', '5.0000000000000001', '1.50']) {
			expect(number(sent, { whole: true }), sent).toEqual(refused('position must be a whole number'));
		}
		// Where a whole number is not asked for, it is a number like any other.
		expect(number('1.0000000000000001')).toEqual(handed(1));
	});

	it('holds a number to its range, in words that give the range', () => {
		expect(number(-1, { min: 0, max: 6 })).toEqual(refused('position must be from 0 to 6'));
		expect(number(7, { min: 0, max: 6 })).toEqual(refused('position must be from 0 to 6'));
		expect(number(0, { min: 0, max: 6 })).toEqual(handed(0));
		expect(number(6, { min: 0, max: 6 })).toEqual(handed(6));
		expect(number(0, { min: 1 })).toEqual(refused('position must be at least 1'));
		expect(number(101, { max: 100 })).toEqual(refused('position must be at most 100'));
	});
});

describe('readId', () => {
	const id = (sent: unknown) => outcome(() => readId({ columnId: sent }, 'columnId', {}));

	it('reads a whole number of 1 or more, and one written as text', () => {
		expect(id(5)).toEqual(handed(5));
		expect(id('5')).toEqual(handed(5));
		expect(id(' 12 ')).toEqual(handed(12));
	});

	it('refuses anything else, `null`, 0 and a fraction among them: no id is "card 0"', () => {
		for (const sent of [0, -1, 1.5, '1.5', '0', 'abc', '', '1e3', true, null, [5], {}, 2 ** 53]) {
			expect(id(sent), JSON.stringify(sent)).toEqual(refused('columnId must be an id'));
		}
	});

	it('reads text that is whole as it is written, and refuses text that Number() only rounds to a whole number', () => {
		expect(id('1.0')).toEqual(handed(1));
		expect(id(' 7')).toEqual(handed(7));
		expect(id('007')).toEqual(handed(7));
		for (const sent of ['1.0000000000000001', '5.0000000000000001', `1${'0'.repeat(400)}`]) {
			expect(id(sent), sent).toEqual(refused('columnId must be an id'));
		}
		expect(outcome(() => readIds({ cardIds: ['1.0', '1.0000000000000001'] }, 'cardIds', {}))).toEqual(refused('cardIds[1] must be an id'));
	});
});

describe('readBoolean', () => {
	it('reads true and false, and nothing else: "false" is never true', () => {
		expect(outcome(() => readBoolean({ pinned: true }, 'pinned', {}))).toEqual(handed(true));
		expect(outcome(() => readBoolean({ pinned: false }, 'pinned', {}))).toEqual(handed(false));
		for (const sent of ['false', 'true', '', 0, 1, null, [], {}, [true]]) {
			expect(outcome(() => readBoolean({ pinned: sent }, 'pinned', {})), JSON.stringify(sent)).toEqual(refused('pinned must be true or false'));
		}
	});
});

describe('readChoice', () => {
	const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
	const WRONG = 'priority must be one of: low, medium, high, critical';
	const choice = (sent: unknown, rule: { anyCase?: boolean; trim?: boolean } = {}) =>
		outcome(() => readChoice({ priority: sent }, 'priority', { ...rule, from: PRIORITIES }));

	it('reads one of its words', () => {
		expect(choice('high')).toEqual(handed('high'));
	});

	it('refuses any other word, and anything that is not text, in words that list the choices', () => {
		for (const sent of ['urgent', 'High', ' high', '', 5, null, ['high'], {}]) {
			expect(choice(sent), JSON.stringify(sent)).toEqual(refused(WRONG));
		}
	});

	it('reads a word in any case where asked, and hands it back in its own spelling', () => {
		expect(choice('High', { anyCase: true })).toEqual(handed('high'));
		expect(choice('CRITICAL', { anyCase: true })).toEqual(handed('critical'));
		expect(choice(' high ', { anyCase: true })).toEqual(refused(WRONG));
		expect(choice(' high ', { anyCase: true, trim: true })).toEqual(handed('high'));
	});
});

describe('readDate', () => {
	const WRONG = 'dueDate must be a date written YYYY-MM-DD';
	const date = (sent: unknown, rule: Rule = {}) => outcome(() => readDate({ dueDate: sent }, 'dueDate', rule));

	it('reads a calendar date written YYYY-MM-DD, of a day there is', () => {
		expect(date('2026-10-14')).toEqual(handed('2026-10-14'));
		expect(date('2024-02-29')).toEqual(handed('2024-02-29'));
	});

	it('refuses a day there is not, any other way of writing one, and anything that is not text', () => {
		for (const sent of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-1-1', '2026-10-14T00:00:00Z', '14/10/2026', 'tomorrow', 20261014, true]) {
			expect(date(sent), JSON.stringify(sent)).toEqual(refused(WRONG));
		}
	});

	it('reads empty text as null, which is how a page clears a date, and refuses it where null is refused', () => {
		expect(date('', { nullable: true })).toEqual(handed(null));
		expect(date('')).toEqual(refused(WRONG));
	});
});

describe('readTime', () => {
	const WRONG = 'timeOfDay must be a time written HH:MM, from 00:00 to 23:59';
	const time = (sent: unknown, rule: { empty?: string } = {}) => outcome(() => readTime({ timeOfDay: sent }, 'timeOfDay', rule));

	it('reads HH:MM from 00:00 to 23:59, and nothing else', () => {
		for (const sent of ['00:00', '09:00', '23:59']) expect(time(sent)).toEqual(handed(sent));
		for (const sent of ['24:00', '9:00', '09:60', '9', '09:00:00', '', 900, null]) {
			expect(time(sent), JSON.stringify(sent)).toEqual(refused(WRONG));
		}
	});

	it('reads empty text as what the rule says it means', () => {
		expect(time('', { empty: '09:00' })).toEqual(handed('09:00'));
	});
});

describe('readTimeZone', () => {
	const WRONG = 'timeZone must be a time zone name, such as Europe/London';
	const zone = (sent: unknown) => outcome(() => readTimeZone({ timeZone: sent }, 'timeZone', {}));

	it('hands back a zone the server knows, by the name the server gives it (card 2159)', () => {
		expect(zone('Europe/London')).toEqual(handed('Europe/London'));
		expect(zone('europe/london')).toEqual(handed('Europe/London'));
		expect(zone('Etc/UTC')).toEqual(handed('UTC'));
	});

	it('refuses a name it does not know, an offset, empty text, more than 64 characters, and anything not text', () => {
		for (const sent of ['Mars/Base', '+01:00', '', 'E'.repeat(65), 5, null]) {
			expect(zone(sent), JSON.stringify(sent)).toEqual(refused(WRONG));
		}
	});
});

describe('readTimestamp', () => {
	const WRONG = 'expiresAt must be a timestamp, such as 2027-01-01T09:00:00Z';
	const stamp = (sent: unknown, rule: { future?: boolean } = {}) => outcome(() => readTimestamp({ expiresAt: sent }, 'expiresAt', rule));

	it('hands back the moment in the stored form, whatever zone or form it was written in (card 2095)', () => {
		expect(stamp('2027-01-01T09:30:00+02:00')).toEqual(handed('2027-01-01 07:30:00'));
		expect(stamp('2027-01-01T07:30:00Z')).toEqual(handed('2027-01-01 07:30:00'));
		expect(stamp('2027-01-01T07:30:00.000Z')).toEqual(handed('2027-01-01 07:30:00'));
		expect(stamp('2027-01-01 07:30:00')).toEqual(handed('2027-01-01 07:30:00'));
		// A date alone is the start of that day: a key expiring on it stops at 00:00 UTC.
		expect(stamp('2027-01-01')).toEqual(handed('2027-01-01 00:00:00'));
		// Seven digits of a fraction and an offset, as PowerShell's `Get-Date -Format o` writes (R7).
		expect(stamp('2027-01-01T09:30:00.1234567+01:00')).toEqual(handed('2027-01-01 08:30:00'));
	});

	it('reads a time with no zone as UTC, as a date alone is, whatever zone the server is in', () => {
		const zone = process.env.TZ;
		// A zone with no summer time and not on UTC, so that a time read in it is plainly not UTC.
		process.env.TZ = 'Asia/Kolkata';
		try {
			expect(stamp('2027-07-01T09:30:00')).toEqual(handed('2027-07-01 09:30:00'));
			expect(stamp('2027-07-01T09:30')).toEqual(handed('2027-07-01 09:30:00'));
			// A fraction of a second is dropped: the stored form is whole seconds.
			expect(stamp('2027-07-01T09:30:00.5')).toEqual(handed('2027-07-01 09:30:00'));
			expect(stamp('2027-07-01')).toEqual(handed('2027-07-01 00:00:00'));
			// A zone written is read.
			expect(stamp('2027-07-01T09:30:00-01:00')).toEqual(handed('2027-07-01 10:30:00'));
		} finally {
			if (zone === undefined) delete process.env.TZ;
			else process.env.TZ = zone;
		}
	});

	it('refuses anything that is not a moment so written', () => {
		for (const sent of ['banana', '2027-02-30T00:00:00Z', '2027-01-01 25:00:00', '2027-01-01T25:00:00Z', '1', 1798761600000, true, null]) {
			expect(stamp(sent), JSON.stringify(sent)).toEqual(refused(WRONG));
		}
	});

	it('refuses a moment that has come, where one in the future is asked for', () => {
		expect(stamp('2000-01-01T00:00:00Z', { future: true })).toEqual(refused('expiresAt must be in the future'));
		expect(stamp('2999-01-01T00:00:00Z', { future: true })).toEqual(handed('2999-01-01 00:00:00'));
	});
});

describe('readUrl', () => {
	const WRONG = 'url must be an http or https address';
	const url = (sent: unknown, rule: { allowEmpty?: boolean; max?: number } = {}) => outcome(() => readUrl({ url: sent }, 'url', rule));

	it('reads an http or https address, trimmed', () => {
		expect(url('https://example.test/hook')).toEqual(handed('https://example.test/hook'));
		expect(url(' http://example.test ')).toEqual(handed('http://example.test'));
	});

	it('refuses any other address, and text that is none', () => {
		for (const sent of ['ftp://example.test', 'javascript:alert(1)', 'file:///etc/passwd', 'example.test', '', 5]) {
			expect(url(sent), JSON.stringify(sent)).toEqual(refused(WRONG));
		}
	});

	it('allows empty text where asked, and holds an address to 2,048 characters unless told otherwise', () => {
		expect(url('', { allowEmpty: true })).toEqual(handed(''));
		expect(url(`https://example.test/${'x'.repeat(2048)}`)).toEqual(refused('url must be at most 2048 characters'));
		expect(url('https://example.test/abc', { max: 10 })).toEqual(refused('url must be at most 10 characters'));
	});
});

describe('readColour', () => {
	const WRONG = 'color must be a colour written #rrggbb';
	const colour = (sent: unknown, rule: { allowEmpty?: boolean } = {}) => outcome(() => readColour({ color: sent }, 'color', rule));

	it('reads a colour written #rrggbb, in either case, trimmed, and in the case it was sent in', () => {
		expect(colour('#a1B2c3')).toEqual(handed('#a1B2c3'));
		expect(colour(' #a1b2c3 ')).toEqual(handed('#a1b2c3'));
		expect(colour('#FFFFFF')).toEqual(handed('#FFFFFF'));
	});

	it('refuses any other colour and anything that is not one, in one text: a colour is written into a style on every page that draws it', () => {
		const NOT = ['red;background:url(//x.io)', 'red', '#fff', '#ffff', '#ff000080', '#abcdef1', 'url(x)', '#zzzzzz', '#12345', 'rgb(1,2,3)', 'x y', '', ' ', 5, ['#ffffff'], {}, null, true];
		for (const sent of NOT) expect(colour(sent), JSON.stringify(sent)).toEqual(refused(WRONG));
	});

	it('allows empty text where asked, which clears a colour tag, and says so in its refusal', () => {
		const tag = (sent: unknown) => outcome(() => readColour({ colorTag: sent }, 'colorTag', { allowEmpty: true }));
		expect(tag('')).toEqual(handed(''));
		expect(tag('  ')).toEqual(handed(''));
		expect(tag('#10b981')).toEqual(handed('#10b981'));
		for (const sent of ['red', '#fff', 5, null]) {
			expect(tag(sent), JSON.stringify(sent)).toEqual(refused('colorTag must be a colour written #rrggbb, or empty'));
		}
	});

	it('asks isHexColour, which a page can ask too: # and six hex digits, as text, and nothing else', () => {
		expect(['#a1B2c3', '#000000', '#FFFFFF'].map(isHexColour)).toEqual([true, true, true]);
		const NOT = ['#fff', '#ffff', '#ff000080', 'red', 'var(--accent)', ' #a1b2c3', '#a1b2c3 ', '', 5, ['#ffffff'], null, undefined, {}];
		expect(NOT.map(isHexColour)).toEqual(NOT.map(() => false));
	});
});

describe('readEmail, readEmailText and readEmailList', () => {
	it('reads an email address, trimmed, and refuses text that is not one', () => {
		expect(outcome(() => readEmail({ to: ' a@example.test ' }, 'to', {}))).toEqual(handed('a@example.test'));
		for (const sent of ['a', 'a b@example.test', '@example.test', 'a@', '', 5]) {
			expect(outcome(() => readEmail({ to: sent }, 'to', {})), JSON.stringify(sent)).toEqual(refused('to must be an email address'));
		}
		expect(outcome(() => readEmail({ to: '' }, 'to', { allowEmpty: true }))).toEqual(handed(''));
	});

	it('refuses an address holding , ; < > " ( ), which the mailer reads as two addresses, or as a name, a group or a comment round one', () => {
		const ODD = ['victim,attacker@evil.test', 'a;b@example.test', '<a@example.test>', 'a@example.test>', '"a"@example.test', 'a(b)@example.test', 'a@(b)example.test'];
		for (const sent of ODD) {
			expect(outcome(() => readEmail({ to: sent }, 'to', {})), sent).toEqual(refused('to must be an email address'));
			expect(outcome(() => readEmailList({ to: ['a@example.test', sent] }, 'to', {})), sent).toEqual(refused('to[1] must be an email address'));
		}
		// The text of a schedule is split on its commas, semicolons and lines first; each part is held to the same rule.
		expect(outcome(() => readEmailText({ to: 'a@example.test, b<c@example.test' }, 'to', {}))).toEqual(
			refused('to holds "b<c@example.test", which is not an email address')
		);
	});

	it('reads addresses written as one text with commas, as a schedule keeps them, ignoring empty parts', () => {
		const text = (sent: unknown) => outcome(() => readEmailText({ recipients: sent }, 'recipients', {}));
		expect(text('a@example.test, b@example.test')).toEqual(handed('a@example.test, b@example.test'));
		// Handed back in the one form a schedule holds (card 2117's second fix pass).
		expect(text('a@example.test,,')).toEqual(handed('a@example.test'));
		expect(text('')).toEqual(handed(''));
		expect(text('a@example.test, nobody')).toEqual(refused('recipients holds "nobody", which is not an email address'));
		expect(text(['a@example.test'])).toEqual(refused('recipients must be email addresses separated by commas'));
		expect(text(`${'a'.repeat(2000)}@example.test`)).toEqual(refused('recipients must be at most 2000 characters'));
	});

	it('reads a list of addresses, as the report-email dialog sends them, naming an entry that is not one', () => {
		const list = (sent: unknown) => outcome(() => readEmailList({ recipients: sent }, 'recipients', { min: 1 }));
		expect(list([' a@example.test ', 'b@example.test'])).toEqual(handed(['a@example.test', 'b@example.test']));
		expect(list(['a@example.test', 'nobody'])).toEqual(refused('recipients[1] must be an email address'));
		expect(list([5])).toEqual(refused('recipients[0] must be an email address'));
		expect(list([])).toEqual(refused('recipients cannot be empty'));
		expect(list('a@example.test')).toEqual(refused('recipients must be a list'));
	});
});

describe('the list readers', () => {
	it('readList refuses what is not a list, and a list too short or too long', () => {
		const list = (sent: unknown, rule: { min?: number; max?: number } = {}) => outcome(() => readList({ links: sent }, 'links', rule));
		expect(list([1, 'a', null])).toEqual(handed([1, 'a', null]));
		for (const sent of ['[]', {}, 5]) expect(list(sent), JSON.stringify(sent)).toEqual(refused('links must be a list'));
		expect(list([], { min: 1 })).toEqual(refused('links cannot be empty'));
		expect(list([1], { min: 2 })).toEqual(refused('links must have at least 2 entries'));
		expect(list([1, 2, 3], { max: 2 })).toEqual(refused('links must have at most 2 entries'));
	});

	it('readObjects names the entry that is not an object (decision 18)', () => {
		const objects = (sent: unknown) => outcome(() => readObjects({ links: sent }, 'links', {}));
		expect(objects([{ blocked: 1 }, {}])).toEqual(handed([{ blocked: 1 }, {}]));
		expect(objects([{}, {}, {}, null])).toEqual(refused('links[3] must be an object'));
		expect(objects([[1]])).toEqual(refused('links[0] must be an object'));
		expect(objects(['x'])).toEqual(refused('links[0] must be an object'));
	});

	it('readIds reads each entry as an id, so null is no longer "card 0"', () => {
		const ids = (sent: unknown) => outcome(() => readIds({ cardIds: sent }, 'cardIds', {}));
		expect(ids([1, '2'])).toEqual(handed([1, 2]));
		expect(ids([1, null])).toEqual(refused('cardIds[1] must be an id'));
		expect(ids([0])).toEqual(refused('cardIds[0] must be an id'));
		expect(ids([1.5])).toEqual(refused('cardIds[0] must be an id'));
	});

	it('readChoices reads each entry as one of its words, trimmed where asked (R9)', () => {
		const EVENTS = ['card.created', 'card.moved'] as const;
		const events = (sent: unknown, trim = true) => outcome(() => readChoices({ events: sent }, 'events', { from: EVENTS, trim }));
		expect(events(['card.created', ' card.moved'])).toEqual(handed(['card.created', 'card.moved']));
		expect(events([])).toEqual(handed([]));
		expect(events([' card.moved'], false)).toEqual(refused('events[0] must be one of: card.created, card.moved'));
		expect(events(['card.moved', 'card.lost'])).toEqual(refused('events[1] must be one of: card.created, card.moved'));
		expect(events([null])).toEqual(refused('events[0] must be one of: card.created, card.moved'));
		expect(events('card.moved')).toEqual(refused('events must be a list'));
	});
});

describe('what the readers hand back, to the type check', () => {
	it('is the type the rule says, and a field of the body is unknown until a reader has read it', () => {
		const body: RequestBody = { title: 'x', when: null, priority: 'low', cardIds: [1] };

		const title: string = readText(body, 'title', { required: true, max: 5 });
		// @ts-expect-error A field that is not required may not have been sent.
		const maybe: string = readText(body, 'title', { max: 5 });
		const when: string | null = readDate(body, 'when', { required: true, nullable: true });
		// @ts-expect-error Null is handed back only where the rule allows it.
		const never: string | undefined = readDate(body, 'when', { nullable: true });
		const priority: 'low' | 'high' = readChoice(body, 'priority', { required: true, from: ['low', 'high'] });
		const cardIds: number[] = readIds(body, 'cardIds', { required: true });
		// @ts-expect-error The body's fields are unknown.
		const unread: string = body.title;

		expect([title, maybe, when, never, priority, cardIds, unread]).toEqual(['x', 'x', null, null, 'low', [1], 'x']);
	});
});

// ─── Ids in the path, and query parameters ───────────────────────────────────

describe('pathId', () => {
	it('reads an id written in digits, of 1 or more', () => {
		expect(outcome(() => pathId('5', 'card'))).toEqual(handed(5));
		expect(outcome(() => pathId('007', 'card'))).toEqual(handed(7));
	});

	it('refuses anything else in the guards’ own words, where Number() and isNaN let some through', () => {
		for (const sent of ['1.5', 'abc', '0', '00', '', '-1', '1e3', ' 5', '5 ', '5abc', '0x10', '9007199254740993', undefined]) {
			expect(outcome(() => pathId(sent, 'card')), String(sent)).toEqual(refused('Invalid card ID'));
		}
		expect(outcome(() => pathId('1.5', 'milestone'))).toEqual(refused('Invalid milestone ID'));
		expect(outcome(() => pathId('1.5', 'card', 'Card not found'))).toEqual(refused('Card not found'));
	});
});

describe('the query readers, which take the value and not the name (R7)', () => {
	it('readLimit is never refused: a whole number held between 1 and the cap, and the default for text and for 0', () => {
		const limit = (value: string | null) => readLimit(value, { max: 500, fallback: 100 });
		expect([null, '', 'abc', '1e3'].map(limit)).toEqual([100, 100, 100, 100]);
		expect(['-1', '2.5', '20', '500', '501', '99999'].map(limit)).toEqual([1, 2, 20, 500, 500, 500]);
		// 0 is not sent, as `Number(limit) || 100` read it before card 2117: the default, and not 1.
		expect(['0', '0.0', '-0'].map(limit)).toEqual([100, 100, 100]);
	});

	it('readOffset is never refused: a whole number of 0 or more, and 0 for text', () => {
		expect([null, '', 'x', '-5', '7.9', '40'].map(readOffset)).toEqual([0, 0, 0, 0, 7, 40]);
	});

	it('readOffset and readLimit hold a number to the largest whole number held exactly, which SQLite takes', () => {
		const huge = `1${'0'.repeat(20)}`;
		expect(readOffset(huge)).toBe(Number.MAX_SAFE_INTEGER);
		expect(readLimit(huge, { max: Infinity, fallback: 100 })).toBe(Number.MAX_SAFE_INTEGER);
		// Text of 400 digits, which Number() reads as Infinity, is no number: the default.
		expect(readOffset(`1${'0'.repeat(400)}`)).toBe(0);
		expect(readLimit(`1${'0'.repeat(400)}`, { max: 500, fallback: 100 })).toBe(100);

		// SQLite refuses 1e20 as an offset or a limit, which was a 500; what the readers hand back it takes.
		const sqlite = new Database(':memory:');
		try {
			const page = (limit: number, offset: number) => sqlite.prepare('SELECT 1 AS one LIMIT ? OFFSET ?').all(limit, offset);
			expect(() => page(1, 1e20)).toThrow(/datatype mismatch/);
			expect(page(readLimit(huge, { max: Infinity, fallback: 100 }), readOffset(huge))).toEqual([]);
		} finally {
			sqlite.close();
		}
	});

	it('readQueryCount reads a whole number of 0 or more, holds it to the cap, and refuses anything else', () => {
		const count = (value: string | null) => outcome(() => readQueryCount(value, 'commentLimit', { fallback: 3, max: 20 }));
		expect([null, '', '0', '5', '25'].map(count)).toEqual([3, 3, 0, 5, 20].map(handed));
		for (const value of ['-1', '2.5', 'x', ' 5']) {
			expect(count(value), value).toEqual(refused('commentLimit must be a whole number of 0 or more'));
		}
	});

	it('readQueryCount holds a count of any number of digits to the cap, and refuses one too large to hold only where there is none', () => {
		const count = (value: string, max?: number) => outcome(() => readQueryCount(value, 'commentLimit', { fallback: 3, max }));
		expect(count('9'.repeat(30), 20)).toEqual(handed(20));
		expect(count(`1${'0'.repeat(400)}`, 20)).toEqual(handed(20));
		expect(count('9'.repeat(30))).toEqual(refused('commentLimit must be a whole number of 0 or more'));
		expect(count('9007199254740991')).toEqual(handed(Number.MAX_SAFE_INTEGER));
	});

	it('readQueryId reads an id as pathId does, and nothing sent as no id', () => {
		expect([null, ''].map((value) => readQueryId(value, 'board'))).toEqual([undefined, undefined]);
		expect(readQueryId('12', 'board')).toBe(12);
		for (const value of ['2.5', '5abc', '0']) {
			expect(outcome(() => readQueryId(value, 'board')), value).toEqual(refused('Invalid board ID'));
		}
		expect(outcome(() => readQueryId('x', 'board', 'Invalid boardId'))).toEqual(refused('Invalid boardId'));
	});

	it('readQueryDate reads a date or a timestamp, in the stored form, and refuses anything else (decision 17; card 2095)', () => {
		expect([null, ''].map((value) => readQueryDate(value, 'from'))).toEqual([undefined, undefined]);
		expect(readQueryDate('2026-10-14T09:00:00Z', 'from')).toBe('2026-10-14 09:00:00');
		expect(readQueryDate('2026-10-14T09:00:00.999Z', 'from')).toBe('2026-10-14 09:00:00');
		expect(readQueryDate('2026-10-14 09:00:00', 'from')).toBe('2026-10-14 09:00:00');
		// A date alone is the whole of that day: its first second as a lower bound, its last as an upper one.
		expect(readQueryDate('2026-10-14', 'from')).toBe('2026-10-14 00:00:00');
		expect(readQueryDate('2026-10-14', 'to', 'upper')).toBe('2026-10-14 23:59:59');
		expect(readQueryDate('2026-10-14T09:00:00Z', 'to', 'upper')).toBe('2026-10-14 09:00:00');
		for (const value of ['yesterday', '2026-13-01', '2026-02-30', '14/10/2026', '1']) {
			expect(outcome(() => readQueryDate(value, 'from')), value).toEqual(refused('from is not a date'));
		}
	});

	it('readQueryDate hands back a timestamp with an offset, or with no zone, in UTC, as readTimestamp does', () => {
		const zone = process.env.TZ;
		// A zone with no summer time and not on UTC, so that a time read in it is plainly not UTC.
		process.env.TZ = 'Asia/Kolkata';
		try {
			// A stored timestamp is compared as text: `09:00+02:00` compared as written is two hours out.
			expect(readQueryDate('2026-10-14T09:00:00+02:00', 'from')).toBe('2026-10-14 07:00:00');
			expect(readQueryDate('2026-10-14T09:00:00-01:30', 'from')).toBe('2026-10-14 10:30:00');
			// No zone is UTC, as the API's own timestamps are, and not the server's zone.
			expect(readQueryDate('2026-10-14T09:00:00', 'from')).toBe('2026-10-14 09:00:00');
			expect(readQueryDate('2026-10-14T09:00', 'from')).toBe('2026-10-14 09:00:00');
			expect(readQueryDate('2026-10-14 09:00:00', 'from')).toBe('2026-10-14 09:00:00');
			// A date is the whole day in UTC, whatever the server's zone.
			expect(readQueryDate('2026-10-14', 'to', 'upper')).toBe('2026-10-14 23:59:59');
		} finally {
			if (zone === undefined) delete process.env.TZ;
			else process.env.TZ = zone;
		}
	});
});

// ─── The rule: every handler reads its body through readBody ─────────────────

const ROOT = process.cwd();

/**
 * The files that still read their body themselves, with the build that moves
 * each onto the readers and takes it off. Empty: card 2117's fourth slice took
 * off the last 21, the accounts, administration, teams, reports and requests.
 *
 * It was 80 files and 95 reads when it was made: 19 files for P2 (cards 2114
 * and 2115), 21 for slice 2, 19 for slice 3 and 21 for slice 4. A handler is
 * written with `readBody` and never goes on: the test below fails on any entry.
 */
const STILL_READING: Record<string, string> = {};

/** The fewest calls of `readBody` the tree holds: 95 when the last handler was moved. */
const FEWEST_READ_BODY_CALLS = 80;

/**
 * The bodies read as something other than JSON, which `readBody` is not for,
 * each by its file and the way it is read, with why. It fails on an entry that
 * no longer matches a read, as `STILL_READING` does. A body read as JSON
 * (`json()`, or `text()` for `JSON.parse`) is never put here: it is read with
 * `readBody`, or is on `STILL_READING` until it is.
 */
const NOT_JSON: Record<string, string> = {
	'src/routes/api/admin/import/+server.ts arrayBuffer()': 'The import reads a .db backup, as bytes.',
	'src/routes/api/cards/[id]/attachments/+server.ts formData()':
		'The attachment upload reads a form. guardBody answers a body that is not one 400.',
	'src/lib/server/body-limits.ts .body':
		'heldToLimit passes the body through a count, for whatever reads it after. Its other two are `request.body === null`, which reads nothing.'
};

/** The two files that read a body as JSON for everyone else. */
const READ_HERE = ['src/lib/server/request-body.ts', 'src/lib/server/api-errors.ts'];

/** How a body read as JSON is written: what a file on `STILL_READING` may do until it is moved. */
const JSON_READS = ['json()', 'text()'];

/** The methods of a request that read its body. Its `.body`, the stream, is looked for beside them. */
const BODY_READERS = ['json', 'text', 'arrayBuffer', 'blob', 'bytes', 'formData'];

/** Files under `dir` that `keep` says yes to, as paths from the repository root with forward slashes. */
function filesUnder(dir: string, keep: (path: string) => boolean): string[] {
	return (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
		.map((path) => `${dir}/${path.split('\\').join('/')}`)
		.filter(keep)
		.sort();
}

const FILES = [
	...filesUnder('src/routes', (path) => path.endsWith('/+server.ts')),
	...filesUnder('src/lib/server', (path) => path.endsWith('.ts'))
];

type Found = {
	/** A body read from the request: `at` is `file:line`, `how` is `json()`, `formData()`, `.body` and the like. */
	reads: { at: string; how: string }[];
	/** A cast of what `readBody` hands back, of a field of it, or a type written on its name: `file:line what`. */
	casts: string[];
	/** A use of what `readBody` hands back, or of an entry `readObjects` hands back, that goes round the readers: `file:line what`. */
	uses: string[];
	/** Calls of `readBody`. */
	readBodyCalls: number;
};

/** `node` without the parentheses, `await` and `!` round it. */
function bare(node: ts.Expression): ts.Expression {
	let inner = node;
	while (ts.isParenthesizedExpression(inner) || ts.isAwaitExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
	return inner;
}

const OR_ELSE: ts.SyntaxKind[] = [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken];
const EQUALS: ts.SyntaxKind[] = [
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken
];

/** `node` bare, and without what follows a `??` or a `||` after it: `readObjects(...) ?? []` is the list. */
function bareOr(node: ts.Expression): ts.Expression {
	let inner = bare(node);
	while (ts.isBinaryExpression(inner) && OR_ELSE.includes(inner.operatorToken.kind)) inner = bare(inner.left);
	return inner;
}

/** The function `node` is in, or the file. */
function scopeOf(node: ts.Node): ts.Node {
	let at = node.parent;
	while (at && !ts.isFunctionLike(at) && !ts.isSourceFile(at)) at = at.parent;
	return at;
}

/** Is this a call of the function called `name`? */
function isCallOf(node: ts.Expression, name: string): node is ts.CallExpression {
	return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
}

/** Names, by the node they are kept in: a function, a loop, the file. */
class Names {
	private readonly held = new Map<ts.Node, Set<string>>();

	keep(scope: ts.Node, name: string): void {
		this.held.set(scope, (this.held.get(scope) ?? new Set()).add(name));
	}

	/** Is `name` kept in a node that `at` is in? */
	holds(name: string, at: ts.Node): boolean {
		for (let up: ts.Node | undefined = at; up; up = up.parent) {
			if (this.held.get(up)?.has(name)) return true;
		}
		return false;
	}
}

/** The array methods whose first argument is called with each entry, as its first parameter. */
const EACH_ENTRY = ['map', 'forEach', 'filter', 'some', 'every', 'find', 'findLast', 'findIndex', 'flatMap'];

/** `Object` functions that copy or walk an object's fields. */
const OBJECT_WALKS = ['assign', 'keys', 'entries', 'values'];

/** Functions that turn a value into another type, so that the type check no longer sees it was unknown. */
const COERCIONS = ['Number', 'String', 'Boolean'];

/** Every body read, every cast of a body and every use of one that goes round the readers, in one file. */
function check(file: string, source: string): Found {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const line = (node: ts.Node) => `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`;
	const found: Found = { reads: [], casts: [], uses: [], readBodyCalls: 0 };

	// The names the request goes by: `request`, a name given the type
	// `Request`, the name it is given out of the event (`{ request: req }`),
	// and a name it is kept in (`const r = event.request`, `const r = request`).
	const requestNames = new Set(['request']);

	/** Is this the request, or a clone of it? */
	const isTheRequest = (node: ts.Expression): boolean => {
		let held = bare(node);
		if (ts.isCallExpression(held) && ts.isPropertyAccessExpression(held.expression) && held.expression.name.text === 'clone') {
			held = bare(held.expression.expression);
		}
		return (
			(ts.isIdentifier(held) && requestNames.has(held.text)) || (ts.isPropertyAccessExpression(held) && held.name.text === 'request')
		);
	};

	const name = (node: ts.Node): void => {
		if (
			ts.isBindingElement(node) &&
			node.propertyName &&
			ts.isIdentifier(node.propertyName) &&
			node.propertyName.text === 'request' &&
			ts.isIdentifier(node.name)
		) {
			requestNames.add(node.name.text);
		}
		if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name)) {
			const typed = node.type && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) && node.type.typeName.text === 'Request';
			if (typed || (node.initializer && isTheRequest(node.initializer))) requestNames.add(node.name.text);
		}
		ts.forEachChild(node, name);
	};
	name(tree);

	// The names what readBody hands back is kept in, and the names an entry of
	// what readObjects hands back is kept in; and the names those lists are kept in.
	const bodies = new Names();
	const lists = new Names();

	/** The node a call hands its value to, past the parentheses, `await`, `!` and `?? []` round it, and the outermost of those. */
	const handedTo = (call: ts.CallExpression): { to: ts.Node; result: ts.Expression } => {
		let result: ts.Expression = call;
		for (;;) {
			const up = result.parent;
			if (ts.isParenthesizedExpression(up) || ts.isAwaitExpression(up) || ts.isNonNullExpression(up)) result = up;
			else if (bareOr(up as ts.Expression) === call && ts.isBinaryExpression(up)) result = up;
			else return { to: up, result };
		}
	};

	/** Keep the name a call's value is put in, if it is put in one. */
	const keepName = (call: ts.CallExpression, names: Names): ts.Node => {
		const { to, result } = handedTo(call);
		if (ts.isVariableDeclaration(to) && to.initializer === result && ts.isIdentifier(to.name)) {
			names.keep(scopeOf(to), to.name.text);
		} else if (ts.isBinaryExpression(to) && to.operatorToken.kind === ts.SyntaxKind.EqualsToken && to.right === result && ts.isIdentifier(to.left)) {
			names.keep(scopeOf(to), to.left.text);
		}
		return to;
	};

	/** Is this a list readObjects handed back: the call itself, or a name it is kept in? */
	const isList = (node: ts.Expression): boolean => {
		const held = bareOr(node);
		return isCallOf(held, 'readObjects') || (ts.isIdentifier(held) && lists.holds(held.text, held));
	};

	/** Is this a body: what readBody handed back, or an entry of a list readObjects handed back? */
	const isBody = (node: ts.Expression): boolean => {
		const held = bare(node);
		if (isCallOf(held, 'readBody') || isCallOf(held, 'asObject')) return true;
		if (ts.isIdentifier(held)) return bodies.holds(held.text, held);
		return ts.isElementAccessExpression(held) && isList(held.expression);
	};

	/** Is this a field of a body, as it is, or before a `??` or a `||`? */
	const isFieldOfBody = (node: ts.Expression): boolean => {
		const held = bareOr(node);
		return (ts.isPropertyAccessExpression(held) || ts.isElementAccessExpression(held)) && isBody(held.expression);
	};

	const casts: (ts.AsExpression | ts.TypeAssertion)[] = [];
	const everything: ts.Node[] = [];
	const visit = (node: ts.Node): void => {
		everything.push(node);
		if (ts.isCallExpression(node)) {
			const called = node.expression;
			if (ts.isPropertyAccessExpression(called) && BODY_READERS.includes(called.name.text) && isTheRequest(called.expression)) {
				found.reads.push({ at: line(node), how: `${called.name.text}()` });
			}
			if (isCallOf(node, 'readBody')) {
				found.readBodyCalls++;
				const to = keepName(node, bodies);
				if (ts.isAsExpression(to) || ts.isTypeAssertionExpression(to)) found.casts.push(`${line(to)} casts what readBody hands back`);
				if (ts.isVariableDeclaration(to) && to.type) found.casts.push(`${line(to)} writes a type on what readBody hands back`);
				if (ts.isVariableDeclaration(to) && ts.isObjectBindingPattern(to.name) && to.name.elements.some((each) => each.dotDotDotToken)) {
					found.uses.push(`${line(to)} copies the fields of what readBody hands back with a rest (...)`);
				}
			}
			if (isCallOf(node, 'readObjects')) {
				const to = keepName(node, lists);
				if (ts.isAsExpression(to) || ts.isTypeAssertionExpression(to)) found.casts.push(`${line(to)} casts what readObjects hands back`);
			}
			// An entry of a list that may be an object, handed back as a body to read with the readers.
			if (isCallOf(node, 'asObject')) {
				const to = keepName(node, bodies);
				if (ts.isAsExpression(to) || ts.isTypeAssertionExpression(to)) found.casts.push(`${line(to)} casts what asObject hands back`);
			}
		}
		// The stream itself, but not `request.body === null`, which asks whether there is one and reads nothing.
		if (ts.isPropertyAccessExpression(node) && node.name.text === 'body' && isTheRequest(node.expression)) {
			const asked = ts.isBinaryExpression(node.parent) && EQUALS.includes(node.parent.operatorToken.kind);
			if (!asked) found.reads.push({ at: line(node), how: '.body' });
		}
		if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) casts.push(node);
		ts.forEachChild(node, visit);
	};
	visit(tree);

	// The names an entry of a list is kept in: `for (const link of links)`,
	// `links.map((link) => ...)` and `const link = links[i]`.
	for (const node of everything) {
		if (ts.isForOfStatement(node) && isList(node.expression) && ts.isVariableDeclarationList(node.initializer)) {
			const [declared] = node.initializer.declarations;
			if (declared && ts.isIdentifier(declared.name)) bodies.keep(node, declared.name.text);
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && EACH_ENTRY.includes(node.expression.name.text)) {
			const [each] = node.arguments;
			if (isList(node.expression.expression) && each && (ts.isArrowFunction(each) || ts.isFunctionExpression(each))) {
				const [entry] = each.parameters;
				if (entry && ts.isIdentifier(entry.name)) bodies.keep(each, entry.name.text);
			}
		}
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			const value = bare(node.initializer);
			if (ts.isElementAccessExpression(value) && isList(value.expression)) bodies.keep(scopeOf(node), node.name.text);
		}
	}

	// What the type check cannot see: a field read by a key that is not
	// written out and copied on (`updateData[key] = body[key]`), the fields
	// copied or walked whole, and a field turned into a number, text or a
	// boolean, which the type check takes as checked.
	for (const node of everything) {
		if (ts.isElementAccessExpression(node) && isBody(node.expression)) {
			const key = node.argumentExpression;
			if (!ts.isStringLiteral(key) && !ts.isNoSubstitutionTemplateLiteral(key)) {
				found.uses.push(`${line(node)} reads a field of a body by a key that is not written out`);
			}
		}
		if ((ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && isBody(node.expression)) {
			found.uses.push(`${line(node)} spreads a body`);
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === 'Object' &&
			OBJECT_WALKS.includes(node.expression.name.text) &&
			node.arguments.some(isBody)
		) {
			found.uses.push(`${line(node)} hands a body to Object.${node.expression.name.text}`);
		}
		if (ts.isForInStatement(node) && isBody(node.expression)) {
			found.uses.push(`${line(node)} walks the fields of a body with for…in`);
		}
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && COERCIONS.includes(node.expression.text)) {
			const [value] = node.arguments;
			if (value && isFieldOfBody(value)) found.uses.push(`${line(node)} turns a field of a body into another type with ${node.expression.text}()`);
		}
		if (
			ts.isPrefixUnaryExpression(node) &&
			node.operator === ts.SyntaxKind.ExclamationToken &&
			ts.isPrefixUnaryExpression(node.operand) &&
			node.operand.operator === ts.SyntaxKind.ExclamationToken &&
			isFieldOfBody(node.operand.operand)
		) {
			found.uses.push(`${line(node)} turns a field of a body into a boolean with !!`);
		}
	}

	// A cast of a body, of a list of them, or of a field of either, in the function it was kept in or one inside it.
	for (const cast of casts) {
		let root = bare(cast.expression);
		while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = bare(root.expression);
		if (ts.isIdentifier(root) && (bodies.holds(root.text, cast) || lists.holds(root.text, cast))) {
			found.casts.push(`${line(cast)} casts what readBody or readObjects hands back, or a field of it`);
		}
	}
	return found;
}

describe('every handler reads its body through readBody', () => {
	/** Every body read, as `file how` → the lines it is on. */
	const reads = new Map<string, string[]>();
	const casts: string[] = [];
	const uses: string[] = [];
	let readBodyCalls = 0;
	for (const file of FILES) {
		const found = check(file, readFileSync(join(ROOT, file), 'utf8'));
		if (!READ_HERE.includes(file)) {
			for (const { at, how } of found.reads) reads.set(`${file} ${how}`, [...(reads.get(`${file} ${how}`) ?? []), at]);
		}
		casts.push(...found.casts);
		uses.push(...found.uses);
		readBodyCalls += found.readBodyCalls;
	}
	const fileOf = (read: string) => read.slice(0, read.lastIndexOf(' '));
	const howOf = (read: string) => read.slice(read.lastIndexOf(' ') + 1);
	const isJsonRead = (read: string) => JSON_READS.includes(howOf(read));

	it('in every route file and the server library, but the files still on STILL_READING and the reads on NOT_JSON', () => {
		const unlisted = [...reads]
			.filter(([read]) => !(isJsonRead(read) && fileOf(read) in STILL_READING) && !(read in NOT_JSON))
			.flatMap(([read, at]) => at.map((each) => `${each} ${howOf(read)}`));

		// Each line names the file, the line and the way of the read: read a JSON body with readBody(request).
		expect(unlisted).toEqual([]);
	});

	it('has nothing on STILL_READING that reads its body through readBody now', () => {
		const stillRead = new Set([...reads.keys()].filter(isJsonRead).map(fileOf));

		expect(Object.keys(STILL_READING).filter((file) => !stillRead.has(file))).toEqual([]);
	});

	it('has nothing on STILL_READING at all: every handler reads its body through readBody (card 2117, slice 4)', () => {
		expect(STILL_READING).toEqual({});
	});

	it('has nothing on NOT_JSON that no longer reads its body that way', () => {
		expect(Object.keys(NOT_JSON).filter((read) => !reads.has(read))).toEqual([]);
	});

	it('casts nothing readBody or readObjects hands back', () => {
		expect(casts).toEqual([]);
	});

	it('uses no field of a body in a way the type check cannot see: a key not written out, a spread, Object.keys, for…in, Number()', () => {
		expect(uses).toEqual([]);
	});

	it('was looked for in the whole tree', () => {
		expect(FILES).toContain('src/routes/api/v1/cards/[cardId]/+server.ts');
		expect(FILES).toContain('src/routes/api/requests/[id]/messages/+server.ts');
		expect(FILES).toContain('src/lib/server/request-body.ts');
		expect(FILES).toContain('src/lib/server/body-limits.ts');
		expect(FILES.length).toBeGreaterThanOrEqual(150);
		// Every entry on NOT_JSON is a read found, so the list itself shows the
		// parser sees a read; and with STILL_READING empty, the calls of
		// readBody show it sees them (R2's floor of 80).
		expect(reads.size).toBeGreaterThan(0);
		expect(readBodyCalls).toBeGreaterThanOrEqual(FEWEST_READ_BODY_CALLS);
	});
});

describe('the check itself', () => {
	const KIT = "import { error } from '@sveltejs/kit';\n";
	const of = (code: string) => check('example.ts', KIT + code);

	it.each<[string, string]>([
		['request.json()', 'export const POST = async ({ request }) => { const body = await request.json(); };'],
		['the request under another name (R2)', 'export const POST = async ({ request: req }) => { const body = await req.json(); };'],
		['the request read from the event', 'export const POST = async (event) => { const body = await event.request.json(); };'],
		['the request kept under another name', 'export const POST = async (event) => { const r = event.request; return r.json(); };'],
		['a clone of the request', 'export const POST = async ({ request }) => request.clone().json();'],
		['the body read as text, for JSON.parse', 'export const POST = async ({ request }) => JSON.parse(await request.text());'],
		['a function of the library given the request', 'export async function fields(request: Request) { return (await request.json()).a; }'],
		['a name given the type Request', 'export async function fields(req: Request) { return (await req.json()).a; }']
	])('finds a body read itself: %s', (_name, code) => {
		expect(of(code).reads).toEqual([{ at: 'example.ts:2', how: code.includes('.text()') ? 'text()' : 'json()' }]);
	});

	it.each<[string, string, string]>([
		['arrayBuffer()', 'export const POST = async ({ request }) => Buffer.from(await request.arrayBuffer());', 'arrayBuffer()'],
		['blob()', 'export const POST = async ({ request }) => { const b = await request.blob(); };', 'blob()'],
		['bytes()', 'export const POST = async ({ request }) => { const b = await request.bytes(); };', 'bytes()'],
		['formData()', "export const POST = async ({ request }) => (await request.formData()).get('file');", 'formData()'],
		['the stream', 'export const POST = async ({ request }) => { const reader = request.body.getReader(); };', '.body'],
		['the stream, handed to a new answer', 'export const POST = async ({ request }) => new Response(request.body);', '.body'],
		['the stream of a request kept under a name given the type', 'export function f(req: Request) { return req.body?.pipeThrough(x); }', '.body'],
		['a form from the event, under another name', 'export const POST = async (event) => { const r = event.request; return r.formData(); };', 'formData()']
	])('finds a body read any other way: %s', (_name, code, how) => {
		expect(of(code).reads).toEqual([{ at: 'example.ts:2', how }]);
	});

	it.each<[string, string]>([
		['the body read through readBody', 'export const POST = async ({ request }) => { const body = await readBody(request); };'],
		['an answer from fetch', 'export async function f() { const res = await fetch("x"); return res.json(); }'],
		['an answer called response', 'export async function f(response: Response) { return response.json(); }'],
		['json() of SvelteKit', 'export const GET = () => json({ a: 1 });'],
		['a file of a form', "export const POST = async ({ request }) => { const file = form.get('file'); return file.arrayBuffer(); };"],
		['the body of an answer', 'export async function f() { const res = await fetch("x"); return new Response(res.body); }'],
		['whether there is a body at all', 'export function f(request: Request) { if (request.body === null) return null; return request.body !== null; }']
	])('finds no read in %s', (_name, code) => {
		expect(of(code).reads).toEqual([]);
	});

	it.each<[string, string]>([
		['as', 'export const POST = async ({ request }) => { const body = (await readBody(request)) as { title: string }; };'],
		['as, without parentheses', 'export const POST = async ({ request }) => { const body = await readBody(request) as any; };'],
		['angle brackets', 'export const POST = async ({ request }) => { const body = <any>await readBody(request); };'],
		['a type written on the name', 'export const POST = async ({ request }) => { const body: { title: string } = await readBody(request); };'],
		['a field of it', 'export const POST = async ({ request }) => { const body = await readBody(request); const t = body.title as string; };'],
		['a field of it, by its name in brackets', "export const POST = async ({ request }) => { const body = await readBody(request); const t = body['title'] as string; };"],
		['the whole of it, later', 'export const POST = async ({ request }) => { const body = await readBody(request); use(body as Record<string, string>); };'],
		['a field of it, in a function inside', 'export const POST = async ({ request }) => { const body = await readBody(request); [1].map(() => body.a as number); };'],
		[
			'a field of an entry of readObjects',
			"export const POST = async ({ request }) => { const body = await readBody(request); for (const link of readObjects(body, 'links', {}) ?? []) use(link.blocked as number); };"
		],
		['what asObject hands back', 'export const POST = async ({ request }) => { const entry = asObject(x) as { id: number }; };'],
		['a field of what asObject hands back', 'export const POST = async ({ request }) => { const entry = asObject(x); if (entry) use(entry.id as number); };'],
		[
			'the list readObjects hands back',
			"export const POST = async ({ request }) => { const body = await readBody(request); const links = readObjects(body, 'links', {}) as { blocked: number }[]; };"
		]
	])('finds a cast of what readBody hands back: %s', (_name, code) => {
		expect(of(code).casts).toHaveLength(1);
	});

	/** In a handler that has read `body` with readBody and `links` with readObjects. */
	const handler = (code: string) =>
		`export const PUT = async ({ request }) => { const body = await readBody(request); const links = readObjects(body, 'links', {}) ?? []; ${code} };`;

	it.each<[string, string, string]>([
		[
			'the update that copies every field it allows, by a key not written out, as slices 2 to 4 will meet it',
			'const updateData: Record<string, unknown> = {}; for (const key of WRITABLE) if (key in body) updateData[key] = body[key];',
			'reads a field of a body by a key that is not written out'
		],
		['a key not written out, on readBody itself', 'const later = async (key) => (await readBody(request))[key];', 'reads a field of a body by a key that is not written out'],
		['a key not written out, on an entry in a loop', 'for (const link of links) copy[name] = link[name];', 'reads a field of a body by a key that is not written out'],
		['a key not written out, on an entry handed to map', 'links.map((link) => link[name]);', 'reads a field of a body by a key that is not written out'],
		['a key not written out, on an entry by its index', 'const first = links[0]; use(first[name]);', 'reads a field of a body by a key that is not written out'],
		['a key not written out, on an entry of the list as it is', 'use(links[i][name]);', 'reads a field of a body by a key that is not written out'],
		['a spread into an object', 'db.update(cards).set({ ...body });', 'spreads a body'],
		['a spread of an entry', 'for (const link of links) rows.push({ ...link });', 'spreads a body'],
		['a spread of what asObject hands back', 'const entry = asObject(chain[0]); if (entry) rows.push({ ...entry });', 'spreads a body'],
		['a spread into a call', 'use(...body);', 'spreads a body'],
		['a rest taken out of it', 'const { id, ...rest } = await readBody(request);', 'copies the fields of what readBody hands back with a rest (...)'],
		['Object.assign', 'Object.assign(row, body);', 'hands a body to Object.assign'],
		['Object.keys', 'Object.keys(body);', 'hands a body to Object.keys'],
		['Object.entries', 'Object.entries(body);', 'hands a body to Object.entries'],
		['Object.values, on an entry', 'links.forEach((link) => Object.values(link));', 'hands a body to Object.values'],
		['for…in', 'for (const key in body) copy.push(key);', 'walks the fields of a body with for…in'],
		['Number() of a field', 'const position = Number(body.position);', 'turns a field of a body into another type with Number()'],
		['Number() of a field with a default', 'const position = Number(body.position ?? 0);', 'turns a field of a body into another type with Number()'],
		['String() of a field by its name in brackets', "const title = String(body['title']);", 'turns a field of a body into another type with String()'],
		['Boolean() of a field', 'const pinned = Boolean(body.pinned);', 'turns a field of a body into another type with Boolean()'],
		['Number() of a field of an entry', 'for (const link of links) ids.push(Number(link.blocked));', 'turns a field of a body into another type with Number()'],
		['!! of a field', 'const pinned = !!body.pinned;', 'turns a field of a body into a boolean with !!']
	])('finds a use of a body that goes round the readers: %s', (_name, code, what) => {
		expect(of(handler(code)).uses).toEqual([`example.ts:2 ${what}`]);
	});

	it.each<[string, string]>([
		['a reader', "const title = readText(body, 'title', {});"],
		['a field by its name in brackets', "const title = readText({ title: body['title'] }, 'title', {});"],
		['whether a field was sent', "if ('title' in body) changed.push('title');"],
		['each entry handed to a reader', "for (const link of links) readId(link, 'blocked', {});"],
		['an entry by its index, handed to a reader', "for (let i = 0; i < links.length; i++) readId(links[i], 'blocked', {});"],
		['a copy of the list', 'const copy = [...links];'],
		['Number() of something else', 'const id = Number(params.id);'],
		['!! of something else', 'const has = !!links.length;'],
		['Object.keys of something else', 'Object.keys(other);']
	])('finds no use that goes round the readers in %s', (_name, code) => {
		expect(of(handler(code)).uses).toEqual([]);
	});

	it('finds no use of a name of the same spelling in another function', () => {
		const code = 'export const PUT = async ({ request }) => { const body = await readBody(request); }; export function f(body: Record<string, unknown>, key: string) { return Number(body[key]); }';
		expect(of(code).uses).toEqual([]);
	});

	it.each<[string, string]>([
		['a reader', "export const POST = async ({ request }) => { const body = await readBody(request); const t = readText(body, 'title', {}); };"],
		['its fields taken out by name', 'export const POST = async ({ request }) => { const { title } = await readBody(request); };'],
		['a cast of something else', 'export const POST = async ({ request }) => { const body = await readBody(request); const other = x as string; };'],
		['a name of the same spelling in another function', 'export const POST = async ({ request }) => { const body = await readBody(request); }; export function f(body: unknown) { return body as string; }']
	])('finds no cast in %s', (_name, code) => {
		expect(of(code).casts).toEqual([]);
	});

	it('counts the calls of readBody', () => {
		expect(of('export const POST = async ({ request }) => { await readBody(request); await readBody(request); };').readBodyCalls).toBe(2);
	});
});

// ─── The cases table: what each handler moved onto the readers refuses ──────

describe('the handlers card 2115 moved onto the readers', () => {
	/**
	 * Each refusal is a 400 that names the field, or the route's own words where
	 * a test or the API document quotes them, and changes nothing. Before, a
	 * field was stored as it was sent (`"false"` made a board public, any text
	 * became a member's or a share's role, `"top"` a column's position), or was
	 * a 500 (`.trim` of a number, an update with nothing to set).
	 */
	type World = {
		/** Owns board A, owns the team, wrote the comment. */
		owner: SessionUser;
		other: SessionUser;
		boardId: number;
		cardId: number;
		labelId: number;
		categoryId: number;
		groupingId: number;
		commentId: number;
		teamId: number;
		columnId: number;
		webhookId: number;
	};

	function world(): World {
		const owner = makeUser({ username: 'owner' });
		const other = makeUser({ username: 'other' });
		const A = makeBoard({ owner, name: 'A' });
		const card = makeCard(A.cols['To Do']);
		const team = makeTeam([owner]);
		db.update(teamMembers).set({ role: 'owner' }).where(eq(teamMembers.teamId, team.id)).run();
		return {
			owner,
			other,
			boardId: A.board.id,
			cardId: card.id,
			labelId: makeLabel(A.board, 'A label').id,
			categoryId: db.insert(categories).values({ boardId: A.board.id, name: 'A category' }).returning().get().id,
			groupingId: db.insert(boardCategories).values({ name: 'A grouping' }).returning().get().id,
			commentId: makeComment(card, owner, 'Said').id,
			teamId: team.id,
			columnId: A.cols['On Hold'].id,
			webhookId: makeWebhook(A.board).id
		};
	}

	beforeEach(resetDb);

	type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	type Case = [route: string, path: (w: World) => string, body: (w: World) => unknown, message: string];
	const EVENTS = 'card.created, card.updated, card.moved, card.completed, card.deleted, comment.added';
	const long = (n: number) => 'x'.repeat(n);
	// Card 2162: a colour is read with readColour, where card 2115 read it as text of 1 to 32.
	const COLOUR_RULE = 'color must be a colour written #rrggbb';

	const CASES: Case[] = [
		// PUT /api/teams/:id
		['PUT /api/teams/:id', (w) => `/api/teams/${w.teamId}`, () => ({}), 'No valid fields to update'],
		['PUT /api/teams/:id', (w) => `/api/teams/${w.teamId}`, () => ({ name: '  ' }), 'name cannot be empty'],
		['PUT /api/teams/:id', (w) => `/api/teams/${w.teamId}`, () => ({ name: 5 }), 'name must be text'],
		['PUT /api/teams/:id', (w) => `/api/teams/${w.teamId}`, () => ({ name: long(201) }), 'name must be at most 200 characters'],
		['PUT /api/teams/:id', (w) => `/api/teams/${w.teamId}`, () => ({ emoji: long(33) }), 'emoji must be at most 32 characters'],
		['PUT /api/teams/:id', () => '/api/teams/1.5', () => ({ name: 'x' }), 'Invalid team ID'],
		// POST /api/teams/:id/members/:userId
		['POST /api/teams/:id/members/:userId', (w) => `/api/teams/${w.teamId}/members/${w.other.id}`, (w) => ({ userId: w.owner.id }), 'userId must be the user in the path, or be left out'],
		['POST /api/teams/:id/members/:userId', (w) => `/api/teams/${w.teamId}/members/${w.other.id}`, () => ({ userId: 'someone' }), 'userId must be an id'],
		['POST /api/teams/:id/members/:userId', (w) => `/api/teams/${w.teamId}/members/${w.other.id}`, () => ({ role: 'admin' }), 'role must be one of: member, owner'],
		['POST /api/teams/:id/members/:userId', (w) => `/api/teams/${w.teamId}/members/0`, () => ({}), 'Invalid user ID'],
		// PUT /api/boards/:id
		['PUT /api/boards/:id', (w) => `/api/boards/${w.boardId}`, () => ({ name: '' }), 'name cannot be empty'],
		['PUT /api/boards/:id', (w) => `/api/boards/${w.boardId}`, () => ({ name: ['A'] }), 'name must be text'],
		['PUT /api/boards/:id', (w) => `/api/boards/${w.boardId}`, () => ({ emoji: '' }), 'emoji cannot be empty'],
		['PUT /api/boards/:id', (w) => `/api/boards/${w.boardId}`, () => ({ isPublic: 'false' }), 'isPublic must be true or false'],
		['PUT /api/boards/:id', (w) => `/api/boards/${w.boardId}`, () => ({ categoryId: 'none' }), 'categoryId must be an id'],
		['PUT /api/boards/:id', (w) => `/api/boards/${w.boardId}`, () => ({ parentCardId: 'a card' }), 'parentCardId must be an id'],
		// The share window's three requests.
		['POST /api/boards/:id/share', (w) => `/api/boards/${w.boardId}/share`, (w) => ({ type: 'group', targetId: w.other.id }), 'type must be "user" or "team"'],
		['POST /api/boards/:id/share', (w) => `/api/boards/${w.boardId}/share`, () => ({ type: 'user' }), 'targetId is required'],
		['POST /api/boards/:id/share', (w) => `/api/boards/${w.boardId}/share`, () => ({ type: 'user', targetId: 'x' }), 'targetId must be an id'],
		['POST /api/boards/:id/share', (w) => `/api/boards/${w.boardId}/share`, (w) => ({ type: 'user', targetId: w.other.id, role: 'owner' }), 'role must be one of: viewer, editor'],
		['POST /api/boards/:id/share', (w) => `/api/boards/${w.boardId}/share`, (w) => ({ type: 'team', targetId: w.teamId, role: 'admin' }), 'role must be one of: viewer, editor'],
		['PATCH /api/boards/:id/share', (w) => `/api/boards/${w.boardId}/share`, () => ({}), 'isPublic is required'],
		['PATCH /api/boards/:id/share', (w) => `/api/boards/${w.boardId}/share`, () => ({ isPublic: 'false' }), 'isPublic must be true or false'],
		['DELETE /api/boards/:id/share', (w) => `/api/boards/${w.boardId}/share`, (w) => ({ type: 'everyone', targetId: w.other.id }), 'type must be "user" or "team"'],
		['DELETE /api/boards/:id/share', (w) => `/api/boards/${w.boardId}/share`, () => ({ type: 'user', targetId: 0 }), 'targetId must be an id'],
		// The two category routes of the web application.
		['PUT /api/categories/:id', (w) => `/api/categories/${w.categoryId}`, () => ({}), 'No valid fields to update'],
		['PUT /api/categories/:id', (w) => `/api/categories/${w.categoryId}`, () => ({ name: ' ' }), 'name cannot be empty'],
		['PUT /api/categories/:id', (w) => `/api/categories/${w.categoryId}`, () => ({ color: long(33) }), COLOUR_RULE],
		['PUT /api/board-categories/:id', (w) => `/api/board-categories/${w.groupingId}`, () => ({}), 'No valid fields to update'],
		['PUT /api/board-categories/:id', (w) => `/api/board-categories/${w.groupingId}`, () => ({ name: 7 }), 'name must be text'],
		['PUT /api/board-categories/:id', (w) => `/api/board-categories/${w.groupingId}`, () => ({ color: null }), COLOUR_RULE],
		// PUT /api/cards/:id/comments/:commentId
		['PUT /api/cards/:id/comments/:commentId', (w) => `/api/cards/${w.cardId}/comments/${w.commentId}`, () => ({}), 'Comment cannot be empty'],
		['PUT /api/cards/:id/comments/:commentId', (w) => `/api/cards/${w.cardId}/comments/${w.commentId}`, () => ({ content: '   ' }), 'Comment cannot be empty'],
		['PUT /api/cards/:id/comments/:commentId', (w) => `/api/cards/${w.cardId}/comments/${w.commentId}`, () => ({ content: 5 }), 'content must be text'],
		['PUT /api/cards/:id/comments/:commentId', (w) => `/api/cards/${w.cardId}/comments/${w.commentId}`, () => ({ content: long(50001) }), 'content must be at most 50000 characters'],
		['PUT /api/cards/:id/comments/:commentId', (w) => `/api/cards/${w.cardId}/comments/x`, () => ({ content: 'x' }), 'Invalid comment ID'],
		// The three things a key creates on a board.
		['POST /api/v1/boards/:boardId/columns', (w) => `/api/v1/boards/${w.boardId}/columns`, () => ({}), 'title is required'],
		['POST /api/v1/boards/:boardId/columns', (w) => `/api/v1/boards/${w.boardId}/columns`, () => ({ title: '  ' }), 'title is required'],
		['POST /api/v1/boards/:boardId/columns', (w) => `/api/v1/boards/${w.boardId}/columns`, () => ({ title: 5 }), 'title must be text'],
		['POST /api/v1/boards/:boardId/columns', (w) => `/api/v1/boards/${w.boardId}/columns`, () => ({ title: long(201) }), 'title must be at most 200 characters'],
		['POST /api/v1/boards/:boardId/columns', (w) => `/api/v1/boards/${w.boardId}/columns`, () => ({ title: 'Review', position: 'top' }), 'position must be a number'],
		['POST /api/v1/boards/:boardId/columns', (w) => `/api/v1/boards/${w.boardId}/columns`, () => ({ title: 'Review', color: '' }), COLOUR_RULE],
		['POST /api/v1/boards/:boardId/columns', () => '/api/v1/boards/1e3/columns', () => ({ title: 'Review' }), 'Invalid board ID'],
		['POST /api/v1/boards/:boardId/labels', (w) => `/api/v1/boards/${w.boardId}/labels`, () => ({}), 'name is required'],
		['POST /api/v1/boards/:boardId/labels', (w) => `/api/v1/boards/${w.boardId}/labels`, () => ({ name: long(201) }), 'name must be at most 200 characters'],
		['POST /api/v1/boards/:boardId/labels', (w) => `/api/v1/boards/${w.boardId}/labels`, () => ({ name: 'Urgent', color: 3 }), COLOUR_RULE],
		['POST /api/v1/boards/:boardId/categories', (w) => `/api/v1/boards/${w.boardId}/categories`, () => ({ name: '' }), 'name is required'],
		['POST /api/v1/boards/:boardId/categories', (w) => `/api/v1/boards/${w.boardId}/categories`, () => ({ name: long(201) }), 'name must be at most 200 characters'],
		['POST /api/v1/boards/:boardId/categories', (w) => `/api/v1/boards/${w.boardId}/categories`, () => ({ name: { text: 'Bug' } }), 'name must be text'],
		// POST /api/v1/boards/:boardId/webhooks
		['POST /api/v1/boards/:boardId/webhooks', (w) => `/api/v1/boards/${w.boardId}/webhooks`, () => ({}), 'URL is required'],
		['POST /api/v1/boards/:boardId/webhooks', (w) => `/api/v1/boards/${w.boardId}/webhooks`, () => ({ url: 'ftp://hooks.example.test' }), 'url must be an http or https address'],
		['POST /api/v1/boards/:boardId/webhooks', (w) => `/api/v1/boards/${w.boardId}/webhooks`, () => ({ url: 'https://hooks.example.test', events: 'card.created' }), 'events must be a list'],
		['POST /api/v1/boards/:boardId/webhooks', (w) => `/api/v1/boards/${w.boardId}/webhooks`, () => ({ url: 'https://hooks.example.test', events: null }), 'events must be a list'],
		['POST /api/v1/boards/:boardId/webhooks', (w) => `/api/v1/boards/${w.boardId}/webhooks`, () => ({ url: 'https://hooks.example.test', events: ['card.moved', 'card.archived'] }), `events[1] must be one of: ${EVENTS}`],
		['POST /api/v1/boards/:boardId/webhooks', (w) => `/api/v1/boards/${w.boardId}/webhooks`, () => ({ url: 'https://hooks.example.test', secret: long(257) }), 'secret must be at most 256 characters'],
		// A label on a card.
		['POST /api/v1/cards/:cardId/labels', (w) => `/api/v1/cards/${w.cardId}/labels`, () => ({}), 'labelId is required'],
		['POST /api/v1/cards/:cardId/labels', (w) => `/api/v1/cards/${w.cardId}/labels`, () => ({ labelId: 0 }), 'labelId must be an id'],
		['POST /api/v1/cards/:cardId/labels', (w) => `/api/v1/cards/${w.cardId}/labels`, () => ({ labelId: true }), 'labelId must be an id'],
		['DELETE /api/v1/cards/:cardId/labels', (w) => `/api/v1/cards/${w.cardId}/labels`, () => ({}), 'labelId is required'],
		['DELETE /api/v1/cards/:cardId/labels', (w) => `/api/v1/cards/${w.cardId}/labels`, (w) => ({ labelId: [w.labelId] }), 'labelId must be an id'],
		['DELETE /api/v1/cards/:cardId/labels', () => '/api/v1/cards/-1/labels', (w) => ({ labelId: w.labelId }), 'Invalid card ID'],
		// The five things a key updates.
		['PUT /api/v1/labels/:labelId', (w) => `/api/v1/labels/${w.labelId}`, () => ({}), 'No valid fields to update'],
		['PUT /api/v1/labels/:labelId', (w) => `/api/v1/labels/${w.labelId}`, () => ({ name: '' }), 'name cannot be empty'],
		['PUT /api/v1/labels/:labelId', (w) => `/api/v1/labels/${w.labelId}`, () => ({ name: long(201) }), 'name must be at most 200 characters'],
		['PUT /api/v1/labels/:labelId', (w) => `/api/v1/labels/${w.labelId}`, () => ({ color: null }), COLOUR_RULE],
		['PUT /api/v1/labels/:labelId', () => '/api/v1/labels/1.5', () => ({ name: 'x' }), 'Invalid label ID'],
		['PUT /api/v1/categories/:categoryId', (w) => `/api/v1/categories/${w.categoryId}`, () => ({ name: '' }), 'name cannot be empty'],
		['PUT /api/v1/categories/:categoryId', (w) => `/api/v1/categories/${w.categoryId}`, () => ({ name: long(201) }), 'name must be at most 200 characters'],
		['PUT /api/v1/categories/:categoryId', (w) => `/api/v1/categories/${w.categoryId}`, () => ({ color: 9 }), COLOUR_RULE],
		['PUT /api/v1/board-categories/:categoryId', (w) => `/api/v1/board-categories/${w.groupingId}`, () => ({ name: ' ' }), 'name cannot be empty'],
		['PUT /api/v1/board-categories/:categoryId', (w) => `/api/v1/board-categories/${w.groupingId}`, () => ({ name: long(201) }), 'name must be at most 200 characters'],
		['PUT /api/v1/board-categories/:categoryId', (w) => `/api/v1/board-categories/${w.groupingId}`, () => ({}), 'No valid fields to update'],
		['PUT /api/v1/columns/:columnId', (w) => `/api/v1/columns/${w.columnId}`, () => ({}), 'No valid fields to update'],
		['PUT /api/v1/columns/:columnId', (w) => `/api/v1/columns/${w.columnId}`, () => ({ title: '' }), 'title cannot be empty'],
		['PUT /api/v1/columns/:columnId', (w) => `/api/v1/columns/${w.columnId}`, () => ({ title: long(201) }), 'title must be at most 200 characters'],
		['PUT /api/v1/columns/:columnId', (w) => `/api/v1/columns/${w.columnId}`, () => ({ position: 'top' }), 'position must be a number'],
		['PUT /api/v1/columns/:columnId', (w) => `/api/v1/columns/${w.columnId}`, () => ({ showAddCard: 'false' }), 'showAddCard must be true or false'],
		['PUT /api/v1/webhooks/:webhookId', (w) => `/api/v1/webhooks/${w.webhookId}`, () => ({}), 'No fields to update'],
		['PUT /api/v1/webhooks/:webhookId', (w) => `/api/v1/webhooks/${w.webhookId}`, () => ({ url: '' }), 'url must be an http or https address'],
		['PUT /api/v1/webhooks/:webhookId', (w) => `/api/v1/webhooks/${w.webhookId}`, () => ({ url: 'javascript:alert(1)' }), 'url must be an http or https address'],
		['PUT /api/v1/webhooks/:webhookId', (w) => `/api/v1/webhooks/${w.webhookId}`, () => ({ events: [' card.moved ', 'everything'] }), `events[1] must be one of: ${EVENTS}`],
		['PUT /api/v1/webhooks/:webhookId', (w) => `/api/v1/webhooks/${w.webhookId}`, () => ({ active: 'false' }), 'active must be true or false'],
		['PUT /api/v1/webhooks/:webhookId', () => '/api/v1/webhooks/abc', () => ({ active: false }), 'Invalid webhook ID']
	];

	// The twenty-first, the report schedule, is in tests/internal-refusals.test.ts.
	it('has cases for each of the other 20 handlers', () => {
		expect(new Set(CASES.map(([route]) => route)).size).toBe(20);
	});

	it.each(CASES)('%s refuses what it cannot use (%#)', async (route, path, body, message) => {
		const w = world();
		const method = route.split(' ')[0] as Method;
		const before = snapshotDb();

		const res = await api(method, path(w), { user: w.owner, body: body(w) });

		expect(res.status).toBe(400);
		expect(res.body).toEqual({ message });
		expectUnchanged(before);
	});

	it('answers 404 for an id in the body or the path that names nothing, and for a label not on the card', async () => {
		const w = world();
		const before = snapshotDb();
		const refused = async (method: Method, path: string, body: unknown) => {
			const res: ApiResult = await api(method, path, { user: w.owner, body });
			expect(res.status, path).toBe(404);
			return res.body.message;
		};

		expect(await refused('PUT', `/api/boards/${w.boardId}`, { categoryId: 99999 })).toBe('Board category not found');
		expect(await refused('POST', `/api/teams/${w.teamId}/members/99999`, {})).toBe('User not found');
		expect(await refused('POST', `/api/v1/cards/${w.cardId}/labels`, { labelId: 99999 })).toBe('Label not found');
		// It was 200, as if the label had been taken off.
		expect(await refused('DELETE', `/api/v1/cards/${w.cardId}/labels`, { labelId: w.labelId })).toBe('Label not found on this card');
		expectUnchanged(before);
	});

	it('keeps what the row holds when it is sent back unchanged, whatever the rules say of it', async () => {
		const w = world();
		// Stored before the rules: a colour longer than 32, a share role of owner, a member's role of its own.
		db.update(labels).set({ color: long(40) }).run();
		addBoardMember(db.select().from(boards).get()!, w.other, 'owner');
		db.insert(teamMembers).values({ teamId: w.teamId, userId: w.other.id, role: 'lead' }).run();

		const label = await api('PUT', `/api/v1/labels/${w.labelId}`, { user: w.owner, body: { name: 'Renamed', color: long(40) } });
		expect(label.status).toBe(200);
		expect(label.body).toMatchObject({ name: 'Renamed', color: long(40) });

		const share = await api('POST', `/api/boards/${w.boardId}/share`, { user: w.owner, body: { type: 'user', targetId: w.other.id, role: 'owner' } });
		expect(share.status).toBe(200);

		const member = await api('POST', `/api/teams/${w.teamId}/members/${w.other.id}`, { user: w.owner, body: { userId: w.other.id, role: 'lead' } });
		expect(member.status, JSON.stringify(member.body)).toBe(200);
	});

	it('reads what the rules allow as they say: trimmed, a number written as text, the user in the path, null for none', async () => {
		const w = world();

		await api('PUT', `/api/boards/${w.boardId}`, { user: w.owner, body: { name: '  Roadmap  ', categoryId: w.groupingId } });
		expect(db.select({ name: boards.name, categoryId: boards.categoryId }).from(boards).get()).toEqual({ name: 'Roadmap', categoryId: w.groupingId });
		await api('PUT', `/api/boards/${w.boardId}`, { user: w.owner, body: { categoryId: null } });
		expect(db.select({ categoryId: boards.categoryId }).from(boards).get()).toEqual({ categoryId: null });

		const column = await api('POST', `/api/v1/boards/${w.boardId}/columns`, { user: w.owner, body: { title: 'Review', position: '2.5' } });
		expect(column.status).toBe(201);
		expect(db.select({ position: columns.position }).from(columns).where(eq(columns.id, column.body.id)).get()).toEqual({ position: 2.5 });

		// The wrapper sends `-Events "card.created, card.moved"` split on the commas.
		const hook = await api('POST', `/api/v1/boards/${w.boardId}/webhooks`, {
			user: w.owner,
			body: { url: ' https://hooks.example.test/x ', events: ['card.created', ' card.moved'] }
		});
		expect(hook.status).toBe(201);
		expect(db.select({ url: webhooks.url, events: webhooks.events }).from(webhooks).where(eq(webhooks.id, hook.body.id)).get()).toEqual({
			url: 'https://hooks.example.test/x',
			events: '["card.created","card.moved"]'
		});

		// No userId in the body: the user in the path is the one added.
		const added = await api('POST', `/api/teams/${w.teamId}/members/${w.other.id}`, { user: w.owner, body: {} });
		expect(added.status).toBe(201);
		expect(
			db.select({ role: teamMembers.role }).from(teamMembers).where(and(eq(teamMembers.teamId, w.teamId), eq(teamMembers.userId, w.other.id))).get()
		).toEqual({ role: 'member' });

		const shared = await api('POST', `/api/boards/${w.boardId}/share`, { user: w.owner, body: { type: 'user', targetId: String(w.other.id) } });
		expect(shared.status).toBe(200);
		expect(
			db.select({ role: boardMembers.role }).from(boardMembers).where(and(eq(boardMembers.boardId, w.boardId), eq(boardMembers.userId, w.other.id))).get()
		).toEqual({ role: 'viewer' });
	});
});

describe('a new comment, in both trees, read as an edit is (card 2115’s review)', () => {
	// An edit of a comment was held to 50,000 characters; a new one had no
	// limit at all, and content that was not text was a 500. Both are read by
	// `readText` now, with the edit's rule.
	beforeEach(resetDb);

	const ROUTES = ['/api/cards/:id/comments', '/api/v1/cards/:id/comments'];
	const post = (route: string, who: SessionUser, cardId: number, body: unknown) =>
		api('POST', route.replace(':id', String(cardId)), { user: who, body });
	const world = () => {
		const owner = makeUser({ username: 'owner' });
		const A = makeBoard({ owner, name: 'A' });
		return { owner, cardId: makeCard(A.cols['To Do']).id };
	};

	it.each(ROUTES)('POST %s refuses what it cannot use, and saves nothing', async (route) => {
		const w = world();
		const before = snapshotDb();
		const said = async (body: unknown) => {
			const res: ApiResult = await post(route, w.owner, w.cardId, body);
			expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
			return res.body.message;
		};

		expect(await said({ content: 'x'.repeat(50001) })).toBe('content must be at most 50000 characters');
		// Counted once trimmed, as an edit is.
		expect(await said({ content: `  ${'x'.repeat(50001)}  ` })).toBe('content must be at most 50000 characters');
		expect(await said({ content: 5 })).toBe('content must be text');
		expect(await said({ content: ['Done'] })).toBe('content must be text');
		expect(await said({ content: '   ' })).toBe('Comment cannot be empty');
		expect(await said({})).toBe('Comment cannot be empty');
		expectUnchanged(before);
	});

	it.each(ROUTES)('POST %s takes 50,000 characters, trimmed', async (route) => {
		const w = world();

		const res = await post(route, w.owner, w.cardId, { content: ` ${'x'.repeat(50000)} ` });

		expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(201);
		expect(db.select({ content: cardComments.content }).from(cardComments).get()!.content).toBe('x'.repeat(50000));
	});
});

// ─── Card 2117, slice 2: the handlers of /api/v1/ ────────────────────────────

describe('the handlers of /api/v1/ that card 2117’s second slice moved onto the readers', () => {
	/**
	 * Each refusal is a 400 that names the field, or the route's own words where
	 * a test or the API document quotes them, and changes nothing. Before, a
	 * field was stored as it was sent (`"urgent"` as a priority, any text as a
	 * due date or an archive stamp, `"top"` as a position, `"false"` as true),
	 * or was a 500 (`.trim` of a number, a `null` entry of a batch).
	 */
	type World = {
		/** Owns boards A and B: may edit both. */
		owner: SessionUser;
		/** May open neither board. */
		outsider: SessionUser;
		admin: SessionUser;
		boardId: number;
		columnId: number;
		cardId: number;
		subtaskId: number;
		commentId: number;
		/** Board A's, with the card in it. */
		milestoneId: number;
		/** A category of board A, one of board B, and one of no board. */
		categoryId: number;
		otherCategoryId: number;
		sharedCategoryId: number;
	};

	function world(): World {
		const owner = makeUser({ username: 'owner' });
		const outsider = makeUser({ username: 'outsider' });
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const A = makeBoard({ owner, name: 'A' });
		const B = makeBoard({ owner, name: 'B' });
		const card = makeCard(A.cols['To Do']);
		const category = (boardId: number | null, name: string) => db.insert(categories).values({ boardId, name }).returning().get().id;
		return {
			owner,
			outsider,
			admin,
			boardId: A.board.id,
			columnId: A.cols['To Do'].id,
			cardId: card.id,
			subtaskId: makeSubtask(card, { position: 1 }).id,
			commentId: makeComment(card, owner, 'Said').id,
			milestoneId: makeMilestone({ board: A.board, createdBy: owner, cards: [card] }).id,
			categoryId: category(A.board.id, 'A category'),
			otherCategoryId: category(B.board.id, 'B category'),
			sharedCategoryId: category(null, 'Shared category')
		};
	}

	beforeEach(resetDb);

	type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	type Case = [route: string, path: (w: World) => string, body: (w: World) => unknown, message: string];
	const long = (n: number) => 'x'.repeat(n);
	const PRIORITY = 'priority must be one of: low, medium, high, critical';
	const ARCHIVE = 'archivedAt may only be null, which restores the card. Archive a card with DELETE /cards/{cardId}';
	const card = (w: World, more: object = {}) => ({ columnId: w.columnId, title: 'Raised', ...more });
	const cards_ = (w: World) => `/api/v1/boards/${w.boardId}/cards`;

	const CASES: Case[] = [
		// POST /api/v1/boards: a board has no row to guard, so its fields are read first.
		['POST /api/v1/boards', () => '/api/v1/boards', () => ({}), 'name is required'],
		['POST /api/v1/boards', () => '/api/v1/boards', () => ({ name: 5 }), 'name must be text'],
		['POST /api/v1/boards', () => '/api/v1/boards', () => ({ name: long(201) }), 'name must be at most 200 characters'],
		['POST /api/v1/boards', () => '/api/v1/boards', () => ({ name: 'Roadmap', emoji: '' }), 'emoji cannot be empty'],
		['POST /api/v1/boards', () => '/api/v1/boards', () => ({ name: 'Roadmap', parentCardId: 'a card' }), 'parentCardId must be an id'],
		// PUT /api/v1/boards/:boardId
		['PUT /api/v1/boards/:boardId', (w) => `/api/v1/boards/${w.boardId}`, () => ({ name: ['A'] }), 'name must be text'],
		['PUT /api/v1/boards/:boardId', (w) => `/api/v1/boards/${w.boardId}`, () => ({ name: '  ' }), 'name cannot be empty'],
		['PUT /api/v1/boards/:boardId', (w) => `/api/v1/boards/${w.boardId}`, () => ({ name: long(201) }), 'name must be at most 200 characters'],
		['PUT /api/v1/boards/:boardId', (w) => `/api/v1/boards/${w.boardId}`, () => ({ emoji: long(33) }), 'emoji must be at most 32 characters'],
		['PUT /api/v1/boards/:boardId', (w) => `/api/v1/boards/${w.boardId}`, () => ({ categoryId: 1.5 }), 'categoryId must be an id'],
		['PUT /api/v1/boards/:boardId', (w) => `/api/v1/boards/${w.boardId}`, () => ({ isPublic: 'true' }), 'isPublic must be true or false'],
		['PUT /api/v1/boards/:boardId', () => '/api/v1/boards/1.5', () => ({ name: 'x' }), 'Invalid board ID'],
		// POST /api/v1/board-categories
		['POST /api/v1/board-categories', () => '/api/v1/board-categories', () => ({}), 'name is required'],
		['POST /api/v1/board-categories', () => '/api/v1/board-categories', () => ({ name: { text: 'G' } }), 'name must be text'],
		['POST /api/v1/board-categories', () => '/api/v1/board-categories', () => ({ name: long(201) }), 'name must be at most 200 characters'],
		['POST /api/v1/board-categories', () => '/api/v1/board-categories', () => ({ name: 'G', color: 'red' }), 'color must be a colour written #rrggbb'],
		['POST /api/v1/board-categories', () => '/api/v1/board-categories', () => ({ name: 'G', color: '#fff' }), 'color must be a colour written #rrggbb'],
		// POST /api/v1/boards/:boardId/cards
		['POST /api/v1/boards/:boardId/cards', cards_, () => ({ title: 'Raised' }), 'columnId is required'],
		['POST /api/v1/boards/:boardId/cards', cards_, () => ({ columnId: 'one', title: 'Raised' }), 'columnId must be an id'],
		['POST /api/v1/boards/:boardId/cards', cards_, (w) => card(w, { title: 5 }), 'title must be text'],
		['POST /api/v1/boards/:boardId/cards', cards_, (w) => card(w, { title: long(501) }), 'title must be at most 500 characters'],
		['POST /api/v1/boards/:boardId/cards', cards_, (w) => card(w, { description: 5 }), 'description must be text'],
		['POST /api/v1/boards/:boardId/cards', cards_, (w) => card(w, { description: long(50001) }), 'description must be at most 50000 characters'],
		['POST /api/v1/boards/:boardId/cards', cards_, (w) => card(w, { priority: 'urgent' }), PRIORITY],
		['POST /api/v1/boards/:boardId/cards', cards_, (w) => card(w, { dueDate: '2026-02-30' }), 'dueDate must be a date written YYYY-MM-DD'],
		['POST /api/v1/boards/:boardId/cards', cards_, (w) => card(w, { colorTag: 'red;background:url(//x.io)' }), 'colorTag must be a colour written #rrggbb, or empty'],
		['POST /api/v1/boards/:boardId/cards', cards_, (w) => card(w, { position: 'top' }), 'position must be a number'],
		['POST /api/v1/boards/:boardId/cards', cards_, (w) => card(w, { businessValue: long(10001) }), 'businessValue must be at most 10000 characters'],
		['POST /api/v1/boards/:boardId/cards', cards_, (w) => card(w, { categoryId: 0 }), 'categoryId must be an id'],
		// The reporting fields answer their own 400, where the handler turned an error of theirs into one.
		['POST /api/v1/boards/:boardId/cards', cards_, (w) => card(w, { summary: 5 }), 'summary must be a string or null'],
		// PUT /api/v1/cards/:cardId
		['PUT /api/v1/cards/:cardId', (w) => `/api/v1/cards/${w.cardId}`, () => ({ title: '' }), 'title cannot be empty'],
		['PUT /api/v1/cards/:cardId', (w) => `/api/v1/cards/${w.cardId}`, () => ({ title: 5 }), 'title must be text'],
		['PUT /api/v1/cards/:cardId', (w) => `/api/v1/cards/${w.cardId}`, () => ({ description: null }), 'description must be text'],
		['PUT /api/v1/cards/:cardId', (w) => `/api/v1/cards/${w.cardId}`, () => ({ priority: 'urgent' }), PRIORITY],
		['PUT /api/v1/cards/:cardId', (w) => `/api/v1/cards/${w.cardId}`, () => ({ pinned: 'false' }), 'pinned must be true or false'],
		['PUT /api/v1/cards/:cardId', (w) => `/api/v1/cards/${w.cardId}`, () => ({ dueDate: '14/10/2026' }), 'dueDate must be a date written YYYY-MM-DD'],
		['PUT /api/v1/cards/:cardId', (w) => `/api/v1/cards/${w.cardId}`, () => ({ colorTag: '#fff' }), 'colorTag must be a colour written #rrggbb, or empty'],
		['PUT /api/v1/cards/:cardId', (w) => `/api/v1/cards/${w.cardId}`, () => ({ onHoldNote: 5 }), 'onHoldNote must be text'],
		// A cover is a colour or a preset gradient (card 2010, decision 14), where card 2117 read it as text of up to 2048.
		['PUT /api/v1/cards/:cardId', (w) => `/api/v1/cards/${w.cardId}`, () => ({ coverUrl: long(2049) }), 'coverUrl must be a colour written #rrggbb, one of the preset gradients, or null'],
		['PUT /api/v1/cards/:cardId', (w) => `/api/v1/cards/${w.cardId}`, () => ({ milestoneId: 'next' }), 'milestoneId must be an id'],
		['PUT /api/v1/cards/:cardId', (w) => `/api/v1/cards/${w.cardId}`, () => ({ archivedAt: '2026-01-01T00:00:00Z' }), ARCHIVE],
		['PUT /api/v1/cards/:cardId', (w) => `/api/v1/cards/${w.cardId}`, () => ({ archivedAt: 'banana' }), ARCHIVE],
		['PUT /api/v1/cards/:cardId', () => '/api/v1/cards/1e3', () => ({ title: 'x' }), 'Invalid card ID'],
		// PUT /api/v1/cards/:cardId/move
		['PUT /api/v1/cards/:cardId/move', (w) => `/api/v1/cards/${w.cardId}/move`, () => ({}), 'columnId is required'],
		['PUT /api/v1/cards/:cardId/move', (w) => `/api/v1/cards/${w.cardId}/move`, () => ({ columnId: [1] }), 'columnId must be an id'],
		['PUT /api/v1/cards/:cardId/move', (w) => `/api/v1/cards/${w.cardId}/move`, (w) => ({ columnId: w.columnId, position: 'top' }), 'position must be a number'],
		// The assignees of a card.
		['POST /api/v1/cards/:cardId/assignees', (w) => `/api/v1/cards/${w.cardId}/assignees`, () => ({}), 'userId is required'],
		['POST /api/v1/cards/:cardId/assignees', (w) => `/api/v1/cards/${w.cardId}/assignees`, () => ({ userId: 'someone' }), 'userId must be an id'],
		['DELETE /api/v1/cards/:cardId/assignees', (w) => `/api/v1/cards/${w.cardId}/assignees`, () => ({ userId: 0 }), 'userId must be an id'],
		// The subtasks.
		['POST /api/v1/cards/:cardId/subtasks', (w) => `/api/v1/cards/${w.cardId}/subtasks`, () => ({ title: ' ' }), 'title is required'],
		['POST /api/v1/cards/:cardId/subtasks', (w) => `/api/v1/cards/${w.cardId}/subtasks`, () => ({ title: 'A step', priority: 'urgent' }), PRIORITY],
		['POST /api/v1/cards/:cardId/subtasks', (w) => `/api/v1/cards/${w.cardId}/subtasks`, () => ({ title: 'A step', colorTag: 'red' }), 'colorTag must be a colour written #rrggbb, or empty'],
		['POST /api/v1/cards/:cardId/subtasks', (w) => `/api/v1/cards/${w.cardId}/subtasks`, () => ({ title: 'A step', dueDate: 'tomorrow' }), 'dueDate must be a date written YYYY-MM-DD'],
		['PUT /api/v1/subtasks/:subtaskId', (w) => `/api/v1/subtasks/${w.subtaskId}`, () => ({}), 'No valid fields to update'],
		['PUT /api/v1/subtasks/:subtaskId', (w) => `/api/v1/subtasks/${w.subtaskId}`, () => ({ completed: 'false' }), 'completed must be true or false'],
		['PUT /api/v1/subtasks/:subtaskId', (w) => `/api/v1/subtasks/${w.subtaskId}`, () => ({ title: '' }), 'title cannot be empty'],
		['PUT /api/v1/subtasks/:subtaskId', (w) => `/api/v1/subtasks/${w.subtaskId}`, () => ({ title: long(501) }), 'title must be at most 500 characters'],
		['PUT /api/v1/subtasks/:subtaskId', (w) => `/api/v1/subtasks/${w.subtaskId}`, () => ({ position: 'top' }), 'position must be a number'],
		['PUT /api/v1/subtasks/:subtaskId', (w) => `/api/v1/subtasks/${w.subtaskId}`, () => ({ priority: 'urgent' }), PRIORITY],
		// PUT /api/v1/comments/:commentId
		['PUT /api/v1/comments/:commentId', (w) => `/api/v1/comments/${w.commentId}`, () => ({ content: 5 }), 'content must be text'],
		['PUT /api/v1/comments/:commentId', (w) => `/api/v1/comments/${w.commentId}`, () => ({ content: ' ' }), 'Comment cannot be empty'],
		['PUT /api/v1/comments/:commentId', (w) => `/api/v1/comments/${w.commentId}`, () => ({ content: long(50001) }), 'content must be at most 50000 characters'],
		// The dependency batch: an entry that is not an object, and a kind that is no kind (decision 18).
		['POST /api/v1/dependencies/bulk', () => '/api/v1/dependencies/bulk', () => ({ links: [null] }), 'links[0] must be an object'],
		['POST /api/v1/dependencies/bulk', () => '/api/v1/dependencies/bulk', (w) => ({ links: [{ blocked: w.cardId, blocker: w.cardId }, 7] }), 'links[1] must be an object'],
		[
			'POST /api/v1/dependencies/bulk',
			() => '/api/v1/dependencies/bulk',
			(w) => ({ links: [{ blocked: w.cardId, blocker: w.subtaskId, blockerType: 'board' }] }),
			'links[0].blockerType must be one of: card, subtask'
		],
		['POST /api/v1/dependencies/bulk', () => '/api/v1/dependencies/bulk', () => ({ links: 'all of them' }), 'links must be a list'],
		['POST /api/v1/dependencies/bulk', () => '/api/v1/dependencies/bulk', () => ({ links: [] }), 'links is empty'],
		// The milestones.
		['POST /api/v1/milestones', () => '/api/v1/milestones', () => ({ name: 5 }), 'name must be text'],
		['POST /api/v1/milestones', () => '/api/v1/milestones', () => ({ name: long(201) }), 'name must be at most 200 characters'],
		['POST /api/v1/milestones', () => '/api/v1/milestones', () => ({ name: 'Ship it', targetDate: 'soon' }), 'targetDate must be a date written YYYY-MM-DD'],
		['POST /api/v1/milestones', () => '/api/v1/milestones', () => ({ name: 'Ship it', boardId: 'A' }), 'boardId must be an id'],
		['POST /api/v1/milestones', () => '/api/v1/milestones', () => ({ name: 'Ship it', description: 7 }), 'description must be text'],
		['PATCH /api/v1/milestones/:milestoneId', (w) => `/api/v1/milestones/${w.milestoneId}`, () => ({ name: null }), 'name must be text'],
		['PATCH /api/v1/milestones/:milestoneId', (w) => `/api/v1/milestones/${w.milestoneId}`, () => ({ name: long(201) }), 'name must be at most 200 characters'],
		['PATCH /api/v1/milestones/:milestoneId', (w) => `/api/v1/milestones/${w.milestoneId}`, () => ({ status: 'done' }), 'status must be open or closed'],
		['PATCH /api/v1/milestones/:milestoneId', (w) => `/api/v1/milestones/${w.milestoneId}`, () => ({ targetDate: '2026-13-01' }), 'targetDate must be a date written YYYY-MM-DD'],
		['PATCH /api/v1/milestones/:milestoneId', (w) => `/api/v1/milestones/${w.milestoneId}`, () => ({ boardId: 1.5 }), 'boardId must be an id'],
		['POST /api/v1/milestones/:milestoneId/cards', (w) => `/api/v1/milestones/${w.milestoneId}/cards`, () => ({}), 'cardId is required'],
		['POST /api/v1/milestones/:milestoneId/cards', (w) => `/api/v1/milestones/${w.milestoneId}/cards`, () => ({ cardId: 'x' }), 'cardId must be an id'],
		['DELETE /api/v1/milestones/:milestoneId/cards', (w) => `/api/v1/milestones/${w.milestoneId}/cards`, () => ({ cardId: null }), 'cardId must be an id'],
		['POST /api/v1/milestones/:milestoneId/cards/bulk', (w) => `/api/v1/milestones/${w.milestoneId}/cards/bulk`, (w) => ({ cardIds: [w.cardId, null] }), 'cardIds[1] must be an id'],
		['POST /api/v1/milestones/:milestoneId/cards/bulk', (w) => `/api/v1/milestones/${w.milestoneId}/cards/bulk`, () => ({ cardIds: 'all' }), 'cardIds must be an array of card ids'],
		['DELETE /api/v1/milestones/:milestoneId/cards/bulk', (w) => `/api/v1/milestones/${w.milestoneId}/cards/bulk`, () => ({ cardIds: [] }), 'cardIds is empty'],
		['DELETE /api/v1/milestones/:milestoneId/cards/bulk', (w) => `/api/v1/milestones/${w.milestoneId}/cards/bulk`, () => ({ cardIds: [0] }), 'cardIds[0] must be an id'],
		// The token routes read their body through readBody and hold it to tokens.ts's rules, and nothing stricter (R10).
		['POST /api/v1/cards/:cardId/tokens', () => '/api/v1/cards/1.5/tokens', () => ({ tokens: 10 }), 'Invalid card ID'],
		['POST /api/v1/cards/:cardId/tokens', (w) => `/api/v1/cards/${w.cardId}/tokens`, () => ({ tokens: 'many' }), 'tokens must be a number'],
		['POST /api/v1/subtasks/:subtaskId/tokens', () => '/api/v1/subtasks/abc/tokens', () => ({ tokens: 10 }), 'Invalid subtask ID'],
		['POST /api/v1/tokens/bulk', () => '/api/v1/tokens/bulk', () => ({}), 'entries must be an array'],
		['POST /api/v1/tokens/bulk', () => '/api/v1/tokens/bulk', () => ({ entries: [null] }), 'entries[0] must be an object']
	];

	/** Every handler of the slice that reads a body: each has its cases above. */
	const HANDLERS = [
		'POST /api/v1/boards',
		'PUT /api/v1/boards/:boardId',
		'POST /api/v1/board-categories',
		'POST /api/v1/boards/:boardId/cards',
		'PUT /api/v1/cards/:cardId',
		'PUT /api/v1/cards/:cardId/move',
		'POST /api/v1/cards/:cardId/assignees',
		'DELETE /api/v1/cards/:cardId/assignees',
		'POST /api/v1/cards/:cardId/subtasks',
		'PUT /api/v1/subtasks/:subtaskId',
		'PUT /api/v1/comments/:commentId',
		'POST /api/v1/dependencies/bulk',
		'POST /api/v1/milestones',
		'PATCH /api/v1/milestones/:milestoneId',
		'POST /api/v1/milestones/:milestoneId/cards',
		'DELETE /api/v1/milestones/:milestoneId/cards',
		'POST /api/v1/milestones/:milestoneId/cards/bulk',
		'DELETE /api/v1/milestones/:milestoneId/cards/bulk',
		'POST /api/v1/cards/:cardId/tokens',
		'POST /api/v1/subtasks/:subtaskId/tokens',
		'POST /api/v1/tokens/bulk'
	];

	it('has cases for each handler of the slice that reads a body', () => {
		expect(sortedSet(CASES.map(([route]) => route))).toEqual(sortedSet(HANDLERS));
	});

	it.each(CASES)('%s refuses what it cannot use (%#)', async (route, path, body, message) => {
		const w = world();
		const method = route.split(' ')[0] as Method;
		const before = snapshotDb();

		const res = await api(method, path(w), { user: w.owner, body: body(w) });

		expect(res.status, JSON.stringify(res.body)).toBe(400);
		expect(res.body).toEqual({ message });
		expectUnchanged(before);
	});

	it('reads every id in a path as an id, on the reads and deletes as well: 1.5, abc, 0 and 1e3 are 400, where some were read as another id', async () => {
		const w = world();
		const before = snapshotDb();
		const PATHS: [Method, string, string][] = [
			['GET', '/api/v1/boards/1.5', 'Invalid board ID'],
			['GET', '/api/v1/boards/1e3/cards', 'Invalid board ID'],
			['GET', '/api/v1/boards/abc/columns', 'Invalid board ID'],
			['GET', '/api/v1/boards/0/labels', 'Invalid board ID'],
			['GET', '/api/v1/cards/1.5', 'Invalid card ID'],
			['GET', '/api/v1/cards/abc/comments', 'Invalid card ID'],
			['GET', '/api/v1/cards/1e3/board-history', 'Invalid card ID'],
			['DELETE', '/api/v1/cards/1.5', 'Invalid card ID'],
			['GET', '/api/v1/columns/2.5', 'Invalid column ID'],
			['DELETE', '/api/v1/labels/abc', 'Invalid label ID'],
			['GET', '/api/v1/categories/0', 'Invalid category ID'],
			['GET', '/api/v1/milestones/1.5/summary', 'Invalid milestone ID'],
			['GET', '/api/v1/milestones/abc/pdf', 'Invalid milestone ID'],
			['DELETE', '/api/v1/tokens/1.5', 'Invalid entry ID'],
			['DELETE', '/api/v1/webhooks/1e3', 'Invalid webhook ID'],
			['GET', `/api/v1/boards/${w.boardId}/cards?columnId=2.5`, 'Invalid column ID'],
			['GET', '/api/v1/milestones?boardId=5abc', 'Invalid boardId']
		];
		for (const [method, path, message] of PATHS) {
			const res = await api(method, path, { user: w.admin });
			expect({ path, status: res.status, body: res.body }).toEqual({ path, status: 400, body: { message } });
		}
		expectUnchanged(before);
	});

	it('looks for what the path names, and checks the caller, before it reads a field (R1)', async () => {
		const w = world();
		const before = snapshotDb();
		const answered = async (method: Method, path: string, body: unknown) => (await api(method, path, { user: w.outsider, body })).status;

		// Each body is wrong, and the caller may not touch the row: the 403 comes first, as it did for a card.
		expect(await answered('PUT', `/api/v1/cards/${w.cardId}`, { title: 5 })).toBe(403);
		expect(await answered('PUT', `/api/v1/cards/${w.cardId}`, { priority: 'urgent' })).toBe(403);
		expect(await answered('PUT', `/api/v1/boards/${w.boardId}`, { name: 5 })).toBe(403);
		expect(await answered('POST', `/api/v1/boards/${w.boardId}/cards`, { title: 5 })).toBe(403);
		expect(await answered('PUT', `/api/v1/subtasks/${w.subtaskId}`, { completed: 'false' })).toBe(403);
		// These looked at the body first, and answered 400.
		expect(await answered('PUT', `/api/v1/comments/${w.commentId}`, { content: '' })).toBe(403);
		expect(await answered('POST', `/api/v1/milestones/${w.milestoneId}/cards`, {})).toBe(403);
		expect(await answered('DELETE', `/api/v1/milestones/${w.milestoneId}/cards`, {})).toBe(403);
		// And a row that is not there is 404, whatever was sent.
		expect(await answered('PUT', '/api/v1/comments/99999', { content: '' })).toBe(404);
		expectUnchanged(before);
	});

	it('answers 404 for a board that is not there to everyone, where all but an administrator were answered 403 (decision 10)', async () => {
		const w = world();
		const lists = ['', '/cards', '/columns', '/labels', '/categories'];
		for (const user of [w.outsider, w.admin]) {
			for (const list of lists) {
				const res = await api('GET', `/api/v1/boards/99999${list}`, { user });
				expect({ list, user: user.username, status: res.status, body: res.body }).toEqual({
					list,
					user: user.username,
					status: 404,
					body: { message: 'Board not found' }
				});
			}
		}
		const before = snapshotDb();
		expect((await api('PUT', '/api/v1/boards/99999', { user: w.outsider, body: { name: 'x' } })).status).toBe(404);
		expect((await api('DELETE', '/api/v1/boards/99999', { user: w.outsider })).status).toBe(404);
		expect((await api('POST', '/api/v1/boards/99999/cards', { user: w.outsider, body: { title: 'x' } })).status).toBe(404);
		// A board that is there, which the caller cannot open, is still 403.
		expect((await api('GET', `/api/v1/boards/${w.boardId}`, { user: w.outsider })).status).toBe(403);
		expectUnchanged(before);
	});

	it('answers 404 for an id in the body that names nothing, and for taking off what is not on (decision 9)', async () => {
		const w = world();
		const other = makeMilestone({ createdBy: w.owner });
		const before = snapshotDb();
		const refused = async (method: Method, path: string, body: unknown) => {
			const res: ApiResult = await api(method, path, { user: w.owner, body });
			expect(res.status, `${method} ${path} ${JSON.stringify(res.body)}`).toBe(404);
			return res.body.message;
		};

		// A card's category: its board's or one of no board. Another board's was stored, and one that is not there was a 500.
		expect(await refused('POST', cards_(w), card(w, { categoryId: w.otherCategoryId }))).toBe('Category not found on this board');
		expect(await refused('POST', cards_(w), card(w, { categoryId: 99999 }))).toBe('Category not found on this board');
		expect(await refused('PUT', `/api/v1/cards/${w.cardId}`, { categoryId: w.otherCategoryId })).toBe('Category not found on this board');
		expect(await refused('PUT', `/api/v1/boards/${w.boardId}`, { categoryId: 99999 })).toBe('Board category not found');
		// Taking off what is not on was 200, and wrote an activity entry for the assignee.
		expect(await refused('DELETE', `/api/v1/cards/${w.cardId}/assignees`, { userId: w.outsider.id })).toBe('User is not assigned to this card');
		// The card is in board A's milestone, and not in this one: it was taken out of its own.
		expect(await refused('DELETE', `/api/v1/milestones/${other.id}/cards`, { cardId: w.cardId })).toBe('Card is not in this milestone');
		expectUnchanged(before);
	});

	it('files a card under its board’s category or a shared one, and keeps another board’s that it already holds (R3)', async () => {
		const w = world();

		const shared = await api('POST', cards_(w), { user: w.owner, body: card(w, { categoryId: w.sharedCategoryId }) });
		expect(shared.status, JSON.stringify(shared.body)).toBe(201);
		expect(shared.body.categoryId).toBe(w.sharedCategoryId);
		const own = await api('PUT', `/api/v1/cards/${w.cardId}`, { user: w.owner, body: { categoryId: w.categoryId } });
		expect(own.status).toBe(200);
		expect(own.body.categoryId).toBe(w.categoryId);

		// Filed under board B's before the rule: sent back unchanged with a new title, it is kept.
		db.update(cards).set({ categoryId: w.otherCategoryId }).where(eq(cards.id, w.cardId)).run();
		const kept = await api('PUT', `/api/v1/cards/${w.cardId}`, { user: w.owner, body: { title: 'Renamed', categoryId: w.otherCategoryId } });
		expect(kept.status, JSON.stringify(kept.body)).toBe(200);
		expect(kept.body).toMatchObject({ title: 'Renamed', categoryId: w.otherCategoryId });
	});

	it('keeps what the row holds when it is sent back unchanged, whatever the rules say of it, and refuses anything else on that row (decision 8, R8)', async () => {
		const w = world();
		// Stored before the rules, and sent back as a page sends them: the card window sends the priority, the due date and the colour tag on every save.
		const odd = { priority: 'urgent', dueDate: '14/10/2026', colorTag: 'red', businessValue: long(10001) };
		db.update(cards).set(odd).where(eq(cards.id, w.cardId)).run();
		db.update(subtasks).set({ priority: 'Urgent', colorTag: 'blue' }).where(eq(subtasks.id, w.subtaskId)).run();
		db.update(milestones).set({ targetDate: 'someday' }).where(eq(milestones.id, w.milestoneId)).run();

		const saved = await api('PUT', `/api/v1/cards/${w.cardId}`, { user: w.owner, body: { title: 'Renamed', ...odd } });
		expect(saved.status, JSON.stringify(saved.body).slice(0, 200)).toBe(200);
		expect(saved.body).toMatchObject({ title: 'Renamed', priority: 'urgent', dueDate: '14/10/2026', colorTag: 'red' });
		const step = await api('PUT', `/api/v1/subtasks/${w.subtaskId}`, { user: w.owner, body: { title: 'Renamed', priority: 'Urgent', colorTag: 'blue' } });
		expect(step.status, JSON.stringify(step.body)).toBe(200);
		const goal = await api('PATCH', `/api/v1/milestones/${w.milestoneId}`, { user: w.owner, body: { name: 'Renamed', targetDate: 'someday' } });
		expect(goal.status, JSON.stringify(goal.body)).toBe(200);

		// The pair that shows the rule is there: another value the rule refuses, on the same row, is refused and changes nothing.
		const before = snapshotDb();
		const banana = await api('PUT', `/api/v1/cards/${w.cardId}`, { user: w.owner, body: { title: 'Again', priority: 'banana' } });
		expect(banana.status).toBe(400);
		expect(banana.body).toEqual({ message: PRIORITY });
		// A position of "top", against a row whose position is a number.
		expect((await api('PUT', `/api/v1/subtasks/${w.subtaskId}`, { user: w.owner, body: { position: 'top' } })).status).toBe(400);
		expect((await api('PATCH', `/api/v1/milestones/${w.milestoneId}`, { user: w.owner, body: { targetDate: 'later' } })).status).toBe(400);
		expectUnchanged(before);
	});

	it('reads what the rules allow as they say: trimmed, in lower case, a number written as text, empty text as no date', async () => {
		const w = world();

		const made = await api('POST', cards_(w), {
			user: w.owner,
			body: { columnId: String(w.columnId), title: '  Raised  ', priority: 'HIGH', colorTag: ' #A1b2C3 ', dueDate: '', position: '2.5' }
		});
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		expect(made.body).toMatchObject({ title: 'Raised', priority: 'high', colorTag: '#A1b2C3', dueDate: null, position: 2.5 });

		const board = await api('POST', '/api/v1/boards', { user: w.owner, body: { name: '  Roadmap  ' } });
		expect(board.status).toBe(201);
		expect(board.body).toMatchObject({ name: 'Roadmap', emoji: '📋' });

		const grouping = await api('POST', '/api/v1/board-categories', { user: w.owner, body: { name: ' Clients ', color: ' #10B981 ' } });
		expect(grouping.status).toBe(201);
		expect(grouping.body).toMatchObject({ name: 'Clients', color: '#10B981' });

		const goal = await api('POST', '/api/v1/milestones', { user: w.owner, body: { name: ' Ship it ', boardId: w.boardId, targetDate: '2026-12-01' } });
		expect(goal.status).toBe(201);
		expect(goal.body).toMatchObject({ name: 'Ship it', boardId: w.boardId, targetDate: '2026-12-01' });

		const moved = await api('PUT', `/api/v1/cards/${w.cardId}/move`, { user: w.owner, body: { columnId: w.columnId, position: '7' } });
		expect(moved.status, JSON.stringify(moved.body)).toBe(200);
		expect(moved.body.position).toBe(7);
	});

	it('restores a card with archivedAt null, and does nothing else with it (decision 12)', async () => {
		const w = world();
		db.update(cards).set({ archivedAt: '2026-10-01 00:00:00' }).where(eq(cards.id, w.cardId)).run();

		// The stamp the card holds, sent back as this API answers it (ISO 8601, card 2095), changes nothing.
		const kept = await api('PUT', `/api/v1/cards/${w.cardId}`, { user: w.owner, body: { title: 'Renamed', archivedAt: '2026-10-01T00:00:00.000Z' } });
		expect(kept.status, JSON.stringify(kept.body)).toBe(200);
		expect(kept.body.archivedAt).toBe('2026-10-01T00:00:00.000Z');

		// How the tracking wrapper restores a card.
		const restored = await api('PUT', `/api/v1/cards/${w.cardId}`, { user: w.owner, body: { archivedAt: null } });
		expect(restored.status, JSON.stringify(restored.body)).toBe(200);
		expect(restored.body.archivedAt).toBeNull();
		expect(db.select({ archivedAt: cards.archivedAt }).from(cards).where(eq(cards.id, w.cardId)).get()).toEqual({ archivedAt: null });
	});

	it('takes a card out of a milestone by one rule on every route: edit access to the milestone it is in (R5)', async () => {
		const w = world();
		// A goal across boards, made by an administrator, with board A's card in it. `owner` edits board A, and neither made it nor is an administrator.
		const goal = makeMilestone({ createdBy: w.admin });
		db.update(cards).set({ milestoneId: goal.id }).where(eq(cards.id, w.cardId)).run();
		const before = snapshotDb();

		const viaCard = await api('PUT', `/api/v1/cards/${w.cardId}`, { user: w.owner, body: { milestoneId: null } });
		expect(viaCard.status, JSON.stringify(viaCard.body)).toBe(403);
		expect(viaCard.body.message).toBe('No edit access to this milestone');
		const viaGoal = await api('DELETE', `/api/v1/milestones/${goal.id}/cards`, { user: w.owner, body: { cardId: w.cardId } });
		expect(viaGoal.status).toBe(403);
		expectUnchanged(before);

		// The goal's maker, or an administrator, can.
		const out = await api('PUT', `/api/v1/cards/${w.cardId}`, { user: w.admin, body: { milestoneId: null } });
		expect(out.status, JSON.stringify(out.body)).toBe(200);
		expect(out.body.milestoneId).toBeNull();
	});

	it('puts no archived card into a milestone, in the words of the batch (decision 15)', async () => {
		const w = world();
		const column = db.select().from(columns).where(eq(columns.id, w.columnId)).get()!;
		const archived = makeCard(column, { archivedAt: '2026-10-01 00:00:00' });
		const before = snapshotDb();

		const one = await api('POST', `/api/v1/milestones/${w.milestoneId}/cards`, { user: w.owner, body: { cardId: archived.id } });
		expect(one.status, JSON.stringify(one.body)).toBe(400);
		expect(one.body).toEqual({ message: 'Card does not exist or is archived' });
		const viaCard = await api('PUT', `/api/v1/cards/${archived.id}`, { user: w.owner, body: { milestoneId: w.milestoneId } });
		expect(viaCard.status).toBe(400);
		expect(viaCard.body).toEqual({ message: 'Card does not exist or is archived' });
		expectUnchanged(before);
	});

	it('reads the audit log’s limit and offset as whole numbers held to their range, and its ids as ids (decision 17)', async () => {
		const w = world();
		for (let i = 0; i < 3; i++) await api('PUT', `/api/v1/cards/${w.cardId}`, { user: w.owner, body: { title: `Title ${i}` } });
		const page = (query: string) => api('GET', `/api/v1/audit-log?${query}`, { user: w.admin });

		// -1 gave every row, which is what SQLite does with a negative limit.
		const minusOne = await page('limit=-1');
		expect(minusOne.status).toBe(200);
		expect(minusOne.body.pagination).toMatchObject({ limit: 1, count: 1 });
		// 2.5 was a 500.
		expect((await page('limit=2.5')).body.pagination).toMatchObject({ limit: 2, count: 2 });
		// A negative offset was echoed.
		expect((await page('offset=-5')).body.pagination).toMatchObject({ offset: 0 });
		expect((await page('limit=x')).body.pagination).toMatchObject({ limit: 100 });
		for (const query of ['boardId=2.5', 'userId=abc', 'cardId=0']) {
			const res = await page(query);
			expect({ query, status: res.status }).toEqual({ query, status: 400 });
		}
	});

	it('reads the activity report’s window as dates, in UTC, and its board ids as ids (decision 17)', async () => {
		const w = world();
		const report = (query: string) => api('GET', `/api/v1/reports/activity?${query}`, { user: w.admin });

		expect((await report('from=yesterday')).body).toEqual({ message: 'from is not a date' });
		expect((await report('to=2026-13-01')).body).toEqual({ message: 'to is not a date' });
		expect((await report(`boardIds=${w.boardId},abc`)).body).toEqual({ message: 'boardIds must be a comma-separated list of ids' });
		expect((await report('commentLimit=2.5')).status).toBe(400);

		// 09:00 at +02:00 is 07:00 UTC: compared as written, it was two hours out.
		const shifted = await report(`from=${encodeURIComponent('2026-10-14T09:00:00+02:00')}&to=2026-10-15`);
		expect(shifted.status, JSON.stringify(shifted.body)).toBe(200);
		// Read in the stored form, a bare `to` the whole of its day, and answered in ISO 8601 (card 2095).
		expect(shifted.body.period).toMatchObject({ from: '2026-10-14T07:00:00.000Z', to: '2026-10-15T23:59:59.000Z' });
	});

	it('answers an average cycle time of 0 as 0, where it was null (decision 17)', async () => {
		const w = world();
		// Completed the moment it was raised, and assigned to the caller.
		const raised = db.select({ createdAt: cards.createdAt }).from(cards).where(eq(cards.id, w.cardId)).get()!;
		db.update(cards).set({ completedAt: raised.createdAt }).where(eq(cards.id, w.cardId)).run();
		db.insert(cardAssignees).values({ cardId: w.cardId, userId: w.owner.id }).run();

		const stats = await api('GET', '/api/v1/me/stats', { user: w.owner });

		expect(stats.status).toBe(200);
		expect(stats.body.avgCycleTimeDays).toBe(0);
	});
});

describe('the web application’s work routes that card 2117’s third slice moved onto the readers', () => {
	/**
	 * Each refusal is a 400 that names the field, or the route's own words
	 * where a test or a page quotes them (`Invalid card ID` for an id in the
	 * body that names the row guarded, which the guard used to parse), and
	 * changes nothing. Before, a field was stored as it was sent (`"urgent"`
	 * as a priority, any text as a due date or a colour, `"top"` as a
	 * position, `"false"` as true), was given a default (`{}` made "Untitled
	 * Board"), or was a 500 (a label with no name, a column body with no field
	 * it uses, an entry of a drop that was no object).
	 */
	type World = {
		/** Owns boards A and B: may edit both. */
		owner: SessionUser;
		/** May open neither board. */
		outsider: SessionUser;
		/** May view board A. */
		viewer: SessionUser;
		admin: SessionUser;
		boardId: number;
		otherBoardId: number;
		columnId: number;
		otherColumnId: number;
		cardId: number;
		subtaskId: number;
		labelId: number;
		/** Board A's, with the card in it. */
		milestoneId: number;
		/** A category of board A, one of board B, and one of no board. */
		categoryId: number;
		otherCategoryId: number;
		sharedCategoryId: number;
	};

	function world(): World {
		const owner = makeUser({ username: 'owner' });
		const outsider = makeUser({ username: 'outsider' });
		const viewer = makeUser({ username: 'viewer' });
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const A = makeBoard({ owner, name: 'A' });
		const B = makeBoard({ owner, name: 'B' });
		addBoardMember(A.board, viewer, 'viewer');
		const card = makeCard(A.cols['To Do']);
		const category = (boardId: number | null, name: string) => db.insert(categories).values({ boardId, name }).returning().get().id;
		return {
			owner,
			outsider,
			viewer,
			admin,
			boardId: A.board.id,
			otherBoardId: B.board.id,
			columnId: A.cols['To Do'].id,
			otherColumnId: B.cols['To Do'].id,
			cardId: card.id,
			subtaskId: makeSubtask(card, { position: 1 }).id,
			labelId: makeLabel(A.board).id,
			milestoneId: makeMilestone({ board: A.board, createdBy: owner, cards: [card] }).id,
			categoryId: category(A.board.id, 'A category'),
			otherCategoryId: category(B.board.id, 'B category'),
			sharedCategoryId: category(null, 'Shared category')
		};
	}

	beforeEach(resetDb);

	type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	type Case = [route: string, path: (w: World) => string, body: (w: World) => unknown, message: string];
	const long = (n: number) => 'x'.repeat(n);
	const PRIORITY = 'priority must be one of: low, medium, high, critical';
	const DATE = (name: string) => `${name} must be a date written YYYY-MM-DD`;
	const COLOUR = 'color must be a colour written #rrggbb';
	const COLOUR_TAG = 'colorTag must be a colour written #rrggbb, or empty';
	const card = (w: World, more: object = {}) => ({ columnId: w.columnId, title: 'Raised', ...more });
	const step = (w: World, more: object = {}) => ({ cardId: w.cardId, title: 'A step', ...more });
	const at = (path: string) => () => path;
	const ofCard = (w: World) => `/api/cards/${w.cardId}`;
	const ofSubtask = (w: World) => `/api/subtasks/${w.subtaskId}`;
	const ofColumn = (w: World) => `/api/columns/${w.columnId}`;
	const ofMilestone = (w: World) => `/api/milestones/${w.milestoneId}`;
	const assignees = (w: World) => `/api/cards/${w.cardId}/assignees`;
	const archive = (w: World) => `/api/boards/${w.boardId}/archive`;

	const CASES: Case[] = [
		// POST /api/boards: a board has no row to guard, so its fields are read first.
		['POST /api/boards', at('/api/boards'), () => ({}), 'name is required'],
		['POST /api/boards', at('/api/boards'), () => ({ name: 5 }), 'name must be text'],
		['POST /api/boards', at('/api/boards'), () => ({ name: '   ' }), 'name is required'],
		['POST /api/boards', at('/api/boards'), () => ({ name: long(201) }), 'name must be at most 200 characters'],
		['POST /api/boards', at('/api/boards'), () => ({ name: 'Roadmap', emoji: '' }), 'emoji cannot be empty'],
		['POST /api/boards', at('/api/boards'), () => ({ name: 'Roadmap', parentCardId: 'a card' }), 'parentCardId must be an id'],
		['POST /api/boards', at('/api/boards'), () => ({ name: 'Roadmap', categoryId: 1.5 }), 'categoryId must be an id'],
		// POST /api/boards/:id/archive restores the card the body names.
		['POST /api/boards/:id/archive', archive, () => ({}), 'Invalid card ID'],
		['POST /api/boards/:id/archive', archive, () => ({ cardId: 'the first' }), 'Invalid card ID'],
		['POST /api/boards/:id/archive', at('/api/boards/1.5/archive'), (w) => ({ cardId: w.cardId }), 'Invalid board ID'],
		// POST /api/board-categories
		['POST /api/board-categories', at('/api/board-categories'), () => ({}), 'name is required'],
		['POST /api/board-categories', at('/api/board-categories'), () => ({ name: ['G'] }), 'name must be text'],
		['POST /api/board-categories', at('/api/board-categories'), () => ({ name: 'G', color: 'red' }), COLOUR],
		// POST /api/categories
		['POST /api/categories', at('/api/categories'), (w) => ({ boardId: w.boardId }), 'name is required'],
		['POST /api/categories', at('/api/categories'), () => ({ boardId: 'A', name: 'C' }), 'Invalid board ID'],
		['POST /api/categories', at('/api/categories'), (w) => ({ boardId: w.boardId, name: long(201) }), 'name must be at most 200 characters'],
		['POST /api/categories', at('/api/categories'), (w) => ({ boardId: w.boardId, name: 'C', color: '#fff' }), COLOUR],
		// POST /api/columns
		['POST /api/columns', at('/api/columns'), () => ({ title: 'X' }), 'Invalid board ID'],
		['POST /api/columns', at('/api/columns'), (w) => ({ boardId: w.boardId }), 'title is required'],
		['POST /api/columns', at('/api/columns'), (w) => ({ boardId: w.boardId, title: 'X', position: 'top' }), 'position must be a number'],
		['POST /api/columns', at('/api/columns'), (w) => ({ boardId: w.boardId, title: 'X', color: 'red;background:url(//x.io)' }), COLOUR],
		// PUT /api/columns/:id: a body with nothing it uses was a 500.
		['PUT /api/columns/:id', ofColumn, () => ({}), 'No valid fields to update'],
		['PUT /api/columns/:id', ofColumn, (w) => ({ boardId: w.boardId }), 'No valid fields to update'],
		['PUT /api/columns/:id', ofColumn, () => ({ title: ' ' }), 'title cannot be empty'],
		['PUT /api/columns/:id', ofColumn, () => ({ showAddCard: 'false' }), 'showAddCard must be true or false'],
		['PUT /api/columns/:id', ofColumn, () => ({ position: 'top' }), 'position must be a number'],
		['PUT /api/columns/:id', ofColumn, () => ({ color: 'red' }), COLOUR],
		['PUT /api/columns/:id', at('/api/columns/abc'), () => ({ title: 'X' }), 'Invalid column ID'],
		// PUT /api/columns/reorder
		['PUT /api/columns/reorder', at('/api/columns/reorder'), () => ({}), 'updates must be an array'],
		['PUT /api/columns/reorder', at('/api/columns/reorder'), () => ({ updates: 'all' }), 'updates must be an array'],
		['PUT /api/columns/reorder', at('/api/columns/reorder'), () => ({ updates: [null] }), 'updates[0] must be an object'],
		['PUT /api/columns/reorder', at('/api/columns/reorder'), () => ({ updates: [{ id: 'x', position: 1 }] }), 'updates[0].id must be an id'],
		['PUT /api/columns/reorder', at('/api/columns/reorder'), (w) => ({ updates: [{ id: w.columnId, position: 'top' }] }), 'updates[0].position must be a number'],
		['PUT /api/columns/reorder', at('/api/columns/reorder'), (w) => ({ updates: [{ id: w.columnId }] }), 'updates[0].position must be a number'],
		// POST /api/cards
		['POST /api/cards', at('/api/cards'), () => ({ title: 'Raised' }), 'Invalid column ID'],
		['POST /api/cards', at('/api/cards'), (w) => card(w, { title: 5 }), 'title must be text'],
		['POST /api/cards', at('/api/cards'), (w) => card(w, { title: ' ' }), 'title is required'],
		['POST /api/cards', at('/api/cards'), (w) => card(w, { title: long(501) }), 'title must be at most 500 characters'],
		['POST /api/cards', at('/api/cards'), (w) => card(w, { description: long(50001) }), 'description must be at most 50000 characters'],
		['POST /api/cards', at('/api/cards'), (w) => card(w, { priority: 'urgent' }), PRIORITY],
		['POST /api/cards', at('/api/cards'), (w) => card(w, { dueDate: '2026-02-30' }), DATE('dueDate')],
		['POST /api/cards', at('/api/cards'), (w) => card(w, { colorTag: 'red' }), COLOUR_TAG],
		['POST /api/cards', at('/api/cards'), (w) => card(w, { position: 'top' }), 'position must be a number'],
		['POST /api/cards', at('/api/cards'), (w) => card(w, { businessValue: long(10001) }), 'businessValue must be at most 10000 characters'],
		['POST /api/cards', at('/api/cards'), (w) => card(w, { categoryId: 0 }), 'categoryId must be an id'],
		['POST /api/cards', at('/api/cards'), (w) => card(w, { summary: 5 }), 'summary must be a string or null'],
		// PUT /api/cards/:id
		['PUT /api/cards/:id', ofCard, () => ({ title: '' }), 'title cannot be empty'],
		['PUT /api/cards/:id', ofCard, () => ({ title: 5 }), 'title must be text'],
		['PUT /api/cards/:id', ofCard, () => ({ description: null }), 'description must be text'],
		['PUT /api/cards/:id', ofCard, () => ({ priority: 'urgent' }), PRIORITY],
		['PUT /api/cards/:id', ofCard, () => ({ pinned: 'false' }), 'pinned must be true or false'],
		['PUT /api/cards/:id', ofCard, () => ({ dueDate: '14/10/2026' }), DATE('dueDate')],
		['PUT /api/cards/:id', ofCard, () => ({ colorTag: '#fff' }), COLOUR_TAG],
		['PUT /api/cards/:id', ofCard, () => ({ position: 'top' }), 'position must be a number'],
		['PUT /api/cards/:id', ofCard, () => ({ coverUrl: 5 }), 'coverUrl must be a colour written #rrggbb, one of the preset gradients, or null'],
		['PUT /api/cards/:id', ofCard, () => ({ businessValue: long(10001) }), 'businessValue must be at most 10000 characters'],
		['PUT /api/cards/:id', ofCard, () => ({ closeReason: 7 }), 'closeReason must be a string or null'],
		['PUT /api/cards/:id', ofCard, () => ({ columnId: 'next' }), 'Invalid column ID'],
		['PUT /api/cards/:id', at('/api/cards/1e3'), () => ({ title: 'x' }), 'Invalid card ID'],
		// The assignees of a card.
		['POST /api/cards/:id/assignees', assignees, () => ({}), 'userId is required'],
		['POST /api/cards/:id/assignees', assignees, () => ({ userId: 'someone' }), 'userId must be an id'],
		['DELETE /api/cards/:id/assignees', assignees, () => ({}), 'userId is required'],
		['DELETE /api/cards/:id/assignees', assignees, () => ({ userId: 0 }), 'userId must be an id'],
		// PUT /api/cards/reorder
		['PUT /api/cards/reorder', at('/api/cards/reorder'), () => ({}), 'updates must be an array'],
		['PUT /api/cards/reorder', at('/api/cards/reorder'), () => ({ updates: [7] }), 'updates[0] must be an object'],
		['PUT /api/cards/reorder', at('/api/cards/reorder'), (w) => ({ updates: [{ id: 'x', columnId: w.columnId }] }), 'updates[0].id must be an id'],
		['PUT /api/cards/reorder', at('/api/cards/reorder'), (w) => ({ updates: [{ id: w.cardId, columnId: 1.5 }] }), 'updates[0].columnId must be an id'],
		[
			'PUT /api/cards/reorder',
			at('/api/cards/reorder'),
			(w) => ({ updates: [{ id: w.cardId, columnId: w.columnId, position: 'top' }] }),
			'updates[0].position must be a number'
		],
		// The labels.
		['POST /api/labels', at('/api/labels'), () => ({ name: 'L' }), 'Invalid board ID'],
		['POST /api/labels', at('/api/labels'), (w) => ({ boardId: w.boardId }), 'name is required'],
		['POST /api/labels', at('/api/labels'), (w) => ({ boardId: w.boardId, name: 'L', color: 'blue' }), COLOUR],
		['PUT /api/labels', at('/api/labels'), (w) => ({ labelId: w.labelId }), 'Invalid card ID'],
		['PUT /api/labels', at('/api/labels'), (w) => ({ cardId: w.cardId, labelId: '1.5' }), 'Invalid label ID'],
		['DELETE /api/labels', at('/api/labels'), () => ({}), 'Invalid label ID'],
		['DELETE /api/labels', at('/api/labels'), () => ({ id: true }), 'Invalid label ID'],
		// The milestones.
		['POST /api/milestones', at('/api/milestones'), () => ({}), 'name is required'],
		['POST /api/milestones', at('/api/milestones'), () => ({ name: 5 }), 'name must be text'],
		['POST /api/milestones', at('/api/milestones'), () => ({ name: 'Ship it', targetDate: 'soon' }), DATE('targetDate')],
		['POST /api/milestones', at('/api/milestones'), () => ({ name: 'Ship it', boardId: 'A' }), 'boardId must be an id'],
		['PATCH /api/milestones/:id', ofMilestone, () => ({}), 'No valid fields to update'],
		['PATCH /api/milestones/:id', ofMilestone, () => ({ name: null }), 'name must be text'],
		['PATCH /api/milestones/:id', ofMilestone, () => ({ status: 'done' }), 'status must be open or closed'],
		['PATCH /api/milestones/:id', ofMilestone, () => ({ targetDate: '2026-13-01' }), DATE('targetDate')],
		['PATCH /api/milestones/:id', ofMilestone, () => ({ boardId: 1.5 }), 'boardId must be an id'],
		['PATCH /api/milestones/:id', ofMilestone, () => ({ cardId: 'x' }), 'cardId must be an id'],
		['PATCH /api/milestones/:id', ofMilestone, (w) => ({ cardId: w.cardId, attach: 'false' }), 'attach must be true or false'],
		['PATCH /api/milestones/:id', at('/api/milestones/1.5'), () => ({ name: 'x' }), 'Invalid milestone ID'],
		// The subtasks.
		['POST /api/subtasks', at('/api/subtasks'), () => ({ title: 'A step' }), 'Invalid card ID'],
		['POST /api/subtasks', at('/api/subtasks'), (w) => ({ cardId: w.cardId }), 'title is required'],
		['POST /api/subtasks', at('/api/subtasks'), (w) => step(w, { priority: 'urgent' }), PRIORITY],
		['POST /api/subtasks', at('/api/subtasks'), (w) => step(w, { colorTag: 'red' }), COLOUR_TAG],
		['POST /api/subtasks', at('/api/subtasks'), (w) => step(w, { dueDate: 'tomorrow' }), DATE('dueDate')],
		['PUT /api/subtasks/:id', ofSubtask, () => ({}), 'No valid fields to update'],
		['PUT /api/subtasks/:id', ofSubtask, () => ({ completed: 'false' }), 'completed must be true or false'],
		['PUT /api/subtasks/:id', ofSubtask, () => ({ title: '' }), 'title cannot be empty'],
		['PUT /api/subtasks/:id', ofSubtask, () => ({ position: 'top' }), 'position must be a number'],
		['PUT /api/subtasks/:id', ofSubtask, () => ({ priority: 'urgent' }), PRIORITY],
		['PUT /api/subtasks/:id', at('/api/subtasks/0'), () => ({ title: 'x' }), 'Invalid subtask ID'],
		// The templates.
		['POST /api/templates', at('/api/templates'), () => ({}), 'name is required'],
		['POST /api/templates', at('/api/templates'), () => ({ name: 'T', boardId: 'A' }), 'Invalid board ID'],
		['POST /api/templates', at('/api/templates'), () => ({ name: 'T', title: 5 }), 'title must be text'],
		['POST /api/templates', at('/api/templates'), () => ({ name: 'T', priority: 'urgent' }), PRIORITY],
		['POST /api/templates', at('/api/templates'), () => ({ name: 'T', subtasks: [5] }), 'subtasks[0] must be an object'],
		['POST /api/templates', at('/api/templates'), () => ({ name: 'T', subtasks: [{ title: 5 }] }), 'subtasks[0].title must be text'],
		[
			'POST /api/templates',
			at('/api/templates'),
			() => ({ name: 'T', subtasks: [{ title: 'S', priority: 'urgent' }] }),
			'subtasks[0].priority must be one of: low, medium, high, critical'
		],
		['POST /api/templates', at('/api/templates'), () => ({ name: 'T', labels: ['x'] }), 'labels[0] must be an id']
	];

	/** Every handler of the slice that reads a body: each has its cases above. */
	const HANDLERS = [
		'POST /api/boards',
		'POST /api/boards/:id/archive',
		'POST /api/board-categories',
		'POST /api/categories',
		'POST /api/columns',
		'PUT /api/columns/:id',
		'PUT /api/columns/reorder',
		'POST /api/cards',
		'PUT /api/cards/:id',
		'POST /api/cards/:id/assignees',
		'DELETE /api/cards/:id/assignees',
		'PUT /api/cards/reorder',
		'POST /api/labels',
		'PUT /api/labels',
		'DELETE /api/labels',
		'POST /api/milestones',
		'PATCH /api/milestones/:id',
		'POST /api/subtasks',
		'PUT /api/subtasks/:id',
		'POST /api/templates'
	];

	it('has cases for each handler of the slice that reads a body', () => {
		expect(sortedSet(CASES.map(([route]) => route))).toEqual(sortedSet(HANDLERS));
	});

	it.each(CASES)('%s refuses what it cannot use (%#)', async (route, path, body, message) => {
		const w = world();
		const method = route.split(' ')[0] as Method;
		const before = snapshotDb();

		const res = await api(method, path(w), { user: w.owner, body: body(w) });

		expect(res.status, JSON.stringify(res.body)).toBe(400);
		expect(res.body).toEqual({ message });
		expectUnchanged(before);
	});

	it('looks for what the path or the body names, and checks the caller, before it reads a field (R1)', async () => {
		const w = world();
		const before = snapshotDb();
		const answered = async (method: Method, path: string, body: unknown, user = w.outsider) => (await api(method, path, { user, body })).status;

		// Each body is wrong, and the caller may not touch the row: the 403 comes first.
		expect(await answered('PUT', `/api/cards/${w.cardId}`, { title: 5 })).toBe(403);
		expect(await answered('PUT', `/api/subtasks/${w.subtaskId}`, { completed: 'false' })).toBe(403);
		expect(await answered('PUT', `/api/columns/${w.columnId}`, { title: 5 })).toBe(403);
		expect(await answered('POST', '/api/cards', { columnId: w.columnId, title: 5 })).toBe(403);
		expect(await answered('POST', '/api/subtasks', { cardId: w.cardId, title: 5 })).toBe(403);
		expect(await answered('POST', '/api/columns', { boardId: w.boardId, title: 5 })).toBe(403);
		expect(await answered('POST', '/api/labels', { boardId: w.boardId, name: 5 })).toBe(403);
		expect(await answered('PUT', '/api/labels', { cardId: w.cardId, labelId: 'x' })).toBe(403);
		expect(await answered('POST', '/api/categories', { boardId: w.boardId, name: 5 })).toBe(403);
		expect(await answered('POST', '/api/templates', { boardId: w.boardId, name: 5 })).toBe(403);
		expect(await answered('POST', '/api/milestones', { boardId: w.boardId, name: 5 })).toBe(403);
		expect(await answered('PATCH', `/api/milestones/${w.milestoneId}`, { name: 5 })).toBe(403);
		expect(await answered('POST', `/api/cards/${w.cardId}/assignees`, { userId: 'x' })).toBe(403);
		expect(await answered('PUT', '/api/cards/reorder', { updates: [{ id: w.cardId, columnId: w.columnId, position: 'top' }] })).toBe(403);
		// A new comment, in both trees, read its content first and answered 400.
		expect(await answered('POST', `/api/cards/${w.cardId}/comments`, { content: '' })).toBe(403);
		expect(await answered('POST', `/api/v1/cards/${w.cardId}/comments`, { content: '' })).toBe(403);
		expect(await answered('POST', `/api/cards/${w.cardId}/comments`, { content: 5 }, w.viewer)).toBe(403);
		// And a row that is not there is 404, whatever was sent.
		expect(await answered('POST', '/api/cards/99999/comments', { content: '' }, w.owner)).toBe(404);
		expect(await answered('POST', '/api/v1/cards/99999/comments', { content: '' }, w.owner)).toBe(404);
		expect(await answered('PUT', '/api/cards/99999', { title: 5 }, w.owner)).toBe(404);
		expect(await answered('POST', '/api/cards', { columnId: 99999, title: 5 }, w.owner)).toBe(404);
		expect(await answered('PATCH', '/api/milestones/99999', { name: 5 }, w.owner)).toBe(404);
		expectUnchanged(before);
	});

	it('answers 404 for an id in the body that names nothing, and for taking off what is not on (decision 9)', async () => {
		const w = world();
		const other = makeMilestone({ createdBy: w.owner });
		const before = snapshotDb();
		const refused = async (method: Method, path: string, body: unknown) => {
			const res: ApiResult = await api(method, path, { user: w.owner, body });
			expect(res.status, `${method} ${path} ${JSON.stringify(res.body)}`).toBe(404);
			return res.body.message;
		};

		// A card's category: its board's or one of no board. Another board's was stored, and one that is not there was a 500.
		expect(await refused('POST', '/api/cards', card(w, { categoryId: w.otherCategoryId }))).toBe('Category not found on this board');
		expect(await refused('POST', '/api/cards', card(w, { categoryId: 99999 }))).toBe('Category not found on this board');
		expect(await refused('PUT', `/api/cards/${w.cardId}`, { categoryId: w.otherCategoryId })).toBe('Category not found on this board');
		// A board's grouping: there is no foreign key, and one that is not there was stored.
		expect(await refused('POST', '/api/boards', { name: 'Roadmap', categoryId: 99999 })).toBe('Board category not found');
		// Taking off what is not on was 200.
		expect(await refused('DELETE', `/api/cards/${w.cardId}/assignees`, { userId: w.viewer.id })).toBe('User is not assigned to this card');
		// The card is in board A's milestone, and not in this one: it was taken out of its own.
		expect(await refused('PATCH', `/api/milestones/${other.id}`, { cardId: w.cardId, attach: false })).toBe('Card is not in this milestone');
		// A milestone that is not there was not looked at, and the card was taken out of its own.
		expect(await refused('PATCH', '/api/milestones/99999', { cardId: w.cardId, attach: false })).toBe('Milestone not found');
		expectUnchanged(before);
	});

	it('files a card under its board’s category or a shared one, and keeps another board’s that it already holds (R3)', async () => {
		const w = world();

		const shared = await api('POST', '/api/cards', { user: w.owner, body: card(w, { categoryId: w.sharedCategoryId }) });
		expect(shared.status, JSON.stringify(shared.body)).toBe(201);
		expect(shared.body.categoryId).toBe(w.sharedCategoryId);
		const own = await api('PUT', `/api/cards/${w.cardId}`, { user: w.owner, body: { categoryId: w.categoryId } });
		expect(own.status).toBe(200);
		expect(own.body.categoryId).toBe(w.categoryId);

		// Filed under board B's before the rule: sent back unchanged with a new title, it is kept.
		db.update(cards).set({ categoryId: w.otherCategoryId }).where(eq(cards.id, w.cardId)).run();
		const kept = await api('PUT', `/api/cards/${w.cardId}`, { user: w.owner, body: { title: 'Renamed', categoryId: w.otherCategoryId } });
		expect(kept.status, JSON.stringify(kept.body)).toBe(200);
		expect(kept.body).toMatchObject({ title: 'Renamed', categoryId: w.otherCategoryId });

		// Moved to board B, as All Tasks moves one, a new category is one of the board it ends on.
		const moved = await api('PUT', `/api/cards/${w.cardId}`, { user: w.owner, body: { columnId: w.otherColumnId, categoryId: w.categoryId } });
		expect(moved.status, JSON.stringify(moved.body)).toBe(404);
		const movedWith = await api('PUT', `/api/cards/${shared.body.id}`, {
			user: w.owner,
			body: { columnId: w.otherColumnId, categoryId: w.otherCategoryId }
		});
		expect(movedWith.status, JSON.stringify(movedWith.body)).toBe(200);
		expect(movedWith.body).toMatchObject({ columnId: w.otherColumnId, categoryId: w.otherCategoryId });
	});

	it('offers in the card window only the board’s categories and the shared ones (R3)', () => {
		const modal = readFileSync(join(ROOT, 'src/lib/components/CardModal.svelte'), 'utf8');

		// The picker's list, filtered against the card's board, and not every category the page passes.
		expect(modal).toMatch(/const pickableCategories = \$derived\(localCategories\.filter\(\(c\) => c\.boardId === boardId \|\| c\.boardId === null\)\)/);
		expect(modal).toContain('{#each pickableCategories as cat}');
		expect(modal).not.toContain('{#each localCategories as cat}');
	});

	it('keeps what the row holds when it is sent back unchanged, whatever the rules say of it, and refuses anything else on that row (decision 8, R8)', async () => {
		const w = world();
		// Stored before the rules, and sent back as the card window sends them on every save.
		const odd = { priority: 'urgent', dueDate: '14/10/2026', colorTag: 'red', businessValue: long(10001), categoryId: w.otherCategoryId };
		db.update(cards).set(odd).where(eq(cards.id, w.cardId)).run();
		db.update(subtasks).set({ priority: 'Urgent', colorTag: 'blue' }).where(eq(subtasks.id, w.subtaskId)).run();
		db.update(columns).set({ color: 'red' }).where(eq(columns.id, w.columnId)).run();
		db.update(milestones).set({ targetDate: 'someday' }).where(eq(milestones.id, w.milestoneId)).run();

		const saved = await api('PUT', `/api/cards/${w.cardId}`, { user: w.owner, body: { title: 'Renamed', ...odd } });
		expect(saved.status, JSON.stringify(saved.body).slice(0, 200)).toBe(200);
		expect(saved.body).toMatchObject({ title: 'Renamed', priority: 'urgent', dueDate: '14/10/2026', colorTag: 'red', categoryId: w.otherCategoryId });
		const stepSaved = await api('PUT', `/api/subtasks/${w.subtaskId}`, { user: w.owner, body: { title: 'Renamed', priority: 'Urgent', colorTag: 'blue' } });
		expect(stepSaved.status, JSON.stringify(stepSaved.body)).toBe(200);
		const columnSaved = await api('PUT', `/api/columns/${w.columnId}`, { user: w.owner, body: { title: 'Renamed', color: 'red' } });
		expect(columnSaved.status, JSON.stringify(columnSaved.body)).toBe(200);
		const goal = await api('PATCH', `/api/milestones/${w.milestoneId}`, { user: w.owner, body: { name: 'Renamed', targetDate: 'someday' } });
		expect(goal.status, JSON.stringify(goal.body)).toBe(200);

		// The pair that shows the rule is there: another value the rule refuses, on the same row, is refused and changes nothing.
		const before = snapshotDb();
		const banana = await api('PUT', `/api/cards/${w.cardId}`, { user: w.owner, body: { title: 'Again', priority: 'banana' } });
		expect(banana.status).toBe(400);
		expect(banana.body).toEqual({ message: PRIORITY });
		// A position of "top", against a row whose position is a number.
		expect((await api('PUT', `/api/subtasks/${w.subtaskId}`, { user: w.owner, body: { position: 'top' } })).status).toBe(400);
		expect((await api('PUT', `/api/columns/${w.columnId}`, { user: w.owner, body: { color: 'blue' } })).status).toBe(400);
		expect((await api('PATCH', `/api/milestones/${w.milestoneId}`, { user: w.owner, body: { targetDate: 'later' } })).status).toBe(400);
		expectUnchanged(before);
	});

	it('reads what the rules allow as they say: trimmed, in lower case, a number written as text, empty text as no date', async () => {
		const w = world();

		const made = await api('POST', '/api/cards', {
			user: w.owner,
			body: { columnId: String(w.columnId), title: '  Raised  ', priority: 'HIGH', colorTag: ' #A1b2C3 ', dueDate: '', position: '2.5', boardId: w.otherBoardId }
		});
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		expect(made.body).toMatchObject({ title: 'Raised', priority: 'high', colorTag: '#A1b2C3', dueDate: null, position: 2.5 });

		const board = await api('POST', '/api/boards', { user: w.owner, body: { name: '  Roadmap  ', categoryId: null } });
		expect(board.status).toBe(201);
		expect(board.body).toMatchObject({ name: 'Roadmap', emoji: '📋', categoryId: null });

		const grouping = await api('POST', '/api/board-categories', { user: w.owner, body: { name: ' Clients ', color: ' #10B981 ' } });
		expect(grouping.status).toBe(201);
		expect(grouping.body).toMatchObject({ name: 'Clients', color: '#10B981' });

		const madeStep = await api('POST', '/api/subtasks', { user: w.owner, body: { cardId: String(w.cardId), title: ' A step ', priority: 'Low' } });
		expect(madeStep.status, JSON.stringify(madeStep.body)).toBe(201);
		expect(madeStep.body).toMatchObject({ title: 'A step', priority: 'low' });

		const template = await api('POST', '/api/templates', {
			user: w.owner,
			body: { name: ' Release ', priority: 'CRITICAL', subtasks: [{ title: 'Tag it', priority: 'High', extra: 'not kept' }], labels: [String(w.labelId)] }
		});
		expect(template.status, JSON.stringify(template.body)).toBe(200);
		expect(template.body).toMatchObject({ name: 'Release', priority: 'critical', labelsJson: JSON.stringify([w.labelId]) });
		expect(JSON.parse(template.body.subtasksJson)).toEqual([{ title: 'Tag it', description: '', priority: 'high' }]);

		const goal = await api('POST', '/api/milestones', { user: w.owner, body: { name: ' Ship it ', boardId: w.boardId, targetDate: '2026-12-01' } });
		expect(goal.status).toBe(201);
		expect(goal.body).toMatchObject({ name: 'Ship it', boardId: w.boardId, targetDate: '2026-12-01' });

		const dropped = await api('PUT', '/api/cards/reorder', {
			user: w.owner,
			body: { updates: [{ id: w.cardId, columnId: String(w.columnId), position: '7' }] }
		});
		expect(dropped.status, JSON.stringify(dropped.body)).toBe(200);
		expect(db.select({ position: cards.position }).from(cards).where(eq(cards.id, w.cardId)).get()).toEqual({ position: 7 });

		const ordered = await api('PUT', '/api/columns/reorder', { user: w.owner, body: { updates: [{ id: w.columnId, position: '9' }] } });
		expect(ordered.status).toBe(200);
		expect(db.select({ position: columns.position }).from(columns).where(eq(columns.id, w.columnId)).get()).toEqual({ position: 9 });
	});

	it('saves "Show Add Task" on a column, which was a 500 on every press (decision 20)', async () => {
		const w = world();

		const res = await api('PUT', `/api/columns/${w.columnId}`, { user: w.owner, body: { showAddCard: true, boardId: w.boardId } });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.showAddCard).toBe(true);
		expect(db.select({ showAddCard: columns.showAddCard }).from(columns).where(eq(columns.id, w.columnId)).get()).toEqual({ showAddCard: true });
	});

	it('takes a card out of a milestone from the card window by the one rule: edit access to the milestone it is in (R5)', async () => {
		const w = world();
		// A goal across boards, made by an administrator, with board A's card in it. `owner` edits board A, and neither made it nor is an administrator.
		const goal = makeMilestone({ createdBy: w.admin });
		db.update(cards).set({ milestoneId: goal.id }).where(eq(cards.id, w.cardId)).run();
		const before = snapshotDb();

		const refused = await api('PATCH', `/api/milestones/${goal.id}`, { user: w.owner, body: { cardId: w.cardId, attach: false } });
		expect(refused.status, JSON.stringify(refused.body)).toBe(403);
		expect(refused.body.message).toBe('No edit access to this milestone');
		expectUnchanged(before);

		// The goal's maker, or an administrator, can.
		const out = await api('PATCH', `/api/milestones/${goal.id}`, { user: w.admin, body: { cardId: w.cardId, attach: false } });
		expect(out.status, JSON.stringify(out.body)).toBe(200);
		expect(db.select({ milestoneId: cards.milestoneId }).from(cards).where(eq(cards.id, w.cardId)).get()).toEqual({ milestoneId: null });
	});

	it('puts no archived card into a milestone from the card window, in the words of the batch (decision 15)', async () => {
		const w = world();
		const column = db.select().from(columns).where(eq(columns.id, w.columnId)).get()!;
		const archived = makeCard(column, { archivedAt: '2026-10-01 00:00:00' });
		const before = snapshotDb();

		const res = await api('PATCH', `/api/milestones/${w.milestoneId}`, { user: w.owner, body: { cardId: archived.id } });

		expect(res.status, JSON.stringify(res.body)).toBe(400);
		expect(res.body).toEqual({ message: 'Card does not exist or is archived' });
		expectUnchanged(before);
	});

	it('reads every id in a path or a query string as an id, on the reads and deletes as well: 1.5, abc, 0 and 1e3 are 400', async () => {
		const w = world();
		const before = snapshotDb();
		const PATHS: [Method, string, string][] = [
			['GET', '/api/boards/1.5/archive', 'Invalid board ID'],
			['DELETE', '/api/boards/abc', 'Invalid board ID'],
			['GET', '/api/boards/0/share', 'Invalid board ID'],
			['GET', '/api/boards/1e3/cards', 'Invalid board ID'],
			['GET', '/api/boards/1e3/cfd', 'Invalid board ID'],
			['GET', '/api/boards/1.5/export/csv', 'Invalid board ID'],
			['GET', '/api/boards/abc/metrics', 'Invalid board ID'],
			['POST', '/api/boards/1.5/favourite', 'Invalid board ID'],
			['DELETE', '/api/cards/1.5', 'Invalid card ID'],
			['GET', '/api/cards/abc/comments', 'Invalid card ID'],
			['DELETE', `/api/cards/${w.cardId}/comments/1.5`, 'Invalid comment ID'],
			['GET', '/api/cards/1e3/dependencies', 'Invalid card ID'],
			['GET', '/api/cards/1.5/attachments', 'Invalid card ID'],
			['DELETE', `/api/cards/${w.cardId}/attachments/abc`, 'Invalid attachment ID'],
			['GET', '/api/cards/0/context', 'Invalid card ID'],
			['POST', '/api/cards/1e3/restore', 'Invalid card ID'],
			['GET', '/api/cards/1.5/tokens', 'Invalid card ID'],
			['DELETE', '/api/categories/abc', 'Invalid category ID'],
			['DELETE', '/api/board-categories/1.5', 'Invalid category ID'],
			['DELETE', '/api/columns/1e3', 'Invalid column ID'],
			['GET', '/api/milestones/1.5', 'Invalid milestone ID'],
			['DELETE', '/api/milestones/abc', 'Invalid milestone ID'],
			['GET', '/api/milestones/1e3/pdf', 'Invalid milestone ID'],
			['GET', '/api/milestones/0/summary', 'Invalid milestone ID'],
			['DELETE', '/api/subtasks/1.5', 'Invalid subtask ID'],
			['GET', '/api/subtasks/abc/dependencies', 'Invalid subtask ID'],
			['DELETE', '/api/templates/1.5', 'Invalid template ID'],
			['GET', '/api/labels?boardId=2.5', 'Invalid boardId'],
			['GET', '/api/subtasks?cardId=abc', 'Invalid cardId'],
			['GET', '/api/activity?boardId=5abc', 'Invalid boardId'],
			['GET', '/api/graph?columnId=2.5', 'Invalid columnId'],
			['GET', '/api/graph?boardId=0', 'Invalid boardId'],
			['GET', '/api/milestones?forBoard=x', 'Invalid forBoard'],
			['GET', '/api/milestones?boardId=1.5', 'Invalid boardId'],
			['GET', '/api/templates?boardId=1e3', 'Invalid board ID'],
			['GET', '/api/cards/export/csv?boardId=2.5', 'Invalid boardId']
		];
		for (const [method, path, message] of PATHS) {
			const res = await api(method, path, { user: w.admin });
			expect({ path, status: res.status, body: res.body }).toEqual({ path, status: 400, body: { message } });
		}
		expectUnchanged(before);
	});

	it('draws the superadmin among the administrators, a member of every board (decision 20)', async () => {
		const w = world();
		const chief = makeUser({ username: 'chief', role: 'superadmin' });

		const res = await api('GET', '/api/graph', { user: w.admin });

		expect(res.status).toBe(200);
		const boardsOf = (user: SessionUser) =>
			res.body.edges
				.filter((edge: { source: string; relation: string }) => edge.source === `user:${user.id}` && edge.relation === 'admin_of')
				.map((edge: { target: string }) => edge.target)
				.sort();
		expect(boardsOf(chief)).toEqual([`board:${w.boardId}`, `board:${w.otherBoardId}`].sort());
		expect(boardsOf(chief)).toEqual(boardsOf(w.admin));
	});

	it('answers 404 for a card that is not there before it asks who may see its labels, on GET /api/v1/cards/:cardId/labels', async () => {
		const w = world();
		for (const user of [w.outsider, w.admin]) {
			const res = await api('GET', '/api/v1/cards/99999/labels', { user });
			expect({ user: user.username, status: res.status, body: res.body }).toEqual({
				user: user.username,
				status: 404,
				body: { message: 'Card not found' }
			});
		}
	});

	it('reads each end of a dependency batch as an id, naming the entry (decision 18)', async () => {
		const w = world();
		const before = snapshotDb();
		const said = (what: string) => `${what} must be a card id, "subtask:<id>", or {kind, id}`;
		const BODIES: [unknown, string][] = [
			// Each was taken for an id, and reported in the 409 as a link to nothing.
			[{ chain: [w.cardId, 1.5] }, said('chain[1]')],
			[{ chain: [w.cardId, '1e3'] }, said('chain[1]')],
			[{ chain: [0, w.cardId] }, said('chain[0]')],
			[{ chain: [w.cardId, 'subtask:-1'] }, said('chain[1]')],
			[{ links: [{ blocked: w.cardId, blocker: '2.5' }] }, said('links[0].blocker')],
			[{ links: [{ blocked: { kind: 'card', id: 'x' }, blocker: w.cardId }] }, said('links[0].blocked')],
			// A list was read as the id in it, and a kind that is no kind as a card.
			[{ chain: [[w.cardId], w.cardId] }, said('chain[0]')],
			[{ chain: [{ kind: 'board', id: w.boardId }, w.cardId] }, said('chain[0]')]
		];
		for (const [body, message] of BODIES) {
			const res = await api('POST', '/api/v1/dependencies/bulk', { user: w.owner, body });
			expect({ body, status: res.status, answer: res.body }).toEqual({ body, status: 400, answer: { message } });
		}
		expectUnchanged(before);

		// What was taken stays taken: a card, `subtask:<id>`, `card:<id>`, an id written as text, and {kind, id}.
		const second = makeCard(db.select().from(columns).where(eq(columns.id, w.columnId)).get()!);
		const made = await api('POST', '/api/v1/dependencies/bulk', {
			user: w.owner,
			body: { links: [{ blocked: `card:${second.id}`, blocker: String(w.cardId) }, { blocked: { kind: 'subtask', id: w.subtaskId }, blocker: second.id }] }
		});
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		expect(made.body.created).toBe(2);
	});

	it('reads a bare date as the whole day when it checks the activity report’s window', async () => {
		const w = world();
		const report = (query: string) => api('GET', `/api/v1/reports/activity?${query}`, { user: w.admin });

		// The rest of 14 October: a bare `to` was read as its start, and this was `from` after `to`.
		const rest = await report('from=2026-10-14T09:00:00Z&to=2026-10-14');
		expect(rest.status, JSON.stringify(rest.body)).toBe(200);
		expect((await report('from=2026-10-14&to=2026-10-14')).status).toBe(200);
		// A window that does end before it begins is still refused.
		expect((await report('from=2026-10-15&to=2026-10-14')).body).toEqual({ message: '`from` is after `to`' });
		expect((await report('from=2026-10-15T00:00:00Z&to=2026-10-14')).body).toEqual({ message: '`from` is after `to`' });
	});
});

// ─── Card 2117, slice 4: accounts, administration, teams, reports and requests ─

describe('the accounts, administration, teams, reports and requests that card 2117’s fourth slice moved onto the readers', () => {
	/**
	 * Each refusal is a 400 that names the field, or the route's own words
	 * where a test or a page quotes them, and changes nothing. Before, a field
	 * was stored as it was sent (a port of `"abc"`, an expiry of `"banana"`, a
	 * schedule's time of `"9"`), was dropped without a word (a preference of
	 * `"no"`, a recipient that was no address, a priority it did not know), was
	 * read as another (`"10"` XP added as text), or was a 500 (a password, a
	 * title or a message that was not text).
	 */
	type World = {
		/** Owns board A, is a member of the team, and is who the request is for. */
		owner: SessionUser;
		/** May open nothing, and the request is not for them. */
		outsider: SessionUser;
		admin: SessionUser;
		/** The superadmin. */
		chief: SessionUser;
		boardId: number;
		columnId: number;
		teamId: number;
		/** A request to `owner`, waiting, with the token of its link. */
		requestId: number;
		token: string;
		/** A schedule of `owner`'s. */
		scheduleId: number;
	};

	const TOKEN = 'the-token-of-the-requesters-link';

	function world(): World {
		const owner = makeUser({ username: 'owner' });
		const outsider = makeUser({ username: 'outsider' });
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		const A = makeBoard({ owner, name: 'A' });
		const team = makeTeam([owner]);
		const request = db
			.insert(taskRequests)
			.values({ targetType: 'user', targetId: owner.id, title: 'A dark theme', desiredBoardId: A.board.id, accessToken: TOKEN })
			.returning()
			.get();
		const schedule = db.insert(reportSchedules).values({ userId: owner.id, name: 'Weekly', scopeId: A.board.id }).returning().get();
		return {
			owner,
			outsider,
			admin,
			chief,
			boardId: A.board.id,
			columnId: A.cols['To Do'].id,
			teamId: team.id,
			requestId: request.id,
			token: TOKEN,
			scheduleId: schedule.id
		};
	}

	beforeEach(resetDb);

	type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	type Who = 'owner' | 'admin' | 'chief';
	type Case = [route: string, who: Who, path: (w: World) => string, body: (w: World) => unknown, message: string];
	const long = (n: number) => 'x'.repeat(n);
	const at = (path: string) => () => path;
	/** The routes that ask for the current password read a session cookie; it is not looked up. */
	const SESSION = { cookie: `${SESSION_COOKIE_NAME}=a-session` };
	const PRIORITY = 'priority must be one of: low, medium, high, critical';
	const TIME = (name: string) => `${name} must be a time written HH:MM, from 00:00 to 23:59`;
	const key = (more: object = {}) => ({ name: 'my script', password: 'the password', ...more });
	const schedule = (w: World, more: object = {}) => ({ name: 'Weekly', scope: 'board', scopeId: w.boardId, frequency: 'weekly', ...more });
	const report = (w: World, more: object = {}) => ({ scope: 'board', scopeId: w.boardId, periodStart: '2026-10-01', periodEnd: '2026-10-08', ...more });
	const mailed = (w: World, more: object = {}) => report(w, { recipients: ['a@example.test'], ...more });
	const asked = (w: World, more: object = {}) => ({ targetType: 'user', targetId: w.owner.id, desiredBoardId: w.boardId, title: 'A dark theme', ...more });
	const ofRequest = (w: World) => `/api/requests/${w.requestId}`;
	const replies = (w: World) => `/api/requests/${w.requestId}/messages`;
	const ofOwner = (w: World) => `/api/users/${w.owner.id}`;
	const DESTINATION = 'destinations[0]';
	/** A save of one SFTP destination holding `hostKey` (card 2250). */
	const hostKeyed = (hostKey: unknown) => ({ destinations: [{ name: 'Box', type: 'sftp', host: 'box.example.test', username: 'backup', hostKey }] });

	const CASES: Case[] = [
		// POST /api/account/api-keys: every field before a password is checked or counted.
		['POST /api/account/api-keys', 'owner', at('/api/account/api-keys'), () => ({ password: 'x' }), 'Key name is required'],
		['POST /api/account/api-keys', 'owner', at('/api/account/api-keys'), () => key({ name: 5 }), 'name must be text'],
		['POST /api/account/api-keys', 'owner', at('/api/account/api-keys'), () => key({ name: long(101) }), 'name must be at most 100 characters'],
		['POST /api/account/api-keys', 'owner', at('/api/account/api-keys'), () => key({ password: 5 }), 'Password is required'],
		['POST /api/account/api-keys', 'owner', at('/api/account/api-keys'), () => key({ expiresAt: 'banana' }), 'expiresAt must be a timestamp, such as 2027-01-01T09:00:00Z'],
		['POST /api/account/api-keys', 'owner', at('/api/account/api-keys'), () => key({ expiresAt: '2020-01-01T00:00:00Z' }), 'expiresAt must be in the future'],
		// PUT /api/account/email
		['PUT /api/account/email', 'owner', at('/api/account/email'), () => ({ newEmail: 'moved@example.test' }), 'Password is required'],
		['PUT /api/account/email', 'owner', at('/api/account/email'), () => ({ password: 'x', newEmail: 5 }), 'newEmail must be text'],
		['PUT /api/account/email', 'owner', at('/api/account/email'), () => ({ password: 'x', newEmail: '  ' }), 'Email is required'],
		['PUT /api/account/email', 'owner', at('/api/account/email'), () => ({ password: 'x', newEmail: 'me@example.test,them@example.test' }), 'Invalid email address'],
		['PUT /api/account/email', 'owner', at('/api/account/email'), () => ({ password: 'x', newEmail: 'me@localhost' }), 'Invalid email address'],
		// PUT /api/account/emoji
		['PUT /api/account/emoji', 'owner', at('/api/account/emoji'), () => ({}), 'Missing emoji'],
		['PUT /api/account/emoji', 'owner', at('/api/account/emoji'), () => ({ emoji: 5 }), 'Missing emoji'],
		['PUT /api/account/emoji', 'owner', at('/api/account/emoji'), () => ({ emoji: long(33) }), 'emoji must be at most 32 characters'],
		// PUT /api/account/notifications: a known key that is not true or false was dropped without a word.
		['PUT /api/account/notifications', 'owner', at('/api/account/notifications'), () => ({ email_moved: 'no' }), 'email_moved must be true or false'],
		['PUT /api/account/notifications', 'owner', at('/api/account/notifications'), () => ({ email_all: null }), 'email_all must be true or false'],
		// PUT /api/account/password
		['PUT /api/account/password', 'owner', at('/api/account/password'), () => ({ newPassword: 'a long password' }), 'Current password is required'],
		['PUT /api/account/password', 'owner', at('/api/account/password'), () => ({ currentPassword: 'x', newPassword: 12345678 }), 'newPassword must be text'],
		['PUT /api/account/password', 'owner', at('/api/account/password'), () => ({ currentPassword: 'x', newPassword: 'a long password', endApiKeys: 'yes' }), 'endApiKeys must be true or false'],
		// PUT /api/admin/backup: `{}` wrote the defaults over every setting and deleted every destination.
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => ({}), 'No valid fields to update'],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => ({ schedule: 'monthly' }), 'schedule must be one of: disabled, hourly, every6h, every12h, daily, weekly'],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => ({ scheduleTime: '2am' }), TIME('scheduleTime')],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => ({ scheduleDay: 7 }), 'scheduleDay must be from 0 to 6'],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => ({ retention: 0 }), 'retention must be from 1 to 100'],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => ({ retention: '7 days' }), 'retention must be a whole number'],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => ({ notifyOnFailure: 'true' }), 'notifyOnFailure must be true or false'],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => ({ notifyEmail: 'ops' }), 'notifyEmail holds "ops", which is not an email address'],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => ({ destinations: {} }), 'destinations must be a list'],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => ({ destinations: [5] }), 'destinations[0] must be an object'],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => ({ destinations: [{ type: 'sftp' }] }), `${DESTINATION}.name is required`],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => ({ destinations: [{ name: 'Box', type: 'ftp' }] }), `${DESTINATION}.type must be one of: sftp, s3, gdrive, onedrive`],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => ({ destinations: [{ name: 'Box', type: 'sftp', port: '22a' }] }), `${DESTINATION}.port must be a whole number`],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => ({ destinations: [{ name: 'Box', type: 's3', bucket: ['b'] }] }), `${DESTINATION}.bucket must be text`],
		// Card 2250, R5: an SFTP host key fingerprint with its type, in one of two forms, or nothing.
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed(`255 ${FINGERPRINT} root@nas (ECDSA)`), HOST_KEY(DESTINATION)],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed(`1024 ${FINGERPRINT} root@nas (DSA)`), HOST_KEY(DESTINATION)],
		// The review's S5: an RSA key of fewer than 1,024 bits is no key a server should be trusted by.
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed(`1023 ${FINGERPRINT} root@nas (RSA)`), HOST_KEY(DESTINATION)],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed(`512 ${FINGERPRINT} root@nas (RSA)`), HOST_KEY(DESTINATION)],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed(`256 ${FINGERPRINT} root@nas (ED25519-SK)`), HOST_KEY(DESTINATION)],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed(FINGERPRINT), HOST_KEY(DESTINATION)],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed(`ssh-dss ${FINGERPRINT}`), HOST_KEY(DESTINATION)],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed(`SSH-ED25519 ${FINGERPRINT}`), HOST_KEY(DESTINATION)],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed('ssh-ed25519 SHA256:s16t1ixxsjxOgoaXCXACvAIOEG1K5biSlM7Gek-av_Y'), HOST_KEY(DESTINATION)],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed(`ssh-ed25519 ${FINGERPRINT.slice(0, -1)}`), HOST_KEY(DESTINATION)],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed(`ssh-ed25519 ${FINGERPRINT}A`), HOST_KEY(DESTINATION)],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed(`ssh-ed25519 ${FINGERPRINT}=`), HOST_KEY(DESTINATION)],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed('ssh-ed25519 SHA256:s16t1ixxsjxOgoaXCXACvAIOEG1K5biSlM7GekmavrZ'), HOST_KEY(DESTINATION)],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed('ssh-ed25519 MD5:16:27:ac:a5:76:28:2d:36:63:1b:56:4d:eb:df:a6:48'), HOST_KEY(DESTINATION)],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed('256 MD5:16:27:ac:a5:76:28:2d:36:63:1b:56:4d:eb:df:a6:48 root@nas (ED25519)'), HOST_KEY(DESTINATION)],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed(`ssh-ed25519 sha256:${FINGERPRINT.slice(7)}`), HOST_KEY(DESTINATION)],
		['PUT /api/admin/backup', 'chief', at('/api/admin/backup'), () => hostKeyed(5), `${DESTINATION}.hostKey must be text`],
		// POST /api/admin/backup
		['POST /api/admin/backup', 'chief', at('/api/admin/backup'), () => ({ destination: 5 }), 'destination must be text'],
		// POST /api/admin/backup/gdrive/auth
		['POST /api/admin/backup/gdrive/auth', 'chief', at('/api/admin/backup/gdrive/auth'), () => ({ destName: 'Drive' }), 'Missing code or destName'],
		['POST /api/admin/backup/gdrive/auth', 'chief', at('/api/admin/backup/gdrive/auth'), () => ({ code: 5, destName: 'Drive' }), 'code must be text'],
		// Card 2251: the state from the address Google's page leads to, read as text as the code is.
		['POST /api/admin/backup/gdrive/auth', 'chief', at('/api/admin/backup/gdrive/auth'), () => ({ code: 'x', destName: 'Drive', state: 5 }), 'state must be text'],
		// POST /api/admin/backup/test
		['POST /api/admin/backup/test', 'chief', at('/api/admin/backup/test'), () => ({ type: 'sftp' }), 'Missing destination type or name'],
		['POST /api/admin/backup/test', 'chief', at('/api/admin/backup/test'), () => ({ name: 'Box', type: 'ftp' }), 'type must be one of: sftp, s3, gdrive, onedrive'],
		['POST /api/admin/backup/test', 'chief', at('/api/admin/backup/test'), () => ({ name: 'Box', type: 'sftp', port: 70000 }), 'port must be a whole number from 1 to 65535'],
		['POST /api/admin/backup/test', 'chief', at('/api/admin/backup/test'), () => ({ name: 'Box', type: 'sftp', hostKey: FINGERPRINT }), HOST_KEY(null)],
		// PUT /api/admin/smtp: the body was handed on whole, and a port of "abc" stored.
		['PUT /api/admin/smtp', 'chief', at('/api/admin/smtp'), () => ({ port: 'abc' }), 'port must be a whole number'],
		['PUT /api/admin/smtp', 'chief', at('/api/admin/smtp'), () => ({ port: 70000 }), 'port must be from 1 to 65535'],
		['PUT /api/admin/smtp', 'chief', at('/api/admin/smtp'), () => ({ allowInsecure: 'true' }), 'allowInsecure must be true or false'],
		['PUT /api/admin/smtp', 'chief', at('/api/admin/smtp'), () => ({ host: 5 }), 'host must be text'],
		['PUT /api/admin/smtp', 'chief', at('/api/admin/smtp'), () => ({ fromAddress: 'the board' }), 'fromAddress must be an email address'],
		['PUT /api/admin/smtp', 'chief', at('/api/admin/smtp'), () => ({ appUrl: 'ftp://kanban.example.test' }), 'appUrl must be an http or https address'],
		// POST /api/admin/smtp
		['POST /api/admin/smtp', 'chief', at('/api/admin/smtp'), () => ({ to: 'nobody' }), 'to must be an email address'],
		// POST /api/report-schedules: as the scheduler reads each, as PUT reads them.
		['POST /api/report-schedules', 'owner', at('/api/report-schedules'), () => ({}), 'Missing required fields: name, scope, frequency'],
		['POST /api/report-schedules', 'owner', at('/api/report-schedules'), (w) => schedule(w, { scopeId: 'A' }), 'scopeId must be an id'],
		['POST /api/report-schedules', 'owner', at('/api/report-schedules'), (w) => schedule(w, { name: long(201) }), 'name must be at most 200 characters'],
		['POST /api/report-schedules', 'owner', at('/api/report-schedules'), (w) => schedule(w, { timeOfDay: '9' }), TIME('timeOfDay')],
		['POST /api/report-schedules', 'owner', at('/api/report-schedules'), (w) => schedule(w, { dayOfWeek: 7 }), 'dayOfWeek must be from 0 to 6'],
		['POST /api/report-schedules', 'owner', at('/api/report-schedules'), (w) => schedule(w, { dayOfMonth: 31 }), 'dayOfMonth must be from 1 to 28'],
		['POST /api/report-schedules', 'owner', at('/api/report-schedules'), (w) => schedule(w, { periodDays: 0 }), 'periodDays must be from 1 to 366'],
		['POST /api/report-schedules', 'owner', at('/api/report-schedules'), (w) => schedule(w, { recipients: 'a@example.test, nobody' }), 'recipients holds "nobody", which is not an email address'],
		['POST /api/report-schedules', 'owner', at('/api/report-schedules'), (w) => schedule(w, { detailLevel: 'brief' }), 'detailLevel must be one of: summary, detailed'],
		['POST /api/report-schedules', 'owner', at('/api/report-schedules'), (w) => schedule(w, { statusFilter: 'done' }), 'statusFilter must be one of: all, completed, in_progress, todo'],
		// POST /api/reports
		['POST /api/reports', 'owner', at('/api/reports'), (w) => report(w, { periodStart: 'last week' }), 'periodStart is not a date'],
		['POST /api/reports', 'owner', at('/api/reports'), (w) => report(w, { periodEnd: 5 }), 'periodEnd must be text'],
		['POST /api/reports', 'owner', at('/api/reports'), (w) => report(w, { scopeId: 1.5 }), 'scopeId must be an id'],
		['POST /api/reports', 'owner', at('/api/reports'), (w) => report(w, { detailLevel: 'brief' }), 'detailLevel must be one of: summary, detailed'],
		['POST /api/reports', 'owner', at('/api/reports'), (w) => report(w, { statusFilter: 'done' }), 'statusFilter must be one of: all, completed, in_progress, todo'],
		['POST /api/reports', 'owner', at('/api/reports'), (w) => report(w, { assigneeUserId: 'all' }), 'assigneeUserId must be a user id'],
		// The reader's zone, whose day decides the Overdue figure (card 2258), read as a schedule's is.
		['POST /api/reports', 'owner', at('/api/reports'), (w) => report(w, { timeZone: 'Mars/Base' }), 'timeZone must be a time zone name, such as Europe/London'],
		// POST /api/reports/email
		['POST /api/reports/email', 'owner', at('/api/reports/email'), (w) => mailed(w, { recipients: 'a@example.test' }), 'At least one recipient email is required'],
		['POST /api/reports/email', 'owner', at('/api/reports/email'), (w) => mailed(w, { recipients: ['a@example.test, b@example.test'] }), 'recipients[0] must be an email address'],
		['POST /api/reports/email', 'owner', at('/api/reports/email'), (w) => mailed(w, { scope: 'everything' }), 'Invalid scope. Must be: board, category, or all'],
		['POST /api/reports/email', 'owner', at('/api/reports/email'), (w) => mailed(w, { periodEnd: 'tomorrow' }), 'periodEnd is not a date'],
		['POST /api/reports/email', 'owner', at('/api/reports/email'), (w) => mailed(w, { timeZone: 'Mars/Base' }), 'timeZone must be a time zone name, such as Europe/London'],
		// POST /api/requests, signed in: a field that was not text was a 500, and a priority it did not know was medium.
		['POST /api/requests', 'owner', at('/api/requests'), (w) => asked(w, { title: 5 }), 'title must be text'],
		['POST /api/requests', 'owner', at('/api/requests'), (w) => asked(w, { targetType: 'board' }), 'Invalid target type'],
		['POST /api/requests', 'owner', at('/api/requests'), (w) => asked(w, { targetId: 'me' }), 'targetId must be an id'],
		['POST /api/requests', 'owner', at('/api/requests'), (w) => asked(w, { desiredBoardId: 1.5 }), 'desiredBoardId must be an id'],
		['POST /api/requests', 'owner', at('/api/requests'), (w) => asked(w, { description: 5 }), 'description must be text'],
		['POST /api/requests', 'owner', at('/api/requests'), (w) => asked(w, { priority: 'urgent' }), PRIORITY],
		['POST /api/requests', 'owner', at('/api/requests'), (w) => asked(w, { requesterName: 5 }), 'requesterName must be text'],
		// PATCH /api/requests/:id
		['PATCH /api/requests/:id', 'owner', ofRequest, () => ({ action: ['accept'] }), 'Invalid action — must be "accept" or "reject"'],
		['PATCH /api/requests/:id', 'owner', ofRequest, (w) => ({ action: 'accept', boardId: w.boardId, columnId: 'the first' }), 'columnId must be an id'],
		['PATCH /api/requests/:id', 'owner', ofRequest, (w) => ({ action: 'accept', boardId: w.boardId, columnId: w.columnId, assigneeId: 'x' }), 'assigneeId must be an id'],
		['PATCH /api/requests/:id', 'owner', ofRequest, () => ({ action: 'reject', rejectReason: 5 }), 'rejectReason must be text'],
		// POST /api/requests/:id/messages
		['POST /api/requests/:id/messages', 'owner', replies, () => ({ message: 5 }), 'message must be text'],
		['POST /api/requests/:id/messages', 'owner', replies, () => ({ message: '  ' }), 'Message is required'],
		['POST /api/requests/:id/messages', 'owner', replies, () => ({ message: long(5001) }), 'message must be at most 5000 characters'],
		['POST /api/requests/:id/messages', 'owner', replies, () => ({ message: 'Any news?', senderType: 'staff' }), 'senderType must be one of: requester, admin'],
		// POST /api/teams, as PUT reads a team.
		['POST /api/teams', 'owner', at('/api/teams'), () => ({ name: 5 }), 'name must be text'],
		['POST /api/teams', 'owner', at('/api/teams'), () => ({ name: long(201) }), 'name must be at most 200 characters'],
		['POST /api/teams', 'owner', at('/api/teams'), () => ({ name: 'Platform', emoji: '' }), 'emoji cannot be empty'],
		// POST /api/users
		['POST /api/users', 'admin', at('/api/users'), () => ({ username: 'newbie', email: 'newbie@example.test,them@example.test' }), 'Valid email required'],
		['POST /api/users', 'admin', at('/api/users'), () => ({ username: 'newbie', email: 'newbie@example.test', emoji: long(33) }), 'emoji must be at most 32 characters'],
		// PUT /api/users/:id: the username and email were stored as they came.
		['PUT /api/users/:id', 'admin', ofOwner, () => ({ username: ' a ' }), 'Username must be at least 2 characters'],
		['PUT /api/users/:id', 'admin', ofOwner, () => ({ email: 'no at sign' }), 'Valid email required'],
		['PUT /api/users/:id', 'admin', ofOwner, () => ({ emoji: '' }), 'emoji cannot be empty'],
		// PUT /api/users/:id/password: a password that was not text reached bcrypt, which threw.
		['PUT /api/users/:id/password', 'admin', (w) => `/api/users/${w.owner.id}/password`, () => ({ password: 12345678 }), 'password must be text'],
		['PUT /api/users/:id/password', 'admin', (w) => `/api/users/${w.owner.id}/password`, () => ({}), 'Password must be at least 8 characters']
	];

	/** Every handler of the slice that reads a body: each has its cases above. */
	const HANDLERS = [
		'POST /api/account/api-keys',
		'PUT /api/account/email',
		'PUT /api/account/emoji',
		'PUT /api/account/notifications',
		'PUT /api/account/password',
		'PUT /api/admin/backup',
		'POST /api/admin/backup',
		'POST /api/admin/backup/gdrive/auth',
		'POST /api/admin/backup/test',
		'PUT /api/admin/smtp',
		'POST /api/admin/smtp',
		'POST /api/report-schedules',
		'POST /api/reports',
		'POST /api/reports/email',
		'POST /api/requests',
		'PATCH /api/requests/:id',
		'POST /api/requests/:id/messages',
		'POST /api/teams',
		'POST /api/users',
		'PUT /api/users/:id',
		'PUT /api/users/:id/password'
	];

	it('has cases for each handler of the slice that reads a body, but the confirmation, which refuses none (below)', () => {
		expect(sortedSet(CASES.map(([route]) => route))).toEqual(sortedSet(HANDLERS));
	});

	it.each(CASES)('%s refuses what it cannot use (%#)', async (route, who, path, body, message) => {
		const w = world();
		const method = route.split(' ')[0] as Method;
		const before = snapshotDb();

		const res = await api(method, path(w), { user: w[who], body: body(w), headers: SESSION });

		expect(res.status, JSON.stringify(res.body)).toBe(400);
		expect(res.body).toEqual({ message });
		expectUnchanged(before);
	});

	it('reads every id in a path or a query string as an id: 1.5, abc, 0 and 1e3 are 400', async () => {
		const w = world();
		const before = snapshotDb();
		const PATHS: [Method, string, Who, string][] = [
			['DELETE', '/api/account/api-keys/1.5', 'owner', 'Invalid key ID'],
			['POST', '/api/admin/boards/abc/clear-cards', 'admin', 'Invalid board ID'],
			['POST', '/api/admin/boards/0/clear-categories', 'admin', 'Invalid board ID'],
			['DELETE', '/api/report-schedules/1e3', 'owner', 'Invalid schedule ID'],
			['GET', '/api/requests/1.5', 'owner', 'Invalid request ID'],
			['PATCH', '/api/requests/abc', 'owner', 'Invalid request ID'],
			['DELETE', '/api/requests/0', 'admin', 'Invalid request ID'],
			['POST', '/api/requests/1e3/confirm', 'owner', 'Invalid request ID'],
			['GET', '/api/requests/1.5/messages', 'owner', 'Invalid request ID'],
			['POST', '/api/requests/abc/messages', 'owner', 'Invalid request ID'],
			['DELETE', '/api/teams/1.5', 'admin', 'Invalid team ID'],
			['DELETE', `/api/teams/${w.teamId}/members/abc`, 'admin', 'Invalid user ID'],
			['PUT', '/api/users/1.5', 'admin', 'Invalid user ID'],
			['DELETE', '/api/users/abc', 'admin', 'Invalid user ID'],
			['PUT', '/api/users/0/password', 'admin', 'Invalid user ID'],
			['POST', '/api/users/1e3/invite', 'admin', 'Invalid user ID'],
			['GET', '/api/audit?boardId=2.5', 'admin', 'Invalid boardId'],
			['GET', '/api/audit?userId=5abc', 'admin', 'Invalid userId']
		];
		for (const [method, path, who, message] of PATHS) {
			const body = method === 'GET' || method === 'DELETE' ? undefined : {};
			const res = await api(method, path, { user: w[who], body });
			expect({ path, status: res.status, body: res.body }).toEqual({ path, status: 400, body: { message } });
		}
		expectUnchanged(before);
	});

	it('looks for what the path names, and checks the caller, before it reads a field (R1)', async () => {
		const w = world();
		const admin2 = makeUser({ username: 'admin2', role: 'admin' });
		const before = snapshotDb();
		const answered = async (method: Method, path: string, user: SessionUser, body: unknown) =>
			(await api(method, path, { user, body, headers: SESSION })).status;

		// Each body is wrong, and the caller may not touch the row: the 403 or the 404 comes first.
		expect(await answered('PUT', `/api/users/${admin2.id}`, w.admin, { username: 5 })).toBe(403);
		expect(await answered('PUT', '/api/users/99999', w.admin, { username: 5 })).toBe(404);
		expect(await answered('PUT', `/api/users/${admin2.id}/password`, w.admin, { password: 5 })).toBe(403);
		expect(await answered('PATCH', ofRequest(w), w.outsider, { action: 'accept', columnId: 'x' })).toBe(403);
		expect(await answered('POST', replies(w), w.outsider, { message: '' })).toBe(403);
		expect(await answered('POST', '/api/requests/99999/messages', w.owner, { message: '' })).toBe(404);
		expect(await answered('POST', replies(w), w.owner, { message: '', senderType: 'requester', token: 'not it' })).toBe(403);
		// A schedule's board is looked for, and the caller checked, before its other fields: its name was read first.
		expect(await answered('POST', '/api/report-schedules', w.outsider, schedule(w, { name: '' }))).toBe(403);
		expect(await answered('POST', '/api/report-schedules', w.admin, schedule(w, { scopeId: 99999, name: '' }))).toBe(404);
		expectUnchanged(before);
	});

	it('answers a confirmation token that is not text as it answers a wrong one, for a request that is there and one that is not (decision 19)', async () => {
		const w = world();
		db.update(taskRequests).set({ status: 'unverified' }).where(eq(taskRequests.id, w.requestId)).run();
		const before = snapshotDb();
		const NOT_VALID = { message: 'This confirmation link is not valid.' };

		// A token of 5 was handed to the comparison, which threw for a request
		// that is there: a 500, where one that is not was a 404.
		for (const token of [5, null, ['x'], { token: TOKEN }, 'not it']) {
			for (const id of [w.requestId, 99999]) {
				const res = await api('POST', `/api/requests/${id}/confirm`, { body: { token } });
				expect({ token, id, status: res.status, body: res.body }).toEqual({ token, id, status: 404, body: NOT_VALID });
			}
		}
		// A body that is not one is the gate's 400, where it was read as no token.
		const res = await api('POST', `/api/requests/${w.requestId}/confirm`, {});
		expect(res.status).toBe(400);
		expectUnchanged(before);

		const confirmed = await api('POST', `/api/requests/${w.requestId}/confirm`, { body: { token: TOKEN } });
		expect(confirmed.status).toBe(200);
	});

	it('does not run a backup for a body it cannot read: it was read as {}, a backup to every destination (decision 19)', async () => {
		const w = world();
		const before = snapshotDb();

		const res = await api('POST', '/api/admin/backup', { user: w.chief });

		expect(res.status).toBe(400);
		expect(res.body).toEqual({ message: 'The request body is missing or is not valid JSON' });
		expectUnchanged(before);
	});

	it('keeps the backup settings it is not sent, and a secret sent back masked, where it wrote the defaults over them (decision 19, R10)', async () => {
		const w = world();
		const box = { type: 'sftp', name: 'Box', host: 'box.example.test', port: 22, username: 'backup', password: 'the-real-one', remotePath: '/b' };
		const stored = { schedule: 'daily', scheduleTime: '03:30', scheduleDay: 2, retention: 9, destinations: [box], notifyOnFailure: true, notifyEmail: 'ops@example.test' };
		db.insert(settings).values({ key: 'backup_config', value: JSON.stringify(stored) }).run();
		const config = () => JSON.parse(db.select().from(settings).where(eq(settings.key, 'backup_config')).get()!.value);

		const kept = await api('PUT', '/api/admin/backup', { user: w.chief, body: { retention: 3 } });
		expect(kept.status, JSON.stringify(kept.body)).toBe(200);
		expect(config()).toEqual({ ...stored, retention: 3 });

		// The page sends the destinations as it was given them: the secret masked, and a field of its own that is not kept.
		// The host in other case and spacing, and the port as text, are the same destination, so the secret is kept (card 2190).
		const page = await api('GET', '/api/admin/backup', { user: w.chief });
		const shown = page.body.destinations[0];
		expect(shown.password).toBe('••••••••');
		const saved = await api('PUT', '/api/admin/backup', {
			user: w.chief,
			body: { scheduleTime: '', destinations: [{ ...shown, host: ' BOX.example.test ', port: '22', extra: 'not kept' }] }
		});
		expect(saved.status, JSON.stringify(saved.body)).toBe(200);
		expect(config()).toEqual({
			...stored,
			retention: 3,
			// Empty is 02:00, as it was.
			scheduleTime: '02:00',
			// The host as it was saved with the secret, which is kept (the review-fix pass's S1).
			destinations: [{ ...box, port: 22 }]
		});
	});

	it('saves only the mail settings it knows, each by its rule, and keeps a value already stored when it is sent back (R10)', async () => {
		const w = world();
		// Stored before the rules: a sender with no domain.
		db.insert(settings).values([
			{ key: 'smtp_host', value: 'smtp.example.test' },
			{ key: 'smtp_from_address', value: 'board' }
		]).run();
		const stored = () => Object.fromEntries(db.select().from(settings).all().map((row) => [row.key, row.value]));

		const res = await api('PUT', '/api/admin/smtp', {
			user: w.chief,
			body: { host: 'smtp.example.test', port: '587', allowInsecure: false, fromAddress: 'board', fromName: 'The Board', evil: 'x', appUrl: 'https://kanban.example.test/' }
		});

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(stored()).toEqual({
			smtp_host: 'smtp.example.test',
			smtp_port: '587',
			smtp_allow_insecure: 'false',
			smtp_from_address: 'board',
			smtp_from_name: 'The Board',
			app_url: 'https://kanban.example.test'
		});
		// Changed to another that is no address, it is refused.
		expect((await api('PUT', '/api/admin/smtp', { user: w.chief, body: { fromAddress: 'boards' } })).status).toBe(400);
	});

	it('stores a key’s expiry in one form, in UTC, so that it compares as the time it names (R13)', async () => {
		const w = world();
		db.update(users).set({ passwordHash: await makePasswordHash('the password', 'known') }).where(eq(users.id, w.owner.id)).run();

		const res = await api('POST', '/api/account/api-keys', {
			user: w.owner,
			body: key({ expiresAt: '2099-01-01T09:30:00+02:00' }),
			headers: SESSION
		});

		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.expiresAt).toBe('2099-01-01 07:30:00');
		expect(db.select({ expiresAt: apiKeys.expiresAt }).from(apiKeys).get()).toEqual({ expiresAt: '2099-01-01 07:30:00' });
	});

	it('holds a username and an email to POST’s rules on PUT /api/users/:id, and answers a duplicate 409 where it was a 500 (decision 14)', async () => {
		const w = world();
		const before = snapshotDb();
		const change = (body: unknown) => api('PUT', ofOwner(w), { user: w.admin, body });

		const taken = await change({ username: 'outsider' });
		expect(taken.status, JSON.stringify(taken.body)).toBe(409);
		expect(taken.body).toEqual({ message: 'Username already taken' });
		const inUse = await change({ email: 'OUTSIDER@example.test' });
		expect(inUse.status, JSON.stringify(inUse.body)).toBe(409);
		expect(inUse.body).toEqual({ message: 'Email already in use' });
		expectUnchanged(before);

		// Trimmed, where it was stored with its spaces; the account's own name is no clash.
		const renamed = await change({ username: '  Owner Two  ', email: ' Owner@Example.test ' });
		expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
		expect(renamed.body).toMatchObject({ username: 'Owner Two', email: 'owner@example.test' });
		expect((await change({ username: 'Owner Two' })).status).toBe(200);

		// A name stored before the rule, sent back unchanged, is kept (decision 8).
		db.update(users).set({ username: 'x' }).where(eq(users.id, w.owner.id)).run();
		const kept = await change({ username: 'x', emoji: '🦊' });
		expect(kept.status, JSON.stringify(kept.body)).toBe(200);
		expect(kept.body).toMatchObject({ username: 'x', emoji: '🦊' });
	});

	it('reads what the rules allow as they say: a number written as text, trimmed, empty text as its default', async () => {
		const w = world();

		// A schedule's empty time is 09:00, as the scheduler reads it.
		const made = await api('POST', '/api/report-schedules', { user: w.owner, body: schedule(w, { name: ' Monday ', timeOfDay: '', dayOfWeek: '1' }) });
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		expect(made.body).toMatchObject({ name: 'Monday', timeOfDay: '09:00', dayOfWeek: 1, detailLevel: 'detailed', statusFilter: 'all' });

		const team = await api('POST', '/api/teams', { user: w.owner, body: { name: '  Platform  ' } });
		expect(team.status).toBe(201);
		expect(team.body).toMatchObject({ name: 'Platform', emoji: '🏢' });

		const asking = await api('POST', '/api/requests', { user: w.owner, body: asked(w, { title: '  Faster boards  ', priority: 'HIGH' }) });
		expect(asking.status, JSON.stringify(asking.body)).toBe(201);
		expect(asking.body).toMatchObject({ title: 'Faster boards', priority: 'high' });
	});

	it('reads the audit and system logs’ limit and offset as whole numbers held to their range (decision 17)', async () => {
		const w = world();
		const pagination = async (path: string) => (await api('GET', path, { user: w.admin })).body.pagination;

		// -1 answered every entry, and 2.5 was a 500 from SQLite.
		expect(await pagination('/api/audit?limit=-1&offset=-5')).toMatchObject({ limit: 1, offset: 0 });
		expect(await pagination('/api/audit?limit=2.5&offset=1.9')).toMatchObject({ limit: 2, offset: 1 });
		expect(await pagination('/api/audit?limit=9999&offset=ten')).toMatchObject({ limit: 500, offset: 0 });
		expect(await pagination('/api/logs?limit=-1&offset=-5')).toMatchObject({ limit: 1, offset: 0 });
		expect(await pagination('/api/logs?limit=99999&offset=2.5')).toMatchObject({ limit: 1000, offset: 2 });
		expect(await pagination('/api/logs?limit=many')).toMatchObject({ limit: 200, offset: 0 });
	});

	it('answers 404 for a board that is not there to everyone on GET /api/boards/:id/cards and /api/activity, and only then 403 (decision 10)', async () => {
		const w = world();
		const PATHS = ['/api/boards/99999/cards', '/api/activity?boardId=99999'];
		for (const path of PATHS) {
			for (const user of [w.outsider, w.admin]) {
				// Everyone but an administrator was answered 403, and an administrator an empty list.
				const res = await api('GET', path, { user });
				expect({ path, user: user.username, status: res.status, body: res.body }).toEqual({
					path,
					user: user.username,
					status: 404,
					body: { message: 'Board not found' }
				});
			}
		}
		for (const path of [`/api/boards/${w.boardId}/cards`, `/api/activity?boardId=${w.boardId}`]) {
			expect((await api('GET', path, { user: w.outsider })).body).toEqual({ message: 'No access to this board' });
		}
	});

	it('reads the status of GET /api/milestones as open or closed, as the API’s twin reads it', async () => {
		const w = world();

		// Any other text matched no milestone, and was an empty list.
		const res = await api('GET', '/api/milestones?status=done', { user: w.owner });
		expect(res.status).toBe(400);
		expect(res.body).toEqual({ message: 'status must be open or closed' });
		expect((await api('GET', '/api/milestones?status=open', { user: w.owner })).status).toBe(200);
	});
});

describe('the review fixes to card 2117’s slices 2 to 5 (version 1.7)', () => {
	type World = {
		/** Owns boards A and B: may edit both, and neither made the cross-board goal nor is an administrator. */
		owner: SessionUser;
		admin: SessionUser;
		/** The superadmin. */
		chief: SessionUser;
		boardId: number;
		columnId: number;
		otherColumnId: number;
		cardId: number;
		/** A cross-board goal an administrator made, with the card in it. */
		goalId: number;
		/** Board A's own milestone, which the owner may change. */
		milestoneId: number;
		/** A category of board A, one of board B, and one of no board. */
		categoryId: number;
		otherCategoryId: number;
		sharedCategoryId: number;
	};

	function world(): World {
		const owner = makeUser({ username: 'owner' });
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		const A = makeBoard({ owner, name: 'A' });
		const B = makeBoard({ owner, name: 'B' });
		const card = makeCard(A.cols['To Do']);
		const category = (boardId: number | null, name: string) => db.insert(categories).values({ boardId, name }).returning().get().id;
		return {
			owner,
			admin,
			chief,
			boardId: A.board.id,
			columnId: A.cols['To Do'].id,
			otherColumnId: B.cols['To Do'].id,
			cardId: card.id,
			goalId: makeMilestone({ createdBy: admin, cards: [card] }).id,
			milestoneId: makeMilestone({ board: A.board, createdBy: owner }).id,
			categoryId: category(A.board.id, 'A category'),
			otherCategoryId: category(B.board.id, 'B category'),
			sharedCategoryId: category(null, 'Shared category')
		};
	}

	beforeEach(resetDb);

	const milestoneOf = (cardId: number) => db.select({ milestoneId: cards.milestoneId }).from(cards).where(eq(cards.id, cardId)).get()!.milestoneId;

	it('takes no card out of a goal the caller may not change by putting it in another, on the card window’s route (R5)', async () => {
		const w = world();
		const before = snapshotDb();
		const patch = (id: number, body: object) => api('PATCH', `/api/milestones/${id}`, { user: w.owner, body: { cardId: w.cardId, ...body } });

		// The card window: another goal, then None. The first moved the card out of
		// the administrator's goal into board A's, and the second took it out of
		// that one, which the owner may change: out of a goal they could not touch.
		const another = await patch(w.milestoneId, { attach: true });
		expect(another.status, JSON.stringify(another.body)).toBe(403);
		expect(another.body).toEqual({ message: 'No edit access to this milestone' });
		// Refused, the window shows the goal the card is still in, and None names that one.
		expect((await patch(w.goalId, { attach: false })).status).toBe(403);
		// None named through board A's milestone, as the window would have sent it had the first been taken.
		expect((await patch(w.milestoneId, { attach: false })).body).toEqual({ message: 'Card is not in this milestone' });
		expectUnchanged(before);

		// The goal's maker, or an administrator, can.
		const moved = await api('PATCH', `/api/milestones/${w.milestoneId}`, { user: w.admin, body: { cardId: w.cardId, attach: true } });
		expect(moved.status, JSON.stringify(moved.body)).toBe(200);
		expect(milestoneOf(w.cardId)).toBe(w.milestoneId);
	});

	it('takes no card out of a goal the caller may not change by putting it in another, through the API (R5)', async () => {
		const w = world();
		const before = snapshotDb();

		const one = await api('POST', `/api/v1/milestones/${w.milestoneId}/cards`, { user: w.owner, body: { cardId: w.cardId } });
		expect(one.status, JSON.stringify(one.body)).toBe(403);
		expect(one.body).toEqual({ message: 'No edit access to this milestone' });

		const viaCard = await api('PUT', `/api/v1/cards/${w.cardId}`, { user: w.owner, body: { milestoneId: w.milestoneId } });
		expect(viaCard.status, JSON.stringify(viaCard.body)).toBe(403);
		expect(viaCard.body).toEqual({ message: 'No edit access to this milestone' });
		expectUnchanged(before);

		const out = await api('PUT', `/api/v1/cards/${w.cardId}`, { user: w.admin, body: { milestoneId: w.milestoneId } });
		expect(out.status, JSON.stringify(out.body)).toBe(200);
		expect(out.body.milestoneId).toBe(w.milestoneId);
	});

	it('lists a card in a goal the caller may not change under the batch’s problems, and moves none (R5)', async () => {
		const w = world();
		const column = db.select().from(columns).where(eq(columns.id, w.columnId)).get()!;
		const free = makeCard(column);
		const before = snapshotDb();

		const batch = await api('POST', `/api/v1/milestones/${w.milestoneId}/cards/bulk`, { user: w.owner, body: { cardIds: [free.id, w.cardId] } });

		expect(batch.status, JSON.stringify(batch.body)).toBe(409);
		expect(batch.body.problems).toEqual([{ cardId: w.cardId, reason: `No edit access to milestone #${w.goalId}, which holds card #${w.cardId}` }]);
		expect(batch.body.attached).toBe(0);
		expectUnchanged(before);

		// An administrator's is moved, and named as moved.
		const moved = await api('POST', `/api/v1/milestones/${w.milestoneId}/cards/bulk`, { user: w.admin, body: { cardIds: [free.id, w.cardId] } });
		expect(moved.status, JSON.stringify(moved.body)).toBe(200);
		expect(moved.body.movedFromOtherGoal).toEqual([{ cardId: w.cardId, title: expect.any(String), fromMilestoneId: w.goalId }]);
	});

	it('restores a card before it puts it in a milestone, and keeps it archived when the milestone is refused (fault 14)', async () => {
		const w = world();
		const column = db.select().from(columns).where(eq(columns.id, w.columnId)).get()!;
		const stamp = '2026-10-01 00:00:00';
		const archived = makeCard(column, { archivedAt: stamp });

		// It was refused as archived: the milestone was set before the card was restored.
		const both = await api('PUT', `/api/v1/cards/${archived.id}`, { user: w.owner, body: { archivedAt: null, milestoneId: w.milestoneId } });
		expect(both.status, JSON.stringify(both.body)).toBe(200);
		expect(both.body).toMatchObject({ archivedAt: null, milestoneId: w.milestoneId });

		// A milestone refused undoes the restore with it.
		const again = makeCard(column, { archivedAt: stamp });
		const before = snapshotDb();
		const refusedGoal = await api('PUT', `/api/v1/cards/${again.id}`, { user: w.owner, body: { archivedAt: null, milestoneId: w.goalId } });
		expect(refusedGoal.status, JSON.stringify(refusedGoal.body)).toBe(403);
		expectUnchanged(before);
	});

	it('lets a move to another board decide the category the card held, and checks a new one against that board', async () => {
		const w = world();
		const column = db.select().from(columns).where(eq(columns.id, w.columnId)).get()!;
		const move = (cardId: number, categoryId: number | null) =>
			api('PUT', `/api/cards/${cardId}`, { user: w.owner, body: { title: 'Moved', columnId: w.otherColumnId, categoryId } });

		// The card window sends the category back with the move: board A's was written over the move's clearing.
		const own = makeCard(column, { categoryId: w.categoryId });
		const cleared = await move(own.id, w.categoryId);
		expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
		expect(cleared.body).toMatchObject({ columnId: w.otherColumnId, categoryId: null, title: 'Moved' });

		// A shared one follows the card, as the move keeps it.
		const shared = makeCard(column, { categoryId: w.sharedCategoryId });
		expect((await move(shared.id, w.sharedCategoryId)).body).toMatchObject({ columnId: w.otherColumnId, categoryId: w.sharedCategoryId });

		// A different one sent is held to the board the card ends on: board A's is not one of B's.
		const wrong = makeCard(column);
		const before = snapshotDb();
		const refused = await move(wrong.id, w.categoryId);
		expect(refused.status, JSON.stringify(refused.body)).toBe(404);
		expect(refused.body).toEqual({ message: 'Category not found on this board' });
		expectUnchanged(before);
		const other = makeCard(column, { categoryId: w.categoryId });
		const filed = await move(other.id, w.otherCategoryId);
		expect(filed.status, JSON.stringify(filed.body)).toBe(200);
		expect(filed.body).toMatchObject({ columnId: w.otherColumnId, categoryId: w.otherCategoryId });
	});

	it('offers the shared categories in All Tasks’ card window, as R3 says', () => {
		const page = readFileSync(join(ROOT, 'src/routes/all/+page.svelte'), 'utf8');

		expect(page).toContain('categories={data.categories.filter((c: any) => c.boardId === editingBoardId || c.boardId === null) as any}');
	});

	it('answers a save of the mail settings with nothing it knows 400, as the backup settings answer one', async () => {
		const w = world();
		const before = snapshotDb();

		for (const body of [{}, { evil: 'x' }]) {
			const res = await api('PUT', '/api/admin/smtp', { user: w.chief, body });
			expect({ body, status: res.status, answer: res.body }).toEqual({ body, status: 400, answer: { message: 'No valid fields to update' } });
		}
		expectUnchanged(before);
		expect((await api('PUT', '/api/admin/smtp', { user: w.chief, body: { appUrl: '' } })).status).toBe(200);
	});

	it('refuses a report whose period ends before it starts, and reads a bare date as the whole day', async () => {
		const w = world();
		const before = snapshotDb();
		const report = { scope: 'board', scopeId: w.boardId };

		for (const route of ['/api/reports', '/api/reports/email']) {
			const res = await api('POST', route, {
				user: w.owner,
				body: { ...report, periodStart: '2026-10-08', periodEnd: '2026-10-01', recipients: ['a@example.test'] }
			});
			expect({ route, status: res.status, answer: res.body }).toEqual({ route, status: 400, answer: { message: 'periodStart is after periodEnd' } });
		}
		const timed = await api('POST', '/api/reports', { user: w.owner, body: { ...report, periodStart: '2026-10-08T12:00:00Z', periodEnd: '2026-10-08T11:59:59Z' } });
		expect(timed.body).toEqual({ message: 'periodStart is after periodEnd' });
		expectUnchanged(before);

		// One day, from a date to the same date, or from its noon to its date, is that day.
		expect((await api('POST', '/api/reports', { user: w.owner, body: { ...report, periodStart: '2026-10-08', periodEnd: '2026-10-08' } })).status).toBe(200);
		expect((await api('POST', '/api/reports', { user: w.owner, body: { ...report, periodStart: '2026-10-08T12:00:00Z', periodEnd: '2026-10-08' } })).status).toBe(200);
	});

	it('holds the texts without a limit to one: a requester’s name, a rejection’s reason, the mail settings and a backup destination’s fields', async () => {
		const w = world();
		const long = (n: number) => 'x'.repeat(n);
		const request = db
			.insert(taskRequests)
			.values({ targetType: 'user', targetId: w.owner.id, title: 'A dark theme', desiredBoardId: w.boardId })
			.returning()
			.get();
		const before = snapshotDb();
		const box = (more: object) => ({ destinations: [{ name: 'Box', type: 'sftp', ...more }] });
		const CASES: [Method, string, SessionUser, unknown, string][] = [
			['POST', '/api/requests', w.owner, { targetType: 'user', targetId: w.owner.id, desiredBoardId: w.boardId, title: 'A', requesterName: long(201) }, 'requesterName must be at most 200 characters'],
			['PATCH', `/api/requests/${request.id}`, w.owner, { action: 'reject', rejectReason: long(10001) }, 'rejectReason must be at most 10000 characters'],
			['PUT', '/api/admin/smtp', w.chief, { host: long(2049) }, 'host must be at most 2048 characters'],
			['PUT', '/api/admin/smtp', w.chief, { user: long(2049) }, 'user must be at most 2048 characters'],
			['PUT', '/api/admin/smtp', w.chief, { fromName: long(201) }, 'fromName must be at most 200 characters'],
			['PUT', '/api/admin/backup', w.chief, box({ host: long(2049) }), 'destinations[0].host must be at most 2048 characters'],
			['PUT', '/api/admin/backup', w.chief, { destinations: [{ name: long(2049), type: 's3' }] }, 'destinations[0].name must be at most 2048 characters'],
			['PUT', '/api/admin/backup', w.chief, box({ privateKey: long(20001) }), 'destinations[0].privateKey must be at most 20000 characters'],
			['POST', '/api/admin/backup/test', w.chief, { name: 'Box', type: 's3', bucket: long(2049) }, 'bucket must be at most 2048 characters']
		];
		const answers = [];
		for (const [method, path, user, body] of CASES) {
			const res = await api(method, path, { user, body });
			answers.push({ path, status: res.status, answer: res.body });
		}
		// Every case at once, so that each limit is seen to hold apart from the others.
		expect(answers).toEqual(CASES.map(([, path, , , message]) => ({ path, status: 400, answer: { message } })));
		expectUnchanged(before);

		// A pasted key, longer than 2,048, is kept: one of 4,096 bits is about 3,300 characters.
		const key = await api('PUT', '/api/admin/backup', { user: w.chief, body: box({ host: 'box.example.test', privateKey: long(3300) }) });
		expect(key.status, JSON.stringify(key.body)).toBe(200);
	});

	it('answers 404 for a request deleted that is not there, where it was answered as deleted', async () => {
		const w = world();
		const before = snapshotDb();

		const res = await api('DELETE', '/api/requests/99999', { user: w.admin });

		expect(res.status).toBe(404);
		expect(res.body).toEqual({ message: 'Request not found' });
		expectUnchanged(before);
	});

	it('reads the card search’s exclude as an id, and the card window sends none for a card not yet made', async () => {
		const w = world();

		// `2.5` and `5abc` were read by Number() as something else.
		for (const exclude of ['2.5', '5abc', '0']) {
			const res = await api('GET', `/api/cards/search?q=Card&exclude=${exclude}`, { user: w.owner });
			expect({ exclude, status: res.status, answer: res.body }).toEqual({ exclude, status: 400, answer: { message: 'Invalid card ID' } });
		}
		const found = await api('GET', `/api/cards/search?q=%23${w.cardId}`, { user: w.owner });
		expect(found.status).toBe(200);
		expect(found.body.map((c: { id: number }) => c.id)).toEqual([w.cardId]);
		expect((await api('GET', `/api/cards/search?q=%23${w.cardId}&exclude=${w.cardId}`, { user: w.owner })).body).toEqual([]);

		const modal = readFileSync(join(ROOT, 'src/lib/components/CardModal.svelte'), 'utf8');
		expect(modal).toContain("const exclude = card?.id ? `&exclude=${card.id}` : '';");
		expect(modal).not.toContain('exclude=${card?.id ?? 0}');
	});

	it('reads a limit of 0 as not sent, the default, on the three logs, as it was before card 2117', async () => {
		const w = world();
		for (const [path, fallback] of [['/api/v1/audit-log', 100], ['/api/audit', 100], ['/api/logs', 200]] as const) {
			const res = await api('GET', `${path}?limit=0`, { user: w.admin });
			expect({ path, limit: res.body.pagination?.limit }).toEqual({ path, limit: fallback });
		}
	});

	/**
	 * The page sweep: what a page sends that the readers now refuse, put right
	 * where the page builds it. Each is read from the source, as
	 * tests/page-failures.test.ts reads the pages.
	 */
	describe('what the pages send, held to the readers', () => {
		const source = (path: string) => readFileSync(join(ROOT, path), 'utf8');

		it('sends a schedule’s recipients as addresses separated by commas, and its name trimmed', () => {
			const page = source('src/routes/reports/+page.svelte');
			const create = page.slice(page.indexOf('async function createSchedule()'), page.indexOf('async function toggleSchedule'));

			// A line or a `;` between two addresses, which the box takes, is refused: `recipients holds "a@x.test\nb@x.test", ...`.
			expect(create).toMatch(/recipients: schedRecipients\s*\.split\(\/\[,;\\n\]\/\)\s*\.map\(\(e\) => e\.trim\(\)\)\s*\.filter\(\(e\) => e\.length > 0\)\s*\.join\(', '\)/);
			// A name of spaces alone was sent as it was, and is refused once trimmed.
			expect(create).toContain("name: schedName.trim() || 'Scheduled Report'");
		});

		it('sends no retention for a box cleared, which bound null, where null is refused', () => {
			expect(source('src/routes/admin/+page.svelte')).toContain('retention: backupRetention ?? undefined,');
		});

		it('holds what the card window and the board’s menu make from a card’s title to the limits of what they make', () => {
			const modal = source('src/lib/components/CardModal.svelte');
			// A board's name and a template's are at most 200; a title is up to 500.
			expect(modal).toContain("let newSubBoardName = $state((card?.title || '').slice(0, 200));");
			expect(modal).toContain('templateName = title.slice(0, 200);');
			expect(modal).not.toContain('templateName = title;');
			expect(modal.match(/placeholder="Link to a sub-board\.\.\." maxlength="200"/g)).toHaveLength(2);
			// A subtask's description stored as null is no text, which a template's subtask must hold.
			expect(modal).toContain("description: s.description ?? '', priority: priorityToCopy(s.priority)");

			const actions = source('src/lib/board/card-actions.ts');
			expect(actions).toContain("title: `${card.title.slice(0, 500 - ' (Copy)'.length)} (Copy)`,");
			expect(actions).toContain('name: name.slice(0, 200),');

			// The dashboard made the parent card, and then had the board refused.
			expect(source('src/routes/+page.svelte')).toContain('placeholder="Sub-board name..." maxlength="200"');
		});

		it('lets no one type past the new limits of a request: the requester’s name and the reason for a rejection', () => {
			expect(source('src/routes/request/+page.svelte')).toContain('placeholder="Your name" class="form-input" maxlength="200"');
			expect(source('src/routes/inbox/+page.svelte')).toContain('bind:value={rejectModal.reason} class="modal-textarea" rows="3" maxlength="10000"');
		});

		it('refuses what the pages sent before they were put right, so the fixes are needed', async () => {
			const w = world();
			const before = snapshotDb();
			// Recipients one to a line were refused here too, and are taken now: see the second fix pass's block below.
			const CASES: [string, unknown, string][] = [
				['/api/report-schedules', { name: '   ', scope: 'board', scopeId: w.boardId, frequency: 'weekly' }, 'Missing required fields: name, scope, frequency'],
				['/api/templates', { boardId: w.boardId, name: 'T', title: 'T', subtasks: [{ title: 'A step', description: null, priority: 'medium' }] }, 'subtasks[0].description must be text'],
				['/api/templates', { boardId: w.boardId, name: 'x'.repeat(201), title: 'T' }, 'name must be at most 200 characters'],
				['/api/boards', { name: 'x'.repeat(201) }, 'name must be at most 200 characters']
			];
			const answers = [];
			for (const [path, body] of CASES) {
				const res = await api('POST', path, { user: w.owner, body });
				answers.push({ path, status: res.status, answer: res.body });
			}
			expect(answers).toEqual(CASES.map(([path, , message]) => ({ path, status: 400, answer: { message } })));
			expectUnchanged(before);
		});
	});

	type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
});

/**
 * The second fix pass (version 1.8): what a page sent, and was taken before
 * card 2117, is taken again, read the way the old code effectively read it.
 */
describe('the second fix pass to card 2117’s slices 2 to 5 (version 1.8)', () => {
	type World = { owner: SessionUser; chief: SessionUser; boardId: number; columnId: number; categoryId: number; otherCategoryId: number; sharedCategoryId: number };

	function world(): World {
		const owner = makeUser({ username: 'owner' });
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		const A = makeBoard({ owner, name: 'A' });
		const B = makeBoard({ owner, name: 'B' });
		const category = (boardId: number | null, name: string) => db.insert(categories).values({ boardId, name }).returning().get().id;
		return {
			owner,
			chief,
			boardId: A.board.id,
			columnId: A.cols['To Do'].id,
			categoryId: category(A.board.id, 'A category'),
			otherCategoryId: category(B.board.id, 'B category'),
			sharedCategoryId: category(null, 'Shared category')
		};
	}

	beforeEach(resetDb);
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const source = (path: string) => readFileSync(join(ROOT, path), 'utf8');
	const setting = (key: string) => db.select().from(settings).where(eq(settings.key, key)).get()?.value;

	it('reads addresses separated by commas, semicolons or lines, and hands them back separated by commas, for every caller', async () => {
		const text = (sent: unknown) => outcome(() => readEmailText({ to: sent }, 'to', {}));
		expect(text('a@example.test;b@example.test\nc@example.test\r\n, d@example.test ;')).toEqual(
			handed('a@example.test, b@example.test, c@example.test, d@example.test')
		);
		expect(text(' ;\n, ')).toEqual(handed(''));
		expect(text('a@example.test; nobody')).toEqual(refused('to holds "nobody", which is not an email address'));

		// A report schedule, made and changed, as the reports page and the API send one.
		const w = world();
		const made = await api('POST', '/api/report-schedules', {
			user: w.owner,
			body: { name: 'Weekly', scope: 'board', scopeId: w.boardId, frequency: 'weekly', recipients: 'a@example.test\nb@example.test; c@example.test' }
		});
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		const recipients = () => db.select({ recipients: reportSchedules.recipients }).from(reportSchedules).get()!.recipients;
		expect(recipients()).toBe('a@example.test, b@example.test, c@example.test');
		const id = db.select({ id: reportSchedules.id }).from(reportSchedules).get()!.id;
		const changed = await api('PUT', `/api/report-schedules/${id}`, { user: w.owner, body: { recipients: 'x@example.test;y@example.test' } });
		expect(changed.status, JSON.stringify(changed.body)).toBe(200);
		expect(recipients()).toBe('x@example.test, y@example.test');
	});

	it('takes more than one address for the backup failure email, as the mailer sent to each, stored separated by commas', async () => {
		const w = world();
		const res = await api('PUT', '/api/admin/backup', { user: w.chief, body: { notifyEmail: 'ops@example.test; chief@example.test' } });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(JSON.parse(setting('backup_config')!).notifyEmail).toBe('ops@example.test, chief@example.test');
		// Empty is none, as it was.
		expect((await api('PUT', '/api/admin/backup', { user: w.chief, body: { notifyEmail: '' } })).status).toBe(200);
		expect(JSON.parse(setting('backup_config')!).notifyEmail).toBe('');
	});

	it('completes an App URL typed with no scheme as getAppUrl() reads it, stores it completed, and refuses what is still no host', async () => {
		const w = world();
		// What getAppUrl() made of one stored as typed, before card 2117.
		db.insert(settings).values({ key: 'app_url', value: 'kanban.example.test' }).run();
		const read = getAppUrl();
		expect(read).toBe('http://kanban.example.test');

		const typed = await api('PUT', '/api/admin/smtp', { user: w.chief, body: { appUrl: 'kanban.example.test' } });
		expect(typed.status, JSON.stringify(typed.body)).toBe(200);
		expect(setting('app_url')).toBe(read);
		expect(getAppUrl()).toBe(read);
		expect((await api('PUT', '/api/admin/smtp', { user: w.chief, body: { appUrl: ' localhost:3000/ ' } })).status).toBe(200);
		expect(setting('app_url')).toBe('http://localhost:3000');

		const before = snapshotDb();
		for (const appUrl of ['ftp://kanban.example.test', '/kanban', 'mailto:a@example.test', 'kanban example', 'javascript:alert(1)']) {
			const res = await api('PUT', '/api/admin/smtp', { user: w.chief, body: { appUrl } });
			expect({ appUrl, status: res.status, answer: res.body }).toEqual({ appUrl, status: 400, answer: { message: 'appUrl must be an http or https address' } });
		}
		expectUnchanged(before);
		// Only the App URL is completed: a webhook's address is read as it was.
		expect(outcome(() => readUrl({ url: 'hooks.example.test' }, 'url', {}))).toEqual(refused('url must be an http or https address'));
	});

	it('takes an SFTP destination’s port cleared, null, as the default, 22, and still refuses the mail settings’ port cleared', async () => {
		const w = world();
		const box = { type: 'sftp', name: 'Box', host: 'box.example.test', port: null, username: 'backup', remotePath: '/b' };
		const res = await api('PUT', '/api/admin/backup', { user: w.chief, body: { destinations: [box] } });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const stored = JSON.parse(setting('backup_config')!).destinations[0];
		expect(stored.port).toBeNull();
		// The destination connects to 22, as `port || 22` did, once its host key
		// is confirmed: with none it connects nowhere (card 2250, R7).
		expect(new SftpDestination({ ...stored, hostKey: `ssh-ed25519 ${FINGERPRINT}` })['getConnectConfig']().port).toBe(22);

		const mail = await api('PUT', '/api/admin/smtp', { user: w.chief, body: { port: null } });
		expect({ status: mail.status, answer: mail.body }).toEqual({ status: 400, answer: { message: 'port must be a whole number' } });
	});

	it('saves an SFTP host key in one form, the type and the fingerprint, from either form an administrator copies, and empty for none (card 2250, R5)', async () => {
		const w = world();
		const box = { type: 'sftp', name: 'Box', host: 'box.example.test', port: 22, username: 'backup', remotePath: '/b' };
		const savedAs = async (hostKey: unknown) => {
			const res = await api('PUT', '/api/admin/backup', { user: w.chief, body: { destinations: [{ ...box, hostKey }] } });
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			return JSON.parse(setting('backup_config')!).destinations[0].hostKey;
		};

		// The line ssh-keygen -l prints, pasted whole: the bits and the comment dropped.
		expect(await savedAs(`256 ${FINGERPRINT} root@nas (ED25519)`)).toBe(`ssh-ed25519 ${FINGERPRINT}`);
		expect(await savedAs(`384 ${FINGERPRINT} root@nas.example.test (ECDSA)`)).toBe(`ecdsa-sha2-nistp384 ${FINGERPRINT}`);
		expect(await savedAs(`256 ${FINGERPRINT} (ECDSA)`)).toBe(`ecdsa-sha2-nistp256 ${FINGERPRINT}`);
		expect(await savedAs(`521 ${FINGERPRINT} a comment (with spaces) (ECDSA)`)).toBe(`ecdsa-sha2-nistp521 ${FINGERPRINT}`);
		expect(await savedAs(`3072 ${FINGERPRINT} root@nas (RSA)\n`)).toBe(`ssh-rsa ${FINGERPRINT}`);
		expect(await savedAs(`1024 ${FINGERPRINT} root@nas (RSA)`)).toBe(`ssh-rsa ${FINGERPRINT}`);
		// The type and the fingerprint, with spaces and tabs around and between them.
		expect(await savedAs(` \tssh-ed25519   ${FINGERPRINT} `)).toBe(`ssh-ed25519 ${FINGERPRINT}`);
		expect(await savedAs(`ssh-rsa ${FINGERPRINT}`)).toBe(`ssh-rsa ${FINGERPRINT}`);
		// Empty for none.
		expect(await savedAs('')).toBe('');
		expect(await savedAs('  ')).toBe('');
	});

	it('copies to a duplicate only the stored values the server takes, and leaves the rest to its defaults', () => {
		const w = world();
		expect(['low', 'High', 'critical', 'urgent', '', null].map(priorityToCopy)).toEqual(['low', 'High', 'critical', undefined, undefined, undefined]);
		expect(['#a1B2c3', 'red', '#fff', null].map(colourToCopy)).toEqual(['#a1B2c3', '', '', '']);
		expect(['2026-10-14', '2026-10-14T09:00:00Z', '2026-02-30', 'soon', null].map(dueDateToCopy)).toEqual(['2026-10-14', '2026-10-14', undefined, undefined, undefined]);
		const listed = db.select({ id: categories.id, boardId: categories.boardId }).from(categories).all();
		expect([w.categoryId, w.sharedCategoryId, w.otherCategoryId, 9999, null].map((id) => categoryToCopy(id, w.boardId, listed))).toEqual([
			w.categoryId,
			w.sharedCategoryId,
			undefined,
			undefined,
			undefined
		]);
	});

	it('duplicates a card holding values stored before the rules, with its subtasks, where the copy was refused', async () => {
		const w = world();
		// The board page's requests, answered by the routes themselves.
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			const res = await api(init.method as Method, url, { user: w.owner, body: JSON.parse(String(init.body)) });
			return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
		});
		const step = { id: 1, cardId: 1, title: 'A step', description: null, priority: 'High', colorTag: '#fff', dueDate: 'soon', completed: true, position: 0 };
		const card = {
			id: 1,
			columnId: w.columnId,
			title: 'Legacy',
			description: null,
			priority: 'urgent',
			colorTag: 'red',
			categoryId: w.otherCategoryId,
			dueDate: '2026-10-14T09:00:00Z',
			subtasks: [step]
		} as unknown as CardType;
		const columns = [{ id: w.columnId, cards: [card] }] as unknown as ColumnType[];
		const listed = db.select({ id: categories.id, boardId: categories.boardId }).from(categories).all();

		expect(await duplicateCard(card, columns, w.boardId, listed)).toEqual({ title: 'Legacy', failure: null });
		const copy = db.select().from(cards).where(eq(cards.title, 'Legacy (Copy)')).get()!;
		expect({ priority: copy.priority, colorTag: copy.colorTag, categoryId: copy.categoryId, dueDate: copy.dueDate }).toEqual({
			priority: 'medium',
			colorTag: '',
			categoryId: null,
			dueDate: '2026-10-14'
		});
		const copied = db.select().from(subtasks).where(eq(subtasks.cardId, copy.id)).get()!;
		expect({ priority: copied.priority, colorTag: copied.colorTag, dueDate: copied.dueDate }).toEqual({ priority: 'high', colorTag: '', dueDate: null });

		// One holding what the rules take keeps it: the board's category, and a shared one.
		for (const categoryId of [w.categoryId, w.sharedCategoryId]) {
			const kept = { ...card, title: `Kept ${categoryId}`, priority: 'low', colorTag: '#a1b2c3', categoryId, dueDate: '2026-11-01', subtasks: [] } as CardType;
			expect(await duplicateCard(kept, [{ ...columns[0], cards: [kept] }] as ColumnType[], w.boardId, listed)).toEqual({ title: kept.title, failure: null });
			const made = db.select().from(cards).where(eq(cards.title, `${kept.title} (Copy)`)).get()!;
			expect([made.priority, made.colorTag, made.categoryId, made.dueDate]).toEqual(['low', '#a1b2c3', categoryId, '2026-11-01']);
		}

		// The board page hands it the board's categories.
		expect(source('src/routes/board/[id]/+page.svelte')).toContain('cardActions.duplicateCard(card, boardColumns, data.board.id, boardCategories)');
	});

	it('saves a template from a card whose subtask holds a priority no rule allows, which is left out and is medium', async () => {
		const w = world();
		// The card window leaves the priority out, as `priorityToCopy` hands it back.
		expect(source('src/lib/components/CardModal.svelte')).toContain("priority: priorityToCopy(s.priority) })) : [],");
		const res = await api('POST', '/api/templates', {
			user: w.owner,
			body: { boardId: w.boardId, name: 'T', title: 'T', subtasks: [{ title: 'A step', description: '', priority: priorityToCopy('urgent') }] }
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(JSON.parse(res.body.subtasksJson)).toEqual([{ title: 'A step', description: '', priority: 'medium' }]);
		// Sent as it was stored, it is refused.
		const refusedOne = await api('POST', '/api/templates', {
			user: w.owner,
			body: { boardId: w.boardId, name: 'T', title: 'T', subtasks: [{ title: 'A step', description: '', priority: 'urgent' }] }
		});
		expect(refusedOne.body).toEqual({ message: 'subtasks[0].priority must be one of: low, medium, high, critical' });
	});

	type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
});

describe('one wording for a length limit (card 2218)', () => {
	/**
	 * A length limit worded its own way, as the overrides card 2218 deleted
	 * did: `Title too long (max 500 chars)`. The readers' own words are
	 * `<name> must be at most <max> characters`, and with no override they
	 * cannot drift. The check is of the code's shape, not its words: a reader
	 * given a `max` may only be given a `says` written out in place, whose
	 * `invalid`, if it has one, is a text ending in the readers' own words with
	 * the same number. What it cannot see, and does not claim: a route that
	 * throws its own 400 (`error(400, 'Title too long')`), and a rule handed to
	 * the reader by name rather than written in the call (`readWebhookUrl`'s).
	 */
	const OWN_WORDS = /too long|\(max \d/i;

	/**
	 * The readers that refuse text over its `max` in `<name> must be at most
	 * <max> characters`, read from the module, so a new one is checked too.
	 */
	const LENGTH_READERS = (() => {
		const tree = ts.createSourceFile('request-body.ts', readFileSync(join(ROOT, 'src/lib/server/request-body.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
		return tree.statements
			.filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.body !== undefined)
			.filter((reader) => reader.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
			.filter((reader) => /must be at most \$\{[^}]+\} characters`/.test(reader.body!.getText(tree)))
			.map((reader) => reader.name!.text)
			.sort();
	})();

	/** A property's name as written: `says`, `'says'` and `['says']` alike; undefined for a spread or a name worked out. */
	function keyOf(property: ts.ObjectLiteralElementLike): string | undefined {
		const name = property.name;
		if (name === undefined) return undefined;
		if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
		if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
		return undefined;
	}

	/** `node` without brackets, `as` or `satisfies` round it. */
	function bare(node: ts.Expression): ts.Expression {
		let inner = node;
		while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner)) inner = inner.expression;
		return inner;
	}

	/**
	 * Every call of a length reader in `source` whose rule has a `max` and
	 * could word that limit its own way, as `file:line why: code`.
	 */
	function ownWords(file: string, source: string): string[] {
		const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		const found: string[] = [];
		const report = (node: ts.Node, why: string) =>
			found.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1} ${why}: ${node.getText(tree).replace(/\s+/g, ' ')}`);
		/** A text or template as written, each `${…}` kept as it is written. */
		const written = (text: ts.StringLiteralLike | ts.TemplateExpression) =>
			ts.isTemplateExpression(text)
				? text.head.text + text.templateSpans.map((span) => '${' + span.expression.getText(tree) + '}' + span.literal.text).join('')
				: text.text;
		const check = (rule: ts.ObjectLiteralExpression) => {
			const max = rule.properties.find((property) => keyOf(property) === 'max');
			if (max === undefined) return;
			// The number as the reader's words would hold it: `500`, or `${LONGEST_TEXT}`, `${max}` where a template names it.
			const held = ts.isPropertyAssignment(max) ? bare(max.initializer) : ts.isShorthandPropertyAssignment(max) ? max.name : undefined;
			const limit = held === undefined ? undefined : ts.isNumericLiteral(held) ? held.text : '${' + held.getText(tree) + '}';
			for (const property of rule.properties) if (ts.isSpreadAssignment(property)) report(property, 'a spread in the rule may carry a says');
			const says = rule.properties.find((property) => keyOf(property) === 'says');
			if (says === undefined) return;
			const given = ts.isPropertyAssignment(says) ? bare(says.initializer) : undefined;
			if (given === undefined || !ts.isObjectLiteralExpression(given)) return report(says, 'says is not written out in place');
			for (const entry of given.properties) {
				const key = keyOf(entry);
				if (key === undefined) {
					report(entry, 'a says entry whose name cannot be read');
					continue;
				}
				if (key !== 'invalid') continue;
				const text = ts.isPropertyAssignment(entry) ? bare(entry.initializer) : undefined;
				if (text === undefined || !(ts.isStringLiteralLike(text) || ts.isTemplateExpression(text))) {
					report(entry, 'invalid is not written as a text');
				} else if (limit === undefined || !written(text).endsWith(`must be at most ${limit} characters`)) {
					report(entry, `invalid does not end "must be at most ${limit} characters"`);
				}
			}
		};
		const visit = (node: ts.Node) => {
			if (ts.isCallExpression(node)) {
				const callee = bare(node.expression);
				const reader = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
				const rule = node.arguments[2] === undefined ? undefined : bare(node.arguments[2]);
				if (reader !== undefined && LENGTH_READERS.includes(reader) && rule !== undefined && ts.isObjectLiteralExpression(rule)) check(rule);
			}
			ts.forEachChild(node, visit);
		};
		visit(tree);
		return found;
	}

	const found = FILES.flatMap((file) => ownWords(file, readFileSync(join(ROOT, file), 'utf8')));

	it('no route file or server module gives a reader a length limit in its own words', () => {
		// Each line names the file, the line and why: delete the `invalid` override, so the reader's own words answer.
		expect(found).toEqual([]);
	});

	it('knows the length readers from the module itself', () => {
		expect(LENGTH_READERS).toEqual(['readEmailText', 'readReportRecipients', 'readText', 'readUrl']);
	});

	it('catches each way round the readers’ words, by shape and not by wording', () => {
		const of = (code: string) => ownWords('example.ts', code);
		// An override in other words, whatever they are.
		expect(of("readText(body, 'title', { max: 5, says: { invalid: 'Title too long (max 5 chars)' } });")).toHaveLength(1);
		expect(of("readText(body, 'title', { max: 5, says: { invalid: 'title must be shorter than 6 characters' } });")).toHaveLength(1);
		// The readers' words with the wrong number.
		expect(of("readText(body, 'title', { max: 5, says: { invalid: 'title must be at most 50 characters' } });")).toHaveLength(1);
		expect(of("readUrl(body, 'url', { max: 500, says: { invalid: 'url must be at most 1500 characters' } });")).toHaveLength(1);
		// A constant for the text, a shared says, and the says shorthand.
		expect(of("const TOO_LONG = 'Title too long'; readText(body, 'title', { max: 5, says: { invalid: TOO_LONG } });")).toHaveLength(1);
		expect(of("readText(body, 'title', { max: 5, says: SAYS }); readText(body, 'name', { max: 9, says: SAYS });")).toHaveLength(2);
		expect(of("const says = { invalid: 'Title too long' }; readText(body, 'title', { max: 5, says });")).toHaveLength(1);
		// A helper's call, for the says or for its text.
		expect(of("readEmailText(body, 'to', { max: 5, says: saysFor('to') });")).toHaveLength(1);
		expect(of("readText(body, 'title', { max: 5, says: { invalid: tooLong('title', 5) } });")).toHaveLength(1);
		// Quoted names, a whole-says text, and spreads.
		expect(of("readText(body, 'title', { 'max': 5, 'says': { 'invalid': 'Title too long' } });")).toHaveLength(1);
		expect(of("readText(body, 'title', { max: 5, ['says']: { invalid: 'Title too long' } });")).toHaveLength(1);
		expect(of("readText(body, 'name', { max: 5, says: `name too long` });")).toHaveLength(1);
		expect(of("readText(body, 'title', { ...RULE, max: 5 });")).toHaveLength(1);
		expect(of("readReportRecipients(body, 'to', { max: 5, says: { ...COMMON } });")).toHaveLength(1);
		// Each is named by file and line.
		expect(of("\n\nreadText(body, 'title', { max: 5, says: SAYS });")[0]).toMatch(/^example\.ts:3 says is not written out in place: /);
	});

	it('passes the readers’ own words, with a path in front or a named number, and what is not a length reader’s', () => {
		const of = (code: string) => ownWords('example.ts', code);
		expect(of("readText(step, 'title', { max: 500, says: { type: `${at}.title must be text`, invalid: `${at}.title must be at most 500 characters` } });")).toEqual([]);
		expect(of("readText(entry, 'name', { max: LONGEST_TEXT, says: { invalid: `${prefix}name must be at most ${LONGEST_TEXT} characters` } });")).toEqual([]);
		expect(of("readText(entry, field, { max, keep, says: { invalid: `${prefix}${field} must be at most ${max} characters` } });")).toEqual([]);
		expect(of("readText(body, 'title', { max: 5, says: { empty: 'title cannot be empty' } });")).toEqual([]);
		expect(of("readText(body, 'title', { max: 5 });")).toEqual([]);
		// No max: a minimum's words are the route's own (the password routes' SHORT).
		expect(of("readText(body, 'password', { min: 8, says: { invalid: SHORT } });")).toEqual([]);
		// Not a length reader: a number's range, a choice.
		expect(of("readNumber(body, 'port', { max: 65535, says: { invalid: 'port must be a whole number from 1 to 65535' } });")).toEqual([]);
		expect(of("readChoice(body, 'scope', { from: SCOPES, says: SCOPE });")).toEqual([]);
		// Outside the check, as said above: a route's own throw.
		expect(of("throw error(400, 'Title too long (max 500 chars)');")).toEqual([]);
	});

	it('lets no one type past a card’s or a request’s limits in the card window or the request page', () => {
		const source = (path: string) => readFileSync(join(ROOT, path), 'utf8');
		// The routes' limits the boxes hold to.
		for (const route of ['src/routes/api/cards/+server.ts', 'src/routes/api/cards/[id]/+server.ts']) {
			expect(source(route)).toMatch(/readText\(body, 'title', \{[^}]*max: 500,/);
			expect(source(route)).toMatch(/readText\(body, 'description', \{ max: 50000[ ,]/);
			expect(source(route)).toMatch(/readText\(body, 'businessValue', \{ max: 10000[ ,]/);
		}
		const requests = source('src/routes/api/requests/+server.ts');
		expect(requests).toMatch(/readText\(body, 'title', \{[^}]*max: 500,/);
		expect(requests).toContain("readText(body, 'description', { max: 10000 })");
		expect(requests).toContain("readText(body, 'businessValue', { max: 5000 })");

		const modal = source('src/lib/components/CardModal.svelte');
		expect(modal).toContain('placeholder="What needs to be done?" maxlength="500" bind:value={title}');
		expect(modal).toContain('placeholder="Add a description…" maxlength="50000" bind:value={description}');
		expect(modal).toContain('placeholder="Why is this important? What value does it deliver?" maxlength="10000" bind:value={businessValue}');
		const request = source('src/routes/request/+page.svelte');
		expect(request).toContain('placeholder="Brief summary of your request..." class="form-input" maxlength="500"');
		expect(request).toContain('rows="5" class="form-textarea" maxlength="10000"');
		expect(request).toContain('rows="3" class="form-textarea" maxlength="5000"');
	});

	it('the milestone service’s own check of a name says what the readers say', () => {
		const service = readFileSync(join(ROOT, 'src/lib/server/milestones.ts'), 'utf8');
		expect(service.split('\n').filter((line) => OWN_WORDS.test(line))).toEqual([]);
		expect(service.split("'name must be at most 200 characters'").length - 1).toBe(2);
	});
});

/** The distinct entries of `list`, sorted. */
function sortedSet(list: string[]): string[] {
	return [...new Set(list)].sort();
}
