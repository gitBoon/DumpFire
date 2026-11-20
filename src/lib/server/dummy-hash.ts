/**
 * dummy-hash.ts — the one password hash nothing matches, in a module of its own (card 2996, R20).
 *
 * passwords.ts re-exports it for the sign-in, which checks a name that is no account against it; the record of
 * account endings (account-endings.ts) reads it too, and must stay a leaf: passwords.ts loads bcryptjs and its worker
 * threads, which nothing that only compares a stored hash needs.
 */

/**
 * What a sign-in at a name that is no account checks its password against
 * (card 2192), so that it costs the one check a wrong password at an account
 * costs, and the time it takes does not tell which names are accounts. The
 * cost-12 hash of 32 random bytes, made once when the card was built
 * (`hashSync(randomBytes(32).toString('hex'), 12)`) and nothing else kept of
 * them: nothing is meant to match it. It must be at `BCRYPT_ROUNDS`, as every
 * stored hash is, or it would take another time (tests/password-checks.test.ts
 * holds it).
 *
 * An account the record of account endings ends as deleted, or as one this server
 * had before it recorded endings, is given it as its password (card 2996): no
 * password signs it in.
 */
export const DUMMY_HASH = '$2b$12$ZJoqPz9NkEAIQhAx09PXiOnu2GMT2hwKv5wcOhyNK5p9Kdx9GJ1He';
