/**
 * Proves the helpers that the all-or-nothing tests stand on: the write that
 * can be made to fail, the snapshot of every row, the record of what was sent,
 * the callers for form actions and page loads, the builders, and the each-write-in-turn
 * pattern itself. If these are wrong, a test built on them proves nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { cardComments, cards, sessions, settings, users, workDependencies } from '$lib/server/db/schema';
import { getCompletionBlocker } from '$lib/server/card-completion';
import { mailStatus, sendEmail, trySendEmail } from '$lib/server/email';
import { emit } from '$lib/server/events';
import { logUiActivity } from '$lib/server/logActivity';
import { createLogger } from '$lib/server/logger';
import { notifyCardMoved } from '$lib/server/notifications';
import { getWorkDependencies } from '$lib/server/planning';
import { SESSION_COOKIE_NAME } from '$lib/server/auth';
import { action, loadKeys, pageLoad, pagePatterns } from './helpers/actions';
import { eachWriteInTurn } from './helpers/each-write';
import { effects, type Effects } from './helpers/effects';
import { failingWrite, InjectedWriteFailure, type FailingWrite } from './helpers/failing-write';
import {
	addBoardMember,
	assignCard,
	makeBoard,
	makeCard,
	makeComment,
	makeDependency,
	makeMilestone,
	makeSmtp,
	makeSubBoard,
	makeSubtask,
	makeUser,
	makeWebhook,
	resetDb
} from './helpers/fixtures';
import { readBudget, ReadBudgetSpent, watchReads } from './helpers/reads';
import { diffSnapshots, expectUnchanged, snapshotDb } from './helpers/snapshot';

beforeEach(resetDb);

const setting = (key: string) => db.insert(settings).values({ key, value: 'x' }).run();

describe('failingWrite', () => {
	let writes: FailingWrite;
	beforeEach(() => {
		writes = failingWrite();
	});
	afterEach(() => writes.restore());

	it('counts the writes Drizzle makes and not its reads', () => {
		setting('a');
		db.select().from(settings).all();
		db.update(settings).set({ value: 'y' }).where(eq(settings.key, 'a')).returning().get();
		db.delete(settings).where(eq(settings.key, 'a')).run();

		expect(writes.count).toBe(3);
		expect(writes.writes.map((sql) => sql.split(' ')[0].toLowerCase())).toEqual(['insert', 'update', 'delete']);
	});

	it('counts a statement prepared once each time it runs', () => {
		const insert = sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
		insert.run('a', 'x');
		insert.run('b', 'x');
		sqlite.prepare('SELECT * FROM settings').all();

		expect(writes.count).toBe(2);
	});

	it('leaves out what the logger writes', () => {
		createLogger('TEST').error('a line for system_logs');

		expect(writes.count).toBe(0);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM system_logs').get()).toEqual({ n: 1 });
	});

	it('fails the nth write, that one only, before it runs', () => {
		writes.failNth(2);

		setting('first');
		expect(writes.fired).toBe(false);
		expect(() => setting('second')).toThrow(InjectedWriteFailure);
		expect(writes.fired).toBe(true);
		setting('third');

		expect(db.select().from(settings).all().map((r) => r.key)).toEqual(['first', 'third']);
	});

	it('starts counting again when it is armed and when it is reset', () => {
		setting('before');
		writes.failNth(1);
		expect(() => setting('refused')).toThrow(/write 1 was made to fail/);

		writes.reset();
		setting('after');
		expect(writes.count).toBe(1);
		expect(writes.fired).toBe(false);
	});

	it('puts everything back', () => {
		const insert = sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
		expect(Object.keys(insert)).toContain('run');
		writes.failNth(1);
		writes.restore();

		expect(Object.keys(sqlite)).not.toContain('prepare');
		expect(Object.keys(sqlite)).not.toContain('exec');
		expect(Object.keys(insert)).not.toContain('run');
		insert.run('a', 'x');
		setting('b');
		expect(writes.count).toBe(0);
		expect(db.select().from(settings).all()).toHaveLength(2);

		// Installed again for afterEach to remove.
		writes = failingWrite();
	});

	it('refuses to be installed twice', () => {
		expect(() => failingWrite()).toThrow(/already installed/);
	});
});

describe('the snapshot of every row', () => {
	it('is unchanged by a read, and by a write that was rolled back', () => {
		const owner = makeUser();
		const { cols } = makeBoard({ owner });
		makeCard(cols['To Do']);
		const before = snapshotDb();

		expect(() =>
			inTransaction(() => {
				makeCard(cols['To Do']);
				throw new Error('rolled back');
			})
		).toThrow('rolled back');

		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		expect(() => expectUnchanged(before)).not.toThrow();
	});

	it('names the table and the column of a changed row', () => {
		const { cols } = makeBoard();
		const card = makeCard(cols['To Do'], { title: 'Before' });
		const before = snapshotDb();

		db.update(cards).set({ title: 'After' }).where(eq(cards.id, card.id)).run();

		expect(diffSnapshots(before, snapshotDb())).toEqual([
			`cards: row ${card.id} changed (title: "Before" became "After")`
		]);
		expect(() => expectUnchanged(before, 'after the edit')).toThrow(
			/^after the edit: the database is not as it was\. 1 difference\(s\):\n  cards: row/
		);
	});

	it('names a row that was added, with the id counter it used up', () => {
		const { cols } = makeBoard();
		makeCard(cols['To Do']);
		const before = snapshotDb();

		const added = makeCard(cols['To Do']);

		const differences = diffSnapshots(before, snapshotDb());
		expect(differences).toHaveLength(2);
		expect(differences[0]).toMatch(new RegExp(`^cards: row ${added.id} was added`));
		expect(differences[1]).toBe('sqlite_sequence: the id counter of cards changed (seq: 1 became 2)');
	});

	it('names a row that was removed', () => {
		const { cols } = makeBoard();
		const card = makeCard(cols['To Do']);
		const before = snapshotDb();

		db.delete(cards).where(eq(cards.id, card.id)).run();

		expect(diffSnapshots(before, snapshotDb())).toEqual([
			expect.stringMatching(new RegExp(`^cards: row ${card.id} was removed`))
		]);
	});

	it('sees an id that a deleted row used up', () => {
		const { cols } = makeBoard();
		const before = snapshotDb();

		const card = makeCard(cols['To Do']);
		db.delete(cards).where(eq(cards.id, card.id)).run();

		expect(diffSnapshots(before, snapshotDb())).toEqual([
			expect.stringMatching(/^sqlite_sequence: the id counter of cards was added/)
		]);
	});

	it('ignores system_logs and its counter', () => {
		const before = snapshotDb();
		createLogger('TEST').error('a failed request leaves a line behind');

		expect(Object.keys(before)).not.toContain('system_logs');
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
	});
});

describe('effects()', () => {
	let sent: Effects;
	beforeEach(() => {
		sent = effects();
	});
	afterEach(() => sent.restore());

	it('records a webhook delivery and sends nothing', async () => {
		const owner = makeUser();
		const { board, cols } = makeBoard({ owner });
		const card = makeCard(cols['To Do']);
		makeWebhook(board, { url: 'https://hooks.example.test/a', secret: 's3cret' });

		logUiActivity({ boardId: board.id, cardId: card.id, action: 'card_updated', detail: 'x' });
		await sent.settle();

		expect(sent.webhooks).toHaveLength(1);
		expect(sent.webhooks[0]).toMatchObject({
			url: 'https://hooks.example.test/a',
			event: 'card.updated',
			body: { event: 'card.updated', boardId: board.id, data: { cardId: card.id, source: 'ui' } },
			inTransaction: false
		});
		expect(sent.webhooks[0].headers['x-dumpfire-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
	});

	it('records a live event with its board', () => {
		emit(7, 'update', { type: 'card' });

		expect(sent.events).toEqual([
			{ kind: 'event', boardId: 7, event: 'update', data: { type: 'card' }, inTransaction: false }
		]);
	});

	it('records mail, which is only attempted once SMTP is configured', async () => {
		const owner = makeUser();
		const assignee = makeUser({ username: 'assignee' });
		const { board, cols } = makeBoard({ owner });
		// Only an assignee who can open the board is mailed about its cards (card 2180).
		addBoardMember(board, assignee, 'viewer');
		const card = makeCard(cols['To Do'], { title: 'Ship it' });
		assignCard(card, assignee);

		notifyCardMoved(board.id, card.id, card.title, owner.username, 'To Do', 'Complete', owner.id, 'http://localhost');
		await sent.settle();
		expect(sent.emails).toEqual([]);

		makeSmtp();
		notifyCardMoved(board.id, card.id, card.title, owner.username, 'To Do', 'Complete', owner.id, 'http://localhost');
		await sent.settle();

		expect(sent.emails).toHaveLength(1);
		expect(sent.emails[0]).toMatchObject({
			to: 'assignee@example.test',
			subject: 'Card moved: Ship it → Complete',
			inTransaction: false
		});
	});

	it('refuses mail to the addresses it is given, and keeps that mail apart', async () => {
		sent.restore();
		sent = effects({ refuseMailTo: ['refused@example.test'] });
		makeSmtp();

		// The transport throws, as a mail server's refusal does, and the send says it failed.
		expect(await sendEmail('refused@example.test', 'One', '<p>1</p>')).toBe(false);
		expect(await sendEmail('taken@example.test', 'Two', '<p>2</p>')).toBe(true);

		expect(sent.all.map((e) => e.kind === 'email' && e.to)).toEqual(['taken@example.test']);
		expect(sent.refusedMail).toEqual([
			{ kind: 'email', to: 'refused@example.test', subject: 'One', html: '<p>1</p>', attachments: [], inTransaction: false }
		]);
		sent.clear();
		expect(sent.refusedMail).toEqual([]);
	});

	it('notes a refused mail that started while a transaction was open', async () => {
		sent.restore();
		sent = effects({ refuseMailTo: ['refused@example.test'] });
		makeSmtp();

		// Sent straight from inside one, which no application code may do. The
		// refusal keeps it out of `all`, and must not hide it from this check.
		let send: Promise<boolean> = Promise.resolve(true);
		sqlite.transaction(() => {
			send = sendEmail('refused@example.test', 'Too early', '<p>1</p>');
		})();
		expect(await send).toBe(false);

		expect(sent.all).toEqual([]);
		expect(sent.duringTransaction).toEqual([
			{ kind: 'email', to: 'refused@example.test', subject: 'Too early', html: '<p>1</p>', attachments: [], inTransaction: true }
		]);
		sent.clear();
		expect(sent.duringTransaction).toEqual([]);
	});

	it('refuses nothing unless it is told to', async () => {
		makeSmtp();

		expect(await sendEmail('refused@example.test', 'One', '<p>1</p>')).toBe(true);
		expect(sent.refusedMail).toEqual([]);
	});

	it('refuses with the error mailRefusal returns, shown the mail, and keeps that mail apart (card 2196)', async () => {
		sent.restore();
		const shown: { to: string; subject: string; html: string }[] = [];
		const refusal = Object.assign(new Error('535 5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 });
		sent = effects({
			mailRefusal: (mail) => {
				shown.push(mail);
				return mail.to === 'refused@example.test' ? refusal : undefined;
			}
		});
		makeSmtp();

		expect(await trySendEmail('refused@example.test', 'One', '<p>1</p>')).toEqual({
			sent: false,
			problem: 'sign-in',
			detail: '535 5.7.8 Username and Password not accepted'
		});
		expect(await trySendEmail('taken@example.test', 'Two', '<p>2</p>')).toEqual({ sent: true });

		expect(shown).toEqual([
			{ to: 'refused@example.test', subject: 'One', html: '<p>1</p>' },
			{ to: 'taken@example.test', subject: 'Two', html: '<p>2</p>' }
		]);
		expect(sent.all.map((e) => e.kind === 'email' && e.to)).toEqual(['taken@example.test']);
		expect(sent.refusedMail.map((e) => e.to)).toEqual(['refused@example.test']);
	});

	it('notes an effect that starts while a transaction is open', async () => {
		// Sent straight from inside one, which no application code may do.
		sqlite.transaction(() => {
			void fetch('https://hooks.example.test/too-early', { method: 'POST', body: '{}' });
		})();
		await fetch('https://hooks.example.test/after', { method: 'POST', body: '{}' });

		expect(sent.all.map((e) => e.inTransaction)).toEqual([true, false]);
		expect(sent.duringTransaction).toHaveLength(1);
		expect(sent.duringTransaction[0]).toMatchObject({ url: 'https://hooks.example.test/too-early' });
	});

	it('keeps the order across kinds, and forgets on clear()', async () => {
		emit(1, 'update', {});
		await fetch('https://hooks.example.test/a', { method: 'POST', body: '{}' });
		emit(1, 'celebrate', {});

		expect(sent.all.map((e) => e.kind)).toEqual(['event', 'webhook', 'event']);
		sent.clear();
		expect(sent.all).toEqual([]);
	});

	it('puts fetch back, and stops listening', () => {
		const stub = globalThis.fetch;
		sent.restore();

		expect(globalThis.fetch).not.toBe(stub);
		emit(1, 'update', {});
		expect(sent.all).toEqual([]);

		// Installed again for afterEach to remove.
		sent = effects();
	});
});

describe('action(), the caller for form actions', () => {
	it('finds the pages that have a +page.server.ts', () => {
		expect(pagePatterns()).toContain('/invite/[token]');
		expect(pagePatterns()).toContain('/setup');
	});

	it('returns what fail() was given', async () => {
		const res = await action('/setup', {
			form: { username: 'a', email: 'first@example.test', password: 'long enough', confirmPassword: 'long enough' }
		});

		expect(res).toMatchObject({
			type: 'failure',
			status: 400,
			data: { error: 'Username must be at least 2 characters' }
		});
		expect(db.select().from(users).all()).toHaveLength(0);
	});

	it('returns a redirect, and the cookies the action set', async () => {
		const res = await action('/setup', {
			form: {
				username: 'first',
				email: 'First@example.test',
				password: 'long enough',
				confirmPassword: 'long enough'
			}
		});

		expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/' });
		const created = db.select().from(users).all();
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ username: 'first', email: 'first@example.test', role: 'superadmin' });

		const cookie = res.cookies[SESSION_COOKIE_NAME];
		expect(cookie.options).toMatchObject({ path: '/', httpOnly: true });
		expect(db.select().from(sessions).all().map((s) => s.userId)).toEqual([created[0].id]);
	});

	it('passes route parameters, and cookies the browser sent', async () => {
		const invalid = await action('/invite/no-such-token', {
			form: { password: 'long enough', confirmPassword: 'long enough' }
		});
		expect(invalid).toMatchObject({
			type: 'failure',
			status: 400,
			data: { error: expect.stringMatching(/^This invite link no longer works\./) }
		});

		const out = await action('/logout', { cookies: { [SESSION_COOKIE_NAME]: 'not-a-session' } });
		expect(out).toMatchObject({ type: 'redirect', location: '/login' });
		expect(out.deletedCookies).toEqual([SESSION_COOKIE_NAME]);
	});

	it('fails the test for a page or an action that is not there', async () => {
		await expect(action('/no/such/page')).rejects.toThrow(/No page with a \+page\.server\.ts matches/);
		await expect(action('/setup', { name: 'rename' })).rejects.toThrow(/has no "rename" action/);
		// A page that loads data and has no actions at all.
		await expect(action('/archived')).rejects.toThrow(/has no "default" action/);
	});
});

describe('pageLoad(), the caller for page loads', () => {
	it('finds every page and layout that has a server load', () => {
		expect(loadKeys()).toContain('layout /');
		expect(loadKeys()).toContain('page /');
		expect(loadKeys()).toContain('page /board/[id]');
		expect(loadKeys()).not.toContain('page /api/cards');
	});

	it('returns what the load returns, given the route parameters and the caller', async () => {
		const owner = makeUser();
		const { board } = makeBoard({ owner, name: 'Read by its page' });

		const page = await pageLoad(`/board/${board.id}`, { user: owner });
		expect(page.type).toBe('data');
		expect(page.type === 'data' && page.data.board.name).toBe('Read by its page');

		expect(await pageLoad('/', { user: owner, layout: true })).toEqual({ type: 'data', data: { user: owner } });
	});

	// It imports two pages' loads, and on a cold cache that once took longer
	// than the 5 seconds a test is given.
	it('returns a redirect, and an error', { timeout: 30_000 }, async () => {
		const user = makeUser();

		expect(await pageLoad('/admin', { user })).toEqual({ type: 'redirect', status: 303, location: '/' });
		expect(await pageLoad('/board/99999', { user })).toEqual({ type: 'error', status: 404, body: { message: 'Board not found' } });
	});

	it('fails the test for a page that is not there', async () => {
		await expect(pageLoad('/no/such/page')).rejects.toThrow(/No page with a \+page\.server\.ts matches/);
		await expect(pageLoad('/all', { layout: true })).rejects.toThrow(/No layout with a \+layout\.server\.ts matches/);
	});
});

describe('readBudget(), which stops a walk that does not end', () => {
	it('counts every read of every table, inside a transaction or not, and no write', () => {
		const owner = makeUser();
		makeBoard({ owner });

		const budget = readBudget(10);
		try {
			db.select().from(users).all();
			sqlite.prepare('SELECT COUNT(*) AS n FROM columns').get();
			inTransaction(() => {
				db.select().from(cards).all();
				for (const row of sqlite.prepare('SELECT id FROM boards').iterate()) void row;
				db.update(users).set({ emoji: '🦊' }).where(eq(users.id, owner.id)).run();
			});
			expect(budget.count).toBe(4);
			expect(budget.spent).toBe(false);
		} finally {
			budget.restore();
		}
	});

	it('refuses the read past the limit, and says the budget was spent even if that is caught', () => {
		const budget = readBudget(2);
		try {
			db.select().from(users).all();
			db.select().from(users).all();
			expect(() => db.select().from(users).all()).toThrow(ReadBudgetSpent);
			expect(budget.spent).toBe(true);
		} finally {
			budget.restore();
		}

		// Restored, nothing is counted or refused.
		for (let i = 0; i < 5; i++) db.select().from(users).all();
		expect(budget.count).toBe(3);
	});

	it('cannot be installed with watchReads, failingWrite or another of itself', () => {
		const reads = watchReads('boards');
		try {
			expect(() => readBudget(10)).toThrow(/already wrapped/);
		} finally {
			reads.restore();
		}
		const writes = failingWrite();
		try {
			expect(() => readBudget(10)).toThrow(/already wrapped/);
		} finally {
			writes.restore();
		}
		const budget = readBudget(10);
		try {
			expect(() => readBudget(10)).toThrow(/already wrapped/);
			expect(() => watchReads('boards')).toThrow(/already wrapped/);
		} finally {
			budget.restore();
		}
	});
});

describe('the builders', () => {
	it('makeDependency records which end waits, for cards and for subtasks', () => {
		const owner = makeUser();
		const { cols } = makeBoard({ owner });
		const first = makeCard(cols['To Do']);
		const second = makeCard(cols['To Do']);
		const step = makeSubtask(first);

		makeDependency({ blocked: second, blocker: first, createdBy: owner });
		makeDependency({ blocked: second, blocker: step });
		makeDependency({ blocked: { kind: 'subtask', id: step.id }, blocker: { kind: 'card', id: 99 } });

		expect(db.select().from(workDependencies).all()).toMatchObject([
			{ blockedType: 'card', blockedId: second.id, blockerType: 'card', blockerId: first.id, createdByUserId: owner.id },
			{ blockedType: 'card', blockedId: second.id, blockerType: 'subtask', blockerId: step.id },
			{ blockedType: 'subtask', blockedId: step.id, blockerType: 'card', blockerId: 99 }
		]);
		// The planning code reads it the same way round, for the board's owner.
		const state = getWorkDependencies(second.id, owner);
		expect(state.isBlocked).toBe(true);
		expect(state.blockedBy.map((b) => `${b.kind}:${b.id}`).sort()).toEqual([`card:${first.id}`, `subtask:${step.id}`]);
	});

	it('makeMilestone attaches the cards it is given', () => {
		const owner = makeUser();
		const { board, cols } = makeBoard({ owner });
		const inIt = makeCard(cols['To Do']);
		const notInIt = makeCard(cols['To Do']);

		const milestone = makeMilestone({ board, createdBy: owner, cards: [inIt] });
		const crossBoard = makeMilestone();

		expect(milestone).toMatchObject({ boardId: board.id, createdBy: owner.id, status: 'open' });
		expect(crossBoard.boardId).toBeNull();
		expect(db.select().from(cards).where(eq(cards.id, inIt.id)).get()?.milestoneId).toBe(milestone.id);
		expect(db.select().from(cards).where(eq(cards.id, notInIt.id)).get()?.milestoneId).toBeNull();
	});

	it('makeComment writes a comment by its author', () => {
		const owner = makeUser();
		const { cols } = makeBoard({ owner });
		const card = makeCard(cols['To Do']);

		const comment = makeComment(card, owner, 'Looks right to me');

		expect(db.select().from(cardComments).all()).toEqual([comment]);
		expect(comment).toMatchObject({ cardId: card.id, userId: owner.id, content: 'Looks right to me' });
	});

	it('resetDb starts again what mail has done since the server started (card 2196)', async () => {
		const sent = effects({ refuseMailTo: ['refused@example.test'] });
		try {
			makeSmtp();
			await sendEmail('taken@example.test', 'One', '<p>1</p>');
			await sendEmail('refused@example.test', 'Two', '<p>2</p>');
			expect(mailStatus()).toMatchObject({ sent: 1, failed: 1, lastFailure: { subject: 'Two' } });
			const since = mailStatus().since;
			await new Promise((resolve) => setTimeout(resolve, 5));

			resetDb();

			expect(mailStatus()).toEqual({ since: expect.any(String), sent: 0, failed: 0, lastSentAt: null, lastFailure: null });
			expect(mailStatus().since > since).toBe(true);
		} finally {
			sent.restore();
		}
	});

	it('makeSubBoard hangs a board with cards off a card, to any depth', () => {
		const owner = makeUser();
		const { cols } = makeBoard({ owner });
		const parent = makeCard(cols['To Do']);

		const sub = makeSubBoard(parent, { owner, cards: { 'To Do': 2, Complete: 1 } });
		const deeper = makeSubBoard(sub.cards[0], { owner });

		expect(sub.board.parentCardId).toBe(parent.id);
		expect(sub.cards.map((c) => c.columnId)).toEqual([
			sub.cols['To Do'].id,
			sub.cols['To Do'].id,
			sub.cols['Complete'].id
		]);
		expect(deeper.board.parentCardId).toBe(sub.cards[0].id);
		expect(deeper.cards).toHaveLength(1);
		// It is a sub-board to the application too: the parent cannot be completed.
		expect(getCompletionBlocker(parent.id)).toMatch(/has 2 incomplete cards/);
	});
});

describe('eachWriteInTurn', () => {
	const build = () => {
		const owner = makeUser();
		return makeBoard({ owner });
	};

	it('passes a request that is all or nothing, and reports its writes and effects', async () => {
		const run = await eachWriteInTurn({
			build,
			request: ({ board }) =>
				inTransaction(() => {
					setting('a');
					setting('b');
					emit(board.id, 'update', { type: 'card' });
					return 'saved';
				})
		});

		expect(run.writes).toHaveLength(2);
		expect(run.result).toBe('saved');
		expect(run.effects).toMatchObject([{ kind: 'event', event: 'update' }]);
	});

	it('catches a request that keeps its first write when its second fails', async () => {
		await expect(
			eachWriteInTurn({
				build,
				request: () => {
					setting('a');
					setting('b');
				}
			})
		).rejects.toThrow(/with write 2 of 2 failed \(insert into "settings".*\): the database is not as it was[\s\S]*settings: row/);
	});

	it('catches a request that announces something and then fails', async () => {
		await expect(
			eachWriteInTurn({
				build,
				request: ({ board }) => {
					// Outside any transaction, so it is sent at once.
					emit(board.id, 'update', { type: 'card' });
					setting('a');
				}
			})
		).rejects.toThrow(/nothing was saved, but 1 effect\(s\) were sent: event update/);
	});

	it('catches an effect that starts while the transaction is still open', async () => {
		await expect(
			eachWriteInTurn({
				build,
				request: () =>
					sqlite.transaction(() => {
						setting('a');
						void fetch('https://hooks.example.test/too-early', { method: 'POST', body: '{}' });
					})()
			})
		).rejects.toThrow(/1 effect\(s\) started while the transaction was still open: webhook/);
	});

	it('catches a request that swallows the failure and reports success', async () => {
		await expect(
			eachWriteInTurn({
				build,
				request: () => {
					try {
						setting('a');
					} catch {
						// Carried on from.
					}
					return { status: 200 };
				}
			})
		).rejects.toThrow(/the request reported success/);
	});

	it('accepts a 500 as a failure, and passes a crash of another kind on', async () => {
		const run = await eachWriteInTurn({
			build,
			request: () => {
				try {
					inTransaction(() => setting('a'));
					return { status: 200 };
				} catch {
					return { status: 500 };
				}
			}
		});
		expect(run.writes).toHaveLength(1);

		await expect(
			eachWriteInTurn({
				build,
				request: () => {
					try {
						inTransaction(() => setting('a'));
					} catch {
						throw new Error('a fault of its own');
					}
				}
			})
		).rejects.toThrow('a fault of its own');
	});

	it('refuses a request that writes nothing', async () => {
		await expect(eachWriteInTurn({ build, request: () => db.select().from(settings).all() })).rejects.toThrow(
			/made no write/
		);
	});

	it('removes what it installed, whether it passed or not', async () => {
		await eachWriteInTurn({ build, request: () => inTransaction(() => setting('a')) });
		await eachWriteInTurn({ build, request: () => setting('a') }).catch(() => {});

		// Either would throw if the last one were still installed.
		failingWrite().restore();
		effects().restore();
	});
});
