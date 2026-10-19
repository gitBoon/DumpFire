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
 * log), and ends if the session is gone, has expired or has no account: each
 * asks `openSessionUser`. The two that were let in for an administrator's role
 * end as well when that role has changed (the log stream when the account is
 * no longer an administrator, `/api/events` when it has become one or stopped
 * being one). The board stream ends as well when the board has gone or the
 * account as it is now cannot open it, and says so first with one `update`
 * of its own (card 2170); `/api/events` asks each board again after each
 * heartbeat. Nothing else ends a stream: another session of the same account
 * ending does not, and a check that throws ends the stream with one WARN line
 * and never escapes the timer, where it would end the process.
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

/** Set to make the board stream's access check throw, the same way (card 2170). */
const accessCheck = vi.hoisted(() => ({ fails: false }));

vi.mock('$lib/server/board-access', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/board-access')>();
	return {
		...real,
		canViewBoard: (...args: Parameters<typeof real.canViewBoard>) => {
			if (accessCheck.fails) throw new Error('disk I/O error');
			return real.canViewBoard(...args);
		}
	};
});

import { and, eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME, openSessionUser, sessionStillOpen, type SessionUser } from '$lib/server/auth';
import { db, sqlite } from '$lib/server/db';
import { boardMembers, boards, boardTeams, sessions, teamMembers, users, type Board } from '$lib/server/db/schema';
import { deleteBoard } from '$lib/server/deletes';
import { emit } from '$lib/server/events';
import { error as logError } from '$lib/server/logger';
import { addBoardMember, makeBoard, makeSession, makeTeam, makeUser, resetDb, shareBoardWithTeam } from './helpers/fixtures';
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
	accessCheck.fails = false;
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

	// The board stream does not ask about the role as such: it asks whether
	// the account, as it is now, may still open the board (card 2170, below).
	// An administrator who is on the board still may as an ordinary user.
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

/** What the board stream sends, on that stream alone, before it ends for want of access. */
const ACCESS_EVENT = 'event: update\ndata: {"type":"access"}\n\n';

