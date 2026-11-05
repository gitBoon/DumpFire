/**
 * decision-mail.ts — the mails that carry a decision's record to its
 * participants (card 2675, plan section 4.6 and decisions 10, 16 to 18, 28,
 * 30 and 31): the invitation, asked again, told of a change, withdrawn, and
 * the ruling, which card 2679's `ruleDecision` sends with a line saying a
 * concern may be raised for 90 days.
 *
 * `queueRecordMails` is called inside a service write's transaction. For each
 * participant who is not removed it asks `reachOf` (decision-links.ts) whether
 * they may be mailed at all, and how:
 *
 *   - skipped: `mail_skipped { mail, reason }`, and nothing else;
 *   - through their account: the mail links to `/decisions/{id}`, behind a
 *     sign-in;
 *   - through a link: a fresh link is issued, replacing the last (decision
 *     10), and the mail carries it.
 *
 * Then the mail's own event (`invited`, `asked_again`, `told_of_change`,
 * `told_withdrawn` or `told_ruling`) is written, and the mail is put in the
 * batch, in memory only: the token is held nowhere else. After the commit one
 * effect sends the batch in sequence, each mail finished and its
 * `mail_outcome { of, mail, delivered, problem? }` written, in a transaction
 * of its own as DumpFire, before the next starts (decision 17, D4): one mail
 * connection at a time, however many participants there are. `problem` is
 * the `MailProblem` code alone, never the mail server's words.
 *
 * Just before each send the mail is asked again (`stillToSend`, the code
 * review's F2): a mail whose decision has been deleted is not sent, and a
 * WARN line says so, as nothing can be recorded on it; one whose link the row
 * no longer holds, or whose participant is removed, has a new address or is
 * no longer reached through their account, or (card 2739's code review)
 * whose decision has been published again since it was built, is not sent
 * either, and its outcome is `mail_outcome { delivered: false, problem: 'superseded' }`. A
 * failed send's ERROR line names the participant and the decision by id,
 * never the address (S7).
 *
 * Every link is made on `decisionLinkBase()`: the App URL, else `ORIGIN`,
 * never the request's own Host (decision 28). With neither, a service refuses
 * the writes whose point is the mail before calling here; a withdrawal and a
 * ruling go ahead. Every mail asked for with no link address is recorded as
 * not sent, its event and `mail_outcome { delivered: false, problem:
 * 'no_link_address' }` written in the write's own transaction, with no link
 * issued and nothing queued (decision 17).
 *
 * These mails ignore notification preferences, the master switch included
 * (D22). Every text put into their HTML goes through `escapeHtml`, the title
 * in the heading too, as `emailTemplate` puts its title in as given (decision
 * 30). A subject is plain text, and never holds a token.
 *
 * Card 2697 adds the dry run (`queueDryRun`), which is no record mail: it
 * goes to the caller alone and records nothing but the service's `dry_run`
 * event; and the volume limits' constants and the one rule of when a
 * participant may be mailed again (`mailRestOf`).
 *
 * Card 2740 adds the words of an asking mail held back from a participant
 * made consulted while the decision is open (`HoldReason`, `HELD_WORDS`):
 * `setParticipants` writes the skip, and sends the rest as invitations here.
 * Card 2744: `extendDecision` does the same for whom a reopening asks.
 *
 * Card 2685 adds the closing-date reminder's mail (`reminderMail`), which
 * decision-reminders.ts sends. It is not a record mail and not one of D22's
 * five: for an account holder it follows `email_decisions` and the master
 * switch. It carries no personal link and no token, and issues none: a link
 * holder is told to use the link in the latest email they were sent.
 *
 * Not a service: plain functions with no caller.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { escapeHtml } from '$lib/escape-html';
import { LATEST_LINK_LINE } from '$lib/decision-words';
import { db } from './db';
import { decisionParticipants, decisions, decisionVersions, people, type Decision, type DecisionParticipant } from './db/schema';
import { afterCommit, inTransaction } from './db/transaction';
import { accountHistory, appendEvent, peopleById, SYSTEM_ACTOR, type EventKind, type RecordActor } from './decision-record';
import { hashOf, issueLink, linkUrl, reachOf } from './decision-links';
import { linkBaseUrl, trySendEmail } from './email';
import { createLogger } from './logger';
import { emailTemplate } from './notifications';
import { parseStamp, stamp, type Stamp } from '$lib/timestamps';

const log = createLogger('DECISIONS');

/** The mails that carry the record. */
export type RecordMail = 'invitation' | 'asked_again' | 'told_of_change' | 'withdrawn' | 'ruling';

