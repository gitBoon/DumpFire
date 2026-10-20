/**
 * How the board page is to keep itself current without re-running its whole
 * load (card 2280, slice B1 of card 2012's part B): the plain modules, with
 * fake timers. No page uses them yet; slice B2a moves the board page onto
 * them.
 *
 *   - `src/lib/board/refresh-schedule.ts`: when a re-read of the board is
 *     sent. A burst of live events is one read, 250 ms after the last, and
 *     never more than about a second after the first; one read at a time;
 *     none while a drag or a write is in flight (holds are a count, each with
 *     a watchdog), except for an access event, which is never held; and an
 *     answer to a read sent before the latest local write settled is dropped
 *     (the generation) and the board read again.
 *   - `src/lib/board/board-patches.ts`: a write's change to the columns, and
 *     its undo, as pure functions. A patch merges into the card; an undo puts
 *     back only what its patch changed.
 *   - `src/lib/board/contents-answer.ts`: what an answer of
 *     `GET /api/boards/[id]/contents` decides: apply it, the board is refused
 *     (401, 403, 404), or keep the screen as it is (anything else, or none).
 *   - `src/lib/board/board-state.svelte.ts`: the state the page draws, which
 *     takes each answer, re-applies the viewer's column sorts, and on a
 *     refusal empties itself and asks for the load's refusal page once.
 *
 * The plan is `docs/planning/card-2012-service-layer-and-pages.md`, part B
 * (decision 8, section 4.4, R6, R7, section 6.2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshSchedule, type RefreshSchedule } from '$lib/board/refresh-schedule';
import { insertCard, insertColumn, moveCards, patchCard, patchColumn, removeCard, removeColumn, reorderColumns } from '$lib/board/board-patches';
import { askForContents, contentsVerdict, type BoardContentsData } from '$lib/board/contents-answer';
import { BoardState } from '$lib/board/board-state.svelte';
import type { CardType, ColumnType } from '$lib/types';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

/** A run that counts itself, answers after `takes` ms, and applies by counting too. */
function counted(takes = 10) {
	const seen = { runs: 0, applied: 0, inFlight: 0, mostAtOnce: 0 };
	const run = async () => {
		seen.runs += 1;
		seen.inFlight += 1;
		seen.mostAtOnce = Math.max(seen.mostAtOnce, seen.inFlight);
		await new Promise((done) => setTimeout(done, takes));
		seen.inFlight -= 1;
		return () => {
			seen.applied += 1;
		};
	};
	return { seen, run };
}

let schedules: RefreshSchedule[] = [];
function schedule(run: Parameters<typeof refreshSchedule>[0]) {
	const made = refreshSchedule(run);
	schedules.push(made);
	return made;
}
afterEach(() => {
	for (const s of schedules) s.dispose();
	schedules = [];
});

