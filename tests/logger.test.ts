/**
 * Every line of the system log is one line (card 2214).
 *
 * The logger wrote what it was given to the console, to `system_logs` and to
 * the live feed exactly as passed, and many lines carry stored names and
 * titles. A board named with a line break began a second console line, which
 * could read as anything (`[CRITICAL] [AUTH] ...`), and an ESC in it reached
 * the terminal of whoever tailed the log. `emit` now puts a space in place of
 * each C0 control character, DEL, each C1 control character, U+2028 and
 * U+2029, each bidi control, U+200B to U+200F and U+FEFF, once, in the
 * message, the context, the serialised meta and the address, so all three
 * places hold the same cleaned text. Card 2142's cleaner in startup-checks.ts
 * and backup-secrets.ts's own are now this one.
 *
 * `LOG_LEVEL` is `ERROR` under vitest (vitest.config.ts), so these log at
 * ERROR or set it for the test and put it back.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqlite } from '$lib/server/db';
import { cleanOldSystemLogs, createLogger, getRecentLogs, printable, subscribeToLogs, type LogEntry } from '$lib/server/logger';
import { stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { makeBoard, makeUser, resetDb, stepUp } from './helpers/fixtures';

beforeEach(resetDb);
afterEach(() => {
	process.env.LOG_LEVEL = 'ERROR';
	vi.restoreAllMocks();
});

const log = createLogger('TEST');
const forged = '[2026-10-15T08:00:00.000Z] [CRITICAL] [AUTH] forged';

type Row = { context: string; message: string; meta: string | null };
const rows = (context: string): Row[] =>
	sqlite.prepare('SELECT context, message, meta FROM system_logs WHERE context = ? ORDER BY id').all(context) as Row[];

/** Log through `write` with the console and the live feed watched: the lines printed and the entries heard. */
function watched(write: () => void, level: 'error' | 'log' = 'error') {
	const printed: string[] = [];
	vi.spyOn(console, level).mockImplementation((line: string) => {
		printed.push(line);
	});
	const heard: LogEntry[] = [];
	const stop = subscribeToLogs((entry) => heard.push(entry));
	try {
		write();
	} finally {
		stop();
	}
	return { printed, heard };
}

describe('printable', () => {
	it('puts one space in place of each C0 and C1 control character, DEL, U+2028 and U+2029, each bidi control, U+200B to U+200F and U+FEFF, and leaves the rest as it is', () => {
		const range = (from: number, to: number) =>
			Array.from({ length: to - from + 1 }, (_, i) => String.fromCharCode(from + i));
		const controls = [
			...range(0x00, 0x1f),
			...range(0x7f, 0x9f),
			'\u2028',
			'\u2029',
			...range(0x202a, 0x202e),
			...range(0x2066, 0x2069),
			...range(0x200b, 0x200f),
			'\ufeff'
		];
		expect(controls).toHaveLength(82);
		expect(printable(`<${controls.join('')}>`)).toBe(`<${' '.repeat(82)}>`);

		const kept = 'Plain ASCII ~ | é ñ ü \u00a0 — “quoted” 🔥 \u200a \u2010 \u2027 \u202f \u2065 \u206a \ufefe';
		expect(printable(kept)).toBe(kept.replace('\u{206a}', ' ')); // U+206A is a format character: see below.
	});

	it('puts one space in place of every other format character, \\p{Cf}, the tag characters a flag is spelt with included (card 2675, S6)', () => {
		const format = [0xad, 0x61c, 0x180e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x206a, 0x206f, 0xfff9, 0xfffa, 0xfffb, 0xe0001, 0xe0067, 0xe007f].map((code) =>
			String.fromCodePoint(code)
		);
		expect(printable(`<${format.join('')}>`)).toBe(`<${' '.repeat(format.length)}>`);
		// A flag spelt with tag characters keeps its black flag, and loses the tags it is spelt with.
		expect(printable('\u{1f3f4}\u{e0067}\u{e0062}\u{e007f}')).toBe('\u{1f3f4}   ');
	});

	it('takes what is not text as text, and does not throw', () => {
		expect(printable(undefined as unknown as string)).toBe('undefined');
		expect(printable(12 as unknown as string)).toBe('12');
	});
});

