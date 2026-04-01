import { writable } from 'svelte/store';
import { browser } from '$app/environment';

export type UserProfile = {
	name: string;
	emoji: string;
};

const defaultProfile: UserProfile = { name: '', emoji: '👤' };

const emojiOptions = ['👤', '🦊', '🐱', '🐶', '🦁', '🐼', '🐸', '🦉', '🐙', '🦄', '🐝', '🐳', '🚀', '⚡', '🔥', '💎'];

function createUserStore() {
	let stored: UserProfile = defaultProfile;
	if (browser) {
		try {
			const raw = localStorage.getItem('dumpfire-user');
			if (raw) stored = JSON.parse(raw);
		} catch {}
	}

	const { subscribe, set, update } = writable<UserProfile>(stored);

	return {
		subscribe,
		emojiOptions,
		setProfile(profile: UserProfile) {
			set(profile);
			if (browser) {
				localStorage.setItem('dumpfire-user', JSON.stringify(profile));
			}
		},
		clear() {
			set(defaultProfile);
			if (browser) {
				localStorage.removeItem('dumpfire-user');
			}
		}
	};
}

export const user = createUserStore();