/** How long after a record-bearing mail the same participant may be mailed again by a re-send, a re-publish or a re-inclusion (decision 31). */
export const RECORD_MAIL_MIN_MINUTES = 10;

/**
 * The most record-bearing mails one participant is sent about one decision
 * in 24 hours by a re-send, a re-publish or a re-inclusion (card 2697, Q24):
 * an invitation, two re-publishes and two re-sends. The withdrawal and the
 * ruling are not held to it: each is sent once, and must be.
 */
export const RECORD_MAIL_DAILY_CAP = 5;

/** How long after one dry run the same account may send the next, on any decision (card 2697, decision 19). */
export const DRY_RUN_MIN_MINUTES = 10;

/** The most dry runs one account sends in 24 hours, across decisions (card 2697, decision 19, Q2). */
export const DRY_RUN_DAILY_CAP = 20;

/** The most decisions one account opens or re-publishes in 24 hours, each mailing every participant (card 2697, Q23). */
export const PUBLISH_DAILY_CAP = 10;

/**
 * The most record mails one account causes in 24 hours, across every
 * decision (card 2697's code review, part B, S2): the invitations its opening,
 * its re-sends and its including or re-including people send, and the mails
 * its re-publishing sends. `RECORD_MAIL_DAILY_CAP` holds each participant of
 * one decision; this holds the caller across decisions, so that no account
 * can mail without end by spreading its mail over many. A write that would
 * pass it is refused whole, 429, and sends nothing. The withdrawal and the
 * ruling are not held to it, nor counted: each is sent once, and must be.
 */
export const CALLER_MAIL_DAILY_CAP = 500;

/** A day, in milliseconds: the window of each daily cap. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** `moment` moved on by `ms`, in the stored form; null when it is not a moment. Every rest and cap here reads its end so (the code review's part B, F5). */
export function later(moment: Stamp, ms: number): Stamp | null {
	const date = parseStamp(moment);
	return date === null ? null : stamp(new Date(date.getTime() + ms));
}

/**
 * The moment a daily cap of `cap` lets `coming` more through (one if not
 * said), given the moments counted against it in the last 24 hours, oldest
 * first: the moment the oldest that keeps the count with them over the cap is
 * a day old. Null while they fit. `coming` more than `cap` never fits: the
 * caller refuses that first. Each caller compares the answer with now as
 * `mailRestOf` does, `now < from` (the code review's part B, F7), so a moment
 * exactly a day old no longer counts.
 */
export function dailyCapFrom(moments: readonly Stamp[], cap: number, coming = 1): Stamp | null {
	if (moments.length + coming <= cap) return null;
	const oldest = moments[Math.max(0, moments.length + coming - cap - 1)];
	return (oldest === undefined ? null : later(oldest, DAY_MS)) ?? stamp(new Date(Date.now() + DAY_MS));
}

/**
 * Whether a participant may be mailed by the record again now (decision 31,
 * card 2697 Q24), in one rule that the service's refusal and the editor's
 * delivery panel both ask, so the two cannot disagree: null when they may;
 * otherwise the 409's words and the moment, in UTC, from which they may.
 * `lastAt` is their latest record-bearing mail or closing-date reminder (card
 * 2685, S6: a reminder starts the rest), `recent` the moments of the
 * record-bearing mails alone in the last 24 hours, oldest first. The
 * 10-minute rest is asked first. `reason` says which held them (card 2740:
 * the `mail_skipped` reason of a role change's asking mail held back).
 */
export function mailRestOf(
	name: string,
	lastAt: Stamp | undefined,
	recent: readonly Stamp[],
	now: Stamp
): { words: string; from: Stamp; reason: 'resting' | 'daily_cap' } | null {
	const rested = lastAt === undefined ? null : later(lastAt, RECORD_MAIL_MIN_MINUTES * 60 * 1000);
	if (rested !== null && now < rested) {
		return {
			words: `${name} was mailed about this decision less than ${RECORD_MAIL_MIN_MINUTES} minutes ago: they can be mailed again from ${rested} UTC`,
			from: rested,
			reason: 'resting'
		};
	}
	const capped = dailyCapFrom(recent, RECORD_MAIL_DAILY_CAP);
	if (capped !== null && now < capped) {
		return {
			words: `${name} has been mailed about this decision ${RECORD_MAIL_DAILY_CAP} times in the last 24 hours: they can be mailed again from ${capped} UTC`,
			from: capped,
			reason: 'daily_cap'
		};
	}
	return null;
}

