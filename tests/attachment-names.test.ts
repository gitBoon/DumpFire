/**
 * The name and the type a file uploaded through the card window is stored
 * with (card 2910, D11 and D12; `src/lib/server/attachment-names.ts`).
 *
 * The route's own cases are in tests/uploads.test.ts ("every upload's limits
 * (card 2910)"). These are the arms the route cannot reach (the plan review's
 * E8: a browser's `File` holds no type with `<` in it, nor one 200 characters
 * long), and the one result of an image's name that changed (S6).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionUser } from '$lib/server/auth';
import { cleanedName, storedType } from '$lib/server/attachment-names';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { api } from './helpers/api';
import { png } from './helpers/image-bytes';
import { makeBoard, makeCard, makeUser, resetDb } from './helpers/fixtures';

let owner: SessionUser;

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	owner = makeUser({ username: 'owner' });
});

describe('storedType (card 2910, D12)', () => {
	it.each([
		{ row: 'a type with < in it', declared: 'text/html<script>', stored: 'application/octet-stream' },
		// 200 characters: a subtype past the pattern's 64.
		{ row: 'a type 200 characters long', declared: `application/${'x'.repeat(188)}`, stored: 'application/octet-stream' },
		// Card 2910's code review (CR4): the empty type, which a File always fills in before the route sees it, and a plain one.
		{ row: 'no type', declared: '', stored: 'application/octet-stream' },
		{ row: 'a plain type', declared: 'text/plain', stored: 'text/plain' },
		{
			row: "a long real type, a Word document's",
			declared: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			stored: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
		}
	])('19. stores $row as $stored (E8)', ({ declared, stored }) => {
		expect(storedType(declared)).toBe(stored);
	});
});

describe('cleanedName (card 2910, S6)', () => {
	it('20. takes out a line separator and a paragraph separator, and an image is named through it', async () => {
		expect(cleanedName('a b c.png')).toBe('abc.png');

		const card = makeCard(makeBoard({ owner, name: 'A' }).cols['To Do'], { title: 'Has files' });
		const form = new FormData();
		form.set('file', new File([png() as BlobPart], 'a b c.png', { type: 'image/png' }));
		const res = await api('POST', `/api/cards/${card.id}/attachments`, { user: owner, body: form });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.originalName).toBe('abc.png');
	});
});