describe('a log line', () => {
	it('holding line breaks, a tab, ESC, DEL, U+0085 and U+2028 is one line on the console, and the row, the ring buffer and the live feed hold the same text', () => {
		const message = `Card "a\n${forged}\r\tb\u001b[2Jc\u007fd\u0085e\u2028f" deleted`;
		const cleaned = `Card "a ${forged}  b [2Jc d e f" deleted`;

		const { printed, heard } = watched(() => log.error(message));

		expect(printed).toHaveLength(1);
		expect(printed[0]).toMatch(/^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] \[ERROR\] \[TEST\] /);
		expect(printed[0].endsWith(cleaned)).toBe(true);
		expect(printed[0]).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/);

		expect(rows('TEST')).toEqual([{ context: 'TEST', message: cleaned, meta: null }]);
		expect(getRecentLogs(1)[0]).toMatchObject({ context: 'TEST', message: cleaned });
		expect(heard).toHaveLength(1);
		expect(heard[0]).toMatchObject({ context: 'TEST', message: cleaned });
	});

	it('cleans its context the same way', () => {
		const { printed, heard } = watched(() => createLogger('CTX\nX').error('said'));

		expect(printed).toHaveLength(1);
		expect(printed[0]).toContain('[ERROR] [CTX X] said');
		expect(rows('CTX X')).toEqual([{ context: 'CTX X', message: 'said', meta: null }]);
		expect(heard[0].context).toBe('CTX X');
	});

	it('keeps its meta valid JSON, with no DEL or C1 character in it', () => {
		const { printed } = watched(() => log.error('with meta', { name: 'a\u007fb\u0085c', line: 'd\ne' }));

		const [row] = rows('TEST');
		expect(row.meta).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/);
		// JSON escapes the C0 range itself, so the line break stays an escape
		// and nothing is lost of it; DEL and U+0085 it leaves raw.
		expect(JSON.parse(row.meta!)).toEqual({ name: 'a b c', line: 'd\ne' });
		expect(printed[0]).toContain(` | ${row.meta}`);
		expect(printed[0]).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/);
	});

	it('with no control character in it is printed and stored exactly as passed', () => {
		const message = 'Board "Été | 🔥 — plan" was renamed: 100% done; <b>not markup</b>';
		const { printed, heard } = watched(() => log.error(message, { detail: 'é 🔥' }));

		expect(printed[0].endsWith(`[ERROR] [TEST] ${message} | {"detail":"é 🔥"}`)).toBe(true);
		expect(rows('TEST')).toEqual([{ context: 'TEST', message, meta: '{"detail":"é 🔥"}' }]);
		expect(heard[0].message).toBe(message);
	});

	it('given something that is not text as its message is still printed and stored, and does not throw', () => {
		const { printed, heard } = watched(() => log.error(undefined as unknown as string));

		expect(printed).toHaveLength(1);
		expect(printed[0].endsWith('[ERROR] [TEST] undefined')).toBe(true);
		expect(rows('TEST')).toEqual([{ context: 'TEST', message: 'undefined', meta: null }]);
		expect(heard[0].message).toBe('undefined');
	});

	it('cleans the address it carries the same way, in the row, the ring buffer and the live feed', () => {
		const { heard } = watched(() => log.error('from somewhere', undefined, { userId: 7, ip: '10.0.0.1\n\u001b[2J\u202e' }));

		const stored = sqlite.prepare("SELECT user_id, ip FROM system_logs WHERE context = 'TEST'").all();
		expect(stored).toEqual([{ user_id: 7, ip: '10.0.0.1  [2J ' }]);
		expect(getRecentLogs(1)[0]).toMatchObject({ userId: 7, ip: '10.0.0.1  [2J ' });
		expect(heard[0]).toMatchObject({ userId: 7, ip: '10.0.0.1  [2J ' });
	});

	it('with no address keeps it null', () => {
		watched(() => log.error('from nowhere', undefined, { ip: null }));
		watched(() => log.error('from nowhere'));

		expect(sqlite.prepare("SELECT ip FROM system_logs WHERE context = 'TEST'").all()).toEqual([{ ip: null }, { ip: null }]);
	});
});

