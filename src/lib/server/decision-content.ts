/**
 * decision-content.ts — a decision's working copy, read and kept (card 2676,
 * plan 4.5): its stored form, the strict reading of a body's content, the
 * title rule, which sections a save changed, the draft revision, option
 * labels, the options a re-publish adds and retires, the facts the
 * readability check is worked out from, and a decision's option and
 * participant rows as the service and the reads both take them (the code
 * review's C7). Card 2677 adds a published version's content read back
 * (`parseVersionContent`, F1), and shares the markdown field's rule
 * (`readMultiline`) and the closed-object check (`requireClosed`) with a
 * response's comments and keyed objects. Card 2679 adds the results revision
 * (`resultsRevisionOf`), which the ruling and the release ask, and a
 * superseding draft's content from the version ruled on (`workingFromVersion`).
 *
 * Plain functions with no caller, called by the decision services
 * (`decision-<area>-writes.ts`) inside their writes, and by the authoring
 * reads. Nothing here writes a row of
 * a decision; the revision's key is derived from the request form's, which
 * `request-tokens.ts` makes on its first use.
 *
 * The content is closed at every level (decision 8, R5): a key that is not
 * design 4.4's is a 400 naming its path, and so is each of the server's own
 * keys (`SERVER_KEYS`). A single-line field holds no character of
 * `UNPRINTABLE`; a markdown field holds none but tab, newline, carriage
 * return and U+200D, the joiner inside emoji sequences (D12). Every
 * direction control stays refused everywhere.
 */
import { createHmac } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from './db';
import {
	decisionOptions,
	decisionParticipants,
	people,
	peopleGroupMembers,
	peopleGroups,
	users,
	type Decision,
	type DecisionOption,
	type DecisionParticipant
} from './db/schema';
import { canEditBoard } from './board-access';
import { labelsInVersions, peopleById, snapshotOf } from './decision-record';
import { decisionLinkBase } from './decision-mail';
import { isSmtpConfigured } from './email';
import { UNPRINTABLE } from './logger';
import { asObject, readId, readList, readObjects, readText, type RequestBody } from './request-body';
import { purposeKey } from './request-tokens';
import { CHOSEN_KEYS, type AudienceFacts, type OpenFacts, type WorkingContent } from '$lib/decision-readiness';
import { DECISION_TITLE_MAX } from '$lib/decision-rules';
import type { Stamp } from '$lib/timestamps';

export type { WorkingContent } from '$lib/decision-readiness';

/** The working content without the keys only the server writes. */
export type ContentFields = Omit<WorkingContent, 'agentDrafted' | 'reviewed' | 'lastLabel'>;

/** How much each field of the content may hold (decision 8). */
export const CONTENT_LIMITS = {
	/** `situation`, `unknowns`, `alreadyRuled`, `technicalDetail`: markdown. */
	longText: 20_000,
	/** `question`: one line. */
	question: 500,
	/** `ask`: markdown. */
	ask: 2_000,
	options: 20,
	optionTitle: 200,
	/** An option's `summary` and `commercial`: markdown. */
	optionText: 4_000,
	/** The items of an option's `pros` and of its `cons`. */
	listItems: 20,
	listItem: 500,
	audiences: 30,
	stories: 30,
	/** An audience's `heading` and a story's `title`: one line. */
	heading: 200,
	/** An audience's and a story's `body`: markdown. */
	body: 10_000,
	/** The whole, serialised. */
	bytes: 256 * 1024
} as const;

/** The keys of the working content that only the server writes: each is a 400 in a body. */
export const SERVER_KEYS = ['agentDrafted', 'reviewed', 'lastLabel'] as const;

/** The content's own text sections, each flagged under its own key (decision 9). */
const TEXT_SECTIONS = ['situation', 'question', 'ask', 'unknowns', 'alreadyRuled', 'technicalDetail'] as const;

/** The keys of the content, of an option, of an audience and of a story (design 4.4). */
const CONTENT_KEYS = [...TEXT_SECTIONS, 'options', 'audiences', 'stories'];
const OPTION_KEYS = ['optionId', 'title', 'summary', 'pros', 'cons', 'commercial'];
const AUDIENCE_KEYS = ['groupId', 'heading', 'body'];
const STORY_KEYS = ['title', 'body'];

