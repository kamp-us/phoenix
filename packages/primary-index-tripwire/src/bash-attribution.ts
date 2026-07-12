/**
 * Run-time (pre-Bash) attribution for the #2778 corruption — the complement to the pre-commit
 * {@link import("./tripwire.ts").decideTripwire} core.
 *
 * The pre-commit tripwire sees only the POST-HOC index state (a mass of staged deletions), which
 * cannot say WHICH command produced it (staging leaves no reflog trace, #2778). This core runs at
 * the `PreToolUse` Bash boundary instead, where the offending staging COMMAND string + cwd + agent
 * are still in hand — so wiring it into the `worktree-guard pre-bash` hook captures the actor at
 * the moment a bulk-staging op is issued, closing the "which command staged it?" ambiguity for the
 * primary-operator surface the pre-commit leg is blind to.
 *
 * RECORD-ONLY, like the pre-commit tripwire: this decides only whether to WRITE an attribution
 * record; it never blocks a command (blocking is the §CP guard on the pre-commit/sync path). It is
 * scoped to the HIGH-SIGNAL bulk-staging shapes that stage deletions EN MASSE — a stage-everything
 * (`git add -A/--all/.`, `git commit -a`), or an index removal (`git rm --cached`, the literal
 * `git rm -r --cached`-class the #2778 signature names). A plain `git add <one-path>` of a
 * modification is deliberately NOT recorded — it is low-signal and would drown the log.
 */
import {CONTROL_PLANE_DELETION_PREFIXES, isControlPlaneDeletion} from "./tripwire.ts";

export {CONTROL_PLANE_DELETION_PREFIXES};

/** The git + environment facts the run-time attribution needs, gathered read-only at the hook boundary. */
export interface BashStagingInput {
	/** The raw Bash command the agent is about to run (the hook's `tool_input.command`). */
	readonly command: string;
	readonly cwd: string;
	/** The commit target is the PRIMARY checkout (`git-dir == git-common-dir`) — the severe surface. */
	readonly onPrimaryCheckout: boolean;
	readonly agentType: string;
	readonly sessionId: string;
	readonly worktreeRoot: string;
	readonly at: string;
}

/** Which bulk-staging shape was detected — the two the #2778 signature is produced by. */
export type BashStagingKind = "stage-all" | "rm-cached";

/** The run-time attribution record written when a bulk-staging command is seen at the Bash boundary. */
export interface BashStagingRecord {
	readonly at: string;
	readonly source: "pre-bash";
	readonly kind: BashStagingKind;
	readonly command: string;
	readonly cwd: string;
	readonly onPrimaryCheckout: boolean;
	readonly agentType: string;
	readonly sessionId: string;
	readonly worktreeRoot: string;
	/** Control-plane path args named explicitly in the command (empty for a bare stage-all). */
	readonly controlPlanePathArgs: readonly string[];
}

export type BashStagingDecision =
	| {readonly kind: "quiet"; readonly reason: string}
	| {readonly kind: "record"; readonly record: BashStagingRecord};

/** Split a command into its git-bearing segments across the common shell connectors (`&&`, `||`, `;`, `|`). */
const segmentsOf = (command: string): readonly string[] => command.split(/&&|\|\||[;|]/);

const tokensOf = (segment: string): readonly string[] =>
	segment
		.trim()
		.split(/\s+/)
		.filter((t) => t !== "");

// The flag predicates below split "is a single-dash letter cluster" (a linear `^-[letters]$`
// test) from "contains the staging letter" (`includes`), deliberately NOT the ambiguous
// `^-[A-Za-z]*A[A-Za-z]*$` bash-pin uses — that overlapping-quantifier form is polynomial
// backtracking on `-AAA…` (a CodeQL ReDoS finding), and the split form is equivalent and linear.

/** A `git add` pathspec that stages the whole tree rather than an explicit path. */
const isAddAllPathspec = (t: string): boolean =>
	t === "." ||
	t === "--all" ||
	t === "--no-ignore-removal" ||
	(/^-[A-Za-z]*$/.test(t) && t.includes("A")); // a short-flag cluster carrying `-A` (e.g. `-A`, `-Av`)

/** A `git commit` flag that auto-stages tracked changes (`-a` / `-am` / `--all`); NOT `--amend`. */
const isCommitAllFlag = (t: string): boolean =>
	t === "--all" || (/^-[a-z]*$/.test(t) && t.includes("a"));

