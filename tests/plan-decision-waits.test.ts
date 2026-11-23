/**
 * Card 2687, slice S1: a card linked to a decision as `waits` in the plan
 * view. While the decision is shown open or awaiting its ruling, and the
 * viewer may view it, the card and its ordered subtasks not ticked leave
 * `nextActionable` and join `blocked`, with the decision named by title,
 * status and closing time alone; a viewer who may not view it is given no
 * trace of it. The critical path, the layers, the reach and the progress are
 * the work's, the same for everyone (D11).
 *
 * The cases are P1 to P5 and P7 to P10 of
 * `docs/planning/card-2687-cards-waiting-on-a-decision.md`, section 9 (P6 is
 * merged into P4; P11 is in tests/bulk-endpoints.test.ts, P12 and P13 in
 * tests/openapi-document.test.ts), and P14, ruled in its section 13, added
 * with slice S2.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import { db } from '$lib/server/db';
import type { Credential, SessionUser } from '$lib/server/auth';
import { apiKeys, decisionCardLinks, type Board, type Card, type Column, type Decision } from '$lib/server/db/schema';
import { DECISION_TITLE_MAX } from '$lib/decision-rules';
import { generateMilestonePdf } from '$lib/server/milestone-report';
import { getMilestoneSummary, withDecisionWaits, workSummary, type MilestoneNode, type MilestoneSummary } from '$lib/server/planning';
import { api } from './helpers/api';
import { pdfText } from './helpers/pdf';
import {
	addBoardMember,
	makeApiKey,
	makeBoard,
	makeCard,
	makeCardLink,
	makeDecision,
	makeDependency,
	makeMilestone,
	makeParticipant,
	makeSubtask,
	makeUser,
	resetDb
} from './helpers/fixtures';

const FUTURE = '2099-01-01 12:00:00';
const OPENED = '2026-01-01 09:00:00';
const TITLE = 'DSECRET2687';

let owner: SessionUser;
let admin: SessionUser;
let reader: SessionUser;
let participant: SessionUser;
let A: Board;
let B: Board;
let todoA: Column;
let doneA: Column;
let todoB: Column;
let decision: Decision;

beforeEach(() => {
	resetDb();
	owner = makeUser({ username: 'owner' });
	admin = makeUser({ username: 'admin', role: 'admin' });
	reader = makeUser({ username: 'reader' });
	participant = makeUser({ username: 'participant' });
	const a = makeBoard({ owner, name: 'Board A' });
	const b = makeBoard({ owner, name: 'Board B' });
	A = a.board;
	B = b.board;
	todoA = a.cols['To Do'];
	doneA = a.cols['Complete'];
	todoB = b.cols['To Do'];
	// Both open board A alone. The decision is on board B: the reader may not view it; the participant, holding one live
	// row on it, may.
	addBoardMember(A, reader, 'viewer');
	addBoardMember(A, participant, 'viewer');
	decision = openOn(B, TITLE);
	makeParticipant(decision, { userId: participant.id });
});

/** An open decision on `board`, closing in the future. */
const openOn = (board: Board, title: string) => makeDecision({ board, status: 'open', closesAt: FUTURE, openedAt: OPENED, title });

/** The goal on board A holding `cards`. */
const goalOf = (...cards: Card[]) => makeMilestone({ board: A, name: 'Goal', cards });

const summaryFor = (viewer: SessionUser, goal: { id: number }) => getMilestoneSummary(goal.id, viewer)!;
const nodeOf = (summary: MilestoneSummary, kind: 'card' | 'subtask', id: number) => summary.graph.nodes.find((n) => n.kind === kind && n.id === id)!;
const keyOf = (n: { kind: string; id: number }) => `${n.kind}:${n.id}`;
const startable = (summary: MilestoneSummary) => summary.nextActionable.map(keyOf);
const waiting = (summary: MilestoneSummary) => summary.blocked.map((b) => keyOf(b.card));
const projection = (d: Decision, shownStatus = 'open', closesAt: string | null = FUTURE) => ({ id: d.id, title: d.title, shownStatus, closesAt });
const unlinkAll = () => db.delete(decisionCardLinks).run();

/** The key credential of a real API key of `user`. */
function keyCredential(user: SessionUser): Credential {
	const key = makeApiKey(user);
	const row = db.select().from(apiKeys).all().find((k) => key.startsWith(k.keyPrefix))!;
	return { kind: 'api key', id: row.id };
}