/** What a markdown field may hold of `UNPRINTABLE`: tab, newline, carriage return and the zero-width joiner (D12). */
const MARKDOWN_ALLOWED = /[\t\n\r‍]/g;

/** The words for a field holding a character it may not, as `createDecision`'s for the title (decision 30). */
const unprintable = (path: string) => `${path} cannot hold control, direction or invisible characters`;

/** A JSON object: not null, and not a list. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The working content as it is stored, read tolerantly: a field missing or
 * of the wrong type is its empty value, an entry that is not an object is
 * left out, and a key that is none of design 4.4's is dropped.
 */
export function parseWorkingContent(json: string): WorkingContent {
	let read: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(json) as unknown;
		if (isRecord(parsed)) read = parsed;
	} catch {
		// Not JSON: the empty content.
	}
	const text = (value: unknown) => (typeof value === 'string' ? value : '');
	const texts = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
	const records = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);
	const reviewed: WorkingContent['reviewed'] = {};
	if (isRecord(read.reviewed)) {
		for (const [key, stampOf] of Object.entries(read.reviewed)) {
			if (isRecord(stampOf) && typeof stampOf.byUserId === 'number' && typeof stampOf.byName === 'string' && typeof stampOf.at === 'string') {
				reviewed[key] = { byUserId: stampOf.byUserId, byName: stampOf.byName, at: stampOf.at };
			}
		}
	}
	const agentDrafted: WorkingContent['agentDrafted'] = {};
	if (isRecord(read.agentDrafted)) for (const [key, flag] of Object.entries(read.agentDrafted)) if (flag === true) agentDrafted[key] = true;
	return {
		situation: text(read.situation),
		question: text(read.question),
		ask: text(read.ask),
		options: records(read.options).map((option) => ({
			...(typeof option.optionId === 'number' ? { optionId: option.optionId } : {}),
			title: text(option.title),
			summary: text(option.summary),
			pros: texts(option.pros),
			cons: texts(option.cons),
			commercial: text(option.commercial)
		})),
		audiences: records(read.audiences).map((audience) => ({
			groupId: typeof audience.groupId === 'number' ? audience.groupId : null,
			heading: text(audience.heading),
			body: text(audience.body)
		})),
		stories: records(read.stories).map((story) => ({ title: text(story.title), body: text(story.body) })),
		unknowns: text(read.unknowns),
		alreadyRuled: text(read.alreadyRuled),
		technicalDetail: text(read.technicalDetail),
		agentDrafted,
		reviewed,
		lastLabel: typeof read.lastLabel === 'string' ? read.lastLabel : null
	};
}

/**
 * A published version's content (card 2677, decision 16, F1): what
 * `versionContent` in decision-lifecycle-writes.ts copied, read back tolerantly, as
 * `parseWorkingContent` reads the working copy. It keeps what a version holds
 * and the working copy does not: each option's `optionId` and `label`, and
 * each review stamp as `{ byName, at }`. A server read: nothing it keeps
 * reaches a page whole.
 */
export type VersionContent = {
	situation: string;
	question: string;
	ask: string;
	unknowns: string;
	alreadyRuled: string;
	technicalDetail: string;
	options: { optionId: number; label: string; title: string; summary: string; pros: string[]; cons: string[]; commercial: string }[];
	audiences: { groupId: number | null; heading: string; body: string }[];
	stories: { title: string; body: string }[];
	agentDrafted: Record<string, true>;
	reviewed: Record<string, { byName: string; at: string }>;
};

/**
 * A version's content as it is stored, read tolerantly: a field missing or of
 * the wrong type is its empty value, an entry that is not an object is left
 * out, and so is an option with no id, and a key that is none of a version's
 * is dropped.
 */
