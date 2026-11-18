/**
 * people-directory.ts — the people directory as the admin page shows it
 * (card 2674): every person, every group and every account, in four reads.
 *
 * It takes no caller: the page load that calls it (`/admin/people`) asks
 * whether the caller is an administrator itself, as `/admin` does, and the
 * gate asks before it. A service's read may not be called from a page load
 * (tests/check-at-the-write.test.ts), and so this is not in `people.ts`,
 * where the writes are (plan, section 9, R3).
 */
import { asc } from 'drizzle-orm';
import { db } from './db';
import { people, peopleGroupMembers, peopleGroups, users, type PeopleGroup, type Person } from './db/schema';

/** A person, with the ids of their groups and the account they are linked to. */
export type DirectoryPerson = Person & { groupIds: number[]; account: { id: number; username: string } | null };

/** A group, with the ids of its people. */
export type DirectoryGroup = PeopleGroup & { personIds: number[] };

/** An account, for linking a person to and for Add from accounts: the person it is linked to, if any. */
export type DirectoryAccount = { id: number; username: string; email: string; emoji: string; personId: number | null };

export type Directory = { people: DirectoryPerson[]; groups: DirectoryGroup[]; accounts: DirectoryAccount[] };

/** Everything the admin page shows: people by name, groups by name, accounts by username. */
export function readDirectory(): Directory {
	const personRows = db.select().from(people).orderBy(asc(people.fullName), asc(people.id)).all();
	const groupRows = db.select().from(peopleGroups).orderBy(asc(peopleGroups.name)).all();
	const memberships = db.select().from(peopleGroupMembers).all();
	const accountRows = db
		.select({ id: users.id, username: users.username, email: users.email, emoji: users.emoji, disabledAt: users.disabledAt })
		.from(users)
		.orderBy(asc(users.username))
		.all();

	const personOf = new Map(personRows.filter((person) => person.userId !== null).map((person) => [person.userId!, person.id]));
	const accountById = new Map(accountRows.map((account) => [account.id, account]));
	const ids = (rows: number[]) => rows.sort((a, b) => a - b);

	return {
		people: personRows.map((person) => {
			const account = person.userId === null ? undefined : accountById.get(person.userId);
			return {
				...person,
				groupIds: ids(memberships.filter((m) => m.personId === person.id).map((m) => m.groupId)),
				account: account ? { id: account.id, username: account.username } : null
			};
		}),
		groups: groupRows.map((group) => ({
			...group,
			personIds: ids(memberships.filter((m) => m.groupId === group.id).map((m) => m.personId))
		})),
		// The accounts to link and add from: a disabled one is neither (card
		// 2671). A person already linked to one still names it, above.
		accounts: accountRows.filter((account) => account.disabledAt === null).map((account) => ({
			id: account.id,
			username: account.username,
			email: account.email,
			emoji: account.emoji || '👤',
			personId: personOf.get(account.id) ?? null
		}))
	};
}
