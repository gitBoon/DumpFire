// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Error {
			message: string;
			/**
			 * The limit, in bytes, on the 413 for a body that passed its route's
			 * limit as it was read: see `heldToLimit` in $lib/server/body-limits.ts.
			 */
			limitBytes?: number;
		}
		interface Locals {
			user: {
				id: number;
				username: string;
				email: string;
				emoji: string;
				role: string;
			} | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
