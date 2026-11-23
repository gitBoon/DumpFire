/**
 * decision-flags.ts — the reads of a decision's objections and requests to talk (card 2684, R19; its plan review's
 * S-H1 and E-L1), as decision-questions.ts holds the reads of its questions.
 *
 * Stored flags are read tolerantly, for every read of them, the ruling's gate and the results revision among them: a
 * row is kept only where the write could have made it (`flagKept`), and is otherwise left out everywhere, so that a row
 * a restore planted neither shows nor blocks a ruling. The text is asked through the one predicate the write asks,
 * `flagTextProblem` in decision-record.ts, so that every text the write accepts, the reader keeps. Whenever a read
 * leaves a row out it logs one WARN line naming the decisions and how many, and never a reason, a reply or a name.
 *
 * The caps on raising a flag count raw rows, not these reads (R5), so a planted row cannot be used to get past one.
 *
 * Reads alone. Here rather than in decision-record.ts because the WARN line writes to the system log: the record
 * module's functions are each read by tests/check-at-the-write.test.ts as a record write where they reach any write,
 * and a read of flags is not one.
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { db } from './db';
import { decisionFlags, decisionParticipants, decisions, type DecisionFlag } from './db/schema';
import { flagTextProblem, IDS_AT_ONCE } from './decision-record';
import { createLogger } from './logger';
import { FLAG_KINDS, FLAG_TEXT_RULES, REPLY_TEXT_RULE, type FlagKind } from '$lib/decision-rules';

const log = createLogger('DECISIONS');

/**
 * A stored flag, the decision its participant row is of (null where there is no such row), and its own decision's
 * current version (null where there is no such decision), as one read gives them.
 */
type StoredFlag = { flag: DecisionFlag; placeDecisionId: number | null; currentVersion: number | null };

const storedFlagColumns = { flag: decisionFlags, placeDecisionId: decisionParticipants.decisionId, currentVersion: decisions.currentVersion };

/** The ways in a flag is written by (card 2684, R3): signed in, or by personal link. */
const FLAG_VIAS: readonly unknown[] = ['session', 'link'];

/**
 * Whether a stored flag is one the write could have made (card 2684, R19; code review C-S-L3): its kind one of
 * `FLAG_KINDS`, its `via` `session` or `link`, its version 1 to its decision's current version, its participant row of
 * the same decision, its reason text that passes `flagTextProblem` with its kind's rule (so an objection with an empty
 * reason is left out), and its reply null, or text that passes it with `REPLY_TEXT_RULE` with `replied_at` set and a
 * replier's name kept.
 */
function flagKept({ flag, placeDecisionId, currentVersion }: StoredFlag): boolean {
	if (placeDecisionId === null || placeDecisionId !== flag.decisionId) return false;
	if (!(FLAG_KINDS as readonly unknown[]).includes(flag.kind)) return false;
	if (!FLAG_VIAS.includes(flag.via)) return false;
	if (currentVersion === null || !Number.isInteger(flag.versionNumber) || flag.versionNumber < 1 || flag.versionNumber > currentVersion) return false;
	if (typeof flag.reason !== 'string' || flagTextProblem(flag.reason, FLAG_TEXT_RULES[flag.kind as FlagKind]) !== null) return false;
	if (flag.reply === null) return true;
	return (
		typeof flag.reply === 'string' &&
		flagTextProblem(flag.reply, REPLY_TEXT_RULE) === null &&
		typeof flag.repliedAt === 'string' &&
		typeof flag.repliedByName === 'string' &&
		flag.repliedByName !== ''
	);
}

/** The flags of `rows` that `flagKept` keeps, in their order; where any is left out, one WARN line naming the decisions and how many. */
function keptFlags(rows: readonly StoredFlag[]): DecisionFlag[] {
	const kept: DecisionFlag[] = [];
	const dropped = new Set<number>();
	let count = 0;
	for (const row of rows) {
		if (flagKept(row)) kept.push(row.flag);
		else {
			count++;
			dropped.add(row.flag.decisionId);
		}
	}
	if (count > 0) {
		const ids = [...dropped].sort((a, b) => a - b).join(', ');
		log.warn(`${count} stored objection or request-to-talk row(s) of decision(s) ${ids} could not have been written here, and were left out`);
	}
	return kept;
}

/** The decision's flags the write could have made, oldest first (card 2684, R19). */
export function flagsOf(decisionId: number): DecisionFlag[] {
	return keptFlags(
		db
			.select(storedFlagColumns)
			.from(decisionFlags)
			.leftJoin(decisionParticipants, eq(decisionParticipants.id, decisionFlags.participantId))
			.leftJoin(decisions, eq(decisions.id, decisionFlags.decisionId))
			.where(eq(decisionFlags.decisionId, decisionId))
			.orderBy(asc(decisionFlags.id))
			.all()
	);
}

/**
 * The flags each participant raised that the write could have made, oldest first, by participant id (`flagsOf` for
 * many, R19), in as few queries as `IDS_AT_ONCE` allows and one WARN line at most. One with none is not in the map.
 */
export function flagsOfParticipants(participantIds: readonly number[]): Map<number, DecisionFlag[]> {
	const unique = [...new Set(participantIds)];
	const rows: StoredFlag[] = [];
	for (let from = 0; from < unique.length; from += IDS_AT_ONCE) {
		rows.push(
			...db
				.select(storedFlagColumns)
				.from(decisionFlags)
				.leftJoin(decisionParticipants, eq(decisionParticipants.id, decisionFlags.participantId))
				.leftJoin(decisions, eq(decisions.id, decisionFlags.decisionId))
				.where(inArray(decisionFlags.participantId, unique.slice(from, from + IDS_AT_ONCE)))
				.orderBy(asc(decisionFlags.id))
				.all()
		);
	}
	const found = new Map<number, DecisionFlag[]>();
	for (const flag of keptFlags(rows)) found.set(flag.participantId, [...(found.get(flag.participantId) ?? []), flag]);
	return found;
}
