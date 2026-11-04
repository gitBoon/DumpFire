/**
 * people-shape.ts — a person and a group as an API key is answered them
 * (card 2681), kept apart from the people service so that any module may
 * shape one: the people service's v1 answers, and card 2682's decisions API,
 * which hands a key the people of a decision's picker.
 *
 * Built field by field, so that neither a person's address nor their account
 * id can be spread in (plan D4), and marked `untrusted`, as names, job titles
 * and descriptions are text others wrote (D6). The ids in each answer are
 * sorted, so that what a write answers and what a list answers agree (the
 * code review's F4). It reads and writes nothing.
 */
import type { PeopleGroup, Person } from './db/schema';

/** A person as an API key is answered one: no address and no account id, the ids of their groups, and `untrusted`. */
export type KeyPerson = {
	id: number;
	fullName: string;
	jobTitle: string;
	status: string;
	leftAt: string | null;
	createdBy: number | null;
	createdAt: string;
	updatedAt: string;
	groupIds: number[];
	untrusted: true;
};

/** A group as an API key is answered one: the row, the ids of its people, and `untrusted`. */
export type KeyGroup = {
	id: number;
	name: string;
	description: string;
	createdAt: string;
	personIds: number[];
	untrusted: true;
};

/** The ids, smallest first, in a list of their own. */
function sorted(ids: readonly number[]): number[] {
	return [...ids].sort((a, b) => a - b);
}

/** A person as a key is answered one, with the ids of their groups, sorted. */
export function keyPerson(row: Person, groupIds: readonly number[]): KeyPerson {
	return {
		id: row.id,
		fullName: row.fullName,
		jobTitle: row.jobTitle,
		status: row.status,
		leftAt: row.leftAt,
		createdBy: row.createdBy,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		groupIds: sorted(groupIds),
		untrusted: true
	};
}

/** A group as a key is answered one, with the ids of its people, sorted. */
export function keyGroup(row: PeopleGroup, personIds: readonly number[]): KeyGroup {
	return { id: row.id, name: row.name, description: row.description, createdAt: row.createdAt, personIds: sorted(personIds), untrusted: true };
}