describe('refresh-schedule: when a re-read is sent', () => {
	it('runs ten calls made within 250 ms once', async () => {
		const { seen, run } = counted();
		const s = schedule(run);

		for (let i = 0; i < 10; i++) {
			s.schedule();
			await vi.advanceTimersByTimeAsync(20);
		}
		expect(seen.runs).toBe(0);
		await vi.advanceTimersByTimeAsync(250);
		expect(seen.runs).toBe(1);
		await vi.advanceTimersByTimeAsync(2000);
		expect(seen.runs).toBe(1);
		expect(seen.applied).toBe(1);
	});

	it('still runs at least once a second under calls every 100 ms for 3 s (the maximum wait)', async () => {
		const { seen, run } = counted();
		const s = schedule(run);

		const ranBy: number[] = [];
		for (let t = 100; t <= 3000; t += 100) {
			s.schedule();
			await vi.advanceTimersByTimeAsync(100);
			ranBy.push(seen.runs);
		}
		// With a trailing timer alone it would not have run at all yet.
		expect(seen.runs).toBeGreaterThanOrEqual(3);
		// The first by about a second after the first call.
		expect(ranBy[10]).toBeGreaterThanOrEqual(1);
	});

	it('runs a call made while a run is in flight once more after it, never beside it', async () => {
		const { seen, run } = counted(500);
		const s = schedule(run);

		s.schedule();
		await vi.advanceTimersByTimeAsync(260);
		expect(seen.runs).toBe(1);
		expect(s.inFlight).toBe(true);
		s.schedule();
		s.schedule();
		await vi.advanceTimersByTimeAsync(300);
		// Still the first: the second waits for it.
		expect(seen.runs).toBe(1);
		await vi.advanceTimersByTimeAsync(2000);
		expect(seen.runs).toBe(2);
		expect(seen.mostAtOnce).toBe(1);
	});

	it('counts its holds: two holds and one release stay held; the second release runs once', async () => {
		const { seen, run } = counted();
		const s = schedule(run);

		const first = s.hold();
		const second = s.hold();
		s.schedule();
		s.schedule();
		await vi.advanceTimersByTimeAsync(2000);
		expect(seen.runs).toBe(0);

		first();
		first(); // a release is spent once
		await vi.advanceTimersByTimeAsync(2000);
		expect(seen.runs).toBe(0);
		expect(s.holds).toBe(1);

		second();
		await vi.advanceTimersByTimeAsync(20);
		expect(seen.runs).toBe(1);
		await vi.advanceTimersByTimeAsync(2000);
		expect(seen.runs).toBe(1);
	});

	it('lets go of a hold left open after about 30 s (the watchdog)', async () => {
		const { seen, run } = counted();
		const s = schedule(run);

		s.hold(); // never released
		s.schedule();
		await vi.advanceTimersByTimeAsync(29_000);
		expect(seen.runs).toBe(0);
		await vi.advanceTimersByTimeAsync(1_100);
		expect(s.holds).toBe(0);
		expect(seen.runs).toBe(1);
	});

	it('never holds an access event', async () => {
		const { seen, run } = counted();
		const s = schedule(run);

		const release = s.hold();
		s.access();
		await vi.advanceTimersByTimeAsync(20);
		expect(seen.runs).toBe(1);
		expect(seen.applied).toBe(1);
		release();
	});

	it('drops an answer to a read sent before the latest local write settled, and applies the next read', async () => {
		const { seen, run } = counted(100);
		const s = schedule(run);

		s.schedule();
		await vi.advanceTimersByTimeAsync(260); // the read is out
		expect(seen.runs).toBe(1);
		// A write of this page's settles while it is out.
		s.settled();
		await vi.advanceTimersByTimeAsync(100);
		expect(seen.applied).toBe(0);
		// The board is read again, and that answer is taken.
		await vi.advanceTimersByTimeAsync(1000);
		expect(seen.runs).toBe(2);
		expect(seen.applied).toBe(1);
	});

	it('drops the answer to a read already out when a hold is taken, and reads again once it is let go (B1 review)', async () => {
		const { seen, run } = counted(100);
		const s = schedule(run);

		s.schedule();
		await vi.advanceTimersByTimeAsync(260); // the read is out
		expect(seen.runs).toBe(1);
		// A drag or a write begins while it is out: its answer would land under it.
		const release = s.hold();
		await vi.advanceTimersByTimeAsync(2000);
		expect(seen.applied).toBe(0);
		expect(seen.runs).toBe(1);

		release();
		await vi.advanceTimersByTimeAsync(200);
		expect(seen.runs).toBe(2);
		expect(seen.applied).toBe(1);
	});

	it('applies an access read on its first answer however many holds come and go while it is out, and reads once more after the last release (B1 re-check)', async () => {
		const starts: number[] = [];
		const applied: number[] = [];
		const s = schedule(async () => {
			const n = starts.push(Date.now());
			await new Promise((done) => setTimeout(done, 100));
			return () => {
				applied.push(n);
			};
		});

		const t0 = Date.now();
		s.access();
		// Drags and writes, one after another, every 80 ms, through the read and long after it.
		let lastRelease = 0;
		for (let i = 0; i < 10; i++) {
			const release = s.hold();
			await vi.advanceTimersByTimeAsync(40);
			release();
			lastRelease = Date.now();
			await vi.advanceTimersByTimeAsync(40);
			// The access read's own answer is drawn as it arrives.
			if (Date.now() - t0 >= 110) expect(applied[0]).toBe(1);
		}
		await vi.advanceTimersByTimeAsync(2000);

		expect(applied[0]).toBe(1);
		// And an ordinary read after the last release brings the board up to date.
		expect(starts[starts.length - 1]).toBeGreaterThanOrEqual(lastRelease);
		expect(applied[applied.length - 1]).toBe(starts.length);
		expect(s.inFlight).toBe(false);
	});

	it('starts no watchdog for a hold taken after it was stopped (B1 review)', () => {
		const s = schedule(async () => {});
		s.dispose();
		const release = s.hold();
		expect(vi.getTimerCount()).toBe(0);
		expect(s.holds).toBe(0);
		release();
		expect(s.holds).toBe(0);
	});

	it('refreshNow: no 250 ms wait, and it settles once the answer is applied', async () => {
		const { seen, run } = counted(50);
		const s = schedule(run);

		let done = false;
		void s.now().then(() => (done = true));
		await vi.advanceTimersByTimeAsync(1);
		expect(seen.runs).toBe(1);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(60);
		expect(seen.applied).toBe(1);
		expect(done).toBe(true);
	});
});

