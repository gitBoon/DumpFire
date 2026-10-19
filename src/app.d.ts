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
			/**
			 * What the gate let the request in with: the API key's row id, or the
			 * session's token, or null for neither. A handler that writes asks, in
			 * its transaction, that it is still open and who its account is now
			 * (`writeAs` in $lib/server/write-as.ts, card 2253). Undefined only
			 * where no gate ran: a test that calls a handler directly. Anywhere
			 * else a write refuses it (`stillAuthenticated` in $lib/server/auth.ts).
			 */
			credential?: import('$lib/server/auth').Credential | null;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			/**
			 * The node adapter's request, under the built server only: its
			 * socket says whether the caller has gone (`callerHasGone` in
			 * $lib/server/passwords.ts). Not there under `vite dev` or in tests.
			 */
			req?: import('node:http').IncomingMessage;
		}
	}
}

export {};
