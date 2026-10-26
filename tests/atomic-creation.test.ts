/**
 * Creating a thing that is more than one row is all or nothing.
 *
 * A new board is the board, its four columns and its owner. A new card, a new
 * subtask and a new comment are each the row and the activity entry that says
 * who made it. A new team is the team and its owner. Each of these was written
 * one statement after another with nothing around them, so a failure part of
 * the way left a board with no columns, or a card nobody was recorded as
 * having raised. The mail settings were saved one key at a time in the same
 * way. Restoring a card from the archive is here too: two routes do it, and
 * they are now one routine.
 *
 * Every test of a success uses `eachWriteInTurn`, which makes the request once
 * to count its writes and then once more for each of them, with that write
 * failing, and checks every time that not one row changed and nothing was
 * sent. It also checks, on the run that succeeds, that nothing was sent while
 * the transaction was still open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import {
	activityLog,
	boardMembers,
	boards,
	cardComments,
	cards,
	columns,
	settings,
	subtasks,
	taskRequests,
	teamMembers,
	teams,
	users,
	type Card
} from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { api, type ApiResult } from './helpers/api';
import { eachWriteInTurn } from './helpers/each-write';
import { effects, type RecordedEffect } from './helpers/effects';
import {
	addBoardMember,
	makeBoard,
	makeCard,
	makeSmtp,
	makeSubtask,
	makeTeam,
	makeUser,
	makeWebhook,
	resetDb,
	shareBoardWithTeam,
	type BoardFixture
} from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

beforeEach(resetDb);

/** A recorded effect in a few words, so that a whole request reads as a list. */
function name(effect: RecordedEffect): string {
	if (effect.kind === 'webhook') return `webhook ${effect.event}`;
	if (effect.kind === 'email') return `email to ${effect.to}: ${effect.subject}`;
	return `event ${effect.event} (${effect.data?.type}) on board ${effect.boardId}`;
}

