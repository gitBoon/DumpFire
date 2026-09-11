/**
 * milestone-report.ts — a milestone plan as a PDF.
 *
 * Deliberately drawn with the report palette and helpers from `reports.ts`
 * rather than its own look: these documents land in the same stakeholder packs
 * as the board reports, and a second visual language would read as coming from
 * somewhere else.
 *
 * Takes the `MilestoneSummary` the planning engine already produces, so the
 * document and the screen cannot disagree about what the critical path is.
 *
 * Written for someone who does not use DumpFire: no in-app jargon, and the
 * figures are explained rather than left to be inferred.
 */

import PDFDocument from 'pdfkit';
import {
	REPORT_COLORS as C,
	stripTag,
	drawSectionTitle,
	ensureSpace,
	formatDate
} from './reports';
import type { MilestoneSummary, MilestoneNode, PlanNode } from './planning';

/** A4 portrait with the same margins the board reports use. */
const MARGIN = 40;

const label = (n: { kind: string; id: number; parentCardId?: number }) =>
	n.kind === 'subtask' ? `step of #${n.parentCardId ?? '?'}` : `#${n.id}`;

const stateOf = (n: MilestoneNode): 'Done' | 'Blocked' | 'Startable' =>
	n.isComplete ? 'Done' : n.openBlockers.length > 0 ? 'Blocked' : 'Startable';

const stateColour = (s: string) =>
	s === 'Done' ? C.emerald : s === 'Blocked' ? C.amber : C.blue;

/** Wrap-aware text height, so a row can be sized before it is drawn. */
function heightOf(doc: PDFKit.PDFDocument, text: string, width: number, size: number): number {
	doc.font('Helvetica').fontSize(size);
	return doc.heightOfString(text || ' ', { width });
}

