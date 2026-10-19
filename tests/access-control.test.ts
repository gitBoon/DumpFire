/**
 * Board access is decided on the server, from the row.
 *
 * Each test here is a request that used to succeed and must not. The cast:
 *
 *   owner     owns board A
 *   editor    editor on board A
 *   viewer    viewer on board A
 *   outsider  owns board B and has no access to board A — but is signed in,
 *             which used to be enough
 *
 * The recurring trick is the outsider naming board B, which they may edit, in
 * the request body while acting on something that is on board A.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	boardCategories,
	boardFavourites,
	boards,
	cardAssignees,
	cardComments,
	cardLabels,
	cards,
	cardTemplates,
	categories,
	columns,
	milestones,
	subtasks,
	taskRequests,
	webhooks
} from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { dispatchWebhook } from '$lib/server/webhooks';
import { api } from './helpers/api';
import {
	addBoardMember,
	makeBoard,
	makeCard,
	makeLabel,
	makeSubtask,
	makeUser,
	resetDb,
	type BoardFixture
} from './helpers/fixtures';
import { stamp } from '$lib/timestamps';

let owner: SessionUser;
let editor: SessionUser;
let viewer: SessionUser;
let outsider: SessionUser;
let admin: SessionUser;
let superadmin: SessionUser;
let A: BoardFixture;
let B: BoardFixture;

beforeEach(() => {
	resetDb();
	owner = makeUser({ username: 'owner' });
	editor = makeUser({ username: 'editor' });
	viewer = makeUser({ username: 'viewer' });
	outsider = makeUser({ username: 'outsider' });
	admin = makeUser({ username: 'admin', role: 'admin' });
	superadmin = makeUser({ username: 'superadmin', role: 'superadmin' });

	A = makeBoard({ owner, name: 'A' });
	addBoardMember(A.board, editor, 'editor');
	addBoardMember(A.board, viewer, 'viewer');
	B = makeBoard({ owner: outsider, name: 'B' });
});

const cardRow = (id: number) => db.select().from(cards).where(eq(cards.id, id)).get();

describe('cards: the board comes from the card, not the request body', () => {
	it('refuses an update that names a board the caller can edit', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Original' });

		const res = await api('PUT', `/api/cards/${card.id}`, {
			user: outsider,
			body: { title: 'Hijacked', boardId: B.board.id }
		});

		expect(res.status).toBe(403);
		expect(cardRow(card.id)?.title).toBe('Original');
	});

	it('refuses a delete that names a board the caller can edit', async () => {
		const card = makeCard(A.cols['To Do']);

		for (const path of [`/api/cards/${card.id}`, `/api/cards/${card.id}?permanent=true`]) {
			const res = await api('DELETE', path, { user: outsider, body: { boardId: B.board.id } });
			expect(res.status).toBe(403);
		}
		expect(cardRow(card.id)?.archivedAt).toBeNull();
	});

	it('refuses to create a card in a column on a board the caller cannot edit', async () => {
		const res = await api('POST', '/api/cards', {
			user: outsider,
			body: { columnId: A.cols['To Do'].id, boardId: B.board.id, title: 'Planted' }
		});

		expect(res.status).toBe(403);
		expect(db.select().from(cards).all()).toHaveLength(0);
	});

	it('refuses a viewer, who can read the board but not change it', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Original' });
		const res = await api('PUT', `/api/cards/${card.id}`, { user: viewer, body: { title: 'x' } });
		expect(res.status).toBe(403);
	});

	it('still lets an editor update, and reports a missing card as 404', async () => {
		const card = makeCard(A.cols['To Do']);
		expect((await api('PUT', `/api/cards/${card.id}`, { user: editor, body: { title: 'Ok' } })).status).toBe(200);
		expect((await api('PUT', '/api/cards/99999', { user: editor, body: { title: 'x' } })).status).toBe(404);
		expect((await api('DELETE', '/api/cards/99999', { user: editor })).status).toBe(404);
	});
});

describe('cards: only named fields are writable', () => {
	it('ignores completedAt and archivedAt in an update', async () => {
		const card = makeCard(A.cols['To Do']);

		const res = await api('PUT', `/api/cards/${card.id}`, {
			user: owner,
			body: { title: 'Renamed', completedAt: '2020-01-01T00:00:00.000Z', archivedAt: '2020-01-01T00:00:00.000Z' }
		});

		expect(res.status).toBe(200);
		const row = cardRow(card.id)!;
		expect(row.title).toBe('Renamed');
		expect(row.completedAt).toBeNull();
		expect(row.archivedAt).toBeNull();
	});

	it('refuses to move a card into a column on a board the caller cannot edit', async () => {
		const card = makeCard(B.cols['To Do']);

		const res = await api('PUT', `/api/cards/${card.id}`, {
			user: outsider,
			body: { columnId: A.cols['To Do'].id }
		});

		expect(res.status).toBe(403);
		expect(cardRow(card.id)?.columnId).toBe(B.cols['To Do'].id);
	});

	it('moves a card between boards when the caller can edit both, stamping completion itself', async () => {
		addBoardMember(A.board, outsider, 'editor');
		const card = makeCard(B.cols['To Do']);

		const res = await api('PUT', `/api/cards/${card.id}`, {
			user: outsider,
			body: { columnId: A.cols['Complete'].id, completedAt: '2020-01-01T00:00:00.000Z' }
		});

		expect(res.status).toBe(200);
		const row = cardRow(card.id)!;
		expect(row.columnId).toBe(A.cols['Complete'].id);
		// Stamped by the server at the moment of completion, not taken from the body.
		expect(row.completedAt).not.toBeNull();
		expect(row.completedAt).not.toBe('2020-01-01T00:00:00.000Z');
	});
});

describe('milestones: joining one needs access to it', () => {
	it('refuses to attach a card to a milestone on a board the caller cannot open', async () => {
		const card = makeCard(A.cols['To Do']);
		const hidden = db
			.insert(milestones)
			.values({ boardId: B.board.id, name: "Someone else's goal", createdBy: outsider.id })
			.returning()
			.get();

		// The v1 card update wrote milestoneId straight to the row.
		const res = await api('PUT', `/api/v1/cards/${card.id}`, {
			user: owner,
			body: { milestoneId: hidden.id }
		});

		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(cardRow(card.id)?.milestoneId).toBeNull();
	});

	it('still attaches a card to a milestone on its own board', async () => {
		const card = makeCard(A.cols['To Do']);
		const mine = db
			.insert(milestones)
			.values({ boardId: A.board.id, name: 'Our goal', createdBy: owner.id })
			.returning()
			.get();

		const res = await api('PUT', `/api/v1/cards/${card.id}`, { user: owner, body: { milestoneId: mine.id } });

		expect(res.status).toBe(200);
		expect(cardRow(card.id)?.milestoneId).toBe(mine.id);
	});
});

describe('reorder: checked whether or not a board id is sent', () => {
	it('refuses a card reorder that omits the board id', async () => {
		const card = makeCard(A.cols['To Do']);

		const res = await api('PUT', '/api/cards/reorder', {
			user: outsider,
			body: { updates: [{ id: card.id, columnId: A.cols['Complete'].id, position: 0 }] }
		});

		expect(res.status).toBe(403);
		expect(cardRow(card.id)?.columnId).toBe(A.cols['To Do'].id);
	});

	it('refuses a card reorder that names a board the caller can edit', async () => {
		const card = makeCard(A.cols['To Do']);

		const res = await api('PUT', '/api/cards/reorder', {
			user: outsider,
			body: {
				boardId: B.board.id,
				updates: [{ id: card.id, columnId: A.cols['Complete'].id, position: 0 }]
			}
		});

		expect(res.status).toBe(403);
	});

	it('refuses to drag a card onto a board the caller cannot edit', async () => {
		const card = makeCard(B.cols['To Do']);

		const res = await api('PUT', '/api/cards/reorder', {
			user: outsider,
			body: { updates: [{ id: card.id, columnId: A.cols['To Do'].id, position: 0 }] }
		});

		expect(res.status).toBe(403);
	});

	it('keeps a reorder within one board', async () => {
		addBoardMember(A.board, outsider, 'editor');
		const card = makeCard(B.cols['To Do']);

		const res = await api('PUT', '/api/cards/reorder', {
			user: outsider,
			body: { updates: [{ id: card.id, columnId: A.cols['To Do'].id, position: 0 }] }
		});

		expect(res.status).toBe(400);
		expect(cardRow(card.id)?.columnId).toBe(B.cols['To Do'].id);
	});

	it('still lets an editor reorder', async () => {
		const card = makeCard(A.cols['To Do']);

		const res = await api('PUT', '/api/cards/reorder', {
			user: editor,
			body: { updates: [{ id: card.id, columnId: A.cols['In Progress'].id, position: 3 }] }
		});

		expect(res.status).toBe(200);
		expect(cardRow(card.id)?.columnId).toBe(A.cols['In Progress'].id);
	});

	it('refuses a column reorder with or without a board id', async () => {
		const col = A.cols['To Do'];
		const updates = [{ id: col.id, position: 99 }];

		expect((await api('PUT', '/api/columns/reorder', { user: outsider, body: { updates } })).status).toBe(403);
		expect(
			(await api('PUT', '/api/columns/reorder', { user: outsider, body: { updates, boardId: B.board.id } })).status
		).toBe(403);
		expect(db.select().from(columns).where(eq(columns.id, col.id)).get()?.position).toBe(col.position);
	});
});

describe('subtasks', () => {
	it('refuses create, update and delete that name a board the caller can edit', async () => {
		const card = makeCard(A.cols['To Do']);
		const sub = makeSubtask(card, { title: 'Original' });
		const spoof = { boardId: B.board.id };

		const create = await api('POST', '/api/subtasks', {
			user: outsider,
			body: { cardId: card.id, title: 'Planted', ...spoof }
		});
		const update = await api('PUT', `/api/subtasks/${sub.id}`, {
			user: outsider,
			body: { title: 'Hijacked', ...spoof }
		});
		const remove = await api('DELETE', `/api/subtasks/${sub.id}`, { user: outsider, body: spoof });

		expect([create.status, update.status, remove.status]).toEqual([403, 403, 403]);
		const rows = db.select().from(subtasks).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].title).toBe('Original');
	});

	it('refuses to list the subtasks of a card on a board the caller cannot open', async () => {
		const card = makeCard(A.cols['To Do']);
		makeSubtask(card);
		expect((await api('GET', `/api/subtasks?cardId=${card.id}`, { user: outsider })).status).toBe(403);
		expect((await api('GET', `/api/subtasks?cardId=${card.id}`, { user: viewer })).status).toBe(200);
	});

	it('writes only the named fields, so a subtask cannot be moved to another card', async () => {
		const card = makeCard(A.cols['To Do']);
		const other = makeCard(B.cols['To Do']);
		const sub = makeSubtask(card);

		const res = await api('PUT', `/api/subtasks/${sub.id}`, {
			user: owner,
			body: { title: 'Renamed', cardId: other.id, id: 9999 }
		});

		expect(res.status).toBe(200);
		const row = db.select().from(subtasks).where(eq(subtasks.id, sub.id)).get()!;
		expect(row.title).toBe('Renamed');
		expect(row.cardId).toBe(card.id);
	});
});

describe('labels', () => {
	it('refuses to toggle or delete a label by naming a board the caller can edit', async () => {
		const card = makeCard(A.cols['To Do']);
		const label = makeLabel(A.board);
		const spoof = { boardId: B.board.id };

		const toggle = await api('PUT', '/api/labels', {
			user: outsider,
			body: { cardId: card.id, labelId: label.id, ...spoof }
		});
		const remove = await api('DELETE', '/api/labels', { user: outsider, body: { id: label.id, ...spoof } });

		expect([toggle.status, remove.status]).toEqual([403, 403]);
		expect(db.select().from(cardLabels).all()).toHaveLength(0);
	});

	it("refuses to put another board's label on a card", async () => {
		addBoardMember(A.board, outsider, 'editor');
		const card = makeCard(A.cols['To Do']);
		const foreign = makeLabel(B.board);

		const res = await api('PUT', '/api/labels', {
			user: outsider,
			body: { cardId: card.id, labelId: foreign.id }
		});

		expect(res.status).toBe(400);
	});
});

describe('archive and restore', () => {
	it('refuses to list a board archive to someone who cannot open the board', async () => {
		makeCard(A.cols['To Do'], { archivedAt: stamp(), title: 'Secret' });

		expect((await api('GET', `/api/boards/${A.board.id}/archive`)).status).toBe(401);
		expect((await api('GET', `/api/boards/${A.board.id}/archive`, { user: outsider })).status).toBe(403);
		const ok = await api('GET', `/api/boards/${A.board.id}/archive`, { user: viewer });
		expect(ok.status).toBe(200);
		expect(ok.body).toHaveLength(1);
	});

	it('refuses to restore a card on a board the caller cannot edit, by either route', async () => {
		const card = makeCard(A.cols['To Do'], { archivedAt: stamp() });

		const viaBoard = await api('POST', `/api/boards/${B.board.id}/archive`, {
			user: outsider,
			body: { cardId: card.id }
		});
		const viaCard = await api('POST', `/api/cards/${card.id}/restore`, { user: outsider });
		const anonymous = await api('POST', `/api/cards/${card.id}/restore`);
		const asViewer = await api('POST', `/api/cards/${card.id}/restore`, { user: viewer });

		expect([viaBoard.status, viaCard.status, anonymous.status, asViewer.status]).toEqual([403, 403, 401, 403]);
		expect(cardRow(card.id)?.archivedAt).not.toBeNull();
	});

	it('still lets an editor restore', async () => {
		const card = makeCard(A.cols['To Do'], { archivedAt: stamp() });
		expect((await api('POST', `/api/cards/${card.id}/restore`, { user: editor })).status).toBe(200);
		expect(cardRow(card.id)?.archivedAt).toBeNull();
	});
});

describe('categories', () => {
	it('checks a card category against the board it belongs to', async () => {
		const category = db
			.insert(categories)
			.values({ boardId: A.board.id, name: 'Original' })
			.returning()
			.get();

		const rename = await api('PUT', `/api/categories/${category.id}`, {
			user: outsider,
			body: { name: 'Hijacked', boardId: B.board.id }
		});
		const remove = await api('DELETE', `/api/categories/${category.id}`, { user: outsider });
		const create = await api('POST', '/api/categories', {
			user: outsider,
			body: { boardId: A.board.id, name: 'Planted' }
		});
		const v1Rename = await api('PUT', `/api/v1/categories/${category.id}`, {
			user: outsider,
			body: { name: 'Hijacked' }
		});

		expect([rename.status, remove.status, create.status, v1Rename.status]).toEqual([403, 403, 403, 403]);
		expect(db.select().from(categories).all().map((c) => c.name)).toEqual(['Original']);
		expect((await api('PUT', `/api/categories/${category.id}`, { user: editor, body: { name: 'Ok' } })).status).toBe(200);
	});

	it('leaves a category that belongs to no board to administrators', async () => {
		const shared = db.insert(categories).values({ boardId: null, name: 'Shared' }).returning().get();

		expect((await api('POST', '/api/categories', { user: owner, body: { name: 'Mine' } })).status).toBe(403);
		expect((await api('DELETE', `/api/categories/${shared.id}`, { user: owner })).status).toBe(403);
		expect((await api('DELETE', `/api/v1/categories/${shared.id}`, { user: owner })).status).toBe(403);
		expect((await api('DELETE', `/api/categories/${shared.id}`, { user: admin })).status).toBe(200);
	});

	it('lets a dashboard grouping be changed only by someone who can edit every board in it', async () => {
		const grouping = db.insert(boardCategories).values({ name: 'Projects' }).returning().get();
		db.update(boards).set({ categoryId: grouping.id }).where(eq(boards.id, A.board.id)).run();

		for (const path of [`/api/board-categories/${grouping.id}`, `/api/v1/board-categories/${grouping.id}`]) {
			expect((await api('PUT', path, { user: outsider, body: { name: 'Hijacked' } })).status).toBe(403);
			expect((await api('DELETE', path, { user: outsider })).status).toBe(403);
		}
		expect(
			(await api('PUT', `/api/board-categories/${grouping.id}`, { user: owner, body: { name: 'Renamed' } })).status
		).toBe(200);
	});
});

describe('favourites and templates', () => {
	it('refuses to favourite a board the caller cannot open', async () => {
		expect((await api('POST', `/api/boards/${A.board.id}/favourite`)).status).toBe(401);
		expect((await api('POST', `/api/boards/${A.board.id}/favourite`, { user: outsider })).status).toBe(403);
		expect(db.select().from(boardFavourites).all()).toHaveLength(0);
		expect((await api('POST', `/api/boards/${A.board.id}/favourite`, { user: viewer })).body.favourited).toBe(true);
	});

	it('keeps a board template as private as its board', async () => {
		db.insert(cardTemplates).values({ boardId: A.board.id, name: 'Private', title: 'Secret plan' }).run();
		db.insert(cardTemplates).values({ boardId: null, name: 'Shared' }).run();

		const byBoard = await api('GET', `/api/templates?boardId=${A.board.id}`, { user: outsider });
		const everything = await api('GET', '/api/templates', { user: outsider });
		const create = await api('POST', '/api/templates', {
			user: outsider,
			body: { boardId: A.board.id, name: 'Planted' }
		});

		expect(byBoard.status).toBe(403);
		expect(everything.body.map((t: { name: string }) => t.name)).toEqual(['Shared']);
		expect(create.status).toBe(403);
		expect((await api('GET', `/api/templates?boardId=${A.board.id}`, { user: viewer })).body).toHaveLength(2);
	});
});

describe('task requests', () => {
	const makeRequest = (target: SessionUser) =>
		db
			.insert(taskRequests)
			.values({
				targetType: 'user',
				targetId: target.id,
				title: 'Please do this',
				desiredBoardId: A.board.id,
				requesterEmail: 'someone@example.test'
			})
			.returning()
			.get();

	it('refuses to accept a request into a board the acceptor cannot edit', async () => {
		const request = makeRequest(outsider);

		const res = await api('PATCH', `/api/requests/${request.id}`, {
			user: outsider,
			body: { action: 'accept', boardId: A.board.id, columnId: A.cols['To Do'].id }
		});

		expect(res.status).toBe(403);
		expect(db.select().from(cards).all()).toHaveLength(0);
	});

	it('refuses a column that is not on the board named', async () => {
		addBoardMember(A.board, outsider, 'editor');
		const request = makeRequest(outsider);

		const res = await api('PATCH', `/api/requests/${request.id}`, {
			user: outsider,
			body: { action: 'accept', boardId: B.board.id, columnId: A.cols['To Do'].id }
		});

		expect(res.status).toBe(400);
	});

	it('lets only the person it is addressed to read, answer or resolve it', async () => {
		const request = makeRequest(owner);

		const read = await api('GET', `/api/requests/${request.id}`, { user: outsider });
		const thread = await api('GET', `/api/requests/${request.id}/messages`, { user: outsider });
		const reply = await api('POST', `/api/requests/${request.id}/messages`, {
			user: outsider,
			body: { message: 'Not mine to answer' }
		});
		const reject = await api('PATCH', `/api/requests/${request.id}`, {
			user: outsider,
			body: { action: 'reject' }
		});

		expect([read.status, thread.status, reply.status, reject.status]).toEqual([403, 403, 403, 403]);
		expect(db.select().from(taskRequests).get()?.status).toBe('pending');
	});

	it('accepts into a board the addressee can edit', async () => {
		const request = makeRequest(owner);

		const res = await api('PATCH', `/api/requests/${request.id}`, {
			user: owner,
			body: { action: 'accept', boardId: A.board.id, columnId: A.cols['To Do'].id }
		});

		expect(res.status).toBe(200);
		expect(db.select().from(cards).all()).toHaveLength(1);
	});
});

describe('comments and assigned work do not outlive board access', () => {
	it('refuses a former member editing or deleting their old comment', async () => {
		const card = makeCard(A.cols['To Do']);
		const comment = db
			.insert(cardComments)
			.values({ cardId: card.id, userId: outsider.id, content: 'Written while a member' })
			.returning()
			.get();
		const path = `/api/cards/${card.id}/comments/${comment.id}`;

		expect((await api('PUT', path, { user: outsider, body: { content: 'Edited later' } })).status).toBe(403);
		expect((await api('DELETE', path, { user: outsider })).status).toBe(403);
		expect(db.select().from(cardComments).get()?.content).toBe('Written while a member');
	});

	it('drops cards on a board the caller can no longer open from their task list', async () => {
		const lost = makeCard(A.cols['To Do'], { title: 'On a board I lost' });
		const kept = makeCard(B.cols['To Do'], { title: 'On my board' });
		db.insert(cardAssignees).values({ cardId: lost.id, userId: outsider.id }).run();
		db.insert(cardAssignees).values({ cardId: kept.id, userId: outsider.id }).run();

		const res = await api('GET', '/api/my-tasks', { user: outsider });

		const titles = res.body.flatMap((g: { cards: { title: string }[] }) => g.cards.map((c) => c.title));
		expect(titles).toEqual(['On my board']);
	});
});

/**
 * A webhook's secret, and its address (card 2133), are for the board's owner
 * and an administrator. The address can name a server inside the network, or
 * carry credentials before the host: it was given to every viewer of the board.
 * So are changing them, and switching a webhook on (card 2154).
 */
