/**
 * A card's cover, its recurrence, and the label routes the card window's
 * label picker calls (card 2010).
 *
 * A cover is drawn as a `background` across the top of the card, for every
 * viewer of the board. Both card updates stored whatever they were sent, up
 * to 2,048 characters: `red; background-image: url(https://...)` and
 * `url(...)` were saved with 200, and drawn would have made each viewer's
 * browser fetch an address of the writer's choosing. A cover is now a colour
 * written `#rrggbb`, one of the eight gradients the card window offers, or
 * nothing (`isCoverValue` in `src/lib/colours.ts`, read by `readCover`).
 *
 * Recurrence was half built: the session route stored a rule that nothing
 * read and no page set. A request that names one now changes nothing; the
 * columns stay, so every card answer keeps its two keys.
 *
 * The label picker makes, renames, recolours and deletes labels from the card
 * window. A page cannot call the API's rename, which needs a key, so the
 * session tree has `PATCH /api/labels`, holding a label's fields to the rule
 * `POST /api/labels` holds them to: a name of 1 to 200 characters once
 * trimmed, and a colour written `#rrggbb`.
 *
 * Who may call each route is in `tests/access-every-route.test.ts`, and that
 * the new route reads its guard's rows inside the transaction that writes, in
 * `tests/check-at-the-write.test.ts`.
 *
 * The board now draws a card's cover as a strip across its top, and every
 * page draws one only once `isCoverValue` has said it is a cover, so a value
 * stored before the rule is kept and not drawn. A page cannot be run here, so
 * that is held by reading the source, as `tests/page-failures.test.ts` does.
 * That the label picker reads each answer is held there; that it can always
 * leave its edit mode, and takes whether a label is on the card from the
 * server's answer, is held here the same way.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { cards, labels, type Card, type Label } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { COVER_PRESETS, isCoverValue, isHexColour } from '$lib/colours';
import { readCover } from '$lib/server/request-body';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { makeBoard, makeCard, makeLabel, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

let owner: SessionUser;
let board: BoardFixture;
let card: Card;

beforeEach(() => {
	resetDb();
	owner = makeUser();
	board = makeBoard({ owner });
	card = makeCard(board.cols['To Do'], { title: 'Original' });
});

/** The card's row as it is stored now. */
const cardRow = (id: number) => db.select().from(cards).where(eq(cards.id, id)).get()!;
/** The label's row as it is stored now, or undefined. */
const labelRow = (id: number) => db.select().from(labels).where(eq(labels.id, id)).get();

/** The eight gradients of the presets: everything in the list that is not a hex colour. */
const GRADIENTS = COVER_PRESETS.filter((preset) => !isHexColour(preset));

const COVER = 'coverUrl must be a colour written #rrggbb, one of the preset gradients, or null';

// ─── What a cover may be ─────────────────────────────────────────────────────