/**
 * Why a role change's asking mail was held back (card 2740, D3): the
 * participant's 10-minute rest (`resting`) or daily cap (`daily_cap`), as
 * `mailRestOf` says, or the caller's daily cap (`caller_cap`,
 * `CALLER_MAIL_DAILY_CAP`). Written as `mail_skipped { mail: 'invitation',
 * reason }`; the role change itself is saved. Disjoint from `SkipReason`,
 * which says why a participant cannot be mailed at all.
 */
export type HoldReason = 'resting' | 'daily_cap' | 'caller_cap';

/**
 * A held-back asking mail in words, for the editor's delivery panel (card 2740, D3): after "Invitation not sent, <moment>:".
 * `caller_cap` names no Resend (the code review, 2026-11-05): the panel cannot ask the caller's cap, which is the
 * account's across decisions, so a Resend offered beside it would be refused 429 until the day's limit allows.
 * Card 2744 (D6): an Extend that reopens a decision holds back its asks in the same way, for people included as well as
 * made consulted, so the words say what is true of both.
 */
export const HELD_WORDS: Readonly<Record<HoldReason, (name: string) => string>> = {
	resting: (name) =>
		`${name} was not asked for their view: they had been mailed about this decision less than ${RECORD_MAIL_MIN_MINUTES} minutes before. Resend asks them once they may be mailed again`,
	daily_cap: (name) =>
		`${name} was not asked for their view: they had been mailed about this decision ${RECORD_MAIL_DAILY_CAP} times in 24 hours. Resend asks them once they may be mailed again`,
	caller_cap: (name) =>
		`${name} was not asked for their view: the invitation was held, as the daily limit of ${CALLER_MAIL_DAILY_CAP} decision mails one account can send had been reached. It can be sent tomorrow`
};

/** The event each mail writes for its participant; the delivery panel reads it back (`MAIL_OF_EVENT`, the code review's part B, F5). */
export const MAIL_EVENT: Readonly<Record<RecordMail, EventKind>> = {
	invitation: 'invited',
	asked_again: 'asked_again',
	told_of_change: 'told_of_change',
	withdrawn: 'told_withdrawn',
	ruling: 'told_ruling'
};

/**
 * The address every decision mail's links are made on: the configured App
 * URL, else `ORIGIN`, else null. The request's own Host never counts, even
 * under dev (decision 28, R10), and a service's `opts.baseUrl` is not read.
 */
export function decisionLinkBase(): string | null {
	return linkBaseUrl();
}

/**
 * One mail of a batch, as it is to be sent: held in memory only, as its
 * `html` may carry a token. `linkHash` is the stored form of the link it
 * carries, null for a mail to an account holder (the code review's F2).
 */
type Queued = { to: string; subject: string; html: string; eventId: number; participantId: number; linkHash: string | null; version: number };

/** What a mail is told beside the decision. */
export type RecordMailOptions = {
	/** Who the events are by. */
	by: RecordActor;
	/** The participants to mail; every participant who is not removed when not given. */
	participants?: DecisionParticipant[];
	/** Asked again, told of a change: the change note. */
	changeNote?: string;
	/** Withdrawn: the reason. */
	reason?: string;
	/** An invitation sent again (`resendInvitation`): its event says so, `invited { resend: true }`. */
	resend?: boolean;
	/** The ruling (card 2679, `ruleDecision`): the option chosen by label and title, or none of them (null), the reason and the conditions. No figure, no "against" and no cut-off (S4). */
	ruling?: { optionLabel: string | null; optionTitle: string | null; reason: string; conditions: string | null };
};

/**
 * Mail `mail` to the decision's participants, inside the write's transaction,
 * as the module header says: the events now, and the sending, in sequence,
 * once the write is committed. `decision` is the row as the write leaves it.
 *
 * With no link address each mail is recorded as not sent, and none is
 * queued. A service whose point is the mail refuses before it calls here
 * (409 `NO_LINK_ADDRESS`), so only a withdrawal and a ruling reach that.
 */
