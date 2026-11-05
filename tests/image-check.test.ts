/**
 * Card 2754, slice S1: whether bytes are a PNG, JPEG, GIF or WebP image, and
 * those bytes with their metadata taken out (`$lib/server/image-check`).
 *
 * One case per path through each format's walk: what it keeps, what it
 * drops, each way it refuses, and the size ceiling. Then the walks against
 * bytes nobody would write: every truncation of a valid file, and seeded
 * random and changed bytes (S4 of the plan review), which may be refused but
 * must never throw.
 */
import { describe, expect, it } from 'vitest';
import {
	checkImage,
	imageTypeOf,
	MAX_PIXELS,
	MAX_SIDE,
	sniffImage,
	type CheckedImage,
	type ImageType,
	type RefusedImage
} from '$lib/server/image-check';
import {
	be16,
	be32,
	bytes,
	DHT,
	DQT,
	gif,
	gifExtension,
	gifImage,
	GRAPHIC_CONTROL,
	ihdr,
	JFIF,
	jpeg,
	jpegSegment,
	le16,
	le24,
	le32,
	LOOP,
	png,
	pngChunk,
	riffChunk,
	sof,
	SOS,
	vp8,
	vp8l,
	vp8x,
	webp,
	webpOf,
	type Bytes
} from './helpers/image-bytes';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function accepted(input: Bytes, declared: string): CheckedImage {
	const result = checkImage(input, declared);
	if (!result.ok) throw new Error(`refused ${result.status}: ${result.message}`);
	return result;
}

/** The 400 message for bytes that are not a valid image of their type. */
function invalid(input: Bytes, declared: string): string {
	const result = checkImage(input, declared);
	expect(result.ok, 'accepted').toBe(false);
	expect((result as RefusedImage).status, (result as RefusedImage).message).toBe(400);
	return (result as RefusedImage).message;
}

/** The bytes as text, one character a byte, to look for what was dropped. */
const text = (input: Bytes) => Buffer.from(input).toString('latin1');

/** A PNG's chunk names, in order. */
function pngChunks(input: Bytes): string[] {
	const names: string[] = [];
	for (let at = 8; at < input.length; ) {
		const length = Buffer.from(input).readUInt32BE(at);
		names.push(text(input.subarray(at + 4, at + 8)));
		at += 12 + length;
	}
	return names;
}

/** A JPEG's markers, in order, its scans' data passed over. */
function jpegMarkers(input: Bytes): number[] {
	const markers: number[] = [0xd8];
	let at = 2;
	while (at < input.length) {
		const marker = input[at + 1];
		markers.push(marker);
		if (marker === 0xd9) break;
		at += 2 + input[at + 2] * 256 + input[at + 3];
		if (marker === 0xda) {
			while (at < input.length && !(input[at] === 0xff && input[at + 1] !== 0x00 && (input[at + 1] < 0xd0 || input[at + 1] > 0xd7))) at++;
		}
	}
	return markers;
}

/** A RIFF file's chunk names, in order. */
function riffChunks(input: Bytes): string[] {
	const names: string[] = [];
	for (let at = 12; at < input.length; ) {
		const length = Buffer.from(input).readUInt32LE(at + 4);
		names.push(text(input.subarray(at, at + 4)));
		at += 8 + length + (length & 1);
	}
	return names;
}

/** A GIF's blocks after its colour table: `image`, `ext <label>` (an application one by its name), `trailer`. */
function gifBlocks(input: Bytes): string[] {
	const blocks: string[] = [];
	let at = 13 + (input[10] & 0x80 ? 3 * (1 << ((input[10] & 7) + 1)) : 0);
	const pastSubBlocks = (from: number) => {
		while (input[from] !== 0) from += 1 + input[from];
		return from + 1;
	};
	while (at < input.length) {
		if (input[at] === 0x3b) {
			blocks.push('trailer');
			at++;
		} else if (input[at] === 0x2c) {
			blocks.push('image');
			at = pastSubBlocks(at + 11);
		} else {
			const label = input[at + 1];
			blocks.push(label === 0xff ? `ext ${text(input.subarray(at + 3, at + 14))}` : `ext ${label.toString(16)}`);
			at = pastSubBlocks(at + 2);
		}
	}
	return blocks;
}

