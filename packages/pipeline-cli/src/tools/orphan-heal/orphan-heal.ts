/**
 * `orphan-heal` core — the pure, IO-free decision that turns a snapshot of open PRs into a
 * plan of "heal red CI on PR #N" items to file (the #3532 boundary path, steps 1–2).
 *
 * Founder ruling on #3532: engines heal only lanes they OWN. An orphan red PR — open,
 * CI-red, in no engine lane (hand-/conversation-authored, e.g. an ADR/ROADMAP PR that
 * closes no triaged issue — #3501) — is never healed, because no engine adopts a PR with no
 * owned lane. The ruling is BOUNDARY, not free-scan-adopt: convert the orphan into pullable
 * board work first, and an engine adopts the resulting lane second. This core is that
 * boundary — it decides which PRs are orphans-needing-heal and what heal-item to file; it
 * never mutates a PR, and it never lets an engine free-scan.
 *
 * Default-deny toward NOT-orphan: a PR is flagged ONLY when every gate positively holds
 * (open + non-draft, CI-red, laneless, red past the grace window, no existing heal-item).
 * Any missing signal — an unknown CI conclusion, no red-since timestamp to measure grace
 * against — leaves the PR un-flagged, so a miss can only ever under-file (a human still sees
 * the red PR), never spuriously file a heal-item for a healthy or actively-worked lane.
 *
 * The IO lives in `github.ts` (the `gh api` REST shell that builds these snapshots and files
 * the emitted issues); `command.ts` is the thin bin. This file holds only the decision over
 * plain values and the heal-item string builders, so both are unit-tested without a network.
 */

/** The rolled-up head-CI conclusion. `unknown` is a real state (no checks reported) — default-deny treats it as not-red. */
export type CiConclusion = "red" | "green" | "pending" | "unknown";

/**
 * Whether a PR sits in an engine lane. `unknown` is a first-class outcome, not a shade of
 * `laneless`: it means the lane probe COULD NOT EXECUTE (a transient GitHub 5xx / transport
 * failure), which says nothing about lane state. Folding that into `laneless` would let a blip
 * read a healthy laned PR as an orphan and over-file against it (#3701).
 */
export type LaneState = "laned" | "laneless" | "unknown";

/** A snapshot of one open PR — the gate inputs the plan decides over, all read from existing state. */
export interface PrSnapshot {
	readonly number: number;
	readonly isDraft: boolean;
	readonly ci: CiConclusion;
	/** ISO-8601 timestamp the head CI first/last went red — the grace-window anchor. Absent ⇒ grace unmeasurable ⇒ not flagged. */
	readonly redSince?: string | undefined;
	/** Engine-lane membership, tri-state: only a confirmed `laneless` is flaggable (`unknown` defers). */
	readonly laneState: LaneState;
	/** A failing check name carried into the heal-item for the engine to start from (diagnostic only, never decisive). */
	readonly failingCheck?: string | undefined;
}

export interface HealPlanOptions {
	/** The grace window: a PR must be red at least this long before it is flagged. */
	readonly graceMs: number;
	/** "Now" as epoch ms — injected so the decision is a pure function of its inputs (testable). */
	readonly now: number;
	/** PR numbers that already have an open heal-item — the idempotency set; a member is skipped, never re-filed. */
	readonly existingHealTargets: ReadonlySet<number>;
}

/** Why a PR was passed over — each maps to exactly one failed gate, in evaluation order. */
export type SkipReason =
	| "draft"
	| "ci-not-red"
	| "in-engine-lane"
	| "lane-state-unknown"
	| "no-red-since"
	| "within-grace"
	| "heal-item-exists";

/** A PR the plan will file a heal-item for. */
export interface EmitItem {
	readonly number: number;
	readonly failingCheck?: string | undefined;
	readonly redForMs: number;
}

/** A PR the plan passed over, with the deciding gate and a human-readable detail. */
export interface SkipItem {
	readonly number: number;
	readonly reason: SkipReason;
	readonly detail: string;
}

export interface HealPlan {
	readonly emit: ReadonlyArray<EmitItem>;
	readonly skip: ReadonlyArray<SkipItem>;
}

/** Render a ms duration as a compact `Nh Mm` / `Mm` string for the skip/emit detail lines. */
export const formatDuration = (ms: number): string => {
	const totalMinutes = Math.max(0, Math.floor(ms / 60000));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours === 0) return `${minutes}m`;
	return `${hours}h ${minutes}m`;
};

/**
 * Decide, over a snapshot of open PRs, which to file a heal-item for and which to skip.
 *
 * The gates are evaluated in a fixed order so each skipped PR names the FIRST gate it failed
 * — draft → not-red → in-lane → no-red-since → within-grace → already-has-heal-item — and a
 * PR reaches `emit` only by clearing all of them. Idempotency is enforced here (the
 * `existingHealTargets` gate), so re-running the detector never files a second heal-item for
 * a PR that already has an open one (#3650 AC: idempotent emitter).
 */
