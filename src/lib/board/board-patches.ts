/**
 * board-patches.ts — a write's change to the board's columns, and its undo
 * (card 2280, slice B1 of card 2012's part B).
 *
 * The board page is to show a change at once, send it, and on a refusal or no
 * answer put back what it replaced, without re-reading the board. Each
 * function here takes the columns as they are, returns new columns with the
 * change made, and an undo. Nothing given is changed: a column or card the
 * change does not touch is handed back as the same object.
 *
 * Two rules from the plan's review (R7):
 *
 *   - **A patch merges.** `patchCard` puts the given fields on the card and
 *     keeps every other: an answer that is a bare row (no subtasks, labels or
 *     assignees) never strips the card of what the board read gave it.
 *   - **An undo puts back only its own change.** It is given the columns as
 *     they are when it is called, which a refresh may have changed meanwhile,
 *     and restores only the fields, the place or the presence its patch
 *     changed, on that card or column alone. Someone else's change to another
 *     card, or to another field, is kept.
 *
 * Moving a card is `moveCards`, which sets its `columnId` and position and
 * puts it in its new column; `patchCard` given a `columnId` would leave the
 * card where it is drawn.
 */

type CardLike = { id: number; columnId: number; position: number };
type ColumnLike = { id: number; position: number; cards: CardLike[] };
type CardOf<C extends ColumnLike> = C['cards'][number];

/** The columns with a change made, and how to take it back out of the columns as they are then. */
export type Patched<C> = { columns: C[]; undo: (current: C[]) => C[] };

/** The old value of each key of `fields` on `row`, to put back. */
function oldValues<T extends object>(row: T, fields: Partial<T>): Partial<T> {
	const old: Partial<T> = {};
	for (const key of Object.keys(fields) as (keyof T)[]) old[key] = row[key];
	return old;
}

/** Where a card is: its column's index and its own index in that column. */
function findCard<C extends ColumnLike>(columns: C[], cardId: number): { col: number; at: number } | null {
	for (let col = 0; col < columns.length; col++) {
		const at = columns[col].cards.findIndex((card) => card.id === cardId);
		if (at !== -1) return { col, at };
	}
	return null;
}

/** `columns` with column `col`'s cards replaced. */
function withCards<C extends ColumnLike>(columns: C[], col: number, cards: CardOf<C>[]): C[] {
	return columns.map((column, i) => (i === col ? { ...column, cards } : column));
}

/** Where a card of `position` goes among `cards`: before the first placed after it. */
function placeFor(cards: CardLike[], position: number): number {
	const at = cards.findIndex((card) => card.position > position);
	return at === -1 ? cards.length : at;
}

/**
 * Of `values`, those whose field `row` still holds as `set` put it: a write's
 * answer or undo is put only on a field no later change has taken since (the
 * B2b review: of two quick changes to one priority, the first's answer or
 * refusal put its own value back over the second's).
 */
function stillSet<T extends object>(row: T, set: Partial<T>, values: Partial<T>): Partial<T> {
	const kept: Partial<T> = {};
	for (const key of Object.keys(values) as (keyof T)[]) if (row[key] === set[key]) kept[key] = values[key];
	return kept;
}

/** Put `fields` on card `cardId`, keeping every other field. */
export function patchCard<C extends ColumnLike>(columns: C[], cardId: number, fields: Partial<CardOf<C>>): Patched<C> {
	const found = findCard(columns, cardId);
	if (!found || Object.keys(fields).length === 0) return { columns, undo: (current) => current };
	const card = columns[found.col].cards[found.at] as CardOf<C>;
	const old = oldValues(card, fields);
	const cards = columns[found.col].cards.map((c) => (c.id === cardId ? { ...c, ...fields } : c)) as CardOf<C>[];
	return {
		columns: withCards(columns, found.col, cards),
		undo: (current) => patchCardStill(current, cardId, fields, old)
	};
}

/**
 * Put `values` on card `cardId`, each only while the card still holds the
 * value `set` gave that field: what a write's answer or undo does, so a later
 * write's value is left in place.
 */