export function parseVersionContent(json: string): VersionContent {
	let read: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(json) as unknown;
		if (isRecord(parsed)) read = parsed;
	} catch {
		// Not JSON: the empty content.
	}
	const text = (value: unknown) => (typeof value === 'string' ? value : '');
	const texts = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
	const records = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);
	const reviewed: VersionContent['reviewed'] = {};
	if (isRecord(read.reviewed)) {
		for (const [key, stampOf] of Object.entries(read.reviewed)) {
			if (isRecord(stampOf) && typeof stampOf.byName === 'string' && typeof stampOf.at === 'string') reviewed[key] = { byName: stampOf.byName, at: stampOf.at };
		}
	}
	const agentDrafted: VersionContent['agentDrafted'] = {};
	if (isRecord(read.agentDrafted)) for (const [key, flag] of Object.entries(read.agentDrafted)) if (flag === true) agentDrafted[key] = true;
	return {
		situation: text(read.situation),
		question: text(read.question),
		ask: text(read.ask),
		unknowns: text(read.unknowns),
		alreadyRuled: text(read.alreadyRuled),
		technicalDetail: text(read.technicalDetail),
		options: records(read.options)
			.filter((option) => typeof option.optionId === 'number')
			.map((option) => ({
				optionId: option.optionId as number,
				label: text(option.label),
				title: text(option.title),
				summary: text(option.summary),
				pros: texts(option.pros),
				cons: texts(option.cons),
				commercial: text(option.commercial)
			})),
		audiences: records(read.audiences).map((audience) => ({
			groupId: typeof audience.groupId === 'number' ? audience.groupId : null,
			heading: text(audience.heading),
			body: text(audience.body)
		})),
		stories: records(read.stories).map((story) => ({ title: text(story.title), body: text(story.body) })),
		agentDrafted,
		reviewed
	};
}

/** A key of an object, named in a refusal only when it is a plain word. */
const named = (key: string) => (/^[A-Za-z0-9_]{1,40}$/.test(key) ? key : null);

/**
 * A 400 for any key of `entry` that is not one of `allowed`, naming its path
 * (`content.options[0]`, `scores`). It walks the keys in its own function, so
 * a body's keyed object is refused here and never walked by its caller (card
 * 2677, R9).
 */
export function requireClosed(entry: Record<string, unknown>, allowed: readonly string[], path: string, what: string): void {
	for (const key of Object.keys(entry)) {
		if (allowed.includes(key)) continue;
		const name = named(key);
		error(400, name === null ? `${path} holds a field that is not a field of ${what}` : `${path}.${name} is not a field of ${what}`);
	}
}

/** A single-line field at `path`: text, trimmed, up to `max`, with no character of `UNPRINTABLE`. Not sent, it is empty. */
function singleLine(value: unknown, path: string, max: number): string {
	const text = readText({ [path]: value }, path, { trim: true, max }) ?? '';
	if (UNPRINTABLE.test(text)) error(400, unprintable(path));
	return text;
}

/**
 * A field of several lines at `path`, a markdown field's or a response's
 * comment (card 2677, decision 11): text up to `max`, trimmed first when
 * `trim` is given, holding of `UNPRINTABLE` only what `MARKDOWN_ALLOWED` lets
 * through. Not sent, it is empty.
 */
export function readMultiline(value: unknown, path: string, max: number, opts: { trim?: boolean } = {}): string {
	const text = readText({ [path]: value }, path, { max, trim: opts.trim === true }) ?? '';
	if (UNPRINTABLE.test(text.replace(MARKDOWN_ALLOWED, ''))) error(400, unprintable(path));
	return text;
}

/** A list of single-line items at `path`, up to `CONTENT_LIMITS.listItems`, each up to `listItem`, the empty ones dropped. */
function itemList(value: unknown, path: string): string[] {
	const items = readList({ [path]: value }, path, { max: CONTENT_LIMITS.listItems }) ?? [];
	return items.map((item, index) => singleLine(item, `${path}[${index}]`, CONTENT_LIMITS.listItem)).filter((item) => item !== '');
}

/**
 * The body's `content`, read strictly (decision 8, R5): an object holding
 * only design 4.4's keys, at every level, each field to its rule and limit,
 * and the whole up to 256 KB serialised. A field not sent is empty. Each
 * refusal is a 400 naming the field.
 *
 * An option's `optionId` is named once at most; that it is a live option of
 * this decision is the write's to ask. An audience's `groupId` is an id or
 * null, and a new one, not held by an audience of `stored`, must be a group
 * (decision 24): one kept from `stored` whose group has since been deleted
 * is kept, so that re-saving does not fail.
 */