describe('a stream and access to its board', () => {
	// Card 2170. The board stream asked whether its account could open the
	// board once, when it opened, and went on sending the board's events to
	// someone taken off it for as long as the session lasted. It now asks at
	// each heartbeat, of the account as it is now, and before it ends sends
	// one `update` of its own so that the page re-reads and shows its load's
	// refusal. The global stream decides each board again at its heartbeat.
	const [EVENTS, BOARD] = STREAMS;

	/** The ways someone stops being able to open a board, each to its own account. */
	const WITHDRAWN: { what: string; who: () => SessionUser; take: (user: SessionUser) => void }[] = [
		{
			what: 'their membership of the board is deleted',
			who: () => w.viewer,
			take: (user) =>
				db.delete(boardMembers).where(and(eq(boardMembers.boardId, w.board.id), eq(boardMembers.userId, user.id))).run()
		},
		{
			what: 'the team share they opened it through is deleted',
			who: () => {
				const user = makeUser();
				shareBoardWithTeam(w.board, makeTeam([user]), 'viewer');
				return user;
			},
			take: () => db.delete(boardTeams).where(eq(boardTeams.boardId, w.board.id)).run()
		},
		{
			what: 'they are taken out of the team the board is shared with',
			who: () => {
				const user = makeUser();
				shareBoardWithTeam(w.board, makeTeam([user]), 'viewer');
				return user;
			},
			take: (user) => db.delete(teamMembers).where(eq(teamMembers.userId, user.id)).run()
		},
		{
			what: 'a public board they are not on is made private',
			who: () => {
				db.update(boards).set({ isPublic: true }).where(eq(boards.id, w.board.id)).run();
				return makeUser();
			},
			take: () => db.update(boards).set({ isPublic: false }).where(eq(boards.id, w.board.id)).run()
		},
		{
			what: 'an administrator who is not on the board is made an ordinary user',
			who: () => w.admin,
			take: (user) => setRole(user, 'user')
		}
	];

	for (const { what, who, take } of WITHDRAWN) {
		it(`${BOARD.route} sends the access event and ends at the next heartbeat when ${what}`, async () => {
			const user = who();
			const token = makeSession(user);
			const reader = await open(BOARD, token);

			take(user);
			vi.advanceTimersByTime(BOARD.every);
			const mark = newMark();
			BOARD.send(mark);

			const { ended, received } = await readUntil(reader, mark);
			expect(ended).toBe(true);
			expect(received).not.toContain(mark);
			expect(count(received, ACCESS_EVENT)).toBe(1);
			expect(received.endsWith(ACCESS_EVENT)).toBe(true);
			// Not the heartbeat that found it: the session is open still.
			expect(count(received, BOARD.beat)).toBe(BOARD.beatsAtOpen);
			expect(sessionStillOpen(token)).toBe(true);
		});
	}

	it(`${BOARD.route} hands on a deleted board's own event first, then the access event, then ends`, async () => {
		const reader = await open(BOARD, makeSession(w.viewer));

		// The delete's event is delivered as its transaction commits, in the
		// same run; the heartbeat is a timer and comes after it.
		deleteBoard(w.board.id, w.owner);
		vi.advanceTimersByTime(BOARD.every);
		const mark = newMark();
		BOARD.send(mark);

		const { ended, received } = await readUntil(reader, mark);
		expect(ended).toBe(true);
		expect(received).not.toContain(mark);
		const deleted = received.indexOf('event: update\ndata: {"type":"board","action":"deleted"}\n\n');
		expect(deleted).toBeGreaterThan(-1);
		expect(received.indexOf(ACCESS_EVENT)).toBeGreaterThan(deleted);
		expect(received.endsWith(ACCESS_EVENT)).toBe(true);
	});

	it(`${BOARD.route} goes on for a member who stays, with every event and no access event`, async () => {
		const reader = await open(BOARD, makeSession(w.viewer));

		const marks = [newMark(), newMark(), newMark()];
		for (const mark of marks) {
			BOARD.send(mark);
			vi.advanceTimersByTime(BOARD.every);
		}

		const { ended, received } = await readUntil(reader, marks[2]);
		expect(ended).toBe(false);
		for (const mark of marks) expect(received).toContain(mark);
		expect(received).not.toContain('"type":"access"');
	});

	it(`${BOARD.route} does not open on a board that is not there, administrators included, or on an id that is not one`, async () => {
		const asked = async (path: string, user: SessionUser) => {
			// Asked for JSON so that the refusal's words can be read: what the
			// page's EventSource reads is the status, which is the same.
			const res = await gate('GET', path, {
				headers: { cookie: `${SESSION_COOKIE_NAME}=${makeSession(user)}`, accept: 'application/json' }
			});
			// A stream that opened is never read to its end: it has none.
			if (res.status === 200) {
				await res.body?.cancel();
				return { status: 200, body: null };
			}
			return { status: res.status, body: await res.json() };
		};
		expect(await asked('/api/boards/999999/events', w.admin)).toEqual({ status: 404, body: { message: 'Board not found' } });
		expect(await asked('/api/boards/999999/events', w.viewer)).toEqual({ status: 404, body: { message: 'Board not found' } });
		expect(await asked('/api/boards/abc/events', w.admin)).toEqual({ status: 400, body: { message: 'Invalid board ID' } });
		// A board that is there and that the caller cannot open, as before.
		const outsider = makeUser();
		expect(await asked(`/api/boards/${w.board.id}/events`, outsider)).toEqual({ status: 403, body: { message: 'No access to this board' } });
	});

	it(`${EVENTS.route} stops sending a board's events at the next heartbeat to someone taken off it, and goes on with the rest`, async () => {
		const { board: other } = makeBoard({ owner: w.owner });
		addBoardMember(other, w.viewer, 'viewer');
		const reader = await open(EVENTS, makeSession(w.viewer));

		// Delivered once first, so that the stream has its answer for the board.
		const first = newMark();
		BOARD.send(first);
		expect((await readUntil(reader, first)).received).toContain(first);

		db.delete(boardMembers).where(and(eq(boardMembers.boardId, w.board.id), eq(boardMembers.userId, w.viewer.id))).run();
		// One heartbeat, and the clock not moved: nothing else decides.
		vi.advanceTimersByTime(EVENTS.every);
		const gone = newMark();
		const kept = newMark();
		BOARD.send(gone);
		emit(other.id, 'update', { type: 'card', title: kept });

		const { ended, received } = await readUntil(reader, kept);
		expect(ended).toBe(false);
		expect(received).toContain(kept);
		expect(received).not.toContain(gone);
	});

	it(`${BOARD.route} ends, says so once at WARN, and does not throw out of its timer, when the access check cannot be made`, async () => {
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const reader = await open(BOARD, makeSession(w.viewer));

		accessCheck.fails = true;
		expect(() => vi.advanceTimersByTime(BOARD.every)).not.toThrow();
		accessCheck.fails = false;
		const mark = newMark();
		BOARD.send(mark);

		const { ended, received } = await readUntil(reader, mark);
		expect(ended).toBe(true);
		expect(received).not.toContain(mark);
		// It could not say whether access was withdrawn, so it does not say it was.
		expect(received).not.toContain('"type":"access"');

		const said = sqlite
			.prepare("SELECT level, meta FROM system_logs WHERE message = 'Live stream ended: its session could not be checked'")
			.all() as { level: string; meta: string }[];
		expect(said).toHaveLength(1);
		expect(said[0].level).toBe('WARN');
		expect(JSON.parse(said[0].meta)).toMatchObject({ route: BOARD.route, boardId: w.board.id, error: 'Error: disk I/O error' });
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