describe('webhook secrets and addresses', () => {
	const ADDRESS = 'https://deliver:p4ss@hooks.internal.example.test/hook';
	const makeHook = () =>
		db
			.insert(webhooks)
			.values({ boardId: A.board.id, url: ADDRESS, secret: 's3cret' })
			.returning()
			.get();

	it('never returns the secret or the address to a viewer or an editor', async () => {
		const hook = makeHook();

		for (const user of [viewer, editor]) {
			const list = await api('GET', `/api/v1/boards/${A.board.id}/webhooks`, { user });
			const one = await api('GET', `/api/v1/webhooks/${hook.id}`, { user });

			expect(list.status).toBe(200);
			expect(one.status).toBe(200);
			const text = JSON.stringify([list.body, one.body]);
			expect(text).not.toContain('s3cret');
			expect(text).not.toContain('hooks.internal.example.test');
			for (const answer of [list.body[0], one.body]) {
				expect(answer).not.toHaveProperty('url');
				expect(answer).not.toHaveProperty('secret');
				// What they may know is still there.
				expect(answer).toMatchObject({ id: hook.id, boardId: A.board.id, hasSecret: true, events: [], active: true });
			}
		}
	});

	it('does not return either to an editor who updates the webhook', async () => {
		const hook = makeHook();
		const paused = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: editor, body: { active: false } });

		expect(paused.status).toBe(200);
		expect(paused.body).not.toHaveProperty('url');
		expect(JSON.stringify(paused.body)).not.toContain('s3cret');
		expect(JSON.stringify(paused.body)).not.toContain('hooks.internal.example.test');
		expect(paused.body).toMatchObject({ hasSecret: true, active: false });
	});

	/**
	 * Card 2154: the address and the secret are changed by the people who may
	 * read them. An editor who changed the address could not see what they
	 * replaced, and the owner had no reason to look.
	 */
	const ADDRESS_OR_SECRET = "Only the board's owner or an administrator can change a webhook's address or secret. Ask the board's owner.";
	const SWITCH_ON = "Only the board's owner or an administrator can switch a webhook on. Ask the board's owner.";
	const rowOf = (id: number) => db.select().from(webhooks).where(eq(webhooks.id, id)).get()!;

	it('refuses an editor who sends an address or a secret, whatever the value, and writes nothing (card 2154)', async () => {
		const hook = makeHook();
		const before = rowOf(hook.id);

		for (const body of [
			{ url: 'https://elsewhere.example.test/hook' },
			{ secret: 'mine now' },
			{ url: 'https://elsewhere.example.test/hook', secret: 'mine now' },
			// The value stored, sent back unchanged: accepting it would let an
			// editor test guesses at an address they may not read.
			{ url: ADDRESS },
			{ secret: 's3cret', events: ['card.moved'] },
			{ url: null }
		]) {
			const res = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: editor, body });
			expect(res.status, JSON.stringify(body)).toBe(403);
			expect(res.body.message).toBe(ADDRESS_OR_SECRET);
		}
		expect(rowOf(hook.id)).toEqual(before);
	});

	it('lets an editor change the events and switch a webhook off', async () => {
		const hook = makeHook();

		expect((await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: editor, body: { events: ['card.moved'] } })).status).toBe(200);
		expect((await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: editor, body: { active: false } })).status).toBe(200);
		expect(rowOf(hook.id)).toMatchObject({ url: ADDRESS, secret: 's3cret', events: '["card.moved"]', active: false });
	});

	it('refuses an editor who switches a webhook on, and accepts on for one already on (decision 15)', async () => {
		const hook = makeHook();
		// Already on: an unchanged value.
		expect((await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: editor, body: { active: true } })).status).toBe(200);

		db.update(webhooks).set({ active: false }).where(eq(webhooks.id, hook.id)).run();
		const on = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: editor, body: { active: true, events: ['card.moved'] } });

		expect(on.status).toBe(403);
		expect(on.body.message).toBe(SWITCH_ON);
		expect(rowOf(hook.id)).toMatchObject({ active: false, events: '[]' });
	});

	it('lets the owner and an administrator change the address and the secret, and switch a webhook on', async () => {
		for (const user of [owner, admin]) {
			const hook = makeHook();
			db.update(webhooks).set({ active: false }).where(eq(webhooks.id, hook.id)).run();

			const res = await api('PUT', `/api/v1/webhooks/${hook.id}`, {
				user,
				body: { url: 'https://elsewhere.example.test/hook', secret: 'new', active: true }
			});

			expect(res.status).toBe(200);
			expect(rowOf(hook.id)).toMatchObject({ url: 'https://elsewhere.example.test/hook', secret: 'new', active: true, setBy: user.id });
		}
	});

	it('makes whoever switches a webhook on its setter, and nobody who sends on for one already on (the review, S2)', async () => {
		for (const user of [owner, admin]) {
			// Set by somebody else, and switched off: by that account's reset, say.
			const hook = makeHook();
			db.update(webhooks).set({ active: false, setBy: editor.id }).where(eq(webhooks.id, hook.id)).run();

			expect((await api('PUT', `/api/v1/webhooks/${hook.id}`, { user, body: { active: true } })).status).toBe(200);
			expect(rowOf(hook.id)).toMatchObject({ active: true, setBy: user.id });
		}

		// On already: `active: true` sent back changes nothing, and sets nothing.
		const on = makeHook();
		db.update(webhooks).set({ setBy: editor.id }).where(eq(webhooks.id, on.id)).run();
		expect((await api('PUT', `/api/v1/webhooks/${on.id}`, { user: owner, body: { active: true } })).status).toBe(200);
		expect(rowOf(on.id)).toMatchObject({ active: true, setBy: editor.id });
	});

	it('refuses a viewer any change, as before', async () => {
		const hook = makeHook();
		for (const body of [{ active: false }, { url: 'https://elsewhere.example.test/hook' }]) {
			const res = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: viewer, body });
			expect(res.status).toBe(403);
			expect(res.body.message).toBe('No edit access to this board');
		}
	});

	it('returns both to the board owner and to an administrator, on both reads and an update', async () => {
		const hook = makeHook();

		for (const user of [owner, admin]) {
			const list = await api('GET', `/api/v1/boards/${A.board.id}/webhooks`, { user });
			const one = await api('GET', `/api/v1/webhooks/${hook.id}`, { user });
			const changed = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user, body: { active: true } });

			for (const answer of [list.body[0], one.body, changed.body]) {
				expect(answer.url).toBe(ADDRESS);
				expect(answer.secret).toBe('s3cret');
			}
		}
	});

	it('returns both once, on creation, to whoever supplied them', async () => {
		const res = await api('POST', `/api/v1/boards/${A.board.id}/webhooks`, {
			user: editor,
			body: { url: 'https://example.test/new', secret: 'fresh' }
		});

		expect(res.status).toBe(201);
		expect(res.body.secret).toBe('fresh');
		expect(res.body.url).toBe('https://example.test/new');

		// And after that, not to them again.
		const one = await api('GET', `/api/v1/webhooks/${res.body.id}`, { user: editor });
		expect(one.body).not.toHaveProperty('url');
		expect(one.body).not.toHaveProperty('secret');
	});

	/**
	 * Card 2178: what the last delivery came to goes with the address, to the
	 * people who may read it and change it. The address here carries a user
	 * name and password, so its delivery is refused before any request, and
	 * the result is held at once.
	 */
	it('gives the last delivery to the owner and an administrator, null on creation, and to nobody else (card 2178)', async () => {
		const hook = makeHook();
		dispatchWebhook(A.board.id, 'card.moved', { cardId: 1 });
		const result = {
			at: expect.any(String),
			event: 'card.moved',
			outcome: 'not-sent',
			status: null,
			reason: 'Not sent: the address carries a user name or password'
		};

		for (const user of [viewer, editor]) {
			const list = await api('GET', `/api/v1/boards/${A.board.id}/webhooks`, { user });
			const one = await api('GET', `/api/v1/webhooks/${hook.id}`, { user });
			for (const answer of [list.body[0], one.body]) expect(answer).not.toHaveProperty('lastDelivery');
		}
		const edited = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user: editor, body: { events: ['card.moved'] } });
		expect(edited.status).toBe(200);
		expect(edited.body).not.toHaveProperty('lastDelivery');

		for (const user of [owner, admin]) {
			const list = await api('GET', `/api/v1/boards/${A.board.id}/webhooks`, { user });
			const one = await api('GET', `/api/v1/webhooks/${hook.id}`, { user });
			const changed = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user, body: { active: true } });
			for (const answer of [list.body[0], one.body, changed.body]) expect(answer.lastDelivery).toEqual(result);
		}

		// The create's answer, to an editor too: nothing has been delivered.
		const made = await api('POST', `/api/v1/boards/${A.board.id}/webhooks`, { user: editor, body: { url: 'https://example.test/new' } });
		expect(made.status).toBe(201);
		expect(made.body).toHaveProperty('lastDelivery', null);
	});

	it('refuses someone who cannot open the board at all', async () => {
		const hook = makeHook();
		expect((await api('GET', `/api/v1/boards/${A.board.id}/webhooks`, { user: outsider })).status).toBe(403);
		expect((await api('GET', `/api/v1/webhooks/${hook.id}`, { user: outsider })).status).toBe(403);
	});
});

describe('superadmin is an administrator', () => {
	it('can read the audit log', async () => {
		expect((await api('GET', '/api/v1/audit-log', { user: superadmin })).status).toBe(200);
		expect((await api('GET', '/api/v1/audit-log', { user: admin })).status).toBe(200);
		expect((await api('GET', '/api/v1/audit-log', { user: owner })).status).toBe(403);
	});

	it("can run an activity report on another user", async () => {
		const path = `/api/v1/reports/activity?userId=${owner.id}`;
		expect((await api('GET', path, { user: superadmin })).status).toBe(200);
		expect((await api('GET', path, { user: admin })).status).toBe(200);
		expect((await api('GET', path, { user: outsider })).status).toBe(403);
	});
});
