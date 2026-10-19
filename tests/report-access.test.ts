/**
 * A report holds only the boards its reader can open (card 2150).
 *
 * A board report, and a grouping's, walked from its boards into every
 * sub-board beneath them, to any depth, asking nothing. Access is not
 * inherited from a parent board, so an ordinary member of a board could
 * download, mail to any address, or schedule weekly, a PDF holding the card
 * titles, descriptions and assignees of sub-boards they were never given. And
 * a board in the report whose parent board the reader cannot open was shown
 * with that parent's name.
 *
 * Now the walk follows only the sub-boards the reader can open, and does not
 * pass through one they cannot. A parent is named only when they can open it.
 * The reader is the caller who downloads or mails the report, and the
 * schedule's owner, as their account stands at the run. The Reports page
 * offers each board they can open whose parent they cannot, which no report
 * of theirs reaches any more.
 *
 * The world:
 *
 *   BOARD-A (owner; viewer is a member), in grouping GROUP-G
 *     A-CARD-1 ─ HIDDEN (owner's, not shared), card HIDDEN-CARD
 *                  └ HIDDEN-CARD ─ DEEP (shared with viewer), card DEEP-CARD
 *     A-CARD-2 ─ SHOWN (shared with viewer), card SHOWN-CARD
 *   PARENT-SECRET (owner's, not shared), card PS-CARD
 *     PS-CARD ─ SHARED-CHILD (shared with viewer), card CHILD-CARD
 *
 * Every PDF is read with `pdfText` (tests/helpers/pdf.ts), and as Latin-1
 * bytes for the names it must not hold anywhere. The administrator's reports
 * are the positive control: what a reader's report leaves out is there for
 * someone who can open everything, so a "not in it" is not a PDF that could
 * not be read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { boardCategories, boards, reportSchedules, users } from '$lib/server/db/schema';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { generateBoardReport, generateCategoryReport, runDueReportSchedules } from '$lib/server/reports';
import { pageLoad } from './helpers/actions';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import {
	addBoardMember,
	makeBoard,
	makeCard,
	makeSession,
	makeSmtp,
	makeSubBoard,
	makeUser,
	resetDb,
	type BoardFixture
} from './helpers/fixtures';
import { gate } from './helpers/gate';
import { pdfText } from './helpers/pdf';

const PERIOD_START = '2026-01-01';
const periodEnd = () => new Date().toISOString().slice(0, 10);

/** What a reader who cannot open HIDDEN must find nowhere in a report of A or G. */
const HIDDEN_NAMES = ['HIDDEN', 'HIDDEN-CARD', 'DEEP', 'DEEP-CARD'];

type World = {
	owner: SessionUser;
	viewer: SessionUser;
	admin: SessionUser;
	A: BoardFixture;
	groupingId: number;
	hidden: BoardFixture;
	shown: BoardFixture;
	deep: BoardFixture;
	parentSecret: BoardFixture;
	sharedChild: BoardFixture;
};

let w: World;
let sent: Effects | null = null;

function world(): World {
	const owner = makeUser({ username: 'owner' });
	const viewer = makeUser({ username: 'viewer' });
	const admin = makeUser({ username: 'admin', role: 'admin' });

	const groupingId = db.insert(boardCategories).values({ name: 'GROUP-G' }).returning().get().id;
	const A = makeBoard({ owner, name: 'BOARD-A' });
	db.update(boards).set({ categoryId: groupingId }).where(eq(boards.id, A.board.id)).run();
	addBoardMember(A.board, viewer, 'viewer');
	const a1 = makeCard(A.cols['To Do'], { title: 'A-CARD-1' });
	const a2 = makeCard(A.cols['To Do'], { title: 'A-CARD-2' });

	const hidden = makeSubBoard(a1, { owner, name: 'HIDDEN', cards: {} });
	const hiddenCard = makeCard(hidden.cols['To Do'], { title: 'HIDDEN-CARD' });
	const deep = makeSubBoard(hiddenCard, { owner, name: 'DEEP', cards: {} });
	makeCard(deep.cols['To Do'], { title: 'DEEP-CARD' });
	addBoardMember(deep.board, viewer, 'viewer');

	const shown = makeSubBoard(a2, { owner, name: 'SHOWN', cards: {} });
	makeCard(shown.cols['To Do'], { title: 'SHOWN-CARD' });
	addBoardMember(shown.board, viewer, 'viewer');

	const parentSecret = makeBoard({ owner, name: 'PARENT-SECRET' });
	const psCard = makeCard(parentSecret.cols['To Do'], { title: 'PS-CARD' });
	const sharedChild = makeSubBoard(psCard, { owner, name: 'SHARED-CHILD', cards: {} });
	makeCard(sharedChild.cols['To Do'], { title: 'CHILD-CARD' });
	addBoardMember(sharedChild.board, viewer, 'viewer');

	return { owner, viewer, admin, A, groupingId, hidden, shown, deep, parentSecret, sharedChild };
}

