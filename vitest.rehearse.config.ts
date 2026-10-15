import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// The rehearsal is not part of the suite. It takes the migration runner over a
// copy of a real database file, and `npm run rehearse` (scripts/rehearse.mjs)
// is what makes the copy and runs it. Everything else is the suite's own
// configuration, the in-memory DB_PATH above all: the application's connection
// must not be a real database here either.
export default defineConfig({
	...base,
	test: {
		...base.test,
		include: ['tests/rehearsal/**/*.rehearsal.ts'],
		// A real database is rebuilt at its real size. Ten minutes is far more
		// than any should take, and a rehearsal that is cut short proves nothing.
		testTimeout: 600_000
	}
});
