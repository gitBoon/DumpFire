/**
 * people.ts — the people directory and its groups, kept by an administrator
 * (card 2674): who can be consulted on or told of a decision, with an account
 * or without one. The tables are migration 0061's (card 2673).
 *
 * The internal routes under `/api/people` and `/api/people-groups` call these,
 * handed `caller` inside their `writeAs` callback; card 2681's v1 routes will
 * call the same. Reading the directory for the admin page is
 * `people-directory.ts`, which takes no caller, so that a page load may call it.
 *
 * Each write has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`): `inWrite()` first, then the caller (an administrator, or
 * 403), the row in the path (404), every field read from the body (400), the
 * checks against other rows (400, 409), and the write. Refusals are kit
 * `error()`s.
 *
 * Every change is written to the system log, context PEOPLE, level INFO, once
 * it is committed (`afterCommit`): the actor's name in the text and their id
 * in the entry, the person or group by id and name, and the fields that
 * changed. Never an email address. A refused write logs nothing, as what is
 * queued is dropped with the transaction (plan, sections 4.5 and 9, R4).
 *
 * A person's personal decision links (`decision_participants.link_token_hash`)
 * are emptied when the person is marked left, linked to an account, unlinked
 * from one, given a new address, or deleted (design S6, comment 5649; card
 * 2675 decision 12). Each emptied row is recorded on its decision as a
 * `link_revoked` event with the reason, by the administrator
 * (`revokeLinks` in decision-links.ts). Nothing else on a participant row is
 * touched: its snapshots are the record's (S7).
 *
 * A person whose account is deleted is marked left, and their links ended
 * with the reason `left`, by `deleteUser` in deletes.ts, inside the delete's
 * own transaction and through the same `revokeLinks` (card 2675's code
 * review, S4): Mark active, here, is the deliberate act that brings them back.
 */
import { error } from '@sveltejs/kit';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from './db';
import { people, peopleGroupMembers, peopleGroups, users, type PeopleGroup, type Person } from './db/schema';
import type { SessionUser } from './auth';
import { afterCommit } from './db/transaction';
import { revokeLinks, type RevokeReason } from './decision-links';
import { actorFor } from './decision-record';
import { createLogger } from './logger';
import { readChoice, readEmail, readId, readIds, readText, type RequestBody } from './request-body';
import { requireAdmin } from './route-guards';
import { stamp } from '$lib/timestamps';
import { inWrite, type ServiceOptions } from './write-as';

const log = createLogger('PEOPLE');

/**
 * The functions here that only read: the refusals of a person's change, which
 * its route asks before the caller's password when the change carries an
 * address or an account (card 2697, Q21); and of adding a person, deleting
 * one and adding people from accounts, which always set or end an address or
 * an account, so that their routes ask for the password every time (card
 * 2697's code review, part B, S1). Every other export is a write, and starts
 * with `inWrite()`.
 */
export const READS: readonly string[] = ['personUpdateGuard', 'personCreateGuard', 'personDeleteGuard', 'fromAccountsGuard'];

/** A person as the routes answer one: the row, and the ids of their groups. */
export type PersonAnswer = Person & { groupIds: number[] };

/** What Add from accounts answers: how many were made, and each account skipped with why. */
export type FromAccountsAnswer = { created: number; skipped: { userId: number; reason: string }[] };

/** The most groups a person may be put in at once, and the most people a group may be given at once. */
const MOST_GROUPS = 500;
const MOST_MEMBERS = 5000;

/**
 * Add a person (`POST /api/people`). `fullName` text, trimmed, 1 to 200
 * characters; `email` an address, stored lower-case, used by nobody else in
 * the directory, people who left included; `jobTitle` text, trimmed, up to
 * 200, '' if not sent; `userId` an account no other person is linked to, or
 * null; `groupIds` groups that exist, none if not sent.
 *
 * Every refusal is `personCreateGuard`'s, asked first. Its internal route asks
 * for the caller's password between the two (S1).
 */
