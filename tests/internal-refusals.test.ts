/**
 * The routes under `/api/` that answered a refusal in a shape of their own,
 * and now answer `{ message }` as every other route does.
 *
 * Report schedules, the report itself and the emailed report answered
 * `{ error }`, the first as `json(...)` and the other two as a `Response` put
 * together by hand. `GET /api/my-tasks` answered an anonymous
 * caller 401 with the body `[]`, and `GET /api/logs/stream` answered a caller
 * who is not an administrator with the plain text "Forbidden".
 *
 * None of them had a test. `tests/error-shape.test.ts` reads the source of
 * every route and would catch the key coming back; these make the requests,
 * one refusal or more for each route, and check the status and the body a
 * page receives. Each also checks that the refused request changed nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { reportSchedules } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { api, type ApiResult } from './helpers/api';
import { effects } from './helpers/effects';
import { makeBoard, makeSmtp, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

let user: SessionUser;
let admin: SessionUser;
/** A board `user` owns. */
let mine: BoardFixture;
/** A board `user` has no access to. */
let theirs: BoardFixture;

beforeEach(() => {
	resetDb();
	user = makeUser();
	admin = makeUser({ role: 'admin' });
	mine = makeBoard({ owner: user });
	theirs = makeBoard({ owner: makeUser() });
});

/**
 * Make `request`, and check that it was answered `status` with `{ message }`
 * and nothing else, that not one row changed, and that nothing was sent.
 */
async function refused(request: () => Promise<ApiResult>, status: number, message: string): Promise<ApiResult> {
	const before = snapshotDb();
	const sent = effects();
	try {
		const res = await request();
		await sent.settle();
		expect(res.status).toBe(status);
		expect(res.body).toEqual({ message });
		expectUnchanged(before);
		expect(sent.all).toEqual([]);
		return res;
	} finally {
		sent.restore();
	}
}

/** A schedule of `owner`'s, made through the route. */
async function makeSchedule(owner: SessionUser, board: BoardFixture): Promise<number> {
	const res = await api('POST', '/api/report-schedules', {
		user: owner,
		body: { name: 'Weekly', scope: 'board', scopeId: board.board.id, frequency: 'weekly' }
	});
	expect(res.status).toBe(201);
	return res.body.id;
}

describe('/api/report-schedules', () => {
	const post = (caller: SessionUser | null, body: unknown) => () =>
		api('POST', '/api/report-schedules', { user: caller, body });
	const weekly = { name: 'Weekly', scope: 'board', frequency: 'weekly' };

	it('answers 401 to a caller who is not signed in, on GET and on POST', async () => {
		await refused(() => api('GET', '/api/report-schedules'), 401, 'Unauthorized');
		await refused(post(null, { ...weekly, scopeId: mine.board.id }), 401, 'Unauthorized');
	});

	it('answers 400 for a schedule with a field missing, a scope or a frequency it does not know, or no board named', async () => {
		await refused(post(user, { name: 'Weekly' }), 400, 'Missing required fields: name, scope, frequency');
		await refused(post(user, { ...weekly, scope: 'everything' }), 400, 'Invalid scope');
		await refused(
			post(user, { ...weekly, frequency: 'hourly', scopeId: mine.board.id }),
			400,
			'Invalid frequency. Must be: weekly or monthly'
		);
		await refused(post(user, weekly), 400, 'scopeId required for board scope');
		await refused(post(user, { ...weekly, scope: 'category' }), 400, 'scopeId required for category scope');
	});

	it('answers 403 for a board the caller cannot see, and for every board when the caller is not an administrator', async () => {
		await refused(post(user, { ...weekly, scopeId: theirs.board.id }), 403, 'No access to this board');
		await refused(post(user, { ...weekly, scope: 'all' }), 403, 'Only admins can schedule all-boards reports');
	});

	it('answers 404 for a category that is not there', async () => {
		await refused(post(user, { ...weekly, scope: 'category', scopeId: 99999 }), 404, 'Category not found');
	});

	it('still creates a schedule that is in order', async () => {
		const id = await makeSchedule(user, mine);

		expect(db.select({ id: reportSchedules.id, userId: reportSchedules.userId }).from(reportSchedules).all()).toEqual([
			{ id, userId: user.id }
		]);
	});
});

