import { writable } from 'svelte/store';
import { browser } from '$app/environment';

function createThemeStore() {
	const initial = browser ? (localStorage.getItem('dumpfire-theme') as 'dark' | 'light') || 'dark' : 'dark';
	const { subscribe, set, update } = writable<'dark' | 'light'>(initial);

	return {
		subscribe,
		toggle() {
			update((current) => {
				const next = current === 'dark' ? 'light' : 'dark';
				if (browser) {
					document.documentElement.setAttribute('data-theme', next);
					localStorage.setItem('dumpfire-theme', next);
				}
				return next;
			});
		},
		set(value: 'dark' | 'light') {
			if (browser) {
				document.documentElement.setAttribute('data-theme', value);
				localStorage.setItem('dumpfire-theme', value);
			}
			set(value);
		}
	};
}

export const theme = createThemeStore();
