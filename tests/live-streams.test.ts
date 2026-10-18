/**
 * An open live stream ends when the session it was opened with ends (card
 * 2160).
 *
 * The gate looks at a request's session once, when it arrives. A live stream
 * is one request that stays open: `/api/events` (the All Tasks page, the
 * dashboard and Burndown), `/api/boards/[id]/events` (a board) and
 * `/api/logs/stream` (the audit console). Each went on sending after its
 * session was deleted by a sign-out, a password change or a reset: card titles
 * and who did what, and for an administrator the system log, until the tab
 * was closed.
 *
 * Each now asks at the heartbeat it already had, every 30 seconds (25 for the
 * log), and ends if the session is gone, has expired or has no account: the
 * board stream asks `sessionStillOpen`, and the two that were let in for an
 * administrator's role ask `openSessionUser`, and end as well when the role
 * they were let in for has changed (the log stream when the account is no
 * longer an administrator, `/api/events` when it has become one or stopped
 * being one). Nothing else ends a stream: another session of the same account
 * ending does not, the board stream does not ask about the role, and a check
 * that throws ends the stream with one WARN line and never escapes the timer,
 * where it would end the process.
 *
 * The server is started under real timers. Each test then fakes only
 * `setInterval` and `clearInterval`, so that the heartbeat is advanced by hand
 * and everything else (promises, the reading of the stream) runs as it does.
 * A stream is read until it ends or the marked event arrives, whichever is
 * first, so a stream that does not end fails on the event and never hangs.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Set to make the stream's check throw, as a read of a broken database would. */
const check = vi.hoisted(() => ({ fails: false }));

vi.mock('$lib/server/auth', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/auth')>();
	return {
		...real,
		sessionStillOpen: (token: string | undefined) => {
			if (check.fails) throw new Error('disk I/O error');
			return real.sessionStillOpen(token);
		},
		openSessionUser: (token: string | undefined) => {
			if (check.fails) throw new Error('disk I/O error');
			return real.openSessionUser(token);
		}
	};
});

import { eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME, openSessionUser, sessionStillOpen, type SessionUser } from '$lib/server/auth';
import { db, sqlite } from '$lib/server/db';
import { sessions, users, type Board } from '$lib/server/db/schema';
import { emit } from '$lib/server/events';
import { error as logError } from '$lib/server/logger';
import { addBoardMember, makeBoard, makeSession, makeUser, resetDb } from './helpers/fixtures';
import { gate, gateApiRoutes } from './helpers/gate';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

type World = { owner: SessionUser; viewer: SessionUser; admin: SessionUser; board: Board };

let w: World;

beforeAll(async () => {
	// Started now, under real timers: what the server starts at start-up
	// (the rate limiter's sweep, the log's upkeep) is not the tests' to advance.
	// It takes seconds while every other file is starting too, so it is given
	// the time to do it in, as the other files that start one are.
	await gateApiRoutes();
	await gate('GET', '/login', { headers: { accept: 'text/html' } });
}, 120_000);

beforeEach(() => {
	resetDb();
	const owner = makeUser();
	const viewer = makeUser();
	const admin = makeUser({ role: 'admin' });
	const { board } = makeBoard({ owner });
	addBoardMember(board, owner, 'owner');
	addBoardMember(board, viewer, 'viewer');
	w = { owner, viewer, admin, board };
});

const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
const LOG_LEVEL = process.env.LOG_LEVEL;

