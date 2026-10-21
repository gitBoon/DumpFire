/**
 * A dialog's hold on the keyboard's focus: the app's confirm dialog's
 * (`ConfirmModal`, card 2353) and, through `holdFocus`, the admin page's
 * dialogs that are not a plain yes or no (card 2362: the Import Database
 * dialog and Google Drive's Connect box).
 *
 *   - As it opens, the focus goes to the button it names (Cancel), so Enter
 *     straight after cancels rather than pressing the page's button behind it
 *     again.
 *   - While it is open, Tab and Shift+Tab stay on its own tab stops, and a Tab
 *     from outside it (the page behind, after a click on the overlay) comes
 *     back to that button.
 *   - As it closes, the focus goes back to what had it, after one macrotask,
 *     only if that is still in the page and the focus is then on nothing: a
 *     card window the dialog opened (the board page's Cannot Complete, Open
 *     Card) focuses its title in a microtask, and keeps it.
 */

/**
 * What Tab reaches in `dialog`, in order: a link, button, field or element
 * with a `tabindex`, not disabled and not taken out with `tabindex="-1"`; and
 * of radio buttons only the one chosen, as the browser stops once on a group.
 */
function tabStops(dialog: HTMLElement): HTMLElement[] {
	return [...dialog.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')].filter(
		(el) =>
			el.tabIndex >= 0 &&
			!(el as HTMLButtonElement).disabled &&
			!(el instanceof HTMLInputElement && (el.type === 'hidden' || (el.type === 'radio' && !el.checked)))
	);
}

/**
 * Focuses `first` as a dialog opens, and gives back what to run as it closes:
 * the focus handed back to what had it before, on the rules above.
 *
 * `returnTo`, where it is given, names where the focus goes back to instead,
 * asked as the dialog closes: for a dialog opened by something other than a
 * press on a control still in the page (the invite link's, opened once an
 * answer comes, by which time the pressed control is off or gone and the
 * focus is on nothing). When it names nothing, or something no longer in
 * the page, the focus goes back to what had it, as without it.
 */
export function takeFocus(first: HTMLElement, returnTo?: () => HTMLElement | null | undefined): () => void {
	const opener = document.activeElement;
	first.focus();
	return () => {
		setTimeout(() => {
			const named = returnTo?.();
			const back = named?.isConnected ? named : opener;
			if (back instanceof HTMLElement && back !== document.body && back.isConnected && document.activeElement === document.body) {
				back.focus();
			}
		}, 0);
	};
}

/**
 * Keeps a Tab pressed while `dialog` is open on its own tab stops: from
 * outside it to `first`, from its last stop to its first and, with Shift,
 * from its first to its last. Between them the browser's own Tab is left be.
 */
export function keepTab(e: KeyboardEvent, dialog: HTMLElement, first: HTMLElement): void {
	if (e.key !== 'Tab') return;
	const at = document.activeElement;
	if (!dialog.contains(at)) {
		e.preventDefault();
		first.focus();
		return;
	}
	const stops = tabStops(dialog);
	if (stops.length === 0) return;
	if (!e.shiftKey && at === stops[stops.length - 1]) {
		e.preventDefault();
		stops[0].focus();
	} else if (e.shiftKey && at === stops[0]) {
		e.preventDefault();
		stops[stops.length - 1].focus();
	}
}

/** What `holdFocus` is given: see below. */
type HoldOptions = { first: string; onEscape?: () => void; returnTo?: () => HTMLElement | null | undefined };

/**
 * The same hold as a Svelte action, for a dialog drawn inside an `{#if}`:
 * `use:holdFocus={{ first: '.modal-actions .btn-ghost', onEscape: close }}` on the
 * dialog's box. `first` is a selector for the button inside it that takes
 * the focus; Escape, pressed anywhere while it is up, runs `onEscape`;
 * `returnTo` is `takeFocus`'s, asked as the dialog closes.
 */
export function holdFocus(node: HTMLElement, options: HoldOptions) {
	let current = options;
	const first = () => node.querySelector<HTMLElement>(current.first) ?? node;
	const handBack = takeFocus(first(), () => current.returnTo?.());
	const keys = (e: KeyboardEvent) => {
		if (e.key === 'Escape') current.onEscape?.();
		keepTab(e, node, first());
	};
	window.addEventListener('keydown', keys);
	return {
		update(next: HoldOptions) {
			current = next;
		},
		destroy() {
			window.removeEventListener('keydown', keys);
			handBack();
		}
	};
}
