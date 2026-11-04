/**
 * decision-register-types.ts — what the register, a person's record and a
 * decision's record view are given (card 2680, decisions 2, 9 and 16). Types,
 * and the two fixed lists the register's query is read by (`REGISTER_TABS`,
 * `SHOWN_STATUSES`, code review F6), with no other code, so the pages and
 * components the browser loads can name them without reaching into
 * `$lib/server`, and the page and the server read one list each.
 *
 * Each type is an allowlist: a field not named here is not given. None holds
 * an account id, and an address only in an administrator's person record. A
 * board is named by its current name and id only to a caller who can open
 * it; anyone else is given the name it had when the decision was made, with
 * no id (S1).
 */
import type { QuestionView, ShownStatus } from '$lib/decision-view-types';
import type { Stamp } from '$lib/timestamps';

// ─── The register (decisions 1 to 8) ─────────────────────────────────────────

/** The register's tabs: waiting for my response, waiting on me, open, ruled and all. */
export type RegisterTab = 'waiting-response' | 'waiting-ruling' | 'open' | 'ruled' | 'all';

/** The register's tabs in the order the page draws them: `registerQueryOf` reads `tab` by this list (code review F6). */
export const REGISTER_TABS: readonly RegisterTab[] = ['waiting-response', 'waiting-ruling', 'open', 'ruled', 'all'];

/** Every status a reader is shown, in the order the status filter lists them: `registerQueryOf` reads `status` by this list (F6). */
export const SHOWN_STATUSES: readonly ShownStatus[] = ['draft', 'open', 'awaiting_ruling', 'ruled', 'superseded', 'withdrawn'];

/**
 * The register's filters, each read by allow-list (`registerQueryOf`,
 * decision 7): null where it was not sent, or was dropped as malformed on a
 * page. `tab` null is the default tab; `status` is read on All alone.
 */
export type RegisterQuery = {
	tab: RegisterTab | null;
	status: ShownStatus | null;
	board: number | null;
	person: number | null;
	who: string | null;
	q: string | null;
	before: number | null;
};

/**
 * A decision's board as a list names it (S1): an accessible board by its id
 * and current name; any other by the name it had when the decision was made,
 * with no id; a deleted one by that name, `gone`.
 */
export type ListedBoard = { id: number | null; name: string; gone: boolean };

/**
 * One row of the register (decision 2). No participant's name, no count of
 * anyone, no response, no ruling moment, no "early" or "against", no
 * `updatedAt`, no account id and no address.
 */
export type RegisterRow = {
	id: number;
	title: string;
	shownStatus: ShownStatus;
	board: ListedBoard;
	deciderName: string | null;
	/** Null where the caller's only role on the decision is participant. */
	authorName: string | null;
	/** Null once ruled or superseded (`listedStatusOf`). */
	closesAt: Stamp | null;
	openedAt: Stamp | null;
	/** The caller's own live participation, where they hold exactly one. */
	role: 'consulted' | 'informed' | null;
	/** Present only where it holds (D6): the caller's response is awaited, or their ruling. */
	waiting?: 'response' | 'ruling';
};

/** What the register's load gives. */
export type RegisterPage = {
	tab: RegisterTab;
	query: RegisterQuery;
	rows: RegisterRow[];
	/** The id to pass as `before` for the next page, or null on the last (and on the waiting tabs, which are unpaged). */
	next: number | null;
	/** How many rows each waiting tab holds, with the filters set. */
	counts: { waitingResponse: number; waitingRuling: number };
	/** A waiting tab holds more rows than it shows (`REGISTER_WAITING_MAX`). */
	capped: boolean;
	/** The accessible boards that hold a decision the caller may view, by current name. */
	boards: { id: number; name: string }[];
	/**
	 * The person select: the matches of `who` in the caller's scope, or the person already chosen; none otherwise. Named
	 * by the directory to an administrator and for the caller's own person; anyone else by the name the newest
	 * participation in their scope was given under (code review S2).
	 */
	people: { id: number; name: string }[];
	/** The caller's own person of the directory, for the "My record" link (code review F1); null where their account holds none. */
	myPersonId: number | null;
};

// ─── A person's record (decisions 9 to 15) ───────────────────────────────────

/** Which person record the caller is given. */
export type PersonAudience = 'admin' | 'decider' | 'self';

/**
 * The person as each audience is told of them: an administrator the
 * directory's name, job title, groups, address and status; a decider the
 * snapshot name and job title of the newest participation in their scope and
 * the status; the person themselves the directory's name and job title.
 */
export type PersonHeader = { name: string; jobTitle: string; groups?: string[]; email?: string; status?: 'active' | 'left' };

