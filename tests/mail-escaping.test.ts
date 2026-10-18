/**
 * Text in a mail is text (card 2149).
 *
 * The report emailed by hand put the board's or grouping's name and the
 * sender's username into its HTML as they were typed, the scheduled report
 * did the same with the schedule's name, and the backup failure mail with the
 * destination's name and the error text another server answered. Anyone with
 * an account can name a board and email its report to any address, so anyone
 * could have the server's own sender deliver HTML of their choosing: a link,
 * or a styled "sign in again" button.
 *
 * The rule now (`src/lib/escape-html.ts`): every text put into a mail's HTML
 * goes through `escapeHtml` where it is put, a link in `href` included, and a
 * subject stays plain text. Each mail is sent here with markup in every text
 * it carries, and the HTML recorded by `effects()` must hold that markup
 * escaped and never as it was written. `notifications.ts` already escaped its
 * texts with a function of its own; its fifteen mails are swept too, so that
 * the move to the one function, and any mail added later, is held to the rule.
 * (There were sixteen: the mail for a new card, which nothing sent, went with
 * card 2010.)
 *
 * No mail leaves: `effects()` records each one. No destination is reached:
 * `createDestination` is replaced, for this file, by one whose upload fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SessionUser } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { boardCategories, boards, reportSchedules, settings, taskRequests, type Board, type Card } from '$lib/server/db/schema';
import { runBackup, saveBackupConfig } from '$lib/server/backup';
import * as notifications from '$lib/server/notifications';
import { initReportScheduler } from '$lib/server/reports';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { addBoardMember, assignCard, makeBoard, makeCard, makeSmtp, makeUser, resetDb } from './helpers/fixtures';

/** What the stand-in destination's upload fails with: as another server might answer. */
const UPLOAD_FAILURE = vi.hoisted(() => '<b>refused</b>');

vi.mock('$lib/server/backup-destinations', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/backup-destinations')>();
	return {
		...real,
		// A destination that reaches nowhere and refuses every upload.
		createDestination: (config: { type: string; name: string }) => ({
			type: config.type,
			name: config.name,
			test: async () => ({ success: false, message: UPLOAD_FAILURE }),
			upload: async () => {
				throw new Error(UPLOAD_FAILURE);
			},
			list: async () => [],
			delete: async () => {}
		})
	};
});

/** A link, as a name somebody gave a board, a grouping or a schedule. */
const LINK = '<a href="https://evil.test/">Click here</a>';
const LINK_ESCAPED = '&lt;a href=&quot;https://evil.test/&quot;&gt;Click here&lt;/a&gt;';
/** A marker for every other text. */
const MARKER = '<i data-x="1">x</i>';
const MARKER_ESCAPED = '&lt;i data-x=&quot;1&quot;&gt;x&lt;/i&gt;';

let sent: Effects;

beforeEach(() => {
	resetDb();
	makeSmtp();
	sent = effects();
});

afterEach(() => {
	sent.restore();
	vi.useRealTimers();
});

/** The one mail recorded, which must be there. */
function onlyMail() {
	expect(sent.emails).toHaveLength(1);
	return sent.emails[0];
}