/** The first words of each write, to read a request's writes as a list. */
const shape = (writes: string[]) =>
	writes.map((sql) => sql.split(/[ (]/).slice(0, 3).join(' ').replace(/"/g, '').toLowerCase());

const entries = () =>
	db
		.select({
			boardId: activityLog.boardId,
			cardId: activityLog.cardId,
			userId: activityLog.userId,
			action: activityLog.action,
			detail: activityLog.detail,
			source: activityLog.source
		})
		.from(activityLog)
		.all();

/**
 * Make `request` with nothing failed, and check that it was answered `status`
 * with not a row changed and nothing sent.
 */
async function expectRefused(request: () => Promise<ApiResult>, status: number): Promise<ApiResult> {
	const before = snapshotDb();
	const sent = effects();
	try {
		const res = await request();
		await sent.settle();
		expect(res.status).toBe(status);
		expectUnchanged(before);
		expect(sent.all).toEqual([]);
		return res;
	} finally {
		sent.restore();
	}
}

type Scene = {
	owner: SessionUser;
	admin: SessionUser;
	/** May look at board A and change nothing on it. */
	viewer: SessionUser;
	/** Has a board of their own, and nothing to do with A. */
	outsider: SessionUser;
	A: BoardFixture;
	B: BoardFixture;
	/** A card on A. */
	first: Card;
};

/** Board A with a webhook and a card, mail switched on, and board B, which is somebody else's. */
function scene(): Scene {
	const owner = makeUser({ username: 'owner' });
	const admin = makeUser({ username: 'admin', role: 'admin' });
	const viewer = makeUser({ username: 'viewer' });
	const outsider = makeUser({ username: 'outsider' });
	const A = makeBoard({ owner, name: 'A' });
	const B = makeBoard({ owner: outsider, name: 'B' });
	addBoardMember(A.board, viewer, 'viewer');
	makeSmtp();
	makeWebhook(A.board);
	const first = makeCard(A.cols['To Do'], { title: 'First' });
	return { owner, admin, viewer, outsider, A, B, first };
}

// ─── Boards ─────────────────────────────────────────────────────────────────

describe('POST /api/boards', () => {
	it('makes the board, its four columns and its owner, or none of them', async () => {
		const run = await eachWriteInTurn({
			build: () => ({ owner: makeUser({ username: 'owner' }) }),
			request: ({ owner }) => api('POST', '/api/boards', { user: owner, body: { name: 'Roadmap', emoji: '🗺️' } }),
			afterSuccess: ({ owner }, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({ name: 'Roadmap', emoji: '🗺️', createdBy: owner.id });

				const made = db.select().from(boards).all();
				expect(made).toHaveLength(1);
				expect(made[0].id).toBe(res.body.id);
				expect(
					db
						.select({ boardId: columns.boardId, title: columns.title, position: columns.position })
						.from(columns)
						.all()
				).toEqual([
					{ boardId: made[0].id, title: 'To Do', position: 0 },
					{ boardId: made[0].id, title: 'On Hold', position: 1 },
					{ boardId: made[0].id, title: 'In Progress', position: 2 },
					{ boardId: made[0].id, title: 'Complete', position: 3 }
				]);
				expect(
					db
						.select({ boardId: boardMembers.boardId, userId: boardMembers.userId, role: boardMembers.role })
						.from(boardMembers)
						.all()
				).toEqual([{ boardId: made[0].id, userId: owner.id, role: 'owner' }]);
				// The entry `POST /api/v1/boards` writes, from the page (card 2143).
				expect(entries()).toEqual([
					{
						boardId: made[0].id,
						cardId: null,
						userId: owner.id,
						action: 'board_created',
						detail: 'Created board "Roadmap"',
						source: 'ui'
					}
				]);
			}
		});

		// A failure at the second of these used to leave a board with no columns,
		// and at the third a board with no member who owned it. The fourth, the
		// entry, was not written (card 2143).
		expect(shape(run.writes)).toEqual([
			'insert into boards',
			'insert into columns',
			'insert into board_members',
			'insert into activity_log'
		]);
		// A top-level board: no page but its maker's has anything to show.
		expect(run.effects).toEqual([]);
	});

	it('refuses a caller who is not signed in', async () => {
		await expectRefused(() => api('POST', '/api/boards', { body: { name: 'Roadmap' } }), 401);
	});
});

// ─── Cards ──────────────────────────────────────────────────────────────────

describe('POST /api/cards', () => {
	it('makes the card and the entry that says who raised it, or neither', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ owner, A }) =>
				api('POST', '/api/cards', {
					user: owner,
					body: { columnId: A.cols['To Do'].id, title: 'Raised here', priority: 'high' }
				}),
			afterSuccess: ({ owner, A }, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({ title: 'Raised here', priority: 'high', createdBy: owner.id });

				const made = db.select().from(cards).where(eq(cards.id, res.body.id)).get();
				expect(made).toMatchObject({ columnId: A.cols['To Do'].id, title: 'Raised here' });
				expect(entries()).toEqual([
					{
						boardId: A.board.id,
						cardId: res.body.id,
						userId: owner.id,
						action: 'card_created',
						detail: 'Raised here',
						source: 'ui'
					}
				]);
			}
		});

		// A failure at the second used to leave a card with no record of who
		// raised it, which is what the entry was added for. The third stamps its
		// commitment (milestone 22): a card created in To Do is committed work.
		expect(shape(run.writes)).toEqual(['insert into cards', 'insert into activity_log', 'update cards set']);
		expect(run.effects.map(name)).toEqual(['webhook card.created', 'event update (card) on board 1']);
	});

	it('refuses a column on a board the caller may not edit, from inside the transaction', async () => {
		const s = scene();
		const post = (user: SessionUser | null, columnId: number) => () =>
			api('POST', '/api/cards', { user, body: { columnId, title: 'Not mine to raise' } });

		expect((await expectRefused(post(s.outsider, s.A.cols['To Do'].id), 403)).body.message).toBe(
			'No edit access to this board'
		);
		expect((await expectRefused(post(s.viewer, s.A.cols['To Do'].id), 403)).body.message).toBe(
			'No edit access to this board'
		);
		expect((await expectRefused(post(s.owner, 99999), 404)).body.message).toBe('Column not found');
		await expectRefused(post(null, s.A.cols['To Do'].id), 401);
	});

	// The column is looked for, and the caller checked, before a field is read
	// (card 2117, R1). A title that was too long was refused first, with 400,
	// to a caller who could not touch the column, and for one that was not there.
	it('looks for the column, and checks the caller, before it reads the title', async () => {
		const s = scene();
		const post = (user: SessionUser, columnId: number) => () =>
			api('POST', '/api/cards', { user, body: { columnId, title: 'x'.repeat(501) } });

		expect((await expectRefused(post(s.owner, 99999), 404)).body.message).toBe('Column not found');
		expect((await expectRefused(post(s.outsider, s.A.cols['To Do'].id), 403)).body.message).toBe('No edit access to this board');
		expect((await expectRefused(post(s.owner, s.A.cols['To Do'].id), 400)).body.message).toBe('title must be at most 500 characters');
	});
});