describe('isCoverValue and isHexColour', () => {
	it('offers sixteen presets: eight gradients, then eight colours', () => {
		expect(COVER_PRESETS).toHaveLength(16);
		expect(GRADIENTS).toHaveLength(8);
		expect(COVER_PRESETS.slice(8).every(isHexColour)).toBe(true);
		for (const gradient of GRADIENTS) expect(gradient).toMatch(/^linear-gradient\(/);
	});

	it('takes each of the sixteen presets and any colour written #rrggbb', () => {
		for (const preset of COVER_PRESETS) expect(isCoverValue(preset), preset).toBe(true);
		expect(isCoverValue('#a1B2c3')).toBe(true);
		expect(isHexColour('#a1B2c3')).toBe(true);
	});

	it('takes nothing else: no address, no gradient of the writer’s own, no other type, and not null, which is no cover', () => {
		const NOT = [
			'#fff',
			'red',
			'url(x)',
			'url(https://evil.example.test/t.png)',
			'red; background-image: url(https://evil.example.test/t.png)',
			'linear-gradient(135deg, #000000 0%, #ffffff 100%)',
			`${GRADIENTS[0]}, url(https://evil.example.test/t.png)`,
			` ${GRADIENTS[0]}`,
			'',
			['#ffffff'],
			5,
			{},
			null,
			undefined
		];
		for (const value of NOT) expect(isCoverValue(value), JSON.stringify(value)).toBe(false);
		for (const value of ['#fff', 'red', 'url(x)', ['#ffffff'], 5, {}, null]) expect(isHexColour(value), JSON.stringify(value)).toBe(false);
	});
});

describe('readCover', () => {
	const read = (sent: unknown, rule: { nullable?: boolean } = { nullable: true }) => {
		try {
			return { value: readCover({ coverUrl: sent }, 'coverUrl', rule) };
		} catch (thrown) {
			if (isHttpError(thrown, 400)) return { refused: thrown.body.message };
			throw thrown;
		}
	};

	it('hands back a cover as it was sent, and empty text and null as null where null is allowed', () => {
		expect(read('#a1B2c3')).toEqual({ value: '#a1B2c3' });
		expect(read(GRADIENTS[3])).toEqual({ value: GRADIENTS[3] });
		expect(read('')).toEqual({ value: null });
		expect(read(null)).toEqual({ value: null });
	});

	it('refuses anything else in one text naming the field, and empty text where null is not allowed', () => {
		for (const sent of ['red', 'url(x)', ' #a1b2c3', ['#ffffff'], 5, {}, true]) {
			expect(read(sent), JSON.stringify(sent)).toEqual({ refused: COVER });
		}
		const WITHOUT_NULL = 'coverUrl must be a colour written #rrggbb or one of the preset gradients';
		expect(read('', {})).toEqual({ refused: WITHOUT_NULL });
		expect(read(null, {})).toEqual({ refused: WITHOUT_NULL });
	});
});

// ─── A cover, through both card updates ──────────────────────────────────────

const UPDATES: [string, (id: number) => string][] = [
	['PUT /api/cards/[id]', (id) => `/api/cards/${id}`],
	['PUT /api/v1/cards/[cardId]', (id) => `/api/v1/cards/${id}`]
];

describe.each(UPDATES)('%s', (_route, pathOf) => {
	const put = (body: unknown) => api('PUT', pathOf(card.id), { user: owner, body });

	it('stores null, a colour written #rrggbb and every preset as sent, and empty text as null', async () => {
		for (const cover of ['#a1b2c3', ...COVER_PRESETS]) {
			const res = await put({ coverUrl: cover });
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.body.coverUrl).toBe(cover);
			expect(cardRow(card.id).coverUrl).toBe(cover);
		}

		const cleared = await put({ coverUrl: '' });
		expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
		expect(cardRow(card.id).coverUrl).toBeNull();

		await put({ coverUrl: '#a1b2c3' });
		const none = await put({ coverUrl: null });
		expect(none.status, JSON.stringify(none.body)).toBe(200);
		expect(cardRow(card.id).coverUrl).toBeNull();
	});

	it('refuses any other cover with 400 naming coverUrl, and writes nothing of the request', async () => {
		const sent = effects();
		try {
			for (const cover of [
				'red; background-image: url(https://evil.example.test/t.png)',
				'url(https://evil.example.test/t.png)',
				'linear-gradient(135deg, #000000 0%, #ffffff 100%)',
				['#ffffff'],
				5
			]) {
				const before = snapshotDb();
				const res = await put({ title: 'Renamed', coverUrl: cover });

				expect(res.status, JSON.stringify(cover)).toBe(400);
				expect(res.body).toEqual({ message: COVER });
				expectUnchanged(before, JSON.stringify(cover));
			}
			await sent.settle();
			expect(sent.all).toEqual([]);
		} finally {
			sent.restore();
		}
		expect(cardRow(card.id).title).toBe('Original');
	});

	it('keeps a cover stored before the rule when it is sent back unchanged, and refuses it as a new value', async () => {
		const OLD = 'url(https://example.test/old.png)';
		db.update(cards).set({ coverUrl: OLD }).where(eq(cards.id, card.id)).run();

		const kept = await put({ title: 'Renamed', coverUrl: OLD });
		expect(kept.status, JSON.stringify(kept.body)).toBe(200);
		expect(cardRow(card.id)).toMatchObject({ title: 'Renamed', coverUrl: OLD });

		const other = makeCard(board.cols['To Do']);
		const refused = await api('PUT', pathOf(other.id), { user: owner, body: { coverUrl: OLD } });
		expect(refused.status).toBe(400);
		expect(cardRow(other.id).coverUrl).toBeNull();
	});
});