describe('the report emailed by hand', () => {
	let sender: SessionUser;
	let board: Board;

	beforeEach(() => {
		// The sender's username is set by an administrator, and is escaped all the same.
		sender = makeUser({ username: MARKER });
		({ board } = makeBoard({ owner: sender, name: LINK }));
	});

	const email = (body: Record<string, unknown>) =>
		api('POST', '/api/reports/email', {
			user: sender,
			body: { periodStart: '2026-10-01', periodEnd: '2026-10-14', recipients: ['someone@example.test'], ...body }
		});

	it("escapes a board's name and the sender's username, and keeps the name as typed in the subject", async () => {
		const res = await email({ scope: 'board', scopeId: board.id });

		expect(res.status).toBe(200);
		const mail = onlyMail();
		expect(mail.html).toContain(`<strong>${LINK_ESCAPED}</strong>`);
		expect(mail.html).toContain(`Sent by ${MARKER_ESCAPED} via DumpFire`);
		expect(mail.html).not.toContain(LINK);
		expect(mail.html).not.toContain(MARKER);
		expect(mail.html).toContain('Period: 1 Oct 2026 — 14 Oct 2026');
		expect(mail.subject).toBe(`DumpFire Report: ${LINK}`);
	});

	it("escapes a grouping's name the same way", async () => {
		const grouping = db.insert(boardCategories).values({ name: LINK }).returning().get();
		db.update(boards).set({ categoryId: grouping.id }).where(eq(boards.id, board.id)).run();

		const res = await email({ scope: 'category', scopeId: grouping.id });

		expect(res.status).toBe(200);
		const mail = onlyMail();
		expect(mail.html).toContain(`<strong>${LINK_ESCAPED}</strong>`);
		expect(mail.html).not.toContain(LINK);
		expect(mail.html).not.toContain(MARKER);
		expect(mail.subject).toBe(`DumpFire Report: ${LINK}`);
	});
});

describe('the scheduled report', () => {
	it("escapes the schedule's name, and keeps it as typed in the subject", { timeout: 30_000 }, async () => {
		const owner = makeUser();
		const { board } = makeBoard({ owner, name: 'Sales' });
		db.insert(reportSchedules)
			.values({
				userId: owner.id,
				name: LINK,
				scope: 'board',
				scopeId: board.id,
				recipients: 'someone@example.test',
				nextRunAt: '2000-01-01T00:00:00.000Z'
			})
			.run();

		// The scheduler's minute, made to pass at once. Only the interval is
		// faked: the report's PDF is built on the real clock.
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		initReportScheduler();
		vi.advanceTimersByTime(60_000);
		await vi.waitFor(() => expect(sent.emails).toHaveLength(1), { timeout: 20_000 });

		const mail = onlyMail();
		expect(mail.html).toContain(`<strong>${LINK_ESCAPED} - Weekly Report</strong>`);
		expect(mail.html).not.toContain(LINK);
		expect(mail.subject).toBe(`DumpFire Report: ${LINK} - Weekly Report`);
	});
});

describe('the backup failure mail', () => {
	it("escapes the destination's name and type and the error it answered", async () => {
		saveBackupConfig({
			schedule: 'disabled',
			scheduleTime: '02:00',
			scheduleDay: 0,
			retention: 7,
			destinations: [
				{ type: MARKER, name: MARKER } as unknown as Parameters<typeof saveBackupConfig>[0]['destinations'][number]
			],
			notifyOnFailure: true,
			notifyEmail: 'chief@example.test'
		});

		const results = await runBackup();

		expect(results).toEqual([expect.objectContaining({ status: 'failed', message: UPLOAD_FAILURE })]);
		const mail = onlyMail();
		expect(mail.to).toBe('chief@example.test');
		expect(mail.html).toContain(`<strong>${MARKER_ESCAPED}</strong> (${MARKER_ESCAPED}) failed.`);
		expect(mail.html).toContain('&lt;b&gt;refused&lt;/b&gt;');
		expect(mail.html).not.toContain(MARKER);
		expect(mail.html).not.toContain(UPLOAD_FAILURE);
	});
});