export function queueRecordMails(decision: Decision, mail: RecordMail, opts: RecordMailOptions): void {
	const base = decisionLinkBase();

	const participants = (
		opts.participants ??
		db
			.select()
			.from(decisionParticipants)
			.where(and(eq(decisionParticipants.decisionId, decision.id), isNull(decisionParticipants.removedAt)))
			.orderBy(asc(decisionParticipants.id))
			.all()
	).filter((p) => p.removedAt === null);
	if (participants.length === 0) return;

	const persons = peopleById(participants.map((p) => p.personId).filter((id): id is number => id !== null));
	// Read once for the whole mail, and handed to issueLink (the code review's F1).
	const history = accountHistory(decision.id);
	const kind = MAIL_EVENT[mail];
	const versionNumber = mail === 'asked_again' || mail === 'told_of_change' ? decision.currentVersion : null;
	const detail = opts.resend ? { resend: true } : null;
	const content = publishedContent(decision);

	const batch: Queued[] = [];
	for (const p of participants) {
		const person = p.personId === null ? null : (persons.get(p.personId) ?? null);
		const hadAccount = history.get(p.id) ?? false;
		const reach = reachOf(p, person, hadAccount);
		if ('skip' in reach) {
			appendEvent({ decisionId: decision.id, kind: 'mail_skipped', participantId: p.id, detail: { mail, reason: reach.skip } }, opts.by);
			continue;
		}
		if (base === null) {
			// No address to make a link on: recorded, and not sent.
			const of = appendEvent({ decisionId: decision.id, kind, participantId: p.id, versionNumber, detail }, opts.by);
			appendEvent(
				{ decisionId: decision.id, kind: 'mail_outcome', participantId: p.id, detail: { of, mail, delivered: false, problem: 'no_link_address' } },
				SYSTEM_ACTOR
			);
			continue;
		}
		const token = reach.via === 'link' ? issueLink(p.id, opts.by, p.linkTokenHash !== null, { person, hadAccount }) : null;
		const link = token !== null ? linkUrl(base, token) : `${base}/decisions/${decision.id}`;
		const eventId = appendEvent({ decisionId: decision.id, kind, participantId: p.id, versionNumber, detail }, opts.by);
		batch.push({
			to: p.email,
			subject: subjectOf(decision, mail, p.role),
			html: emailTemplate(escapeHtml(decision.title), bodyOf(decision, mail, p.role, link, content, opts)),
			eventId,
			participantId: p.id,
			linkHash: token === null ? null : hashOf(token),
			version: decision.currentVersion
		});
	}
	if (batch.length === 0) return;

	const decisionId = decision.id;
	afterCommit(async () => {
		for (const m of batch) {
			// Asked again just before the send (the code review's F2): a write
			// committed while the batch was out may have ended what this mail is for.
			const still = stillToSend(decisionId, m);
			if (still === 'decision_gone') {
				log.warn(`Decision ${decisionId}: mail event ${m.eventId} was not sent, as the decision is gone`, { decisionId, eventId: m.eventId });
				continue;
			}
			const outcome = still === 'send' ? await trySendEmail(m.to, m.subject, m.html, { recipient: `participant ${m.participantId} of decision ${decisionId}` }) : null;
			const result = outcome === null ? { delivered: false, problem: 'superseded' } : { delivered: outcome.sent, ...(outcome.sent ? {} : { problem: outcome.problem }) };
			try {
				inTransaction(() =>
					appendEvent({ decisionId, kind: 'mail_outcome', participantId: m.participantId, detail: { of: m.eventId, mail, ...result } }, SYSTEM_ACTOR)
				);
			} catch {
				// The decision deleted meanwhile, for one: the batch goes on with the next mail.
				log.warn(`Decision ${decisionId}: the outcome of mail event ${m.eventId} could not be recorded`, { decisionId, eventId: m.eventId });
			}
		}
	});
}

// ─── Inside the mails ────────────────────────────────────────────────────────

/**
 * Whether a queued mail is still to go, asked just before it is sent (F2):
 * `decision_gone` when the decision has been deleted, so that nothing can be
 * recorded of it; `superseded` when the mail no longer stands: the row is
 * removed or its address is not the one the mail is for; for a link mail
 * because the row no longer holds the link it carries (a later mail
 * replaced it, or it was ended), and for an account mail because `reachOf`
 * would no longer reach the participant through their account; and (card
 * 2739's code review, 2026-11-05) when the decision has been published again
 * since the mail was built, so that it quotes a version no longer current;
 * `send` otherwise. An account mail's `reachOf` never reads `hadAccount`, so none is
 * read for it: a row whose account was cleared meanwhile is not on the
 * account route, whatever its history.
 */