export async function generateMilestonePdf(summary: MilestoneSummary): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const m = summary.milestone;
		const doc = new PDFDocument({
			size: 'A4',
			margins: { top: 36, bottom: 36, left: MARGIN, right: MARGIN },
			info: {
				Title: `Plan — ${m.name}`,
				Author: 'DumpFire',
				Subject: `Delivery plan for ${m.name}`
			}
		});

		const chunks: Buffer[] = [];
		doc.on('data', (c: Buffer) => chunks.push(c));
		doc.on('end', () => resolve(Buffer.concat(chunks)));
		doc.on('error', reject);

		const pw = doc.page.width - MARGIN * 2;
		const mx = MARGIN;

		const byKey = new Map(summary.graph.nodes.map((n) => [`${n.kind}:${n.id}`, n]));
		const titleOf = (n: { kind: string; id: number }) =>
			stripTag(byKey.get(`${n.kind}:${n.id}`)?.title ?? '');

		// ─── Header ──────────────────────────────────────────────────────────
		doc.rect(0, 0, doc.page.width, 80).fill(C.headerBg);
		doc.font('Helvetica-Bold').fontSize(18).fillColor(C.headerText)
			.text('Delivery Plan', mx, 14, { width: pw });
		doc.font('Helvetica-Bold').fontSize(11).fillColor(C.accentLight)
			.text(stripTag(m.name), mx, 34, { width: pw, ellipsis: true });

		const scope =
			summary.progress.boards.length === 0
				? 'No work attached yet'
				: summary.progress.boards.map((b) => `${b.name} (${b.cardCount})`).join('  ·  ');
		doc.font('Helvetica').fontSize(8).fillColor(C.headerText)
			.text(scope, mx, 54, { width: pw, ellipsis: true });
		doc.font('Helvetica').fontSize(7.5).fillColor(C.textLight)
			.text(
				`Generated ${formatDate(new Date().toISOString())}` +
					(m.targetDate ? `   ·   Target ${formatDate(m.targetDate)}` : '   ·   No target date') +
					(m.status !== 'open' ? '   ·   CLOSED' : ''),
				mx, 66, { width: pw }
			);

		let y = 94;

		// ─── What this document is ───────────────────────────────────────────
		doc.roundedRect(mx, y, pw, 30, 4).fill(C.accentLight);
		doc.font('Helvetica').fontSize(7.5).fillColor(C.accent).text(
			'This plan is derived, not written by hand. Only two things are recorded: which piece of work blocks which, ' +
				'and which work belongs to this goal. The order below, what can start today and what is waiting are all ' +
				'computed from those two facts, so this document cannot drift from the board.',
			mx + 10, y + 6, { width: pw - 20 }
		);
		y += 40;

		// ─── Progress ────────────────────────────────────────────────────────
		const p = summary.progress;
		const metrics = [
			{ label: 'Items of work', value: p.total, bg: C.accentLight, fg: C.accent },
			{ label: 'Complete', value: p.done, bg: C.emeraldLight, fg: C.emerald },
			{ label: 'Complete %', value: `${p.percent}%`, bg: C.emeraldLight, fg: C.emerald },
			{ label: 'Can start now', value: summary.nextActionable.length, bg: C.blueLight, fg: C.blue },
			{ label: 'Waiting', value: summary.blocked.length, bg: C.amberLight, fg: C.amber },
			{ label: 'Open steps', value: p.openSubtasks, bg: C.blueLight, fg: C.blue }
		];
		const gap = 8;
		const cw = (pw - (metrics.length - 1) * gap) / metrics.length;
		for (let i = 0; i < metrics.length; i++) {
			const mt = metrics[i];
			const cx = mx + i * (cw + gap);
			doc.roundedRect(cx, y, cw, 44, 4).fill(mt.bg);
			doc.font('Helvetica-Bold').fontSize(17).fillColor(mt.fg)
				.text(String(mt.value), cx, y + 7, { width: cw, align: 'center' });
			doc.font('Helvetica').fontSize(5.6).fillColor(mt.fg)
				.text(mt.label.toUpperCase(), cx, y + 31, { width: cw, align: 'center' });
		}
		y += 50;

		doc.font('Helvetica').fontSize(6.5).fillColor(C.textLight).text(
			`Items of work = the ${p.total} cards in this goal. ` +
				`Can start now = nothing is blocking them. Waiting = something must finish first. ` +
				`Open steps = ${p.openSubtasks} unticked subtasks across those cards.`,
			mx, y, { width: pw }
		);
		y = (doc as any).y + 12;

		// ─── Critical path ───────────────────────────────────────────────────
		y = ensureSpace(doc, 80, y);
		y = drawSectionTitle(doc, 'The chain that cannot slip', mx, y);
		doc.font('Helvetica').fontSize(7.5).fillColor(C.textMuted).text(
			'The longest run of work that has to happen in order. Every item here delays the goal if it slips; ' +
				'everything else has somewhere to absorb a delay.',
			mx, y, { width: pw }
		);
		y = (doc as any).y + 8;

		if (summary.criticalPathNodes.length === 0) {
			doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(C.textMuted).text(
				'No chain yet — nothing in this goal has been recorded as waiting on anything else.',
				mx, y, { width: pw }
			);
			y = (doc as any).y + 14;
		} else {
			summary.criticalPathNodes.forEach((n, i) => {
				const title = stripTag(n.title);
				const h = Math.max(20, heightOf(doc, title, pw - 74, 8.5) + 10);
				y = ensureSpace(doc, h + 4, y);

				doc.roundedRect(mx, y, pw, h, 3).fill(i % 2 === 0 ? C.rowAlt : C.white);
				doc.circle(mx + 16, y + h / 2, 8).fill(C.redLight);
				doc.font('Helvetica-Bold').fontSize(8).fillColor(C.red)
					.text(String(i + 1), mx + 8, y + h / 2 - 4, { width: 16, align: 'center' });
				doc.font('Helvetica-Bold').fontSize(7).fillColor(C.textMuted)
					.text(label(n), mx + 30, y + 6, { width: 40 });
				doc.font('Helvetica').fontSize(8.5).fillColor(C.heading)
					.text(title, mx + 72, y + 5, { width: pw - 84 });
				y += h + 3;
			});
			y += 8;
		}

		// ─── Startable now ───────────────────────────────────────────────────
		y = ensureSpace(doc, 70, y);
		y = drawSectionTitle(doc, 'What can be picked up today', mx, y);
		doc.font('Helvetica').fontSize(7.5).fillColor(C.textMuted).text(
			'Nothing is blocking these. Ordered by how much each one frees up: finishing the top item unblocks the most work.',
			mx, y, { width: pw }
		);
		y = (doc as any).y + 8;
		y = drawWorkRows(doc, summary.nextActionable, mx, y, pw, true);

		// ─── Waiting ─────────────────────────────────────────────────────────
		y += 8;
		y = ensureSpace(doc, 70, y);
		y = drawSectionTitle(doc, 'What is waiting, and on what', mx, y);
		y += 2;

		if (summary.blocked.length === 0) {
			doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(C.textMuted)
				.text('Nothing is waiting.', mx, y, { width: pw });
			y = (doc as any).y + 12;
		} else {
			for (const b of summary.blocked) {
				const title = stripTag(b.card.title);
				const h = Math.max(18, heightOf(doc, title, pw - 60, 8.5) + 8);
				y = ensureSpace(doc, h + b.blockers.length * 13 + 8, y);

				doc.font('Helvetica-Bold').fontSize(7).fillColor(C.textMuted)
					.text(label(b.card), mx, y + 3, { width: 46 });
				doc.font('Helvetica').fontSize(8.5).fillColor(C.heading)
					.text(title, mx + 50, y + 2, { width: pw - 60 });
				y += h;

				for (const blocker of b.blockers) {
					doc.rect(mx + 54, y, 1.5, 11).fill(C.amber);
					doc.font('Helvetica').fontSize(7.5).fillColor(C.textMuted).text(
						`waiting on ${label(blocker)}  ${stripTag(blocker.title)}`,
						mx + 62, y + 1.5, { width: pw - 72, ellipsis: true }
					);
					y += 13;
				}
				y += 5;
			}
		}

		// ─── The dependency picture, when it fits ────────────────────────────
		y = drawGraphOrSayWhyNot(doc, summary, mx, y, pw);

		// ─── Everything in the goal ──────────────────────────────────────────
		y += 6;
		y = ensureSpace(doc, 70, y);
		y = drawSectionTitle(doc, 'Everything in this goal', mx, y);
		y += 2;
		drawFullTable(doc, summary, mx, y, pw);

		doc.end();
	});
}