describe('every mail in notifications.ts', () => {
	/**
	 * The address every link begins with: the App URL as somebody might type
	 * it, with a quote that would end an `href` written bare.
	 */
	const BASE = 'https://dumpfire.example.test/a"b';
	const BASE_ESCAPED = 'https://dumpfire.example.test/a&quot;b';
	const REQUESTER = 'pat@example.test';
	const TOKEN = 'a'.repeat(64);

	let recipient: SessionUser;
	let actor: SessionUser;
	let board: Board;
	let card: Card;

	beforeEach(() => {
		recipient = makeUser();
		actor = makeUser();
		const made = makeBoard({ owner: recipient, name: MARKER });
		board = made.board;
		card = makeCard(made.cols['To Do'], { title: MARKER, description: MARKER, businessValue: MARKER });
		assignCard(card, recipient);
		db.insert(taskRequests)
			.values({
				targetType: 'user',
				targetId: recipient.id,
				requesterName: MARKER,
				requesterEmail: REQUESTER,
				title: MARKER,
				status: 'accepted',
				resolvedCardId: card.id,
				accessToken: TOKEN
			})
			.run();
	});

	/** Each mail, sent with the marker in every text it is handed or finds in a row. */
	const MAILS: { name: string; link: boolean; send: () => void }[] = [
		{
			name: 'notifyCardMoved',
			link: true,
			send: () => notifications.notifyCardMoved(board.id, card.id, MARKER, MARKER, MARKER, MARKER, actor.id, BASE)
		},
		{
			name: 'notifyUserAssigned',
			link: true,
			send: () => notifications.notifyUserAssigned(board.id, card.id, MARKER, recipient.email, MARKER, MARKER, BASE)
		},
		{ name: 'sendInviteEmail', link: true, send: () => notifications.sendInviteEmail('new@example.test', MARKER, TOKEN, BASE) },
		{
			name: 'notifyBoardShared',
			link: true,
			send: () => notifications.notifyBoardShared(board.id, MARKER, recipient.email, MARKER, MARKER, MARKER, BASE)
		},
		{
			name: 'notifyTaskRequest',
			link: true,
			send: () => notifications.notifyTaskRequest('user', recipient.id, MARKER, MARKER, MARKER, BASE)
		},
		{
			name: 'notifyCommentAdded',
			link: true,
			send: () => notifications.notifyCommentAdded(board.id, card.id, MARKER, MARKER, MARKER, actor.id, BASE)
		},
		{ name: 'notifyRequesterAccepted', link: false, send: () => notifications.notifyRequesterAccepted(REQUESTER, MARKER, MARKER) },
		{
			name: 'notifyRequesterRejected',
			link: false,
			send: () => notifications.notifyRequesterRejected(REQUESTER, MARKER, MARKER, MARKER)
		},
		{
			name: 'notifyRequesterConfirm',
			link: true,
			send: () => notifications.notifyRequesterConfirm(REQUESTER, MARKER, `${BASE}/request/1/confirm?token=${TOKEN}`)
		},
		{
			name: 'notifyRequesterMessage',
			link: true,
			send: () => notifications.notifyRequesterMessage(REQUESTER, MARKER, MARKER, MARKER, `${BASE}/request/1/reply?token=${TOKEN}`)
		},
		{
			// Card 2158: the link a requester asks for, to replace one that no longer works.
			name: 'notifyRequesterNewLink',
			link: true,
			send: () => notifications.notifyRequesterNewLink(REQUESTER, MARKER, `${BASE}/request/1/reply?token=${TOKEN}`, false)
		},
		{
			name: 'notifyAdminMessage',
			link: true,
			send: () => notifications.notifyAdminMessage('user', recipient.id, MARKER, MARKER, MARKER, BASE)
		},
		...(['comment', 'moved', 'subtask_completed', 'completed'] as const).map((action) => ({
			name: `notifyRequesterProgress (${action})`,
			link: true,
			send: () =>
				notifications.notifyRequesterProgress({
					cardId: card.id,
					action,
					summary: MARKER,
					actorName: MARKER,
					baseUrl: BASE,
					toColumn: MARKER,
					fromColumn: MARKER,
					actorUserId: actor.id
				})
		})),
		{
			name: 'notifyCardUnblocked',
			link: true,
			send: () => notifications.notifyCardUnblocked(board.id, card.id, MARKER, 99, MARKER, MARKER, BASE)
		},
		{
			name: 'notifyPlanCreated',
			link: true,
			send: () =>
				notifications.notifyPlanCreated(
					{
						milestoneId: 1,
						name: MARKER,
						cardCount: 1,
						boards: [MARKER],
						criticalPath: [{ id: card.id, title: MARKER }],
						startable: 1,
						blocked: 0
					},
					[card.id],
					MARKER,
					actor.id,
					BASE
				)
		},
		{
			name: 'notifyMention',
			link: true,
			send: () => notifications.notifyMention(recipient, MARKER, card.id, MARKER, MARKER, board.id, BASE)
		}
	];

	it('has a case for every mail the module exports', () => {
		const exported = Object.entries(notifications)
			.filter(([name, value]) => typeof value === 'function' && name !== 'getUserNotifPrefs')
			.map(([name]) => name)
			.sort();
		const covered = [...new Set(MAILS.map((mail) => mail.name.split(' ')[0]))].sort();

		// A mail added to notifications.ts is added here, with markup in what it carries.
		expect(covered).toEqual(exported);
	});

	it.each(MAILS)('$name escapes every text it carries, and its link', { timeout: 30_000 }, async ({ send, link }) => {
		send();
		// The progress mail is sent after an await, and its completion builds a PDF first.
		await vi.waitFor(() => expect(sent.emails.length).toBeGreaterThan(0), { timeout: 20_000 });

		for (const mail of sent.emails) {
			expect(mail.html).not.toContain(MARKER);
			expect(mail.html).toContain(MARKER_ESCAPED);
			expect(mail.html).not.toContain('a"b');
			if (link) expect(mail.html).toContain(`href="${BASE_ESCAPED}/`);
		}
	});
});

