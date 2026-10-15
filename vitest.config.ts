import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		setupFiles: ['tests/setup.ts'],
		// Set before any module loads, so `$lib/server/db` opens an in-memory
		// database and never the real dumpfire.db. tests/setup.ts refuses to run
		// if this did not take effect.
		env: {
			DB_PATH: ':memory:',
			// tests/gate.test.ts loads src/hooks.server.ts, which starts the
			// backup, report and snapshot schedulers as a server does. Never
			// from a test, whatever kind of server vitest is taken to be.
			SCHEDULERS: 'off',
			// Passwords are hashed and checked on the test's own thread, a turn
			// later, and not on worker threads (card 2191): so a test's
			// vi.mock('bcryptjs') sees every call, and a check is still never
			// answered in the turn that asked for it. tests/password-checks.test.ts
			// starts real threads with setPasswordThreads().
			PASSWORD_THREADS: '0',
			// Attachment files go under the operating system's temp folder and
			// never to ./uploads, which holds real ones. tests/setup.ts refuses
			// to run without this, and gives each test file a folder of its own
			// beneath it.
			UPLOADS_DIR: join(tmpdir(), 'dumpfire-test-uploads'),
			// The logger prints every entry to the console; INFO and WARN from
			// several hundred route calls would bury the test output.
			LOG_LEVEL: 'ERROR'
		},
		// Each test file runs in its own process and so gets its own database.
		pool: 'forks'
	}
});