beforeEach(() => {
	resetDb();
	w = world();
});

afterEach(() => {
	sent?.restore();
	sent = null;
});

type Scope = { scope: 'board' | 'category'; scopeId: number };

/** The PDF a download answers, through the gate with the reader's session. */
async function downloaded(reader: SessionUser, { scope, scopeId }: Scope): Promise<Buffer> {
	const res = await gate('POST', '/api/reports', {
		headers: { cookie: `${SESSION_COOKIE_NAME}=${makeSession(reader)}`, accept: '*/*' },
		body: { scope, scopeId, periodStart: PERIOD_START, periodEnd: periodEnd() }
	});
	expect(res.status).toBe(200);
	expect(res.headers.get('content-type')).toBe('application/pdf');
	return Buffer.from(await res.arrayBuffer());
}

/** The PDF attached to the mail the reader sends. */
async function mailed(reader: SessionUser, { scope, scopeId }: Scope): Promise<Buffer> {
	makeSmtp();
	sent = effects();
	const res = await api('POST', '/api/reports/email', {
		user: reader,
		body: { scope, scopeId, periodStart: PERIOD_START, periodEnd: periodEnd(), recipients: ['outside@example.test'] }
	});
	expect(res.status).toBe(200);
	return attached(sent);
}

/** The PDF a schedule of the reader's mails at its run. */
async function scheduled(reader: SessionUser, { scope, scopeId }: Scope): Promise<Buffer> {
	makeSmtp();
	sent = effects();
	schedule(reader, { scope, scopeId });
	await runDueReportSchedules(new Date());
	return attached(sent);
}

/** A schedule of `owner`'s, due now, to one outside address. */
function schedule(owner: SessionUser, { scope, scopeId }: Scope): void {
	db.insert(reportSchedules)
		.values({ userId: owner.id, name: 'Weekly', scope, scopeId, recipients: 'outside@example.test', nextRunAt: '2000-01-01 00:00:00' })
		.run();
}

/** The one PDF of the one mail recorded. */
function attached(recorded: Effects): Buffer {
	expect(recorded.emails.map((m) => m.to)).toEqual(['outside@example.test']);
	const [file] = recorded.emails[0].files;
	expect(file.filename).toMatch(/\.pdf$/);
	return file.content;
}

/** Every name in `names` that the PDF holds, in its text or its bytes. */
function namesIn(pdf: Buffer, names: string[]): string[] {
	const text = pdfText(pdf);
	const bytes = pdf.toString('latin1');
	return names.filter((name) => text.split('\n').some((line) => line.includes(name)) || bytes.includes(name));
}

/** The names among `names` that the PDF's text shows. */
function shownIn(pdf: Buffer, names: string[]): string[] {
	const text = pdfText(pdf);
	return names.filter((name) => text.includes(name));
}

const PATHS = [
	{ path: 'downloaded', read: downloaded },
	{ path: 'mailed', read: mailed },
	{ path: 'scheduled', read: scheduled }
] as const;

const SCOPES = [
	{ of: 'board A', scope: () => ({ scope: 'board' as const, scopeId: w.A.board.id }) },
	{ of: 'grouping G', scope: () => ({ scope: 'category' as const, scopeId: w.groupingId }) }
];

describe('a report of a board, or of a grouping, and the sub-boards beneath it', () => {
	for (const { path, read } of PATHS) {
		for (const { of, scope } of SCOPES) {
			it(`${path}, of ${of}: holds the sub-board its reader can open, and nothing of one they cannot`, { timeout: 30_000 }, async () => {
				const pdf = await read(w.viewer, scope());

				expect(shownIn(pdf, ['BOARD-A', 'A-CARD-1', 'SHOWN', 'SHOWN-CARD'])).toEqual(['BOARD-A', 'A-CARD-1', 'SHOWN', 'SHOWN-CARD']);
				// DEEP is shared with them, but beneath HIDDEN: the walk does not go through it.
				expect(namesIn(pdf, HIDDEN_NAMES)).toEqual([]);
			});

			it(`${path}, of ${of}, for an administrator: holds every sub-board`, { timeout: 30_000 }, async () => {
				const pdf = await read(w.admin, scope());

				expect(shownIn(pdf, ['SHOWN-CARD', ...HIDDEN_NAMES])).toEqual(['SHOWN-CARD', ...HIDDEN_NAMES]);
			});
		}
	}

	it('reads the same without a PDF, from the report data', () => {
		const ofBoard = generateBoardReport(w.A.board.id, PERIOD_START, periodEnd(), w.viewer)!;
		const ofGrouping = generateCategoryReport(w.groupingId, PERIOD_START, periodEnd(), w.viewer)!;

		for (const report of [ofBoard, ofGrouping]) {
			expect(report.boardBreakdown.map((b) => [b.parentBoardName, b.boardName])).toEqual([
				[null, 'BOARD-A'],
				['BOARD-A', 'SHOWN']
			]);
			const titles = report.outstandingTasks.flatMap((group) => group.tasks.map((t) => t.title));
			expect(titles.sort()).toEqual(['A-CARD-1', 'A-CARD-2', 'SHOWN-CARD']);
			expect(report.summary.totalCards).toBe(3);
		}
	});
});