describe('a card waiting on a decision in the plan (card 2687)', () => {
	it('P1: leaves nextActionable and is in blocked with no blockers and the decision, carrying it on its node; progress is the plan’s without the link', () => {
		const held = makeCard(todoA, { title: 'Held' });
		const free = makeCard(todoA, { title: 'Free' });
		const goal = goalOf(held, free);
		makeCardLink(decision, held, { relation: 'waits' });

		const summary = summaryFor(participant, goal);
		expect(startable(summary)).toEqual([`card:${free.id}`]);
		expect(summary.blocked).toEqual([{ card: nodeOf(summary, 'card', held.id), blockers: [], decisions: [projection(decision)] }]);
		expect(nodeOf(summary, 'card', held.id).waitingOnDecisions).toEqual([projection(decision)]);
		expect(nodeOf(summary, 'card', free.id).waitingOnDecisions).toEqual([]);

		unlinkAll();
		const without = summaryFor(participant, goal);
		expect(startable(without)).toContain(`card:${held.id}`);
		expect(summary.progress).toEqual(without.progress);
	});

	it('P2: a relates link, and a stored waits_on, leave the card startable with no wait', () => {
		for (const relation of ['relates', 'waits_on']) {
			resetLinks();
			const card = makeCard(todoA);
			const goal = goalOf(card);
			makeCardLink(decision, card, { relation });

			const summary = summaryFor(participant, goal);
			expect(startable(summary), relation).toEqual([`card:${card.id}`]);
			expect(summary.blocked, relation).toEqual([]);
			expect(nodeOf(summary, 'card', card.id).waitingOnDecisions, relation).toEqual([]);
		}
	});

	it('P3: open, closed and open past its closing time hold, with their shown status; ruled, superseded, withdrawn and a planted draft release', () => {
		const cases: [string, { status: string; closesAt: string | null }, string | null][] = [
			['open', { status: 'open', closesAt: FUTURE }, 'open'],
			['closed', { status: 'closed', closesAt: OPENED }, 'awaiting_ruling'],
			['open past its closing time', { status: 'open', closesAt: OPENED }, 'awaiting_ruling'],
			['ruled', { status: 'ruled', closesAt: OPENED }, null],
			['superseded', { status: 'superseded', closesAt: OPENED }, null],
			['withdrawn', { status: 'withdrawn', closesAt: OPENED }, null],
			['draft', { status: 'draft', closesAt: null }, null]
		];
		for (const [name, row, shown] of cases) {
			const d = makeDecision({ board: A, ...row, openedAt: row.status === 'draft' ? null : OPENED, title: `Decision ${name}` });
			const card = makeCard(todoA);
			const goal = makeMilestone({ board: A, cards: [card] });
			makeCardLink(d, card, { relation: 'waits' });

			// An administrator may view every decision, a draft too: only the status decides.
			const summary = summaryFor(admin, goal);
			if (shown === null) {
				expect(startable(summary), name).toEqual([`card:${card.id}`]);
				expect(nodeOf(summary, 'card', card.id).waitingOnDecisions, name).toEqual([]);
			} else {
				expect(startable(summary), name).toEqual([]);
				expect(nodeOf(summary, 'card', card.id).waitingOnDecisions, name).toEqual([{ id: d.id, title: d.title, shownStatus: shown, closesAt: row.closesAt }]);
			}
		}
	});

	it('P4: a reader who may not view the decision is given the card startable and no trace of it; a participant is given it waiting; the chain, layers and reach are the same for both and with no link', () => {
		const held = makeCard(todoA, { title: 'Held' });
		const next = makeCard(todoA, { title: 'Next' });
		makeDependency({ blocked: next, blocker: held });
		const goal = goalOf(held, next);
		makeCardLink(decision, held, { relation: 'waits' });

		const forReader = summaryFor(reader, goal);
		expect(startable(forReader)).toEqual([`card:${held.id}`]);
		expect(waiting(forReader)).toEqual([`card:${next.id}`]);
		expect(forReader.graph.nodes.every((n) => n.waitingOnDecisions.length === 0)).toBe(true);
		expect(forReader.blocked.every((b) => b.decisions.length === 0)).toBe(true);
		expect(JSON.stringify(forReader)).not.toContain(TITLE);
		expect(JSON.stringify(forReader)).not.toContain('waits');

		const forParticipant = summaryFor(participant, goal);
		expect(startable(forParticipant)).toEqual([]);
		expect(waiting(forParticipant)).toEqual([`card:${held.id}`, `card:${next.id}`]);

		unlinkAll();
		const unlinked = summaryFor(participant, goal);
		const order = (s: MilestoneSummary) => ({
			criticalPath: s.criticalPath,
			criticalPathNodes: s.criticalPathNodes,
			layers: s.graph.layers,
			reach: s.graph.nodes.map((n) => [keyOf(n), n.downstreamCount, n.onCriticalPath, n.layer]),
			progress: s.progress
		});
		expect(order(forReader)).toEqual(order(unlinked));
		expect(order(forParticipant)).toEqual(order(unlinked));
		expect(forParticipant.criticalPath).toEqual([held.id, next.id]);
		// The step on the chain is marked for the viewer who may see the decision.
		const step = nodeOf(forParticipant, 'card', held.id);
		expect(step.onCriticalPath).toBe(true);
		expect(step.waitingOnDecisions).toEqual([projection(decision)]);
	});

	it('P5: a withheld member card carries no decision, and is placed by its dependencies alone', () => {
		// The participant may view the decision, but cannot open board B, where this member card is.
		const elsewhere = makeCard(todoB, { title: 'On B' });
		const goal = goalOf(elsewhere);
		makeCardLink(decision, elsewhere, { relation: 'waits' });

		const summary = summaryFor(participant, goal);
		const node = nodeOf(summary, 'card', elsewhere.id);
		expect(node.withheld).toBe(true);
		expect(node.waitingOnDecisions).toEqual([]);
		expect(startable(summary)).toEqual([`card:${elsewhere.id}`]);
		expect(summary.blocked).toEqual([]);
		expect(JSON.stringify(summary)).not.toContain(TITLE);
		// The owner opens B: the same card is held for them.
		expect(startable(summaryFor(owner, goal))).toEqual([]);
	});

	it('P7: a complete card, an option and an external blocker carry no wait; an ordered subtask of a waiting card not ticked carries its card’s, a ticked one none', () => {
		const optionsBoard = makeBoard({ owner, name: 'Board O', options: true });
		const done = makeCard(doneA, { title: 'Done' });
		const option = makeCard(optionsBoard.cols['Options'], { title: 'Option' });
		const external = makeCard(todoA, { title: 'External' });
		const member = makeCard(todoA, { title: 'Member' });
		makeDependency({ blocked: member, blocker: external });
		const held = makeCard(todoA, { title: 'Held' });
		const open = makeSubtask(held, { title: 'Open step', completed: false });
		const ticked = makeSubtask(held, { title: 'Ticked step', completed: true });
		makeDependency({ blocked: open, blocker: ticked });
		const goal = goalOf(done, option, member, held);
		for (const card of [done, option, external, held]) makeCardLink(decision, card, { relation: 'waits' });

		const summary = summaryFor(owner, goal);
		for (const [name, node] of [
			['complete', nodeOf(summary, 'card', done.id)],
			['option', nodeOf(summary, 'card', option.id)],
			['external', nodeOf(summary, 'card', external.id)],
			['ticked step', nodeOf(summary, 'subtask', ticked.id)]
		] as [string, MilestoneNode][]) {
			expect(node.waitingOnDecisions, name).toEqual([]);
			expect(waiting(summary), name).not.toContain(keyOf(node));
		}
		expect(nodeOf(summary, 'card', external.id).external).toBe(true);
		expect(summary.blocked.find((b) => b.card.id === member.id && b.card.kind === 'card')).toMatchObject({
			blockers: [expect.objectContaining({ kind: 'card', id: external.id })],
			decisions: []
		});

		const step = nodeOf(summary, 'subtask', open.id);
		expect(step.waitingOnDecisions).toEqual([projection(decision)]);
		expect(startable(summary)).not.toContain(`subtask:${open.id}`);
		expect(summary.blocked.find((b) => keyOf(b.card) === `subtask:${open.id}`)).toEqual({ card: step, blockers: [], decisions: [projection(decision)] });
		// The same plan for the reader, who may not view the decision: the step is startable.
		expect(startable(summaryFor(reader, goal))).toContain(`subtask:${open.id}`);
	});

	it('P8: a card with an open blocker and a wait is in blocked once, with both; blocked is in order of blockers and decisions together, then id', () => {
		const second = openOn(B, 'Second');
		makeParticipant(second, { userId: participant.id });
		const blockerOne = makeCard(todoA, { title: 'Blocker one' });
		const blockerTwo = makeCard(todoA, { title: 'Blocker two' });
		// Made first, so of the two with two things to wait on it has the lower id.
		const twoBlockers = makeCard(todoA, { title: 'Two blockers' });
		const both = makeCard(todoA, { title: 'Both' });
		const decisionOnly = makeCard(todoA, { title: 'Decision only' });
		makeDependency({ blocked: twoBlockers, blocker: blockerOne });
		makeDependency({ blocked: twoBlockers, blocker: blockerTwo });
		makeDependency({ blocked: both, blocker: blockerOne });
		makeCardLink(decision, both, { relation: 'waits' });
		makeCardLink(decision, decisionOnly, { relation: 'waits' });
		const goal = goalOf(blockerOne, blockerTwo, twoBlockers, both, decisionOnly);

		const summary = summaryFor(participant, goal);
		const entries = summary.blocked.filter((b) => b.card.id === both.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ blockers: [expect.objectContaining({ id: blockerOne.id })], decisions: [projection(decision)] });
		expect(summary.blocked.map((b) => b.card.id)).toEqual([decisionOnly.id, twoBlockers.id, both.id]);
	});

	it('P9: the PDF names the decision under the waiting card, marked Blocked, only for the viewer who may view it; both carry the words that say so and the closing line; many decisions with no blockers are drawn whole', async () => {
		const held = makeCard(todoA, { title: 'Held card' });
		const free = makeCard(todoA, { title: 'Free card' });
		const goal = goalOf(held, free);
		makeCardLink(decision, held, { relation: 'waits' });

		const flat = (text: string) => text.split('\n').join(' ').replace(/\s+/g, ' ');
		const pdfOf = async (viewer: SessionUser) => {
			const bytes = await generateMilestonePdf(summaryFor(viewer, goal));
			return { text: pdfText(bytes), raw: Buffer.from(bytes).toString('latin1') };
		};
		const forParticipant = await pdfOf(participant);
		const forReader = await pdfOf(reader);

		expect(forParticipant.text).toContain(`waiting on decision "${TITLE}" (Open)`);
		expect(forParticipant.text.split('\n').filter((line) => line === 'Blocked')).toHaveLength(1);
		expect(forReader.text).not.toContain(TITLE);
		expect(forReader.raw).not.toContain(TITLE);
		expect(forReader.text.split('\n').filter((line) => line === 'Blocked')).toHaveLength(0);
		for (const { text } of [forParticipant, forReader]) {
			expect(flat(text)).toContain('Only three things are recorded: which piece of work blocks which, which work belongs to this goal, and which cards are marked as waiting on a decision.');
			expect(flat(text)).toContain('Waiting = something must finish, or a decision be ruled, first.');
			expect(flat(text)).toContain('Amber is waiting, on other work or on a decision; blue can start, green is done.');
			expect(text.split('\n').at(-1)).toBe('Decisions named are those the exporter may view.');
		}

		// Card 2687's code review (C-E-M1): a decision with a title as long as one may be, and a blocker with one as long,
		// each drawn as one line cut with an ellipsis, never wrapped over the line after it. Made first, each has lines
		// after it.
		const longWords = (start: string) => `${`${start} ${'and a long run of words '.repeat(10)}`.slice(0, DECISION_TITLE_MAX - 1)}.`;
		const longDecision = openOn(A, longWords('Long decision'));
		expect(longDecision.title).toHaveLength(DECISION_TITLE_MAX);
		makeCardLink(longDecision, held, { relation: 'waits' });
		const longBlocker = makeCard(todoA, { title: longWords('Long blocker') });
		makeDependency({ blocked: held, blocker: longBlocker });
		// Fifty decisions and no blocker: the space kept for the entry counts them, so it starts on a page they all fit on.
		const many = Array.from({ length: 50 }, (_, i) => {
			const d = openOn(A, `Many ${String(i).padStart(2, '0')}`);
			makeCardLink(d, held, { relation: 'waits' });
			return d;
		});
		const pages: { text: string; page: number; top: unknown; bottom: number }[] = [];
		let page = 0;
		const addPage = PDFDocument.prototype.addPage;
		const text = PDFDocument.prototype.text;
		const pageSpy = vi.spyOn(PDFDocument.prototype, 'addPage').mockImplementation(function (this: PDFKit.PDFDocument, ...args: unknown[]) {
			page++;
			return (addPage as (...a: unknown[]) => PDFKit.PDFDocument).apply(this, args);
		});
		const textSpy = vi.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (this: PDFKit.PDFDocument, ...args: unknown[]) {
			const drawn = (text as (...a: unknown[]) => PDFKit.PDFDocument).apply(this, args);
			// Where the line was set, and where the text it drew ended.
			if (typeof args[0] === 'string') pages.push({ text: args[0], page, top: args[2], bottom: this.y });
			return drawn;
		});
		try {
			await generateMilestonePdf(summaryFor(owner, goal));
		} finally {
			pageSpy.mockRestore();
			textSpy.mockRestore();
		}
		const pageOf = (words: string) => pages.filter((p) => p.text === words).map((p) => p.page);
		const titlePages = pageOf('Held card');
		const decisionPages = many.map((d) => pageOf(`waiting on decision "${d.title}" (Open)`)[0]);
		expect(decisionPages.every((p) => p !== undefined)).toBe(true);
		// The title in the waiting list is the one drawn just before its first decision.
		const listTitle = titlePages.filter((p) => p <= decisionPages[0]).at(-1);
		expect(new Set([listTitle, ...decisionPages])).toEqual(new Set([decisionPages[0]]));

		// The long two are drawn on that page too, and every waiting line ends before the next begins.
		const lines = pages.filter((p) => p.text.startsWith('waiting on '));
		// The blocker, then the decisions the owner may view: the one on B, the fifty and the long one.
		expect(lines).toHaveLength(many.length + 3);
		const longLines = lines.filter((p) => p.text.includes('and a long run of words'));
		expect(longLines.map((p) => p.page)).toEqual([decisionPages[0], decisionPages[0]]);
		expect(longLines[0].text).toBe(`waiting on #${longBlocker.id}  ${longBlocker.title}`);
		expect(longLines[1].text).toBe(`waiting on decision "${longDecision.title}" (Open)`);
		for (const [i, line] of lines.entries()) {
			expect(typeof line.top).toBe('number');
			// One line, inside the 13pt kept for it (set 1.5pt into it), and ended before the next begins.
			expect(line.bottom, line.text).toBeLessThanOrEqual((line.top as number) + 11.5);
			if (i > 0) expect(line.top as number, lines[i - 1].text).toBeGreaterThanOrEqual(lines[i - 1].bottom);
		}
	});

	it('P10: GET /api/v1/milestones/{id}/summary through a key, full and compact, carries waitingOnDecisions and blocked[].decisions', async () => {
		const held = makeCard(todoA, { title: 'Held' });
		const goal = goalOf(held);
		makeCardLink(decision, held, { relation: 'waits' });
		const credential = keyCredential(participant);
		// Under /api/v1/ a stored moment is given in ISO 8601 (v1-json.ts).
		const answered = { ...projection(decision), closesAt: '2099-01-01T12:00:00.000Z' };

		const full = await api('GET', `/api/v1/milestones/${goal.id}/summary`, { user: participant, credential });
		expect(full.status).toBe(200);
		expect(full.body.graph.nodes.find((n: MilestoneNode) => n.id === held.id).waitingOnDecisions).toEqual([answered]);
		expect(full.body.blocked).toEqual([expect.objectContaining({ blockers: [], decisions: [answered] })]);
		expect(full.body.nextActionable).toEqual([]);

		const compact = await api('GET', `/api/v1/milestones/${goal.id}/summary?compact=true`, { user: participant, credential });
		expect(compact.status).toBe(200);
		expect(compact.body).not.toHaveProperty('graph');
		expect(compact.body.blocked).toEqual([
			{ card: expect.objectContaining({ id: held.id, waitingOnDecisions: [answered] }), blockers: [], decisions: [answered] }
		]);

		// The same route for the reader's key: nothing of the decision.
		const forReader = await api('GET', `/api/v1/milestones/${goal.id}/summary?compact=true`, { user: reader, credential: keyCredential(reader) });
		expect(forReader.body.blocked).toEqual([]);
		expect(JSON.stringify(forReader.body)).not.toContain(TITLE);
	});

	it('P14: withDecisionWaits leaves the summary it is handed as it was, as the plan mail hands one to every recipient who opens the same boards', () => {
		const held = makeCard(todoA, { title: 'Held' });
		const step = makeSubtask(held, { title: 'Held step' });
		const other = makeSubtask(held, { title: 'Other step' });
		makeDependency({ blocked: step, blocker: other });
		const next = makeCard(todoA, { title: 'Next' });
		makeDependency({ blocked: next, blocker: held });
		const goal = goalOf(held, next);
		makeCardLink(decision, held, { relation: 'waits' });

		const work = workSummary(goal.id, participant)!;
		const before = structuredClone(work);
		const given = withDecisionWaits(work, participant);
		// It held something, so a summary left as it was is not one it had nothing to do to.
		expect(given.nextActionable).toEqual([]);
		expect(nodeOf(given, 'card', held.id).waitingOnDecisions).toEqual([projection(decision)]);
		expect(work).toEqual(before);
		// And a second recipient handed the same summary is given their own: nothing of the first's waits.
		expect(JSON.stringify(withDecisionWaits(work, reader))).not.toContain(TITLE);
	});
});

/** Every link taken off, between the parts of a parameterised case. */
function resetLinks() {
	db.delete(decisionCardLinks).where(eq(decisionCardLinks.decisionId, decision.id)).run();
}