// ─── Recurrence ──────────────────────────────────────────────────────────────

describe('recurrence, which nothing acts on', () => {
	it('is not written by PUT /api/cards/[id], alone or beside another field', async () => {
		const alone = await api('PUT', `/api/cards/${card.id}`, { user: owner, body: { recurrenceRule: 'FREQ=DAILY' } });
		expect(alone.status, JSON.stringify(alone.body)).toBe(200);
		expect(cardRow(card.id).recurrenceRule).toBeNull();

		const beside = await api('PUT', `/api/cards/${card.id}`, { user: owner, body: { title: 'Renamed', recurrenceRule: 'FREQ=DAILY' } });
		expect(beside.status, JSON.stringify(beside.body)).toBe(200);
		expect(cardRow(card.id)).toMatchObject({ title: 'Renamed', recurrenceRule: null, nextRecurrence: null });
	});

	it('is not taken by PUT /api/v1/cards/[cardId] either, which answers a body of it alone as having nothing to update', async () => {
		const res = await api('PUT', `/api/v1/cards/${card.id}`, { user: owner, body: { recurrenceRule: 'FREQ=DAILY' } });
		expect(res.status).toBe(400);
		expect(res.body).toEqual({ message: 'No valid fields to update' });
		expect(cardRow(card.id).recurrenceRule).toBeNull();
	});

	it('is still in every card answer, as null: the shape of a card is unchanged', async () => {
		await api('PUT', `/api/cards/${card.id}`, { user: owner, body: { recurrenceRule: 'FREQ=DAILY' } });

		const res = await api('GET', `/api/v1/cards/${card.id}`, { user: owner });
		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('recurrenceRule', null);
		expect(res.body).toHaveProperty('nextRecurrence', null);
	});
});

// ─── Labels ──────────────────────────────────────────────────────────────────

/** The refusals of a label's fields that are the same, word for word, on both routes that write them. */
const LABEL_REFUSALS: [Record<string, unknown>, string][] = [
	[{ name: ['x'] }, 'name must be text'],
	[{ name: 5 }, 'name must be text'],
	[{ name: 'x'.repeat(201) }, 'name must be at most 200 characters'],
	[{ color: 'red; background: url(https://evil.example.test/)' }, 'color must be a colour written #rrggbb'],
	[{ color: '#fff' }, 'color must be a colour written #rrggbb'],
	[{ color: 5 }, 'color must be a colour written #rrggbb'],
	[{ color: null }, 'color must be a colour written #rrggbb']
];

describe('POST /api/labels', () => {
	const post = (body: Record<string, unknown>) => api('POST', '/api/labels', { user: owner, body: { boardId: board.board.id, ...body } });

	it('refuses a label with no name, with a blank name, or with a field it cannot use: 400 naming the field, and no row', async () => {
		const cases: [Record<string, unknown>, string][] = [
			[{}, 'name is required'],
			[{ name: '' }, 'name is required'],
			[{ name: '   ' }, 'name is required'],
			...LABEL_REFUSALS.map(([body, message]): [Record<string, unknown>, string] => [{ name: 'Bug', ...body }, message])
		];
		for (const [body, message] of cases) {
			const before = snapshotDb();
			const res = await post(body);

			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(res.body, JSON.stringify(body)).toEqual({ message });
			expectUnchanged(before, JSON.stringify(body));
		}
		expect(db.select().from(labels).all()).toEqual([]);
	});

	it('stores the name trimmed, and #6366f1 when no colour is sent', async () => {
		const res = await post({ name: '  Bug  ' });

		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body).toMatchObject({ boardId: board.board.id, name: 'Bug', color: '#6366f1' });
		expect(labelRow(res.body.id)).toMatchObject({ name: 'Bug', color: '#6366f1' });

		const red = await post({ name: 'Urgent', color: '#EF4444' });
		expect(red.status).toBe(201);
		expect(labelRow(red.body.id)).toMatchObject({ name: 'Urgent', color: '#EF4444' });
	});
});

