/**
 * How the admin page and its panels send a write and say what came of it
 * (card 2281, slice C1a: moved from src/routes/admin/+page.svelte as
 * written, so that the page and each panel it is split into say a refusal
 * the same way).
 */
import { failureMessage } from '$lib/api';
import { toasts } from '$lib/stores/toast';
import { stepUpRefusal } from '$lib/step-up-words';

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
 *
 * With `{ giveBackPasswordRefusal: true }`, for a write that carries the
 * caller's password (card 2701), a refusal of the password itself (wrong,
 * missing, the session signed out: `stepUpRefusal`) is not put in a toast: its
 * words are given back, for the dialog that asked for the password to show in
 * itself, with the field cleared to type again (decision 13).
 */
export function sent(send: () => Promise<Response>, fallback: string): Promise<Response | null>;
export function sent(
	send: () => Promise<Response>,
	fallback: string,
	options: { giveBackPasswordRefusal: true }
): Promise<Response | string | null>;
export async function sent(
	send: () => Promise<Response>,
	fallback: string,
	options?: { giveBackPasswordRefusal: true }
): Promise<Response | string | null> {
	const started = toasts.navigation();
	try {
		const res = await send();
		if (res.ok) return res;
		if (options?.giveBackPasswordRefusal) {
			const refusal = await stepUpRefusal(res);
			if (refusal !== null) return refusal;
		}
		showToast(await failureMessage(res, fallback), 'error', started);
	} catch {
		showToast(NO_ANSWER, 'error', started);
	}
	return null;
}

/**
 * `sent` for a write that carries the caller's password (card 2701): the
 * answer when it was done, the words of a refusal of the password itself,
 * and null for any other refusal or no answer, said in a toast.
 */
export function sentAsking(send: () => Promise<Response>, fallback: string): Promise<Response | string | null> {
	return sent(send, fallback, { giveBackPasswordRefusal: true });
}