/** A compact row list used for the startable section. */
function drawWorkRows(
	doc: PDFKit.PDFDocument,
	nodes: MilestoneNode[],
	mx: number,
	startY: number,
	pw: number,
	showUnblocks: boolean
): number {
	let y = startY;
	if (nodes.length === 0) {
		doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(C.textMuted)
			.text('Nothing can be started — every remaining item is waiting on something.', mx, y, { width: pw });
		return (doc as any).y + 12;
	}

	nodes.forEach((n, i) => {
		const title = stripTag(n.title);
		const titleW = pw - 60 - (showUnblocks ? 74 : 0);
		const h = Math.max(17, heightOf(doc, title, titleW, 8.5) + 7);
		y = ensureSpace(doc, h + 2, y);

		if (i % 2 === 0) doc.rect(mx, y, pw, h).fill(C.rowAlt);
		doc.font('Helvetica-Bold').fontSize(7).fillColor(C.textMuted)
			.text(label(n), mx + 6, y + 4, { width: 46 });
		doc.font('Helvetica').fontSize(8.5).fillColor(C.heading)
			.text(title, mx + 54, y + 3, { width: titleW });

		if (showUnblocks && n.downstreamCount > 0) {
			const bw = 70;
			doc.roundedRect(mx + pw - bw - 4, y + 3, bw, 11, 5.5).fill(C.emeraldLight);
			doc.font('Helvetica-Bold').fontSize(6.5).fillColor(C.emerald).text(
				`frees up ${n.downstreamCount}`,
				mx + pw - bw - 4, y + 5.5, { width: bw, align: 'center' }
			);
		}
		y += h + 1;
	});
	return y;
}

