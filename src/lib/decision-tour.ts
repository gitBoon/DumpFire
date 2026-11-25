/**
 * decision-tour.ts — the guided tour of decision records (card 3070, the plan
 * docs/planning/card-3070-decision-tour.md): the presenter's own example
 * decision, cleaned and checked, and everything the tour's ten stops show of
 * it. Pure, with no DOM and no storage, so the page and the tests share it.
 *
 * Ported from the owner-seen standalone page (its `clean`, `problems`,
 * `derive`, `values` and list builders), with the app's own words where a
 * screen copies a real one (`decision-words.ts`, `decision-readiness.ts`, the
 * decision pages). Nothing here is read from or written to the server: the
 * responses and results are made up from the people and options entered, and
 * the page marks them as example responses.
 */
import { CLOSES_WITHIN_DAYS } from '$lib/decision-readiness';
import { decisionWaitLine, objectionsUnansweredWords, PARTICIPATION_ROLE_WORDS, rulingWords, talksConfirmWords, WITHHELD } from '$lib/decision-words';

/**
 * The browser storage key the page keeps the details under (ruling 5): in
 * `sessionStorage` as it is where the page knows no account, and in
 * `localStorage` with the account's id after it (`tourStorageKey`), so that
 * two people on one browser never see each other's example (code review).
 */
export const TOUR_STORAGE_KEY = 'dumpfire-decision-tour';

/** The `localStorage` key for the signed-in account `userId`. */
export const tourStorageKey = (userId: number) => `${TOUR_STORAGE_KEY}:${userId}`;

/** The furthest ahead a closing date may be, as the editor's (`CLOSES_WITHIN_DAYS`). */
export const TOUR_CLOSES_WITHIN_DAYS = CLOSES_WITHIN_DAYS;

/** How many stops follow the setup form. */
export const TOUR_STOPS = 10;

/** The most characters each field keeps. */
export const TOUR_LIMITS = { title: 160, question: 400, board: 80, option: 120, name: 80, group: 60 } as const;

/** The most options and participants the form offers. */
export const TOUR_MAX_OPTIONS = 4;
export const TOUR_MAX_PEOPLE = 5;

const LETTERS = ['A', 'B', 'C', 'D'] as const;

/** Which option each responder chose, in turn, as an index into the options (wrapped to how many there are). */
const PATTERN = [1, 0, 1, 2, 1, 3] as const;

export type TourRole = 'consulted' | 'informed';
export type TourPerson = { name: string; role: TourRole; group: string };
export type TourDetails = {
	title: string;
	question: string;
	board: string;
	decider: string;
	/** The closing date, `YYYY-MM-DD`; '' where none or not a date. */
	closes: string;
	options: string[];
	people: TourPerson[];
};