// ─── Patches ─────────────────────────────────────────────────────────────────

function card(id: number, columnId: number, position: number, extra: Partial<CardType> = {}): CardType {
	return {
		id,
		columnId,
		categoryId: null,
		title: `Card ${id}`,
		description: '',
		position,
		priority: 'medium',
		colorTag: '',
		dueDate: null,
		createdAt: `2026-10-0${id} 09:00:00`,
		updatedAt: '2026-10-01 09:00:00',
		subtasks: [],
		labelIds: [],
		pinned: false,
		onHoldNote: '',
		businessValue: '',
		subBoards: [],
		assignees: [],
		archivedAt: null,
		coverUrl: null,
		milestoneId: null,
		...extra
	};
}

function column(id: number, position: number, cards: CardType[], extra: Partial<ColumnType> = {}): ColumnType {
	return { id, boardId: 1, title: `Column ${id}`, position, color: '#888888', showAddCard: false, wipLimit: 0, cards, ...extra };
}

/** Two columns: 10 holds cards 1 (low), 2 (critical) and 3 (high); 20 holds card 4. */
function board(): ColumnType[] {
	return [
		column(10, 0, [card(1, 10, 1, { priority: 'low' }), card(2, 10, 2, { priority: 'critical' }), card(3, 10, 3, { priority: 'high' })]),
		column(20, 1, [card(4, 20, 1)])
	];
}

const ids = (columns: ColumnType[]) => columns.map((c) => [c.id, c.cards.map((k) => k.id)]);

