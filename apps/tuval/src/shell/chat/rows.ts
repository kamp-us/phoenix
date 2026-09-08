/**
 * What the virtualized list is a list *of*, and the pure joins that build it.
 *
 * The transcript a window shows is two things stitched together: the older pages this window walked
 * back through, and the live tail the session keeps in its own state (#7569). The stitch is pure and
 * lives here rather than in the component, because "one `page` request carries the oldest loaded id"
 * and "a page prepends without duplicating what the tail already holds" are decisions a test can
 * make without a DOM.
 *
 * That second decision joins on **either of a row's two ids, and then on text for a turn the layer
 * never echoed**. Id alone cannot deliver either half.
 *
 * The `alias` half is #8032: a backend may key its live tail and its history reads in two id spaces
 * — Pi keys the tail positionally and the page by the stored session entry — so one turn arrives
 * under two strings and a single-id join renders it twice. The backend that holds both spaces says
 * so on the row (`ports/transcript-item.ts`, `alias`), and matching a page row's `alias` against
 * what the tail holds is the whole of the join; nothing here learns which backend has two spaces.
 *
 * The text half is #7998: the core records the operator's own turn at send time under a synthetic
 * `local:<key>` id (`ai-agent/core/fold.ts`, `promptItem`), and a layer that emits no `user` item
 * of its own never clears that marker — so the same turn comes back from the layer's history store
 * under the layer's id and matches nothing in the tail. `unheld` below is the fold's `echoOf` join
 * applied to the page/tail stitch, under the same two guards. It cannot cover the `alias` half:
 * Pi does echo, and the echo clears `local` before the operator can page at all.
 *
 * The head row is one row, never two: the loading row *replaces* the omitted-count line while a page
 * is in flight, and both disappear at the beginning of history (founder ruling, 2026-09-02).
 */

import {pageCursor} from "../../ai-agent/history/cursor.ts";
import type {ItemId, SubagentSlot, SystemItem, TranscriptItem} from "../../ai-agent/ports/index.ts";

/**
 * What an `item` row may carry. A session notice is deliberately not one: every `SystemItem` lands
 * in a `session` run instead, so a row that renders one as ordinary prose does not typecheck.
 */
export type RowItem = Exclude<TranscriptItem, SystemItem>;

/** A tool call, off the union rather than off a second import: the one above is at its width bound,
 * and `boundary.unit.test.ts` reads import lines one at a time, so a wrapped one reads as untyped. */
export type ToolCall = Extract<RowItem, {readonly kind: "tool"}>;

/** One run of consecutive session notices, oldest-first. Non-empty by construction. */
export type SessionRun = readonly [SystemItem, ...ReadonlyArray<SystemItem>];

/**
 * One run of consecutive tool calls, oldest-first. **Two or more** by construction: a lone call is
 * already one row, and collapsing it into a sentence would spend its name and its disclosure to
 * say "Read 1 file". So the type is what says a run of one is not a run.
 */
export type ToolRun = readonly [ToolCall, ToolCall, ...ReadonlyArray<ToolCall>];

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
	/**
	 * A run of consecutive tool calls as one sentence-shaped row (#8612). Six reads are one line
	 * saying "Read 6 files" instead of six labelled blocks saying nothing about what was read.
	 */
	| {
			readonly kind: "tools";
			readonly calls: ToolRun;
			/** This run ran inside another tool call — a subagent's, not the agent's own. */
			readonly nested: boolean;
			/** How many folds deep the run sits. Every call in it sits at this one depth. */
			readonly depth: number;
	  }
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
	/**
	 * The spawning calls the session holds a subagent slot for. Every row whose parent chain reaches
	 * one leaves the agent window entirely (#8405, founder ruling Q5) — its work is read in the
	 * running list and in the view Q7 switches to.
	 *
	 * Empty is today's window: the fold of #8027 is untouched, which is what lets the flag gating
	 * this be one boolean and no second code path.
	 */
	readonly subagents?: ReadonlySet<string>;
	/**
	 * The call this whole list ran inside, set only when the list is one subagent's own transcript
	 * (#8406). Its children are this list's top level, so they read at depth zero instead of as rows
	 * nested under a head the list does not contain.
	 */
	readonly head?: string;
}

/**
 * What the window hands `chatRows` with the flag off: one frozen empty set, for the life of the
 * module. A fresh `new Set()` per worker frame would be a new memo value on a path that is meant to
 * be a literal no-op, so the window's `subagents` memo would produce a changed dependency for a
 * transcript nothing about the flag touches.
 */