export function readContent(body: RequestBody, stored: WorkingContent): ContentFields {
	const content = asObject(body.content);
	if (content === undefined) error(400, body.content === undefined ? 'content is required' : 'content must be an object');
	for (const key of SERVER_KEYS) {
		if (Object.hasOwn(content, key)) error(400, `content.${key} is kept by the server: it cannot be sent`);
	}
	requireClosed(content, CONTENT_KEYS, 'content', "a decision's content");

	const seen = new Set<number>();
	const options = (readObjects(content, 'options', { max: CONTENT_LIMITS.options }) ?? []).map((entry, index) => {
		const path = `options[${index}]`;
		requireClosed(entry, OPTION_KEYS, `content.${path}`, 'an option');
		const optionId = readId({ [`${path}.optionId`]: entry.optionId }, `${path}.optionId`, {});
		if (optionId !== undefined) {
			if (seen.has(optionId)) error(400, `${path}.optionId ${optionId} is named twice`);
			seen.add(optionId);
		}
		return {
			...(optionId === undefined ? {} : { optionId }),
			title: singleLine(entry.title, `${path}.title`, CONTENT_LIMITS.optionTitle),
			summary: readMultiline(entry.summary, `${path}.summary`, CONTENT_LIMITS.optionText),
			pros: itemList(entry.pros, `${path}.pros`),
			cons: itemList(entry.cons, `${path}.cons`),
			commercial: readMultiline(entry.commercial, `${path}.commercial`, CONTENT_LIMITS.optionText)
		};
	});

	const kept = new Set(stored.audiences.map((audience) => audience.groupId).filter((id): id is number => id !== null));
	const audiences = (readObjects(content, 'audiences', { max: CONTENT_LIMITS.audiences }) ?? []).map((entry, index) => {
		const path = `audiences[${index}]`;
		requireClosed(entry, AUDIENCE_KEYS, `content.${path}`, 'an audience');
		return {
			groupId: readId({ [`${path}.groupId`]: entry.groupId }, `${path}.groupId`, { nullable: true }) ?? null,
			heading: singleLine(entry.heading, `${path}.heading`, CONTENT_LIMITS.heading),
			body: readMultiline(entry.body, `${path}.body`, CONTENT_LIMITS.body)
		};
	});
	const asked = [...new Set(audiences.map((audience) => audience.groupId).filter((id): id is number => id !== null && !kept.has(id)))];
	if (asked.length > 0) {
		const groups = new Set(db.select({ id: peopleGroups.id }).from(peopleGroups).where(inArray(peopleGroups.id, asked)).all().map((group) => group.id));
		audiences.forEach((audience, index) => {
			if (audience.groupId !== null && !kept.has(audience.groupId) && !groups.has(audience.groupId)) {
				error(400, `audiences[${index}].groupId ${audience.groupId} is not a group`);
			}
		});
	}

	const stories = (readObjects(content, 'stories', { max: CONTENT_LIMITS.stories }) ?? []).map((entry, index) => {
		const path = `stories[${index}]`;
		requireClosed(entry, STORY_KEYS, `content.${path}`, 'a user story');
		return { title: singleLine(entry.title, `${path}.title`, CONTENT_LIMITS.heading), body: readMultiline(entry.body, `${path}.body`, CONTENT_LIMITS.body) };
	});

	const fields: ContentFields = {
		situation: readMultiline(content.situation, 'situation', CONTENT_LIMITS.longText),
		question: singleLine(content.question, 'question', CONTENT_LIMITS.question),
		ask: readMultiline(content.ask, 'ask', CONTENT_LIMITS.ask),
		options,
		audiences,
		stories,
		unknowns: readMultiline(content.unknowns, 'unknowns', CONTENT_LIMITS.longText),
		alreadyRuled: readMultiline(content.alreadyRuled, 'alreadyRuled', CONTENT_LIMITS.longText),
		technicalDetail: readMultiline(content.technicalDetail, 'technicalDetail', CONTENT_LIMITS.longText)
	};
	if (Buffer.byteLength(JSON.stringify(fields), 'utf8') > CONTENT_LIMITS.bytes) error(400, 'content must be at most 256 KB');
	return fields;
}

/**
 * A decision's `title` (decision 25, F6): text, trimmed, 1 to 200 characters,
 * holding no control, direction or invisible character (card 2675, decision
 * 30). Required unless told otherwise; not sent, then, it is undefined.
 */
