/**
 * The free space every test sees on the uploads volume (card 2920): never the
 * real disk's. `tests/setup.ts` installs `plentyOfSpace()` for every test file;
 * a test of the floor installs its own reader with `setFreeSpaceReader`, and
 * puts this one back after it.
 */
import { setFreeSpaceReader } from '$lib/server/upload-space';

/** What the stand-in answers: 1 TiB free of 2 TiB, far above any floor a test database makes. */
export const PLENTY_FREE_BYTES = 1024 ** 4;
export const PLENTY_TOTAL_BYTES = 2 * 1024 ** 4;

/** Install the stand-in that answers plenty of room, and forget the state. */
export function plentyOfSpace(): void {
	setFreeSpaceReader(async () => ({ freeBytes: PLENTY_FREE_BYTES, totalBytes: PLENTY_TOTAL_BYTES }));
}