describe('board-patches: a write on the screen, and its undo', () => {
	it("patchCard merges the answer's fields into the card, keeps what the answer lacks, and its undo restores the card", () => {
		const before = board();
		const original = structuredClone(before);
		const { columns, undo } = patchCard(before, 2, { title: 'Renamed', priority: 'low' });

		expect(columns[0].cards[1]).toEqual({ ...original[0].cards[1], title: 'Renamed', priority: 'low' });
		// The input is not changed, and every other card is the same object.
		expect(before).toEqual(original);
		expect(columns[0].cards[0]).toBe(before[0].cards[0]);
		expect(columns[1]).toBe(before[1]);

		expect(undo(columns)).toEqual(original);

		// The undo puts back only what its patch changed: a field a refresh changed since is kept.
		const refreshed = patchCard(columns, 2, { description: 'From the server' }).columns;
		expect(undo(refreshed)[0].cards[1]).toEqual({ ...original[0].cards[1], description: 'From the server' });
	});

	it("moveCards sets each card's columnId and position; its undo restores both, and the order", () => {
		const before = board();
		const original = structuredClone(before);
		const { columns, undo } = moveCards(before, [
			{ id: 2, columnId: 20, position: 0.5 },
			{ id: 3, columnId: 20, position: 2 }
		]);

		expect(ids(columns)).toEqual([
			[10, [1]],
			[20, [2, 4, 3]]
		]);
		expect(columns[1].cards[0]).toMatchObject({ id: 2, columnId: 20, position: 0.5 });
		expect(columns[1].cards[2]).toMatchObject({ id: 3, columnId: 20, position: 2 });
		expect(before).toEqual(original);

		expect(undo(columns)).toEqual(original);
	});

	it('moveCards: an undo leaves out a card a refresh took off the board, and a move into a column not on the board leaves the card where it was (B1 review)', () => {
		const before = board();
		const moved = moveCards(before, [
			{ id: 2, columnId: 20, position: 0.5 },
			{ id: 3, columnId: 20, position: 2 }
		]);
		// A refresh meanwhile: card 3 was archived by someone else.
		const refreshed = removeCard(moved.columns, 3).columns;
		expect(ids(moved.undo(refreshed))).toEqual([
			[10, [1, 2]],
			[20, [4]]
		]);

		const original = structuredClone(before);
		const nowhere = moveCards(before, [
			{ id: 2, columnId: 99, position: 1 },
			{ id: 3, columnId: 20, position: 2 }
		]);
		expect(ids(nowhere.columns)).toEqual([
			[10, [1, 2]],
			[20, [4, 3]]
		]);
		expect(nowhere.columns[0].cards[1]).toBe(before[0].cards[1]);
		expect(nowhere.undo(nowhere.columns)).toEqual(original);
	});

	it('insertCard and removeCard each undo to the original', () => {
		const before = board();
		const original = structuredClone(before);

		const inserted = insertCard(before, card(9, 10, 2.5));
		expect(ids(inserted.columns)).toEqual([
			[10, [1, 2, 9, 3]],
			[20, [4]]
		]);
		expect(inserted.undo(inserted.columns)).toEqual(original);

		const removed = removeCard(before, 2);
		expect(ids(removed.columns)).toEqual([
			[10, [1, 3]],
			[20, [4]]
		]);
		expect(removed.undo(removed.columns)).toEqual(original);
		expect(before).toEqual(original);
	});

	it('the column patches each undo to the original', () => {
		const before = board();
		const original = structuredClone(before);

		const patched = patchColumn(before, 20, { title: 'Doing', wipLimit: 3 });
		expect(patched.columns[1]).toMatchObject({ id: 20, title: 'Doing', wipLimit: 3 });
		expect(patched.columns[1].cards).toBe(before[1].cards);
		expect(patched.undo(patched.columns)).toEqual(original);

		const added = insertColumn(before, column(30, 0.5, []));
		expect(added.columns.map((c) => c.id)).toEqual([10, 30, 20]);
		expect(added.undo(added.columns)).toEqual(original);

		const gone = removeColumn(before, 10);
		expect(gone.columns.map((c) => c.id)).toEqual([20]);
		expect(gone.undo(gone.columns)).toEqual(original);

		const reordered = reorderColumns(before, [20, 10]);
		expect(reordered.columns.map((c) => [c.id, c.position])).toEqual([
			[20, 0],
			[10, 1]
		]);
		expect(reordered.undo(reordered.columns)).toEqual(original);
		expect(before).toEqual(original);
	});
});

// ─── The contents answer and the board state ─────────────────────────────────