export function readTitle(body: RequestBody): string;
export function readTitle(body: RequestBody, opts: { required: boolean }): string | undefined;
export function readTitle(body: RequestBody, opts: { required: boolean } = { required: true }): string | undefined {
	const title = readText(body, 'title', { required: opts.required, trim: true, min: 1, max: DECISION_TITLE_MAX });
	if (title !== undefined && UNPRINTABLE.test(title)) error(400, 'title cannot hold control, direction or invisible characters');
	return title;
}

/** An option's text, to compare. */
const optionText = (option: WorkingContent['options'][number]) =>
	JSON.stringify([option.title, option.summary, option.pros, option.cons, option.commercial]);

/**
 * The sections of `after` that differ from `before` (decision 9), by the
 * keys a flag names: each text section, `options.<optionId>` for each option
 * whose text changed or that is new, and `audiences` and `stories` for each
 * list as a whole. Every option of `after` carries its id by now.
 */
export function changedSections(before: WorkingContent, after: ContentFields): string[] {
	const changed: string[] = TEXT_SECTIONS.filter((key) => before[key] !== after[key]);
	const was = new Map(before.options.filter((option) => option.optionId !== undefined).map((option) => [option.optionId!, option]));
	for (const option of after.options) {
		if (option.optionId === undefined) continue;
		const earlier = was.get(option.optionId);
		if (earlier === undefined || optionText(earlier) !== optionText(option)) changed.push(`options.${option.optionId}`);
	}
	if (JSON.stringify(before.audiences) !== JSON.stringify(after.audiences)) changed.push('audiences');
	if (JSON.stringify(before.stories) !== JSON.stringify(after.stories)) changed.push('stories');
	return changed;
}

/**
 * Every key a flag may name in this content: its text sections, each listed
 * option, the audiences and stories, and (card 2728) the title, participants
 * and decider.
 */
export function sectionKeysOf(content: WorkingContent): string[] {
	return [
		...TEXT_SECTIONS,
		...content.options.filter((option) => option.optionId !== undefined).map((option) => `options.${option.optionId}`),
		'audiences',
		'stories',
		...CHOSEN_KEYS
	];
}

/**
 * The stored working content `json` with `key` flagged as an agent's choice
 * and its review stamp removed (card 2728, D2): for a key's write to the
 * title, the participants or the decider. Every other key is kept as stored,
 * a missing one left missing, so the content reads exactly as before but for
 * the flag. Stored content that is not a JSON object is read as empty, as
 * `parseWorkingContent` reads it. Pure.
 */
export function withChosenFlag(json: string, key: (typeof CHOSEN_KEYS)[number]): string {
	let stored: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(json) as unknown;
		if (isRecord(parsed)) stored = parsed;
	} catch {
		// Not JSON: the empty content.
	}
	const flags = isRecord(stored.agentDrafted) ? stored.agentDrafted : {};
	const next: Record<string, unknown> = { ...stored, agentDrafted: { ...flags, [key]: true } };
	if (isRecord(stored.reviewed) && Object.hasOwn(stored.reviewed, key)) {
		const kept = { ...stored.reviewed };
		delete kept[key];
		next.reviewed = kept;
	}
	return JSON.stringify(next);
}

/** What the revision's key is derived for (`purposeKey`): no other value is made with it. */
const REVISION_PURPOSE = 'decision-revision';

/**
 * The draft revision (decision 10, R1): HMAC-SHA256, in hex, over what the
 * editor's writes change, keyed with `purposeKey('decision-revision')`, a key
 * derived from the server's own and never stored (the code review's C2), so
 * that holding it lets nobody test guesses at what it covers offline. The
 * decision's title, status, closing time, vote mode, working content, current
 * version and decider; every option row, retired ones too, by its id, label,
 * position and the versions it was added and retired in; and every
 * participant row, removed ones too, by its id, person, role and
 * `removed_at`. Rows are taken in id order, however they are handed in.
 *
 * Card 2706: never a delivery column, a participant's account or address, nor
 * the decision's `updated_at`. A Resend and an administrator's account or
 * address change write those alone, and no write that asks this revision
 * reads them as its caller saw them: each is read again at the write (the
 * mail at its send, `reachOf`; one live row per account; the account and
 * address writes' own guards). So they no longer refuse an editor's save over
 * nothing it edits, an administrator's included (D3). `updated_at` is still
 * stamped by them, for the board's list and every answer that shows it; every
 * other write that stamps it changes a column covered here. The results
 * revision still covers a participant's account and address, and since card
 * 2734 not `updated_at` either (`resultsRevisionOf`).
 */
