/**
 * How the admin page and its panels send a write and say what came of it
 * (card 2281, slice C1a: moved from src/routes/admin/+page.svelte as
 * written, so that the page and each panel it is split into say a refusal
 * the same way).
 */
import { failureMessage } from '$lib/api';
import { toasts } from '$lib/stores/toast';

/**
 * The shared toast: a failure stays until it is closed, and so does a
 * warning (⚠️), for something done that took more with it (card 2397's
 * review); a success goes after 3 s. `started` is `toasts.navigation()` as
 * the request began, so that a failure or a warning arriving after the page
 * was left is not shown.
 */
export function showToast(msg: string, type: 'success' | 'error' | 'warning' = 'success', started?: number) {
	toasts.add(msg, type, started, type === 'warning');
}

/** What a request that got no answer says: it is not known to have failed. */
export const NO_ANSWER = 'No answer from the server. It is not known whether this was done.';

/**
 * Send a request that changes something, and say so in a toast if it was
 * not done. Returns the answer when the server said it was done and null
 * when it did not, so that a caller changes the page only for an answer.
 *
 * The toast is the server's own message where it gave one, and `fallback`
 * where it did not. A request that got no answer is not known to have
 * failed, and the toast says that instead.
 */
export async function sent(send: () => Promise<Response>, fallback: string): Promise<Response | null> {
	const started = toasts.navigation();
	try {
		const res = await send();
		if (res.ok) return res;
		showToast(await failureMessage(res, fallback), 'error', started);
	} catch {
		showToast(NO_ANSWER, 'error', started);
	}
	return null;
}