describe('/api/report-schedules/:id', () => {
	it('answers 401 to a caller who is not signed in', async () => {
		const id = await makeSchedule(user, mine);

		await refused(() => api('PUT', `/api/report-schedules/${id}`, { body: { enabled: false } }), 401, 'Unauthorized');
		await refused(() => api('DELETE', `/api/report-schedules/${id}`), 401, 'Unauthorized');
	});

	it('answers 404 for a schedule that is not there, and for one that is somebody else’s', async () => {
		const id = await makeSchedule(user, mine);

		await refused(
			() => api('PUT', '/api/report-schedules/99999', { user, body: { enabled: false } }),
			404,
			'Schedule not found'
		);
		await refused(
			() => api('PUT', `/api/report-schedules/${id}`, { user: admin, body: { enabled: false } }),
			404,
			'Schedule not found'
		);
		await refused(() => api('DELETE', `/api/report-schedules/${id}`, { user: admin }), 404, 'Schedule not found');
		expect(db.select({ enabled: reportSchedules.enabled }).from(reportSchedules).all()).toEqual([{ enabled: true }]);
	});

	// Card 2115 moved the update onto card 2117's readers. Each field was
	// stored as it was sent: a time of "9", which the scheduler cannot work out
	// a next run from, sent the report every minute; `"false"` switched nothing
	// off; an unknown frequency or status filter was dropped without a word.
	it('answers 400, naming the field, for a value the scheduler cannot use', async () => {
		const id = await makeSchedule(user, mine);
		const put = (body: unknown) => () => api('PUT', `/api/report-schedules/${id}`, { user, body });

		await refused(put({ enabled: 'false' }), 400, 'enabled must be true or false');
		await refused(put({ name: '  ' }), 400, 'name cannot be empty');
		await refused(put({ frequency: 'daily' }), 400, 'Invalid frequency. Must be: weekly or monthly');
		await refused(put({ dayOfWeek: 7 }), 400, 'dayOfWeek must be from 0 to 6');
		await refused(put({ dayOfMonth: 31 }), 400, 'dayOfMonth must be from 1 to 28');
		await refused(put({ dayOfMonth: 2.5 }), 400, 'dayOfMonth must be a whole number');
		await refused(put({ timeOfDay: '9' }), 400, 'timeOfDay must be a time written HH:MM, from 00:00 to 23:59');
		await refused(put({ recipients: 'a@example.test, nobody' }), 400, 'recipients holds "nobody", which is not an email address');
		await refused(put({ statusFilter: 'done' }), 400, 'statusFilter must be one of: all, completed, in_progress, todo');
		await refused(() => api('PUT', '/api/report-schedules/1.5', { user, body: { enabled: false } }), 400, 'Invalid schedule ID');
	});

	it('reads an empty time as 09:00, and keeps a value stored before it was checked when it is sent back', async () => {
		const id = await makeSchedule(user, mine);
		db.update(reportSchedules).set({ timeOfDay: '9' }).run();
		const put = (body: unknown) => api('PUT', `/api/report-schedules/${id}`, { user, body });

		// What a page sends back unchanged is saved with the change beside it.
		const kept = await put({ timeOfDay: '9', enabled: false });
		expect(kept.status).toBe(200);
		expect(kept.body).toMatchObject({ timeOfDay: '9', enabled: false });

		const cleared = await put({ timeOfDay: '' });
		expect(cleared.status).toBe(200);
		expect(cleared.body.timeOfDay).toBe('09:00');
	});
});

