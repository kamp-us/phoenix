/**
 * `roadmap view` pure core — assemble ROADMAP.md's founder-voice `## Arcs`/`## Campaigns`
 * tables and the live GitHub projection (milestones + issues + open PRs) into a legible
 * top-down tree, and derive the stale-p1 drift set. IO-free and total: `buildView` is a
 * transform over the already-gathered rows/milestones/issues/pulls, `renderView` a transform
 * over that view model. The `ROADMAP.md` read + the `gh api` REST fetch live in
 * `view.ts`/`github.ts`; this module never touches disk or the network.
 *
 * This is the observability half of the steering seam (#2639 part 3): a render, not a guard.
 * `roadmap-guard` (#2632) owns the fail-closed ROADMAP.md ↔ milestone sync enforcement; this
 * view owns human-legible display and surfaces the one piece of drift a puller cares about —
 * stale p1s: open `p1` issues sitting OUTSIDE the active-arc milestone, the work a puller would
 * keep draining after an arc flip if the lever were decorative (#2639).
 *
 * ROADMAP.md is the SOLE parsed roadmap surface (#2630/#2632): the arc/campaign table parse is
 * reused from `roadmap-guard` so the view and the guard agree on the table grammar by
 * construction rather than re-deriving it here. Everything else is the live REST projection.
 */
import {parseRoadmap, type RoadmapRow} from "../roadmap-guard/roadmap-guard.ts";

export {parseRoadmap, type RoadmapRow};

/** The three intake priority buckets, highest-urgency first. */
export type Priority = "p0" | "p1" | "p2";

/** A GitHub milestone reduced to the projection facts the view renders. */
export interface Milestone {
	readonly number: number;
	readonly title: string;
	readonly state: "open" | "closed";
}

/**
 * A GitHub issue reduced to the facts the tree + stale-p1 derivation need. `milestone` is the
 * pinned milestone number, or `null` when unmilestoned. `parent` is the epic this issue is a
 * sub-issue of (`null` for a top-level issue), populated at the boundary from the sub-issues
 * endpoint. `isEpic`/`priority` are classified from `labels` by the pure helpers below.
 */
export interface Issue {
	readonly number: number;
	readonly title: string;
	readonly state: "open" | "closed";
	readonly labels: ReadonlyArray<string>;
	readonly milestone: number | null;
	readonly parent: number | null;
	readonly isEpic: boolean;
	readonly priority: Priority | null;
}

/** An open pull request reduced to number/title + the issues it declares it closes. */
export interface PullRequest {
	readonly number: number;
	readonly title: string;
	readonly branch: string;
	readonly linkedIssues: ReadonlyArray<number>;
}

/** The live GitHub projection the view renders ROADMAP.md against — all read-only, REST-sourced. */
export interface RoadmapFacts {
	readonly milestones: ReadonlyArray<Milestone>;
	readonly issues: ReadonlyArray<Issue>;
	readonly pulls: ReadonlyArray<PullRequest>;
}

const EPIC_LABEL = "type:epic";
const PRIORITY_LABELS: ReadonlyArray<Priority> = ["p0", "p1", "p2"];

/** True when the label set marks this issue as an epic (`type:epic`). */
export const isEpic = (labels: ReadonlyArray<string>): boolean => labels.includes(EPIC_LABEL);

/** The issue's priority bucket from its labels, or `null` if none of `p0`/`p1`/`p2` is present. */
export const priorityOf = (labels: ReadonlyArray<string>): Priority | null =>
	PRIORITY_LABELS.find((p) => labels.includes(p)) ?? null;

// Closing-keyword refs (`fixes/closes/resolves #N`, GitHub's own set) plus the branch-name
// number (`<prefix>/<N>-slug`, the pipeline's branch idiom) are the two signals that tie an
// open PR to the issue it builds — parsed here so the view can hang PRs under their epic tree.
const CLOSES_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
const BRANCH_NUM_RE = /^[^/]+\/(\d+)-/;

