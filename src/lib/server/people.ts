/**
 * people.ts — the people directory and its groups, kept by an administrator
 * (card 2674): who can be consulted on or told of a decision, with an account
 * or without one. The tables are migration 0061's (card 2673).
 *
 * The internal routes under `/api/people` and `/api/people-groups` call these,
 * handed `caller` inside their `writeAs` callback. Reading the directory for
 * the admin page is `people-directory.ts`, which takes no caller, so that a
 * page load may call it.
 *
 * Card 2681's v1 routes, under an administrator's API key, call six of them:
 * the two reads `listPeople` and `listPeopleGroups`, and `updatePerson`
 * (a job title and groups only), `createGroup`, `updateGroup` (a description
 * only) and `setGroupMembers`. An API key cannot give a password, and every
 * write that sets or ends an address or an account asks for one on the
 * People page (card 2697), so a key never adds, deletes, renames, re-addresses
 * or relinks a person, marks one left or back, adds people from accounts, or
 * renames a group: `createPerson`, `deletePerson` and `addFromAccounts`
 * refuse a key outright, and `updatePerson` and `updateGroup` refuse those
 * fields (plan D2, D3, D17). A key is told apart by the route's word
 * (`opts.source` other than `'ui'`) **and** by the credential the write was
 * let in with (`writingWithKey()` in write-as.ts, D18): either refuses, so a
 * route that passed the wrong word opens nothing. Deleting a group is the
 * People page's too (the code review's S3). What a key is answered carries no
 * address and no account id (`keyPerson`, `keyGroup` in people-shape.ts, D4),
 * and is marked `untrusted` (D6); what a key changes is logged with the
 * values it replaced (D7).
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
 * A write under an API key ends its line `(by <username>, through the API)`
 * and puts `source: 'api'`, `credential: 'api key'` and the values it
 * replaced, `before`, in the entry; a rename, by the page, puts
 * `renamed: { from, to }` there (card 2681, D7, D17, the code review's F2).
 *
 * The system log is pruned, so every change, by the page or a key, also
 * appends one row to `people_changes` (migration 0064) in the write's own
 * transaction: what the changed fields held and now hold, never an address or
 * an account id, kept for good so that an administrator can put it back
 * (`recordChange`, the code review's S1). Nothing updates or deletes a row.
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
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db, sqlite } from './db';
import { ACCESS_KIND, recordAccessChange } from './access-changes';
import { foldEquals } from './db/fold-case';
import { people, peopleChanges, peopleGroupMembers, peopleGroups, users, type PeopleGroup, type Person } from './db/schema';
import type { SessionUser } from './auth';
import { afterCommit } from './db/transaction';
import { revokeLinks, type RevokeReason } from './decision-links';
import { actorFor } from './decision-record';
import { createLogger } from './logger';
import { keyGroup, keyPerson, type KeyGroup, type KeyPerson } from './people-shape';
import { readChoice, readEmail, readId, readIds, readText, type RequestBody } from './request-body';
import { requireAdmin } from './route-guards';
import { stamp } from '$lib/timestamps';
import { yourProof } from '$lib/step-up-words';
import { codeAskedOf } from './mfa-store';
import { inWrite, writingWithKey, type ServiceOptions } from './write-as';

const log = createLogger('PEOPLE');

/**
 * The functions here that only read: the refusals of a person's change, which
 * its route asks before the caller's password when the change carries an
 * address or an account (card 2697, Q21); and of adding a person, deleting
 * one and adding people from accounts, which always set or end an address or
 * an account, so that their routes ask for the password every time (card
 * 2697's code review, part B, S1); and the directory and its groups as an
 * administrator's API key reads them (card 2681, D4, D5). Every other export
 * is a write, and starts with `inWrite()`.
 */
export const READS: readonly string[] = [
	'personUpdateGuard',
	'personCreateGuard',
	'personDeleteGuard',
	'fromAccountsGuard',
	'listPeople',
	'listPeopleGroups'
];

/**
 * The refusals of what an API key may never do (card 2681, D2, D3, D17).
 * Kept in this module, not exported: a service exports its functions and
 * `READS` alone (tests/check-at-the-write.test.ts, rule 2), so the tests and
 * the OpenAPI document write the words out.
 */
