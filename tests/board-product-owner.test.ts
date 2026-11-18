/**
 * A board's Product Owner (card 2673, decision 4): `boards.product_owner_user_id`,
 * the default decider of the board's decisions, set with
 * `PUT /api/v1/boards/{boardId}` and carried by every board answer.
 *
 * It is null, or an account that can edit the board. A change of it is the
 * board's owner's or an administrator's, and both that and whether the account
 * can edit the board are asked only when the value changes, so a board read
 * with GET can be sent back whole even after its Product Owner has lost access.
 *
 * The column, its key and its index are migration 0061's, held by
 * `tests/migrations.test.ts`. The plan is
 * `docs/planning/card-2673-decision-model.md`, sections 3 and 6.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { sqlite } from '$lib/server/db';
import type { SessionUser } from '$lib/server/auth';
import { api, type ApiResult } from './helpers/api';
import { addBoardMember, makeBoard, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

const NOT_THE_OWNER = "Only the board's owner or an administrator can change its Product Owner";

let owner: SessionUser;
let editor: SessionUser;
let A: BoardFixture;

beforeEach(() => {
	resetDb();
	owner = makeUser({ username: 'owner' });
	editor = makeUser({ username: 'editor' });
	A = makeBoard({ owner, name: 'A' });
	addBoardMember(A.board, editor, 'editor');
});

const update = (body: Record<string, unknown>, user: SessionUser = owner) =>
	api('PUT', `/api/v1/boards/${A.board.id}`, { user, body });
const read = (user: SessionUser = owner) => api('GET', `/api/v1/boards/${A.board.id}`, { user });
const stored = () =>
	(sqlite.prepare('SELECT product_owner_user_id AS id FROM boards WHERE id = ?').get(A.board.id) as { id: number | null }).id;

/** The request is answered `status` with `message`, and nothing in the database changed. */
async function expectRefused(request: () => Promise<ApiResult>, status: number, message: string): Promise<void> {
	const before = snapshotDb();
	const res = await request();
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	expect(res.body).toEqual({ message });
	expectUnchanged(before);
}

describe('PUT /api/v1/boards/{boardId} with productOwnerUserId', () => {
	it('is set and cleared by the board’s owner, and carried by the board answer', async () => {
		expect((await read()).body.productOwnerUserId).toBeNull();

		const set = await update({ productOwnerUserId: editor.id });
		expect(set.status, JSON.stringify(set.body)).toBe(200);
		expect(set.body.productOwnerUserId).toBe(editor.id);
		expect(stored()).toBe(editor.id);
		const got = await read(editor);
		expect(got.status).toBe(200);
		expect(got.body.productOwnerUserId).toBe(editor.id);
		// Recorded as the board's other changes are, with the field named.
		const entry = sqlite.prepare("SELECT detail FROM activity_log WHERE board_id = ? AND action LIKE '%board_updated' ORDER BY id DESC").get(A.board.id) as {
			detail: string;
		};
		expect(entry.detail).toContain('productOwnerUserId');

		const cleared = await update({ productOwnerUserId: null });
		expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
		expect(cleared.body.productOwnerUserId).toBeNull();
		expect(stored()).toBeNull();
		expect((await read()).body.productOwnerUserId).toBeNull();
	});

	it('is the owner’s or an administrator’s to change, asked only when it changes', async () => {
		const other = makeUser({ username: 'other' });
		addBoardMember(A.board, other, 'editor');

		// An editor changing it is refused, and nothing else sent with it is saved.
		await expectRefused(() => update({ name: 'Renamed', productOwnerUserId: other.id }, editor), 403, NOT_THE_OWNER);

		// An editor sending back the stored value is not changing it.
		sqlite.prepare('UPDATE boards SET product_owner_user_id = ? WHERE id = ?').run(other.id, A.board.id);
		const same = await update({ name: 'Renamed', productOwnerUserId: other.id }, editor);
		expect(same.status, JSON.stringify(same.body)).toBe(200);
		expect(same.body.name).toBe('Renamed');
		expect(stored()).toBe(other.id);

		// The Product Owner loses access: the board sent back whole by its owner is
		// accepted, and the value stays.
		sqlite.prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?').run(A.board.id, other.id);
		const whole = (await read()).body as Record<string, unknown>;
		const { columns: _columns, ...board } = whole;
		const back = await update(board);
		expect(back.status, JSON.stringify(back.body)).toBe(200);
		expect(back.body.productOwnerUserId).toBe(other.id);
		expect(stored()).toBe(other.id);
	});

	it('is set by an administrator who is not the board’s owner', async () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });

		const res = await update({ productOwnerUserId: editor.id }, admin);

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.productOwnerUserId).toBe(editor.id);
		expect(stored()).toBe(editor.id);
	});

	it('refuses, 400, an account that cannot edit the board, a reader of a public board included, an unknown id and a value that is no id', async () => {
		const outsider = makeUser({ username: 'outsider' });
		const cannotEdit = (id: number) =>
			`productOwnerUserId ${id} cannot edit this board: a board's Product Owner must be an account that can edit it`;

		// No role on the board at all.
		await expectRefused(() => update({ productOwnerUserId: outsider.id }), 400, cannotEdit(outsider.id));
		// A reader: on a public board everyone signed in can view it, and no more.
		sqlite.prepare('UPDATE boards SET is_public = 1 WHERE id = ?').run(A.board.id);
		await expectRefused(() => update({ productOwnerUserId: outsider.id }), 400, cannotEdit(outsider.id));
		// No such account.
		await expectRefused(() => update({ productOwnerUserId: 999_999 }), 400, 'productOwnerUserId 999999 is not an account');
		// Not an id.
		for (const value of ['abc', 1.5, true]) {
			await expectRefused(() => update({ productOwnerUserId: value }), 400, 'productOwnerUserId must be an id');
		}
	});

	// Card 2671 (case 23): a disabled account can edit no board, so is no Product Owner (F4).
	it('refuses, 400, an editor of the board whose account is disabled, in the words for one who cannot edit it', async () => {
		sqlite.prepare("UPDATE users SET disabled_at = '2099-01-01 09:00:00' WHERE id = ?").run(editor.id);

		await expectRefused(
			() => update({ productOwnerUserId: editor.id }),
			400,
			`productOwnerUserId ${editor.id} cannot edit this board: a board's Product Owner must be an account that can edit it`
		);
	});
});