// ─── Subtasks ───────────────────────────────────────────────────────────────

describe('POST /api/subtasks', () => {
	/** The card already has one subtask, so the new one goes after it. */
	const withSubtask = () => {
		const s = scene();
		makeSubtask(s.first, { title: 'Already here', position: 0 });
		return s;
	};

	it('makes the subtask and its activity entry, or neither', async () => {
		const run = await eachWriteInTurn({
			build: withSubtask,
			request: ({ owner, first }) =>
				api('POST', '/api/subtasks', { user: owner, body: { cardId: first.id, title: 'Write the tests' } }),
			afterSuccess: ({ owner, A, first }, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({ cardId: first.id, title: 'Write the tests', position: 1 });
				expect(
					db.select({ title: subtasks.title, position: subtasks.position }).from(subtasks).all()
				).toEqual([
					{ title: 'Already here', position: 0 },
					{ title: 'Write the tests', position: 1 }
				]);
				expect(entries()).toEqual([
					{
						boardId: A.board.id,
						cardId: first.id,
						userId: owner.id,
						action: 'subtask_created',
						detail: 'Write the tests',
						source: 'ui'
					}
				]);
			}
		});

		expect(shape(run.writes)).toEqual(['insert into subtasks', 'insert into activity_log']);
		expect(run.effects.map(name)).toEqual(['event update (subtask) on board 1']);
	});

	it('refuses a card on a board the caller may not edit, and a card that is not there', async () => {
		const s = withSubtask();
		const post = (user: SessionUser, cardId: number) => () =>
			api('POST', '/api/subtasks', { user, body: { cardId, title: 'Not mine to add' } });

		await expectRefused(post(s.outsider, s.first.id), 403);
		await expectRefused(post(s.viewer, s.first.id), 403);
		expect((await expectRefused(post(s.owner, 99999), 404)).body.message).toBe('Card not found');
	});
});

// ─── Comments ───────────────────────────────────────────────────────────────

