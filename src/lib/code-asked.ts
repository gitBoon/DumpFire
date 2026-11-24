/**
 * code-asked.ts — whether a confirmation asks the signed-in account for a
 * code beside its password, as the page has it (card 3064, R7, F25): the
 * layout's `codeAsked`, false only for an account with no factor while
 * two-step sign-in is dormant. For a component with no `data` of its own to
 * say what a confirmation asks for by (`asksForPassword`, `yourProof` in
 * `$lib/step-up-words`), by the same rule as its field (`proofTyped`,
 * `CurrentPasswordField`).
 *
 * Anything but a literal `false` is the code asked, and so is a page whose
 * data cannot be read: the server's rule is the guard, and the words only
 * follow it. Read in a template or a `$derived`, it follows the page's data
 * as it changes.
 */
import { page } from '$app/state';

/** The layout's `codeAsked` as a boolean: false only where it is literally false. */
export function codeAskedHere(): boolean {
	try {
		return page.data?.codeAsked !== false;
	} catch {
		// Outside a page (a component drawn on its own): asked.
		return true;
	}
}
