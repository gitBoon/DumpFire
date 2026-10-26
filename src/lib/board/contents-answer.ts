/**
 * contents-answer.ts — what an answer to `GET /api/boards/[id]/contents`
 * decides (card 2280, slice B1 of card 2012's part B).
 *
 *   - **apply**: a success with the board's contents, which the board state
 *     takes in place of what it drew.
 *   - **refused**: 401, 403 or 404. The session has ended, the caller may no
 *     longer open the board, or it is gone. None is mended by reading again
 *     (as `$lib/live-stream.ts` decides for the stream): the page empties its
 *     state and shows its load's refusal page.
 *   - **keep**: anything else, or no answer at all, or a success that is not
 *     the contents (a proxy's page). A server that is restarting or a network
 *     that is down: the screen is kept as it is, and the next live event, the
 *     stream's reconnect or a return to the tab reads again.
 */
import type { Fetch } from '$lib/signed-out';
import type { BoardKind } from '$lib/column-role';
import type { CategoryType, ColumnType, LabelType, MilestoneType } from '$lib/types';

/** One board above this one, as the breadcrumbs show it. */
export type BreadcrumbType = { label: string; emoji: string; href: string | null; title?: string };

/** One open blocker of a card, as the board's "Blocked" chip shows it. */
export type BoardBlockerType = {
	id: number;
	title: string;
	columnTitle: string;
	boardName: string;
	boardId: number | null;
	withheld: boolean;
};

/**
 * What the board page draws: the board load's data and the contents route's
 * answer, which come from one server reader (`readBoardContents`). Named here
 * by what the page reads of it; the server's own type is not imported into
 * the page.
 */
export type BoardContentsData = {
	/** `kind`: a delivery board, or an ideas board whose every column is upstream (milestone 22). */
	board: { id: number; name: string; emoji: string | null; parentCardId: number | null; kind: BoardKind };
	breadcrumbs: BreadcrumbType[];
	columns: ColumnType[];
	categories: CategoryType[];
	labels: LabelType[];
	linkableBoards: { id: number; name: string; emoji: string | null }[];
	canEdit: boolean;
	canManage: boolean;
	userBoardRole: string;
	boardUsers: { id: number; username: string; emoji: string | null }[];
	blockedState: Record<number, BoardBlockerType[]>;
	cardTokens: Record<number, { tokens: number; costUsd: number | null }>;
	boardTokenSummary: { total: number; entries: number; costUsd: number | null; unpricedTokens: number } | null;
	milestones: MilestoneType[];
};

export type ContentsVerdict = 'apply' | 'refused' | 'keep';

export type ContentsAnswer =
	| { verdict: 'apply'; contents: BoardContentsData }
	| { verdict: 'refused'; status: number }
	| { verdict: 'keep' };

/** What an answer's status decides; `null` is no answer at all. */
export function contentsVerdict(status: number | null): ContentsVerdict {
	if (status === null) return 'keep';
	if (status >= 200 && status < 300) return 'apply';
	if (status === 401 || status === 403 || status === 404) return 'refused';
	return 'keep';
}

/** Read board `boardId`'s contents, and say what the answer decides. Never throws. */
export async function askForContents(boardId: number, fetch: Fetch): Promise<ContentsAnswer> {
	let res: Response;
	try {
		res = await fetch(`/api/boards/${boardId}/contents`, { cache: 'no-store', headers: { accept: 'application/json' } });
	} catch {
		return { verdict: 'keep' };
	}
	const verdict = contentsVerdict(res.status);
	if (verdict === 'refused') return { verdict, status: res.status };
	if (verdict === 'keep') return { verdict };
	try {
		const contents = await res.json();
		// The contents are an object with the board's columns; anything else is not DumpFire's answer.
		if (contents && typeof contents === 'object' && Array.isArray(contents.columns) && contents.board) {
			return { verdict: 'apply', contents: contents as BoardContentsData };
		}
	} catch {
		// Not JSON.
	}
	return { verdict: 'keep' };
}
