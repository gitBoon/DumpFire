// @vitest-environment jsdom
/**
 * The ISO/IEC 27001:2022 checklist (card 2670, plan section 5): its source,
 * `src/lib/server/iso-27001.ts`, its page's load and the page.
 *
 * Cases 1 to 5 guard the source: every control and clause once, every value
 * from its set with the two sides kept apart, every piece of evidence found
 * in the repository, and every gap named by a card or an accepted risk. They
 * cannot read prose: whether a "met" is really met is the code review's to
 * check (plan D13). Cases 6 to 9 cover `summarise` and each branch of the
 * load. Cases 10 and 11 mount the page, which is all it does.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';
import { isRedirect } from '@sveltejs/kit';
import type { SessionUser } from '$lib/server/auth';
import { CHECKED_ON, CHECKLIST, summarise, type IsoItem, type IsoStatus } from '$lib/server/iso-27001';
import { load } from '../src/routes/admin/iso-27001/+page.server';
import IsoPage from '../src/routes/admin/iso-27001/+page.svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), goto: vi.fn(), afterNavigate: vi.fn(), beforeNavigate: vi.fn(), onNavigate: vi.fn() }));
// A bare 'svelte' gives the server's runtime: the client's, by its path (as tests/admin-panels.test.ts does).
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

const ROOT = process.cwd();
const APPLICATION_SIDE = CHECKLIST.filter((item) => item.applicability !== 'organisational');

/** A heading's anchor as GitHub and Merview make it: lower case, only letters, digits, spaces and hyphens, spaces as hyphens. */
function slug(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N} -]/gu, '')
		.replace(/ /g, '-');
}

/** Every heading's anchor in a Markdown file, outside fenced code. */
function anchorsOf(path: string): Set<string> {
	const anchors = new Set<string>();
	let fenced = false;
	for (const line of readFileSync(join(ROOT, path), 'utf8').split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		const heading = !fenced && /^#{1,6}\s+(.*)$/.exec(line);
		if (heading) anchors.add(slug(heading[1]));
	}
	return anchors;
}

/** What is wrong with a path and its anchor or symbol, or null. */
function evidenceFault(e: { path: string; anchor?: string; symbol?: string }): string | null {
	// docs/planning/ is git-ignored: a clone, and the image build's copy of one, has none of it.
	if (e.path.startsWith('docs/planning')) return `${e.path} is under docs/planning/, which a clone does not hold`;
	if (!existsSync(join(ROOT, e.path))) return `${e.path} does not exist`;
	if (e.anchor !== undefined) {
		if (!e.path.endsWith('.md')) return `${e.path}#${e.anchor}: an anchor needs a Markdown file`;
		if (!anchorsOf(e.path).has(e.anchor)) return `${e.path}#${e.anchor}: no heading has that anchor`;
	}
	if (e.symbol !== undefined && !readFileSync(join(ROOT, e.path), 'utf8').includes(e.symbol)) return `${e.path}: ${e.symbol} is not in it`;
	return null;
}