/** Resolve the issue numbers an open PR links, from its body's closing keywords + its branch name. */
export const parseLinkedIssues = (body: string, branch: string): ReadonlyArray<number> => {
	const nums = new Set<number>();
	for (const m of body.matchAll(CLOSES_RE)) {
		if (m[1] !== undefined) nums.add(Number(m[1]));
	}
	const b = branch.match(BRANCH_NUM_RE);
	if (b?.[1] !== undefined) nums.add(Number(b[1]));
	return [...nums];
};

// --- view model -------------------------------------------------------------------

/** One epic and its sub-issue children (both states shown; a puller wants the whole tree). */
export interface EpicNode {
	readonly epic: Issue;
	readonly children: ReadonlyArray<Issue>;
}

/** One rendered arc/campaign row: its resolved milestone + the epic trees, loose issues, and PRs under it. */
export interface RowNode {
	readonly kind: "arc" | "campaign";
	readonly name: string;
	readonly state: string;
	readonly isActiveArc: boolean;
	readonly milestoneNumber: number | null;
	readonly milestone: Milestone | null;
	readonly epics: ReadonlyArray<EpicNode>;
	/** Milestone issues that are neither an epic nor a child of one — top-level standalone work. */
	readonly looseIssues: ReadonlyArray<Issue>;
	readonly pulls: ReadonlyArray<PullRequest>;
}

/** The whole assembled view: the active-arc pointer, the arc/campaign rows, and the stale-p1 drift set. */
export interface RoadmapView {
	readonly activeArcName: string | null;
	readonly activeMilestone: number | null;
	readonly arcs: ReadonlyArray<RowNode>;
	readonly campaigns: ReadonlyArray<RowNode>;
	readonly staleP1s: ReadonlyArray<Issue>;
}

/** The single `active` arc row, or `null` when none/several are active (a guard-owned concern, #2632). */
export const activeArc = (arcs: ReadonlyArray<RoadmapRow>): RoadmapRow | null => {
	const active = arcs.filter((a) => a.state === "active");
	return active.length === 1 ? (active[0] ?? null) : null;
};

/**
 * Stale p1 drift: open `p1` issues sitting outside the active-arc milestone (#2639). With no
 * resolvable active milestone every open p1 is "outside" it, so all are flagged — the fail-loud
 * reading, since a decorative lever is exactly what this surfaces. An epic is included like any
 * other issue: a p1 epic parked off the active arc is itself drift.
 */
export const deriveStaleP1s = (
	issues: ReadonlyArray<Issue>,
	activeMilestone: number | null,
): ReadonlyArray<Issue> =>
	issues.filter(
		(i) =>
			i.state === "open" &&
			i.priority === "p1" &&
			// No active milestone ⇒ every open p1 is outside it (an unmilestoned p1 must NOT
			// slip through on `null === null`); otherwise stale iff pinned to a different milestone.
			(activeMilestone === null || i.milestone !== activeMilestone),
	);

/** Assemble the arc/campaign rows for a milestone: its epic trees, loose top-level issues, and linked PRs. */
const buildRows = (
	rows: ReadonlyArray<RoadmapRow>,
	kind: "arc" | "campaign",
	facts: RoadmapFacts,
	activeArcName: string | null,
): ReadonlyArray<RowNode> => {
	const msByNumber = new Map(facts.milestones.map((m) => [m.number, m]));
	return rows.map((row): RowNode => {
		const ms = row.milestone !== null ? (msByNumber.get(row.milestone) ?? null) : null;
		const inMilestone =
			row.milestone !== null ? facts.issues.filter((i) => i.milestone === row.milestone) : [];
		const epics = inMilestone
			.filter((i) => i.isEpic)
			.map(
				(epic): EpicNode => ({
					epic,
					children: facts.issues.filter((c) => c.parent === epic.number),
				}),
			);
		const epicNumbers = new Set(epics.map((e) => e.epic.number));
		const looseIssues = inMilestone.filter((i) => !i.isEpic && i.parent === null);
		// Children live under sub_issues and may not carry the milestone pin themselves — count
		// them in too so a PR closing a sub-issue still hangs under this row.
		const claimed = new Set(inMilestone.map((i) => i.number));
		for (const e of epics) for (const c of e.children) claimed.add(c.number);
		const pulls = facts.pulls.filter((p) =>
			p.linkedIssues.some((n) => claimed.has(n) || epicNumbers.has(n)),
		);
		return {
			kind,
			name: row.name,
			state: row.state,
			isActiveArc: kind === "arc" && row.name === activeArcName,
			milestoneNumber: row.milestone,
			milestone: ms,
			epics,
			looseIssues,
			pulls,
		};
	});
};

