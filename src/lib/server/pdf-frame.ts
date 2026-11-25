/**
 * pdf-frame.ts — the drawing pieces DumpFire's PDFs share (card 3077): the
 * report palette, the section title, the page-break check, the table, the dark
 * header band and the figure tiles. The activity report (`reports.ts`), the
 * delivery plan (`milestone-report.ts`) and a decision's PDF
 * (`decision-report.ts`) draw with them, so that the documents that land in the
 * same stakeholder packs look like one family.
 *
 * Moved here from `reports.ts` and `milestone-report.ts` as they were, but for
 * one addition: `drawTable` takes an optional `TableFrame`, through which the
 * decision PDF fits a table to its own pages, ceiling and parts. Called without
 * one, as the activity report calls it, it draws exactly as before, so the
 * activity report and the plan draw the same page content they drew before. A
 * plain module with no database, mail or route behind it, so that a PDF that
 * needs only the look does not load the report engine.
 *
 * Every function draws the text it is handed as it is: a caller drawing
 * anything a person wrote makes it safe (`pdfSafe`, `oneLine`) first.
 */

/**
 * The report palette. Shared because the plan and decision exports draw with
 * it too — these PDFs land in the same stakeholder packs, and a second look
 * would read as coming from somewhere else.
 */
export const REPORT_COLORS = {
	white: '#ffffff',
	bg: '#f8f9fc',
	headerBg: '#1e293b',
	headerText: '#f1f5f9',
	heading: '#0f172a',
	text: '#334155',
	textMuted: '#64748b',
	textLight: '#94a3b8',
	border: '#e2e8f0',
	borderLight: '#f1f5f9',
	accent: '#4f46e5',
	accentLight: '#e0e7ff',
	emerald: '#059669',
	emeraldLight: '#d1fae5',
	amber: '#d97706',
	amberLight: '#fef3c7',
	red: '#dc2626',
	redLight: '#fee2e2',
	blue: '#2563eb',
	blueLight: '#dbeafe',
	rowAlt: '#f8fafc',
	critical: '#dc2626',
	high: '#ea580c',
	medium: '#2563eb',
	low: '#64748b'
};

const C = REPORT_COLORS;

/** The margin the header band's text is set at, as the report and plan pages have it. */
const BAND_MARGIN = 40;

export function drawSectionTitle(doc: PDFKit.PDFDocument, title: string, x: number, y: number): number {
	doc.font('Helvetica-Bold').fontSize(12).fillColor(C.heading)
		.text(title, x, y);
	y += 18;
	doc.rect(x, y, 40, 2).fill(C.accent);
	return y + 10;
}

export function ensureSpace(doc: PDFKit.PDFDocument, needed: number, y: number): number {
	if (y + needed > doc.page.height - 50) {
		doc.addPage();
		return 40;
	}
	return y;
}

/**
 * How a table is fitted to a document with pages of its own (the decision PDF): without one, `drawTable` breaks
 * pages with `ensureSpace`, as the activity report's tables always have.
 */
export type TableFrame = {
	/** The y to draw `needed` points at: `y`, or the top of a new page where they do not fit. */
	ensure(needed: number, y: number): number;
	/** Asked before each row, the row's y given: false stops the table there, with no closing rule. */
	canDraw(y: number): boolean;
	/** The header row drawn again at the top of each page the table runs onto. */
	repeatHeader: boolean;
	/** Whether the header row is drawn at the start (default true): false for a table drawn in parts after its first. */
	header?: boolean;
	/** The index of the first row given among the table's rows, so that a table drawn in parts stripes as one. */
	firstRow?: number;
	/** Whether the closing rule is drawn after the last row given (default true). */
	close?: boolean;
};

