/**
 * decision-seen.ts — record that a participant has seen a decision's version,
 * from the page, after their first genuine action on it (card 2677, decision
 * 14, R2, D7).
 *
 * Opening a decision is its acknowledgement (design D5), but mail scanners
 * follow the links in a message before the person does, and some draw the page
 * in a headless browser, where it is "visible". So the page load writes
 * nothing, and rendering, focus or becoming visible are not taken for an
 * action: the page posts once, after the first trusted `pointerdown`,
 * `keydown`, `touchstart` or `wheel` while it is visible. Not `scroll`, which
 * is trusted however it was caused, a script's `scrollTo` included (code
 * review C3); `wheel` is trusted only from the device. An action while it is
 * hidden sends nothing, and the next one once it is visible does.
 *
 * Both participant pages arm `watchForSeen` in an effect on the decision, the
 * version and the stage, so a page read again for another of them watches
 * afresh (code review C2), and only for a participant: `/decisions/[id]`
 * arms none for a caller who is no participant, so they never send it, and
 * neither page arms one where it has no stage to send. `DecisionView` arms
 * none, so a preview can never record an opening. The server writes one
 * event per participant, version and stage, whatever is sent.
 *
 * Client-safe: no import, and nothing read until it is called.
 */

/** What the page's actions are watched for. */
const ACTIONS = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;

export type SeenWatchOptions = {
	/**
	 * Whether an event is the person's own: `event.isTrusted` unless given. A
	 * test stands it in, since a script can make no trusted event.
	 */
	trusted?: (event: Event) => boolean;
};

/**
 * Post `body` as JSON to `url` after the first trusted action while the page
 * is visible, and stop watching. With no answer, or a 429 or a 5xx, it
 * watches again and the next action sends it again; any other answer is the
 * end of it (a refusal that a second try would not change). Returns what
 * stops the watch, for the page's effect to run when it is armed again or
 * the page goes.
 */
export function watchForSeen(url: string, body: Record<string, unknown>, opts: SeenWatchOptions = {}): () => void {
	const trusted = opts.trusted ?? ((event: Event) => event.isTrusted);
	let watching = false;
	/** The page has gone: an answer that comes after it starts no watch. */
	let ended = false;

	const listen = () => {
		if (watching || ended) return;
		watching = true;
		for (const kind of ACTIONS) window.addEventListener(kind, onAction, { capture: true, passive: true });
	};
	const stop = () => {
		if (!watching) return;
		watching = false;
		for (const kind of ACTIONS) window.removeEventListener(kind, onAction, { capture: true });
	};

	async function send() {
		try {
			const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
			if (res.status === 429 || res.status >= 500) listen();
		} catch {
			// No answer: whether it was recorded is not known, so the next action asks again.
			listen();
		}
	}

	function onAction(event: Event) {
		if (!trusted(event) || document.visibilityState !== 'visible') return;
		stop();
		void send();
	}

	listen();
	return () => {
		ended = true;
		stop();
	};
}