/**
 * Build the full view model from the parsed roadmap rows and the live projection. Pure and
 * total — every derivation (active arc, per-row trees, stale p1s) is a fold over the inputs.
 */
export const buildView = (
	arcs: ReadonlyArray<RoadmapRow>,
	campaigns: ReadonlyArray<RoadmapRow>,
	facts: RoadmapFacts,
): RoadmapView => {
	const active = activeArc(arcs);
	const activeArcName = active?.name ?? null;
	const activeMilestone = active?.milestone ?? null;
	return {
		activeArcName,
		activeMilestone,
		arcs: buildRows(arcs, "arc", facts, activeArcName),
		campaigns: buildRows(campaigns, "campaign", facts, activeArcName),
		staleP1s: deriveStaleP1s(facts.issues, activeMilestone),
	};
};

// --- rendering (pure over the view model) -----------------------------------------

const issueLine = (i: Issue): string => {
	const prio = i.priority ? ` ${i.priority}` : "";
	return `#${i.number} [${i.state}]${prio} ${i.title}`;
};

const milestoneLabel = (row: RowNode): string => {
	if (row.milestoneNumber === null) return "(no milestone pin)";
	const title = row.milestone ? ` "${row.milestone.title}"` : " (milestone not found)";
	const state = row.milestone ? ` [${row.milestone.state}]` : "";
	return `milestone #${row.milestoneNumber}${title}${state}`;
};

const renderRow = (row: RowNode): ReadonlyArray<string> => {
	const marker = row.isActiveArc ? "  ← ACTIVE ARC" : "";
	const out: Array<string> = [`▸ ${row.name} [${row.state}] → ${milestoneLabel(row)}${marker}`];
	for (const {epic, children} of row.epics) {
		out.push(`    ◆ epic ${issueLine(epic)}`);
		for (const c of children) out.push(`        · ${issueLine(c)}`);
	}
	for (const i of row.looseIssues) out.push(`    · ${issueLine(i)}`);
	if (row.pulls.length > 0) {
		out.push("    PRs:");
		for (const p of row.pulls) {
			const links =
				p.linkedIssues.length > 0 ? ` → ${p.linkedIssues.map((n) => `#${n}`).join(", ")}` : "";
			out.push(`        ⇢ PR #${p.number} ${p.title}${links}`);
		}
	}
	if (row.epics.length === 0 && row.looseIssues.length === 0 && row.pulls.length === 0) {
		out.push("    (no open work)");
	}
	return out;
};

/** Render the assembled view model as the legible top-down tree the command emits to stdout. */
export const renderView = (view: RoadmapView): string => {
	const lines: Array<string> = [];
	lines.push(
		view.activeArcName
			? `Roadmap — active arc: ${view.activeArcName} (milestone ${view.activeMilestone !== null ? `#${view.activeMilestone}` : "unpinned"})`
			: "Roadmap — no single active arc (see roadmap-guard, #2632)",
	);
	lines.push("");
	lines.push("Arcs:");
	for (const row of view.arcs) lines.push(...renderRow(row));
	if (view.campaigns.length > 0) {
		lines.push("");
		lines.push("Campaigns:");
		for (const row of view.campaigns) lines.push(...renderRow(row));
	}
	lines.push("");
	if (view.staleP1s.length === 0) {
		lines.push("Drift: no stale p1s — every open p1 sits inside the active-arc milestone.");
	} else {
		lines.push(
			`⚠ Drift: ${view.staleP1s.length} stale p1(s) — open p1 outside the active-arc milestone` +
				`${view.activeMilestone !== null ? ` #${view.activeMilestone}` : ""} (a puller would keep draining these; #2639):`,
		);
		for (const i of view.staleP1s) {
			const ms = i.milestone !== null ? `milestone #${i.milestone}` : "no milestone";
			lines.push(`    #${i.number} ${i.title} (${ms})`);
		}
	}
	return lines.join("\n");
};