export function createPerson(caller: SessionUser | null, at: Record<string, never>, body: RequestBody, opts: ServiceOptions): PersonAnswer {
	inWrite();
	const { actor, fullName, email, jobTitle, userId, groupIds, account } = personCreateGuard(caller, at, body);

	const person = db
		.insert(people)
		.values({ fullName, email, jobTitle, userId, createdBy: actor.id })
		.returning()
		.get();
	if (groupIds.length > 0) {
		db.insert(peopleGroupMembers)
			.values(groupIds.map((groupId) => ({ groupId, personId: person.id })))
			.run();
	}

	const linked = account ? `, linked to account ${account.id} "${account.username}"` : '';
	afterCommit(() =>
		log.info(
			`Person ${person.id} "${person.fullName}" added${linked} (by ${actor.username})`,
			{ personId: person.id, userId: person.userId, groupIds },
			{ userId: actor.id }
		)
	);
	return { ...person, groupIds };
}

/**
 * Every refusal of `createPerson`, in its order, read only (card 2697's code
 * review, part B, S1): the caller an administrator (403), every field read
 * (400; `email` is required, so every body that can make a person carries an
 * address), an address another person holds (409), an account that is not one
 * or is linked to another person (400, 409), and a group that is not one
 * (400). `POST /api/people` asks it before the caller's password, so that none
 * of these costs a check; `createPerson` asks it first, so the rules are one.
 * Answers what the write inserts.
 */
export function personCreateGuard(
	caller: SessionUser | null,
	at: Record<string, never>,
	body: RequestBody
): {
	actor: SessionUser;
	fullName: string;
	email: string;
	jobTitle: string;
	userId: number | null;
	groupIds: number[];
	account: { id: number; username: string } | null;
} {
	const actor = requireAdmin(caller);

	const fullName = readText(body, 'fullName', { required: true, trim: true, min: 1, max: 200 });
	const email = readEmail(body, 'email', { required: true }).toLowerCase();
	const jobTitle = readText(body, 'jobTitle', { trim: true, max: 200 }) ?? '';
	const userId = readId(body, 'userId', { nullable: true }) ?? null;
	const groupIds = unique(readIds(body, 'groupIds', { max: MOST_GROUPS }) ?? []);

	requireUnusedEmail(email);
	const account = userId === null ? null : requireLinkable(userId);
	requireGroups(groupIds);
	return { actor, fullName, email, jobTitle, userId, groupIds, account };
}

/**
 * Change a person (`PUT /api/people/:id`). Each field as `createPerson` reads
 * it, the stored value kept where it is sent back, and `status` `active` or
 * `left`. Only what changes is written, with `updated_at` stamped; a body that
 * changes nothing writes and logs nothing. `left` stamps `left_at` and keeps
 * the account link and the groups; `active` clears it. A changed `groupIds`
 * replaces the memberships. Marking the person left, linking them to an
 * account, unlinking them and a new address each empty their decision links,
 * and record a `link_revoked` event for each row emptied (card 2675 decision
 * 12, comment 5649). An update that does more than one clears once, with the
 * first reason of left, linked, unlinked, address changed. A rename, a new
 * job title, new groups and Mark active clear nothing.
 *
 * Every refusal is `personUpdateGuard`'s, asked first. Its internal route
 * asks for the caller's password between the two when the body carries
 * `email` or `userId` (card 2697, Q21).
 */
export function updatePerson(caller: SessionUser | null, at: { personId: number }, body: RequestBody, opts: ServiceOptions): PersonAnswer {
	inWrite();
	const { actor, person, heldGroups, groupIds, groupsChange, updates, changed, account, linkChange, statusChange, status } = personUpdateGuard(caller, at, body);

	if (Object.keys(updates).length === 0 && !groupsChange) return { ...person, groupIds: heldGroups };

	updates.updatedAt = stamp();
	const row = db.update(people).set(updates).where(eq(people.id, person.id)).returning().get();
	if (groupsChange) {
		db.delete(peopleGroupMembers).where(eq(peopleGroupMembers.personId, person.id)).run();
		if (groupIds.length > 0) {
			db.insert(peopleGroupMembers)
				.values(groupIds.map((groupId) => ({ groupId, personId: person.id })))
				.run();
		}
	}
	// Card 2675 decision 12: once, with the first reason that applies.
	const reason: RevokeReason | null =
		statusChange && status === 'left'
			? 'left'
			: account !== null
				? 'linked'
				: linkChange
					? 'unlinked'
					: updates.email !== undefined
						? 'address_changed'
						: null;
	const clears = reason !== null;
	const cleared = reason !== null ? clearLinks(person.id, reason, actor, opts) : [];

	const parts: string[] = [];
	if (changed.length > 0) parts.push(`changed: ${changed.join(', ')}`);
	if (statusChange) parts.push(status === 'left' ? 'marked left' : 'marked active');
	if (account) parts.push(`linked to account ${account.id} "${account.username}"`);
	else if (linkChange) parts.push(`unlinked from account ${person.userId}`);
	if (clears) parts.push(`${cleared.length} decision links cleared`);
	afterCommit(() =>
		log.info(
			`Person ${row.id} "${row.fullName}" ${parts.join('; ')} (by ${actor.username})`,
			{
				personId: row.id,
				fields: Object.keys(updates).filter((key) => key !== 'updatedAt' && key !== 'leftAt').concat(groupsChange ? ['groupIds'] : []),
				userId: row.userId,
				participantIds: cleared
			},
			{ userId: actor.id }
		)
	);
	return { ...row, groupIds: groupsChange ? groupIds : heldGroups };
}

