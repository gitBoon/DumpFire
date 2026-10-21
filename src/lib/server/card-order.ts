/**
 * card-order.ts — the one order of cards by their place (card 2347), beside
 * `subtask-order.ts`.
 *
 * Cards are listed by `position`, and by id where two share it, so cards at
 * one position read in the order they were made. Every reader that hands out
 * cards in their place on the board orders them this way: the board page (and
 * `GET /api/boards/:id/contents`), All Tasks and All To Do, the internal
 * picker, the v1 listing and both CSV exports. Before, all but the picker and
 * the v1 listing (card 2295) ordered by `position` alone, so a tie came in
 * whatever order SQLite read it: within one column the order they were made,
 * but across columns, as All Tasks' buckets and the exports' rows run, by the
 * column it was in. A card made through the API with no `position` is at 0,
 * so a script's cards all tie.
 *
 * Columns the same (card 2372): `COLUMN_ORDER`, by position and then by id,
 * so two columns at one position (a column made through v1 with a chosen
 * `position`, or a reorder that sent one twice) read oldest first on every
 * reader, where each gave them in whatever order SQLite read them. A reader
 * that lists cards column by column orders by `...COLUMN_ORDER, ...CARD_ORDER`.
 */
import { asc } from 'drizzle-orm';
import { cards, columns } from './db/schema';

/** `.orderBy(...CARD_ORDER)`: by position, then by id. */
export const CARD_ORDER = [asc(cards.position), asc(cards.id)] as const;

/** `.orderBy(...COLUMN_ORDER)`: a board's columns by position, then by id. */
export const COLUMN_ORDER = [asc(columns.position), asc(columns.id)] as const;