/**
 * Draw the dependency graph, or say plainly that it will not fit.
 *
 * A picture nobody can read is worse than a sentence admitting it does not fit,
 * so anything past a readable size gets the sentence.
 */
function drawGraphOrSayWhyNot(
	doc: PDFKit.PDFDocument,
	summary: MilestoneSummary,
	mx: number,
	startY: number,
	pw: number
): number {
	let y = startY + 8;
	const layers = summary.graph.layers;
	const nodeCount = summary.graph.nodes.length;
	if (nodeCount === 0) return y;

	y = ensureSpace(doc, 60, y);
	y = drawSectionTitle(doc, 'How the work connects', mx, y);

	const NW = 104;
	const NH = 26;
	const GX = 26;
	const GY = 7;
	const widest = Math.max(...layers.map((l) => l.length), 0);
	const neededW = layers.length * NW + Math.max(0, layers.length - 1) * GX;
	const neededH = widest * (NH + GY);

	// Fits only if it fits across the page AND on one page down it.
	if (neededW > pw || neededH > 560 || nodeCount > 40) {
		doc.font('Helvetica').fontSize(8).fillColor(C.textMuted).text(
			`This goal has ${nodeCount} connected items across ${layers.length} stages — too many to draw at a size ` +
				`anyone could read on this page. The order is listed above: the chain that cannot slip, then what can ` +
				`start today, then what is waiting and on what. The full picture is on the planning screen.`,
			mx, y, { width: pw }
		);
		return (doc as any).y + 10;
	}

	doc.font('Helvetica').fontSize(7.5).fillColor(C.textMuted)
		.text('Read left to right: work on the left has to finish before work to its right can start.', mx, y, { width: pw });
	y = (doc as any).y + 8;
	y = ensureSpace(doc, neededH + 20, y);

	const byKey = new Map(summary.graph.nodes.map((n) => [`${n.kind}:${n.id}`, n]));
	const pos = new Map<string, { x: number; y: number }>();
	layers.forEach((layer, li) => {
		layer.forEach((ref, ni) => {
			pos.set(`${ref.kind}:${ref.id}`, { x: mx + li * (NW + GX), y: y + ni * (NH + GY) });
		});
	});

	// Edges first so nodes sit on top of them.
	for (const e of summary.graph.edges) {
		const a = pos.get(`${e.from.kind}:${e.from.id}`);
		const b = pos.get(`${e.to.kind}:${e.to.id}`);
		if (!a || !b) continue;
		const x1 = a.x + NW;
		const y1 = a.y + NH / 2;
		const x2 = b.x;
		const y2 = b.y + NH / 2;
		const mid = x1 + (x2 - x1) / 2;
		const onPath =
			byKey.get(`${e.from.kind}:${e.from.id}`)?.onCriticalPath &&
			byKey.get(`${e.to.kind}:${e.to.id}`)?.onCriticalPath;
		doc.moveTo(x1, y1).bezierCurveTo(mid, y1, mid, y2, x2, y2)
			.lineWidth(onPath ? 1.4 : 0.6)
			.strokeColor(onPath ? C.red : C.border)
			.stroke();
	}

	for (const n of summary.graph.nodes) {
		const pt = pos.get(`${n.kind}:${n.id}`);
		if (!pt) continue;
		const state = stateOf(n);
		const fill = n.external ? C.white : state === 'Done' ? C.emeraldLight : state === 'Blocked' ? C.amberLight : C.blueLight;
		doc.roundedRect(pt.x, pt.y, NW, NH, 3).fill(fill);
		doc.roundedRect(pt.x, pt.y, NW, NH, 3)
			.lineWidth(n.onCriticalPath ? 1.3 : 0.5)
			.strokeColor(n.onCriticalPath ? C.red : C.border)
			.stroke();
		doc.font('Helvetica-Bold').fontSize(5.6).fillColor(C.textMuted)
			.text(n.external ? `${label(n)} · outside` : label(n), pt.x + 5, pt.y + 4, { width: NW - 10 });
		doc.font('Helvetica').fontSize(6.4).fillColor(C.heading)
			.text(stripTag(n.title), pt.x + 5, pt.y + 12, { width: NW - 10, height: 11, ellipsis: true });
	}

	y += neededH + 6;
	doc.font('Helvetica').fontSize(6.5).fillColor(C.textLight).text(
		'Red outline and red lines mark the chain that cannot slip. Amber is waiting, blue can start, green is done. ' +
			'A white box is work outside this goal that something here is waiting on.',
		mx, y, { width: pw }
	);
	return (doc as any).y + 8;
}