describe('the checklist source', () => {
	// 1
	it('holds every Annex A control exactly once, each with its chapter’s theme', () => {
		const expected = [
			...Array.from({ length: 37 }, (_, i) => `A.5.${i + 1}`),
			...Array.from({ length: 8 }, (_, i) => `A.6.${i + 1}`),
			...Array.from({ length: 14 }, (_, i) => `A.7.${i + 1}`),
			...Array.from({ length: 34 }, (_, i) => `A.8.${i + 1}`)
		];
		const annex = CHECKLIST.filter((item) => item.kind === 'annex-a');

		expect(expected).toHaveLength(93);
		expect(annex.map((item) => item.ref)).toEqual(expected);
		const themes: Record<string, string> = { '5': 'organisational', '6': 'people', '7': 'physical', '8': 'technological' };
		expect(annex.filter((item) => item.theme !== themes[item.ref.split('.')[1]]).map((item) => item.ref)).toEqual([]);
	});

	// 2
	it('holds every clause 4 to 10 exactly once, each the organisation’s with no theme', () => {
		const expected = ['4.1', '4.2', '4.3', '4.4', '5.1', '5.2', '5.3', '6.1', '6.2', '6.3', '7.1', '7.2', '7.3', '7.4', '7.5', '8.1', '8.2', '8.3', '9.1', '9.2', '9.3', '10.1', '10.2'];
		const clauses = CHECKLIST.filter((item) => item.kind === 'clause');

		expect(clauses.map((item) => item.ref)).toEqual(expected);
		expect(clauses.filter((item) => item.theme !== null || item.applicability !== 'organisational').map((item) => item.ref)).toEqual([]);
		expect(CHECKLIST).toHaveLength(93 + 23);
	});

	// 3
	it('gives every item values from their sets, and keeps the two sides apart', () => {
		const faults: string[] = [];
		for (const item of CHECKLIST) {
			const at = `${item.kind} ${item.ref}`;
			if (!['met', 'partly-met', 'not-met', 'not-applicable', 'organisational'].includes(item.status)) faults.push(`${at}: status ${item.status}`);
			if (!['app', 'supports', 'organisational'].includes(item.applicability)) faults.push(`${at}: applicability ${item.applicability}`);
			if (!['DumpFire', 'the organisation'].includes(item.owner)) faults.push(`${at}: owner ${item.owner}`);
			if (item.title.trim() === '' || item.how.trim() === '') faults.push(`${at}: a title and how are required`);
			if (item.applicability === 'organisational') {
				if (item.status !== 'organisational' && item.status !== 'not-applicable') faults.push(`${at}: organisational with status ${item.status}`);
				if (item.owner !== 'the organisation') faults.push(`${at}: organisational, owned by ${item.owner}`);
				if (item.gapCards.length > 0) faults.push(`${at}: organisational with gap cards`);
			} else {
				if (item.status === 'organisational') faults.push(`${at}: ${item.applicability} with status organisational`);
				if (item.owner !== 'DumpFire') faults.push(`${at}: ${item.applicability}, owned by ${item.owner}`);
			}
			if (item.applicability === 'supports' && !item.organisationalPart?.trim()) faults.push(`${at}: supports with no organisational part`);
			// An item with an organisation's part is `supports`, not `app` (the code review, R3).
			if (item.applicability === 'app' && item.organisationalPart !== undefined) faults.push(`${at}: app with an organisational part (make it supports)`);
			if (item.status === 'not-applicable' && !item.reason?.trim()) faults.push(`${at}: not applicable with no reason`);
			// Only the organisation excludes a control, through its SoA (the code review, R14).
			if (item.status === 'not-applicable' && item.applicability !== 'organisational') faults.push(`${at}: not applicable but ${item.applicability}`);
		}

		expect(faults).toEqual([]);
	});

	// 4
	it('names evidence that exists: every path, anchor and symbol, and some for every application item', () => {
		const faults: string[] = [];
		for (const item of CHECKLIST) {
			for (const e of item.evidence) {
				const fault = evidenceFault(e);
				if (fault) faults.push(`${item.ref}: ${fault}`);
			}
		}
		for (const item of APPLICATION_SIDE) if (item.evidence.length === 0) faults.push(`${item.ref}: no evidence`);

		expect(faults).toEqual([]);
	});

	// 5
	it('test 43 (card 2996): A.5.18 names the record of account endings, its writer, the restore’s application and the start’s pass as evidence, and each exists', () => {
		const item = CHECKLIST.find((entry) => entry.ref === 'A.5.18')!;
		for (const symbol of ['recordAccountEnding', 'applyAccountEndings', 'endRecordedAccountsPresent']) {
			const evidence = item.evidence.find((e) => e.symbol === symbol);
			expect(evidence, symbol).toBeDefined();
			expect(evidenceFault(evidence!), symbol).toBeNull();
		}
		expect(item.how).toContain('(card 2996)');
	});

	it("(r) card 3013: A.5.18 says a backup whose seal does not verify adds nothing the file chose to either record and gives every account of an id and creation time here that account's role and disabled state exactly, and cites the three restore steps, each of which exists", () => {
		const item = CHECKLIST.find((entry) => entry.ref === 'A.5.18')!;
		for (const symbol of ['keepAccountStateHere', 'carryAccountEndings', 'carryKeyRevocations']) {
			const evidence = item.evidence.find((e) => e.path === 'src/lib/server/db/restore.ts' && e.symbol === symbol);
			expect(evidence, symbol).toBeDefined();
			expect(evidenceFault(evidence!), symbol).toBeNull();
		}
		expect(item.how).toContain(
			"(card 2996). A backup whose seal does not verify adds nothing the file chose to either record, and every account it holds under the id and creation time of an account here takes that account's role and enabled or disabled state exactly as here, a superadmin's included (card 3013)."
		);
	});

	it('(cc) card 2997: A.5.17 names the writer of a password replaced and the restore’s password step as evidence, and each exists', () => {
		const item = CHECKLIST.find((entry) => entry.ref === 'A.5.17')!;
		for (const symbol of ['recordPasswordReplaced', 'applyPasswordRulings']) {
			const evidence = item.evidence.find((e) => e.symbol === symbol);
			expect(evidence, symbol).toBeDefined();
			expect(evidenceFault(evidence!), symbol).toBeNull();
		}
		expect(item.how).toContain('(card 2997)');
	});

	it('(z) card 3009: A.5.17 names the same account here, the unsealed key rule and the holds as evidence, each exists, and no longer says an unsealed backup can give an account any password', () => {
		const item = CHECKLIST.find((entry) => entry.ref === 'A.5.17')!;
		for (const symbol of ['sameAccountHere', 'keysOfTheSameHere', 'holdUnsealedSettings', 'rowsToRestore']) {
			const evidence = item.evidence.find((e) => e.symbol === symbol);
			expect(evidence, symbol).toBeDefined();
			expect(evidenceFault(evidence!), symbol).toBeNull();
		}
		expect(item.how).not.toContain('any password');
		expect(item.how).toContain('gives no account that is not the same account here');
		expect(item.how).toContain('a password, an API key or a second factor from the file');
		// Its code review (FP1, FP3): no invite of a file sets a password, and a working copy removes what it would hold.
		expect(item.how).toContain("none of its invites is restored, and a sealed backup's only as used history, so no invite from a file sets a password");
		expect(item.how).toContain("held for the superadmin's review, or, on a working copy, removed (card 3009)");
		expect(item.how).toContain('(card 3009)');
	});

	it('(z) card 3012: A.8.12 names what an unsealed backup is kept from sending outside, cites the three steps as evidence, and each exists', () => {
		const item = CHECKLIST.find((entry) => entry.ref === 'A.8.12')!;
		for (const symbol of ['holdUnsealedWebhooks', 'pauseUnsealedSchedules', 'keepAccountsHere']) {
			const evidence = item.evidence.find((e) => e.symbol === symbol);
			expect(evidence, symbol).toBeDefined();
			expect(evidenceFault(evidence!), symbol).toBeNull();
		}
		expect(item.how).toContain('A restore of a backup whose seal did not verify sends nothing outside as the file has it');
		expect(item.how).toContain('every webhook with an address is held with its secret discarded, every report schedule is paused');
		expect(item.how).toContain('(card 3012)');
		// Card 3020 (S5 fallout): '(card 3020)' now names the rule that closed the gap, no longer the gap itself.
		expect(item.how).toContain('so no decision mail goes to them (card 3020)');
	});

	it('(z) card 3020: A.8.12 states the rule for the requests and people of an unsealed backup, no longer lists card 3020 as open, and cites the four symbols, each of which exists', () => {
		const item = CHECKLIST.find((entry) => entry.ref === 'A.8.12')!;
		for (const [path, symbol] of [
			['src/lib/server/db/restore.ts', 'holdUnsealedRequestMail'],
			['src/lib/server/db/restore.ts', 'switchOffUnsealedPeople'],
			['src/lib/server/request-access.ts', 'requesterMailAddress'],
			['src/routes/api/requests/held/+server.ts', 'confirmStepUp']
		]) {
			const evidence = item.evidence.find((e) => e.path === path && e.symbol === symbol);
			expect(evidence, `${path} ${symbol}`).toBeDefined();
			expect(evidenceFault(evidence!), `${path} ${symbol}`).toBeNull();
		}
		expect(item.how).toContain(
			'; requests whose requester or card this server did not hold as they are have their mail held until an administrator releases each, as reviewed, with a password and a code, ' +
				'and people whose address and account it did not hold are marked left, so no decision mail goes to them (card 3020). '
		);
		const open = item.how.slice(item.how.indexOf('Still open:'));
		expect(open).toMatch(/^Still open: a schedule covers boards added to its grouping later\. /);
		expect(open).not.toContain('3020');
		expect(item.how).not.toContain('are still mailed as it has them');
	});

	it("(jj) card 3002: A.5.15 and A.8.3 say a restore brings no board, team or person access back above this server's record, and an unsealed backup gives same-here accounts exactly this server's access, A.8.3 saying \"recorded\" and naming what is not (FP9), before what is still open, and cite the record's writer and the restore's steps, each of which exists", () => {
		const cited = {
			'A.5.15': [
				['src/lib/server/access-changes.ts', 'recordAccessChange'],
				['src/lib/server/db/restore.ts', 'applyAccessRecord']
			],
			'A.8.3': [
				['src/lib/server/access-changes.ts', 'recordAccessChange'],
				['src/lib/server/db/restore.ts', 'applyAccessRecord'],
				['src/lib/server/db/restore.ts', 'keepAccessHere']
			]
		};
		for (const [ref, symbols] of Object.entries(cited)) {
			const item = CHECKLIST.find((entry) => entry.ref === ref)!;
			for (const [path, symbol] of symbols) {
				const evidence = item.evidence.find((e) => e.path === path && e.symbol === symbol);
				expect(evidence, `${ref} ${path} ${symbol}`).toBeDefined();
				expect(evidenceFault(evidence!), `${ref} ${path} ${symbol}`).toBeNull();
			}
		}
		const control = CHECKLIST.find((entry) => entry.ref === 'A.5.15')!;
		expect(control.how).toContain(
			'Every change of who may open a board, who is in a team and which account a person is linked to is recorded by identity in the transaction that makes it, ' +
				'and a restore brings that access back no higher than recorded, never taking on a guess access this server holds when it runs (card 3002). '
		);
		expect(control.evidence.find((e) => e.path === 'tests/access-changes.test.ts')).toBeDefined();
		const restriction = CHECKLIST.find((entry) => entry.ref === 'A.8.3')!;
		const said =
			'A restore never brings back board, team or person access whose removal, lowering or making private here since the backup was made is recorded, and a backup whose seal does not verify ' +
			'gives every account that is the same here exactly the access it has here, and none on the boards and teams this server does not hold (card 3002). ' +
			'Not recorded, so not kept by a restore: a change made by a host edit or while an older image ran, and the boards and teams deleted before the record began, which come back whole. ';
		expect(restriction.how).toContain(said);
		// A rule, not a gap: before what is still open.
		expect(restriction.how.indexOf(said)).toBeLessThan(restriction.how.indexOf('Still open:'));
		expect(restriction.how.slice(restriction.how.indexOf('Still open:'))).not.toContain('3002');
	});

	it("(hh) card 3033: A.5.15 and A.8.3 say a restore brings no decision role back above the record and an unsealed backup gives none this server did not give, before what is still open, and cite applyDecisionRecord and keepDecisionRolesHere, each of which exists", () => {
		for (const ref of ['A.5.15', 'A.8.3']) {
			const item = CHECKLIST.find((entry) => entry.ref === ref)!;
			for (const symbol of ['applyDecisionRecord', 'keepDecisionRolesHere']) {
				const evidence = item.evidence.find((e) => e.path === 'src/lib/server/db/restore.ts' && e.symbol === symbol);
				expect(evidence, `${ref} ${symbol}`).toBeDefined();
				expect(evidenceFault(evidence!), `${ref} ${symbol}`).toBeNull();
			}
		}
		const control = CHECKLIST.find((entry) => entry.ref === 'A.5.15')!;
		expect(control.how).toContain(
			"So is every change of a decision's participants, the account each of its places holds, and its decider, and a restore brings no decision role back above the record, " +
				'while a backup whose seal does not verify gives none this server did not give (card 3033). '
		);
		const restriction = CHECKLIST.find((entry) => entry.ref === 'A.8.3')!;
		const said =
			'Nor does a restore bring back a decision role whose removal or lowering here is recorded: a participant removed or made informed, an account taken off a place, a decider replaced; ' +
			"and a backup whose seal does not verify leaves every decision this server holds with its board, stage, author, decider and participants as here, takes no ruling's Product Owner from the file, " +
			'and brings the decisions this server does not hold in with no board, no account and nobody on them (card 3033). ';
		expect(restriction.how).toContain(said);
		expect(restriction.how.indexOf(said)).toBeLessThan(restriction.how.indexOf('Still open:'));
		expect(restriction.how.slice(restriction.how.indexOf('Still open:'))).not.toContain('3033');
	});

	it("(g) card 3029: A.8.12 says, right after card 3020's rule, that an unsealed restore kept as it is keeps this server's From, not as open, and cites both symbols, each of which exists", () => {
		const item = CHECKLIST.find((entry) => entry.ref === 'A.8.12')!;
		for (const [path, symbol] of [
			['src/lib/server/db/restore.ts', 'keepMailFromHere'],
			['src/lib/server/email.ts', 'mailFromAsRead']
		]) {
			const evidence = item.evidence.find((e) => e.path === path && e.symbol === symbol);
			expect(evidence, `${path} ${symbol}`).toBeDefined();
			expect(evidenceFault(evidence!), `${path} ${symbol}`).toBeNull();
		}
		expect(item.how).toContain(
			'so no decision mail goes to them (card 3020). ' +
				"On such a restore kept as it is, mail keeps this server's From address and name, or none where it had none (card 3029). "
		);
		expect(item.how.slice(item.how.indexOf('Still open:'))).not.toContain('3029');
	});

	it("(nn) card 3004: A.8.12 and A.8.13 say a restore brings nothing back more open than this server's record of where it sends, as rules before what is still open, and cite recordOutboundChange and applyOutboundWebhooks, each of which exists", () => {
		const cited = {
			'A.8.12': [
				['src/lib/server/outbound-changes.ts', 'recordOutboundChange'],
				['src/lib/server/db/restore.ts', 'applyOutboundWebhooks'],
				['src/lib/server/db/restore.ts', 'applyOutboundSchedules'],
				['src/lib/server/db/restore.ts', 'applyOutboundSettings']
			],
			'A.8.13': [
				['src/lib/server/outbound-changes.ts', 'recordOutboundChange'],
				['src/lib/server/db/restore.ts', 'applyOutboundSettings'],
				['src/lib/server/db/restore.ts', 'applyOutboundWebhooks']
			]
		};
		for (const [ref, symbols] of Object.entries(cited)) {
			const item = CHECKLIST.find((entry) => entry.ref === ref)!;
			for (const [path, symbol] of symbols) {
				const evidence = item.evidence.find((e) => e.path === path && e.symbol === symbol);
				expect(evidence, `${ref} ${path} ${symbol}`).toBeDefined();
				expect(evidenceFault(evidence!), `${ref} ${path} ${symbol}`).toBeNull();
			}
		}
		const leakage = CHECKLIST.find((entry) => entry.ref === 'A.8.12')!;
		const said =
			"On such a restore kept as it is, mail keeps this server's From address and name, or none where it had none (card 3029). " +
			'Every change of where this server sends is recorded by identity in the transaction that makes it, naming no address in plain: ';
		expect(leakage.how).toContain(said);
		for (const words of [
			'a webhook deleted or re-pointed here comes back switched off for good with its secret discarded',
			'an address taken off a schedule stays off',
			"and a destination, mail server or App URL removed or moved here is held for the superadmin's review; a restore of this server's own backup also holds what is not in that record",
			'Mail settings, destinations and the App URL that are not text are left out or read as text at the restore, and no sender uses one (card 3004). '
		]) {
			expect(leakage.how, words).toContain(words);
		}
		expect(leakage.how.indexOf('(card 3004)')).toBeLessThan(leakage.how.indexOf('Still open:'));
		expect(leakage.how.slice(leakage.how.indexOf('Still open:'))).not.toContain('3004');
		const backup = CHECKLIST.find((entry) => entry.ref === 'A.8.13')!;
		const rule =
			"A restore keeps this server's record of where it sends, and never sends the next backup to a destination removed or moved here since the backup it restores was made: that destination is held for the superadmin's review, ";
		expect(backup.how).toContain(rule);
		expect(backup.how.indexOf(rule)).toBeLessThan(backup.how.indexOf('Still open:'));
		expect(backup.how.slice(backup.how.indexOf('Still open:'))).not.toContain('3004');
	});

	it('names every gap: a card or an accepted risk for each item short of met, and neither for a met one', () => {
		const faults: string[] = [];
		for (const item of APPLICATION_SIDE) {
			const accepted = item.accepted ?? [];
			if ((item.status === 'partly-met' || item.status === 'not-met') && item.gapCards.length === 0 && accepted.length === 0) {
				faults.push(`${item.ref}: ${item.status} with no gap card or accepted risk`);
			}
			if (item.status === 'met' && (item.gapCards.length > 0 || accepted.length > 0)) faults.push(`${item.ref}: met, with a gap card or accepted risk`);
		}
		for (const item of CHECKLIST) {
			if (!item.gapCards.every((card) => Number.isInteger(card) && card > 0)) faults.push(`${item.ref}: a card number is not a positive integer`);
			if (new Set(item.gapCards).size !== item.gapCards.length) faults.push(`${item.ref}: a card number twice`);
			for (const risk of item.accepted ?? []) {
				const fault = evidenceFault(risk);
				if (fault) faults.push(`${item.ref}: accepted ${risk.risk}: ${fault}`);
			}
		}

		expect(faults).toEqual([]);
	});

	// 6
	it('summarises the application side and the organisation side apart', () => {
		const base = { kind: 'annex-a' as const, theme: 'technological' as const, how: 'x', evidence: [], gapCards: [] };
		const fixtures: IsoItem[] = [
			{ ...base, ref: 'A.8.10', title: 'one', applicability: 'app', status: 'met', owner: 'DumpFire' },
			{ ...base, ref: 'A.8.7', title: 'two', applicability: 'supports', status: 'partly-met', owner: 'DumpFire', gapCards: [1] },
			{ ...base, ref: 'A.8.1', title: 'three', applicability: 'organisational', status: 'organisational', owner: 'the organisation' }
		];
		const zero: Record<IsoStatus, number> = { met: 0, 'partly-met': 0, 'not-met': 0, 'not-applicable': 0, organisational: 0 };

		expect(summarise(fixtures)).toEqual({
			application: { ...zero, met: 1, 'partly-met': 1 },
			organisation: { ...zero, organisational: 1 }
		});
	});
});