afterEach(async () => {
	// A stream that did not end keeps its listener until it is cancelled.
	for (const reader of readers.splice(0)) await reader.cancel().catch(() => {});
	vi.useRealTimers();
	vi.restoreAllMocks();
	check.fails = false;
	if (LOG_LEVEL === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = LOG_LEVEL;
});

type Stream = {
	/** The route's id, as the WARN line names it. */
	route: string;
	path: () => string;
	/** Who opens it: a viewer of the board, or an administrator for the log. */
	who: () => SessionUser;
	/** How long between heartbeats. */
	every: number;
	/** What a heartbeat is, and how many are sent when it opens. */
	beat: string;
	beatsAtOpen: number;
	/** Something the stream would deliver, carrying `mark`. */
	send: (mark: string) => void;
};

const onBoard = (mark: string) => emit(w.board.id, 'update', { type: 'card', title: mark });

const STREAMS: Stream[] = [
	{
		route: '/api/events',
		path: () => '/api/events',
		who: () => w.viewer,
		every: 30_000,
		beat: ': heartbeat',
		beatsAtOpen: 1,
		send: onBoard
	},
	{
		route: '/api/boards/[id]/events',
		path: () => `/api/boards/${w.board.id}/events`,
		who: () => w.viewer,
		every: 30_000,
		beat: ': heartbeat',
		beatsAtOpen: 1,
		send: onBoard
	},
	{
		route: '/api/logs/stream',
		path: () => '/api/logs/stream',
		who: () => w.admin,
		every: 25_000,
		beat: ': ping',
		beatsAtOpen: 0,
		send: (mark) => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			logError('TEST', mark);
		}
	}
];

/** What ends a session, done to the one `token` names. */
const ENDINGS: { what: string; end: (user: SessionUser, token: string) => void }[] = [
	{
		what: 'every session of the account is deleted',
		end: (user) => db.delete(sessions).where(eq(sessions.userId, user.id)).run()
	},
	{
		what: 'the session expires where it stands',
		end: (_user, token) =>
			db.update(sessions).set({ expiresAt: '2020-01-01 00:00:00' }).where(eq(sessions.id, token)).run()
	},
	{
		// The cascade deletes the sessions with the account. A database made
		// before it was there can keep the row, which is what this is.
		what: 'the account is gone and its session row is left behind',
		end: (user) => withoutForeignKeys(() => db.delete(users).where(eq(users.id, user.id)).run())
	}
];

function withoutForeignKeys(change: () => void): void {
	sqlite.pragma('foreign_keys = OFF');
	try {
		change();
	} finally {
		sqlite.pragma('foreign_keys = ON');
	}
}

let marks = 0;
/** A mark no other test's event carries, and no other mark contains. */
const newMark = () => `<<live-stream-mark-${++marks}>>`;

/** Open the stream as the holder of `token`, with the heartbeat faked. */
async function open(stream: Stream, token: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	const res = await gate('GET', stream.path(), { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });
	expect(res.status).toBe(200);
	expect(res.headers.get('content-type')).toBe('text/event-stream');
	const reader = res.body!.getReader();
	readers.push(reader);
	return reader;
}

/** Read until the stream ends or `mark` arrives, whichever is first. */
async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	mark: string
): Promise<{ ended: boolean; received: string }> {
	const decoder = new TextDecoder();
	let received = '';
	while (!received.includes(mark)) {
		const { done, value } = await reader.read();
		if (done) return { ended: true, received };
		received += decoder.decode(value, { stream: true });
	}
	return { ended: false, received };
}

const count = (text: string, part: string) => text.split(part).length - 1;

describe('a stream whose session has ended', () => {
	for (const stream of STREAMS) {
		for (const ending of ENDINGS) {
			it(`${stream.route} ends at the next heartbeat when ${ending.what}, and sends nothing more`, async () => {
				const user = stream.who();
				const token = makeSession(user);
				const reader = await open(stream, token);

				ending.end(user, token);
				vi.advanceTimersByTime(stream.every);
				const mark = newMark();
				stream.send(mark);

				const { ended, received } = await readUntil(reader, mark);
				expect(ended).toBe(true);
				expect(received).not.toContain(mark);
				// Not even the heartbeat that found it ended.
				expect(count(received, stream.beat)).toBe(stream.beatsAtOpen);
			});
		}
	}

	it('ends one stream on a board and leaves the other, and the event goes to the one still open', async () => {
		const board = STREAMS[1];
		const kept = await open(board, makeSession(w.owner));
		const ended = await open(board, makeSession(w.viewer));

		db.delete(sessions).where(eq(sessions.userId, w.viewer.id)).run();
		vi.advanceTimersByTime(board.every);
		const mark = newMark();
		board.send(mark);

		const there = await readUntil(kept, mark);
		expect(there.ended).toBe(false);
		expect(there.received).toContain(mark);

		const gone = await readUntil(ended, mark);
		expect(gone.ended).toBe(true);
		expect(gone.received).not.toContain(mark);
	});
});

