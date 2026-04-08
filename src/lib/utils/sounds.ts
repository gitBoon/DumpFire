/**
 * Sound effects for card interactions.
 *
 * Uses the Web Audio API to synthesize short UI sounds — no audio files required.
 * Each function is safe to call server-side (SSR); it simply no-ops when
 * `AudioContext` is unavailable.
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
	if (typeof window === 'undefined') return null;
	if (!audioCtx) {
		try {
			audioCtx = new AudioContext();
		} catch {
			return null;
		}
	}
	return audioCtx;
}

/**
 * A quick, subtle "pop" sound when a card is moved between columns.
 */
export function playMoveSound(): void {
	const ctx = getAudioContext();
	if (!ctx) return;

	const osc = ctx.createOscillator();
	const gain = ctx.createGain();

	osc.connect(gain);
	gain.connect(ctx.destination);

	osc.type = 'sine';
	osc.frequency.setValueAtTime(600, ctx.currentTime);
	osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.08);

	gain.gain.setValueAtTime(0.12, ctx.currentTime);
	gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);

	osc.start(ctx.currentTime);
	osc.stop(ctx.currentTime + 0.1);
}

/**
 * A cheerful two-tone chime when a card is completed.
 */
export function playCompleteSound(): void {
	const ctx = getAudioContext();
	if (!ctx) return;

	// First tone
	const osc1 = ctx.createOscillator();
	const gain1 = ctx.createGain();
	osc1.connect(gain1);
	gain1.connect(ctx.destination);
	osc1.type = 'sine';
	osc1.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
	gain1.gain.setValueAtTime(0.15, ctx.currentTime);
	gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
	osc1.start(ctx.currentTime);
	osc1.stop(ctx.currentTime + 0.15);

	// Second tone (higher, slightly delayed)
	const osc2 = ctx.createOscillator();
	const gain2 = ctx.createGain();
	osc2.connect(gain2);
	gain2.connect(ctx.destination);
	osc2.type = 'sine';
	osc2.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1); // E5
	gain2.gain.setValueAtTime(0.001, ctx.currentTime);
	gain2.gain.setValueAtTime(0.15, ctx.currentTime + 0.1);
	gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
	osc2.start(ctx.currentTime + 0.1);
	osc2.stop(ctx.currentTime + 0.25);
}
