<script lang="ts">
	/**
	 * How decisions work: a guided tour of decision records (card 3070, the
	 * plan docs/planning/card-3070-decision-tour.md), reached from the
	 * register's "How it works" link.
	 *
	 * A teaching page with no data of its own: no load, no fetch, nothing
	 * stored on the server (ruling 2). The presenter types the decision they
	 * want to show, or fills the form with an example, and ten stops walk it
	 * from a draft to its ruling and beyond, each beside an illustrative screen
	 * drawn from those details, marked so. What each stop shows is worked out
	 * by `deriveTour` (`$lib/decision-tour`); the words of a copied screen are
	 * the app's own (`decision-words.ts`, the decision pages). Every value is
	 * interpolated as text, never as HTML. Each stop also says where to click
	 * in the real app, so the tour doubles as a how-to.
	 *
	 * The details are kept in this browser alone (ruling 5): in `localStorage`
	 * under the signed-in account's own key (`tourStorageKey`), or in
	 * `sessionStorage` where the page knows no account. They are read in
	 * `onMount` and written on Start, each wrapped in try/catch: the page works
	 * without storage. The setup fields have no `name`, so nothing typed reaches
	 * an address even before the page's script runs. The stop is in the
	 * address, `#setup` or `#stop-1` to `#stop-10`, read on mount and on every
	 * `hashchange`; an address naming no stop is replaced with the one shown,
	 * and with no valid details saved any stop shows the setup form with "Enter
	 * the details first". Back and Next, the step list and the Left and Right
	 * keys (never in a field, a menu, a dialog or a scrolling table) move
	 * between stops; the stop's heading takes the focus after Start, Edit
	 * details, a step link, or Back or Next reaching the first or last stop
	 * (where the button pressed is turned off), and the page scrolls without
	 * motion where `prefers-reduced-motion` asks.
	 */
	import { onMount, tick } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/stores';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
	import {
		AGENT_UNREVIEWED,
		PRIVATE_BAND,
		RESULTS_NOT_RELEASED,
		STATUS_WORDS,
		answeredByWords,
		flagReplyWhoSees,
		flagUnrepliedWords,
		toldWords,
		whoSeesStatement
	} from '$lib/decision-words';
	import {
		EXAMPLE_DETAILS,
		TOUR_CLOSES_WITHIN_DAYS,
		TOUR_LIMITS,
		TOUR_MAX_OPTIONS,
		TOUR_MAX_PEOPLE,
		TOUR_STOPS,
		TOUR_STORAGE_KEY,
		addDays,
		cleanDetails,
		deriveTour,
		detailProblems,
		todayIso,
		tourStorageKey,
		type DetailProblem,
		type TourDetails,
		type TourRole
	} from '$lib/decision-tour';
	import { theme, themeIcon } from '$lib/stores/theme';

	/** The stops, in order, as the step list and the progress line name them. */
	const STEPS = [
		'What a decision record is',
		'Drafting it',
		'Opening it',
		'A participant answers',
		"The decider's results",
		'The ruling',
		'Everywhere else in DumpFire',
		'Taking it outside',
		'Preparing it through the API',
		'Privacy built in'
	] as const;
	const LETTERS = ['A', 'B', 'C', 'D'] as const;

	type FormPerson = { name: string; role: TourRole; group: string };
	const emptyPeople = (): FormPerson[] => Array.from({ length: TOUR_MAX_PEOPLE }, () => ({ name: '', role: 'consulted', group: '' }));

	/** What the setup form holds, as typed. */
	let form = $state({ title: '', question: '', board: '', closes: '', decider: '', options: ['', '', '', ''], people: emptyPeople() });
	/** The details the stops are drawn from: saved, and valid. */
	let details = $state<TourDetails | null>(null);
	/** 0 is the setup form; 1 to 10 the stops. */
	let current = $state(0);
	let needsSetup = $state(false);
	let exampleShown = $state(false);
	let problems = $state<DetailProblem[]>([]);
	const today = todayIso();

	const tour = $derived(details === null ? null : deriveTour(details, today));
	const invalid = $derived(new Set(problems.map((problem) => problem.field)));

	let stage = $state<HTMLElement>();
	let errorsBox = $state<HTMLElement>();
	let focusOnShow = false;
	let reduceMotion = false;

	/** A field's problem attributes: `aria-invalid` and the errors box as its description, while it has a problem. */
	const marks = (id: string) => (invalid.has(id) ? { 'aria-invalid': 'true' as const, 'aria-describedby': 'setup-errors' } : {});

	// ─── Storage (optional) ──────────────────────────────────────────────────

	/** Where the details are kept: the account's own `localStorage` key, or `sessionStorage` with no account known. */
	function kept(): { area: Storage; key: string } {
		const id: unknown = $page.data.user?.id;
		return typeof id === 'number' ? { area: window.localStorage, key: tourStorageKey(id) } : { area: window.sessionStorage, key: TOUR_STORAGE_KEY };
	}

	function load(): unknown {
		try {
			const { area, key } = kept();
			const raw = area.getItem(key);
			return raw ? JSON.parse(raw) : null;
		} catch {
			return null;
		}
	}

	function store(d: TourDetails) {
		try {
			const { area, key } = kept();
			area.setItem(key, JSON.stringify(d));
		} catch {
			// The page works without storage: a reload starts at the form.
		}
	}

	// ─── The form ────────────────────────────────────────────────────────────

	function fillForm(d: TourDetails) {
		form.title = d.title;
		form.question = d.question;
		form.board = d.board;
		form.closes = d.closes;
		form.decider = d.decider;
		form.options = Array.from({ length: TOUR_MAX_OPTIONS }, (_, i) => d.options[i] ?? '');
		form.people = Array.from({ length: TOUR_MAX_PEOPLE }, (_, i) => {
			const person = d.people[i];
			return person ? { ...person } : { name: '', role: 'consulted' as const, group: '' };
		});
	}

	function fillExample() {
		fillForm(EXAMPLE_DETAILS(todayIso()));
		exampleShown = true;
		problems = [];
	}

	async function start(event: SubmitEvent) {
		event.preventDefault();
		const d = cleanDetails($state.snapshot(form))!;
		// The role problem marks the first row with a name typed, which is the first participant the details hold.
		const firstNamed = form.people.findIndex((person) => person.name.trim() !== '') + 1;
		const found = detailProblems(d, todayIso()).map((problem) =>
			problem.field === 'setup-p1-role' && firstNamed > 0 ? { ...problem, field: `setup-p${firstNamed}-role` } : problem
		);
		problems = found;
		if (found.length > 0) {
			await tick();
			const field = document.getElementById(found[0].field);
			if (field) field.focus();
			else errorsBox?.focus();
			return;
		}
		details = d;
		store(d);
		focusOnShow = true;
		go(1);
	}

	// ─── Routing ─────────────────────────────────────────────────────────────

	/** The stop an address names: 0 for `#setup`, 1 to 10 for `#stop-N`, null for anything else. */
	function parseHash(hash: string): number | null {
		const h = hash.replace(/^#/, '');
		if (h === 'setup') return 0;
		const match = /^stop-([1-9][0-9]?)$/.exec(h);
		const n = match ? Number(match[1]) : 0;
		return n >= 1 && n <= TOUR_STOPS ? n : null;
	}

	function go(n: number) {
		const target = n === 0 ? '#setup' : `#stop-${n}`;
		if (location.hash === target) void show(n);
		else location.hash = target;
	}

	/** An address naming no stop is replaced with the one shown, so that a reload stays on it. */
	function replaceHash(target: string) {
		try {
			replaceState(target, {});
		} catch {
			// Before the router has started: the address keeps what it had.
		}
	}

	function route() {
		const n = parseHash(location.hash);
		const named = location.hash !== '' && location.hash !== '#';
		if (details === null) {
			needsSetup = n !== null && n > 0;
			if (named && n === null) replaceHash('#setup');
			void show(0);
			return;
		}
		needsSetup = false;
		if (named && n === null) replaceHash('#stop-1');
		void show(n === null ? 1 : n);
	}

	async function show(n: number) {
		current = n;
		await tick();
		if (stage && stage.getBoundingClientRect().top < 0 && typeof stage.scrollIntoView === 'function') {
			stage.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
		}
		if (focusOnShow) {
			focusOnShow = false;
			document.getElementById(`h-${n}`)?.focus({ preventScroll: true });
		}
	}

	function stepClicked(n: number) {
		const target = n === 0 ? '#setup' : `#stop-${n}`;
		if (location.hash === target) document.getElementById(`h-${n}`)?.focus({ preventScroll: true });
		else focusOnShow = true;
	}

	function editDetails() {
		if (details !== null) fillForm(details);
		problems = [];
		focusOnShow = true;
		go(0);
	}

	/** Back or Next: reaching the first or last stop turns the button pressed off, so the heading takes the focus. */
	function step(to: number) {
		if (to < 1 || to > TOUR_STOPS) return;
		if (to === 1 || to === TOUR_STOPS) focusOnShow = true;
		go(to);
	}

	function onKey(event: KeyboardEvent) {
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const target = event.target as HTMLElement | null;
		if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
		// A menu and a dialog have arrow keys of their own, and a table that scrolls sideways is scrolled with them.
		if (target instanceof Element && target.closest('[role="menu"], [role="dialog"], .scroll')) return;
		if (current < 1) return;
		if (event.key === 'ArrowRight' && current < TOUR_STOPS) {
			event.preventDefault();
			go(current + 1);
		} else if (event.key === 'ArrowLeft' && current > 1) {
			event.preventDefault();
			go(current - 1);
		}
	}

	onMount(() => {
		reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
		const saved = cleanDetails(load());
		if (saved !== null && detailProblems(saved).length === 0) {
			details = saved;
			fillForm(saved);
		}
		route();
	});

	const progress = $derived(current > 0 ? `Stop ${current} of ${TOUR_STOPS}: ${STEPS[current - 1]}` : '');
</script>

<svelte:head>
	<title>How decisions work: DumpFire</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<svelte:window onhashchange={route} onkeydown={onKey} />

{#snippet where(words: string)}
	<p class="where"><b>Where in DumpFire:</b> {words}</p>
{/snippet}

{#snippet bar(path: string)}
	<div class="mock-bar"><span class="app">DumpFire</span><span class="path">{path}</span></div>
{/snippet}

{#snippet chip(status: string, cls: string)}
	<span class="chip {cls}">{STATUS_WORDS[status]}</span>
{/snippet}

<div class="tour-page">
	<header class="tour-header glass">
		<div class="tour-header-inner">
			<a href="/" class="header-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<p class="crumb"><a href="/decisions">Decisions</a> / How it works</p>
			<HeaderMenu label="Theme" triggerClass="btn-ghost" triggerTitle="Change theme">
				{#snippet trigger()}<span aria-hidden="true">{themeIcon($theme)}</span>{/snippet}
				<ThemeMenuItems heading={false} />
			</HeaderMenu>
		</div>
	</header>

	<div class="wrap">
		<div class="masthead">
			<p class="eyebrow">DumpFire · Decisions</p>
			<h1>Decision Records, step by step</h1>
			<p class="lede">How a question goes from a draft to a ruling: who is asked, what they say, who decides, and what is kept afterwards.</p>
			<p class="illustrative">Illustrative screens; your data will differ</p>
		</div>

		<div class="tour">
			<nav class="steps" aria-label="Tour stops">
				<ol>
					<li>
						<a href="#setup" aria-current={current === 0 ? 'step' : undefined} onclick={() => stepClicked(0)}><span class="n">0</span><span>Set up your demo</span></a>
					</li>
					{#each STEPS as label, i (label)}
						<li>
							<a href="#stop-{i + 1}" aria-current={current === i + 1 ? 'step' : undefined} onclick={() => stepClicked(i + 1)}
								><span class="n">{i + 1}</span><span>{label}</span></a
							>
						</li>
					{/each}
				</ol>
			</nav>

			<main class="stage" bind:this={stage}>
				{#if current === 0 || tour === null}
					<section class="setup" id="setup" aria-labelledby="h-0">
						<div class="setup-head">
							<p class="eyebrow">Before the tour</p>
							<h2 id="h-0" tabindex="-1">Set up your demo</h2>
							<p>
								Enter the decision you want to show. Every screen in the tour is drawn from these details. The responses and results are made up from the
								people and options you enter, and are marked as example responses.
							</p>
							<p class="hint">The details are kept in this browser only, so a reload keeps them.</p>
						</div>
						{#if needsSetup}
							<p class="needs-setup" data-note="needs-setup">Enter the details first, or fill the form with an example, to start the tour.</p>
						{/if}
						<form novalidate onsubmit={start} data-form="setup">
							<div id="setup-errors" class="form-errors" role="alert" tabindex="-1" bind:this={errorsBox} hidden={problems.length === 0}>
								{#if problems.length > 0}
									<p>Fix these to start the tour:</p>
									<ul>
										{#each problems as problem (problem.field + problem.message)}
											<li>{problem.message}</li>
										{/each}
									</ul>
								{/if}
							</div>
							{#if exampleShown}
								<p class="example-note" data-note="example">Filled with example values. Change any of them before you start.</p>
							{/if}

							<fieldset>
								<legend>The decision</legend>
								<div class="fgrid">
									<div class="field full">
										<label for="setup-title">Title</label>
										<input id="setup-title" type="text" maxlength={TOUR_LIMITS.title} autocomplete="off" bind:value={form.title} {...marks('setup-title')} />
									</div>
									<div class="field full">
										<label for="setup-question">The question and its background</label>
										<textarea id="setup-question" maxlength={TOUR_LIMITS.question} rows="3" bind:value={form.question} {...marks('setup-question')}></textarea>
										<span class="hint">One or two sentences: what is happening and what is asked.</span>
									</div>
									<div class="field">
										<label for="setup-board">Board</label>
										<input id="setup-board" type="text" maxlength={TOUR_LIMITS.board} autocomplete="off" bind:value={form.board} {...marks('setup-board')} />
									</div>
									<div class="field">
										<label for="setup-closes">Closing date</label>
										<input id="setup-closes" type="date" min={addDays(today, 1)} max={addDays(today, TOUR_CLOSES_WITHIN_DAYS)} bind:value={form.closes} {...marks('setup-closes')} />
										<span class="hint">After today, and at most a year ahead. The tour shows it at 17:00 UTC.</span>
									</div>
								</div>
							</fieldset>

							<fieldset>
								<legend>Options</legend>
								<p class="hint">Two to four. Each is given a letter, in this order.</p>
								{#each LETTERS as letter, i (letter)}
									<div class="opt-row">
										<span class="letter" aria-hidden="true">{letter}</span>
										<div class="field">
											<label for="setup-opt-{i + 1}">Option {letter}{i >= 2 ? ' (optional)' : ''}</label>
											<input id="setup-opt-{i + 1}" type="text" maxlength={TOUR_LIMITS.option} autocomplete="off" bind:value={form.options[i]} {...marks(`setup-opt-${i + 1}`)} />
										</div>
									</div>
								{/each}
							</fieldset>

							<fieldset>
								<legend>People</legend>
								<div class="field">
									<label for="setup-decider">The decider</label>
									<input id="setup-decider" type="text" maxlength={TOUR_LIMITS.name} autocomplete="off" bind:value={form.decider} {...marks('setup-decider')} />
									<span class="hint">The person who rules. On a real board, someone who can edit it.</span>
								</div>
								<p class="plabel">Participants</p>
								<p class="hint">
									Two to five. Consulted people are asked for their view; informed people are kept told and give no response. A group is optional.
								</p>
								<div>
									{#each form.people as person, i (i)}
										<div class="prow">
											<div class="field">
												<label for="setup-p{i + 1}-name">Participant {i + 1}{i >= 2 ? ' (optional)' : ''}</label>
												<input id="setup-p{i + 1}-name" type="text" maxlength={TOUR_LIMITS.name} autocomplete="off" bind:value={person.name} {...marks(`setup-p${i + 1}-name`)} />
											</div>
											<div class="field">
												<label for="setup-p{i + 1}-role">Role</label>
												<select id="setup-p{i + 1}-role" bind:value={person.role} {...marks(`setup-p${i + 1}-role`)}>
													<option value="consulted">Consulted</option>
													<option value="informed">Informed</option>
												</select>
											</div>
											<div class="field">
												<label for="setup-p{i + 1}-group">Group (optional)</label>
												<input id="setup-p{i + 1}-group" type="text" maxlength={TOUR_LIMITS.group} autocomplete="off" bind:value={person.group} />
											</div>
										</div>
									{/each}
								</div>
							</fieldset>

							<div class="form-actions">
								<button type="button" class="btn" data-action="fill-example" onclick={fillExample}>Fill with an example</button>
								<button type="submit" class="btn primary" data-action="start">Start the tour</button>
							</div>
						</form>
					</section>
				{:else}
					{@const d = tour.details}
					{@const n = current}
					<section class="stop" id="stop-{n}" aria-labelledby="h-{n}" data-stop={n}>
						<div class="stop-text">
							<p class="eyebrow">Stop {n} of {TOUR_STOPS}</p>
							<h2 id="h-{n}" tabindex="-1">{STEPS[n - 1]}</h2>
							{#if n === 1}
								<p>
									A decision record puts one question to the people it affects, here <b data-v="title">{d.title}</b> (board: <b>{d.board}</b>). It keeps who
									was asked, what each of them said, and who decided and why.
								</p>
								<p>
									Everything is added to the record and nothing in it is edited. A changed answer is kept beside the earlier one, so the record can be read
									back long after the ruling.
								</p>
								<p>
									A decision moves from Draft to Open, then Awaiting ruling once it closes for input, then Ruled. A later ruling can supersede it, and it can
									be withdrawn with a reason.
								</p>
								{@render where(
									"Views → Decisions on the dashboard lists every decision you can see; on a board, More → Go to → Decisions lists that board's. A decision's title opens its page."
								)}
							{:else if n === 2}
								<p>
									On the board, <b>More → Go to → Decisions</b>, then <b>New decision</b>, opens the editor. Write the situation and the question, add the
									options (each is given a letter), and choose <b>One choice</b> or <b>A score for each option, 0 to 5</b>. A decision with survey questions
									and no options is a survey.
								</p>
								<p>
									Pick the decider, here <b>{d.decider}</b>. Tick who is <b>Consulted</b> and switch anyone to <b>Informed</b>; ticking a group ticks its
									active members. Set the closing time in UTC.
								</p>
								<p>
									The readability check lists anything that stops the decision opening, and warnings worth a look. <b>Preview as a participant</b> shows the
									page as one of them will see it, and records nothing.
								</p>
								<div class="before" data-note="before-you-start">
									<p class="before-head">Before you start</p>
									<ul>
										<li>
											Participants are chosen from the people directory. An administrator adds people there: <b>More → Admin</b> on the dashboard, then
											<b>People Directory</b>. You must be in it yourself to be sent a dry run.
										</li>
										<li>Mail must be set up, in <b>Admin → Email / SMTP</b>, or the readability check stops <b>Open</b>.</li>
									</ul>
								</div>
								{@render where(
									'Open a board, then More → Go to → Decisions, then New decision (needs edit rights on the board); give it a title and the editor opens. Save keeps everything; the readability check lists what stops it opening.'
								)}
							{:else if n === 3}
								<p><b>Open</b> asks first and says how many people it is about to mail. Then every participant is mailed an invitation.</p>
								<p>
									Someone with no account gets a personal link. It needs no account and no password, and the page tells them not to share it. Each new email
									carries a new link and the old one stops working.
								</p>
								<p>
									About a day before the closing time, each consulted person who has not answered gets one short reminder. People who are only informed never
									get one.
								</p>
								{@render where('In the editor, above its sections: Preview as a participant, Send me a dry run, then Open.')}
							{:else if n === 4}
								<p>
									<b>{tour.firstConsulted.name}</b> opens the link, on a phone or at a desk, and reads the decision first. Then they pick an option (or score
									each), or say <b>I abstain</b> or <b>I have no concerns</b>, answer any survey questions, add a comment if they want, and press
									<b>Send my response</b>. They can change it while the decision is open; each change is kept and the latest counts.
								</p>
								<p>Anyone included can ask a clarifying question. Everyone included sees it and its answer, without the asker's name.</p>
								<p>
									Anyone included, consulted or informed, can also <b>object</b>, with a reason they must give, or <b>ask to talk</b> to the decider. Only the
									decider and administrators see those, with the person's name.
								</p>
								{@render where(
									"The invitation email's link opens it. Signed in: Views → Decisions, the Waiting for my response tab, then the decision's title."
								)}
							{:else if n === 5}
								<p>
									<b>Results and ruling</b> opens for <b>{d.decider}</b> and DumpFire's administrators, and nobody else. It shows how each option is doing, each
									response with the person's name, and who has not answered yet.
								</p>
								<p>Under the totals, a table breaks the round down by group, with people in no group under No group. It is never released.</p>
								<p>
									Open questions, objections and requests to talk are listed with their replies. <b>Rule</b> stays off until every objection has an answer,
									and a request to talk with no outcome recorded needs a tick first.
								</p>
								{@render where("The decision's page: Results and ruling (the decider and administrators).")}
							{:else if n === 6}
								<p>
									<b>{d.decider}</b> picks an option or <b>None of these</b>, says why (required) and adds any conditions, then confirms with their password,
									plus a code from their authenticator app once they have set up two-step sign-in. Every participant is mailed the ruling, its reason and
									its conditions, with no figures.
								</p>
								<p>Ruling before the closing time is recorded as early, and anyone who has not answered is recorded as cut off.</p>
								<p>
									After ruling, the decider may release the totals and comments without names. Figures that could single someone out read <b>withheld</b>,
									and a release needs at least 3 answers. Later, <b>Supersede…</b> starts a new draft from the ruled one.
								</p>
								{@render where(
									"Results and ruling: the ruling form, then Rule…; once ruled, Release results… on the same page. Supersede… is on the decision's page."
								)}
							{:else if n === 7}
								<p>
									<b>Views → Decisions</b> opens the register: every decision you can see, across boards, with <b>Waiting for my response</b> and
									<b>Waiting on me</b> tabs. <b>My record</b> shows what you were asked and what you said.
								</p>
								<p>
									Cards can be linked to the decision. A card marked <b>Waits on this decision</b> shows <b>Blocked</b> on the board, in To Do and in the plan
									until <b>{d.title}</b> is ruled. Someone who cannot see the decision sees the card as if it waited on nothing.
								</p>
								{@render where(
									"Dashboard: Views → Decisions, with My record at the top of the register. On the decision's page, Linked cards finds a card to link and marks it Waits on this decision; the card's window then lists it under Decisions."
								)}
							{:else if n === 8}
								<p>
									The decision's page offers two PDFs. The <b>Shareable copy</b> holds what everyone who may view it already sees: no responses, no names of
									the people consulted, no objections. The <b>Full record</b> is for the decider and administrators, carries a red Private band on every page,
									and each download is noted on the record.
								</p>
								<p>
									A board's webhooks can opt in to <code>decision.opened</code>, <code>decision.ruled</code>, <code>decision.withdrawn</code> and
									<code>decision.superseded</code>. Each event names the decision and its status, and never a person.
								</p>
								<p>
									Both PDFs are downloaded by a person on the decision's page. Neither is offered for a draft, on the personal-link page, or through an API
									key.
								</p>
								{@render where("The decision's page: Shareable copy (PDF), and Full record (PDF) for the decider and administrators.")}
							{:else if n === 9}
								<p>
									Yes, a decision can be set up over the API. An agent with an API key can create the draft on a board it can edit, write its text, options
									and survey questions, and choose the participants and the decider, all before the decision is first opened.
								</p>
								<p>
									Every section an agent writes carries <b>{AGENT_UNREVIEWED}</b> until a person presses <b>Mark reviewed</b>. Editing the text does not
									remove the label.
								</p>
								<p>
									Anything that mails people, takes a view, or rules stays with a person on the decision's page. A key never sees anyone's email address or
									who asked a question.
								</p>
								{@render where(
									'API keys are made on your account page (your name at the foot of every page), under API Keys. Every call is in the API Reference at /docs.'
								)}
							{:else}
								<p>
									Each part of a decision has its own audience, and the page says who that is beside every form. Survey answers are never released.
									Objections and requests to talk reach only the person, the decider and administrators.
								</p>
								<p>
									Webhooks never carry a name, a choice or a count, and an API key never sees an objection. Nothing on the record is edited: replies cannot be
									changed and an objection cannot be withdrawn.
								</p>
								{@render where("Each form on the decision's page says, beside it, who will see what you write there.")}
							{/if}
						</div>

						{#if n === 1}
							<figure class="mock" aria-label="Illustrative screen: a decision's page and its record">
								{@render bar('/decisions/48')}
								<div class="mock-body">
									<div class="m-section">
										<p class="m-muted">Board: {d.board}</p>
										<p class="m-title">{d.title}</p>
										<div class="m-meta">
											{@render chip('open', 'st-open')}<span>Decides: <b>{d.decider}</b></span><span>Closes <b>{tour.closesText}</b></span>
										</div>
									</div>
									<div class="m-section">
										<p class="m-sub">Statuses</p>
										<ul class="status-row" aria-label="The statuses a decision moves through">
											<li>{@render chip('draft', 'st-draft')}</li>
											<li class="arrow" aria-hidden="true">→</li>
											<li>{@render chip('open', 'st-open')}</li>
											<li class="arrow" aria-hidden="true">→</li>
											<li>{@render chip('awaiting_ruling', 'st-await')}</li>
											<li class="arrow" aria-hidden="true">→</li>
											<li>{@render chip('ruled', 'st-ruled')}</li>
										</ul>
										<ul class="status-row" aria-label="Other endings">
											<li>{@render chip('superseded', 'st-super')}</li>
											<li>{@render chip('withdrawn', 'st-withdrawn')}</li>
										</ul>
									</div>
									<div class="m-section">
										<p class="m-sub">Record (decider and administrators)</p>
										<ol class="m-record">
											{#each tour.record as row, i (i)}
												<li><span class="t">{row.at}</span><span class="what">{row.what}</span></li>
											{/each}
										</ol>
									</div>
								</div>
							</figure>
						{:else if n === 2}
							<figure class="mock" aria-label="Illustrative screen: the decision editor">
								{@render bar('/decisions/48/edit')}
								<div class="mock-body">
									<div class="m-meta">{@render chip('draft', 'st-draft')}<span>Unsaved changes</span></div>
									<div class="m-field"><label for="m2-title">Title</label><input type="text" id="m2-title" readonly tabindex="-1" value={d.title} /></div>
									<div class="m-field"><label for="m2-question">The question</label><textarea id="m2-question" readonly tabindex="-1" rows="2" value={d.question}></textarea></div>
									<div class="m-section">
										<p class="m-label">Options</p>
										<div class="m-opts">
											{#each tour.options as option, i (option.letter)}
												{@const lastOne = i === tour.options.length - 1}
												<div class="m-opt">
													<div class="head"><span class="letter">{option.letter}</span><span>{option.title}</span></div>
													<span class="line">Pros · Cons</span>
													<span class="line" class:missing={lastOne}>{lastOne ? 'No commercial note' : 'Commercial note'}</span>
												</div>
											{/each}
										</div>
									</div>
									<div class="m-two">
										<fieldset class="m-box soft">
											<legend class="m-label">How people answer</legend>
											<label class="m-choice" for="m2-mode-one"><input type="radio" id="m2-mode-one" name="m2-mode" checked disabled /><span>One choice</span></label>
											<label class="m-choice" for="m2-mode-score"
												><input type="radio" id="m2-mode-score" name="m2-mode" disabled /><span>A score for each option, 0 to 5</span></label
											>
										</fieldset>
										<div class="m-box soft">
											<div class="m-field"><label for="m2-closes">Closing time (UTC)</label><input type="text" id="m2-closes" readonly tabindex="-1" value={tour.closesText} /></div>
											<div class="m-field">
												<label for="m2-decider">Decider</label><select id="m2-decider" disabled><option>{d.decider}</option></select>
											</div>
										</div>
									</div>
									<div class="m-section">
										<p class="m-label">Survey questions <span class="m-muted">(example)</span></p>
										<div class="m-box soft">
											<p><b>How ready is your team for this change?</b></p>
											<p class="m-muted">A number on a scale, 1 (Not ready) to 5 (Ready now). Must be answered.</p>
										</div>
										<div class="m-btns"><button type="button" class="m-btn" disabled>+ Add survey question</button></div>
									</div>
									<div class="m-section">
										<p class="m-label">Participants</p>
										<ul class="m-people">
											{#each d.people as person, i (i)}
												<li>
													<input type="checkbox" id="m2-p-{i}" checked disabled aria-label="Included: {person.name}" />
													<span class="who">{person.name} <span class="grp">· {person.group || 'No group'}</span></span>
													<span class="chip chip-role" class:informed={person.role === 'informed'}>{person.role === 'informed' ? 'Informed' : 'Consulted'}</span>
												</li>
											{/each}
										</ul>
									</div>
									<div class="m-box warn">
										<p><b>Readability</b></p>
										<p>Nothing stops this decision being opened.</p>
										<p class="m-label">Worth a look first</p>
										<ul class="m-list"><li>{tour.words.warnLine}</li></ul>
									</div>
									<div class="m-btns">
										<button type="button" class="m-btn" disabled>Save</button>
										<button type="button" class="m-btn" disabled>Preview as a participant</button>
										<button type="button" class="m-btn" disabled>Send me a dry run</button>
										<button type="button" class="m-btn primary" disabled>Open</button>
									</div>
								</div>
							</figure>
						{:else if n === 3}
							<figure class="mock" aria-label="Illustrative screen: opening the decision and the mail that follows">
								{@render bar('/decisions/48/edit')}
								<div class="mock-body">
									<div class="m-box accent">
										<p><b>Open this decision?</b></p>
										<p>{tour.words.openConfirm}</p>
										<div class="m-btns">
											<button type="button" class="m-btn" disabled>Cancel</button><button type="button" class="m-btn primary" disabled>{tour.words.openButton}</button>
										</div>
									</div>
									<div class="m-section">
										<p class="m-label">An invitation, in outline, as a consulted person without an account receives it</p>
										<div class="m-box soft">
											<p class="m-muted">To: {tour.firstConsulted.name}</p>
											<p>Your view is asked on <b>{d.title}</b> by {tour.closesText}. {d.decider} decides.</p>
											<p><code>/decision-link/•••••••••••</code></p>
											<p class="m-muted">The page it opens says: This address is personal to you: do not share it.</p>
										</div>
									</div>
									<div class="m-section">
										<p class="m-label">Delivery (author, decider and administrators)</p>
										<!-- A table that scrolls sideways must take the focus, or a keyboard cannot scroll it (as the To Do page). -->
										<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
										<div class="scroll" tabindex="0" role="region" aria-label="Delivery table">
											<table class="m-table">
												<thead><tr><th scope="col">Participant</th><th scope="col">Role</th><th scope="col">Latest mail</th></tr></thead>
												<tbody>
													{#each d.people as person, i (i)}
														<!-- The delivery panel's words: the mail, its moment and its outcome. -->
														<tr><td>{person.name}</td><td>{person.role === 'informed' ? 'Informed' : 'Consulted'}</td><td>Invitation, {tour.invitedAt}: sent</td></tr>
													{/each}
												</tbody>
											</table>
										</div>
										<div class="m-btns"><button type="button" class="m-btn" disabled>Resend</button></div>
										{#if tour.informed.length > 0}
											<p class="m-muted">
												An informed person is told, not asked: {tour.informed[0].name}'s page says "{toldWords(
													{ kind: 'invited', at: `${tour.openedDay} 09:15:00`, delivered: true, sentAs: 'informed' },
													''
												)}"
											</p>
										{/if}
									</div>
									<div class="m-box warn">
										{#if tour.reminderAt !== null}
											<p><b>Reminder due {tour.reminderAt}</b></p>
											<p>One reminder to each consulted person who has not answered: the title, the closing time in UTC, who decides, and how to open it.</p>
										{:else}
											<p><b>No reminder</b></p>
											<p>This decision closes less than 25 hours after it is opened, so no reminder is sent.</p>
										{/if}
									</div>
								</div>
							</figure>
						{:else if n === 4}
							<figure class="mock" aria-label="Illustrative screen: a participant's decision page on a phone">
								{@render bar('/decision-link/•••')}
								<div class="mock-body phone">
									<p class="m-box accent">
										{toldWords({ kind: 'invited', at: `${tour.openedDay} 09:15:00`, delivered: true, sentAs: 'consulted' }, '')}
									</p>
									<p class="m-title">{d.title}</p>
									<p>{d.question}</p>
									<p class="m-muted">Asked of you: choose one option by {tour.closesText}.</p>
									<p class="m-box soft m-muted">{whoSeesStatement(d.decider)}</p>
									<fieldset class="m-section bare">
										<legend class="m-sub">Your response</legend>
										<div class="m-section">
											{#each tour.options as option (option.letter)}
												<label class="m-choice" for="m4-opt-{option.index}"
													><input type="radio" id="m4-opt-{option.index}" name="m4-opt" disabled checked={tour.firstChoice === option.index} /><span
														><b>{option.letter}</b> {option.title}</span
													></label
												>
											{/each}
										</div>
										<label class="m-choice" for="m4-abstain"><input type="radio" id="m4-abstain" name="m4-opt" disabled /><span>I abstain</span></label>
										<label class="m-choice" for="m4-nc"><input type="radio" id="m4-nc" name="m4-opt" disabled /><span>I have no concerns</span></label>
									</fieldset>
									<div class="m-field">
										<label for="m4-scale">How ready is your team for this change? (example survey question, 1 to 5)</label><input
											type="text"
											id="m4-scale"
											readonly tabindex="-1"
											value="4"
										/>
									</div>
									<div class="m-field">
										<label for="m4-comment">Your comment (optional)</label><textarea id="m4-comment" readonly tabindex="-1" rows="2" value="I would like a review after three months."></textarea>
									</div>
									<div class="m-btns"><button type="button" class="m-btn primary" disabled>Send my response</button></div>
									<div class="m-section">
										<p class="m-sub">Questions and answers</p>
										<div class="m-field">
											<label for="m4-question">Your question</label><textarea id="m4-question" readonly tabindex="-1" rows="2" value="When would this start, if it is chosen?"></textarea>
										</div>
										<div class="m-btns"><button type="button" class="m-btn" disabled>Send my question</button></div>
									</div>
									<div class="m-section">
										<p class="m-sub">Objections and requests to talk</p>
										<p class="m-label">I object</p>
										<div class="m-field">
											<label for="m4-why">Why you cannot live with this decision (required)</label><textarea id="m4-why" readonly tabindex="-1" rows="2"></textarea>
										</div>
										<div class="m-btns"><button type="button" class="m-btn" disabled>Send my objection</button></div>
										<p class="m-label">I need to talk to the decider</p>
										<div class="m-field">
											<label for="m4-note">A note for the decider (optional)</label><textarea id="m4-note" readonly tabindex="-1" rows="1"></textarea>
										</div>
										<div class="m-btns"><button type="button" class="m-btn" disabled>Ask to talk</button></div>
									</div>
								</div>
							</figure>
						{:else if n === 5}
							<figure class="mock" aria-label="Illustrative screen: the results page with example responses">
								{@render bar('/decisions/48/results')}
								<div class="mock-body">
									<div class="m-meta">{@render chip('open', 'st-open')}<span>Round 1</span><span class="chip st-draft">example responses</span></div>
									<div class="m-section">
										<p class="m-sub">{tour.words.totalsCaption}</p>
										<div class="bars">
											{#each tour.options as option (option.letter)}
												<div class="bar-row">
													<span class="lab"><b>{option.letter}</b><span>{option.title}</span></span>
													<span class="val">{option.count}</span>
													<div class="bar-track" aria-hidden="true">
														<div class="bar-fill" style:width="{Math.round((option.count / Math.max(1, tour.answered)) * 100)}%"></div>
													</div>
												</div>
											{/each}
											<p class="m-muted">{tour.words.totalsLine}</p>
										</div>
									</div>
									<div class="m-section">
										<!-- A table that scrolls sideways must take the focus, or a keyboard cannot scroll it (as the To Do page). -->
										<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
										<div class="scroll" tabindex="0" role="region" aria-label="Responses table">
											<table class="m-table">
												<caption>Responses</caption>
												<thead><tr><th scope="col">Name</th><th scope="col">Group</th><th scope="col">Response</th></tr></thead>
												<tbody>
													{#each tour.responses as response, i (i)}
														<tr>
															<td>{response.person.name}</td>
															<td>{response.person.group || 'No group'}</td>
															<td>{response.option === null ? 'Not responded' : `Option ${LETTERS[response.option]}`}</td>
														</tr>
													{/each}
												</tbody>
											</table>
										</div>
									</div>
									<div class="m-section" data-part="groups">
										{#if tour.hasGroups}
											<!-- A table that scrolls sideways must take the focus, or a keyboard cannot scroll it (as the To Do page). -->
											<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
											<div class="scroll" tabindex="0" role="region" aria-label="Round 1 by group table">
												<table class="m-table">
													<caption>Round 1 by group</caption>
													<thead>
														<tr>
															<th scope="col">Group</th>
															<th scope="col" class="num">Consulted</th>
															<th scope="col" class="num">Responded</th>
															{#each tour.options as option (option.letter)}<th scope="col" class="num">Votes for {option.letter}</th>{/each}
															<th scope="col" class="num">Abstained</th>
															<th scope="col" class="num">No concerns</th>
															<th scope="col">Most chosen</th>
														</tr>
													</thead>
													<tbody>
														{#each tour.groups as group (group.name + group.none)}
															<tr>
																<td>{group.name}</td>
																<td class="num">{group.consulted}</td>
																<td class="num">{group.responded}</td>
																{#each group.votes as votes, i (i)}<td class="num">{votes}</td>{/each}
																<td class="num">0</td>
																<td class="num">0</td>
																<td>{group.most}</td>
															</tr>
														{/each}
													</tbody>
												</table>
											</div>
											<p class="m-muted">
												Each person is counted in every group they were in when they were included; people in no group are under No group, so the groups do not
												add up to the total. Only the decider and DumpFire's administrators see this, and it is never released.
											</p>
										{:else}
											<p class="m-muted">Nobody consulted is in a group, so the table by group is not drawn.</p>
										{/if}
									</div>
									<div class="m-section">
										<p class="m-sub">Questions, objections and requests to talk</p>
										<div class="m-box soft">
											<p><b>Question</b> · asked by {tour.asker.name}</p>
											<p>When would this start, if it is chosen?</p>
											<p class="m-muted">{answeredByWords(d.decider, 'decider')}: within a month of the ruling.</p>
										</div>
										<div class="m-box bad">
											<p><b>Objection</b> · {tour.objector.name} · {flagUnrepliedWords('objection')}</p>
											<p>This leaves my team short on the days it changes, and nobody has asked us how we would cover them.</p>
											<p class="m-muted">{flagReplyWhoSees(tour.objector.name)}</p>
											<div class="m-btns"><button type="button" class="m-btn" disabled>Send answer</button></div>
										</div>
										<div class="m-box soft">
											<p><b>Request to talk</b> · {tour.talker.name} · {flagUnrepliedWords('talk')}</p>
											<p>Can we talk before you rule? I am in the office on Tuesdays.</p>
											<div class="m-btns"><button type="button" class="m-btn" disabled>Record outcome</button></div>
										</div>
									</div>
									<div class="m-box warn">
										<p>{tour.words.objectionsNote}</p>
										<div class="m-btns">
											<button type="button" class="m-btn" disabled>Go to the objections</button><button type="button" class="m-btn primary off" disabled>Rule…</button>
										</div>
									</div>
								</div>
							</figure>
						{:else if n === 6}
							<figure class="mock" aria-label="Illustrative screen: ruling, the ruled banner and the release preview">
								{@render bar('/decisions/48/results')}
								<div class="mock-body">
									<div class="m-section">
										<fieldset class="m-section bare">
											<legend class="m-sub">The ruling</legend>
											{#each tour.options as option (option.letter)}
												<label class="m-choice" for="m6-opt-{option.index}"
													><input type="radio" id="m6-opt-{option.index}" name="m6-ruling" disabled checked={option.index === tour.chosen.index} /><span
														>Option {option.letter}: {option.title}</span
													></label
												>
											{/each}
											<label class="m-choice" for="m6-none"><input type="radio" id="m6-none" name="m6-ruling" disabled /><span>None of these</span></label>
										</fieldset>
										<div class="m-field">
											<label for="m6-reason">Why (required; every participant is told)</label><textarea id="m6-reason" readonly tabindex="-1" rows="2" value={tour.words.reason}
											></textarea>
										</div>
										<div class="m-field">
											<label for="m6-conditions">Conditions (optional)</label><textarea
												id="m6-conditions"
												readonly tabindex="-1"
												rows="2"
												value="Review after three months. The objection raised is answered on the record."
											></textarea>
										</div>
										<p class="m-box soft">{tour.words.cutOff}</p>
										<label class="m-choice" for="m6-talk-open"><input type="checkbox" id="m6-talk-open" checked disabled /><span>{tour.words.talksConfirm}</span></label>
										<div class="m-btns"><button type="button" class="m-btn primary" disabled>Rule…</button></div>
									</div>
									<div class="banner">
										<b>{tour.words.ruledBanner}</b>
										<span class="m-muted">Shown at the top of the decision's page, with the reason and the conditions.</span>
									</div>
									<div class="m-section">
										<p class="m-sub">Release preview <span class="chip st-draft">example responses</span></p>
										<div class="m-box soft" data-part="release">
											{#if tour.release.refused}
												<p>Release results… is refused here: fewer than 3 people answered. With so few answers, the totals would show who said what.</p>
											{:else}
												<p>Totals and comments, without names.</p>
												{#each tour.release.rows as row (row.letter)}
													<div class="rel-row">
														<span class="lab"><b>{row.letter}</b><span>{row.title}</span></span>
														<span class="val" class:m-muted={row.withheld}>{row.shown}</span>
													</div>
												{/each}
												<p class="m-muted" data-said="answered">Answered: {tour.release.answered}</p>
												<div class="m-box">
													<span>"I would like a review after three months."</span>
													<div class="m-btns"><button type="button" class="m-btn" disabled>Leave out</button></div>
												</div>
											{/if}
										</div>
										<div class="m-btns">
											<button type="button" class="m-btn" class:off={tour.release.refused} disabled>Release results…</button><button
												type="button"
												class="m-btn"
												disabled>Supersede…</button
											>
										</div>
									</div>
								</div>
							</figure>
						{:else if n === 7}
							<figure class="mock" aria-label="Illustrative screen: the register, a blocked card and the plan">
								{@render bar('/decisions')}
								<div class="mock-body">
									<div class="m-section">
										<div class="tabs" aria-hidden="true">
											<span>Waiting for my response</span><span class="on">Waiting on me<span class="count">1</span></span><span>Open</span><span>Ruled</span><span
												>All</span
											>
										</div>
										<!-- A table that scrolls sideways must take the focus, or a keyboard cannot scroll it (as the To Do page). -->
										<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
										<div class="scroll" tabindex="0" role="region" aria-label="Register table">
											<table class="m-table">
												<thead>
													<tr><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Board</th><th scope="col">Decider</th><th scope="col">Closes</th></tr>
												</thead>
												<tbody>
													<tr><td>{d.title}</td><td>{@render chip('awaiting_ruling', 'st-await')}</td><td>{d.board}</td><td>{d.decider}</td><td>{tour.closesText}</td></tr>
												</tbody>
											</table>
										</div>
									</div>
									<div class="m-section">
										<p class="m-sub">Board: {d.board}</p>
										<div class="kgrid">
											<div class="board-col">
												<div class="col-head"><span>To Do</span><span>2</span></div>
												<div class="kcard">
													<span class="kid">#1042</span>
													<span>Carry out the chosen option</span>
													<span><span class="chip chip-blocked" title={tour.words.blockedTip}>Blocked</span></span>
												</div>
												<div class="tip">{tour.words.blockedTip}</div>
												<div class="kcard"><span class="kid">#1043</span><span>Tell customers about the change</span></div>
											</div>
											<div class="m-box soft">
												<p class="m-label">Card #1042: Decisions</p>
												<p><b>{d.title}</b></p>
												<p>{@render chip('awaiting_ruling', 'st-await')} <span class="m-muted">Closes {tour.closesText}</span></p>
												<p class="m-muted">This card waits on it</p>
											</div>
										</div>
									</div>
									<div class="m-section">
										<p class="m-sub">The goal's plan</p>
										<!-- A table that scrolls sideways must take the focus, or a keyboard cannot scroll it (as the To Do page). -->
										<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
										<div class="scroll" tabindex="0" role="region" aria-label="Plan table">
											<table class="m-table">
												<thead><tr><th scope="col">Card</th><th scope="col">State</th><th scope="col">Waiting on</th></tr></thead>
												<tbody>
													<tr>
														<td>#1042 Carry out the chosen option</td>
														<td><span class="chip chip-blocked">Blocked</span></td>
														<td>waiting on decision <a href="#stop-1">{d.title}</a> · {STATUS_WORDS.awaiting_ruling} · {tour.closesText}</td>
													</tr>
												</tbody>
											</table>
										</div>
									</div>
									<div class="m-section">
										<p class="m-sub">My record: {tour.firstConsulted.name}</p>
										<ul class="m-list">
											{#each tour.words.personRecord as line, i (i)}<li>{line}</li>{/each}
										</ul>
									</div>
								</div>
							</figure>
						{:else if n === 8}
							<figure class="mock" aria-label="Illustrative screen: the two PDFs and a webhook event">
								{@render bar('/decisions/48')}
								<div class="mock-body">
									<div class="pdfs">
										<div class="pdf">
											<div class="page" aria-hidden="true">
												<div class="page-in">
													<span class="p-title">{d.title}</span>
													<span class="p-text">Board: {d.board}</span>
													<span class="p-h">The question</span>
													<span class="p-line"></span><span class="p-line s"></span>
													<span class="p-h">Options</span>
													<span class="p-text">{tour.options.map((o) => `${o.letter}: ${o.title}`).join(' ')}</span>
													<span class="p-h">Ruling</span>
													<span class="p-text">{tour.words.ruledBanner}</span>
													<span class="p-line s"></span>
													<span class="p-text">{RESULTS_NOT_RELEASED}</span>
												</div>
												<div class="p-foot"><span>Shareable copy · {tour.words.pdfBy}</span><span>page 1 of 1</span></div>
											</div>
											<p class="cap"><b>Shareable copy (PDF)</b>: anyone who can open the decision.</p>
										</div>
										<div class="pdf">
											<div class="page" aria-hidden="true">
												<div class="private-band">{PRIVATE_BAND.join(' ')}</div>
												<div class="page-in">
													<span class="p-title">{d.title}</span>
													<span class="p-h">Ruling</span>
													<span class="p-text">{tour.words.earlyLine}</span>
													<span class="p-h">Objections and requests to talk</span>
													<span class="p-line"></span><span class="p-line s"></span>
													<span class="p-h">Round 1 by group</span>
													<span class="p-line"></span>
													<span class="p-h">Responses by name</span>
													<span class="p-line"></span><span class="p-line"></span><span class="p-line s"></span>
												</div>
												<div class="p-foot"><span>Full record · {tour.words.pdfByDecider}</span><span>page 1 of 3</span></div>
											</div>
											<p class="cap"><b>Full record (PDF)</b>: the decider and administrators. Written on the record.</p>
										</div>
									</div>
									<div class="m-section">
										<p class="m-label">A webhook event, as the receiver gets it</p>
										<pre class="code">{tour.words.webhookJson}</pre>
									</div>
								</div>
							</figure>
						{:else if n === 9}
							<figure class="mock" aria-label="Illustrative screen: what an API key can do and what only a person can do">
								{@render bar('/api/v1/decisions')}
								<div class="mock-body">
									<div class="m-two">
										<div class="m-box accent">
											<p class="m-sub">Agent can (API key)</p>
											<ul class="m-list">
												{#each tour.words.apiCan as line, i (i)}<li>{line}</li>{/each}
											</ul>
										</div>
										<div class="m-box soft">
											<p class="m-sub">Person only (on the page)</p>
											<ul class="m-list">
												{#each tour.words.apiPerson as line, i (i)}<li>{line}</li>{/each}
											</ul>
										</div>
									</div>
									<div class="m-box warn">
										<p class="m-label">Situation</p>
										<p><span class="chip st-draft chip-wrap">{AGENT_UNREVIEWED}</span></p>
										<p>{d.question}</p>
										<div class="m-btns">
											<button type="button" class="m-btn" disabled>Mark reviewed</button><button type="button" class="m-btn" disabled>Mark all reviewed</button>
										</div>
									</div>
									<div class="m-section">
										<p class="m-label">Calls an agent makes (illustrative ids)</p>
										<pre class="code" data-part="api-calls">{tour.words.apiCalls}</pre>
									</div>
								</div>
							</figure>
						{:else}
							<figure class="mock" aria-label="Who sees each part of a decision">
								{@render bar('who sees what')}
								<div class="mock-body">
									<!-- A table that scrolls sideways must take the focus, or a keyboard cannot scroll it (as the To Do page). -->
									<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
									<div class="scroll" tabindex="0" role="region" aria-label="Who sees what table">
										<table class="m-table privacy">
											<thead><tr><th scope="col">Part</th><th scope="col">Who sees it</th></tr></thead>
											<tbody>
												<tr>
													<th scope="row">A response, with its name</th>
													<td>
														The person, the decider ({d.decider}) and administrators. After the ruling the decider may release totals and comments, never names.
													</td>
												</tr>
												<tr><th scope="row">Survey answers</th><td>The decider and administrators, with names. Never released, never totalled for anyone else.</td></tr>
												<tr>
													<th scope="row">A clarifying question</th>
													<td>Everyone included, without the asker's name. The author, the decider and administrators see who asked.</td>
												</tr>
												<tr>
													<th scope="row">Objections and requests to talk</th>
													<td>The person, the decider and administrators. Never released, never in the ruling mail, never through an API key.</td>
												</tr>
												<tr><th scope="row">Figures by group</th><td>The decider and administrators. Never in a release, a mail or the API's results summary.</td></tr>
												<tr>
													<th scope="row">Webhook events</th>
													<td>The decision's number, title, what happened and its status. Never a name, a choice, a reason or a count.</td>
												</tr>
												<tr><th scope="row">The record</th><td>Added to, never edited. Downloading the full record PDF is itself written on the record.</td></tr>
											</tbody>
										</table>
									</div>
								</div>
							</figure>
						{/if}
					</section>

					<div class="toolbar">
						<button type="button" class="btn" data-action="back" disabled={current === 1} onclick={() => step(current - 1)}>Back</button>
						<span class="progress" aria-live="polite">{progress}</span>
						<button type="button" class="btn primary" data-action="next" disabled={current === TOUR_STOPS} onclick={() => step(current + 1)}>Next</button>
						<span class="spacer"></span>
						<button type="button" class="btn ghost" data-action="edit" onclick={editDetails}>Edit details</button>
					</div>
					<div class="meter" aria-hidden="true"><span style:width="{Math.round((current / TOUR_STOPS) * 100)}%"></span></div>
				{/if}
			</main>
		</div>
	</div>
</div>

<style>
	/* The app's theme tokens, named for what the tour uses them for, so every theme carries over (ruling 4). */
	.tour-page {
		--paper: var(--bg-deep);
		--surface: var(--bg-card);
		--sunk: var(--bg-surface);
		--ink: var(--text-primary);
		--muted: var(--text-secondary);
		--line: var(--glass-border);
		--accent: var(--accent-indigo);
		--accent-soft: color-mix(in srgb, var(--accent-indigo) 14%, transparent);
		--ok: var(--accent-emerald);
		--ok-soft: color-mix(in srgb, var(--accent-emerald) 16%, transparent);
		--warn: var(--accent-amber);
		--warn-soft: color-mix(in srgb, var(--accent-amber) 16%, transparent);
		--bad: var(--accent-rose);
		--bad-soft: color-mix(in srgb, var(--accent-rose) 14%, transparent);
		min-height: 100vh;
		padding-top: 64px;
		color: var(--ink);
	}

	.tour-header {
		position: fixed; top: 0; left: 0; right: 0; z-index: 200;
		height: 64px; border-bottom: 1px solid var(--glass-border);
		backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
	}
	.tour-header-inner {
		max-width: 1400px; margin: 0 auto; height: 100%;
		display: flex; align-items: center; gap: var(--space-lg);
		padding: 0 var(--space-xl);
	}
	.header-logo {
		display: flex; align-items: center; gap: var(--space-sm);
		text-decoration: none; color: var(--text-primary);
		font-weight: 700; font-size: 1.1rem;
	}
	.logo-fire { font-size: 1.4rem; }
	.crumb { flex: 1; font-size: 0.85rem; min-width: 0; margin: 0; color: var(--text-secondary); }
	.crumb a { color: var(--accent-indigo); }

	/* The page's last line stops above the user badge (card 2239). */
	.wrap { max-width: 1200px; margin: 0 auto; padding: var(--space-xl) var(--space-xl) var(--user-badge-space); display: grid; gap: 28px; }
	p { margin: 0; }
	:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

	.masthead { display: grid; gap: 10px; max-width: 70ch; }
	.eyebrow { font-size: 0.8125rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
	.masthead h1 { font-size: clamp(1.6rem, 4vw, 2.3rem); }
	.lede { color: var(--muted); font-size: 1.0625rem; }
	.illustrative {
		display: inline-flex; align-items: center; gap: 8px; justify-self: start;
		font-size: 0.875rem; color: var(--ink); background: var(--warn-soft);
		border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px;
	}
	.illustrative::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--warn); }

	.tour { display: grid; grid-template-columns: 228px minmax(0, 1fr); gap: 36px; align-items: start; }
	.steps { position: sticky; top: 80px; }
	.steps ol { list-style: none; display: grid; gap: 2px; }
	.steps a {
		display: grid; grid-template-columns: 26px 1fr; gap: 8px; align-items: baseline;
		padding: 7px 10px; border-radius: 8px; color: var(--muted); text-decoration: none;
		font-size: 0.875rem; line-height: 1.35; min-height: 44px; align-content: center;
	}
	.steps a:hover { background: var(--sunk); color: var(--ink); }
	.steps .n { font-family: var(--font-mono); font-size: 0.8125rem; font-variant-numeric: tabular-nums; }
	.steps a[aria-current='step'] { background: var(--accent-soft); color: var(--ink); font-weight: 600; }
	.steps a[aria-current='step'] .n { color: var(--accent); }

	.stage { min-width: 0; display: grid; gap: 24px; scroll-margin-top: 80px; }

	.stop { display: grid; grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.3fr); gap: 32px; align-items: start; }
	.stop-text { display: grid; gap: 12px; max-width: 62ch; min-width: 0; line-height: 1.6; }
	.stop-text h2, .setup-head h2 { font-size: 1.6rem; }
	.stop-text h2:focus, .setup-head h2:focus { outline: none; }
	.stop-text h2:focus-visible, .setup-head h2:focus-visible { outline: 3px solid var(--accent); }
	.stop-text b { font-weight: 600; overflow-wrap: anywhere; }
	.where { font-size: 0.875rem; border-left: 3px solid var(--accent); background: var(--accent-soft); border-radius: 0 8px 8px 0; padding: 8px 12px; }
	.before { border: 1px solid var(--line); background: var(--warn-soft); border-radius: 8px; padding: 10px 12px; font-size: 0.875rem; display: grid; gap: 6px; }
	.before-head { font-weight: 700; }
	.before ul { padding-left: 18px; display: grid; gap: 4px; }

	.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; border-top: 1px solid var(--line); padding-top: 16px; }
	.progress { font-size: 0.875rem; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 8ch; text-align: center; }
	.spacer { flex: 1 1 auto; }
	.meter { height: 4px; background: var(--sunk); border-radius: 2px; overflow: hidden; }
	.meter span { display: block; height: 100%; background: var(--accent); transition: width 0.3s ease; }

	.btn {
		font: inherit; font-size: 0.875rem; font-weight: 600; min-height: 44px;
		padding: 9px 16px; border-radius: 8px; border: 1px solid var(--line);
		background: var(--surface); color: var(--ink); cursor: pointer;
	}
	.btn:hover:not(:disabled) { border-color: var(--accent); }
	.btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
	.btn.ghost { background: transparent; }
	.btn:disabled { opacity: 0.45; cursor: not-allowed; }

	/* The setup form */
	.setup { display: grid; gap: 20px; max-width: 860px; }
	.setup-head { display: grid; gap: 10px; max-width: 64ch; }
	.setup form { display: grid; gap: 18px; }
	.setup fieldset {
		border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
		padding: 16px 18px 18px; display: grid; gap: 14px; min-width: 0;
	}
	.setup legend { font-weight: 700; padding: 0 6px; font-size: 1.05rem; }
	.fgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
	.fgrid .full { grid-column: 1 / -1; }
	.field { display: grid; gap: 4px; min-width: 0; }
	.field label, .plabel { font-size: 0.875rem; font-weight: 600; }
	.hint { font-size: 0.8125rem; color: var(--muted); }
	.setup input, .setup select, .setup textarea {
		font: inherit; font-size: 16px; color: var(--ink); background: var(--bg-elevated);
		border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; width: 100%; min-width: 0; min-height: 44px;
	}
	.setup textarea { resize: vertical; min-height: 4.5em; }
	.setup input[aria-invalid='true'], .setup select[aria-invalid='true'], .setup textarea[aria-invalid='true'] { border-color: var(--bad); box-shadow: 0 0 0 1px var(--bad); }
	.opt-row { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 10px; align-items: center; }
	.letter {
		display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; flex: none;
		background: var(--accent-soft); color: var(--accent); font-weight: 700; font-family: var(--font-mono); font-size: 0.875rem;
	}
	.prow { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 0.9fr) minmax(0, 1fr); gap: 10px; align-items: end; }
	.prow + .prow { border-top: 1px dashed var(--line); padding-top: 12px; margin-top: 12px; }
	.form-actions { display: flex; flex-wrap: wrap; gap: 10px; }
	.form-errors { border: 1px solid var(--bad); background: var(--bad-soft); border-radius: 10px; padding: 12px 14px; font-size: 0.875rem; }
	.form-errors ul { margin: 6px 0 0; padding-left: 18px; }
	.example-note { font-size: 0.875rem; background: var(--warn-soft); border-radius: 8px; padding: 8px 12px; border: 1px solid var(--line); }
	.needs-setup { font-size: 0.875rem; background: var(--accent-soft); border-radius: 8px; padding: 8px 12px; }

	/* The illustrative screens */
	.mock { min-width: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow-md); overflow: hidden; }
	.mock-bar {
		display: flex; align-items: center; gap: 10px; padding: 8px 14px;
		background: var(--sunk); border-bottom: 1px solid var(--line);
		font-family: var(--font-mono); font-size: 0.8125rem; color: var(--muted);
	}
	.mock-bar .app { font-family: var(--font-family); font-weight: 700; color: var(--ink); }
	.mock-bar .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
	.mock-body { padding: 16px; display: grid; gap: 14px; font-size: 0.875rem; line-height: 1.5; min-width: 0; overflow-wrap: anywhere; }
	.mock-body.phone { max-width: 400px; margin: 0 auto; width: 100%; }
	.m-title { font-size: 1.2rem; font-weight: 700; overflow-wrap: anywhere; }
	.m-sub { font-size: 0.8125rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
	.m-muted { color: var(--muted); }
	.m-meta { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; color: var(--muted); }
	.m-meta b { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
	.m-section { display: grid; gap: 8px; min-width: 0; }
	.m-section + .m-section { border-top: 1px solid var(--line); padding-top: 14px; }
	.m-section.bare { border: 0; padding: 0; }
	.m-box { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; display: grid; gap: 6px; background: var(--surface); min-width: 0; overflow-wrap: anywhere; }
	.m-box.soft { background: var(--paper); }
	.m-box.warn { background: var(--warn-soft); }
	.m-box.bad { background: var(--bad-soft); }
	.m-box.accent { background: var(--accent-soft); }
	.m-field { display: grid; gap: 4px; min-width: 0; }
	.m-field label, .m-label { font-size: 0.8125rem; font-weight: 600; color: var(--muted); }
	.mock select, .mock textarea, .mock input[type='text'] {
		font: inherit; font-size: 0.875rem; color: var(--ink); -webkit-text-fill-color: var(--ink);
		background: var(--paper); border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px;
		width: 100%; min-width: 0; opacity: 1;
	}
	.mock textarea { resize: none; min-height: 3.2em; }
	.mock input[type='radio'], .mock input[type='checkbox'] { accent-color: var(--accent); margin: 0; flex: none; }
	.m-choice { display: flex; gap: 8px; align-items: flex-start; }
	.m-choice span { min-width: 0; overflow-wrap: anywhere; }
	.m-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
	.m-btns { display: flex; flex-wrap: wrap; gap: 8px; }
	.m-btn {
		font: inherit; font-size: 0.8125rem; font-weight: 600; padding: 6px 11px; border-radius: 6px;
		border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: default; opacity: 1;
	}
	.m-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
	.m-btn.off { opacity: 0.5; }
	.m-opts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
	.m-opt { border: 1px solid var(--line); border-radius: 8px; padding: 10px; display: grid; gap: 6px; align-content: start; background: var(--paper); min-width: 0; }
	.m-opt .head { display: flex; gap: 8px; align-items: flex-start; font-weight: 600; }
	.m-opt .head span:last-child { min-width: 0; overflow-wrap: anywhere; }
	.m-opt .line { font-size: 0.8125rem; color: var(--muted); }
	.m-opt .line.missing { color: var(--ink); font-weight: 600; text-decoration: underline wavy var(--warn); }
	.m-people { list-style: none; display: grid; gap: 6px; }
	.m-people li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; }
	.m-people .who { min-width: 0; overflow-wrap: anywhere; }
	.m-people .grp { font-size: 0.8125rem; color: var(--muted); }
	.m-list { padding-left: 18px; display: grid; gap: 4px; }
	.m-record { list-style: none; display: grid; font-size: 0.8125rem; }
	.m-record li { display: grid; grid-template-columns: 17ch minmax(0, 1fr); gap: 10px; padding: 6px 0; border-bottom: 1px dashed var(--line); }
	.m-record .t { font-family: var(--font-mono); color: var(--muted); font-variant-numeric: tabular-nums; }
	.m-record .what { overflow-wrap: anywhere; }

	.chip {
		display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
		font-size: 0.8125rem; font-weight: 600; border-radius: 999px; padding: 2px 9px;
		border: 1px solid transparent; line-height: 1.5; color: var(--ink);
	}
	.st-draft { background: var(--sunk); color: var(--muted); border-color: var(--line); }
	.st-open { background: var(--accent-soft); border-color: var(--accent); }
	.st-await { background: var(--warn-soft); border-color: var(--warn); }
	.st-ruled { background: var(--ok-soft); border-color: var(--ok); }
	.st-super { background: var(--sunk); color: var(--muted); border-color: var(--line); text-decoration: line-through; }
	.st-withdrawn { background: var(--surface); color: var(--muted); border: 1px dashed var(--line); }
	.chip-wrap { white-space: normal; }
	.chip-blocked { background: var(--bad-soft); border-color: var(--bad); }
	.chip-role { background: var(--accent-soft); }
	.chip-role.informed { background: var(--sunk); color: var(--muted); }
	.status-row { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
	.status-row .arrow { color: var(--muted); font-size: 0.8125rem; }

	.scroll { overflow-x: auto; min-width: 0; }
	.m-table { border-collapse: collapse; width: 100%; font-size: 0.8125rem; font-variant-numeric: tabular-nums; }
	.m-table caption { text-align: left; font-weight: 700; padding-bottom: 6px; font-size: 0.875rem; }
	.m-table th, .m-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
	.m-table th { color: var(--muted); font-weight: 600; white-space: nowrap; }
	.m-table .num { text-align: right; }
	.m-table td { overflow-wrap: anywhere; }
	.privacy th[scope='row'] { color: var(--ink); white-space: normal; min-width: 11ch; }

	.bars { display: grid; gap: 8px; }
	.bar-row { display: grid; grid-template-columns: minmax(0, 1fr) 3ch; gap: 4px 10px; align-items: center; }
	.lab { display: flex; gap: 8px; min-width: 0; }
	.lab span:last-child { overflow-wrap: anywhere; min-width: 0; }
	.val { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; flex: none; }
	.rel-row { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
	.bar-track { grid-column: 1 / -1; height: 8px; background: var(--sunk); border-radius: 4px; overflow: hidden; }
	.bar-fill { height: 100%; background: var(--accent); border-radius: 4px; }

	.banner { border-radius: 8px; padding: 10px 12px; background: var(--ok-soft); display: grid; gap: 4px; }
	.banner b { overflow-wrap: anywhere; }
	.private-band { background: var(--bad); color: #fff; font-size: 9px; font-weight: 700; padding: 4px 8px; line-height: 1.3; }

	.kgrid { display: grid; grid-template-columns: minmax(0, 300px) minmax(0, 1fr); gap: 14px; align-items: start; }
	.board-col { background: var(--sunk); border-radius: 10px; padding: 10px; display: grid; gap: 8px; max-width: 300px; min-width: 0; }
	.col-head { font-weight: 700; font-size: 0.8125rem; color: var(--muted); display: flex; justify-content: space-between; }
	.kcard { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; display: grid; gap: 6px; overflow-wrap: anywhere; }
	.kid { font-family: var(--font-mono); font-size: 0.8125rem; color: var(--muted); }
	.tip { background: var(--ink); color: var(--paper); font-size: 0.8125rem; border-radius: 6px; padding: 6px 9px; overflow-wrap: anywhere; }
	.tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--line); }
	.tabs span { font-size: 0.8125rem; padding: 6px 10px; border-bottom: 2px solid transparent; color: var(--muted); }
	.tabs span.on { border-color: var(--accent); color: var(--ink); font-weight: 600; }
	.tabs .count { display: inline-block; min-width: 1.6em; text-align: center; background: var(--accent); color: #fff; border-radius: 999px; font-size: 11px; padding: 0 5px; margin-left: 4px; border: 0; }

	.pdfs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
	.pdf { display: grid; gap: 6px; min-width: 0; }
	.page {
		aspect-ratio: 1 / 1.414; max-width: 100%; background: var(--surface); border: 1px solid var(--line);
		border-radius: 4px; box-shadow: var(--shadow-md); overflow: hidden; display: flex; flex-direction: column; font-size: 9px; line-height: 1.4;
	}
	.page-in { padding: 10px 12px; display: grid; gap: 5px; align-content: start; flex: 1; min-height: 0; overflow: hidden; }
	.p-title { font-weight: 700; font-size: 12px; overflow-wrap: anywhere; }
	.p-h { font-weight: 700; font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-top: 3px; }
	.p-line { height: 5px; border-radius: 2px; background: var(--sunk); }
	.p-line.s { width: 60%; }
	.p-text { overflow-wrap: anywhere; }
	.p-foot { border-top: 1px solid var(--line); padding: 5px 12px; color: var(--muted); font-size: 8px; display: flex; justify-content: space-between; gap: 6px; }
	.cap { font-size: 0.8125rem; color: var(--muted); }
	.cap b { color: var(--ink); }

	pre.code {
		background: var(--sunk); border: 1px solid var(--line); border-radius: 8px;
		padding: 12px 14px; font-family: var(--font-mono); font-size: 12px; line-height: 1.55; overflow-x: auto; color: var(--ink);
	}
	code { font-family: var(--font-mono); font-size: 0.9em; }

	@media (max-width: 1060px) {
		.stop { grid-template-columns: minmax(0, 1fr); }
	}
	@media (max-width: 860px) {
		.tour { grid-template-columns: minmax(0, 1fr); gap: 20px; }
		.steps { position: static; overflow-x: auto; margin-inline: -4px; padding: 2px 4px 6px; }
		.steps ol { display: flex; gap: 4px; width: max-content; }
		.steps a { grid-template-columns: auto auto; white-space: nowrap; padding: 6px 10px; border: 1px solid var(--line); background: var(--surface); }
	}
	@media (max-width: 640px) {
		.tour-header-inner { padding: 0 var(--space-md); }
		.logo-text { display: none; }
		.wrap { padding: var(--space-md) var(--space-md) var(--user-badge-space); }
		.fgrid { grid-template-columns: minmax(0, 1fr); }
		.prow { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
		.prow .field:first-child { grid-column: 1 / -1; }
		.kgrid { grid-template-columns: minmax(0, 1fr); }
		.m-two { grid-template-columns: minmax(0, 1fr); }
		.spacer { display: none; }
	}
	@media (max-width: 440px) {
		.pdfs { grid-template-columns: minmax(0, 1fr); }
		.page { max-width: 260px; }
	}
	@media (prefers-reduced-motion: reduce) {
		.meter span { transition: none; }
	}
</style>
