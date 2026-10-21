/**
 * A team keeps at least one owner (card 2373).
 *
 * `POST /api/teams/{id}/members/{userId}` set any member's role, an owner's
 * to `member` included, and `DELETE` removed anyone, so a team's owner (or an
 * administrator) could leave it with no owner, to be run by administrators
 * alone. Now a change that takes away the team's last owner is refused, `409`
 * with a plain message, before anything is written; administrators are held
 * to it too. With another owner, or for a member of a team that already has
 * no owner, the change goes through as before.
 *
 * And a member sent with no `role` keeps the role they hold (card 2378): it
 * set `member`, demoting an owner of a team with another owner.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { teamMembers } from '$lib/server/db/schema';
import { api } from './helpers/api';
import { makeTeam, makeUser, resetDb } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

beforeEach(resetDb);

const LAST_OWNER = 'A team needs at least one owner. Make someone else an owner first, or delete the team.';

/** A team of `owner` (its owner) and `member`, and an administrator in no team. */
function scene() {
	const owner = makeUser();
	const member = makeUser();
	const admin = makeUser({ role: 'admin' });
	const team = makeTeam([owner, member]);
	db.update(teamMembers).set({ role: 'owner' }).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, owner.id))).run();
	return { owner, member, admin, team };
}

const roleOf = (teamId: number, userId: number) =>
	db.select({ role: teamMembers.role }).from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))).get()?.role;

describe('a change that would leave a team with no owner is refused, 409, with nothing written', () => {
	it.each([
		['the owner themselves', 'owner'],
		['an administrator', 'admin']
	] as const)('the last owner made a member, by %s', async (_, by) => {
		const s = scene();
		const before = snapshotDb();
		const res = await api('POST', `/api/teams/${s.team.id}/members/${s.owner.id}`, { user: s[by], body: { userId: s.owner.id, role: 'member' } });
		expect(res.status).toBe(409);
		expect(res.body.message).toBe(LAST_OWNER);
		expectUnchanged(before);
		expect(roleOf(s.team.id, s.owner.id)).toBe('owner');
	});

	it.each([
		['the owner themselves', 'owner'],
		['an administrator', 'admin']
	] as const)('the last owner removed, by %s', async (_, by) => {
		const s = scene();
		const before = snapshotDb();
		const res = await api('DELETE', `/api/teams/${s.team.id}/members/${s.owner.id}`, { user: s[by] });
		expect(res.status).toBe(409);
		expect(res.body.message).toBe(LAST_OWNER);
		expectUnchanged(before);
		expect(roleOf(s.team.id, s.owner.id)).toBe('owner');
	});

	// The card 2373 review: who may manage the team is asked before the last-owner rule, so a caller
	// who may not is not told whether the team has another owner. A contract: the route already did so.
	it.each([
		['a member of the team who is not its owner', 'member'],
		['an account outside the team', 'stranger']
	] as const)('someone who cannot manage the team, %s, is 403, not 409, for the last owner made a member or removed', async (_, who) => {
		const s = scene();
		const caller = who === 'member' ? s.member : makeUser();
		const before = snapshotDb();
		const demoted = await api('POST', `/api/teams/${s.team.id}/members/${s.owner.id}`, { user: caller, body: { userId: s.owner.id, role: 'member' } });
		expect(demoted.status).toBe(403);
		const removed = await api('DELETE', `/api/teams/${s.team.id}/members/${s.owner.id}`, { user: caller });
		expect(removed.status).toBe(403);
		expectUnchanged(before);
		expect(roleOf(s.team.id, s.owner.id)).toBe('owner');
	});

	it('a role the field may not hold is still 400, not 409', async () => {
		const s = scene();
		const res = await api('POST', `/api/teams/${s.team.id}/members/${s.owner.id}`, { user: s.owner, body: { role: 'admin' } });
		expect(res.status).toBe(400);
	});
});