function contents(columns: ColumnType[] = board(), extra: Partial<BoardContentsData> = {}): BoardContentsData {
	return {
		board: { id: 1, name: 'Board', emoji: '📋', parentCardId: null },
		breadcrumbs: [],
		columns,
		categories: [],
		labels: [],
		linkableBoards: [],
		canEdit: true,
		canManage: true,
		userBoardRole: 'owner',
		boardUsers: [{ id: 1, username: 'owner', emoji: '👤' }],
		blockedState: {},
		cardTokens: {},
		boardTokenSummary: null,
		milestones: [],
		...extra
	};
}

const answer = (status: number, body: unknown = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A board state whose reads are answered by `answers`, in turn, the last one again. */
function stateWith(answers: (() => Promise<Response>)[]) {
	const asked: string[] = [];
	let n = 0;
	const fetch = vi.fn(async (input: RequestInfo | URL) => {
		asked.push(String(input));
		const next = answers[Math.min(n, answers.length - 1)];
		n += 1;
		return next();
	});
	const invalidate = vi.fn(async () => {});
	const state = new BoardState(contents(), { fetch, invalidate });
	return { state, fetch, invalidate, asked };
}

let states: BoardState[] = [];
afterEach(() => {
	for (const s of states) s.dispose();
	states = [];
});

describe('the contents answer, and the board state that takes it', () => {
	it('re-applies the column sorts the viewer chose after a refresh', async () => {
		const { state, asked } = stateWith([async () => answer(200, contents(board(), { board: { id: 1, name: 'Renamed', emoji: '🔥', parentCardId: null } }))]);
		states.push(state);

		state.setSort(10, 'priority');
		expect(ids(state.columns)[0]).toEqual([10, [2, 3, 1]]);

		state.refresh();
		await vi.advanceTimersByTimeAsync(300);
		expect(asked).toEqual(['/api/boards/1/contents']);
		// The answer came in the board's order; the viewer's sort is put back on it.
		expect(ids(state.columns)[0]).toEqual([10, [2, 3, 1]]);
		expect(ids(state.columns)[1]).toEqual([20, [4]]);
		// And a rename by someone else follows.
		expect(state.board.name).toBe('Renamed');
	});

	it('decides "refused" on 401, 403 and 404: the state is emptied and the refusal page asked for once', async () => {
		expect([200, 401, 403, 404, 500, 502, 400].map((s) => contentsVerdict(s))).toEqual(['apply', 'refused', 'refused', 'refused', 'keep', 'keep', 'keep']);
		expect(contentsVerdict(null)).toBe('keep');

		for (const status of [401, 403, 404]) {
			const { state, invalidate, fetch } = stateWith([async () => answer(status, { message: 'No' })]);
			states.push(state);

			state.refresh();
			await vi.advanceTimersByTimeAsync(300);
			expect(state.refused, String(status)).toBe(true);
			expect(state.columns, String(status)).toEqual([]);
			expect(state.boardUsers, String(status)).toEqual([]);
			expect(state.canEdit, String(status)).toBe(false);
			expect(invalidate, String(status)).toHaveBeenCalledTimes(1);

			// Nothing more is read or asked, whatever comes after.
			state.refresh();
			state.accessChanged();
			await vi.advanceTimersByTimeAsync(2000);
			expect(fetch, String(status)).toHaveBeenCalledTimes(1);
			expect(invalidate, String(status)).toHaveBeenCalledTimes(1);
		}
	});

	it('decides "keep" on a 5xx or no answer: the screen kept, nothing left in flight', async () => {
		for (const failing of [async () => answer(503, { message: 'Down' }), async () => Promise.reject(new TypeError('Failed to fetch')), async () => new Response('<html>proxy</html>', { status: 200 })]) {
			const { state, invalidate, fetch } = stateWith([failing, async () => answer(200, contents([column(10, 0, [])]))]);
			states.push(state);
			const shown = ids(state.columns);

			state.refresh();
			await vi.advanceTimersByTimeAsync(300);
			expect(ids(state.columns)).toEqual(shown);
			expect(state.refused).toBe(false);
			expect(invalidate).not.toHaveBeenCalled();
			expect(state.inFlight).toBe(false);

			// The next refresh is sent and taken.
			state.refresh();
			await vi.advanceTimersByTimeAsync(300);
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(ids(state.columns)).toEqual([[10, []]]);
		}

		// askForContents on its own: what it decides, and the contents when they are to be applied.
		const ok = await askForContents(7, async () => answer(200, contents()));
		expect(ok.verdict).toBe('apply');
		expect(await askForContents(7, async () => answer(403))).toEqual({ verdict: 'refused', status: 403 });
		expect(await askForContents(7, async () => answer(500))).toEqual({ verdict: 'keep' });
	});

	it('a write begun while a read is out is not undone by its answer: the card does not jump back (B1 review)', async () => {
		const later = (ms: number, body: unknown) => () => new Promise<Response>((done) => setTimeout(() => done(answer(200, body)), ms));
		// The read out answers the board as it was; the read after the write, as the write left it.
		const { state, fetch } = stateWith([later(100, contents()), later(10, contents(board().map((c) => (c.id === 10 ? { ...c, cards: c.cards.map((k) => (k.id === 2 ? { ...k, title: 'Mine' } : k)) } : c))))]);
		states.push(state);

		state.refresh();
		await vi.advanceTimersByTimeAsync(260); // the read is out
		const writing = state.write(
			(columns) => patchCard(columns, 2, { title: 'Mine' }),
			() => new Promise<Response>((done) => setTimeout(() => done(answer(200, {})), 200)),
			{ refused: 'The card was not renamed.', noAnswer: 'No answer from the server.' }
		);

		// The old answer arrives while the write is out: it is not drawn.
		await vi.advanceTimersByTimeAsync(150);
		expect(state.columns[0].cards[1].title).toBe('Mine');

		await vi.advanceTimersByTimeAsync(60); // the write is answered
		expect((await writing).ok).toBe(true);
		await vi.advanceTimersByTimeAsync(500);
		// And the board was read again after it, so nothing waits on an event to put it right.
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(state.columns[0].cards[1].title).toBe('Mine');
	});

	it('comes back from a refusal when it is given the board again (B1 review)', async () => {
		const { state, fetch, invalidate } = stateWith([async () => answer(403, { message: 'No' }), async () => answer(200, contents())]);
		states.push(state);

		state.refresh();
		await vi.advanceTimersByTimeAsync(300);
		expect(state.refused).toBe(true);
		expect(invalidate).toHaveBeenCalledTimes(1);

		// The load asked for by the refusal succeeded after all (access given back meanwhile).
		state.take(contents());
		expect(state.refused).toBe(false);
		expect(ids(state.columns)[0]).toEqual([10, [1, 2, 3]]);

		state.refresh();
		await vi.advanceTimersByTimeAsync(300);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(state.refused).toBe(false);
	});

	it('a refused write undoes only its own card, says the server’s words, and is followed by one refresh', async () => {
		const { state, fetch } = stateWith([async () => answer(200, contents())]);
		states.push(state);

		// Someone else's change to card 1 is on the screen; this page renames card 2.
		state.columns = patchCard(state.columns, 1, { title: 'Theirs' }).columns;
		const writing = state.write(
			(columns) => patchCard(columns, 2, { title: 'Mine' }),
			async () => answer(403, { message: 'You may not rename this card' }),
			{ refused: 'The card was not renamed.', noAnswer: 'No answer from the server.' }
		);
		expect(state.columns[0].cards[1].title).toBe('Mine');
		const result = await writing;

		expect(result).toEqual({ ok: false, failure: 'You may not rename this card' });
		expect(state.columns[0].cards[1].title).toBe('Card 2');
		expect(state.columns[0].cards[0].title).toBe('Theirs');
		expect(state.holds).toBe(0);

		await vi.advanceTimersByTimeAsync(2000);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
