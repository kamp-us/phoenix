/**
 * What the virtualized list is a list *of*, and the pure joins that build it.
 *
 * The transcript a window shows is two things stitched together: the older pages this window walked
 * back through, and the live tail the session keeps in its own state (#7569). The stitch is pure and
 * lives here rather than in the component, because "one `page` request carries the oldest loaded id"
 * and "a page prepends without duplicating what the tail already holds" are decisions a test can
 * make without a DOM.
 *
 * That second decision joins on **id, and then on text for a turn the layer never echoed** (#7998).
 * Id alone cannot deliver it: the core records the operator's own turn at send time under a
 * synthetic `local:<key>` id (`ai-agent/core/fold.ts`, `promptItem`), and a layer that emits no
 * `user` item of its own never clears that marker — so the same turn comes back from the layer's
 * history store under the layer's id and matches nothing in the tail. `unheld` below is the fold's
 * `echoOf` join applied to the page/tail stitch, under the same two guards.
 *
 * The head row is one row, never two: the loading row *replaces* the omitted-count line while a page
 * is in flight, and both disappear at the beginning of history (founder ruling, 2026-09-02).
 */

import type {ItemId, SystemItem, TranscriptItem} from "../../ai-agent/ports/index.ts";

/**
 * What an `item` row may carry. A session notice is deliberately not one: every `SystemItem` lands
 * in a `session` run instead, so a row that renders one as ordinary prose does not typecheck.
 */
export type RowItem = Exclude<TranscriptItem, SystemItem>;

/** One run of consecutive session notices, oldest-first. Non-empty by construction. */
export type SessionRun = readonly [SystemItem, ...ReadonlyArray<SystemItem>];

export type ChatRow =
	/** There is more history behind this point; `items` is what the live-tail bound already dropped. */
	| {readonly kind: "older"; readonly items: number}
	/** A `page` request is out. */
	| {readonly kind: "loading"}
	| {readonly kind: "page-error"; readonly detail: string}
	/**
	 * A run of consecutive session notices as one row. A burst of hook frames landing mid-turn is a
	 * row that grows rather than N rows that push everything the reader was looking at down the page.
	 */
	| {readonly kind: "session"; readonly items: SessionRun}
	| {
			readonly kind: "item";
			readonly item: RowItem;
			/**
			 * The rows folded directly under this one, in list order. Empty for everything but a group
			 * head. The ids rather than a count, so "the head says 14" and "14 rows appear" cannot
			 * disagree, and so the head's disclosure can name the rows it controls (#8027).
			 */
			readonly nestedIds: ReadonlyArray<ItemId>;
			/** This row ran inside another tool call — a subagent's, not the agent's own. */
			readonly nested: boolean;
			/** How many folds deep this row sits. Zero for a row the agent itself opened. */
			readonly depth: number;
	  };

export interface ChatRowsInput {
	/** Pages this window has walked back through, oldest-first. */
	readonly older: ReadonlyArray<TranscriptItem>;
	/** The session's live tail, oldest-first. */
	readonly tail: ReadonlyArray<TranscriptItem>;
	/** How many items the live-tail bound dropped, off `transcript.omitted`. */
	readonly omitted: number;
	readonly loading: boolean;
	readonly pageError?: string | null;
	readonly atOldest: boolean;
	/** The ids of the group heads whose folded rows are showing, off this window's own view slot. */
	readonly unfolded?: ReadonlySet<string>;
}

/**
 * A stable key per row, so the virtualizer's measurement cache survives a prepend. Item rows key on
 * the item's own id — which is stable across an update, since a tool result re-sends the same id
 * with a new status (ruling 1, #7570) — and the head rows key on their kind, of which at most
 * one is ever present.
 */
export const rowKey = (row: ChatRow): string => {
	if (row.kind === "item") return `item:${row.item.id}`;
	// The run's first notice, so the key holds still as later notices join the run behind it.
	if (row.kind === "session") return `session:${row.items[0].id}`;
	return row.kind;
};