describe('POST /api/reports', () => {
	const post = (caller: SessionUser | null, body: unknown) => () => api('POST', '/api/reports', { user: caller, body });
	const period = { periodStart: '2026-10-01', periodEnd: '2026-10-08' };

	it('answers 401 to a caller who is not signed in', async () => {
		await refused(post(null, { scope: 'board', scopeId: mine.board.id, ...period }), 401, 'Unauthorized');
	});

	it('answers 400 for a report with a field missing, a scope it does not know, or no board or category named', async () => {
		await refused(post(user, { scope: 'board' }), 400, 'Missing required fields: scope, periodStart, periodEnd');
		await refused(post(user, { scope: 'everything', ...period }), 400, 'Invalid scope. Must be: board, category, or all');
		await refused(post(user, { scope: 'board', ...period }), 400, 'scopeId required for board scope');
		await refused(post(user, { scope: 'category', ...period }), 400, 'scopeId required for category scope');
	});

	it('answers 403 for a board or a category the caller cannot see, and for every board when the caller is not an administrator', async () => {
		await refused(post(user, { scope: 'board', scopeId: theirs.board.id, ...period }), 403, 'Board not found or no access');
		await refused(
			post(user, { scope: 'category', scopeId: 99999, ...period }),
			403,
			'Category not found or no accessible boards'
		);
		await refused(post(user, { scope: 'all', ...period }), 403, 'Only admins can generate all-boards reports');
	});

	it('still answers a report that is in order with the PDF', async () => {
		const res = await post(user, { scope: 'board', scopeId: mine.board.id, ...period })();

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/pdf');
	});
});

describe('POST /api/reports/email', () => {
	const post = (caller: SessionUser | null, body: unknown) => () =>
		api('POST', '/api/reports/email', { user: caller, body });
	const period = { periodStart: '2026-10-01', periodEnd: '2026-10-08' };

	// With mail configured, so that a refusal that sent anything would be seen to.
	beforeEach(makeSmtp);

	it('answers 401 to a caller who is not signed in', async () => {
		await refused(
			post(null, { scope: 'board', scopeId: mine.board.id, recipients: ['a@example.test'], ...period }),
			401,
			'Unauthorized'
		);
	});

	it('answers 400 for a field missing, no recipient, no recipient that is an address, or no board named', async () => {
		await refused(post(user, { scope: 'board', recipients: ['a@example.test'] }), 400, 'Missing required fields');
		await refused(
			post(user, { scope: 'board', scopeId: mine.board.id, recipients: [], ...period }),
			400,
			'At least one recipient email is required'
		);
		// What the reports page sends when "nobody" is typed into the box. Each
		// entry is an address now (card 2117, R10): one that was not was dropped
		// and the report sent to the rest, and with none left this was
		// "No valid email addresses provided".
		await refused(
			post(user, { scope: 'board', scopeId: mine.board.id, recipients: ['nobody'], ...period }),
			400,
			'recipients[0] must be an email address'
		);
		await refused(
			post(user, { scope: 'board', scopeId: mine.board.id, recipients: ['a@example.test', 'nobody'], ...period }),
			400,
			'recipients[1] must be an email address'
		);
		await refused(post(user, { scope: 'board', recipients: ['a@example.test'], ...period }), 400, 'scopeId required');
		await refused(post(user, { scope: 'category', recipients: ['a@example.test'], ...period }), 400, 'scopeId required');
	});

	it('answers 403 for a board the caller cannot see, and for every board when the caller is not an administrator', async () => {
		await refused(
			post(user, { scope: 'board', scopeId: theirs.board.id, recipients: ['a@example.test'], ...period }),
			403,
			'Failed to generate report or no access'
		);
		await refused(
			post(user, { scope: 'all', recipients: ['a@example.test'], ...period }),
			403,
			'Only admins can generate all-boards reports'
		);
	});
});

describe('GET /api/my-tasks', () => {
	it('answers 401 with a message, and not with an empty list, to a caller who is not signed in', async () => {
		await refused(() => api('GET', '/api/my-tasks'), 401, 'Not authenticated');
	});

	it('still answers a caller with nothing assigned with an empty list', async () => {
		const res = await api('GET', '/api/my-tasks', { user });

		expect(res.status).toBe(200);
		expect(res.body).toEqual([]);
	});
});

describe('GET /api/logs/stream', () => {
	it('answers 403 as JSON with a message to a caller who is not an administrator', async () => {
		const res = await refused(() => api('GET', '/api/logs/stream', { user }), 403, 'Forbidden');

		// Returned and not thrown: the caller is an EventSource, which a thrown
		// error would answer with an HTML page.
		expect(res.headers.get('content-type')).toContain('application/json');
		await refused(() => api('GET', '/api/logs/stream'), 403, 'Forbidden');
	});
});