export function patchCardStill<C extends ColumnLike>(columns: C[], cardId: number, set: Partial<CardOf<C>>, values: Partial<CardOf<C>>): C[] {
	const found = findCard(columns, cardId);
	if (!found) return columns;
	return patchCard(columns, cardId, stillSet(columns[found.col].cards[found.at] as CardOf<C>, set, values)).columns;
}

/** One card's new place. */
export type CardMove = { id: number; columnId: number; position: number };

/**
 * Move cards: each takes its new `columnId` and position, and is drawn in its
 * new column before the first card placed after it. A move into a column not
 * on the board is left out, the card where it was. The undo takes each back
 * to the column, position and index it had, unless a refresh has taken the
 * card off the board meanwhile.
 */
export function moveCards<C extends ColumnLike>(columns: C[], moves: CardMove[]): Patched<C> {
	type Was = { id: number; col: number; columnId: number; at: number; position: number };
	const was: Was[] = [];
	const moving = new Map<number, CardOf<C>>();
	for (const move of moves) {
		const found = findCard(columns, move.id);
		// A card not on the board, or a move into a column not on it, changes nothing: the card stays where it was.
		if (!found || !columns.some((column) => column.id === move.columnId)) continue;
		const card = columns[found.col].cards[found.at] as CardOf<C>;
		was.push({ id: move.id, col: found.col, columnId: card.columnId, at: found.at, position: card.position });
		moving.set(move.id, card);
	}

	let next = columns.map((column) =>
		column.cards.some((card) => moving.has(card.id)) ? { ...column, cards: column.cards.filter((card) => !moving.has(card.id)) } : column
	);
	for (const move of moves) {
		const card = moving.get(move.id);
		const col = next.findIndex((column) => column.id === move.columnId);
		if (!card || col === -1) continue;
		const cards = [...next[col].cards] as CardOf<C>[];
		cards.splice(placeFor(cards, move.position), 0, { ...card, columnId: move.columnId, position: move.position });
		next = withCards(next, col, cards);
	}

	return {
		columns: next,
		undo: (current) => {
			// Each card as it is now (a refresh may have changed it), back where it
			// was. A card a refresh took off the board meanwhile stays off it.
			const now = new Map<number, CardOf<C>>();
			for (const w of was) {
				const found = findCard(current, w.id);
				if (found) now.set(w.id, current[found.col].cards[found.at] as CardOf<C>);
			}
			let back = current.map((column) =>
				column.cards.some((card) => now.has(card.id)) ? { ...column, cards: column.cards.filter((card) => !now.has(card.id)) } : column
			);
			for (const w of [...was].sort((a, b) => a.at - b.at)) {
				const col = back.findIndex((column) => column.id === w.columnId);
				if (col === -1 || !now.has(w.id)) continue;
				const cards = [...back[col].cards] as CardOf<C>[];
				cards.splice(Math.min(w.at, cards.length), 0, { ...now.get(w.id)!, columnId: w.columnId, position: w.position });
				back = withCards(back, col, cards);
			}
			return back;
		}
	};
}

/** Add a card to its column (`card.columnId`), before the first card placed after it. */
export function insertCard<C extends ColumnLike>(columns: C[], card: CardOf<C>): Patched<C> {
	const col = columns.findIndex((column) => column.id === card.columnId);
	if (col === -1) return { columns, undo: (current) => current };
	const cards = [...columns[col].cards] as CardOf<C>[];
	cards.splice(placeFor(cards, card.position), 0, card);
	return {
		columns: withCards(columns, col, cards),
		undo: (current) => removeCard(current, card.id).columns
	};
}

/**
 * Take a card off the board. The undo puts it back where it was, unless it is
 * there again: before the first of the cards that followed it then which is
 * still in the column, or at the end. So cards taken off one after another
 * (a bulk archive, card 2280's slice B2b) go back in their order whichever
 * of them is put back first, which a remembered index would not do.
 */