/**
 * How many still-unconfirmed turns `held` carries per text — the budget a page's own copies of
 * those turns may claim. A count rather than a flag, so a turn sent twice can only ever cancel two
 * page copies.
 */
const localTextBudget = (held: ReadonlyArray<TranscriptItem>): Map<string, number> => {
	const budget = new Map<string, number>();
	for (const item of held) {
		if (item.kind !== "user" || item.local !== true) continue;
		budget.set(item.text, (budget.get(item.text) ?? 0) + 1);
	}
	return budget;
};

/** Spend one unit of `budget` on `item`, or answer that it had none to spend. */
const claimsLocal = (item: TranscriptItem, budget: Map<string, number>): boolean => {
	if (item.kind !== "user" || item.local === true) return false;
	const left = budget.get(item.text) ?? 0;
	if (left === 0) return false;
	budget.set(item.text, left - 1);
	return true;
};

/**
 * The `page` items `held` does not already carry, in page order.
 *
 * Two joins, and the second is the fold's `echoOf` with both of its guards intact: only a *layer's*
 * item may claim a still-`local` held one, and a `local` item never claims another, so two
 * deliberate sends of the same text stay two turns. The budget is what makes the claim one-to-one —
 * one unconfirmed turn cancels one page copy, never every copy that shares its text.
 *
 * The walk is newest-first because the held `local` item is the operator's *most recent* send of
 * that text: when a page carries several copies, the newest of them is the one that turn's echo
 * would have been, and dropping an older copy instead would leave the same turn on screen twice.
 */
const unheld = (
	held: ReadonlyArray<TranscriptItem>,
	page: ReadonlyArray<TranscriptItem>,
): ReadonlyArray<TranscriptItem> => {
	const known = new Set<string>(held.map((item) => item.id));
	const budget = localTextBudget(held);
	const fresh: Array<TranscriptItem> = [];
	for (let index = page.length - 1; index >= 0; index -= 1) {
		const item = page[index];
		if (item === undefined) continue;
		if (known.has(item.id) || claimsLocal(item, budget)) continue;
		fresh.push(item);
	}
	return fresh.reverse();
};

/** Prepend a page, dropping anything the window already holds. Oldest-first, in and out. */
export const mergeOlder = (
	held: ReadonlyArray<TranscriptItem>,
	page: ReadonlyArray<TranscriptItem>,
): ReadonlyArray<TranscriptItem> => {
	const fresh = unheld(held, page);
	return fresh.length === 0 ? held : [...fresh, ...held];
};

/**
 * The ids a fold may hang under. A session notice is not one: it renders as part of a run, with no
 * disclosure and no depth of its own, so a row naming one as its parent is an orphan rather than a
 * row hidden behind a head that can never open.
 */
const foldHeads = (items: ReadonlyArray<TranscriptItem>): ReadonlySet<string> =>
	new Set(items.flatMap((item) => (item.kind === "system" ? [] : [item.id])));

/** The head this row hangs under: the call it ran inside, when that call is in this list too. */
const headOf = (item: TranscriptItem, heads: ReadonlySet<string>): ItemId | undefined =>
	item.parentId !== undefined && heads.has(item.parentId) ? item.parentId : undefined;

/**
 * Append a session notice, joining the run already at the end of the list when there is one.
 *
 * A notice heads no fold — `foldHeads` refuses it one — and its own depth is never drawn, which is
 * what makes a plain "is the last row a run" test the whole of adjacency, and what makes the
 * dropped `depth`/`nestedIds` fields nothing lost.
 */
const pushSession = (rows: Array<ChatRow>, item: SystemItem): void => {
	const last = rows[rows.length - 1];
	if (last?.kind !== "session") {
		rows.push({kind: "session", items: [item]});
		return;
	}
	// Spelled from the run's own head so the non-empty shape survives the append.
	rows[rows.length - 1] = {kind: "session", items: [last.items[0], ...last.items.slice(1), item]};
};