function stillToSend(decisionId: number, m: Queued): 'send' | 'superseded' | 'decision_gone' {
	const decision = db.select({ currentVersion: decisions.currentVersion }).from(decisions).where(eq(decisions.id, decisionId)).get();
	if (!decision) return 'decision_gone';
	if (decision.currentVersion !== m.version) return 'superseded';
	const row = db.select().from(decisionParticipants).where(eq(decisionParticipants.id, m.participantId)).get();
	if (!row || row.removedAt !== null || row.email !== m.to) return 'superseded';
	if (m.linkHash !== null) return row.linkTokenHash === m.linkHash ? 'send' : 'superseded';
	const person = row.personId === null ? null : (db.select().from(people).where(eq(people.id, row.personId)).get() ?? null);
	const reach = reachOf(row, person, true);
	return 'via' in reach && reach.via === 'account' ? 'send' : 'superseded';
}

/** What the mail quotes of the published version, or of the working copy for a dry run: its question and what it asks. */
export type Quoted = { question: string; ask: string };

/**
 * A dry run (card 2697, decision 19, Q8, Q20, Q26): the invitation as a
 * consulted participant would get it, quoting the working copy (`quoted`,
 * which the service parses: this module imports nothing from
 * decision-content.ts), mailed to `to`, the caller, alone. Its subject is
 * `Dry run: ` and the invitation's; its body the invitation's, with a line
 * naming the account that asked for it, and its link the preview,
 * `<decisionLinkBase()>/decisions/<id>/preview`, behind a sign-in. It names
 * no participant, carries no personal link and issues none, and writes
 * nothing: the service has written the `dry_run` event. One send after the
 * commit; a failure is logged by `trySendEmail` under the recipient's form,
 * never the address. A caller with no link address is a fault: the service
 * refuses one first.
 */
export function queueDryRun(decision: Decision, to: { id: number; username: string; email: string }, quoted: Quoted): void {
	const base = decisionLinkBase();
	if (base === null) throw new Error(`Decision ${decision.id}: a dry run was asked for with no link address`);
	const link = `${base}/decisions/${decision.id}/preview`;
	const subject = `Dry run: ${subjectOf(decision, 'invitation', 'consulted')}`;
	const asked = paragraph(`This dry run was sent at the request of ${to.username}.`);
	const html = emailTemplate(escapeHtml(decision.title), `${asked}\n${bodyOf(decision, 'invitation', 'consulted', link, quoted, {})}`);
	const recipient = `caller ${to.id} dry run of decision ${decision.id}`;
	afterCommit(async () => {
		await trySendEmail(to.email, subject, html, { recipient });
	});
}

/**
 * The **Open the decision** button of every decision mail built here, its
 * `href` escaped where it is put (card 2685's code review, F5): one markup
 * for the record mails and the closing-date reminder alike.
 */
function openDecisionButton(href: string): string {
	return `<a href="${escapeHtml(href)}" style="display: inline-block; padding: 8px 16px; background: #4338ca; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">Open the decision</a>`;
}

/**
 * The closing-date reminder (card 2685, decision 10): its subject, plain
 * text with the title as written and never a token, and its HTML, every
 * value through `escapeHtml`. The closing time as stored, with `UTC`; who
 * decides; then an account holder's **Open the decision** button to
 * `<base>/decisions/<id>`, behind a sign-in, or a link holder's
 * `LATEST_LINK_LINE` (decision 5: the reminder mints no link, so the one in
 * their latest record mail stays the only one), in the answer notice's
 * words. It quotes no question or ask, names no other participant and gives
 * no figure.
 */
export function reminderMail(decision: Pick<Decision, 'id' | 'title' | 'closesAt' | 'deciderName'>, via: 'account' | 'link', base: string): { subject: string; html: string } {
	const closes = `${decision.closesAt ?? ''} UTC`;
	const parts = [
		paragraph(`Your view on this decision is asked by ${closes}, and you have not responded to the current version yet.`),
		paragraph(decision.deciderName, 'Who decides:'),
		via === 'account' ? openDecisionButton(`${base}/decisions/${decision.id}`) : paragraph(LATEST_LINK_LINE)
	];
	return {
		subject: `Reminder: your view is asked by ${closes}: ${decision.title}`,
		html: emailTemplate(escapeHtml(decision.title), parts.filter((part) => part !== '').join('\n'))
	};
}