/**
 * One response as a person record shows it, replaced ones too: the option and
 * the scores and option comments by label, never by id, and how it was given
 * (`via`) to an administrator and a decider alone. `current`: no later
 * response replaced it.
 */
export type RecordResponse = {
	versionNumber: number;
	round: number;
	kind: 'vote' | 'abstain' | 'no_concerns';
	option: string | null;
	scores: Record<string, number> | null;
	optionComments: Record<string, string>;
	comment: string | null;
	via?: string;
	createdAt: Stamp;
	current: boolean;
};

/** One of a person's own events on their own record (decision 13): its kind, moment and version, and `seen`'s stage. No actor. */
export type OwnRecordEvent = { kind: string; at: Stamp; versionNumber: number | null; stage?: string };

/**
 * One event as the record view and an administrator's or decider's person
 * record show it (decision 16): its kind, moment and version, the
 * participant it names by their snapshot name, who did it by name and tree,
 * and its detail, projected through `RECORD_DETAIL` alone.
 */
export type RecordEntry = {
	kind: string;
	at: Stamp;
	versionNumber: number | null;
	participant: string | null;
	actor: { name: string; source: string };
	detail: Record<string, unknown>;
};

/** The decision a participation is on, as the register gives it. */
export type ParticipationDecision = { id: number; title: string; shownStatus: ShownStatus; board: ListedBoard; closesAt: Stamp | null };

/**
 * One participation on a person record (decision 9). `id` is the
 * participation's, for the record view's participant filter, to an
 * administrator and a decider alone. `moreEvents`: more events name it than
 * the 200 shown, which the record view holds.
 */
export type Participation<E> = {
	kind: 'full';
	id?: number;
	decision: ParticipationDecision;
	role: 'consulted' | 'informed';
	includedAt: Stamp;
	removedAt: Stamp | null;
	name: string;
	jobTitle: string;
	groups: string[];
	responses: RecordResponse[];
	questions: QuestionView[];
	concerns: { comment: string; createdAt: Stamp }[];
	events: E[];
	moreEvents: boolean;
};

/**
 * A participation on the person's own record of a decision they may no longer
 * view (decision 14, S2): when they were included and removed, their own
 * responses and concerns, and their own questions with the answers given up
 * to the removal. Nothing of the decision. `removedAt` null is a live row the
 * person may not view (two live rows on one account, say): the page says "A
 * decision you can no longer open", never "removed" (code review F4).
 */
export type RemovedParticipation = {
	kind: 'removed';
	includedAt: Stamp;
	removedAt: Stamp | null;
	responses: RecordResponse[];
	questions: QuestionView[];
	concerns: { comment: string; createdAt: Stamp }[];
	events: OwnRecordEvent[];
};

/** What a person record's load gives, by audience; `next` the id to pass as `before`, or null on the last page. */
export type PersonRecord =
	| { audience: 'admin' | 'decider'; person: PersonHeader; participations: Participation<RecordEntry>[]; next: number | null }
	| { audience: 'self'; person: PersonHeader; participations: (Participation<OwnRecordEvent> | RemovedParticipation)[]; next: number | null };

// ─── Card links (decisions 17 to 23) ─────────────────────────────────────────

/**
 * A card linked to a decision, as the decision page lists it (decision 18):
 * only on a board the viewer can open now, with no count of the rest, and
 * never who linked it.
 */
export type LinkedCardView = { id: number; title: string; boardId: number; boardName: string; archived: boolean };

/**
 * A decision linked to a card, as the card window lists it (decision 18):
 * only where the viewer may view it, with no count of the rest; the status
 * and closing time through `listedStatusOf`, the closing time null once
 * ruled.
 */
export type LinkedDecisionView = { id: number; title: string; shownStatus: ShownStatus; closesAt: Stamp | null; relation: string };

/** What linking answers (decision 21): a new link, a relation changed, or nothing written for a link that was there already. */
export type LinkOutcome = 'linked' | 'relation_changed' | 'unchanged';

// ─── The record view (decision 16) ───────────────────────────────────────────

/**
 * What the record view's load gives: the events oldest first, the participant
 * select, and the id to pass as `after`, or null. A participant carries
 * `personId`, for a link to their person record (code review F1), only where
 * they are a person of the directory still and the decision has been opened:
 * a draft's participants, and one by address alone, carry none.
 */
export type RecordPage = {
	decision: { id: number; title: string; shownStatus: ShownStatus };
	entries: RecordEntry[];
	participants: { id: number; name: string; personId?: number }[];
	participant: number | null;
	next: number | null;
};