export function revisionOf(decision: Decision, options: DecisionOption[], participants: DecisionParticipant[]): string {
	return createHmac('sha256', purposeKey(REVISION_PURPOSE)).update(JSON.stringify(coveredBy(decision, options, participants))).digest('hex');
}

/** Rows in id order, however they are handed in. */
const inOrder = <T extends { id: number }>(rows: T[]) => [...rows].sort((a, b) => a.id - b.id);

/** The decision columns both revisions cover. */
const decisionColumns = (decision: Decision) => [
	decision.title,
	decision.status,
	decision.closesAt,
	decision.voteMode,
	decision.workingContent,
	decision.currentVersion,
	decision.deciderUserId
];

/** The option rows both revisions cover. */
const optionColumns = (options: DecisionOption[]) =>
	inOrder(options).map((option) => [option.id, option.label, option.position, option.addedInVersion, option.retiredInVersion]);

/** What the draft revision covers (card 2706: no delivery column, and not `updated_at`). */
function coveredBy(decision: Decision, options: DecisionOption[], participants: DecisionParticipant[]) {
	return {
		decision: decisionColumns(decision),
		options: optionColumns(options),
		participants: inOrder(participants).map((row) => [row.id, row.personId, row.role, row.removedAt])
	};
}

/** What the results revision's key is derived for (`purposeKey`): no other value is made with it (card 2679, decision 8). */
const RESULTS_REVISION_PURPOSE = 'decision-results-revision';

/**
 * The results revision (card 2679, decision 8): HMAC-SHA256, in hex, keyed
 * with `purposeKey('decision-results-revision')`, over everything the draft
 * revision covers and, as before card 2706, each participant's account and
 * address (so that no ruling or release is made against a participant change
 * its caller has not seen), the moment the results were released, every
 * response id `responsesOf` gives (votes, abstentions
 * and no concerns, never a concern: their table is insert-only, so the set of
 * ids is the state), and every question's id, the moment it was answered,
 * the moment an agent's draft answer was published and whether its answer is
 * an agent's (card 2678, decision 11: publishing and replacing change which
 * questions are open, and the flag moves it for a replacement made in the
 * same second as the draft). So a response, a question
 * asked, answered, published or replaced, a change to a participant or a
 * release between reading the results and ruling on them moves it; a seen
 * event, a link issued, a Resend, a reminder, a mail outcome, a notice's
 * outcome or a concern does not. Keyed, as the draft
 * revision is, so that holding it lets nobody test guesses offline.
 *
 * Card 2734: never the decision's `updated_at`, which a Resend stamps alone.
 * Every other write that stamps it changes a column covered here in the same
 * write; the release's was the one that did not, so `results_released_at`
 * stands in its place (the plan's write-by-write table,
 * docs/planning/card-2734-results-revision-delivery.md, section 2).
 */
export function resultsRevisionOf(of: {
	decision: Decision;
	options: DecisionOption[];
	participants: DecisionParticipant[];
	responseIds: number[];
	questions: { id: number; answeredAt: string | null; answerReviewedAt: string | null; answerAgentDrafted: boolean }[];
}): string {
	// Built in place, in the shape it had before card 2706, `updated_at` replaced by `results_released_at` (card 2734).
	const covered = {
		decision: [...decisionColumns(of.decision), of.decision.resultsReleasedAt],
		options: optionColumns(of.options),
		participants: inOrder(of.participants).map((row) => [row.id, row.personId, row.role, row.userId, row.email, row.removedAt]),
		responses: [...of.responseIds].sort((a, b) => a - b),
		questions: inOrder(of.questions).map((question) => [question.id, question.answeredAt, question.answerReviewedAt, question.answerAgentDrafted])
	};
	return createHmac('sha256', purposeKey(RESULTS_REVISION_PURPOSE)).update(JSON.stringify(covered)).digest('hex');
}