describe('POST /api/cards/:id/comments', () => {
	/**
	 * Somebody to tell about each thing a comment tells people about: a member
	 * of the board, a user mentioned in it, and the person outside who asked
	 * for the card's work.
	 */
	const withReaders = () => {
		const s = scene();
		const member = makeUser({ username: 'member' });
		const mentioned = makeUser({ username: 'mentioned' });
		addBoardMember(s.A.board, member, 'editor');
		// Someone named is mailed only on a board they can open (card 2198).
		addBoardMember(s.A.board, mentioned, 'viewer');
		db.insert(taskRequests)
			.values({
				targetType: 'user',
				targetId: s.owner.id,
				requesterName: 'Rita',
				requesterEmail: 'rita@example.test',
				title: 'Please build this',
				status: 'accepted',
				accessToken: 'a'.repeat(64),
				resolvedBy: s.owner.id,
				resolvedCardId: s.first.id
			})
			.run();
		return { ...s, member, mentioned };
	};

	it('writes the comment and its activity entry, or neither, and tells nobody until it is saved', async () => {
		const run = await eachWriteInTurn({
			build: withReaders,
			request: ({ owner, first }) =>
				api('POST', `/api/cards/${first.id}/comments`, {
					user: owner,
					body: { content: '  Over to you, @mentioned  ' }
				}),
			afterSuccess: ({ owner, A, first }, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({
					cardId: first.id,
					userId: owner.id,
					content: 'Over to you, @mentioned',
					username: 'owner',
					userEmoji: '👤'
				});
				expect(
					db
						.select({ cardId: cardComments.cardId, userId: cardComments.userId, content: cardComments.content })
						.from(cardComments)
						.all()
				).toEqual([{ cardId: first.id, userId: owner.id, content: 'Over to you, @mentioned' }]);
				expect(entries()).toEqual([
					{
						boardId: A.board.id,
						cardId: first.id,
						userId: owner.id,
						action: 'comment_added',
						detail: 'on "First"',
						source: 'ui'
					}
				]);
			}
		});

		expect(shape(run.writes)).toEqual(['insert into card_comments', 'insert into activity_log']);
		// The webhook; the board's other members, the viewer among them; the user
		// mentioned; and the requester. Each used to be sent as soon as the
		// comment was written, before its entry was.
		expect(run.effects.map(name)).toEqual([
			'webhook comment.added',
			'email to viewer@example.test: New comment on: First',
			'email to member@example.test: New comment on: First',
			'email to mentioned@example.test: New comment on: First',
			'email to mentioned@example.test: owner mentioned you: First',
			'email to rita@example.test: New comment on your request: Please build this',
			// Then the open pages, so a card window open on the card re-reads its comments (card 2282).
			'event update (comment) on board 1'
		]);
	});

	it.each([
		['text that is not JSON', 'not json'],
		['JSON that is not an object', 'null']
	])('is saved when a member of the board has notification preferences that are %s', async (_what, stored) => {
		const { owner, first, member } = withReaders();
		db.update(users).set({ notificationPrefs: stored }).where(eq(users.id, member.id)).run();
		// The line is a WARN, and the tests run at ERROR.
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const sent = effects();

		try {
			// Reading the member's preferences used to throw inside the owner's
			// transaction, and the owner's comment was not saved.
			const res = await api('POST', `/api/cards/${first.id}/comments`, { user: owner, body: { content: 'Hello' } });
			await sent.settle();

			expect(res.status).toBe(201);
			expect(db.select({ content: cardComments.content }).from(cardComments).all()).toEqual([{ content: 'Hello' }]);
			// Preferences that cannot be read are the defaults, and the default is to be told.
			expect(sent.emails.map((e) => e.to)).toContain('member@example.test');
			expect(
				sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'NOTIFY' ORDER BY id").all()
			).toEqual([
				{
					level: 'WARN',
					message:
						`The notification preferences of user ${member.id} could not be read, so the defaults were used: ` +
						'notification_prefs is not a JSON object'
				}
			]);
		} finally {
			sent.restore();
			process.env.LOG_LEVEL = 'ERROR';
			vi.restoreAllMocks();
		}
	});

	it('answers an empty comment, a card that is not there and a caller who may only look, the card first', async () => {
		const s = withReaders();
		const post = (user: SessionUser | null, cardId: number, content: string) => () =>
			api('POST', `/api/cards/${cardId}/comments`, { user, body: { content } });

		// The card is looked for, and the caller checked, before what was sent
		// is looked at (card 2117, R1). Nothing to say was refused first, with
		// 400, for a card that was not there and to a caller who may only look.
		expect((await expectRefused(post(s.owner, 99999, '   '), 404)).body.message).toBe('Card not found');
		expect((await expectRefused(post(s.viewer, s.first.id, '   '), 403)).body.message).toBe('No edit access');
		expect((await expectRefused(post(s.owner, s.first.id, '   '), 400)).body.message).toBe('Comment cannot be empty');
		expect((await expectRefused(post(s.owner, 99999, 'Hello'), 404)).body.message).toBe('Card not found');
		expect((await expectRefused(post(s.viewer, s.first.id, 'Hello'), 403)).body.message).toBe('No edit access');
		expect((await expectRefused(post(s.outsider, s.first.id, 'Hello'), 403)).body.message).toBe('No edit access');
		await expectRefused(post(null, s.first.id, 'Hello'), 401);
	});
});

