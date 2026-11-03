/**
 * mail-words.ts — words about mail that the server and the browser both
 * show (card 2676, R4 and F7). Plain constants with no imports, so a module
 * the browser loads can use them; `src/lib/server/email.ts` re-exports
 * `NO_LINK_ADDRESS`, so its importers are unchanged.
 */

/** What a request is refused with when the link it would mail cannot be made. */
export const NO_LINK_ADDRESS =
	'This server has no address configured to make the link from, so nothing was sent and nothing was saved. ' +
	'An administrator sets it as the App URL on the admin page, under Application Settings; or the server is ' +
	'started with ORIGIN set to its public address';