/** A problem with the details: the id of the field it is about, and what to do. */
export type DetailProblem = { field: string; message: string };

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A string with its runs of white space made one space, trimmed and cut at `max`; '' for anything else. */
function str(value: unknown, max: number): string {
	return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** A `YYYY-MM-DD` date that exists: one that reads back as itself, so 2026-02-31 is not one. */
function isDate(value: unknown): value is string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const at = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

/** `iso` moved by `days`, as `YYYY-MM-DD`, in UTC. */
export function addDays(iso: string, days: number): string {
	const at = new Date(`${iso}T00:00:00Z`);
	at.setUTCDate(at.getUTCDate() + days);
	return at.toISOString().slice(0, 10);
}

/** Today in UTC, as `YYYY-MM-DD`. */
export const todayIso = () => new Date().toISOString().slice(0, 10);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Ann", "Ann and Bo", "Ann, Bo and Cy". */
function listNames(people: { name: string }[]): string {
	const names = people.map((person) => person.name);
	if (names.length < 2) return names.join('');
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ─── The details ─────────────────────────────────────────────────────────────

/**
 * The details as the tour uses them, from whatever was typed or stored: each
 * field trimmed and cut at its limit, blank options and nameless people
 * dropped, at most four options and five people, a role other than
 * `informed` read as `consulted`. Null for anything that is not an object.
 */
export function cleanDetails(raw: unknown): TourDetails | null {
	if (!raw || typeof raw !== 'object') return null;
	const s = raw as Record<string, unknown>;
	return {
		title: str(s.title, TOUR_LIMITS.title),
		question: str(s.question, TOUR_LIMITS.question),
		board: str(s.board, TOUR_LIMITS.board),
		decider: str(s.decider, TOUR_LIMITS.name),
		closes: isDate(s.closes) ? s.closes : '',
		options: (Array.isArray(s.options) ? s.options : [])
			.map((option) => str(option, TOUR_LIMITS.option))
			.filter(Boolean)
			.slice(0, TOUR_MAX_OPTIONS),
		people: (Array.isArray(s.people) ? s.people : [])
			.map((p): TourPerson | null => {
				if (!p || typeof p !== 'object') return null;
				const person = p as Record<string, unknown>;
				return {
					name: str(person.name, TOUR_LIMITS.name),
					role: person.role === 'informed' ? 'informed' : 'consulted',
					group: str(person.group, TOUR_LIMITS.group)
				};
			})
			.filter((p): p is TourPerson => p !== null && p.name !== '')
			.slice(0, TOUR_MAX_PEOPLE)
	};
}

/**
 * What stops the tour starting, each with the field it is about, in the
 * form's order. With `today`, the closing date must be after it and at most
 * `CLOSES_WITHIN_DAYS` ahead (the form's Start); without, as for details
 * read back from storage, any date passes, so a reload the day after closing
 * keeps the tour. The role problem names the first participant's select;
 * the page moves it to the first row with a name typed.
 */
export function detailProblems(d: TourDetails, today?: string): DetailProblem[] {
	const problems: DetailProblem[] = [];
	const add = (field: string, message: string) => problems.push({ field, message });
	if (!d.title) add('setup-title', 'Give the decision a title.');
	if (!d.question) add('setup-question', 'Write the question and its background in a sentence or two.');
	if (!d.board) add('setup-board', 'Name the board the decision sits on.');
	if (!d.closes) add('setup-closes', 'Choose a closing date.');
	else if (today !== undefined && d.closes <= today)
		add('setup-closes', 'Choose a closing date after today: a decision cannot open with its closing time in the past.');
	else if (today !== undefined && d.closes > addDays(today, CLOSES_WITHIN_DAYS))
		add('setup-closes', `Choose a closing date at most a year (${CLOSES_WITHIN_DAYS} days) ahead: a later one is refused.`);
	if (d.options.length < 2) add(d.options.length === 0 ? 'setup-opt-1' : 'setup-opt-2', 'Enter at least two options.');
	if (!d.decider) add('setup-decider', 'Name the decider.');
	if (d.people.length < 2) add(d.people.length === 0 ? 'setup-p1-name' : 'setup-p2-name', 'Enter at least two participants.');
	else if (!d.people.some((p) => p.role === 'consulted'))
		add('setup-p1-role', 'Mark at least one participant as Consulted: a decision with nobody consulted cannot open.');
	return problems;
}

/** The example the form fills with: a support desk's four-day week, closing 14 days after `today`. */
export function EXAMPLE_DETAILS(today: string): TourDetails {
	return {
		title: 'Move the support desk to a four-day week',
		question: 'The support desk runs Monday to Friday. Should we move to a four-day week, and if so, how do we keep Friday covered?',
		board: 'Customer Support',
		decider: 'Priya Natarajan',
		closes: addDays(today, 14),
		options: ['Four ten-hour days, Monday to Thursday', 'A staggered four-day rota that covers all five days', 'Keep the five-day week'],
		people: [
			{ name: 'Tom Ellery', role: 'consulted', group: 'Tier 1 Support' },
			{ name: 'Aisha Bello', role: 'consulted', group: 'Tier 1 Support' },
			{ name: 'Dan Okafor', role: 'consulted', group: 'Tier 2 Support' },
			{ name: 'Mia Chen', role: 'consulted', group: '' },
			{ name: 'Rob Hale', role: 'informed', group: 'Finance' }
		]
	};
}

// ─── What the tour shows ─────────────────────────────────────────────────────

export type TourOption = { index: number; letter: string; title: string; count: number };

/** A consulted person and their example response, an option's index, or null for none (cut off). */
export type TourResponse = { person: TourPerson; option: number | null };

export type TourGroup = { name: string; none: boolean; consulted: number; responded: number; votes: number[]; most: string };

export type ReleaseRow = { letter: string; title: string; shown: string; withheld: boolean };

/** The release preview: refused under 3 answers, or each option's figure with the number who answered. */
export type ReleasePreview = { refused: true } | { refused: false; rows: ReleaseRow[]; answered: string };

export type Tour = {
	details: TourDetails;
	options: TourOption[];
	consulted: TourPerson[];
	informed: TourPerson[];
	/** Every consulted person, in order, with their example response. */
	responses: TourResponse[];
	/** How many consulted people answered. */
	answered: number;
	/** The consulted people who did not answer, and are cut off by the early ruling. */
	cutOff: TourPerson[];
	chosen: TourOption;
	mostOverall: string;
	/** Named groups first, in the order met, then No group. */
	groups: TourGroup[];
	hasGroups: boolean;
	firstConsulted: TourPerson;
	asker: TourPerson;
	talker: TourPerson;
	objector: TourPerson;
	/** The first consulted person's example choice, an option's index, or null. */
	firstChoice: number | null;
	openedDay: string;
	/** When the invitations went, as a page shows a moment: `YYYY-MM-DD 09:15 UTC`. */
	invitedAt: string;
	closesText: string;
	/** When the reminder is due, or null where none is sent: closing less than 25 hours after the invitations. */
	reminderAt: string | null;
	record: { at: string; what: string }[];
	release: ReleasePreview;
	/** The words each stop prints. */
	words: {
		warnLine: string;
		openConfirm: string;
		openButton: string;
		totalsCaption: string;
		totalsLine: string;
		objectionsNote: string;
		talksConfirm: string;
		cutOff: string;
		ruledBanner: string;
		blockedTip: string;
		pdfBy: string;
		pdfByDecider: string;
		earlyLine: string;
		reason: string;
		personRecord: string[];
		apiCan: string[];
		apiPerson: string[];
		webhookJson: string;
		apiCalls: string;
	};
};

/** The options most chosen, by letter: "B", "A, B (tied)", or "–" for none. */
function mostOf(counts: number[]): string {
	const max = Math.max(0, ...counts);
	if (max === 0) return '–';
	const top = counts.flatMap((count, i) => (count === max ? [LETTERS[i]] : []));
	return top.length === 1 ? top[0] : `${top.join(', ')} (tied)`;
}

/**
 * Everything the stops show, from valid details (`detailProblems` without a
 * date finds none) and today's date. The example responses follow a fixed
 * pattern over the options; with three or more consulted, the last does not
 * answer, so the early ruling has someone to cut off.
 */
export function deriveTour(d: TourDetails, today: string): Tour {
	const options: TourOption[] = d.options.map((title, index) => ({ index, letter: LETTERS[index], title, count: 0 }));
	const consulted = d.people.filter((p) => p.role === 'consulted');
	const informed = d.people.filter((p) => p.role === 'informed');
	const cut = consulted.length >= 3 ? 1 : 0;
	const answeredCount = consulted.length - cut;

	const responses: TourResponse[] = consulted.map((person, i) => {
		if (i >= answeredCount) return { person, option: null };
		const option = PATTERN[i % PATTERN.length] % options.length;
		options[option].count++;
		return { person, option };
	});
	const cutOff = responses.filter((r) => r.option === null).map((r) => r.person);

	const counts = options.map((o) => o.count);
	const maxCount = Math.max(...counts);
	const chosen = options.find((o) => o.count === maxCount) ?? options[0];

	const byKey = new Map<string, TourGroup>();
	for (const r of responses) {
		const key = r.person.group ? `g:${r.person.group}` : 'none';
		let group = byKey.get(key);
		if (!group) {
			group = { name: r.person.group || 'No group', none: !r.person.group, consulted: 0, responded: 0, votes: options.map(() => 0), most: '' };
			byKey.set(key, group);
		}
		group.consulted++;
		if (r.option !== null) {
			group.responded++;
			group.votes[r.option]++;
		}
	}
	const groups = [...byKey.values()].filter((g) => !g.none);
	const noGroup = byKey.get('none');
	if (noGroup) groups.push(noGroup);
	for (const g of groups) g.most = mostOf(g.votes);

	const first = consulted[0];
	const objector = informed[0] ?? consulted[consulted.length > 1 ? 1 : 0];
	let opened = addDays(d.closes, -10) < today ? today : addDays(d.closes, -10);
	if (opened >= d.closes) opened = addDays(d.closes, -1);
	const nextDay = addDays(opened, 1) < d.closes ? addDays(opened, 1) : opened;

	// The reminder (card 2685): about a day before closing, never within a day of the invitation, and none at all for a
	// decision that closes less than 25 hours after it was opened.
	const HOUR = 3_600_000;
	const invited = Date.parse(`${opened}T09:15:00Z`);
	const closing = Date.parse(`${d.closes}T17:00:00Z`);
	const shownAt = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
	const reminderAt = closing - invited < 25 * HOUR ? null : shownAt(Math.max(closing - 24 * HOUR, invited + 24 * HOUR));

	const told = (p: TourPerson) => (p.role === 'informed' ? `${p.name} told of the decision, to keep them informed` : `Invitation delivered to ${p.name}`);
	const record = [
		{ at: `${opened} 09:14`, what: `Opened, by ${d.decider}` },
		...d.people.slice(0, 2).map((p) => ({ at: `${opened} 09:14`, what: `Included ${p.name} as ${PARTICIPATION_ROLE_WORDS[p.role]}` })),
		{ at: `${opened} 09:15`, what: told(d.people[0]) },
		...(answeredCount > 0 ? [{ at: `${nextDay} 11:40`, what: `${responses[0].person.name} responded (example)` }] : [])
	];

	// The release (decision 10): refused under 3 answers; a count of 1 or 2, or within 2 of everyone who answered, withheld,
	// and the number who answered withheld whenever any figure is.
	let release: ReleasePreview;
	if (answeredCount < 3) release = { refused: true };
	else {
		const rows = options.map((o) => {
			const withheld = o.count === 1 || o.count === 2 || answeredCount - o.count <= 2;
			return { letter: o.letter, title: o.title, shown: withheld ? WITHHELD : String(o.count), withheld };
		});
		release = { refused: false, rows, answered: rows.some((r) => r.withheld) ? WITHHELD : String(answeredCount) };
	}

	const last = options[options.length - 1];
	const mailed = `Every participant of "${d.title}" is mailed now: ${plural(d.people.length, 'person', 'people')}.`;
	// The readability check's words for an option with no commercial note (`checkContent`).
	const warnLine = `Option ${options.length}, "${last.title}", has no commercial note`;
	const firstResponse = responses[0]?.option ?? null;
	const letters = options.map((o) => o.letter).join(', ');
	// Where the top count is shared, the first of them is chosen, and the reason says so.
	const level = options.filter((o) => o.count === maxCount);
	const reason =
		level.length > 1
			? `Options ${listNames(level.map((o) => ({ name: o.letter })))} were level; Option ${chosen.letter} was chosen, and the objection raised has been answered.`
			: `Option ${chosen.letter} had the most support, and the objection raised has been answered.`;

	return {
		details: d,
		options,
		consulted,
		informed,
		responses,
		answered: answeredCount,
		cutOff,
		chosen,
		mostOverall: mostOf(counts),
		groups,
		hasGroups: consulted.some((p) => p.group !== ''),
		firstConsulted: first,
		asker: first,
		talker: first,
		objector,
		firstChoice: firstResponse,
		openedDay: opened,
		invitedAt: shownAt(invited),
		closesText: `${d.closes} 17:00 UTC`,
		reminderAt,
		record,
		release,
		words: {
			warnLine,
			// Open's confirmation as the editor gives it, warnings and all (`DecisionActions`).
			openConfirm: `${mailed} Still to look at: ${warnLine}.`,
			openButton: 'Open with 1 warning',
			// The results table's caption (`ResultsView`).
			totalsCaption: `Round 1: ${answeredCount} responded`,
			totalsLine: `${plural(consulted.length, 'person', 'people')} consulted. Most chosen: ${mostOf(counts)}.`,
			objectionsNote: objectionsUnansweredWords(1),
			talksConfirm: talksConfirmWords(1),
			// The ruling form's early note (`RulingForm`).
			cutOff:
				cutOff.length > 0
					? `The decision is still open: ruling now is early, and cuts off these people who have not responded: ${listNames(cutOff)}.`
					: 'The decision is still open: ruling now is early.',
			ruledBanner: rulingWords({ label: chosen.letter, title: chosen.title, noneOfThese: false, ruledByName: d.decider }),
			blockedTip: decisionWaitLine({ title: d.title, shownStatus: 'awaiting_ruling' }),
			pdfBy: `downloaded by ${first.name} · ${d.closes}`,
			pdfByDecider: `${d.decider} · ${d.closes}`,
			// The ruling's Early and Cut off, as the results page gives them (`ResultsView`).
			earlyLine: `Early: Yes: ruled while the decision was open${cutOff.length > 0 ? `. Cut off: ${cutOff.map((p) => p.name).join(', ')}` : ''}`,
			reason,
			personRecord: [
				`Consulted on "${d.title}", included ${opened}`,
				firstResponse !== null ? `Responded: Option ${LETTERS[firstResponse]} (example)` : 'No response yet',
				'Asked to talk to the decider: No outcome recorded yet',
				'Invited, seen, responded'
			],
			apiCan: [
				`Read the register, and create a draft of "${d.title}" on ${d.board}, a board it can edit`,
				`Write and edit its text, its options (${letters}) and its survey questions`,
				`Choose the participants (${listNames(d.people)}) and ${d.decider} as decider, while it has never been opened`,
				'Edit its text once it is open',
				`Extend it while it is open, to a later time only, when the key belongs to ${d.decider}, the decider`,
				'Withdraw or delete it while it has never been opened',
				'Supersede it with a new draft once it is ruled',
				'Ask a question as its own participant, and draft an answer that a person publishes',
				'Read its results and record, as the decider or an administrator',
				// A draft cannot be linked (`requireTransition`'s linkCard).
				'Once it is open: link card #1042 as "waits" or "relates", and unlink it'
			],
			apiPerson: [
				'Open, Re-publish, Send me a dry run and Resend: each mails people',
				'Close, and reopening a closed decision with Extend',
				`Responding and answering survey questions: ${listNames(consulted)}`,
				'Objecting and asking to talk',
				`Ruling and releasing the results: ${d.decider}`,
				"Publishing or replacing an agent's answer",
				'Once opened: participants, decider, Withdraw and Delete',
				'Downloading either PDF'
			],
			webhookJson: JSON.stringify(
				{
					event: 'decision.ruled',
					timestamp: `${d.closes}T14:02:11.000Z`,
					boardId: 7,
					data: { decisionId: 48, action: 'decision_ruled', source: 'ui', title: d.title, status: 'ruled' }
				},
				null,
				2
			),
			apiCalls: [
				'POST  /api/v1/boards/7/decisions',
				JSON.stringify({ title: d.title }),
				'',
				'PATCH /api/v1/decisions/48               title, closesAt, voteMode, content',
				'PUT   /api/v1/decisions/48/participants',
				'PUT   /api/v1/decisions/48/decider',
				'',
				'POST  /api/v1/decisions/48/open          404: a person opens it',
				'',
				'(once a person has opened it)',
				'PUT   /api/v1/decisions/48/cards/1042    { "relation": "waits" }'
			].join('\n')
		}
	};
}