describe('who a mention mails (card 2198)', () => {
	const ROUTES = [
		['POST /api/cards/{id}/comments', (card: Card) => `/api/cards/${card.id}/comments`],
		['POST /api/v1/cards/{id}/comments', (card: Card) => `/api/v1/cards/${card.id}/comments`]
	] as const;

	/** Who was told they were mentioned, and every address mailed at all. */
	async function commentAs(owner: SessionUser, path: string, content: string) {
		const sent = effects();
		try {
			const res = await api('POST', path, { user: owner, body: { content } });
			await sent.settle();
			return {
				res,
				mentioned: sent.emails.filter((e) => e.subject === 'owner mentioned you: First').map((e) => e.to),
				mailed: sent.emails.map((e) => e.to)
			};
		} finally {
			sent.restore();
		}
	}

	it.each(ROUTES)('%s mails only those named who can open the board, and saves the comment as before', async (_route, path) => {
		const s = scene();
		const teamMate = makeUser({ username: 'teammate' });
		shareBoardWithTeam(s.A.board, makeTeam([teamMate]), 'viewer');
		const content = '@outsider, @viewer, @teammate and @admin: have a look';

		const { res, mentioned, mailed } = await commentAs(s.owner, path(s.first), content);

		expect(res.status).toBe(201);
		expect(res.body).toMatchObject({ cardId: s.first.id, userId: s.owner.id, content });
		expect(mentioned.sort()).toEqual(['admin@example.test', 'teammate@example.test', 'viewer@example.test']);
		// Nothing at all to someone who cannot open the board: not the mention, and nothing else.
		expect(mailed).not.toContain('outsider@example.test');
	});

	it.each(ROUTES)('%s does not mail someone named who was taken off the board', async (_route, path) => {
		const s = scene();
		const gone = makeUser({ username: 'gone' });
		addBoardMember(s.A.board, gone, 'editor');
		db.delete(boardMembers).where(eq(boardMembers.userId, gone.id)).run();

		const { res, mailed } = await commentAs(s.owner, path(s.first), 'Over to you, @gone');

		expect(res.status).toBe(201);
		expect(mailed).not.toContain('gone@example.test');
	});

	it.each(ROUTES)('%s mails someone named on a public board, which anyone may open (a guard)', async (_route, path) => {
		const s = scene();
		const open = makeBoard({ owner: s.owner, name: 'Open', isPublic: true });
		const card = makeCard(open.cols['To Do'], { title: 'First' });

		const { res, mentioned } = await commentAs(s.owner, path(card), 'Over to you, @outsider');

		expect(res.status).toBe(201);
		expect(mentioned).toEqual(['outsider@example.test']);
	});
});

// ─── Teams ──────────────────────────────────────────────────────────────────

describe('POST /api/teams', () => {
	it('makes the team and its owner, or neither', async () => {
		const run = await eachWriteInTurn({
			build: () => ({ founder: makeUser({ username: 'founder' }) }),
			request: ({ founder }) => api('POST', '/api/teams', { user: founder, body: { name: '  Platform  ' } }),
			afterSuccess: ({ founder }, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({ name: 'Platform', emoji: '🏢' });
				expect(db.select({ id: teams.id, name: teams.name }).from(teams).all()).toEqual([
					{ id: res.body.id, name: 'Platform' }
				]);
				expect(
					db
						.select({ teamId: teamMembers.teamId, userId: teamMembers.userId, role: teamMembers.role })
						.from(teamMembers)
						.all()
				).toEqual([{ teamId: res.body.id, userId: founder.id, role: 'owner' }]);
			}
		});

		// A failure at the second used to leave a team with nobody to manage it
		// but an administrator.
		expect(shape(run.writes)).toEqual(['insert into teams', 'insert into team_members']);
		expect(run.effects).toEqual([]);
	});

	it('refuses a team with no name, and a caller who is not signed in', async () => {
		const founder = makeUser({ username: 'founder' });

		expect(
			(await expectRefused(() => api('POST', '/api/teams', { user: founder, body: { name: '  ' } }), 400)).body
				.message
		).toBe('Team name is required');
		await expectRefused(() => api('POST', '/api/teams', { body: { name: 'Platform' } }), 401);
	});
});

// ─── Restoring a card from the archive ──────────────────────────────────────