describe('PATCH /api/labels', () => {
	let label: Label;
	let sent: Effects;

	beforeEach(() => {
		label = makeLabel(board.board, 'Bug');
		sent = effects();
	});
	afterEach(() => sent.restore());

	const patch = (body: Record<string, unknown>) => api('PATCH', '/api/labels', { user: owner, body: { id: label.id, ...body } });

	it('renames and recolours a label, answers the row, and tells the board once, after the commit', async () => {
		const res = await patch({ name: '  Defect  ', color: '#3b82f6' });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toEqual({ ...label, name: 'Defect', color: '#3b82f6' });
		expect(labelRow(label.id)).toEqual(res.body);

		await sent.settle();
		expect(sent.events.map(({ boardId, event, data }) => ({ boardId, event, data }))).toEqual([
			{ boardId: board.board.id, event: 'update', data: { type: 'label' } }
		]);
		expect(sent.duringTransaction).toEqual([]);
		expect(sent.all).toHaveLength(1);
	});

	it('changes only what it is sent', async () => {
		expect((await patch({ name: 'Defect' })).status).toBe(200);
		expect(labelRow(label.id)).toMatchObject({ name: 'Defect', color: label.color });

		expect((await patch({ color: '#10b981' })).status).toBe(200);
		expect(labelRow(label.id)).toMatchObject({ name: 'Defect', color: '#10b981' });
	});

	it('refuses what it cannot use as creating a label does, with 400 naming the field, and changes nothing', async () => {
		const cases: [Record<string, unknown>, string][] = [
			...LABEL_REFUSALS,
			[{ name: '' }, 'name cannot be empty'],
			[{ name: '   ' }, 'name cannot be empty'],
			[{ name: null }, 'name must be text'],
			// Neither field: nothing to change.
			[{}, 'Send name or color to change'],
			[{ boardId: board.board.id }, 'Send name or color to change'],
			// The label's id is an id.
			[{ id: 'x', name: 'Defect' }, 'Invalid label ID'],
			[{ id: 1.5, name: 'Defect' }, 'Invalid label ID']
		];
		for (const [body, message] of cases) {
			const before = snapshotDb();
			const res = await patch(body);

			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(res.body, JSON.stringify(body)).toEqual({ message });
			expectUnchanged(before, JSON.stringify(body));
		}
		await sent.settle();
		expect(sent.all).toEqual([]);
	});

	it('answers 404 for an id that is no label, and 400 for no id', async () => {
		const missing = await api('PATCH', '/api/labels', { user: owner, body: { id: 99999, name: 'Defect' } });
		expect(missing.status).toBe(404);
		expect(missing.body).toEqual({ message: 'Label not found' });

		const none = await api('PATCH', '/api/labels', { user: owner, body: { name: 'Defect' } });
		expect(none.status).toBe(400);
		expect(none.body).toEqual({ message: 'Invalid label ID' });
		expect(labelRow(label.id)?.name).toBe('Bug');
	});

	it('keeps a colour stored before the rule when it is sent back with a rename, and refuses it as a new colour', async () => {
		db.update(labels).set({ color: 'red' }).where(eq(labels.id, label.id)).run();

		// The picker sends the label's name and colour back together when it saves.
		const kept = await patch({ name: 'Defect', color: 'red' });
		expect(kept.status, JSON.stringify(kept.body)).toBe(200);
		expect(labelRow(label.id)).toMatchObject({ name: 'Defect', color: 'red' });

		const other = makeLabel(board.board, 'Other');
		const refused = await api('PATCH', '/api/labels', { user: owner, body: { id: other.id, color: 'red' } });
		expect(refused.status).toBe(400);
		expect(labelRow(other.id)?.color).toBe('#6366f1');
	});
});

// ─── Where a cover and the label picker are drawn, read from the source ──────

