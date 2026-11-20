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

	it('(cc) card 2997: A.5.17 names the writer of a password replaced and the restore’s password step as evidence, and each exists', () => {
		const item = CHECKLIST.find((entry) => entry.ref === 'A.5.17')!;
		for (const symbol of ['recordPasswordReplaced', 'applyPasswordRulings']) {
			const evidence = item.evidence.find((e) => e.symbol === symbol);
			expect(evidence, symbol).toBeDefined();
			expect(evidenceFault(evidence!), symbol).toBeNull();
		}
		expect(item.how).toContain('(card 2997)');
		// The code review's FP8: no overclaim, the unsealed backup's residual for an account not here named with its card.
		expect(item.how).toContain('can still give an account that is not on this server any password (card 3009)');
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