describe('restoring a card from the archive', () => {
	const ARCHIVED_AT = '2026-10-01 09:00:00';

	/** The card of the scene, archived, with a subtask that went nowhere. */
	const withArchived = () => {
		const s = scene();
		db.update(cards).set({ archivedAt: ARCHIVED_AT, updatedAt: ARCHIVED_AT }).where(eq(cards.id, s.first.id)).run();
		makeSubtask(s.first, { title: 'Still here' });
		return s;
	};

	const cardRow = (id: number) => db.select().from(cards).where(eq(cards.id, id)).get()!;

	const routes: [string, (s: Scene, user: SessionUser | null, card?: number) => Promise<ApiResult>][] = [
		['POST /api/cards/:id/restore', (s, user, card = s.first.id) => api('POST', `/api/cards/${card}/restore`, { user })],
		[
			'POST /api/boards/:id/archive',
			(s, user, card = s.first.id) =>
				api('POST', `/api/boards/${s.A.board.id}/archive`, { user, body: { cardId: card } })
		]
	];

	for (const [route, restore] of routes) {
		describe(route, () => {
			it('puts the card back as it was, writes the entry that says so, and tells the board once it is saved', async () => {
				const run = await eachWriteInTurn({
					build: withArchived,
					request: (s) => restore(s, s.owner),
					afterSuccess: (s, res: ApiResult) => {
						expect(res.status).toBe(200);
						expect(res.body).toMatchObject({ id: s.first.id, title: 'First', archivedAt: null });

						const row = cardRow(s.first.id);
						expect(row.archivedAt).toBeNull();
						expect(row.updatedAt).not.toBe(ARCHIVED_AT);
						expect(row.columnId).toBe(s.A.cols['To Do'].id);
						expect(db.select({ title: subtasks.title }).from(subtasks).all()).toEqual([{ title: 'Still here' }]);
						// Neither route wrote an entry for a restore (card 2108). The
						// archive's entry has the same detail.
						expect(entries()).toEqual([
							{
								boardId: s.A.board.id,
								cardId: s.first.id,
								userId: s.owner.id,
								action: 'card_restored',
								detail: '"First"',
								source: 'ui'
							}
						]);
					}
				});

				// Both routes are the one routine: the same writes and the same
				// event. A restore has no webhook.
				expect(shape(run.writes)).toEqual(['update cards set', 'insert into activity_log']);
				expect(run.effects.map(name)).toEqual(['event update (card) on board 1']);
			});

			it('answers a card that is not archived as it is, with nothing written and nobody told', async () => {
				const s = scene();
				const card = cardRow(s.first.id);
				const before = snapshotDb();
				const sent = effects();

				try {
					const res = await restore(s, s.owner);
					await sent.settle();

					expect(res.status).toBe(200);
					expect(res.body).toEqual(card);
					// It used to set the card's `updated_at`, and tell the board.
					expectUnchanged(before);
					expect(sent.all).toEqual([]);
				} finally {
					sent.restore();
				}
			});

			it('refuses a caller who may not edit the board, and a card that is not there', async () => {
				const s = withArchived();

				await expectRefused(() => restore(s, s.outsider), 403);
				await expectRefused(() => restore(s, s.viewer), 403);
				await expectRefused(() => restore(s, null), 401);
				expect((await expectRefused(() => restore(s, s.owner, 99999), 404)).body.message).toBe('Card not found');
				expect(cardRow(s.first.id).archivedAt).toBe(ARCHIVED_AT);
			});
		});
	}

	it('by the board route, refuses a card that is on another board', async () => {
		const s = withArchived();

		// The admin may edit both boards, so this is refused for the board alone.
		const res = await expectRefused(
			() => api('POST', `/api/boards/${s.B.board.id}/archive`, { user: s.admin, body: { cardId: s.first.id } }),
			404
		);

		expect(res.body.message).toBe('Card not found on this board');
	});
});

// ─── Mail settings ──────────────────────────────────────────────────────────