describe('a link built from the App URL setting', () => {
	it('is escaped in the href, so a quote in the setting cannot end it', async () => {
		db.insert(settings).values({ key: 'app_url', value: 'https://dumpfire.example.test/a"b' }).run();
		const owner = makeUser();
		const commenter = makeUser();
		const { board, cols } = makeBoard({ owner, name: 'A board' });
		addBoardMember(board, commenter, 'editor');
		const card = makeCard(cols['To Do'], { title: 'A card' });

		const res = await api('POST', `/api/cards/${card.id}/comments`, { user: commenter, body: { content: 'Looks right' } });

		expect(res.status).toBe(201);
		const mail = onlyMail();
		expect(mail.to).toBe(owner.email);
		expect(mail.html).toContain(`href="https://dumpfire.example.test/a&quot;b/board/${board.id}?card=${card.id}"`);
		expect(mail.html).not.toContain('a"b');
	});
});

/**
 * The mails to a card's assignees go only to the assignees who can open the
 * board the mail is about (card 2180), whoever calls them. Taking someone off
 * a board leaves them assigned to its cards, and each of these mails names the
 * card, the board and who did what.
 */
describe('the mails to a card\'s assignees', () => {
	const BASE = 'https://dumpfire.example.test';
	const MAILS: { name: string; send: (boardId: number, cardId: number, moverId: number) => void }[] = [
		{
			name: 'notifyCardMoved',
			send: (boardId, cardId, moverId) =>
				notifications.notifyCardMoved(boardId, cardId, 'Secret', 'owner', 'To Do', 'Done', moverId, BASE)
		},
		{
			name: 'notifyCardUnblocked',
			send: (boardId, cardId) => notifications.notifyCardUnblocked(boardId, cardId, 'Secret', 99, 'Other', 'owner', BASE)
		}
	];

	it.each(MAILS)('$name mails no assignee who cannot open the board, and one who can', async ({ send }) => {
		const owner = makeUser();
		const outsider = makeUser();
		const { board, cols } = makeBoard({ owner, name: 'Private' });
		const card = makeCard(cols['To Do'], { title: 'Secret' });
		assignCard(card, outsider);

		send(board.id, card.id, owner.id);
		await sent.settle();
		expect(sent.emails).toEqual([]);

		// The same call, once they can open the board.
		addBoardMember(board, outsider, 'viewer');
		send(board.id, card.id, owner.id);
		await sent.settle();
		expect(sent.emails.map((mail) => mail.to)).toEqual([outsider.email]);
	});
});