export function removeCard<C extends ColumnLike>(columns: C[], cardId: number): Patched<C> {
	const found = findCard(columns, cardId);
	if (!found) return { columns, undo: (current) => current };
	const card = columns[found.col].cards[found.at] as CardOf<C>;
	const columnId = columns[found.col].id;
	const followers = columns[found.col].cards.slice(found.at + 1).map((c) => c.id);
	return {
		columns: withCards(columns, found.col, columns[found.col].cards.filter((c) => c.id !== cardId) as CardOf<C>[]),
		undo: (current) => {
			if (findCard(current, cardId)) return current;
			const col = current.findIndex((column) => column.id === columnId);
			if (col === -1) return current;
			const cards = [...current[col].cards] as CardOf<C>[];
			const next = followers.map((id) => cards.findIndex((c) => c.id === id)).find((at) => at !== -1);
			cards.splice(next ?? cards.length, 0, card);
			return withCards(current, col, cards);
		}
	};
}

/** Put `fields` on column `columnId`, keeping every other field and its cards. */
export function patchColumn<C extends ColumnLike>(columns: C[], columnId: number, fields: Partial<Omit<C, 'cards'>>): Patched<C> {
	const column = columns.find((c) => c.id === columnId);
	if (!column || Object.keys(fields).length === 0) return { columns, undo: (current) => current };
	const old = oldValues(column as Omit<C, 'cards'>, fields);
	return {
		columns: columns.map((c) => (c.id === columnId ? { ...c, ...fields } : c)),
		undo: (current) => patchColumnStill(current, columnId, fields, old)
	};
}

/** `patchCardStill` for a column's fields. */
export function patchColumnStill<C extends ColumnLike>(columns: C[], columnId: number, set: Partial<Omit<C, 'cards'>>, values: Partial<Omit<C, 'cards'>>): C[] {
	const column = columns.find((c) => c.id === columnId);
	if (!column) return columns;
	return patchColumn(columns, columnId, stillSet(column as Omit<C, 'cards'>, set, values)).columns;
}

/** Add a column, before the first placed after it. */
export function insertColumn<C extends ColumnLike>(columns: C[], column: C): Patched<C> {
	const next = [...columns];
	const at = next.findIndex((c) => c.position > column.position);
	next.splice(at === -1 ? next.length : at, 0, column);
	return { columns: next, undo: (current) => removeColumn(current, column.id).columns };
}

/** Take a column off the board. The undo puts it back where it was, unless it is there again. */
export function removeColumn<C extends ColumnLike>(columns: C[], columnId: number): Patched<C> {
	const at = columns.findIndex((c) => c.id === columnId);
	if (at === -1) return { columns, undo: (current) => current };
	const column = columns[at];
	return {
		columns: columns.filter((c) => c.id !== columnId),
		undo: (current) => {
			if (current.some((c) => c.id === columnId)) return current;
			const back = [...current];
			back.splice(Math.min(at, back.length), 0, column);
			return back;
		}
	};
}

/**
 * Of the fields a write sent, the value the answer gives for each, where it
 * gives one (card 2280, slice B2b): what the write took, as the server stored
 * it. The answer is the whole row, but its other fields are taken from no
 * write: they are as the server had them when this one was answered, and a
 * second change still on its way (a title typed after a priority picked)
 * would be undone on screen until its own answer came (R7; check 7 of the
 * plan's section 8.2). No answer, or one without a field, keeps what was sent.
 */
export function answeredFields<T extends object>(answer: Record<string, unknown> | null, fields: Partial<T>): Partial<T> {
	const taken: Partial<T> = { ...fields };
	if (!answer) return taken;
	for (const key of Object.keys(fields) as (keyof T & string)[]) {
		if (key in answer) taken[key] = answer[key] as T[keyof T & string];
	}
	return taken;
}

/**
 * A copy of the columns and their cards, as a drag finds them (card 2280,
 * slice B2b): the board page changes its columns in place while a card is
 * dragged, so what it puts back must not be those same objects.
 */
export function copyColumns<C extends ColumnLike>(columns: C[]): C[] {
	return columns.map((column) => ({ ...column, cards: column.cards.map((card) => ({ ...card })) }));
}

/** Every card on the board by id, as it is now; a drag's shadow of a card is not one. */
function cardsById<C extends ColumnLike>(columns: C[]): Map<number, CardOf<C>> {
	const byId = new Map<number, CardOf<C>>();
	for (const column of columns) {
		for (const card of column.cards) if (!(card as { isDndShadowItem?: boolean }).isDndShadowItem) byId.set(card.id, card as CardOf<C>);
	}
	return byId;
}

