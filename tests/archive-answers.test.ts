/**
 * What a page is told when it archives a card.
 *
 * "Delete" on a board sends `DELETE /api/cards/:id` with no `permanent`,
 * which archives the card. The pages used to send it and say "Card deleted"
 * whatever came back, a refusal included. They go through the functions here
 * now, which hand back the answer or what to say about it.
 *
 * No server and no database: `fetch` is a stand-in that answers as the route
 * would.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteFailure } from '$lib/api';
import { bulkDelete } from '$lib/board/bulk-actions';
import * as cardActions from '$lib/board/card-actions';

const answer = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('archiving cards from a board', () => {
	it('asks for each selected card in turn, and says which the server did not archive and why', async () => {
		const calls: string[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			calls.push(`${init.method} ${url}`);
			if (url.endsWith('/2')) return answer(403, { message: 'No edit access to this board' });
			// What SvelteKit answers for a failure it was not told about.
			if (url.endsWith('/3')) return answer(500, { message: 'Internal Error' });
			if (url.endsWith('/4')) throw new TypeError('fetch failed');
			return answer(200, { success: true });
		});

		const result = await bulkDelete(new Set([1, 2, 3, 4, 5]), 9);

		// No `permanent`, so each is an archive; and one that fails stops none of the rest.
		expect(calls).toEqual([1, 2, 3, 4, 5].map((id) => `DELETE /api/cards/${id}`));
		expect(result).toEqual({
			archived: 2,
			failed: [
				{ cardId: 2, message: 'No edit access to this board' },
				{ cardId: 3, message: 'The card was not archived.' },
				{ cardId: 4, message: 'No answer from the server. The card may not have been archived.' }
			]
		});
	});

	it('hands the page the answer to a single archive, so a refusal is not taken for a success', async () => {
		vi.stubGlobal('fetch', async () => answer(403, { message: 'No edit access to this board' }));
		expect(await deleteFailure(() => cardActions.deleteCard(1, 9), 'card', 'archived')).toBe(
			'No edit access to this board'
		);

		vi.stubGlobal('fetch', async () => answer(200, { success: true }));
		expect(await deleteFailure(() => cardActions.deleteCard(1, 9), 'card', 'archived')).toBeNull();
	});

	it('says "deleted" of a delete, as it did', async () => {
		expect(await deleteFailure(async () => answer(500, {}), 'board')).toBe('The board was not deleted.');
		expect(
			await deleteFailure(async () => {
				throw new TypeError('fetch failed');
			}, 'board')
		).toBe('No answer from the server. The board may not have been deleted.');
	});
});