/** Walk a segment's git global options to the subcommand index (skips `-C`/`-c`/`--git-dir`/`--work-tree` args). */
const subcommandStart = (tokens: readonly string[], gi: number): number => {
	let i = gi + 1;
	while (i < tokens.length) {
		const t = tokens[i] ?? "";
		if (t === "-C" || t === "--git-dir" || t === "--work-tree" || t === "-c") {
			i += 2;
			continue;
		}
		if (/^(--git-dir|--work-tree)=/.test(t)) {
			i += 1;
			continue;
		}
		if (t.startsWith("-")) {
			i += 1;
			continue;
		}
		break;
	}
	return i;
};

const dequote = (s: string): string => s.replace(/^["']/, "").replace(/["']$/, "");

/** Strip trailing slashes without a `\/+$` regex (that `+` is a CodeQL ReDoS finding on many-slash input). */
const stripTrailingSlashes = (s: string): string => {
	let end = s.length;
	while (end > 0 && s[end - 1] === "/") end--;
	return s.slice(0, end);
};

/** The control-plane path args named in the command's tail (positional, non-flag tokens under a trust prefix). */
const controlPlanePathArgs = (rest: readonly string[]): string[] =>
	rest
		.filter((t) => !t.startsWith("-"))
		.map(dequote)
		.filter(
			(t) => isControlPlaneDeletion(`${stripTrailingSlashes(t)}/`) || isControlPlaneDeletion(t),
		);

/**
 * Classify a single segment as a bulk-staging op, or `null`. Shallow, fail-toward-detection parse
 * (the same philosophy as bash-pin's `inspectGitStageAll`): a stage-everything (`git add` all /
 * `git commit -a`) or an index removal (`git rm --cached`).
 */
const classifySegment = (segment: string): {kind: BashStagingKind; paths: string[]} | null => {
	const tokens = tokensOf(segment);
	const gi = tokens.indexOf("git");
	if (gi < 0) return null;
	const i = subcommandStart(tokens, gi);
	const subcommand = tokens[i] ?? "";
	const rest = tokens.slice(i + 1);
	if (subcommand === "add" && rest.some(isAddAllPathspec)) return {kind: "stage-all", paths: []};
	if (subcommand === "commit" && rest.some(isCommitAllFlag)) return {kind: "stage-all", paths: []};
	if (subcommand === "rm" && rest.includes("--cached")) {
		return {kind: "rm-cached", paths: controlPlanePathArgs(rest)};
	}
	return null;
};

/**
 * Decide whether a Bash command warrants a run-time attribution record. Records the FIRST bulk-staging
 * segment found (stage-all or `rm --cached`); everything else is quiet. Total and IO-free — the caller
 * (`worktree-guard pre-bash`) does the read-only log append and never lets it perturb the pin decision.
 */
export const decideBashStagingAttribution = (input: BashStagingInput): BashStagingDecision => {
	for (const segment of segmentsOf(input.command)) {
		const hit = classifySegment(segment);
		if (hit === null) continue;
		return {
			kind: "record",
			record: {
				at: input.at,
				source: "pre-bash",
				kind: hit.kind,
				command: input.command,
				cwd: input.cwd,
				onPrimaryCheckout: input.onPrimaryCheckout,
				agentType: input.agentType,
				sessionId: input.sessionId,
				worktreeRoot: input.worktreeRoot,
				controlPlanePathArgs: hit.paths,
			},
		};
	}
	return {kind: "quiet", reason: "no bulk-staging op (stage-all / rm --cached) in the command"};
};

/** Render a run-time attribution record as a single-line stderr note (mirrors the pre-commit `renderWarning`). */
export const renderBashStagingNote = (r: BashStagingRecord): string =>
	`primary-index-tripwire pre-bash ATTRIBUTION (#2778): a ${r.kind} git op on ` +
	`${r.onPrimaryCheckout ? "the PRIMARY checkout" : "a linked worktree"} — ` +
	`agent=${r.agentType || "unset"} session=${r.sessionId || "unset"} cwd=${r.cwd} ` +
	`worktree-root=${r.worktreeRoot || "unset"}${r.controlPlanePathArgs.length > 0 ? ` · control-plane args: ${r.controlPlanePathArgs.join(", ")}` : ""} · command: ${r.command}`;