/**
 * `columns` in their order, each card the one of the same id in `current`
 * where there is one (the B2b review): a drop's columns are copies made as it
 * was sent, and a write answered or taken back meanwhile changed the card on
 * the board, not the copy. A card on the board nowhere now is kept as the
 * copy has it only if the drag carried it (`dragged`: a keyboard drop's card
 * is in no column until it lands); any other was taken off meanwhile (an
 * archive answered while the drag was in hand) and stays off (the re-check).
 */
export function withCurrentCards<C extends ColumnLike>(columns: C[], current: C[], dragged: Iterable<number>): C[] {
	const now = cardsById(current);
	const carried = new Set(dragged);
	return columns.map((column) => {
		const cards = column.cards.flatMap((card) => {
			const shown = now.get(card.id);
			return shown ? [shown] : carried.has(card.id) ? [card] : [];
		});
		return cards.length === column.cards.length && cards.every((card, i) => card === column.cards[i]) ? column : { ...column, cards };
	});
}

/**
 * Put back a drag of cards that was refused, blocked or cancelled (card 2280,
 * slice B2b): each column whose cards the drag moved gets back the order of
 * cards it had in `before` (`copyColumns`, taken as the drag began), each
 * card as it is now, with the column and place it had then (the B2b review: a
 * write taken back during the drag is not brought back with the copy).
 *
 * Only the columns the drag touched are put back: those that held one of
 * `dragged` (the cards the drag carried) then or hold one now. Any other is
 * kept as it is now, the same object, whatever changed in it meanwhile. A
 * card of the copy on the board nowhere now comes back only if the drag
 * carried it (a keyboard hop's, in no column until it lands); any other was
 * taken off meanwhile (an archive answered while the drag was in hand) and
 * stays off; a card put in a touched column meanwhile is kept, after the
 * rest (the re-check). No read is needed, and none can land meanwhile: the
 * board is held from a drag's first move to its move's answer (R6).
 */
export function undoDrag<C extends ColumnLike>(current: C[], before: C[], dragged: Iterable<number>): C[] {
	const carried = new Set(dragged);
	const holdsOne = (column: ColumnLike) => column.cards.some((card) => carried.has(card.id));
	const then = new Map(before.map((column) => [column.id, column]));
	const now = cardsById(current);
	return current.map((column) => {
		const was = then.get(column.id);
		if (!was || !(holdsOne(was) || holdsOne(column))) return column;
		const same = was.cards.length === column.cards.length && was.cards.every((card, i) => card.id === column.cards[i].id);
		if (same) return column;
		const kept = new Set(was.cards.map((card) => card.id));
		const cards = was.cards.flatMap((card) => {
			const shown = now.get(card.id);
			if (!shown) return carried.has(card.id) ? [card] : [];
			return [shown.columnId === card.columnId && shown.position === card.position ? shown : { ...shown, columnId: card.columnId, position: card.position }];
		});
		const added = column.cards.filter((card) => !kept.has(card.id) && !carried.has(card.id));
		return { ...column, cards: [...cards, ...added] as CardOf<C>[] };
	});
}

/**
 * Put the columns in the order of `orderedIds`, each taking its index as its
 * position, as the column drag sends them. Columns not named keep their order
 * after the named ones. The undo puts back the order and positions there were.
 */
export function reorderColumns<C extends ColumnLike>(columns: C[], orderedIds: number[]): Patched<C> {
	const before = columns.map((c) => ({ id: c.id, position: c.position }));
	const named = orderedIds.map((id) => columns.find((c) => c.id === id)).filter((c): c is C => c !== undefined);
	const rest = columns.filter((c) => !orderedIds.includes(c.id));
	const next = [...named, ...rest].map((c, position) => (c.position === position ? c : { ...c, position }));
	return {
		columns: next,
		undo: (current) => {
			const order = new Map(before.map((b, i) => [b.id, i]));
			const known = current.filter((c) => order.has(c.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
			const others = current.filter((c) => !order.has(c.id));
			return [...known, ...others].map((c) => {
				const was = before.find((b) => b.id === c.id);
				return was && was.position !== c.position ? { ...c, position: was.position } : c;
			});
		}
	};
}