describe('the page load', () => {
	type Event = Parameters<typeof load>[0];
	const as = (role: string | null) => (role === null ? null : ({ id: 1, username: 'someone', email: 's@example.com', emoji: '', role } satisfies SessionUser));
	const loadAs = (role: string | null) => load({ locals: { user: as(role) } } as unknown as Event);
	/** Where the load sent the caller, if it threw a redirect. */
	const sentTo = async (role: string | null) => {
		const thrown = await Promise.resolve(loadAs(role)).then(
			() => null,
			(error: unknown) => error
		);
		return isRedirect(thrown) ? { status: thrown.status, location: thrown.location } : thrown;
	};

	// 7
	it('sends somebody who is not signed in to the login page', async () => {
		expect(await sentTo(null)).toEqual({ status: 303, location: '/login' });
	});

	// 8
	it('sends a signed-in plain user home', async () => {
		expect(await sentTo('user')).toEqual({ status: 303, location: '/' });
	});

	// 9
	it('gives an administrator and the superadmin the items, the summary and the checked-on date', async () => {
		for (const role of ['admin', 'superadmin']) {
			// Card 2922 (R7): and the settings held for review, for the superadmin's banner: none here.
			expect(await loadAs(role)).toEqual({ items: CHECKLIST, summary: summarise(CHECKLIST), checkedOn: CHECKED_ON, settingsHeld: [] });
		}
	});
});