/** The full list, cards with their steps indented underneath. */
function drawFullTable(
	doc: PDFKit.PDFDocument,
	summary: MilestoneSummary,
	mx: number,
	startY: number,
	pw: number
): number {
	let y = startY;
	const colId = 44;
	const colState = 58;
	const colBoard = 96;
	const colTitle = pw - colId - colState - colBoard - 12;

	const header = () => {
		doc.rect(mx, y, pw, 15).fill(C.headerBg);
		doc.font('Helvetica-Bold').fontSize(6.5).fillColor(C.headerText);
		doc.text('REF', mx + 6, y + 5, { width: colId });
		doc.text('WORK', mx + colId + 6, y + 5, { width: colTitle });
		doc.text('WHERE', mx + colId + colTitle + 10, y + 5, { width: colBoard });
		doc.text('STATE', mx + colId + colTitle + colBoard + 12, y + 5, { width: colState });
		y += 15;
	};
	header();

	// Cards in id order, each followed by its own ordered steps.
	const cards = summary.graph.nodes
		.filter((n) => !n.external && n.kind === 'card')
		.sort((a, b) => a.id - b.id);
	const subsByCard = new Map<number, MilestoneNode[]>();
	for (const n of summary.graph.nodes) {
		if (n.kind !== 'subtask' || n.external || n.parentCardId === undefined) continue;
		if (!subsByCard.has(n.parentCardId)) subsByCard.set(n.parentCardId, []);
		subsByCard.get(n.parentCardId)!.push(n);
	}

	let row = 0;
	const draw = (n: MilestoneNode, indent: boolean) => {
		const title = stripTag(n.title);
		const tw = colTitle - (indent ? 12 : 0);
		const h = Math.max(15, heightOf(doc, title, tw, 7.5) + 7);

		if (y + h > doc.page.height - 46) {
			doc.addPage();
			y = 40;
			header();
		}
		if (row % 2 === 0) doc.rect(mx, y, pw, h).fill(C.rowAlt);

		const state = stateOf(n);
		doc.font('Helvetica-Bold').fontSize(6.8).fillColor(C.textMuted)
			.text(n.kind === 'subtask' ? 'step' : `#${n.id}`, mx + 6, y + 4, { width: colId });
		doc.font('Helvetica').fontSize(7.5).fillColor(C.heading)
			.text(title, mx + colId + 6 + (indent ? 12 : 0), y + 3.5, { width: tw });
		doc.font('Helvetica').fontSize(6.8).fillColor(C.textMuted)
			.text(n.kind === 'subtask' ? '' : `${n.boardName} · ${n.columnTitle}`,
				mx + colId + colTitle + 10, y + 4, { width: colBoard, ellipsis: true });
		doc.font('Helvetica-Bold').fontSize(6.5).fillColor(stateColour(state))
			.text(state, mx + colId + colTitle + colBoard + 12, y + 4, { width: colState });

		y += h;
		row++;
	};

	for (const c of cards) {
		draw(c, false);
		for (const st of (subsByCard.get(c.id) ?? []).sort((a, b) => a.id - b.id)) draw(st, true);
	}

	return y;
}

/** A filename that is still identifiable months later. */
export function milestonePdfFilename(name: string): string {
	const safe = stripTag(name)
		.replace(/[^a-z0-9]+/gi, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60) || 'milestone';
	return `plan-${safe}-${new Date().toISOString().slice(0, 10)}.pdf`;
}
