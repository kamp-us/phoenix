/**
 * `@kampus/primary-index-tripwire` pure core — decide whether a to-be-committed staged fileset
 * carries the #2778 corruption signature (a mass staged-deletion of the instruction-trust set) and
 * build an attribution record naming WHO/WHERE is about to commit it.
 *
 * DETECTION + ATTRIBUTION ONLY, IO-free and total: this core never blocks a commit and never mutates
 * git — it emits a record so the *next* occurrence is attributable. Staging leaves no reflog trace, so
 * the index state alone cannot name the actor; the record captures the identity/cwd context at the
 * caller-agnostic choke point git itself fires (`pre-commit`). Prevention/blocking is the §CP
 * hardening fix, tracked separately — see `ops/incidents/2778-primary-index-mass-staged-deletion.md`.
 */

/** One `git diff --cached --name-status` row: the status letter plus the path. */
export interface StagedEntry {
	/** The name-status letter — `D` for a staged deletion (the signal), `M`/`A`/`R…` otherwise. */
	readonly status: string;
	readonly path: string;
}

/**
 * The instruction-trust / control-plane path prefixes whose EN-MASSE staged deletion is the #2778
 * signature. A normal feature commit never deletes these wholesale; a mass deletion of them is the
 * loaded-gun state (a commit + push would land it on `origin/main`). This is a DETECTION heuristic
 * for attribution, deliberately distinct from `ship-it`'s merge-blocking `CONTROL_PLANE_RE` — it
 * classifies *deleted paths* to raise an attribution flag, not to gate a merge, so it carries no
 * dependency on that contract and never needs to move in lockstep with it.
 */
export const CONTROL_PLANE_DELETION_PREFIXES: readonly string[] = [
	".claude/",
	".decisions/",
	".github/",
	".glossary/",
	".patterns/",
	"claude-plugins/",
];

export const isControlPlaneDeletion = (path: string): boolean =>
	CONTROL_PLANE_DELETION_PREFIXES.some((p) => path.startsWith(p));

/**
 * The count of control-plane staged deletions at which the #2778 signature is treated as a
 * MASS deletion that a downstream guard REFUSES (not merely records). Single-sourced here so the
 * two §CP block sites — `pipeline-cli primary-index-guard` (the pre-commit block) and `main-sync`
 * (the sync-path refusal) — agree on what "mass" means. Deliberately HIGHER than the record-only
 * noise floor (`bin.ts`'s `--threshold` default of 10): recording trips early for observability,
 * but blocking is consequential, so it needs a stronger signal to never false-refuse a legitimate
 * multi-file control-plane refactor — and it only ever fires on the PRIMARY checkout, where a
 * direct commit is already off the sanctioned worktree+PR path (a mass deletion committed there is
 * the corruption, not routine work). The 248-deletion incident sits far above it.
 */
export const MASS_DELETION_BLOCK_THRESHOLD = 25;

/** The git + environment facts the decision needs, gathered read-only at the caller's IO boundary. */
export interface TripwireInput {
	/**
	 * The commit is against the PRIMARY checkout (`git-dir == git-common-dir`) — the SEVERE surface
	 * (a push here lands on `origin/main`). A linked worktree's index is contained to its own branch;
	 * the record still fires (a worktree that reached this state is the #2666 bleed class) but the
	 * `onPrimaryCheckout` flag records the severity.
	 */
	readonly onPrimaryCheckout: boolean;
	readonly staged: readonly StagedEntry[];
	readonly cwd: string;
	/** `$CLAUDE_CODE_AGENT` — the agent-type context (`coder`/`reviewer`/`engineering-manager`/…), or "". */
	readonly agentType: string;
	/** `$CLAUDE_CODE_SESSION_ID` — the per-agent UUID that survives the shared `usirin` git login, or "". */
	readonly sessionId: string;
	/** `$WORKTREE_ROOT` — set for a provisioned isolation worktree; "" for the primary/operator session. */
	readonly worktreeRoot: string;
	/** Minimum control-plane staged deletions to trip. Below it, the record stays quiet (noise floor). */
	readonly threshold: number;
	/** ISO-8601-UTC stamp for the record (injected so the core stays total/deterministic). */
	readonly at: string;
}

/** The attribution record written on a trip — everything needed to name the next occurrence's actor. */
export interface AttributionRecord {
	readonly at: string;
	readonly onPrimaryCheckout: boolean;
	readonly cwd: string;
	readonly agentType: string;
	readonly sessionId: string;
	readonly worktreeRoot: string;
	readonly stagedDeletionCount: number;
	readonly controlPlaneDeletionCount: number;
	/** A bounded sample of the offending paths (first few) so the log line stays readable. */
	readonly sampleControlPlaneDeletions: readonly string[];
}

export type TripwireDecision =
	| {readonly kind: "quiet"; readonly reason: string}
	| {readonly kind: "trip"; readonly record: AttributionRecord};

/** How many offending paths to sample into the record — enough to recognize the set, not the whole 248. */
const SAMPLE_SIZE = 8;

/**
 * Decide whether the staged fileset is the #2778 mass-staged-deletion signature.
 *
 * Trips when the count of staged deletions under the instruction-trust prefixes meets `threshold`,
 * regardless of checkout (the checkout is recorded as severity, not used to suppress). Everything
 * else is quiet with a reason. Total and IO-free — the same input always yields the same decision.
 */
export const decideTripwire = (input: TripwireInput): TripwireDecision => {
	const deletions = input.staged.filter((e) => e.status.startsWith("D"));
	const controlPlane = deletions.filter((e) => isControlPlaneDeletion(e.path));
	if (controlPlane.length < input.threshold) {
		return {
			kind: "quiet",
			reason: `${controlPlane.length} control-plane staged deletion(s) < threshold ${input.threshold}`,
		};
	}
	return {
		kind: "trip",
		record: {
			at: input.at,
			onPrimaryCheckout: input.onPrimaryCheckout,
			cwd: input.cwd,
			agentType: input.agentType,
			sessionId: input.sessionId,
			worktreeRoot: input.worktreeRoot,
			stagedDeletionCount: deletions.length,
			controlPlaneDeletionCount: controlPlane.length,
			sampleControlPlaneDeletions: controlPlane.slice(0, SAMPLE_SIZE).map((e) => e.path),
		},
	};
};

/** Parse `git diff --cached --name-status --diff-filter=D` output into staged entries (tab-separated). */
export const parseNameStatus = (raw: string): readonly StagedEntry[] =>
	raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.map((line) => {
			const tab = line.indexOf("\t");
			if (tab < 0) return {status: line, path: ""};
			return {status: line.slice(0, tab), path: line.slice(tab + 1)};
		})
		.filter((e) => e.path !== "");

/** Render a trip record as a single-line LOUD attribution warning for stderr. */
export const renderWarning = (r: AttributionRecord): string =>
	`primary-index-tripwire TRIP (#2778): ${r.controlPlaneDeletionCount} control-plane staged deletion(s) ` +
	`(${r.stagedDeletionCount} total) about to be committed on ` +
	`${r.onPrimaryCheckout ? "the PRIMARY checkout" : "a linked worktree"} — ` +
	`agent=${r.agentType || "unset"} session=${r.sessionId || "unset"} cwd=${r.cwd} ` +
	`worktree-root=${r.worktreeRoot || "unset"} · sample: ${r.sampleControlPlaneDeletions.join(", ")}`;
