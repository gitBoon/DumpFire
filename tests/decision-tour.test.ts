/**
 * The guided tour of decision records, its pure part (card 3070, the plan
 * docs/planning/card-3070-decision-tour.md, cases 1 to 7): `cleanDetails`,
 * `detailProblems` and `deriveTour` in `$lib/decision-tour`, which the page
 * draws every stop from. The page itself is in
 * `tests/decision-tour.svelte.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { EXAMPLE_DETAILS, addDays, cleanDetails, deriveTour, detailProblems, type TourDetails } from '$lib/decision-tour';

const TODAY = '2026-11-25';
const example = () => EXAMPLE_DETAILS(TODAY);

describe('the details', () => {
	it('cleanDetails caps and trims each field, drops blank options and people, keeps at most 4 options and 5 people, and reads an unknown role as consulted (1)', () => {
		const d = cleanDetails({
			title: `  ${'t'.repeat(200)}  `,
			question: ' Why\n\n  now? ',
			board: 'b'.repeat(100),
			decider: ` ${'d'.repeat(90)} `,
			closes: '2026-13-45',
			options: ['  One ', '', '   ', 'Two', 'Three', 'Four', 'Five', 'o'.repeat(130)],
			people: [
				{ name: ' Ann ', role: 'informed', group: ` ${'g'.repeat(70)} ` },
				{ name: '', role: 'consulted', group: 'Nobody' },
				{ name: 'Bo', role: 'owner', group: '' },
				null,
				{ name: 'Cy' },
				{ name: 'Di' },
				{ name: 'Ed' },
				{ name: 'Flo' }
			]
		})!;
		expect(d.title).toBe('t'.repeat(160));
		expect(d.question).toBe('Why now?');
		expect(d.board).toBe('b'.repeat(80));
		expect(d.decider).toBe('d'.repeat(80));
		expect(d.closes).toBe('');
		expect(d.options).toEqual(['One', 'Two', 'Three', 'Four']);
		expect(d.people.map((p) => p.name)).toEqual(['Ann', 'Bo', 'Cy', 'Di', 'Ed']);
		expect(d.people[0]).toEqual({ name: 'Ann', role: 'informed', group: 'g'.repeat(60) });
		expect(d.people[1].role).toBe('consulted');
		const kept = cleanDetails({ closes: '2026-12-09', options: ['o'.repeat(130)] })!;
		expect(kept.options).toEqual(['o'.repeat(120)]);
		expect(kept.closes).toBe('2026-12-09');
		expect(cleanDetails(null)).toBeNull();
		expect(cleanDetails('a string')).toBeNull();
	});

	const broken: [string, (d: TourDetails) => TourDetails, string][] = [
		['title', (d) => ({ ...d, title: '' }), 'setup-title'],
		['question', (d) => ({ ...d, question: '' }), 'setup-question'],
		['board', (d) => ({ ...d, board: '' }), 'setup-board'],
		['closing date', (d) => ({ ...d, closes: '' }), 'setup-closes'],
		['two options', (d) => ({ ...d, options: ['Only one'] }), 'setup-opt-2'],
		['decider', (d) => ({ ...d, decider: '' }), 'setup-decider'],
		['two people', (d) => ({ ...d, people: d.people.slice(0, 1) }), 'setup-p2-name'],
		['one consulted', (d) => ({ ...d, people: d.people.map((p) => ({ ...p, role: 'informed' as const })) }), 'setup-p1-role']
	];

	it.each(broken)('detailProblems names the %s problem once, on its field (2)', (_rule, breakIt, field) => {
		const problems = detailProblems(breakIt(example()), TODAY);
		expect(problems).toHaveLength(1);
		expect(problems[0].field).toBe(field);
		expect(problems[0].message).not.toBe('');
	});

	it('detailProblems finds none in the example (2)', () => {
		expect(detailProblems(example(), TODAY)).toEqual([]);
		expect(detailProblems({ ...example(), options: [], people: [] }, TODAY).map((p) => p.field)).toEqual(['setup-opt-1', 'setup-p1-name']);
	});

	it('refuses a closing date of today and passes tomorrow; without today, any date passes (3)', () => {
		expect(detailProblems({ ...example(), closes: TODAY }, TODAY).map((p) => p.field)).toEqual(['setup-closes']);
		expect(detailProblems({ ...example(), closes: addDays(TODAY, 1) }, TODAY)).toEqual([]);
		expect(detailProblems({ ...example(), closes: '2020-01-01' })).toEqual([]);
	});
});

describe('what the stops show', () => {
	it('deriveTour, with the example: counts per option, the person cut off, the chosen option, the groups with No group last (4)', () => {
		const tour = deriveTour(example(), TODAY);
		expect(tour.options.map((o) => [o.letter, o.count])).toEqual([
			['A', 1],
			['B', 2],
			['C', 0]
		]);
		expect(tour.answered).toBe(3);
		expect(tour.cutOff.map((p) => p.name)).toEqual(['Mia Chen']);
		expect(tour.responses.map((r) => r.option)).toEqual([1, 0, 1, null]);
		expect(tour.chosen.letter).toBe('B');
		expect(tour.words.ruledBanner).toBe('Ruled by Priya Natarajan: Option B: A staggered four-day rota that covers all five days');
		expect(tour.groups.map((g) => [g.name, g.consulted, g.responded, g.votes, g.most])).toEqual([
			['Tier 1 Support', 2, 2, [1, 1, 0], 'A, B (tied)'],
			['Tier 2 Support', 1, 1, [0, 1, 0], 'B'],
			['No group', 1, 0, [0, 0, 0], '–']
		]);
		expect(tour.objector.name).toBe('Rob Hale');
		expect(tour.asker.name).toBe('Tom Ellery');
		expect(tour.closesText).toBe('2026-12-09 17:00 UTC');
		expect(tour.reminderAt).toBe('2026-12-08 17:00 UTC');
		// Ten days before closing, as that is after today.
		expect(tour.openedDay).toBe('2026-11-29');
	});

	it('lists No group last even where the first consulted person is in none (6a)', () => {
		const people = example().people;
		const d = { ...example(), people: [people[3], ...people.slice(0, 3), people[4]] };
		expect(deriveTour(d, TODAY).groups.map((g) => g.name)).toEqual(['Tier 1 Support', 'Tier 2 Support', 'No group']);
	});

	it('with two consulted: nobody is cut off, and the release is refused under 3 answers (5)', () => {
		const d = { ...example(), people: [example().people[0], example().people[1]] };
		const tour = deriveTour(d, TODAY);
		expect(tour.cutOff).toEqual([]);
		expect(tour.answered).toBe(2);
		expect(tour.release).toEqual({ refused: true });
		expect(tour.words.cutOff).toBe('The decision is still open: ruling now is early.');
	});

	it('withholds a count of 1, and then the number who answered too (6)', () => {
		const tour = deriveTour(example(), TODAY);
		expect(tour.release.refused).toBe(false);
		if (tour.release.refused) return;
		expect(tour.release.rows.map((r) => [r.letter, r.shown])).toEqual([
			['A', 'withheld'],
			['B', 'withheld'],
			['C', '0']
		]);
		expect(tour.release.answered).toBe('withheld');
	});

	it('names the second consulted person as the objector where nobody is informed (7)', () => {
		const d = { ...example(), people: example().people.filter((p) => p.role === 'consulted') };
		expect(deriveTour(d, TODAY).objector.name).toBe('Aisha Bello');
	});
});
