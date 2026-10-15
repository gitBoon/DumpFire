import { writable } from 'svelte/store';

export type Toast = {
	id: number;
	message: string;
	type: 'success' | 'info' | 'error' | 'warning';
};

/** How long a toast that is not a failure stays: success, info and warning. */
export const TOAST_MS = 3000;

/** How many failures are shown at once. One more puts the oldest away. */
export const MOST_FAILURES = 3;

let nextId = 0;

/** How many navigations there have been, counted by `Toast.svelte` as each begins. */
let navigations = 0;

/**
 * The toasts every page shows through `<Toast />`.
 *
 * A failure stays until it is closed, or until its page is left: a message
 * that says something was not done is one to read, and it used to go in three
 * seconds like the rest. `Toast.svelte` clears the failures when its page goes
 * and when the page is navigated (`clearErrors`), so that none follows the
 * reader to the next page. The rest still go by themselves after `TOAST_MS`.
 *
 * Because a failure waits to be closed, the same one is shown once however
 * often it comes, and no more than `MOST_FAILURES` are shown. And a failure
 * whose request was started before a navigation is not shown at all, where it
 * would arrive after the clearing, on a page it is not about: a page reads
 * `navigation()` as it starts a request and gives it to `add` with the answer.
 */
function createToastStore() {
	const { subscribe, update } = writable<Toast[]>([]);

	return {
		subscribe,
		/**
		 * Show a toast. `started` is what `navigation()` was when the request
		 * this is about was started; a toast whose page has been left since is
		 * dropped. A failure the same as one shown takes its place, as the
		 * newest, and a failure over `MOST_FAILURES` puts the oldest away.
		 */
		add(message: string, type: Toast['type'] = 'success', started?: number) {
			if (started !== undefined && started !== navigations) return;
			const id = nextId++;
			if (type === 'error') {
				update(toasts => {
					const shown = [...toasts.filter(t => !(t.type === 'error' && t.message === message)), { id, message, type }];
					const failures = shown.filter(t => t.type === 'error');
					const gone = new Set(failures.slice(0, Math.max(0, failures.length - MOST_FAILURES)).map(t => t.id));
					return shown.filter(t => !gone.has(t.id));
				});
				return;
			}
			update(toasts => [...toasts, { id, message, type }]);
			setTimeout(() => {
				update(toasts => toasts.filter(t => t.id !== id));
			}, TOAST_MS);
		},
		/** Which navigation this is, as a count: read when a request starts and given to `add` with its answer. */
		navigation(): number {
			return navigations;
		},
		/** A navigation has begun: what a request started before it would say is not shown. */
		navigated() {
			navigations++;
		},
		dismiss(id: number) {
			update(toasts => toasts.filter(t => t.id !== id));
		},
		/** Every failure shown, gone: the page it was about has been left. */
		clearErrors() {
			update(toasts => toasts.filter(t => t.type !== 'error'));
		}
	};
}

export const toasts = createToastStore();