export const NO_SUBAGENTS: ReadonlySet<string> = Object.freeze(new Set<string>());

/**
 * The spawning calls whose rows leave the window: the slots the session holds, or nothing at all
 * when the flag is off. The identity is the point — off, this answers the same set every time, so
 * the memo reading it never sees a change.
 */
export const subagentHeads = (
	slots: Readonly<Record<string, SubagentSlot>> | null | undefined,
	enabled: boolean,
): ReadonlySet<string> =>
	enabled && slots !== null && slots !== undefined ? new Set(Object.keys(slots)) : NO_SUBAGENTS;

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
	// Its own prefix rather than the first call's `item:` key: the two would otherwise be one string
	// in the window's shared `expanded` set, and a run could not be opened without opening that call.
	if (row.kind === "tools") return `tools:${row.calls[0].id}`;
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
 * Two joins. The first is identity, and it reads both of a row's ids — its own and the `alias` its
 * backend gave it for the other id space — so a page copy keyed differently from the tail row for
 * one turn is still one turn. The second is the fold's `echoOf` with both of its guards intact: only a *layer's*
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
	const known = new Set<string>();
	for (const item of held) {
		known.add(item.id);
		if (item.alias !== undefined) known.add(item.alias);
	}
	const budget = localTextBudget(held);
	const fresh: Array<TranscriptItem> = [];
	for (let index = page.length - 1; index >= 0; index -= 1) {
		const item = page[index];
		if (item === undefined) continue;
		const carried = known.has(item.id) || (item.alias !== undefined && known.has(item.alias));
		if (carried || claimsLocal(item, budget)) continue;
		fresh.push(item);
	}
	return fresh.reverse();
};