/**
 * Every refusal of `updatePerson`, in its order, read only (card 2697, Q21):
 * the caller an administrator (403), the person (404), every field read
 * (400), a new address another person holds (409), a group that is not one
 * (400), and an account that is not one or another person is linked to
 * (400, 409). `PUT /api/people/:id` asks it before the caller's password,
 * when the body carries `email` or `userId`, so that none of these costs a
 * check; `updatePerson` asks it first, so the rules are one. Answers what
 * the write then does: the columns that change, and whether the groups, the
 * account link and the status do.
 */
export function personUpdateGuard(
	caller: SessionUser | null,
	at: { personId: number },
	body: RequestBody
): {
	actor: SessionUser;
	person: Person;
	heldGroups: number[];
	groupIds: number[];
	groupsChange: boolean;
	updates: Partial<typeof people.$inferInsert>;
	changed: string[];
	account: { id: number; username: string } | null;
	linkChange: boolean;
	statusChange: boolean;
	status: string | undefined;
} {
	const actor = requireAdmin(caller);
	const person = requirePerson(at.personId);
	const heldGroups = groupIdsOf(person.id);

	const fullName = readText(body, 'fullName', { trim: true, min: 1, max: 200, keep: person.fullName });
	const email = readEmail(body, 'email', { keep: person.email })?.toLowerCase();
	const jobTitle = readText(body, 'jobTitle', { trim: true, max: 200, keep: person.jobTitle });
	const userId = readId(body, 'userId', { nullable: true, keep: person.userId });
	const status = readChoice(body, 'status', { from: ['active', 'left'] as const, keep: person.status });
	const sentGroups = readIds(body, 'groupIds', { max: MOST_GROUPS, keep: heldGroups });
	const groupIds = sentGroups === undefined ? undefined : unique(sentGroups);

	const updates: Partial<typeof people.$inferInsert> = {};
	/** The names of what changed, for the log line. */
	const changed: string[] = [];
	if (fullName !== undefined && fullName !== person.fullName) {
		updates.fullName = fullName;
		changed.push('name');
	}
	if (email !== undefined && email !== person.email) {
		requireUnusedEmail(email, person.id);
		updates.email = email;
		changed.push('email');
	}
	if (jobTitle !== undefined && jobTitle !== person.jobTitle) {
		updates.jobTitle = jobTitle;
		changed.push('job title');
	}
	const groupsChange = groupIds !== undefined && !sameIds(groupIds, heldGroups);
	if (groupsChange) {
		requireGroups(groupIds);
		changed.push('groups');
	}
	const linkChange = userId !== undefined && userId !== person.userId;
	const account = linkChange && userId !== null ? requireLinkable(userId, person.id) : null;
	if (linkChange) updates.userId = userId;
	const statusChange = status !== undefined && status !== person.status;
	if (statusChange) {
		updates.status = status;
		updates.leftAt = status === 'left' ? stamp() : null;
	}

	return { actor, person, heldGroups, groupIds: groupIds ?? heldGroups, groupsChange, updates, changed, account, linkChange, statusChange, status };
}