describe('PUT /api/admin/smtp', () => {
	const MASKED = '••••••••';

	/**
	 * Mail already set up, with a password, and an App URL. And the superadmin,
	 * `chief`, whose settings these are: an administrator is refused them.
	 * The host, port, the way out and user are `NEW`'s, the host written
	 * otherwise, so that `NEW`'s masked password is kept: it is kept only for
	 * the server it was saved for (card 2190).
	 */
	const withMail = () => {
		const s = scene();
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		db.update(settings).set({ value: ' SMTP.New.Example.TEST ' }).where(eq(settings.key, 'smtp_host')).run();
		db.insert(settings)
			.values([
				{ key: 'smtp_port', value: '465' },
				{ key: 'smtp_allow_insecure', value: 'false' },
				{ key: 'smtp_user', value: 'mailer' },
				{ key: 'smtp_pass', value: 'the-old-secret' },
				{ key: 'app_url', value: 'https://old.example.test' }
			])
			.run();
		return { ...s, chief };
	};

	const stored = () =>
		Object.fromEntries(
			db
				.select()
				.from(settings)
				.all()
				.map((row) => [row.key, row.value])
		);

	const NEW = {
		host: 'smtp.new.example.test',
		port: 465,
		allowInsecure: false,
		user: 'mailer',
		pass: MASKED,
		fromAddress: 'board@new.example.test',
		fromName: 'The Board',
		appUrl: 'https://new.example.test/'
	};

	it('saves every mail setting and the App URL, or none of them', async () => {
		const run = await eachWriteInTurn({
			build: withMail,
			request: ({ chief }) => api('PUT', '/api/admin/smtp', { user: chief, body: NEW }),
			afterSuccess: (_s, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true });
				expect(stored()).toEqual({
					// The host the kept password was saved with, as it was written
					// (the review-fix pass's S1): it compares the same as the one sent.
					smtp_host: ' SMTP.New.Example.TEST ',
					smtp_port: '465',
					smtp_allow_insecure: 'false',
					smtp_user: 'mailer',
					// Sent masked, so the one already stored is kept.
					smtp_pass: 'the-old-secret',
					smtp_from_address: 'board@new.example.test',
					smtp_from_name: 'The Board',
					// Without the slash it was sent with.
					app_url: 'https://new.example.test'
				});
			}
		});

		// One write for each setting: a row changed where there was one, a row
		// added where there was none. A failure part of the way used to leave the
		// new host saved with the old password, and mail that could not be sent.
		// Then who set the App URL (card 2397), in the same transaction: a
		// failure there saves none of it. The mail settings' setter is not
		// written: the host, port, user and way out are as they were, and the
		// sender's name and address move nothing (its review). The App URL's: the
		// address it leaves, saved before anyone was recorded, as nobody's; the
		// saver's other App URL rows dropped; the saver's row (the third review).
		expect(shape(run.writes)).toEqual([
			'update settings set',
			'update settings set',
			'update settings set',
			'update settings set',
			'update settings set',
			'update settings set',
			'insert into settings',
			'update settings set',
			'insert into setting_setters',
			'delete from setting_setters',
			'insert into setting_setters'
		]);
		expect(run.effects).toEqual([]);
	});

	it('saves the mail settings alone when no App URL is sent, and a new password when one is', async () => {
		const s = withMail();
		const { appUrl: _appUrl, ...mailOnly } = NEW;

		const res = await api('PUT', '/api/admin/smtp', { user: s.chief, body: { ...mailOnly, pass: 'a-new-secret' } });

		expect(res.status).toBe(200);
		expect(stored()).toMatchObject({
			smtp_host: 'smtp.new.example.test',
			smtp_pass: 'a-new-secret',
			app_url: 'https://old.example.test'
		});
	});

	it('refuses everybody but an administrator or the superadmin (card 2395)', async () => {
		const s = withMail();

		// Whoever sets the mail server and the App URL decides where an invite
		// goes and what its link points at: the superadmin's alone until card
		// 2395, every administrator's since. Nobody signed in is refused 403 by
		// the handler, as every administrator route answers; the gate answers
		// them 401 first.
		await expectRefused(() => api('PUT', '/api/admin/smtp', { user: s.owner, body: NEW }), 403);
		await expectRefused(() => api('PUT', '/api/admin/smtp', { body: NEW }), 403);
		expect((await api('PUT', '/api/admin/smtp', { user: s.admin, body: NEW })).status).toBe(200);
	});
});