/**
 * Prepend a page, dropping anything the window already holds. Oldest-first, in and out. Through the
 * same `unheld` `chatRows` uses, so a second page cannot re-introduce a copy the first reconciled.
 */
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
 * The rows that belong to a subagent rather than to the agent: every item whose parent chain
 * reaches a call in `subagents`. The spawning call itself is not one of them — it is the agent's
 * own row, and it stays as the plain tool row it was before it grew a fold (#8405).
 *
 * The walk climbs `parentId` over *every* loaded item and not over the rows that survived, because
 * a worker that spawns a worker puts a dropped call between a leaf and the slot it belongs to. A
 * chain that reaches no slot and no loaded parent simply ends; `seen` is what stops one that loops
 * back on itself, the same cycle `chatRows` already tolerates.
 */
const insideSubagent = (
	items: ReadonlyArray<TranscriptItem>,
	subagents: ReadonlySet<string>,
): ReadonlySet<string> => {
	const byId = new Map(items.map((item) => [String(item.id), item]));
	const hidden = new Set<string>();
	for (const item of items) {
		const seen = new Set<string>([String(item.id)]);
		let parent = item.parentId;
		while (parent !== undefined && !seen.has(parent)) {
			if (subagents.has(parent)) {
				hidden.add(String(item.id));
				break;
			}
			seen.add(parent);
			parent = byId.get(parent)?.parentId;
		}
	}
	return hidden;
};

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
 * The call this row is, when it is one a run may absorb.
 *
 * A **spawning** call is not one, and that is the whole of the exclusion: it carries a fold of its
 * own — a second disclosure, its `aria-expanded`, and the nested rows it reveals (#8027/#8057) —
 * which a sentence has no room for, so it stays the tool row it was and breaks the run around it.
 * T3 excludes its `agentSpawn` entries the same way. A call whose worker rows are in this list says
 * so in `nestedIds`; one whose rows left the window entirely says so by holding a subagent slot,
 * and neither reading covers the other.
 *
 * Every other row kind answers `null`, which is what makes a compaction boundary, a session notice,
 * a reply, a thought and the operator's own turn each break a run just by sitting between two calls.
 */
const runCall = (row: ChatRow, subagents: ReadonlySet<string>): ToolCall | null => {
	if (row.kind !== "item" || row.item.kind !== "tool") return null;
	if (row.nestedIds.length > 0 || subagents.has(row.item.id)) return null;
	return row.item;
};

/**
 * Collapse each maximal span of consecutive absorbable tool calls **at one depth** into a single
 * row (#8612). A depth change ends a span, so an open fold never reads as one sentence spanning the
 * agent's calls and its worker's.
 *
 * A span of one is left exactly as it was — see `ToolRun`.
 */
const collapseToolRuns = (
	rows: ReadonlyArray<ChatRow>,
	subagents: ReadonlySet<string>,
): ReadonlyArray<ChatRow> => {
	const out: Array<ChatRow> = [];
	let run: Array<{readonly row: ChatRow; readonly call: ToolCall; readonly depth: number}> = [];
	const flush = (): void => {
		const [first, second, ...rest] = run;
		run = [];
		if (first === undefined) return;
		if (second === undefined) {
			out.push(first.row);
			return;
		}
		out.push({
			kind: "tools",
			calls: [first.call, second.call, ...rest.map((entry) => entry.call)],
			nested: first.depth > 0,
			depth: first.depth,
		});
	};
	for (const row of rows) {
		const call = runCall(row, subagents);
		if (call === null || row.kind !== "item") {
			flush();
			out.push(row);
			continue;
		}
		if (run[0] !== undefined && run[0].depth !== row.depth) flush();
		run.push({row, call, depth: row.depth});
	}
	flush();
	return out;
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
 * A row belonging to a **subagent** is not folded but dropped, and `subagents` is the whole of what
 * says which (#8405): the fold above is what an ordinary tool call's nested rows still get.
 *
 * `reachable` is walked separately from the render because the two ask different questions. A row
 * behind a folded head is hidden on purpose and must stay hidden; a row whose parent chain loops
 * back on itself belongs to no head at all and would otherwise vanish. Only the second is swept in
 * at the end, so no marked row is dropped and none is un-hidden.
 */
export const chatRows = (input: ChatRowsInput): ReadonlyArray<ChatRow> => {
	const loaded = [...unheld(input.tail, input.older), ...input.tail];
	const subagents = input.subagents ?? NO_SUBAGENTS;
	const hidden = subagents.size === 0 ? null : insideSubagent(loaded, subagents);
	const items = hidden === null ? loaded : loaded.filter((item) => !hidden.has(String(item.id)));
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
	for (const item of roots) {
		emit(item, item.parentId === undefined || item.parentId === input.head ? 0 : 1);
	}
	for (const item of items) {
		if (!reachable.has(item.id)) emit(item, 1);
	}
	return collapseToolRuns(rows, subagents);
};

/**
 * One subagent's own transcript, as the swapped-in view renders it (#8406, founder ruling Q7).
 *
 * The slot carries every item the worker produced, so this needs no page walk and no live tail, and
 * `atOldest` is true: a subagent's rows arrive with its slot or not at all, and there is nothing
 * older to ask the backend for.
 */
export const subagentRows = (
	slot: SubagentSlot,
	unfolded?: ReadonlySet<string>,
): ReadonlyArray<ChatRow> =>
	chatRows({
		older: [],
		tail: slot.items,
		omitted: 0,
		loading: false,
		atOldest: true,
		head: slot.id,
		...(unfolded === undefined ? {} : {unfolded}),
	});

/** The prepend anchor: the visually oldest item, including a local echo. */
export const oldestLoadedId = (rows: ReadonlyArray<ChatRow>): string | null => {
	for (const row of rows) {
		if (row.kind === "item") return row.item.id;
		if (row.kind === "session") return row.items[0].id;
		if (row.kind === "tools") return row.calls[0].id;
	}
	return null;
};

/** The stored cursor and visual anchor are different id spaces when the oldest row is local. */
export const olderPageRequest = (
	rows: ReadonlyArray<ChatRow>,
): {readonly before: string; readonly anchor: string} | null => {
	const anchor = oldestLoadedId(rows);
	if (anchor === null) return null;
	const items = rows.flatMap((row): ReadonlyArray<TranscriptItem> => {
		if (row.kind === "item") return [row.item];
		if (row.kind === "session") return row.items;
		if (row.kind === "tools") return row.calls;
		return [];
	});
	const cursor = pageCursor(items, anchor);
	return cursor.kind === "page" && cursor.before !== null ? {before: cursor.before, anchor} : null;
};

/** Membership rather than the row's key: an anchor may name a notice or a call buried mid-run. */
const holds = (row: ChatRow, id: string): boolean => {
	if (row.kind === "item") return row.item.id === id;
	if (row.kind === "session") return row.items.some((item) => item.id === id);
	if (row.kind === "tools") return row.calls.some((call) => call.id === id);
	return false;
};

/** Where the row carrying `id` sits, or `-1`. The anchor a prepend restores the viewport onto. */
export const rowIndexOfItem = (rows: ReadonlyArray<ChatRow>, id: string | null): number =>
	id === null ? -1 : rows.findIndex((row) => holds(row, id));