export const planHealItems = (prs: ReadonlyArray<PrSnapshot>, opts: HealPlanOptions): HealPlan => {
	const emit: Array<EmitItem> = [];
	const skip: Array<SkipItem> = [];

	for (const pr of prs) {
		if (pr.isDraft) {
			skip.push({number: pr.number, reason: "draft", detail: "PR is a draft"});
			continue;
		}
		if (pr.ci !== "red") {
			skip.push({number: pr.number, reason: "ci-not-red", detail: `head CI is ${pr.ci}, not red`});
			continue;
		}
		if (pr.laneState === "laned") {
			skip.push({
				number: pr.number,
				reason: "in-engine-lane",
				detail:
					"PR is in an engine lane (closes a triaged issue / active claim) — the engine heals it",
			});
			continue;
		}
		// The lane probe could not execute (transient GitHub failure). Defer to the next cadence
		// pass rather than treat un-read as laneless and file against a possibly-healthy lane (#3701).
		if (pr.laneState === "unknown") {
			skip.push({
				number: pr.number,
				reason: "lane-state-unknown",
				detail: "lane state unreadable (transient GitHub failure) — deferring to the next pass",
			});
			continue;
		}
		// Red but with no measurable red-since anchor: cannot prove the grace window elapsed, so
		// default-deny to not-flagged rather than file on an unbounded/unknown red duration.
		const redAt = pr.redSince === undefined ? Number.NaN : Date.parse(pr.redSince);
		if (Number.isNaN(redAt)) {
			skip.push({
				number: pr.number,
				reason: "no-red-since",
				detail:
					"red, but no parseable red-since timestamp to measure the grace window (default-deny)",
			});
			continue;
		}
		const redForMs = opts.now - redAt;
		if (redForMs < opts.graceMs) {
			skip.push({
				number: pr.number,
				reason: "within-grace",
				detail: `red for ${formatDuration(redForMs)} < grace ${formatDuration(opts.graceMs)}`,
			});
			continue;
		}
		if (opts.existingHealTargets.has(pr.number)) {
			skip.push({
				number: pr.number,
				reason: "heal-item-exists",
				detail: "an open heal-item already targets this PR — idempotent skip",
			});
			continue;
		}
		emit.push({number: pr.number, failingCheck: pr.failingCheck, redForMs});
	}

	return {emit, skip};
};

/**
 * The heal-item idempotency marker. Each emitted issue carries one `orphan-heal-target: #<N>`
 * line in its body; the detector reads it back off open issues to build `existingHealTargets`,
 * so a re-run recognizes its own prior emission with no dedicated label or search-index round-trip.
 */
export const HEAL_TARGET_PREFIX = "orphan-heal-target:";

export const healTargetMarker = (prNumber: number): string => `${HEAL_TARGET_PREFIX} #${prNumber}`;

const HEAL_TARGET_RE = /orphan-heal-target:\s*#(\d+)/gi;

/** Extract every PR number a heal-item body targets (usually one) — the read half of the marker. */
export const extractHealTargets = (body: string): ReadonlyArray<number> => {
	const out: Array<number> = [];
	for (const m of body.matchAll(HEAL_TARGET_RE)) {
		const n = Number.parseInt(m[1] ?? "", 10);
		if (!Number.isNaN(n)) out.push(n);
	}
	return out;
};

const CLOSING_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+#(\d+)/gi;

/**
 * Parse the GitHub closing-keyword references (`Fixes #N`, `Closes #N`, `Resolves: #N`, …)
 * out of a PR body — the read the shell uses to find a PR's linked issues, from which
 * engine-lane membership is derived (a PR that closes a triaged issue is in an owned lane).
 */
export const parseClosingRefs = (body: string): ReadonlyArray<number> => {
	const out: Array<number> = [];
	for (const m of body.matchAll(CLOSING_RE)) {
		const n = Number.parseInt(m[1] ?? "", 10);
		if (!Number.isNaN(n)) out.push(n);
	}
	return out;
};

export const healItemTitle = (prNumber: number): string => `heal red CI on PR #${prNumber}`;

/**
 * Build the heal-item body: the machine marker, a pointer at the failing check, and the
 * boundary-ruling context an engine needs to adopt the lane (the #3532 boundary path).
 */
export const healItemBody = (
	item: EmitItem,
	ctx: {readonly repo: string; readonly sourceIssue: number},
): string => {
	const prUrl = `https://github.com/${ctx.repo}/pull/${item.number}`;
	const checkLine = item.failingCheck
		? `Failing check: \`${item.failingCheck}\`.`
		: "Failing check: (see the PR's checks tab).";
	return [
		healTargetMarker(item.number),
		"",
		`PR ${prUrl} (#${item.number}) is an **orphan red PR** — open, non-draft, CI-red for`,
		`${formatDuration(item.redForMs)}, and in no engine lane (it closes no triaged issue).`,
		"",
		checkLine,
		"",
		"## What to do",
		`Adopt PR #${item.number} into an owned lane and repair its red CI: diagnose the failing`,
		"check, push a fix on the PR's branch, and re-run until green.",
		"",
		"## Why this exists",
		`Per the #3532 boundary ruling, engines heal only lanes they own — an orphan red PR is`,
		"converted into this pullable heal-item first, then an engine adopts the lane. Engines do",
		"not free-scan and mutate arbitrary red PRs.",
		"",
		`Emitted by \`pipeline-cli orphan-heal\` (#${ctx.sourceIssue}). Refs #3532.`,
	].join("\n");
};