/**
 * The list the window renders. The tail wins on a collision: an item that reached the live stream is
 * the newer copy of itself, and a page that happens to overlap the tail must not double it. The
 * collision is `unheld`'s — id, then text against a turn the tail still holds as `local` — so the
 * surviving row keeps the `local:` id it has had since the send and its `rowKey` does not move.
 *
 * A row naming a parent that is also in this list is **folded under it** (founder ruling,
 * 2026-09-05): the group head carries the count and the folded rows appear only while it is
 * unfolded, which is what keeps a fifty-call subagent from flooding the window. A row whose parent
 * is not in the list — its group head is older than the pages walked back to — stays where it is,
 * marked nested, because dropping it would hide work that happened.
 *
 * The walk is depth-first, which is what makes that last sentence true of *every* shape the backend
 * can mark rather than only of a one-level fold: a subagent that spawns a subagent gives a folded
 * row children of its own, counted and rendered like any other head.
 *
 * `reachable` is walked separately from the render because the two ask different questions. A row
 * behind a folded head is hidden on purpose and must stay hidden; a row whose parent chain loops
 * back on itself belongs to no head at all and would otherwise vanish. Only the second is swept in
 * at the end, so no marked row is dropped and none is un-hidden.
 */
export const chatRows = (input: ChatRowsInput): ReadonlyArray<ChatRow> => {
	const items = [...unheld(input.tail, input.older), ...input.tail];
	const unfolded = input.unfolded ?? new Set<string>();
	const heads = foldHeads(items);
	const folded = new Map<string, Array<TranscriptItem>>();
	for (const item of items) {
		const parent = headOf(item, heads);
		if (parent === undefined) continue;
		const group = folded.get(parent);
		if (group === undefined) folded.set(parent, [item]);
		else group.push(item);
	}
	const rows: Array<ChatRow> = [];
	if (!input.atOldest && items.length > 0) {
		if (input.loading) rows.push({kind: "loading"});
		else if (input.pageError != null) rows.push({kind: "page-error", detail: input.pageError});
		else rows.push({kind: "older", items: input.omitted});
	}
	const roots = items.filter((item) => headOf(item, heads) === undefined);
	const reachable = new Set<string>();
	const mark = (item: TranscriptItem): void => {
		if (reachable.has(item.id)) return;
		reachable.add(item.id);
		for (const child of folded.get(item.id) ?? []) mark(child);
	};
	for (const item of roots) mark(item);
	const seen = new Set<string>();
	const emit = (item: TranscriptItem, depth: number): void => {
		if (seen.has(item.id)) return;
		seen.add(item.id);
		if (item.kind === "system") {
			pushSession(rows, item);
			return;
		}
		const group = folded.get(item.id) ?? [];
		rows.push({
			kind: "item",
			item,
			nestedIds: group.map((child) => child.id),
			nested: depth > 0,
			depth,
		});
		if (!unfolded.has(item.id)) return;
		for (const child of group) emit(child, depth + 1);
	};
	for (const item of roots) emit(item, item.parentId === undefined ? 0 : 1);
	for (const item of items) {
		if (!reachable.has(item.id)) emit(item, 1);
	}
	return rows;
};

/** The `before` cursor for the next page: the oldest item the window currently holds. */
export const oldestLoadedId = (rows: ReadonlyArray<ChatRow>): string | null => {
	for (const row of rows) {
		if (row.kind === "item") return row.item.id;
		if (row.kind === "session") return row.items[0].id;
	}
	return null;
};

/** Membership rather than the row's key: an anchor may name a notice buried mid-run. */
const holds = (row: ChatRow, id: string): boolean => {
	if (row.kind === "item") return row.item.id === id;
	if (row.kind === "session") return row.items.some((item) => item.id === id);
	return false;
};

/** Where the row carrying `id` sits, or `-1`. The anchor a prepend restores the viewport onto. */
export const rowIndexOfItem = (rows: ReadonlyArray<ChatRow>, id: string | null): number =>
	id === null ? -1 : rows.findIndex((row) => holds(row, id));
