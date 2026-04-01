import { runMigrations, seedDefaultBoard } from '$lib/server/db/migrate';

// Run migrations and seed on server start
runMigrations();
seedDefaultBoard();

export async function handle({ event, resolve }) {
	return await resolve(event);
}