describe('a change that leaves an owner goes through as before', () => {
	it('with a second owner, either owner can be made a member, and either removed', async () => {
		const s = scene();
		db.update(teamMembers).set({ role: 'owner' }).where(and(eq(teamMembers.teamId, s.team.id), eq(teamMembers.userId, s.member.id))).run();

		const demoted = await api('POST', `/api/teams/${s.team.id}/members/${s.owner.id}`, { user: s.owner, body: { role: 'member' } });
		expect(demoted.status).toBe(200);
		expect(roleOf(s.team.id, s.owner.id)).toBe('member');

		// The other is now the last owner, and is kept.
		const refused = await api('DELETE', `/api/teams/${s.team.id}/members/${s.member.id}`, { user: s.member });
		expect(refused.status).toBe(409);

		const removed = await api('DELETE', `/api/teams/${s.team.id}/members/${s.owner.id}`, { user: s.member });
		expect(removed.status).toBe(200);
		expect(roleOf(s.team.id, s.owner.id)).toBeUndefined();
	});

	it('the last owner sent back as owner, or sent no role, changes nothing and is answered as before', async () => {
		const s = scene();
		expect((await api('POST', `/api/teams/${s.team.id}/members/${s.owner.id}`, { user: s.owner, body: { role: 'owner' } })).status).toBe(200);
		// No role keeps the role they hold (card 2378): it set `member`, which card 2373 then refused.
		const none = await api('POST', `/api/teams/${s.team.id}/members/${s.owner.id}`, { user: s.owner, body: {} });
		expect(none.status).toBe(200);
		expect(roleOf(s.team.id, s.owner.id)).toBe('owner');
	});

	it('a member removed or given a role, and a new member added, with the one owner kept', async () => {
		const s = scene();
		const other = makeUser();
		expect((await api('POST', `/api/teams/${s.team.id}/members/${other.id}`, { user: s.owner, body: { role: 'member' } })).status).toBe(201);
		expect((await api('POST', `/api/teams/${s.team.id}/members/${s.member.id}`, { user: s.owner, body: { role: 'owner' } })).status).toBe(200);
		expect((await api('POST', `/api/teams/${s.team.id}/members/${s.member.id}`, { user: s.owner, body: { role: 'member' } })).status).toBe(200);
		expect((await api('DELETE', `/api/teams/${s.team.id}/members/${s.member.id}`, { user: s.owner })).status).toBe(200);
		expect(roleOf(s.team.id, s.member.id)).toBeUndefined();
	});

	it('on a team that already has no owner, an administrator changes or removes a member', async () => {
		const s = scene();
		db.update(teamMembers).set({ role: 'member' }).where(eq(teamMembers.teamId, s.team.id)).run();
		expect((await api('POST', `/api/teams/${s.team.id}/members/${s.member.id}`, { user: s.admin, body: { role: 'member' } })).status).toBe(200);
		expect((await api('DELETE', `/api/teams/${s.team.id}/members/${s.member.id}`, { user: s.admin })).status).toBe(200);
		// And makes someone its owner again.
		expect((await api('POST', `/api/teams/${s.team.id}/members/${s.owner.id}`, { user: s.admin, body: { role: 'owner' } })).status).toBe(200);
		expect(roleOf(s.team.id, s.owner.id)).toBe('owner');
	});

	it('removing someone who is not in the team is answered as before', async () => {
		const s = scene();
		const stranger = makeUser();
		expect((await api('DELETE', `/api/teams/${s.team.id}/members/${stranger.id}`, { user: s.owner })).status).toBe(200);
	});
});

// Card 2378: a body with no `role` set an existing member's role to `member`, so an owner
// sent `{}` was quietly made a member wherever the team had another owner.
describe('a member sent with no role keeps the role they hold (card 2378)', () => {
	it('an owner of a team with a second owner, sent no role, is still its owner, answered `updated`, with nothing written', async () => {
		const s = scene();
		db.update(teamMembers).set({ role: 'owner' }).where(and(eq(teamMembers.teamId, s.team.id), eq(teamMembers.userId, s.member.id))).run();
		const before = snapshotDb();
		const res = await api('POST', `/api/teams/${s.team.id}/members/${s.owner.id}`, { user: s.member, body: {} });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true, action: 'updated' });
		expectUnchanged(before);
		expect(roleOf(s.team.id, s.owner.id)).toBe('owner');
	});

	it('someone not yet in the team, sent no role, is added as a member', async () => {
		const s = scene();
		const other = makeUser();
		const res = await api('POST', `/api/teams/${s.team.id}/members/${other.id}`, { user: s.owner, body: {} });
		expect(res.status).toBe(201);
		expect(res.body).toEqual({ success: true, action: 'added' });
		expect(roleOf(s.team.id, other.id)).toBe('member');
	});
});
