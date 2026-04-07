import { writable } from 'svelte/store';
import { browser } from '$app/environment';

export type ThemeName = 'light' | 'dark' | 'solarized' | 'coffee' | 'rose' | 'cappuccino'
	| 'midnight' | 'ocean' | 'forest' | 'lavender' | 'sunset' | 'nord' | 'dracula' | 'monokai' | 'cherry' | 'arctic' | 'hacker';

export const THEMES: { id: ThemeName; label: string; icon: string }[] = [
	{ id: 'light',      label: 'Light',       icon: '☀️' },
	{ id: 'dark',       label: 'Dark',        icon: '🌙' },
	{ id: 'solarized',  label: 'Solarized',   icon: '🌅' },
	{ id: 'coffee',     label: 'Coffee',      icon: '☕' },
	{ id: 'rose',       label: 'Rosé',        icon: '🌸' },
	{ id: 'cappuccino', label: 'Cappuccino',  icon: '🤎' },
	{ id: 'midnight',   label: 'Midnight',    icon: '🌌' },
	{ id: 'ocean',      label: 'Ocean',       icon: '🌊' },
	{ id: 'forest',     label: 'Forest',      icon: '🌲' },
	{ id: 'lavender',   label: 'Lavender',    icon: '💜' },
	{ id: 'sunset',     label: 'Sunset',      icon: '🌇' },
	{ id: 'nord',       label: 'Nord',        icon: '❄️' },
	{ id: 'dracula',    label: 'Dracula',     icon: '🧛' },
	{ id: 'monokai',    label: 'Monokai',     icon: '🎨' },
	{ id: 'cherry',     label: 'Cherry',      icon: '🍒' },
	{ id: 'arctic',     label: 'Arctic',      icon: '🏔️' },
	{ id: 'hacker',     label: 'Hacker',      icon: '💻' }
];

function createThemeStore() {
	const initial = browser ? (localStorage.getItem('dumpfire-theme') as ThemeName) || 'light' : 'light';
	const { subscribe, set: rawSet, update } = writable<ThemeName>(initial);

	function applyTheme(name: ThemeName) {
		if (browser) {
			document.documentElement.setAttribute('data-theme', name);
			localStorage.setItem('dumpfire-theme', name);
		}
	}

	return {
		subscribe,
		set(value: ThemeName) {
			applyTheme(value);
			rawSet(value);
		},
		toggle() {
			update((current) => {
				const idx = THEMES.findIndex(t => t.id === current);
				const next = THEMES[(idx + 1) % THEMES.length].id;
				applyTheme(next);
				return next;
			});
		},
		next() {
			update((current) => {
				const idx = THEMES.findIndex(t => t.id === current);
				const next = THEMES[(idx + 1) % THEMES.length].id;
				applyTheme(next);
				return next;
			});
		}
	};
}

export const theme = createThemeStore();