/**
 * Delete a person (`DELETE /api/people/:id`, decision 3). Their decision links
 * are emptied first, while the participant rows can still be found by person;
 * then the person goes. Their memberships go with them, and every participant
 * row keeps its snapshots with `person_id` emptied by its key. The address is
 * free again afterwards. Answers how many links were emptied.
 *
 * Every refusal is `personDeleteGuard`'s, asked first. Its internal route asks
 * for the caller's password between the two (S1): the delete ends every
 * personal link the person holds and frees their address for another.
 */
export function deletePerson(caller: SessionUser | null, at: { personId: number }, body: null, opts: ServiceOptions): { linksCleared: number } {
	inWrite();
	const { actor, person } = personDeleteGuard(caller, at);

	const cleared = clearLinks(person.id, 'person_deleted', actor, opts);
	db.delete(people).where(eq(people.id, person.id)).run();

	afterCommit(() =>
		log.info(
			`Person ${person.id} "${person.fullName}" deleted; ${cleared.length} decision links cleared (by ${actor.username})`,
			{ personId: person.id, participantIds: cleared },
			{ userId: actor.id }
		)
	);
	return { linksCleared: cleared.length };
}

/**
 * Every refusal of `deletePerson`, read only (S1): the caller an
 * administrator (403) and the person (404). `DELETE /api/people/:id` asks it
 * before the caller's password; `deletePerson` asks it first.
 */
export function personDeleteGuard(caller: SessionUser | null, at: { personId: number }): { actor: SessionUser; person: Person } {
	const actor = requireAdmin(caller);
	const person = requirePerson(at.personId);
	return { actor, person };
}

/**
 * Add a person for each account named (`POST /api/people/from-accounts`),
 * `userIds` 1 to 500 accounts, in one transaction. Every id must be an
 * account, or it is a 400 and nothing is made. An account already linked to a
 * person is skipped; so is one whose address, lower-cased, is a person's: that
 * person is linked by hand if wanted, as an account's address is the holder's
 * own and unconfirmed (decision 13). Any other is made a person named by its
 * username, with its address lower-cased and linked to it.
 *
 * Every refusal is `fromAccountsGuard`'s, asked first. Its internal route asks
 * for the caller's password between the two (S1): each person made is linked
 * to an account and given its address.
 */
export function addFromAccounts(caller: SessionUser | null, at: Record<string, never>, body: RequestBody, opts: ServiceOptions): FromAccountsAnswer {
	inWrite();
	const { actor, userIds, accounts } = fromAccountsGuard(caller, at, body);

	let created = 0;
	const skipped: FromAccountsAnswer['skipped'] = [];
	for (const userId of userIds) {
		const account = accounts.find((a) => a.id === userId)!;
		if (db.select({ id: people.id }).from(people).where(eq(people.userId, userId)).get()) {
			skipped.push({ userId, reason: 'already linked' });
			continue;
		}
		const email = account.email.toLowerCase();
		const match = db.select({ id: people.id }).from(people).where(sql`lower(${people.email}) = ${email}`).get();
		if (match) {
			skipped.push({ userId, reason: `address matches person ${match.id}; link by hand` });
			continue;
		}
		db.insert(people).values({ fullName: account.username, email, userId, createdBy: actor.id }).run();
		created++;
	}

	afterCommit(() =>
		log.info(
			`${created} people added from accounts, ${skipped.length} skipped (by ${actor.username})`,
			{ userIds, created, skipped },
			{ userId: actor.id }
		)
	);
	return { created, skipped };
}

/**
 * Every refusal of `addFromAccounts`, read only (S1): the caller an
 * administrator (403), `userIds` (400), and an id that is no account (400).
 * `POST /api/people/from-accounts` asks it before the caller's password;
 * `addFromAccounts` asks it first. Answers the ids, each once, and their
 * accounts.
 */
export function fromAccountsGuard(
	caller: SessionUser | null,
	at: Record<string, never>,
	body: RequestBody
): { actor: SessionUser; userIds: number[]; accounts: { id: number; username: string; email: string }[] } {
	const actor = requireAdmin(caller);

	const userIds = unique(readIds(body, 'userIds', { required: true, min: 1, max: 500 }));
	const accounts = db
		.select({ id: users.id, username: users.username, email: users.email })
		.from(users)
		.where(inArray(users.id, userIds))
		.all();
	const missing = userIds.find((id) => !accounts.some((account) => account.id === id));
	if (missing !== undefined) error(400, `userId ${missing} is not an account`);
	return { actor, userIds, accounts };
}