describe('a stream whose session is still open', () => {
	for (const stream of STREAMS) {
		it(`${stream.route} goes on when another session of the same account is deleted`, async () => {
			const user = stream.who();
			const token = makeSession(user);
			const other = makeSession(user);
			const reader = await open(stream, token);

			db.delete(sessions).where(eq(sessions.id, other)).run();
			vi.advanceTimersByTime(stream.every);
			const mark = newMark();
			stream.send(mark);

			const { ended, received } = await readUntil(reader, mark);
			expect(ended).toBe(false);
			expect(received).toContain(mark);
			expect(count(received, stream.beat)).toBe(stream.beatsAtOpen + 1);
		});

		it(`${stream.route} sends every heartbeat and every event, and does not move the session's expiry on`, async () => {
			const user = stream.who();
			const token = makeSession(user);
			const reader = await open(stream, token);
			// Put where a moved expiry would show, whatever the clock reads.
			const opened = '2099-01-01 00:00:00';
			db.update(sessions).set({ expiresAt: opened }).where(eq(sessions.id, token)).run();
			const expiry = () => db.select().from(sessions).where(eq(sessions.id, token)).get()?.expiresAt;

			vi.advanceTimersByTime(stream.every * 3);
			const mark = newMark();
			stream.send(mark);

			const { ended, received } = await readUntil(reader, mark);
			expect(ended).toBe(false);
			expect(received).toContain(mark);
			expect(count(received, stream.beat)).toBe(stream.beatsAtOpen + 3);
			// An open tab must not keep its session alive for ever.
			expect(expiry()).toBe(opened);
		});
	}
});

/** Give the account `role`, as the users route does. */
const setRole = (user: SessionUser, role: string) => db.update(users).set({ role }).where(eq(users.id, user.id)).run();

describe('a stream and a change of role', () => {
	const [EVENTS, BOARD, LOG] = STREAMS;

	// The two streams let in for what the account's role was when they opened.
	// `w.admin` is on no board, so `/api/events` sends it the board's events
	// only as an administrator; `w.viewer` is on the board, and is sent them
	// either way, so its stream must end for having become one.
	const ENDED: { stream: Stream; who: () => SessionUser; becomes: string; what: string }[] = [
		{ stream: EVENTS, who: () => w.admin, becomes: 'user', what: 'an administrator is made an ordinary user' },
		{ stream: LOG, who: () => w.admin, becomes: 'user', what: 'an administrator is made an ordinary user' },
		{ stream: EVENTS, who: () => w.viewer, becomes: 'admin', what: 'an ordinary user is made an administrator' }
	];

	for (const { stream, who, becomes, what } of ENDED) {
		it(`${stream.route} ends at the next heartbeat when ${what}, and sends nothing more`, async () => {
			const user = who();
			const token = makeSession(user);
			const reader = await open(stream, token);

			setRole(user, becomes);
			vi.advanceTimersByTime(stream.every);
			const mark = newMark();
			stream.send(mark);

			const { ended, received } = await readUntil(reader, mark);
			expect(ended).toBe(true);
			expect(received).not.toContain(mark);
			expect(count(received, stream.beat)).toBe(stream.beatsAtOpen);
			// The session is open still: it was the role that ended the stream.
			expect(sessionStillOpen(token)).toBe(true);
		});
	}

	// The board stream does not ask about the role. Whether the account may
	// still open the board is card 2170's, and a deleted board's page must
	// still be told by its event before its stream ends.
	it(`${BOARD.route} goes on when an administrator on the board is made an ordinary user`, async () => {
		addBoardMember(w.board, w.admin, 'viewer');
		const reader = await open(BOARD, makeSession(w.admin));

		setRole(w.admin, 'user');
		vi.advanceTimersByTime(BOARD.every);
		const mark = newMark();
		BOARD.send(mark);

		const { ended, received } = await readUntil(reader, mark);
		expect(ended).toBe(false);
		expect(received).toContain(mark);
		expect(count(received, BOARD.beat)).toBe(BOARD.beatsAtOpen + 1);
	});
});