/** A table: a dark header row, then rows striped white and `rowAlt`, each at least 16pt and as tall as its tallest cell. */
export function drawTable(
	doc: PDFKit.PDFDocument,
	headers: string[],
	rows: string[][],
	colWidths: number[],
	startX: number,
	startY: number,
	frame?: TableFrame
): number {
	const fontSize = 7.5;
	const headerHeight = 20;
	const rowPadding = 5;
	const cellPadding = 5;
	const tableWidth = colWidths.reduce((a, b) => a + b, 0);

	let y = startY;

	const drawHeader = () => {
		doc.rect(startX, y, tableWidth, headerHeight).fill(C.headerBg);
		let x = startX;
		doc.font('Helvetica-Bold').fontSize(fontSize).fillColor(C.headerText);
		for (let i = 0; i < headers.length; i++) {
			doc.text(headers[i], x + cellPadding, y + 5, {
				width: colWidths[i] - cellPadding * 2,
				height: headerHeight - 4,
				lineBreak: false
			});
			x += colWidths[i];
		}
		y += headerHeight;
	};

	const heightOfRow = (row: string[]) => {
		let rowH = 16;
		doc.font('Helvetica').fontSize(fontSize);
		for (let i = 0; i < row.length; i++) {
			const h = doc.heightOfString(row[i] || '', { width: colWidths[i] - cellPadding * 2 });
			rowH = Math.max(rowH, h + rowPadding * 2);
		}
		return rowH;
	};

	if (frame === undefined) {
		drawHeader();
	} else if (frame.header !== false) {
		// The header row never alone at a page's foot: it and the first row fit together.
		if (rows.length > 0) y = frame.ensure(headerHeight + heightOfRow(rows[0]), y);
		drawHeader();
	}

	for (let r = 0; r < rows.length; r++) {
		const row = rows[r];
		const rowH = heightOfRow(row);
		if (frame === undefined) {
			y = ensureSpace(doc, rowH, y);
		} else {
			if (!frame.canDraw(y)) return y;
			const page = doc.page;
			y = frame.ensure(rowH, y);
			if (doc.page !== page && frame.repeatHeader) {
				drawHeader();
				doc.font('Helvetica').fontSize(fontSize);
			}
		}

		const bg = (r + (frame?.firstRow ?? 0)) % 2 === 0 ? C.white : C.rowAlt;
		doc.rect(startX, y, tableWidth, rowH).fill(bg);
		doc.rect(startX, y + rowH - 0.5, tableWidth, 0.5).fill(C.borderLight);

		let x = startX;
		doc.fillColor(C.text);
		for (let i = 0; i < row.length; i++) {
			doc.text(row[i] || '—', x + cellPadding, y + rowPadding, {
				width: colWidths[i] - cellPadding * 2,
				height: rowH - rowPadding
			});
			x += colWidths[i];
		}
		y += rowH;
	}

	if (frame !== undefined && frame.close === false) return y;
	doc.rect(startX, y, tableWidth, 0.5).fill(C.border);
	return y + 2;
}

/**
 * The dark band across the top of a document's first page, 80pt: its name (18pt), what it is (11pt), one detail line
 * (8pt) and a footnote (7.5pt), as the delivery plan draws it. The caller's content starts at y 94.
 */
export function drawHeaderBand(doc: PDFKit.PDFDocument, band: { title: string; subtitle: string; detail: string; footnote: string }): void {
	const mx = BAND_MARGIN;
	const pw = doc.page.width - BAND_MARGIN * 2;
	doc.rect(0, 0, doc.page.width, 80).fill(C.headerBg);
	doc.font('Helvetica-Bold').fontSize(18).fillColor(C.headerText)
		.text(band.title, mx, 14, { width: pw });
	doc.font('Helvetica-Bold').fontSize(11).fillColor(C.accentLight)
		.text(band.subtitle, mx, 34, { width: pw, ellipsis: true });
	doc.font('Helvetica').fontSize(8).fillColor(C.headerText)
		.text(band.detail, mx, 54, { width: pw, ellipsis: true });
	doc.font('Helvetica').fontSize(7.5).fillColor(C.textLight)
		.text(band.footnote, mx, 66, { width: pw });
}

/** A figure tile: its value, its label (drawn upper case) and its two colours. */
export type MetricTile = { label: string; value: string | number; bg: string; fg: string };

/**
 * A row of figure tiles across `width`, 44pt high and 8pt apart, each value set smaller rather than wrapped where it
 * is too wide at 17pt, its label beneath it. Answers the y 50pt below the row's top.
 */
export function drawMetricTiles(doc: PDFKit.PDFDocument, tiles: MetricTile[], x: number, y: number, width: number): number {
	const gap = 8;
	const cw = (width - (tiles.length - 1) * gap) / tiles.length;
	for (let i = 0; i < tiles.length; i++) {
		const mt = tiles[i];
		const cx = x + i * (cw + gap);
		doc.roundedRect(cx, y, cw, 44, 4).fill(mt.bg);
		// A value too wide for its box at 17pt (open steps "193 of 412") is set
		// smaller rather than wrapped onto the label beneath it.
		const value = String(mt.value);
		let size = 17;
		doc.font('Helvetica-Bold').fontSize(size);
		while (size > 8 && doc.widthOfString(value) > cw - 6) doc.fontSize(--size);
		doc.fillColor(mt.fg)
			.text(value, cx, y + 7 + (17 - size) / 2, { width: cw, align: 'center' });
		doc.font('Helvetica').fontSize(5.6).fillColor(mt.fg)
			.text(mt.label.toUpperCase(), cx, y + 31, { width: cw, align: 'center' });
	}
	return y + 50;
}
