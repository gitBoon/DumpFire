// @vitest-environment jsdom
/**
 * The New badge on the board's card and on the list view's row (card 2537),
 * both mounted with Svelte's client runtime, as
 * `tests/xp-leaderboard.svelte.test.ts` is: this file alone takes jsdom, by
 * the comment above.
 *
 * The board's card showed "New" for a card made under 24 hours ago and not in
 * a Complete column; the list view's row never did. Both now ask one function,
 * `showsNewBadge` in `src/lib/utils/date-utils.ts`, and both hand it the
 * page's live-timestamp counter, so the badge goes at the 24-hour mark in both
 * views on the same tick, without a reload. Before, neither read the counter,
 * so the board's badge stayed until something else redrew the card.
 *
 * All Tasks' card asks the same function, with its Complete bucket as
 * "complete" and the All Tasks page's own 15-second counter: it showed the
 * badge on a new card even in Complete, and never cleared it on the clock.
 *
 * The file is named `.svelte.test.ts` so the counter can be a `$state`, as the
 * board page's is. The clock is vitest's fake `Date`, set per test.
 *
 * The plan is `docs/planning/2537-list-view-new-badge.md`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';
import KanbanCardBody from '$lib/components/board/KanbanCardBody.svelte';
import CardListRow from '$lib/components/board/CardListRow.svelte';
import AllTaskCard from '$lib/components/tasks/AllTaskCard.svelte';
import { showsNewBadge } from '$lib/utils/date-utils';
import type { CardType } from '$lib/types';

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

/** Now, for every test: noon UTC on 27 October 2026. */
const NOW = new Date('2026-10-27T12:00:00Z');
/** A stored timestamp (`YYYY-MM-DD HH:MM:SS`, UTC) this many minutes before NOW. */
const minutesAgo = (minutes: number) =>
	new Date(NOW.getTime() - minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement }[] = [];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	for (const { component, target } of drawn) {
		unmount(component);
		target.remove();
	}
	drawn = [];
	vi.useRealTimers();
});

function card(createdAt: string): CardType {
	return {
		id: 7,
		columnId: 1,
		categoryId: null,
		title: 'Card 7',
		description: null,
		position: 0,
		priority: 'medium',
		colorTag: null,
		dueDate: null,
		createdAt,
		updatedAt: createdAt,
		subtasks: [],
		labelIds: [],
		pinned: false,
		onHoldNote: '',
		businessValue: null,
		subBoards: [],
		assignees: [],
		archivedAt: null,
		coverUrl: null,
		milestoneId: null
	};
}

const noop = () => {};

function place(): HTMLElement {
	const target = document.createElement('div');
	document.body.appendChild(target);
	return target;
}

/** The page's live-timestamp counter, one for both views, as the board page has one. */
function counter() {
	const clock = $state({ tick: 0 });
	return clock;
}

/** Mounts the board's card body for `c`, reading `clock.tick`. */
function drawCard(c: CardType, completed: boolean, clock: { tick: number }): HTMLElement {
	const target = place();
	const component = mount(KanbanCardBody, {
		target,
		props: {
			card: c, isComplete: completed, isOnHold: false, categories: [], labels: [],
			blockersFor: () => [], blockerTooltip: () => '', milestoneNameById: new Map(), cardTokens: {},
			get tick() { return clock.tick; },
			selectionMode: false, selected: false, editing: false, editValue: '',
			onStartEdit: noop, onSaveEdit: noop, onEditKeydown: noop, onCyclePriority: noop
		}
	});
	drawn.push({ component, target });
	return target;
}

/** Mounts the list view's row for `c`, reading `clock.tick`. */
function drawRow(c: CardType, completed: boolean, clock: { tick: number }): HTMLElement {
	const target = place();
	const component = mount(CardListRow, {
		target,
		props: {
			card: c, onHold: false, completed, categories: [], blockerCount: 0, blockerTooltip: '',
			milestoneName: null, tokens: undefined,
			get tick() { return clock.tick; },
			selected: false, selectionMode: false, onOpen: noop, onContextMenu: noop
		}
	});
	drawn.push({ component, target });
	return target;
}

/** Both views of one card, on one counter, drawn. */
function both(createdAt: string, completed: boolean) {
	const clock = counter();
	const c = card(createdAt);
	const board = drawCard(c, completed, clock);
	const list = drawRow(c, completed, clock);
	flushSync();
	return {
		clock,
		badges: () => [board.querySelector('.new-badge'), list.querySelector('.row-new-badge')].map((el) => el?.textContent ?? null)
	};
}