describe("a board in the report whose parent board the reader cannot open", () => {
	it('is shown under its own name, as a board of its own, and the parent is named nowhere', { timeout: 30_000 }, async () => {
		const scope = { scope: 'board' as const, scopeId: w.sharedChild.board.id };
		const report = generateBoardReport(scope.scopeId, PERIOD_START, periodEnd(), w.viewer)!;

		expect(report.boardBreakdown.map((b) => [b.parentBoardName, b.boardName])).toEqual([[null, 'SHARED-CHILD']]);
		expect(report.outstandingTasks.map((g) => [g.parentBoardName, g.boardName])).toEqual([[null, 'SHARED-CHILD']]);
		expect(JSON.stringify(report)).not.toContain('PARENT-SECRET');

		const pdf = await downloaded(w.viewer, scope);
		expect(shownIn(pdf, ['SHARED-CHILD', 'CHILD-CARD'])).toEqual(['SHARED-CHILD', 'CHILD-CARD']);
		expect(namesIn(pdf, ['PARENT-SECRET', 'PS-CARD'])).toEqual([]);
	});

	it('is named under a parent the reader can open', { timeout: 30_000 }, async () => {
		const scope = { scope: 'board' as const, scopeId: w.shown.board.id };
		const report = generateBoardReport(scope.scopeId, PERIOD_START, periodEnd(), w.viewer)!;

		expect(report.boardBreakdown.map((b) => [b.parentBoardName, b.boardName])).toEqual([['BOARD-A', 'SHOWN']]);
		expect(shownIn(await downloaded(w.viewer, scope), ['BOARD-A', 'SHOWN-CARD'])).toEqual(['BOARD-A', 'SHOWN-CARD']);
	});

	it("is named under its parent in the administrator's report", () => {
		const report = generateBoardReport(w.sharedChild.board.id, PERIOD_START, periodEnd(), w.admin)!;

		expect(report.boardBreakdown.map((b) => [b.parentBoardName, b.boardName])).toEqual([['PARENT-SECRET', 'SHARED-CHILD']]);
	});
});

describe("a schedule's report is its owner's, as their account stands at the run", () => {
	it('takes in a sub-board the owner was given after the schedule was made', { timeout: 30_000 }, async () => {
		schedule(w.viewer, { scope: 'board', scopeId: w.A.board.id });
		addBoardMember(w.hidden.board, w.viewer, 'viewer');
		makeSmtp();
		sent = effects();

		await runDueReportSchedules(new Date());

		const pdf = attached(sent);
		expect(shownIn(pdf, ['SHOWN-CARD', ...HIDDEN_NAMES])).toEqual(['SHOWN-CARD', ...HIDDEN_NAMES]);
	});

	it('leaves out what an administrator made an ordinary user can no longer open', { timeout: 30_000 }, async () => {
		const former = makeUser({ username: 'former', role: 'admin' });
		addBoardMember(w.A.board, former, 'viewer');
		schedule(former, { scope: 'board', scopeId: w.A.board.id });
		db.update(users).set({ role: 'user' }).where(eq(users.id, former.id)).run();
		makeSmtp();
		sent = effects();

		await runDueReportSchedules(new Date());

		const pdf = attached(sent);
		expect(shownIn(pdf, ['BOARD-A', 'A-CARD-1'])).toEqual(['BOARD-A', 'A-CARD-1']);
		expect(namesIn(pdf, [...HIDDEN_NAMES, 'SHOWN-CARD'])).toEqual([]);
	});
});

describe('the Reports page', () => {
	const offered = async (reader: SessionUser) => {
		const res = await pageLoad('/reports', { user: reader });
		expect(res.type).toBe('data');
		return res.type === 'data' ? (res.data.boards as { name: string }[]).map((b) => b.name).sort() : [];
	};

	it('offers each board the reader can open whose parent they cannot, and no board they cannot open', async () => {
		// SHOWN is in BOARD-A's report; DEEP and SHARED-CHILD are in no report of a board above them.
		expect(await offered(w.viewer)).toEqual(['BOARD-A', 'DEEP', 'SHARED-CHILD']);
	});

	it('offers an administrator the top-level boards, as before', async () => {
		expect(await offered(w.admin)).toEqual(['BOARD-A', 'PARENT-SECRET']);
	});
});