// ─── What the bytes claim ───────────────────────────────────────────────────

describe('sniffImage', () => {
	it('names each format by its magic bytes, and nothing else', () => {
		expect(sniffImage(png())).toBe('image/png');
		expect(sniffImage(jpeg())).toBe('image/jpeg');
		expect(sniffImage(gif())).toBe('image/gif');
		expect(sniffImage(bytes('GIF87a', 0, 0))).toBe('image/gif');
		expect(sniffImage(webp())).toBe('image/webp');

		for (const [what, input] of [
			['SVG', bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')],
			['HTML', bytes('<!doctype html><p>hi')],
			['nothing', bytes()],
			['the start of a PNG', bytes(0x89, 0x50, 0x4e)],
			['a RIFF that is not WebP', bytes('RIFF', le32(4), 'WAVE')],
			['GIF88a', bytes('GIF88a')]
		] as const) {
			expect(sniffImage(input), what).toBeNull();
		}
	});
});

describe('imageTypeOf', () => {
	it('reads a Content-Type as one of the four, its parameters and case aside', () => {
		expect(imageTypeOf('IMAGE/PNG; q=1')).toBe('image/png');
		expect(imageTypeOf(' image/webp ')).toBe('image/webp');
		expect(imageTypeOf('image/svg+xml')).toBeNull();
		expect(imageTypeOf('image/jpg')).toBeNull();
		expect(imageTypeOf(null)).toBeNull();
	});
});

// ─── The happy path, each walker ────────────────────────────────────────────

describe('a valid image of each format', () => {
	it.each([
		['PNG', png({ width: 3, height: 5 }), 'image/png', 'png', 3, 5],
		['baseline JPEG', jpeg({ width: 7, height: 4 }), 'image/jpeg', 'jpg', 7, 4],
		['progressive JPEG with restarts', jpeg({ width: 9, height: 2, progressive: true, restarts: true }), 'image/jpeg', 'jpg', 9, 2],
		['GIF', gif({ width: 4, height: 3 }), 'image/gif', 'gif', 4, 3],
		['lossy WebP', webp('lossy', 5, 7), 'image/webp', 'webp', 5, 7],
		['lossless WebP', webp('lossless', 6, 4), 'image/webp', 'webp', 6, 4],
		['extended WebP', webpOf(vp8x(3, 3, 0x10), riffChunk('ALPH', [0]), vp8(3, 3)), 'image/webp', 'webp', 3, 3]
	] as const)('passes a %s, with its type, extension and size, and its bytes as they were', (_what, input, type, extension, width, height) => {
		const result = accepted(input, type);
		expect(result).toMatchObject({ ok: true, mimeType: type, extension, width, height });
		expect(result.bytes).toEqual(input);
	});
});

describe('the declared type', () => {
	it('is refused 415 when it is not one of the four, or the bytes are another', () => {
		expect(checkImage(png(), 'image/svg+xml')).toEqual({
			ok: false,
			status: 415,
			message: 'Content-Type must be image/png, image/jpeg, image/gif or image/webp'
		});
		expect(checkImage(jpeg(), 'image/png')).toEqual({ ok: false, status: 415, message: 'The body is a JPEG image, not the image/png its Content-Type says' });
		expect(checkImage(bytes('<svg/>'), 'image/png')).toEqual({ ok: false, status: 415, message: 'The body is not a PNG, JPEG, GIF or WebP image' });
		expect(checkImage(bytes(), 'image/gif')).toMatchObject({ ok: false, status: 415 });
		expect(accepted(png(), 'IMAGE/PNG; q=1').mimeType).toBe('image/png');
	});
});

// ─── PNG ────────────────────────────────────────────────────────────────────

describe('a PNG', () => {
	it('keeps its colour, transparency and pixel-size chunks and drops every other ancillary chunk', () => {
		const input = png({
			before: [
				pngChunk('tEXt', 'Author\0Somebody'),
				pngChunk('PLTE', [0, 0, 0, 255, 255, 255]),
				pngChunk('tRNS', [0, 0, 0, 0, 0, 0]),
				pngChunk('gAMA', be32(45455)),
				pngChunk('cHRM', new Array(32).fill(1)),
				pngChunk('sRGB', [0]),
				pngChunk('iCCP', 'sRGB\0\0profile'),
				pngChunk('cICP', [1, 13, 0, 1]),
				pngChunk('sBIT', [8, 8, 8]),
				pngChunk('pHYs', [0, 0, 11, 19, 0, 0, 11, 19, 1]),
				pngChunk('zTXt', 'Comment\0\0secret'),
				pngChunk('iTXt', 'XML:com.adobe.xmp\0\0\0\0\0secret'),
				pngChunk('eXIf', 'MM\0*secret'),
				pngChunk('tIME', [7, 234, 11, 5, 12, 0, 0]),
				pngChunk('bKGD', [0, 0, 0, 0, 0, 0])
			],
			after: [pngChunk('tEXt', 'Comment\0secret')]
		});

		const result = accepted(input, 'image/png');

		expect(pngChunks(result.bytes)).toEqual(['IHDR', 'PLTE', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'cICP', 'sBIT', 'pHYs', 'IDAT', 'IEND']);
		expect(text(result.bytes)).not.toMatch(/secret|Somebody/);
		expect(result.bytes.subarray(0, 8)).toEqual(Uint8Array.from(PNG_SIGNATURE));
	});

	const SIG = PNG_SIGNATURE;
	const IDAT = pngChunk('IDAT', [1, 2, 3]);
	const IEND = pngChunk('IEND');
	const badCrc = png();
	badCrc[32] ^= 0xff;

	it.each([
		['a wrong checksum', badCrc, /IHDR chunk's checksum is wrong/],
		['an unknown critical chunk', png({ before: [pngChunk('ABCD', 'x')] }), /critical chunk, ABCD,/],
		['no IHDR first', png({ header: bytes(pngChunk('sRGB', [0]), ihdr(2, 2)) }), /does not start with IHDR/],
		['an IHDR of the wrong length', png({ header: pngChunk('IHDR', new Array(12).fill(1)) }), /IHDR is the wrong length/],
		['a depth its colour type does not allow', png({ header: ihdr(2, 2, 4, 2) }), /colour type and bit depth/],
		['a colour type PNG does not have', png({ header: ihdr(2, 2, 8, 5) }), /colour type and bit depth/],
		['no width', png({ header: ihdr(0, 2) }), /size is not one a PNG allows/],
		['a second IHDR', png({ before: [ihdr(2, 2)] }), /second IHDR/],
		['a palette after the image data', png({ after: [pngChunk('PLTE', [0, 0, 0])] }), /palette is out of place/],
		['a palette image with no palette', png({ header: ihdr(2, 2, 8, 3) }), /palette image has no palette/],
		['a grey image with a palette', png({ header: ihdr(2, 2, 8, 0), before: [pngChunk('PLTE', [0, 0, 0])] }), /grey image has a palette/],
		['IDAT chunks apart', bytes(SIG, ihdr(1, 1), IDAT, pngChunk('gAMA', be32(1)), IDAT, IEND), /IDAT chunks are not together/],
		['no image data', bytes(SIG, ihdr(1, 1), IEND), /no image data/],
		['an IEND that is not empty', bytes(SIG, ihdr(1, 1), IDAT, pngChunk('IEND', [0])), /IEND is not empty/],
		['a chunk past the end', bytes(SIG, ihdr(1, 1), be32(100), 'IDAT', [1, 2, 3]), /runs past the end/],
		['a chunk longer than PNG allows', bytes(SIG, ihdr(1, 1), be32(0x80000000), 'IDAT', [1, 2, 3]), /longer than a PNG allows/],
		['a chunk name that is not four letters', png({ before: [pngChunk('ab1c', 'x')] }), /not four letters/],
		['acTL', png({ before: [pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0])] }), /animated PNG/],
		['fcTL', png({ before: [pngChunk('fcTL', new Array(26).fill(0))] }), /animated PNG/],
		['fdAT', png({ after: [pngChunk('fdAT', [0, 0, 0, 1])] }), /animated PNG/],
		['a byte after IEND', bytes(png(), 0), /bytes after IEND/],
		['a second file after IEND', bytes(png(), webp()), /bytes after IEND/]
	] as const)('is refused 400 for %s', (_what, input, message) => {
		expect(invalid(input, 'image/png')).toMatch(message);
	});
});