describe('the page', () => {
	let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;
	afterEach(() => {
		if (drawn) {
			unmount(drawn.component);
			drawn.target.remove();
			drawn = null;
		}
	});

	const item = (ref: string, kind: IsoItem['kind'], applicability: IsoItem['applicability'], status: IsoStatus, theme: IsoItem['theme']): IsoItem => ({
		ref,
		kind,
		title: `Title of ${ref}`,
		theme,
		applicability,
		status,
		how: `How of ${ref}`,
		evidence: [{ path: `src/${ref}.ts` }],
		owner: applicability === 'organisational' ? 'the organisation' : 'DumpFire',
		gapCards: status === 'partly-met' ? [4242] : []
	});
	const items: IsoItem[] = [
		item('A.5.1', 'annex-a', 'organisational', 'organisational', 'organisational'),
		item('A.5.15', 'annex-a', 'app', 'partly-met', 'organisational'),
		item('A.5.37', 'annex-a', 'supports', 'met', 'organisational'),
		item('A.6.1', 'annex-a', 'organisational', 'organisational', 'people'),
		item('A.8.5', 'annex-a', 'app', 'partly-met', 'technological'),
		item('A.8.7', 'annex-a', 'supports', 'partly-met', 'technological'),
		item('4.1', 'clause', 'organisational', 'organisational', null)
	];

	function draw(data: unknown) {
		const target = document.createElement('div');
		document.body.appendChild(target);
		drawn = { component: mount(IsoPage as never, { target, props: { data } as never }), target };
		flushSync();
		return target;
	}
	const refsShown = (target: HTMLElement) => [...target.querySelectorAll('tbody td.ref')].map((cell) => cell.textContent?.trim());
	function choose(target: HTMLElement, label: string, value: string) {
		const select = [...target.querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith(label))?.querySelector('select');
		if (!select) throw new Error(`no ${label} filter`);
		select.value = value;
		select.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
	}

	// 10
	it('shows the application block and the organisation’s block apart, each with its own counts', () => {
		const zero: Record<IsoStatus, number> = { met: 0, 'partly-met': 0, 'not-met': 0, 'not-applicable': 0, organisational: 0 };
		const target = draw({
			items,
			summary: { application: { ...zero, met: 3, 'partly-met': 5 }, organisation: { ...zero, organisational: 77 } },
			checkedOn: '2026-11-17'
		});
		const block = (id: string) => target.querySelector(`section[aria-labelledby="${id}"]`)?.textContent ?? '';
		const application = block('iso-application');
		const organisation = block('iso-organisation');

		expect(application).toContain('In the application');
		expect(application).toMatch(/Met\s*3/);
		expect(application).toMatch(/Partly met\s*5/);
		expect(application).not.toContain('77');
		expect(application).not.toContain('Organisational');
		expect(organisation).toContain('The organisation');
		expect(organisation).toMatch(/Organisational\s*77/);
		expect(organisation).not.toMatch(/\b[35]\b/);
		expect(target.querySelector('.checked-on')?.textContent).toBe('2026-11-17');
	});

	// 11
	it('narrows the table by status, then applicability, then theme, and All brings every row back', () => {
		const target = draw({ items, summary: summarise(items), checkedOn: '2026-11-17' });
		expect(refsShown(target)).toHaveLength(7);
		expect(target.textContent).toContain('#4242');
		expect(target.querySelector('tbody a')).toBeNull();

		choose(target, 'Status', 'partly-met');
		expect(refsShown(target)).toEqual(['A.5.15', 'A.8.5', 'A.8.7']);

		choose(target, 'Applicability', 'app');
		expect(refsShown(target)).toEqual(['A.5.15', 'A.8.5']);

		choose(target, 'Theme', 'technological');
		expect(refsShown(target)).toEqual(['A.8.5']);

		choose(target, 'Status', 'all');
		choose(target, 'Applicability', 'application');
		expect(refsShown(target)).toEqual(['A.8.5', 'A.8.7']);

		choose(target, 'Applicability', 'all');
		choose(target, 'Theme', 'clauses');
		expect(refsShown(target)).toEqual(['Clause 4.1']);

		choose(target, 'Theme', 'all');
		expect(refsShown(target)).toEqual(['A.5.1', 'A.5.15', 'A.5.37', 'A.6.1', 'A.8.5', 'A.8.7', 'Clause 4.1']);
	});
});