/**
 * A superseding draft's working content (card 2679, decision 5): the content
 * of the version the old decision was ruled on, its text sections, options,
 * audiences and stories, each option under the id of its new row
 * (`optionIds`, old id to new; an option with no new row is left out), and its
 * agent flags with each `options.<old>` key renamed to `options.<new>`. No
 * review stamp is carried: a version holds none with an account id, and
 * `parseWorkingContent` would drop it anyway. Card 2728 (D6): nor the
 * `participants` or `decider` flag, as the new draft has no participants and
 * a decider the server chose; the `title` flag is carried, and
 * `supersedeDecision` drops or sets it by the title it gives. Pure.
 */
export function workingFromVersion(content: VersionContent, optionIds: ReadonlyMap<number, number>): WorkingContent {
	const agentDrafted: WorkingContent['agentDrafted'] = {};
	for (const key of Object.keys(content.agentDrafted)) {
		if (key === 'participants' || key === 'decider') continue;
		const option = /^options\.(\d+)$/.exec(key);
		if (option === null) agentDrafted[key] = true;
		else if (optionIds.has(Number(option[1]))) agentDrafted[`options.${optionIds.get(Number(option[1]))}`] = true;
	}
	return {
		situation: content.situation,
		question: content.question,
		ask: content.ask,
		options: content.options
			.filter((option) => optionIds.has(option.optionId))
			.map((option) => ({
				optionId: optionIds.get(option.optionId)!,
				title: option.title,
				summary: option.summary,
				pros: [...option.pros],
				cons: [...option.cons],
				commercial: option.commercial
			})),
		audiences: content.audiences.map((audience) => ({ groupId: audience.groupId, heading: audience.heading, body: audience.body })),
		stories: content.stories.map((story) => ({ title: story.title, body: story.body })),
		unknowns: content.unknowns,
		alreadyRuled: content.alreadyRuled,
		technicalDetail: content.technicalDetail,
		agentDrafted,
		reviewed: {},
		lastLabel: null
	};
}

/** Every option row of the decision, retired ones included. */
export function allOptionsOf(decisionId: number): DecisionOption[] {
	return db.select().from(decisionOptions).where(eq(decisionOptions.decisionId, decisionId)).all();
}

/** The decision's options not retired, in their order. */
export function liveOptionsOf(decisionId: number): DecisionOption[] {
	return db
		.select()
		.from(decisionOptions)
		.where(and(eq(decisionOptions.decisionId, decisionId), isNull(decisionOptions.retiredInVersion)))
		.orderBy(asc(decisionOptions.position), asc(decisionOptions.id))
		.all();
}

/** Every participant row of the decision, removed ones included, in order. */
export function participantsOf(decisionId: number): DecisionParticipant[] {
	return db.select().from(decisionParticipants).where(eq(decisionParticipants.decisionId, decisionId)).orderBy(asc(decisionParticipants.id)).all();
}

/** A label as this module issues them: one capital letter. */
const LABEL = /^[A-Z]$/;

/**
 * The label the decision's next option is given (decision 7, D3): the letter
 * after the highest it has used, "A" when it has used none. Used means held
 * by any of its option rows, retired ones included; quoted in any version it
 * published; or `content.lastLabel`, the last the server issued, which is all
 * that is left of an option deleted before it was published. A label is
 * never issued twice. Once "Z" has been used, a 409.
 */
export function nextLabel(decisionId: number, content: WorkingContent): string {
	const used = [
		...db.select({ label: decisionOptions.label }).from(decisionOptions).where(eq(decisionOptions.decisionId, decisionId)).all().map((row) => row.label),
		...labelsInVersions(decisionId),
		...(content.lastLabel === null ? [] : [content.lastLabel])
	].filter((label) => LABEL.test(label));
	const highest = used.sort().at(-1);
	if (highest === 'Z') error(409, 'This decision has used every option label from A to Z: no option can be added');
	return highest === undefined ? 'A' : String.fromCharCode(highest.charCodeAt(0) + 1);
}

/**
 * The option ids the working content lists in its `options`, or null when it
 * holds no such list, which states nothing about the options and so retires
 * none (card 2675, decision 24; moved here by card 2676, D7).
 */
export function listedOptionIds(workingContent: string): Set<number> | null {
	try {
		const read = JSON.parse(workingContent) as { options?: unknown } | null;
		if (read === null || typeof read !== 'object' || !Array.isArray(read.options)) return null;
		return new Set(
			read.options
				.map((entry: unknown) => (entry !== null && typeof entry === 'object' ? (entry as { optionId?: unknown }).optionId : undefined))
				.filter((id): id is number => typeof id === 'number')
		);
	} catch {
		return null;
	}
}