/**
 * Add a group (`POST /api/people-groups`): `name` text, trimmed, 1 to 100
 * characters, used by no other group in any case (409); `description` text,
 * trimmed, up to 1,000, '' if not sent.
 */
export function createGroup(caller: SessionUser | null, at: Record<string, never>, body: RequestBody, opts: ServiceOptions): PeopleGroup {
	inWrite();
	const actor = requireAdmin(caller);

	const name = readText(body, 'name', { required: true, trim: true, min: 1, max: 100 });
	const description = readText(body, 'description', { trim: true, max: 1000 }) ?? '';
	requireUnusedGroupName(name);

	const group = db.insert(peopleGroups).values({ name, description }).returning().get();

	afterCommit(() => log.info(`Group ${group.id} "${group.name}" added (by ${actor.username})`, { groupId: group.id }, { userId: actor.id }));
	return group;
}

/**
 * Rename a group or change its description (`PUT /api/people-groups/:id`),
 * each read as `createGroup` reads it, the stored value kept where it is sent
 * back. A body that changes nothing writes and logs nothing.
 */
export function updateGroup(caller: SessionUser | null, at: { groupId: number }, body: RequestBody, opts: ServiceOptions): PeopleGroup {
	inWrite();
	const actor = requireAdmin(caller);
	const group = requireGroup(at.groupId);

	const name = readText(body, 'name', { trim: true, min: 1, max: 100, keep: group.name });
	const description = readText(body, 'description', { trim: true, max: 1000, keep: group.description });

	const updates: Partial<typeof peopleGroups.$inferInsert> = {};
	if (name !== undefined && name !== group.name) {
		requireUnusedGroupName(name, group.id);
		updates.name = name;
	}
	if (description !== undefined && description !== group.description) updates.description = description;
	if (Object.keys(updates).length === 0) return group;

	const row = db.update(peopleGroups).set(updates).where(eq(peopleGroups.id, group.id)).returning().get();

	const fields = Object.keys(updates);
	afterCommit(() =>
		log.info(`Group ${row.id} "${row.name}" changed: ${fields.join(', ')} (by ${actor.username})`, { groupId: row.id, fields }, { userId: actor.id })
	);
	return row;
}

/** Delete a group (`DELETE /api/people-groups/:id`, decision 4). Its memberships go with it; the people stay. */
export function deleteGroup(caller: SessionUser | null, at: { groupId: number }, body: null, opts: ServiceOptions): void {
	inWrite();
	const actor = requireAdmin(caller);
	const group = requireGroup(at.groupId);

	db.delete(peopleGroups).where(eq(peopleGroups.id, group.id)).run();

	afterCommit(() => log.info(`Group ${group.id} "${group.name}" deleted (by ${actor.username})`, { groupId: group.id }, { userId: actor.id }));
}

/**
 * Set who is in a group (`PUT /api/people-groups/:id/members`): `personIds`,
 * 0 to 5,000 people who all exist, or a 400 and nothing changes. The set sent
 * replaces the set held.
 */
export function setGroupMembers(
	caller: SessionUser | null,
	at: { groupId: number },
	body: RequestBody,
	opts: ServiceOptions
): PeopleGroup & { personIds: number[] } {
	inWrite();
	const actor = requireAdmin(caller);
	const group = requireGroup(at.groupId);

	const personIds = unique(readIds(body, 'personIds', { required: true, max: MOST_MEMBERS }));
	requirePeople(personIds);

	db.delete(peopleGroupMembers).where(eq(peopleGroupMembers.groupId, group.id)).run();
	if (personIds.length > 0) {
		db.insert(peopleGroupMembers)
			.values(personIds.map((personId) => ({ groupId: group.id, personId })))
			.run();
	}

	afterCommit(() =>
		log.info(
			`Group ${group.id} "${group.name}" members set: ${personIds.length} (by ${actor.username})`,
			{ groupId: group.id, personIds },
			{ userId: actor.id }
		)
	);
	return { ...group, personIds };
}

// ─── Inside the writes ───────────────────────────────────────────────────────

/** The ids, each once, in the order first sent. */
function unique(ids: number[]): number[] {
	return [...new Set(ids)];
}