describe('a stored name in a line written by a route', () => {
	it('deleting a board named across two lines writes one INFO line for it, on the console and in the row', async () => {
		process.env.LOG_LEVEL = 'INFO';
		const owner = makeUser({ username: 'owner' });
		const doomed = makeBoard({ owner, name: `a\n${forged}` });

		const printed: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((line: string) => {
			printed.push(line);
		});
		const res = await api('DELETE', `/api/boards/${doomed.board.id}`, stepUp(owner));

		expect(res.status).toBe(200);
		const said = printed.filter((line) => line.includes('[DELETE]'));
		expect(said).toHaveLength(1);
		expect(said[0]).toContain(`[INFO] [DELETE] Board ${doomed.board.id} "a ${forged}" was deleted by owner: `);
		expect(said[0]).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		const stored = rows('DELETE');
		expect(stored).toHaveLength(1);
		expect(stored[0].message).toMatch(new RegExp(`^Board ${doomed.board.id} "a \\[2026`));
		expect(stored[0].message).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
	});
});

// Card 2842: GET /api/logs matched `q` with a LIKE built from the text, so %
// and _ were wildcards, and LIKE folds A to Z alone. Each row stores a line the
// text is in and a decoy it matched only as a pattern, or does not hold.
describe('GET /api/logs: q is matched as typed, in any case of any letter (card 2842)', () => {
	it.each<[string, string, string, string]>([
		['a percent sign', '50%', 'Coverage 50% done', 'Coverage 500 done'],
		['an underscore', 'a_b', 'Renamed a_b', 'Renamed axb'],
		['a quote', "it's", "Said it's broken", 'Said its broken'],
		['a letter beyond A to Z in another case', 'ÉCOLE', 'Back to école', 'Back to ecole']
	])('as %s', async (_name, text, line, decoy) => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const insert = sqlite.prepare("INSERT INTO system_logs (timestamp, level, context, message) VALUES ('2026-11-17 09:00:00', 'INFO', 'SEARCH', ?)");
		insert.run(line);
		insert.run(decoy);

		const res = await api('GET', `/api/logs?context=SEARCH&q=${encodeURIComponent(text)}`, { user: admin });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect((res.body.data as { message: string }[]).map((entry) => entry.message)).toEqual([line]);
	});
});

describe('startup-checks.ts', () => {
	it('uses the logger’s cleaner and keeps no copy of its own, and cleans the line it prints past LOG_LEVEL', () => {
		const source = readFileSync(join(process.cwd(), 'src/lib/server/startup-checks.ts'), 'utf8');

		expect(source).toMatch(/import \{[^}]*\bprintable\b[^}]*\} from '\.\/logger';/);
		expect(source).not.toMatch(/(const|function) printable\b/);
		const always = source.slice(source.indexOf('function warnOnConsoleAlways('));
		expect(always.slice(0, always.indexOf('\n}'))).toContain('[WARN] [STARTUP] ${printable(message)}');
	});
});

describe('backup-secrets.ts', () => {
	it('uses the logger’s cleaner for the names its sentences quote, and keeps no copy of its own', () => {
		const source = readFileSync(join(process.cwd(), 'src/lib/server/backup-secrets.ts'), 'utf8');

		expect(source).toMatch(/import \{[^}]*\bprintable\b[^}]*\} from '\.\/logger';/);
		expect(source).not.toMatch(/(const|function) printable\b/);
	});
});

// Card 2899's code review, F1: anyone who can make the server log can raise
// lesser lines, and the count cap took the oldest of every level with them.
describe('the log retention cap (card 2899)', () => {
	it('never deletes a CRITICAL line older than the newest 50,000, and still takes the lesser lines it holds', () => {
		const now = stamp();
		sqlite.exec('DELETE FROM system_logs');
		sqlite.prepare("INSERT INTO system_logs (timestamp, level, context, message) VALUES (?, 'CRITICAL', 'IMPORT', 'The database was replaced')").run(now);
		sqlite.prepare("INSERT INTO system_logs (timestamp, level, context, message) VALUES (?, 'WARN', 'AUTH', 'The oldest lesser line')").run(now);
		sqlite
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000)
				 INSERT INTO system_logs (timestamp, level, context, message) SELECT ?, 'INFO', 'HTTP', 'GET / ' || i FROM n`
			)
			.run(now);

		cleanOldSystemLogs();

		expect(sqlite.prepare("SELECT message FROM system_logs WHERE level = 'CRITICAL'").pluck().all()).toEqual(['The database was replaced']);
		expect(sqlite.prepare("SELECT COUNT(*) FROM system_logs WHERE message = 'The oldest lesser line'").pluck().get()).toBe(0);
		expect(sqlite.prepare('SELECT COUNT(*) FROM system_logs').pluck().get()).toBe(50_001);
	});
});