const KEY_FIELD_WORDS = 'The name, address, account and status of a person are changed on the People page: an API key cannot change them';
const KEY_RENAME_WORDS = 'A group is renamed on the People page: an API key cannot rename one';
const PAGE_ONLY_WORDS =
	'Adding a person, deleting one and adding people from accounts are done on the People page, which asks for your password: an API key cannot';
const GROUP_DELETE_WORDS = 'A group is deleted on the People page: an API key cannot delete one';
/** Card 3020 (R6): Mark active, reached without the step-up; saying what the step-up asks of the caller (card 3064, F25). */
const markActiveWords = (codeAsked: boolean) =>
	`Marking a person active asks for ${yourProof(codeAsked)}: their decision mail and personal links go to their address again. Nothing was changed.`;
/** Card 3020's code review (FP5): Mark active, the address reviewed not the person's now. */
const MARK_ACTIVE_MOVED =
	"This person's address has changed since the page was read: read it again and check the address before you mark them active. Nothing was changed.";

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
 * for the caller's password between the two (S1). An API key is refused
 * before either (card 2681, D2): every add sets an address.
 */
export function createPerson(caller: SessionUser | null, at: Record<string, never>, body: RequestBody, opts: ServiceOptions): PersonAnswer {
	inWrite();
	pageOnly(caller, opts);
	const { actor, fullName, email, jobTitle, userId, groupIds, account } = personCreateGuard(caller, at, body);

	const person = db
		.insert(people)
		.values({ fullName, email, jobTitle, userId, createdBy: actor.id })
		.returning()
		.get();
	// The record of access changes (card 3002, W11): the person tracked, with its account or none.
	recordAccessChange(sqlite, { kind: ACCESS_KIND.personLink, subject: person.id, holder: person.userId, access: 'linked' });
	if (groupIds.length > 0) {
		db.insert(peopleGroupMembers)
			.values(groupIds.map((groupId) => ({ groupId, personId: person.id })))
			.run();
	}
	recordChange(actor, opts, 'person', person.id, 'created', null, personFacts(person, groupIds));

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
 * `email` or `userId` (card 2697, Q21), or `status` other than the exact
 * string `'left'` (card 3020, R6), and only then passes `steppedUp: true`:
 * marking a person active without it is refused 400, nothing written.
 *
 * Under an API key (card 2681) the body may carry `jobTitle` and `groupIds`
 * alone: `email`, `userId`, `status` and `fullName` are refused 403 whatever
 * they hold, before the person is looked for (D2, D3, D17). The answer is
 * `keyPerson`'s, a change that changes nothing included (D20), and the line
 * logged says it came through the API, with the values it replaced (D7).
 */
export function updatePerson(
	caller: SessionUser | null,
	at: { personId: number },
	body: RequestBody,
	opts: ServiceOptions & { steppedUp?: boolean }
): PersonAnswer | KeyPerson {
	inWrite();
	refuseKeyFields(caller, body, opts);
	const { actor, person, heldGroups, groupIds, groupsChange, updates, changed, account, linkChange, statusChange, status } = personUpdateGuard(caller, at, body, {
		steppedUp: opts.steppedUp === true
	});
	const byKey = throughKey(opts);

	if (Object.keys(updates).length === 0 && !groupsChange) return byKey ? keyPerson(person, heldGroups) : { ...person, groupIds: heldGroups };

	updates.updatedAt = stamp();
	const row = db.update(people).set(updates).where(eq(people.id, person.id)).returning().get();
	// The record of access changes (card 3002, W12): a change of the account the person is linked to.
	if (linkChange) recordAccessChange(sqlite, { kind: ACCESS_KIND.personLink, subject: person.id, holder: row.userId, access: 'linked' });
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

	// S1 of the code review: what each changed field held and now holds, kept for good. An address or an
	// account is said to have changed, and never what it was or is.
	const was: ChangeFacts = {};
	const now: ChangeFacts = {};
	if (updates.fullName !== undefined) [was.fullName, now.fullName] = [person.fullName, row.fullName];
	if (updates.jobTitle !== undefined) [was.jobTitle, now.jobTitle] = [person.jobTitle, row.jobTitle];
	if (statusChange) {
		[was.status, now.status] = [person.status, row.status];
		[was.leftAt, now.leftAt] = [person.leftAt, row.leftAt];
	}
	if (groupsChange) [was.groupIds, now.groupIds] = [sortedIds(heldGroups), sortedIds(groupIds)];
	if (updates.email !== undefined) now.addressChanged = true;
	if (linkChange) now.account = row.userId === null ? 'unlinked' : 'linked';
	recordChange(actor, opts, 'person', person.id, 'updated', was, now);

	const parts: string[] = [];
	if (changed.length > 0) parts.push(`changed: ${changed.join(', ')}`);
	if (statusChange) parts.push(status === 'left' ? 'marked left' : 'marked active');
	if (account) parts.push(`linked to account ${account.id} "${account.username}"`);
	else if (linkChange) parts.push(`unlinked from account ${person.userId}`);
	if (clears) parts.push(`${cleared.length} decision links cleared`);
	// Card 2681, D17: a rename, by the page, says what the name was.
	const renamed = updates.fullName !== undefined ? { renamed: { from: person.fullName, to: row.fullName } } : {};
	// D7: a key's change says it came through the API, and what it replaced.
	const before: { jobTitle?: string; groupIds?: number[] } = {};
	if (updates.jobTitle !== undefined) before.jobTitle = person.jobTitle;
	if (groupsChange) before.groupIds = heldGroups;
	const keyed = byKey ? { ...KEYED, before } : {};
	afterCommit(() =>
		log.info(
			`Person ${row.id} "${row.fullName}" ${parts.join('; ')} (by ${actor.username}${via(byKey)})`,
			{
				personId: row.id,
				fields: Object.keys(updates).filter((key) => key !== 'updatedAt' && key !== 'leftAt').concat(groupsChange ? ['groupIds'] : []),
				userId: row.userId,
				participantIds: cleared,
				...renamed,
				...keyed
			},
			{ userId: actor.id }
		)
	);
	const held = groupsChange ? groupIds : heldGroups;
	return byKey ? keyPerson(row, held) : { ...row, groupIds: held };
}

/**
 * Every refusal of `updatePerson`, in its order, read only (card 2697, Q21):
 * the caller an administrator (403), the person (404), every field read
 * (400), a new address another person holds (409), a group that is not one
 * (400), and an account that is not one or another person is linked to
 * (400, 409). `PUT /api/people/:id` asks it before the caller's password,
 * when the body carries `email` or `userId`, or `status` other than the
 * exact string `'left'`, so that none of these costs a check; `updatePerson`
 * asks it first, so the rules are one. Answers what the write then does: the
 * columns that change, and whether the groups, the account link and the
 * status do.
 *
 * Marking a person active (card 3020, R6) lets their decision mail and
 * personal links go to their address again, an address a backup whose seal
 * did not verify may have chosen: it is refused 400 unless `opts.steppedUp`,
 * which the route passes only from its step-up branch. The belt beside the
 * route's key check, so that no other caller marks someone active unasked.
 * And it is tied to the address the administrator was shown (its code
 * review, FP5): the body carries it as `reviewedEmail`, which writes nothing,
 * is required, and must be the person's address now, or it is 409.
 */
export function personUpdateGuard(
	caller: SessionUser | null,
	at: { personId: number },
	body: RequestBody,
	opts: { steppedUp: boolean }
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
	if (statusChange && status === 'active') {
		if (!opts.steppedUp) error(400, markActiveWords(codeAskedOf(actor.id)));
		// The address the confirmation showed: read only, never written (FP5).
		const reviewed = readText(body, 'reviewedEmail', { required: true, max: 1000 });
		if (reviewed !== person.email) error(409, MARK_ACTIVE_MOVED);
	}
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
 * personal link the person holds and frees their address for another. An API
 * key is refused before either (card 2681, D2).
 */
export function deletePerson(caller: SessionUser | null, at: { personId: number }, body: null, opts: ServiceOptions): { linksCleared: number } {
	inWrite();
	pageOnly(caller, opts);
	const { actor, person } = personDeleteGuard(caller, at);

	const cleared = clearLinks(person.id, 'person_deleted', actor, opts);
	// Read before the delete, which takes the memberships with it (S1 of the code review).
	recordChange(actor, opts, 'person', person.id, 'deleted', personFacts(person, groupIdsOf(person.id)), null);
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
 * to an account and given its address. An API key is refused before either
 * (card 2681, D2).
 */
export function addFromAccounts(caller: SessionUser | null, at: Record<string, never>, body: RequestBody, opts: ServiceOptions): FromAccountsAnswer {
	inWrite();
	pageOnly(caller, opts);
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
		const match = db.select({ id: people.id }).from(people).where(foldEquals(people.email, email)).get();
		if (match) {
			skipped.push({ userId, reason: `address matches person ${match.id}; link by hand` });
			continue;
		}
		const person = db.insert(people).values({ fullName: account.username, email, userId, createdBy: actor.id }).returning().get();
		// The record of access changes (card 3002, W13): the person tracked, linked to the account.
		recordAccessChange(sqlite, { kind: ACCESS_KIND.personLink, subject: person.id, holder: userId, access: 'linked' });
		// One change a person made, each its own subject (S1 of the code review).
		recordChange(actor, opts, 'person', person.id, 'created', null, personFacts(person, []));
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
	const rows = db
		.select({ id: users.id, username: users.username, email: users.email, disabledAt: users.disabledAt })
		.from(users)
		.where(inArray(users.id, userIds))
		.all();
	const missing = userIds.find((id) => !rows.some((account) => account.id === id));
	if (missing !== undefined) error(400, `userId ${missing} is not an account`);
	// A person is not added for a disabled account (card 2671, S2): it could neither be mailed nor answer.
	const disabled = userIds.find((id) => rows.some((account) => account.id === id && account.disabledAt !== null));
	if (disabled !== undefined) error(400, `userId ${disabled} is a disabled account`);
	const accounts = rows.map(({ id, username, email }) => ({ id, username, email }));
	return { actor, userIds, accounts };
}

/**
 * Add a group (`POST /api/people-groups`): `name` text, trimmed, 1 to 100
 * characters, used by no other group in any case (409); `description` text,
 * trimmed, up to 1,000, '' if not sent. Under an API key (card 2681) the
 * answer is `keyGroup`'s, with no people yet, and the line logged says it came
 * through the API (D7).
 */
export function createGroup(caller: SessionUser | null, at: Record<string, never>, body: RequestBody, opts: ServiceOptions): PeopleGroup | KeyGroup {
	inWrite();
	const actor = requireAdmin(caller, opts.says);
	const byKey = throughKey(opts);

	const name = readText(body, 'name', { required: true, trim: true, min: 1, max: 100 });
	const description = readText(body, 'description', { trim: true, max: 1000 }) ?? '';
	requireUnusedGroupName(name);

	const group = db.insert(peopleGroups).values({ name, description }).returning().get();
	recordChange(actor, opts, 'group', group.id, 'created', null, { name: group.name, description: group.description, personIds: [] });

	const keyed = byKey ? KEYED : {};
	afterCommit(() =>
		log.info(`Group ${group.id} "${group.name}" added (by ${actor.username}${via(byKey)})`, { groupId: group.id, ...keyed }, { userId: actor.id })
	);
	return byKey ? keyGroup(group, []) : group;
}

/**
 * Rename a group or change its description (`PUT /api/people-groups/:id`),
 * each read as `createGroup` reads it, the stored value kept where it is sent
 * back. A body that changes nothing writes and logs nothing. A rename says in
 * the line's entry what the name was (card 2681, D17).
 *
 * Under an API key (card 2681) the body may carry `description` alone: `name`
 * is refused 403 whatever it holds, before the group is looked for (D17). The
 * answer is `keyGroup`'s, with the group's people, a change that changes
 * nothing included (D20), and the line logged says it came through the API,
 * with the description it replaced (D7).
 */
export function updateGroup(caller: SessionUser | null, at: { groupId: number }, body: RequestBody, opts: ServiceOptions): PeopleGroup | KeyGroup {
	inWrite();
	const actor = refuseKeyRename(caller, body, opts);
	const group = requireGroup(at.groupId);
	const byKey = throughKey(opts);

	const name = readText(body, 'name', { trim: true, min: 1, max: 100, keep: group.name });
	const description = readText(body, 'description', { trim: true, max: 1000, keep: group.description });

	const updates: Partial<typeof peopleGroups.$inferInsert> = {};
	if (name !== undefined && name !== group.name) {
		requireUnusedGroupName(name, group.id);
		updates.name = name;
	}
	if (description !== undefined && description !== group.description) updates.description = description;
	if (Object.keys(updates).length === 0) return byKey ? keyGroup(group, memberIdsOf(group.id)) : group;

	const row = db.update(peopleGroups).set(updates).where(eq(peopleGroups.id, group.id)).returning().get();
	const was: ChangeFacts = {};
	const now: ChangeFacts = {};
	if (updates.name !== undefined) [was.name, now.name] = [group.name, row.name];
	if (updates.description !== undefined) [was.description, now.description] = [group.description, row.description];
	recordChange(actor, opts, 'group', group.id, 'updated', was, now);

	const fields = Object.keys(updates);
	const renamed = updates.name !== undefined ? { renamed: { from: group.name, to: row.name } } : {};
	const keyed = byKey ? { ...KEYED, before: updates.description !== undefined ? { description: group.description } : {} } : {};
	afterCommit(() =>
		log.info(
			`Group ${row.id} "${row.name}" changed: ${fields.join(', ')} (by ${actor.username}${via(byKey)})`,
			{ groupId: row.id, fields, ...renamed, ...keyed },
			{ userId: actor.id }
		)
	);
	return byKey ? keyGroup(row, memberIdsOf(row.id)) : row;
}

/**
 * Delete a group (`DELETE /api/people-groups/:id`, decision 4). Its
 * memberships go with it; the people stay. The People page's alone: an API
 * key is refused (card 2681, D11 and the code review's S3), as no v1 route
 * offers it, whatever word the route passes. The group and the set it held
 * are kept in `people_changes`, read before the delete, so that it can be
 * made again (S1, S3).
 */
export function deleteGroup(caller: SessionUser | null, at: { groupId: number }, body: null, opts: ServiceOptions): void {
	inWrite();
	const actor = pageOnly(caller, opts, GROUP_DELETE_WORDS);
	const group = requireGroup(at.groupId);

	recordChange(actor, opts, 'group', group.id, 'deleted', { name: group.name, description: group.description, personIds: memberIdsOf(group.id) }, null);
	db.delete(peopleGroups).where(eq(peopleGroups.id, group.id)).run();

	afterCommit(() => log.info(`Group ${group.id} "${group.name}" deleted (by ${actor.username})`, { groupId: group.id }, { userId: actor.id }));
}

/**
 * Set who is in a group (`PUT /api/people-groups/:id/members`): `personIds`,
 * 0 to 5,000 people who all exist, or a 400 and nothing changes. The set sent
 * replaces the set held. Under an API key (card 2681) the answer is
 * `keyGroup`'s, and the line logged says it came through the API, with the
 * set it replaced, read once before the delete, so that an administrator can
 * put it back (D7).
 */
export function setGroupMembers(
	caller: SessionUser | null,
	at: { groupId: number },
	body: RequestBody,
	opts: ServiceOptions
): (PeopleGroup & { personIds: number[] }) | KeyGroup {
	inWrite();
	const actor = requireAdmin(caller, opts.says);
	const group = requireGroup(at.groupId);
	const byKey = throughKey(opts);

	const personIds = unique(readIds(body, 'personIds', { required: true, max: MOST_MEMBERS }));
	requirePeople(personIds);

	// The set held, read once before the delete: kept for good, and logged for a key (D7; S1 of the code review).
	const held = memberIdsOf(group.id);
	const keyed = byKey ? { ...KEYED, before: { personIds: held } } : {};
	db.delete(peopleGroupMembers).where(eq(peopleGroupMembers.groupId, group.id)).run();
	if (personIds.length > 0) {
		db.insert(peopleGroupMembers)
			.values(personIds.map((personId) => ({ groupId: group.id, personId })))
			.run();
	}
	recordChange(actor, opts, 'group', group.id, 'members_set', { personIds: held }, { personIds: sortedIds(personIds) });

	afterCommit(() =>
		log.info(
			`Group ${group.id} "${group.name}" members set: ${personIds.length} (by ${actor.username}${via(byKey)})`,
			{ groupId: group.id, personIds, ...keyed },
			{ userId: actor.id }
		)
	);
	return byKey ? keyGroup(group, personIds) : { ...group, personIds };
}

// ─── The directory as an API key reads it (card 2681) ───────────────────────

/**
 * Every person of the directory, left ones included, by name and then id,
 * each with the ids of their groups: no address and no account id (D4), and
 * `untrusted` (D6). An administrator's alone, as the People page is (D5): a
 * 403 in the route's words (`opts.says`) for anyone else (D19).
 */
export function listPeople(user: SessionUser | null, at: Record<string, never>, opts: { says?: string }): KeyPerson[] {
	requireAdmin(user, opts.says);
	const rows = db.select().from(people).orderBy(people.fullName, people.id).all();
	const groupsBy = new Map<number, number[]>();
	for (const { groupId, personId } of db.select().from(peopleGroupMembers).orderBy(peopleGroupMembers.groupId).all()) {
		const held = groupsBy.get(personId);
		if (held) held.push(groupId);
		else groupsBy.set(personId, [groupId]);
	}
	return rows.map((row) => keyPerson(row, groupsBy.get(row.id) ?? []));
}

/**
 * Every group, by name and then id, each with the ids of its people, left
 * people included, and `untrusted` (D6). An administrator's alone (D5), as
 * `listPeople`.
 */
export function listPeopleGroups(user: SessionUser | null, at: Record<string, never>, opts: { says?: string }): KeyGroup[] {
	requireAdmin(user, opts.says);
	const rows = db.select().from(peopleGroups).orderBy(peopleGroups.name, peopleGroups.id).all();
	const peopleBy = new Map<number, number[]>();
	for (const { groupId, personId } of db.select().from(peopleGroupMembers).orderBy(peopleGroupMembers.personId).all()) {
		const held = peopleBy.get(groupId);
		if (held) held.push(personId);
		else peopleBy.set(groupId, [personId]);
	}
	return rows.map((row) => keyGroup(row, peopleBy.get(row.id) ?? []));
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

/**
 * Whether the write is an API key's (card 2681, D18): the route said it came
 * through the API, or it was let in with a key, whatever the route said.
 * Either is enough.
 */
function throughKey(opts: ServiceOptions): boolean {
	return opts.source !== 'ui' || writingWithKey();
}

/** What a key's line says inside its `(by …)`, decided while the write runs: `writingWithKey()` is false after the commit. */
function via(byKey: boolean): string {
	return byKey ? ', through the API' : '';
}

/**
 * What a key's PEOPLE line puts in its entry, whatever word the route passed
 * (the code review's F2): a write let in with a key under a route that said
 * `'ui'` is recorded as the API's, as `people_changes` records it.
 */
const KEYED = { source: 'api', credential: 'api key' } as const;

/**
 * What a `people_changes` row says a field held or holds (the code review's
 * S1): a person's name, job title, status, when they left and their groups; a
 * group's name, description and people. An address or an account is only
 * said to have changed: never what it was or is.
 */
type ChangeFacts = {
	fullName?: string;
	jobTitle?: string;
	status?: string;
	leftAt?: string | null;
	groupIds?: number[];
	addressChanged?: true;
	account?: 'linked' | 'unlinked';
	name?: string;
	description?: string;
	personIds?: number[];
};

/** A person as a `people_changes` row keeps them whole, made or deleted: no address and no account id. */
function personFacts(row: Person, groupIds: readonly number[]): ChangeFacts {
	return { fullName: row.fullName, jobTitle: row.jobTitle, status: row.status, leftAt: row.leftAt, groupIds: sortedIds(groupIds) };
}

/**
 * Append one row to `people_changes`, in the write's own transaction (card
 * 2681, the code review's S1): who, by the page or a key, what about, what
 * kind of change, and what it was and became. The one insert into the table
 * here; the only other is restore.ts's `switchOffUnsealedPeople`, by DumpFire
 * with source `'restore'`, for each person an unsealed restore marks left
 * (card 3020, R13). Nothing updates or deletes a row
 * (tests/decision-record.test.ts reads the source for it). `source` is `'api'`
 * whenever the write is a key's, by the route's word or the credential (F2).
 */
function recordChange(
	actor: SessionUser,
	opts: ServiceOptions,
	subject: 'person' | 'group',
	subjectId: number,
	kind: 'created' | 'updated' | 'deleted' | 'members_set',
	before: ChangeFacts | null,
	after: ChangeFacts | null
): void {
	db.insert(peopleChanges)
		.values({
			createdAt: stamp(),
			actorUserId: actor.id,
			actorName: actor.username,
			source: throughKey(opts) ? 'api' : 'ui',
			subject,
			subjectId,
			kind,
			before: before === null ? null : JSON.stringify(before),
			after: after === null ? null : JSON.stringify(after)
		})
		.run();
}

/** The ids, smallest first, in a list of their own. */
function sortedIds(ids: readonly number[]): number[] {
	return [...ids].sort((a, b) => a - b);
}

/**
 * The refusal of a write that is the People page's alone (card 2681, D2):
 * the caller an administrator (403, in the route's words), then 403 for an
 * API key. Adding a person, deleting one and Add from accounts each set or
 * end an address or an account, which asks for a password a key cannot give;
 * deleting a group drops a set nothing else holds (D11, the code review's
 * S3). Answers the caller.
 */
function pageOnly(caller: SessionUser | null, opts: ServiceOptions, words: string = PAGE_ONLY_WORDS): SessionUser {
	const actor = requireAdmin(caller, opts.says);
	if (throughKey(opts)) error(403, words);
	return actor;
}

/**
 * The refusal of a person's change that carries what a key may not change
 * (card 2681, D2, D3, D17): the caller an administrator (403, in the route's
 * words), then, under a key, 403 for a body that has `email`, `userId`,
 * `status` or `fullName`, whatever it holds, the stored value and null among
 * them. Asked before the person is looked for, so nothing is read for it.
 */
function refuseKeyFields(caller: SessionUser | null, body: RequestBody, opts: ServiceOptions): SessionUser {
	const actor = requireAdmin(caller, opts.says);
	if (
		throughKey(opts) &&
		(Object.hasOwn(body, 'email') || Object.hasOwn(body, 'userId') || Object.hasOwn(body, 'status') || Object.hasOwn(body, 'fullName'))
	) {
		error(403, KEY_FIELD_WORDS);
	}
	return actor;
}

/** The same for a group's change (card 2681, D17): under a key, 403 for a body that has `name`. Asked before the group is looked for. */
function refuseKeyRename(caller: SessionUser | null, body: RequestBody, opts: ServiceOptions): SessionUser {
	const actor = requireAdmin(caller, opts.says);
	if (throughKey(opts) && Object.hasOwn(body, 'name')) error(403, KEY_RENAME_WORDS);
	return actor;
}

/** The ids of a group's people, in order. */
function memberIdsOf(groupId: number): number[] {
	return db
		.select({ personId: peopleGroupMembers.personId })
		.from(peopleGroupMembers)
		.where(eq(peopleGroupMembers.groupId, groupId))
		.orderBy(peopleGroupMembers.personId)
		.all()
		.map((row) => row.personId);
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
 * A 409 for an address another person has, compared in any case of any letter
 * (card 2890). `except` is
 * the person being changed. The answer, an administrator's only, names the
 * holder and the account they are linked to, if any; never the address.
 */
function requireUnusedEmail(email: string, except?: number): void {
	const holder = db
		.select({ id: people.id, fullName: people.fullName, username: users.username })
		.from(people)
		.leftJoin(users, eq(users.id, people.userId))
		.where(and(foldEquals(people.email, email), except === undefined ? undefined : ne(people.id, except)))
		.get();
	if (holder) {
		const linked = holder.username != null ? ` (linked to account ${holder.username})` : '';
		error(409, `Email already in the directory: ${holder.fullName}${linked}`);
	}
}

/**
 * The account a person is to be linked to: a 400 for no such account, and
 * for one that is disabled (card 2671, S2); a 409 for one linked to another
 * person already. `except` is the person being changed.
 */
function requireLinkable(userId: number, except?: number): { id: number; username: string } {
	const row = db.select({ id: users.id, username: users.username, disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId)).get();
	if (!row) error(400, `userId ${userId} is not an account`);
	if (row.disabledAt !== null) error(400, `userId ${userId} is a disabled account`);
	const account = { id: row.id, username: row.username };
	const holder = db.select({ id: people.id, fullName: people.fullName }).from(people).where(eq(people.userId, userId)).get();
	if (holder && holder.id !== except) error(409, `That account is already linked to ${holder.fullName}`);
	return account;
}

/** A 409 for a group name another group has, in any case of any letter (card 2890). `except` is the group being renamed. */
function requireUnusedGroupName(name: string, except?: number): void {
	const holder = db
		.select({ id: peopleGroups.id, name: peopleGroups.name })
		.from(peopleGroups)
		.where(and(foldEquals(peopleGroups.name, name), except === undefined ? undefined : ne(peopleGroups.id, except)))
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