/** The question and the ask of the decision's current published version, '' for either it does not hold. */
function publishedContent(decision: Decision): Quoted {
	const version = db
		.select({ content: decisionVersions.content })
		.from(decisionVersions)
		.where(and(eq(decisionVersions.decisionId, decision.id), eq(decisionVersions.number, decision.currentVersion)))
		.get();
	try {
		const read = JSON.parse(version?.content ?? '{}') as { question?: unknown; ask?: unknown } | null;
		return {
			question: typeof read?.question === 'string' ? read.question : '',
			ask: typeof read?.ask === 'string' ? read.ask : ''
		};
	} catch {
		return { question: '', ask: '' };
	}
}

/** The subject: plain text, the title as written, never a token. `role` is the participant's, `consulted` or `informed` (card 2697, Q8). */
function subjectOf(decision: Decision, mail: RecordMail, role: string): string {
	switch (mail) {
		case 'invitation':
			return role === 'informed' ? `For your information: ${decision.title}` : `Your view is asked: ${decision.title}`;
		case 'asked_again':
			return `Changed, and your view is asked again: ${decision.title}`;
		case 'told_of_change':
			return `Changed: ${decision.title}`;
		case 'withdrawn':
			return `Withdrawn: ${decision.title}`;
		case 'ruling':
			return `Ruled: ${decision.title}`;
	}
}

const PARAGRAPH = 'margin: 0 0 12px; font-size: 14px; color: #334155; line-height: 1.5;';

/** The ruling mail's line on concerns (card 2679, decision 3): the window is `LINK_DAYS_AFTER_END` after the ruling. */
const RULING_CONCERN_LINE = 'You can raise a concern about this ruling from the page for 90 days.';

/** A paragraph of text, escaped; nothing for no text. */
function paragraph(text: string | null | undefined, label?: string): string {
	if (!text) return '';
	return `<p style="${PARAGRAPH}">${label ? `<strong>${escapeHtml(label)}</strong> ` : ''}${escapeHtml(text)}</p>`;
}

/**
 * The mail's body, every value through `escapeHtml`. It names no other
 * participant and gives no figure. `role` is the participant's (card 2697,
 * Q8), so that a dry run, which has no participant row, is the same mail.
 */
function bodyOf(
	decision: Decision,
	mail: RecordMail,
	role: string,
	link: string,
	content: Quoted,
	opts: Pick<RecordMailOptions, 'changeNote' | 'reason' | 'ruling'>
): string {
	const parts: string[] = [];
	switch (mail) {
		case 'invitation':
			parts.push(paragraph(content.question));
			if (role === 'informed') {
				parts.push(paragraph('You are told of this decision for your information. Nothing is asked of you.'));
			} else {
				parts.push(paragraph(content.ask, 'What is asked of you:'));
				parts.push(paragraph(decision.closesAt === null ? null : `${decision.closesAt} UTC`, 'Your view is asked by:'));
			}
			parts.push(paragraph(decision.deciderName, 'Who decides:'));
			break;
		case 'asked_again':
			parts.push(paragraph(opts.changeNote ?? null, 'What changed:'));
			parts.push(paragraph('Your view is asked again. A response you gave earlier stays on the record for the version you gave it on.'));
			parts.push(paragraph(decision.closesAt === null ? null : `${decision.closesAt} UTC`, 'Your view is asked by:'));
			break;
		case 'told_of_change':
			parts.push(paragraph(opts.changeNote ?? null, 'What changed:'));
			break;
		case 'withdrawn':
			parts.push(paragraph('This decision has been withdrawn.'));
			parts.push(paragraph(opts.reason ?? null, 'Why:'));
			parts.push(paragraph('The link below goes on working for 90 days.'));
			break;
		case 'ruling': {
			const ruling = opts.ruling;
			const chosen = ruling && ruling.optionLabel !== null ? [ruling.optionLabel, ruling.optionTitle].filter(Boolean).join(': ') : 'None of these';
			parts.push(paragraph(chosen, 'Ruled:'));
			parts.push(paragraph(ruling?.reason ?? null, 'Why:'));
			parts.push(paragraph(ruling?.conditions ?? null, 'Conditions:'));
			// Card 2679 (decision 3): the concern window, with no figure, no "against" and no cut-off (S4).
			parts.push(paragraph(RULING_CONCERN_LINE));
			break;
		}
	}
	parts.push(openDecisionButton(link));
	return parts.filter((part) => part !== '').join('\n');
}