/** Whether two lists of ids hold the same ids, in any order. */
function sameIds(a: number[], b: number[]): boolean {
	const sorted = (ids: number[]) => [...ids].sort((x, y) => x - y).join(',');
	return sorted(a) === sorted(b);
}

/** The ids of a person's groups, in order. */
function groupIdsOf(personId: number): number[] {
	return db
		.select({ groupId: peopleGroupMembers.groupId })
		.from(peopleGroupMembers)
		.where(eq(peopleGroupMembers.personId, personId))
		.orderBy(peopleGroupMembers.groupId)
		.all()
		.map((row) => row.groupId);
}

/** The person, or 404. */
function requirePerson(personId: number): Person {
	const person = db.select().from(people).where(eq(people.id, personId)).get();
	if (!person) error(404, 'Person not found');
	return person;
}

/** The group, or 404. */
function requireGroup(groupId: number): PeopleGroup {
	const group = db.select().from(peopleGroups).where(eq(peopleGroups.id, groupId)).get();
	if (!group) error(404, 'Group not found');
	return group;
}

/**
 * Empty the personal decision links of every participant row of the person,
 * and nothing else on them, recording `link_revoked { reason }` on each row's
 * decision by the administrator (card 2675, `revokeLinks`). Answers the rows
 * emptied, in order; a row with no link is not one of them (plan, section 9,
 * R7). Only an opened decision's rows hold a link, so no event names a
 * draft's participant.
 */
function clearLinks(personId: number, reason: RevokeReason, actor: SessionUser, opts: ServiceOptions): number[] {
	return revokeLinks({ personId }, reason, actorFor(actor, opts.source));
}

/**
 * A 409 for an address another person has, compared lower-cased. `except` is
 * the person being changed. The answer, an administrator's only, names the
 * holder and the account they are linked to, if any; never the address.
 */
function requireUnusedEmail(email: string, except?: number): void {
	const holder = db
		.select({ id: people.id, fullName: people.fullName, username: users.username })
		.from(people)
		.leftJoin(users, eq(users.id, people.userId))
		.where(and(sql`lower(${people.email}) = ${email.toLowerCase()}`, except === undefined ? undefined : ne(people.id, except)))
		.get();
	if (holder) {
		const linked = holder.username != null ? ` (linked to account ${holder.username})` : '';
		error(409, `Email already in the directory: ${holder.fullName}${linked}`);
	}
}

/**
 * The account a person is to be linked to: a 400 for no such account, and a
 * 409 for one linked to another person already. `except` is the person being
 * changed.
 */
function requireLinkable(userId: number, except?: number): { id: number; username: string } {
	const account = db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, userId)).get();
	if (!account) error(400, `userId ${userId} is not an account`);
	const holder = db.select({ id: people.id, fullName: people.fullName }).from(people).where(eq(people.userId, userId)).get();
	if (holder && holder.id !== except) error(409, `That account is already linked to ${holder.fullName}`);
	return account;
}

/** A 409 for a group name another group has, in any case. `except` is the group being renamed. */
function requireUnusedGroupName(name: string, except?: number): void {
	const holder = db
		.select({ id: peopleGroups.id, name: peopleGroups.name })
		.from(peopleGroups)
		.where(and(sql`lower(${peopleGroups.name}) = ${name.toLowerCase()}`, except === undefined ? undefined : ne(peopleGroups.id, except)))
		.get();
	if (holder) error(409, `Group name already in use: ${holder.name}`);
}

/** A 400 naming the first id that is no group. */
function requireGroups(ids: number[]): void {
	if (ids.length === 0) return;
	const found = new Set(db.select({ id: peopleGroups.id }).from(peopleGroups).where(inArray(peopleGroups.id, ids)).all().map((row) => row.id));
	const missing = ids.find((id) => !found.has(id));
	if (missing !== undefined) error(400, `groupId ${missing} is not a group`);
}

/** A 400 naming the first id that is no person. */
function requirePeople(ids: number[]): void {
	if (ids.length === 0) return;
	const found = new Set(db.select({ id: people.id }).from(people).where(inArray(people.id, ids)).all().map((row) => row.id));
	const missing = ids.find((id) => !found.has(id));
	if (missing !== undefined) error(400, `personId ${missing} is not a person`);
}