/**
 * What publishing again does to the live options (card 2675, decision 24):
 * one not yet published is added in the new version; a published one no
 * longer listed is retired in it. With no list, none is retired.
 */
export function optionChanges(live: DecisionOption[], listed: Set<number> | null): { adding: DecisionOption[]; retiring: DecisionOption[] } {
	return {
		adding: live.filter((option) => option.addedInVersion === null),
		retiring: live.filter((option) => option.addedInVersion !== null && listed !== null && !listed.has(option.id))
	};
}

/**
 * What opening the decision at `now` asks about (decision 11), read on the
 * server: the board, the decider's access to it now, the live options, the
 * participants in id order with their persons, the snapshots taken again
 * now for one account held twice (card 2675, decision 29), and the mail
 * settings. It never leaves the server: `refusalsOf` turns it into words.
 */
export function openFactsOf(decision: Decision, now: Stamp): OpenFacts {
	const decider =
		decision.deciderUserId === null
			? undefined
			: db.select({ id: users.id, role: users.role, disabledAt: users.disabledAt }).from(users).where(eq(users.id, decision.deciderUserId)).get();
	const liveOptionCount = db
		.select({ id: decisionOptions.id })
		.from(decisionOptions)
		.where(and(eq(decisionOptions.decisionId, decision.id), isNull(decisionOptions.retiredInVersion)))
		.all().length;
	const rows = db.select().from(decisionParticipants).where(eq(decisionParticipants.decisionId, decision.id)).orderBy(asc(decisionParticipants.id)).all();
	const persons = peopleById(rows.map((row) => row.personId).filter((id): id is number => id !== null));

	const holders = new Map<number, string>();
	const sharedAccounts: OpenFacts['sharedAccounts'] = [];
	for (const row of rows) {
		if (row.personId === null || !persons.has(row.personId)) continue;
		const snapshot = snapshotOf(row.personId);
		if (snapshot === null || snapshot.userId === null) continue;
		const other = holders.get(snapshot.userId);
		if (other !== undefined) sharedAccounts.push({ name: snapshot.name, other });
		else holders.set(snapshot.userId, snapshot.name);
	}

	return {
		now,
		boardExists: decision.boardId !== null,
		deciderUserId: decision.deciderUserId,
		deciderName: decision.deciderName,
		deciderCanEdit: decider !== undefined && decision.boardId !== null && canEditBoard(decider, decision.boardId),
		closesAt: decision.closesAt,
		liveOptionCount,
		consultedCount: rows.filter((row) => row.role === 'consulted').length,
		participants: rows.map((row) => {
			const person = row.personId === null ? undefined : persons.get(row.personId);
			return { rowName: row.name, personFound: person !== undefined, personName: person?.fullName ?? null, personActive: person?.status === 'active' };
		}),
		sharedAccounts,
		mail: { host: isSmtpConfigured(), linkAddress: decisionLinkBase() !== null }
	};
}

/**
 * What the audience warnings ask about (decision 12): for each group an
 * audience of `content` names, whether it is there and its active members;
 * and the person of each live participant.
 */
export function audienceFactsOf(content: WorkingContent, participants: DecisionParticipant[]): AudienceFacts {
	const ids = [...new Set(content.audiences.map((audience) => audience.groupId).filter((id): id is number => id !== null))];
	const groups: AudienceFacts['groups'] = {};
	if (ids.length > 0) {
		const found = new Set(db.select({ id: peopleGroups.id }).from(peopleGroups).where(inArray(peopleGroups.id, ids)).all().map((group) => group.id));
		const members = db
			.select({ groupId: peopleGroupMembers.groupId, personId: peopleGroupMembers.personId })
			.from(peopleGroupMembers)
			.innerJoin(people, eq(people.id, peopleGroupMembers.personId))
			.where(and(inArray(peopleGroupMembers.groupId, ids), eq(people.status, 'active')))
			.all();
		for (const id of ids) {
			groups[id] = { exists: found.has(id), activeMemberIds: members.filter((member) => member.groupId === id).map((member) => member.personId) };
		}
	}
	return {
		groups,
		participantPersonIds: participants.filter((row) => row.removedAt === null && row.personId !== null).map((row) => row.personId!)
	};
}