describe('a check that cannot be made', () => {
	for (const stream of STREAMS) {
		it(`${stream.route} ends, says so once at WARN, and does not throw out of its timer`, async () => {
			process.env.LOG_LEVEL = 'WARN';
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const reader = await open(stream, makeSession(stream.who()));

			check.fails = true;
			// A throw out of the heartbeat would be rethrown here by the fake
			// clock. On a real one nothing catches it, and Node ends the process.
			expect(() => vi.advanceTimersByTime(stream.every)).not.toThrow();
			const mark = newMark();
			stream.send(mark);

			const { ended, received } = await readUntil(reader, mark);
			expect(ended).toBe(true);
			expect(received).not.toContain(mark);

			const said = sqlite
				.prepare("SELECT level, meta FROM system_logs WHERE message = 'Live stream ended: its session could not be checked'")
				.all() as { level: string; meta: string }[];
			expect(said).toHaveLength(1);
			expect(said[0].level).toBe('WARN');
			expect(JSON.parse(said[0].meta)).toMatchObject({ route: stream.route, error: 'Error: disk I/O error' });
		});
	}
});

describe('sessionStillOpen', () => {
	it('is true of an open session only, and writes and logs nothing', () => {
		const live = makeSession(w.viewer);
		const deleted = makeSession(w.viewer);
		db.delete(sessions).where(eq(sessions.id, deleted)).run();
		const expired = makeSession(w.viewer);
		db.update(sessions).set({ expiresAt: '2020-01-01 00:00:00' }).where(eq(sessions.id, expired)).run();
		const orphan = makeSession(w.owner);
		withoutForeignKeys(() => db.delete(users).where(eq(users.id, w.owner.id)).run());

		// Any line it logged, at any level, would be a row of system_logs.
		process.env.LOG_LEVEL = 'DEBUG';
		const before = snapshotDb();

		expect(sessionStillOpen(live)).toBe(true);
		expect(sessionStillOpen(deleted)).toBe(false);
		expect(sessionStillOpen(expired)).toBe(false);
		expect(sessionStillOpen(orphan)).toBe(false);
		expect(sessionStillOpen(undefined)).toBe(false);

		// The live session's expiry is where it was, and the orphan is still
		// there: deleting it is the gate's, which logs it.
		expectUnchanged(before);
	});
});

describe('openSessionUser', () => {
	it("gives an open session's account as it is now, null for any other, and writes and logs nothing", () => {
		const live = makeSession(w.admin);
		const deleted = makeSession(w.admin);
		db.delete(sessions).where(eq(sessions.id, deleted)).run();
		const expired = makeSession(w.admin);
		db.update(sessions).set({ expiresAt: '2020-01-01 00:00:00' }).where(eq(sessions.id, expired)).run();
		const orphan = makeSession(w.owner);
		withoutForeignKeys(() => db.delete(users).where(eq(users.id, w.owner.id)).run());
		// Changed since the session was made, and read as it is now.
		setRole(w.admin, 'user');

		process.env.LOG_LEVEL = 'DEBUG';
		const before = snapshotDb();

		expect(openSessionUser(live)).toEqual({ ...w.admin, role: 'user' });
		expect(openSessionUser(deleted)).toBeNull();
		expect(openSessionUser(expired)).toBeNull();
		expect(openSessionUser(orphan)).toBeNull();
		expect(openSessionUser(undefined)).toBeNull();

		expectUnchanged(before);
	});
});