// ─── JPEG ───────────────────────────────────────────────────────────────────

describe('a JPEG', () => {
	const app = (n: number, data: string | Bytes) => jpegSegment(0xe0 + n, data);

	it('keeps JFIF without its thumbnail, ICC and Adobe, and drops every other application segment and comment, between scans too', () => {
		const input = jpeg({
			progressive: true,
			restarts: true,
			before: [
				app(0, bytes('JFIF\0', 1, 2, 0, be16(72), be16(72), 1, 1, [1, 2, 3])),
				app(0, 'JFXX\0\x10thumbnail-secret'),
				app(1, 'Exif\0\0MM\0*secret'),
				app(1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>secret</x:xmpmeta>'),
				app(2, 'ICC_PROFILE\0\x01\x01profile'),
				app(2, 'MPF\0secret'),
				app(3, 'secret'),
				app(13, 'Photoshop 3.0\x008BIMsecret'),
				app(14, bytes('Adobe', 0, 100, 0, 0, 0, 0, 1)),
				app(15, 'secret'),
				jpegSegment(0xfe, 'a comment, secret')
			],
			between: [jpegSegment(0xfe, 'between scans, secret'), app(1, 'Exif\0\0between secret'), DHT]
		});

		const result = accepted(input, 'image/jpeg');

		expect(jpegMarkers(result.bytes)).toEqual([0xd8, 0xe0, 0xe2, 0xee, 0xdb, 0xc2, 0xc4, 0xdd, 0xda, 0xc4, 0xda, 0xd9]);
		expect(text(result.bytes)).not.toMatch(/secret|thumbnail/);
		// JFIF as it was, with a 0 x 0 thumbnail and no thumbnail data.
		expect(result.bytes.subarray(2, 20)).toEqual(bytes(0xff, 0xe0, 0, 16, 'JFIF\0', 1, 2, 0, be16(72), be16(72), 0, 0));
		expect(text(result.bytes)).toContain('ICC_PROFILE');
		expect(text(result.bytes)).toContain('Adobe');
	});

	it('passes over fill bytes before a marker, and drops them', () => {
		const plain = jpeg();
		const filled = bytes(plain.subarray(0, 2), 0xff, 0xff, plain.subarray(2));
		expect(accepted(filled, 'image/jpeg').bytes).toEqual(plain);
	});

	const SOI = [0xff, 0xd8];
	const afterSoi = jpeg().subarray(2);

	it.each([
		['a segment shorter than its own length', bytes(SOI, 0xff, 0xe1, 0, 1, afterSoi), /shorter than its own length/],
		['a segment past the end', bytes(SOI, 0xff, 0xe1, 0xff, 0xff, 'x'), /segment runs past the end/],
		['a frame with no height', jpeg({ frame: sof(2, 0) }), /frame has no height/],
		['a frame with no width', jpeg({ frame: sof(0, 2) }), /frame has no width/],
		['a 12-bit baseline frame', jpeg({ frame: jpegSegment(0xc0, [12, 0, 2, 0, 2, 1, 1, 0x11, 0]) }), /precision/],
		['a frame of the wrong length', jpeg({ frame: jpegSegment(0xc0, [8, 0, 2, 0, 2, 2, 1, 0x11, 0]) }), /frame is the wrong length/],
		['a second frame', jpeg({ before: [JFIF, sof(2, 2)] }), /more than one frame/],
		['a scan before the frame', bytes(SOI, DQT, SOS, 0x12, 0xff, 0xd9), /scan comes before the frame/],
		['a scan header of the wrong length', bytes(SOI, sof(2, 2), jpegSegment(0xda, [1, 1, 0, 0, 63]), 0x12, 0xff, 0xd9), /scan header/],
		['a lossless frame', jpeg({ frame: sof(2, 2, 0xc3) }), /0xFFC3, that is not accepted/],
		['a hierarchical frame', jpeg({ frame: sof(2, 2, 0xc5) }), /0xFFC5, that is not accepted/],
		['an arithmetic-coded frame', jpeg({ frame: sof(2, 2, 0xc9) }), /0xFFC9, that is not accepted/],
		['DNL', jpeg({ before: [JFIF, jpegSegment(0xdc, be16(2))] }), /0xFFDC, that is not accepted/],
		['a restart interval longer than two bytes', jpeg({ before: [JFIF, jpegSegment(0xdd, [0, 1, ...bytes('secret')])] }), /restart interval is the wrong length/],
		['an Adobe segment longer than twelve bytes', jpeg({ before: [JFIF, app(14, bytes('Adobe', 0, 100, 0, 0, 0, 0, 1, 'secret'))] }), /Adobe segment is the wrong length/],
		['a restart marker between segments', bytes(SOI, 0xff, 0xd0, afterSoi), /marker out of place/],
		['a second SOI', bytes(SOI, SOI, afterSoi), /marker out of place/],
		['a byte that is not a marker between segments', bytes(SOI, JFIF, 0x00, jpeg({ before: [] }).subarray(2)), /not a marker/],
		['no EOI', jpeg().subarray(0, jpeg().length - 2), /ends inside a scan/],
		['a byte after EOI', bytes(jpeg(), 0), /bytes after EOI/],
		['a second file after EOI', bytes(jpeg(), png()), /bytes after EOI/],
		['no scan', bytes(SOI, JFIF, DQT, sof(2, 2), 0xff, 0xd9), /no image data/]
	] as const)('is refused 400 for %s', (_what, input, message) => {
		expect(invalid(input, 'image/jpeg')).toMatch(message);
	});
});

// ─── GIF ────────────────────────────────────────────────────────────────────

describe('a GIF', () => {
	it('keeps its graphic control and loop extensions, and drops comments, plain text and other application extensions', () => {
		const input = gif({
			before: [
				gifExtension(0xfe, 'a comment, secret'),
				GRAPHIC_CONTROL,
				LOOP,
				gifExtension(0xff, 'XMP DataXMP', '<x:xmpmeta>secret</x:xmpmeta>'),
				gifExtension(0x01, new Array(12).fill(0), 'plain text, secret')
			],
			after: [gifExtension(0xfe, 'after the image, secret')]
		});

		const result = accepted(input, 'image/gif');

		expect(gifBlocks(result.bytes)).toEqual(['ext f9', 'ext NETSCAPE2.0', 'image', 'trailer']);
		expect(text(result.bytes)).not.toMatch(/secret|XMP/);
	});

	/** A GIF's image descriptor with a given LZW code size. */
	const withCodeSize = (size: number) => bytes(0x2c, le16(0), le16(0), le16(2), le16(2), 0, size, 2, 0x44, 0x01, 0);

	it.each([
		['two images', gif({ frames: 2 }), /more than one image: an animated GIF/],
		['an image outside its screen', gif({ frames: 0, before: [gifImage(2, 2, 1, 0)] }), /not inside its screen/],
		['an image taller than its screen', gif({ frames: 0, before: [gifImage(2, 3)] }), /not inside its screen/],
		['a sub-block past the end', bytes(gif().subarray(0, 19), 0x21, 0xfe, 10, 'abc'), /ends inside a block/],
		['no trailer', gif().subarray(0, gif().length - 1), /ends before its trailer/],
		['a byte after the trailer', bytes(gif(), 0), /bytes after its trailer/],
		['a second file after the trailer', bytes(gif(), png()), /bytes after its trailer/],
		['an unknown extension', gif({ before: [gifExtension(0x99, 'x')] }), /extension that is not accepted/],
		['a byte that starts no block', gif({ before: [bytes(0)] }), /starts no block/],
		['a code size of 1', gif({ frames: 0, before: [withCodeSize(1)] }), /code size/],
		['a code size of 9', gif({ frames: 0, before: [withCodeSize(9)] }), /code size/],
		['a screen with no width', gif({ width: 0 }), /screen has no size/],
		['a graphic control block of the wrong length', gif({ before: [gifExtension(0xf9, [1, 0, 0])] }), /graphic control block/],
		['a graphic control block with a second sub-block', gif({ before: [gifExtension(0xf9, [1, 0, 0, 0], 'secret')] }), /graphic control block/],
		['a loop extension with a second sub-block', gif({ before: [gifExtension(0xff, 'NETSCAPE2.0', [1, 0, 0], 'secret')] }), /loop extension is the wrong length/],
		['no image', gif({ frames: 0 }), /has no image/]
	] as const)('is refused 400 for %s', (_what, input, message) => {
		expect(invalid(input, 'image/gif')).toMatch(message);
	});
});

// ─── WebP ───────────────────────────────────────────────────────────────────

describe('a WebP', () => {
	it('drops EXIF and XMP, clears only their VP8X flags, keeps ICC and alpha, and writes its RIFF size again', () => {
		const input = webpOf(
			vp8x(2, 2, 0x20 | 0x10 | 0x08 | 0x04),
			riffChunk('ICCP', 'icc'),
			riffChunk('ALPH', [0]),
			vp8(2, 2),
			riffChunk('EXIF', 'Exif\0\0secret'),
			riffChunk('XMP ', '<x:xmpmeta>secret</x:xmpmeta>')
		);

		const result = accepted(input, 'image/webp');

		expect(riffChunks(result.bytes)).toEqual(['VP8X', 'ICCP', 'ALPH', 'VP8 ']);
		expect(result.bytes[20]).toBe(0x30);
		expect(Buffer.from(result.bytes).readUInt32LE(4)).toBe(result.bytes.length - 8);
		expect(text(result.bytes)).not.toMatch(/secret/);
		// ICCP is 3 bytes, so it keeps its pad byte, and the output reads again.
		expect(accepted(result.bytes, 'image/webp').bytes).toEqual(result.bytes);
	});

	const vp8With = (tag: number, start: readonly number[]) =>
		riffChunk('VP8 ', [...le24(tag), ...start, ...le16(2), ...le16(2), 0, 0, 0]);
	const KEY = (3 << 5) | (1 << 4);

	it.each([
		['a RIFF size shorter than the file', bytes(webp(), 0, 0), /bytes after its RIFF data/],
		['a second file after the RIFF data', bytes(webp(), png()), /bytes after its RIFF data/],
		['a RIFF size longer than the file', webp().subarray(0, webp().length - 1), /ends before its RIFF data/],
		['ANIM', webpOf(vp8x(2, 2), riffChunk('ANIM', new Array(6).fill(0)), vp8l(2, 2)), /animated WebP/],
		['ANMF', webpOf(vp8x(2, 2), vp8l(2, 2), riffChunk('ANMF', new Array(16).fill(0))), /animated WebP/],
		['the animation flag', webpOf(vp8x(2, 2, 0x02), vp8l(2, 2)), /animated WebP/],
		['an unknown chunk', webpOf(vp8x(2, 2), riffChunk('ABCD', 'x'), vp8l(2, 2)), /"ABCD", that is not accepted/],
		['two images', webpOf(vp8x(2, 2), vp8l(2, 2), vp8l(2, 2)), /more than one image/],
		['no image', webpOf(vp8x(2, 2)), /has no image/],
		['no chunk at all', webpOf(), /has no image/],
		['ICCP not straight after VP8X', webpOf(vp8x(2, 2), riffChunk('ALPH', [0]), riffChunk('ICCP', 'i'), vp8(2, 2)), /ICCP chunk/],
		['ALPH after the image', webpOf(vp8x(2, 2), vp8(2, 2), riffChunk('ALPH', [0])), /ALPH chunk is out of place/],
		['ALPH with a lossless image', webpOf(vp8x(2, 2), riffChunk('ALPH', [0]), vp8l(2, 2)), /ALPH chunk with a lossless image/],
		['a simple file with a second chunk', webpOf(vp8l(2, 2), riffChunk('EXIF', 'x')), /simple WebP has more than its image/],
		['a first chunk that is no image', webpOf(riffChunk('EXIF', 'x'), vp8l(2, 2)), /does not start with VP8, VP8L or VP8X/],
		['a VP8X of the wrong length', webpOf(riffChunk('VP8X', new Array(9).fill(0)), vp8l(2, 2)), /VP8X chunk is the wrong length/],
		['a missing pad byte', bytes('RIFF', le32(4 + 8 + 7), 'WEBP', 'VP8L', le32(7), [0x2f, ...le32((1 << 14) | 1), 0, 0]), /pad byte is missing/],
		['a chunk past the end', bytes('RIFF', le32(4 + 8 + 2), 'WEBP', 'VP8L', le32(100), [0x2f, 0]), /chunk runs past the end/],
		['a VP8 frame that is not a key frame', webpOf(vp8With(KEY | 1, [0x9d, 0x01, 0x2a])), /key frame/],
		['a VP8 start code that is wrong', webpOf(vp8With(KEY, [0x9d, 0x01, 0x2b])), /no start code/],
		['a VP8 version it does not have', webpOf(vp8With(KEY | (5 << 1), [0x9d, 0x01, 0x2a])), /version VP8 does not have/],
		['a VP8 partition longer than its data', webpOf(vp8With((99 << 5) | (1 << 4), [0x9d, 0x01, 0x2a])), /shorter than it says/],
		['a VP8L signature that is wrong', webpOf(riffChunk('VP8L', [0x2e, 0, 0, 0, 0, 0, 0])), /VP8L data has no signature/],
		['a VP8L version it does not have', webpOf(riffChunk('VP8L', [0x2f, ...le32(0x20000000), 0, 0])), /version VP8L does not have/],
		['an image that is not the size of its canvas', webpOf(vp8x(3, 3), vp8l(2, 2)), /not the size its canvas says/]
	] as const)('is refused 400 for %s', (_what, input, message) => {
		expect(invalid(input, 'image/webp')).toMatch(message);
	});
});

// ─── Size ───────────────────────────────────────────────────────────────────

describe('the size ceiling', () => {
	it('refuses more than 8000 pixels on a side or 40 megapixels in all, and passes 8000 x 5000', () => {
		expect([MAX_SIDE, MAX_PIXELS]).toEqual([8000, 40_000_000]);
		expect(invalid(png({ width: 8001, height: 1 }), 'image/png')).toBe(
			'The image is 8001 x 1 pixels: the most accepted is 8000 on a side and 40,000,000 in all'
		);
		expect(invalid(png({ width: 1, height: 8001 }), 'image/png')).toMatch(/1 x 8001 pixels/);
		expect(invalid(png({ width: 7000, height: 7000 }), 'image/png')).toMatch(/7000 x 7000 pixels/);
		expect(invalid(webpOf(vp8x(8001, 1), vp8l(8001, 1)), 'image/webp')).toMatch(/8001 x 1 pixels/);
		expect(accepted(png({ width: 8000, height: 5000 }), 'image/png')).toMatchObject({ width: 8000, height: 5000 });
	});
});

// ─── Bytes nobody would write ───────────────────────────────────────────────

/** A valid file of each kind, with something to strip in most. */
const SAMPLES: [string, Bytes, ImageType][] = [
	['PNG', png({ before: [pngChunk('tEXt', 'a\0b'), pngChunk('sRGB', [0])], idat: 2 }), 'image/png'],
	['baseline JPEG', jpeg({ before: [JFIF, jpegSegment(0xe1, 'Exif\0\0x')] }), 'image/jpeg'],
	['progressive JPEG', jpeg({ progressive: true, restarts: true, between: [jpegSegment(0xfe, 'x')] }), 'image/jpeg'],
	['GIF', gif({ before: [GRAPHIC_CONTROL, LOOP, gifExtension(0xfe, 'x')] }), 'image/gif'],
	['lossless WebP', webp('lossless'), 'image/webp'],
	['lossy WebP', webp('lossy'), 'image/webp'],
	['extended WebP', webpOf(vp8x(2, 2, 0x38), riffChunk('ICCP', 'icc'), riffChunk('ALPH', [0]), vp8(2, 2), riffChunk('EXIF', 'x')), 'image/webp']
];

/** A seeded generator (mulberry32), so a failure can be run again. */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('bytes nobody would write', () => {
	it('refuses every truncation of each valid file, and never throws', () => {
		const accepted: string[] = [];
		for (const [what, sample, type] of SAMPLES) {
			expect(checkImage(sample, type).ok, what).toBe(true);
			for (let length = 0; length < sample.length; length++) {
				if (checkImage(sample.subarray(0, length), type).ok) accepted.push(`${what} cut to ${length} of ${sample.length}`);
			}
		}
		expect(accepted).toEqual([]);
	});

	it('answers seeded random bytes and seeded changes to each file with an image or a refusal, never a throw, in bounded time', () => {
		const random = seeded(2754);
		const byte = () => Math.floor(random() * 256);
		const MAGIC: Record<ImageType, Bytes> = {
			'image/png': Uint8Array.from(PNG_SIGNATURE),
			'image/jpeg': bytes(0xff, 0xd8, 0xff),
			'image/gif': bytes('GIF89a'),
			'image/webp': bytes('RIFF', le32(64), 'WEBP')
		};
		const inputs: [Bytes, ImageType][] = [];
		for (const type of Object.keys(MAGIC) as ImageType[]) {
			for (let n = 0; n < 300; n++) {
				const tail = Array.from({ length: Math.floor(random() * 200) }, byte);
				inputs.push([bytes(MAGIC[type], tail), type]);
			}
		}
		for (const [, sample, type] of SAMPLES) {
			for (let n = 0; n < 300; n++) {
				const changed = sample.slice();
				const changes = 1 + Math.floor(random() * 4);
				for (let c = 0; c < changes; c++) changed[Math.floor(random() * changed.length)] = byte();
				inputs.push([changed, type]);
			}
		}

		const thrown: string[] = [];
		const notStable: string[] = [];
		const start = Date.now();
		for (const [input, type] of inputs) {
			try {
				const result = checkImage(input, type);
				if (result.ok) {
					const again = checkImage(result.bytes, type);
					if (!again.ok || Buffer.compare(Buffer.from(again.bytes), Buffer.from(result.bytes)) !== 0) {
						notStable.push(Buffer.from(input).toString('hex'));
					}
				} else {
					expect([400, 415]).toContain(result.status);
				}
			} catch (err) {
				thrown.push(`${Buffer.from(input).toString('hex')}: ${err instanceof Error ? err.stack : String(err)}`);
			}
		}

		expect(thrown).toEqual([]);
		// What is accepted, once stripped, is accepted again unchanged.
		expect(notStable).toEqual([]);
		expect(Date.now() - start).toBeLessThan(10_000);
	});
});