const ROOT = process.cwd();
const BOARD_PAGE = 'src/routes/board/[id]/+page.svelte';
/** What each card on the board shows: moved from the board page by card 2280's slice B3. */
const BOARD_CARD = 'src/lib/components/board/KanbanCardBody.svelte';
const CARD_WINDOW = 'src/lib/components/CardModal.svelte';

/** Every Svelte file under `src`, as a path from the repository. */
const svelteFiles = () =>
	(readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
		.map((file) => `src/${file.split('\\').join('/')}`)
		.filter((file) => file.endsWith('.svelte'));

/**
 * A Svelte file's markup: its source with every `<script>` and `<style>`
 * blanked out, character for character, so that a place in it is the same
 * place in the file.
 */
const markupOf = (file: string) =>
	readFileSync(join(ROOT, file), 'utf8').replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, (block) => block.replace(/[^\r\n]/g, ' '));

/**
 * The `{#if}` blocks a place in the markup is inside, outermost first: each
 * with its condition, and whether the place is in its `{:else}`. As
 * `tests/page-failures.test.ts` reads them, and with the other blocks
 * counted too, so that the `{:else}` of an `{#each}` is not taken for an
 * `{#if}`'s.
 */
function blocksAround(markup: string, index: number): { condition: string; inElse: boolean }[] {
	const stack: { kind: string; condition: string; inElse: boolean }[] = [];
	const tags = /\{#(if|each|await|key|snippet)\b([^}]*)\}|\{:(?:else|then|catch)\b[^}]*\}|\{\/(?:if|each|await|key|snippet)\}/g;
	for (const tag of markup.slice(0, index).matchAll(tags)) {
		if (tag[1]) stack.push({ kind: tag[1], condition: tag[2].trim(), inElse: false });
		else if (tag[0].startsWith('{:')) stack[stack.length - 1].inElse = true;
		else stack.pop();
	}
	return stack.filter((block) => block.kind === 'if').map(({ condition, inElse }) => ({ condition, inElse }));
}

describe('a cover, as the pages draw it', () => {
	it('is drawn only inside {#if isCoverValue(...)} of the very value drawn, on every page and in every component', () => {
		const drawn: string[] = [];
		for (const file of svelteFiles()) {
			const markup = markupOf(file);
			// `style="..."`, and the directive `style:background={...}`.
			for (const style of markup.matchAll(/\bstyle(?::[\w-]+)?=("[^"]*"|\{[^}]*\})/g)) {
				if (!style[0].includes('coverUrl')) continue;
				drawn.push(file);
				const values = [...style[0].matchAll(/\{([^}]*coverUrl[^}]*)\}/g)].map((value) => value[1].trim());
				const guards = blocksAround(markup, style.index!)
					.filter((block) => !block.inElse)
					.map((block) => block.condition);
				for (const value of values) expect(guards, `${file}: ${style[0]}`).toContain(`isCoverValue(${value})`);
			}
		}
		// The board's strip, and in the card window its header strip and the custom swatch.
		expect(drawn.sort()).toEqual([BOARD_CARD, CARD_WINDOW, CARD_WINDOW].sort());
		// Each is read whole as blocks that open and close: none is left open at its end.
		for (const file of [BOARD_PAGE, BOARD_CARD, CARD_WINDOW]) {
			const markup = markupOf(file);
			expect(blocksAround(markup, markup.length), file).toEqual([]);
		}
	});

	it('is drawn on the board as a strip across the top of each card, placed as the category strip is', () => {
		const source = readFileSync(join(ROOT, BOARD_CARD), 'utf8');
		// Each card of the board's columns is drawn through it.
		expect(readFileSync(join(ROOT, BOARD_PAGE), 'utf8')).toMatch(/<KanbanCardBody\s+\{card\}/);
		expect(source).toContain(
			'{#if isCoverValue(card.coverUrl)}<div class="card-cover-strip" style="background: {card.coverUrl}" aria-hidden="true"></div>{/if}'
		);
		// Absolute, so nothing else on the card moves.
		const rule = /\.card-cover-strip \{([^}]*)\}/.exec(source)![1].replace(/\s+/g, ' ').trim();
		expect(rule).toBe('position: absolute; left: 0; right: 0; top: 0; height: 6px; pointer-events: none;');
		expect(source).toContain("import { isCoverValue } from '$lib/colours';");
	});
});