describe('showsNewBadge, the one rule', () => {
	it('is true under 24 hours, false at 24 hours and after', () => {
		expect(showsNewBadge(card(minutesAgo(0)), false, 0)).toBe(true);
		expect(showsNewBadge(card(minutesAgo(24 * 60 - 1)), false, 0)).toBe(true);
		expect(showsNewBadge({ createdAt: new Date(NOW.getTime() - 1).toISOString() }, false, 0)).toBe(true);
		expect(showsNewBadge(card(minutesAgo(24 * 60)), false, 0)).toBe(false);
		expect(showsNewBadge(card(minutesAgo(24 * 60 + 1)), false, 0)).toBe(false);
	});

	it('is false for a card in a Complete column, however new', () => {
		expect(showsNewBadge(card(minutesAgo(0)), true, 0)).toBe(false);
		expect(showsNewBadge(card(minutesAgo(24 * 60 + 1)), true, 0)).toBe(false);
	});
});

describe('the badge, on the board and in the list', () => {
	it('shows on both for a new card that is not complete', () => {
		expect(both(minutesAgo(5), false).badges()).toEqual(['New', 'New']);
	});

	it('shows on neither for a card made a day ago or more', () => {
		expect(both(minutesAgo(24 * 60), false).badges()).toEqual([null, null]);
		expect(both(minutesAgo(3 * 24 * 60), false).badges()).toEqual([null, null]);
	});

	it('shows on neither for a new card in a Complete column', () => {
		expect(both(minutesAgo(5), true).badges()).toEqual([null, null]);
	});

	it('says what it means in the list, where it sits in the title’s line', () => {
		const { badges } = both(minutesAgo(5), false);
		expect(badges()).toEqual(['New', 'New']);
		const row = drawn[1].target;
		const badge = row.querySelector('.row-title .row-new-badge');
		expect(badge?.getAttribute('title')).toBe('Created in the last 24 hours');
	});

	it('goes from both at once on the page’s next tick after the 24-hour mark, without a reload', () => {
		const { clock, badges } = both(minutesAgo(24 * 60 - 1), false);
		expect(badges()).toEqual(['New', 'New']);

		// Two minutes on: nothing redraws until the counter moves.
		vi.setSystemTime(new Date(NOW.getTime() + 2 * 60_000));
		clock.tick++;
		flushSync();
		expect(badges()).toEqual([null, null]);
	});
});

describe('the badge on All Tasks', () => {
	/** Mounts All Tasks' card for a card made at `createdAt`, drawn in the bucket titled `bucketTitle`. */
	function drawAllTasks(createdAt: string, bucketTitle: string) {
		const clock = counter();
		const target = place();
		const component = mount(AllTaskCard, {
			target,
			props: {
				data: { categories: [], labels: [], cardTokens: {}, milestoneNames: {} } as never,
				card: { ...card(createdAt), boardId: 1, boardName: 'Board', boardEmoji: '📋' } as never,
				bucket: { title: bucketTitle, cards: [] } as never,
				get tick() { return clock.tick; },
				boardPlaces: new Map(), blockersFor: () => [], openCard: noop, openMoveModal: noop
			}
		});
		drawn.push({ component, target });
		flushSync();
		return { clock, badge: () => target.querySelector('.new-badge')?.textContent ?? null };
	}

	it('shows for a new card that is not complete, and not for one a day old', () => {
		expect(drawAllTasks(minutesAgo(5), 'To Do').badge()).toBe('New');
		expect(drawAllTasks(minutesAgo(24 * 60), 'To Do').badge()).toBe(null);
	});

	it('shows for no card in the Complete bucket, however new', () => {
		expect(drawAllTasks(minutesAgo(5), 'Complete').badge()).toBe(null);
	});

	it('goes on the page’s next tick after the 24-hour mark, without a reload', () => {
		const { clock, badge } = drawAllTasks(minutesAgo(24 * 60 - 1), 'In Progress');
		expect(badge()).toBe('New');
		vi.setSystemTime(new Date(NOW.getTime() + 2 * 60_000));
		clock.tick++;
		flushSync();
		expect(badge()).toBe(null);
	});
});