describe('the card window’s labels and cover', () => {
	const markup = markupOf(CARD_WINDOW);

	it('are offered on a saved card only, and labels whether or not the board has any yet', () => {
		const picker = [...markup.matchAll(/<LabelPicker\b[^>]*\/>/g)];
		expect(picker.map((found) => found[0])).toEqual(['<LabelPicker cardId={card.id} {boardId} {labels} bind:selected={cardLabelIds} />']);
		const coverSwatches = [...markup.matchAll(/\{#each COVER_PRESETS as preset\}/g)];
		expect(coverSwatches).toHaveLength(1);

		for (const found of [...picker, ...coverSwatches]) {
			const around = blocksAround(markup, found.index!);
			expect(around.some((block) => block.condition === 'card' && !block.inElse), found[0]).toBe(true);
			// Not hidden on a board with no labels: a first one is made here.
			expect(around.filter((block) => block.condition.includes('labels.length')), found[0]).toEqual([]);
		}
	});

	it('have no picker of the window’s own left: labels are put on through LabelPicker.svelte, and the presets come from $lib/colours', () => {
		const source = readFileSync(join(ROOT, CARD_WINDOW), 'utf8');
		expect(source).not.toMatch(/\bfunction toggleLabel\b/);
		expect(source).not.toContain('coverPresets');
		expect(source).toContain("import { COVER_PRESETS, isCoverValue } from '$lib/colours';");
		expect(source).toContain("import LabelPicker from './LabelPicker.svelte';");
	});
});

describe('the label picker', () => {
	const PICKER = 'src/lib/components/LabelPicker.svelte';
	const source = readFileSync(join(ROOT, PICKER), 'utf8');
	const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(source)![1];

	it('can always leave edit mode: "Done editing" is offered whenever it is on, and it ends when the last label goes', () => {
		// Deleting the last label left edit mode on with no way out: "Done
		// editing" was drawn only while there were labels, and "+ New label"
		// only outside edit mode.
		const markup = markupOf(PICKER);
		const link = [...markup.matchAll(/onclick=\{toggleEditMode\}/g)];
		expect(link).toHaveLength(1);
		const around = blocksAround(markup, link[0].index!);
		/** Whether the link is drawn, with the picker in the state given. */
		const drawn = (editMode: boolean, list: unknown[], showNew: boolean) =>
			around.every(({ condition, inElse }) => Boolean(new Function('editMode', 'list', 'showNew', `return (${condition});`)(editMode, list, showNew)) !== inElse);

		expect(drawn(true, [], false), 'edit mode, no labels left').toBe(true);
		expect(drawn(true, [{}], false), 'edit mode, labels').toBe(true);
		expect(drawn(false, [{}], false), '"Edit labels"').toBe(true);
		expect(drawn(false, [], false), 'nothing to edit').toBe(false);
		expect(drawn(false, [{}], true), 'while a label is being made').toBe(false);

		// And edit mode is ended when the list is emptied, by a delete here or by
		// the board's reload, which leaves "+ New label" to make one again.
		const code = script.replace(/^\s*\/\/.*$/gm, '');
		expect(code).toMatch(/\$effect\(\(\) => \{\s*if \(list\.length === 0\) \{[^}]*\beditMode = false;/);
	});

	it('takes whether a label is on the card from the server’s answer, not from what it believed', () => {
		// The window's belief can be stale: All Tasks reopens a card as it was
		// loaded, and someone else may have toggled the label since. Flipping it
		// showed the opposite of the truth, and Save as Template saved that.
		const toggle = /async function toggleLabel\([\s\S]*?\r?\n\t\}\r?\n/.exec(script)?.[0] ?? '';
		expect(toggle).toMatch(/const \{ toggled \}[^=]*= await res\.json\(\);/);
		expect(toggle).not.toContain('selected.includes(');
	});
});
