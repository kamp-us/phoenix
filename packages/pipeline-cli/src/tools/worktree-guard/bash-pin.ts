/**
 * `@kampus/worktree-guard` Bash cwd-pin core — pure decision for a worktree
 * subagent's `PreToolUse` Bash hook (issue #741; HEAD-move refusal #1571).
 *
 * Same hazard as path-resolve: a worktree subagent's Bash cwd resets to the MAIN
 * checkout between calls, so a command with no explicit `cd` runs against the
 * primary tree (and a `git switch`/`git checkout` mis-branches it). The fix pins
 * the command to `$WORKTREE_ROOT` by prepending `cd "$WORKTREE_ROOT" &&` when the
 * command does not already establish its own working directory.
 *
 * "Already establishes its own cwd" is read conservatively: a leading `cd ` (the
 * common explicit form) is honored as-is. We do NOT try to parse arbitrary
 * shell — over-pinning a command that already cd's elsewhere would be wrong, so a
 * leading `cd` is the one signal we trust, mirroring the worktree convention's own
 * `cd <worktree-root> && …` idiom.
 *
 * On top of the cd-pin, a **HEAD-moving git op** (`checkout`/`switch`/`reset`/
 * `rebase`) that is NOT already scoped to a worktree is **refused**, not pinned:
 * cd-pinning it would only relocate the HEAD move into the worktree, but the
 * #1103/#1494 detach class is a bare HEAD move escaping to the shared *primary*
 * `.git` (the orchestrator's ff-pull then stalls on a detached HEAD). The owner's
 * ruling on the arm-vs-refuse posture (issue #1571) is REFUSE, scoped to guarded
 * agents: the refusal fires only when `$WORKTREE_ROOT` names a managed worktree —
 * i.e. this hook is active for an `isolation:worktree` subagent. The orchestrator's
 * own shell runs no such hook and carries no `$WORKTREE_ROOT`, so its legitimate
 * `git checkout main` (the ff-pull/reattach flow) can never reach this refusal. See
 * `.patterns/worktree-agent-constraints.md` (the guard route, now enforced).
 */

export type BashDecision =
	| {readonly kind: "allow"}
	| {readonly kind: "rewrite"; readonly command: string; readonly reason: string}
	| {readonly kind: "refuse"; readonly reason: string};

const stripTrailingSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);

const WORKTREE_SEGMENT = "/.claude/worktrees/";

/** True when `$WORKTREE_ROOT` is a managed agent worktree (`<main>/.claude/worktrees/<id>`). */
const isManagedWorktree = (worktreeRoot: string): boolean =>
	worktreeRoot.replace(/\\/g, "/").indexOf(WORKTREE_SEGMENT) > 0;

/** True when the command's FIRST effective token is `cd` (it sets its own cwd). */
export const hasLeadingCd = (command: string): boolean => /^\s*cd(\s|$)/.test(command);

/** The git subcommands that move HEAD — a bare one against the shared primary is the #1103 detach. */
const HEAD_MOVING = new Set(["checkout", "switch", "reset", "rebase"]);

const dequote = (s: string): string => s.replace(/^["']/, "").replace(/["']$/, "");

/**
 * Inspect a command for a git invocation whose subcommand moves HEAD, and whether that
 * invocation is already **scoped to a worktree** — either via a `-C <path>` / `--git-dir`
 * / `--work-tree` global option pointing at `$WT`/`$WORKTREE_ROOT` (or a path under the
 * worktree root), which is the sanctioned safe form the refusal points agents to.
 *
 * The parse is intentionally shallow (whitespace tokens, first `git` token): guard commands
 * are simple invocations, and a shallow parse that errs toward *seeing* a HEAD-move is the
 * fail-closed direction (ambiguity → refuse, never silently allow a primary-HEAD mutation).
 */
export const inspectGitHeadMove = (
	command: string,
	worktreeRoot: string,
): {readonly isHeadMove: boolean; readonly worktreeScoped: boolean} => {
	const tokens = command.trim().split(/\s+/);
	const gi = tokens.indexOf("git");
	if (gi < 0) return {isHeadMove: false, worktreeScoped: false};

	const root = stripTrailingSlash(worktreeRoot.replace(/\\/g, "/"));
	const isWorktreePath = (raw: string): boolean => {
		// normalize a braced shell expansion (`${WT}`) to its bare form (`$WT`) before comparing
		const v = dequote(raw).replace(/^\$\{(\w+)\}$/, "$$$1");
		if (v === "$WT" || v === "$WORKTREE_ROOT") return true;
		const p = stripTrailingSlash(v.replace(/\\/g, "/"));
		return p === root || p.startsWith(`${root}/`);
	};

	let scoped = false;
	let i = gi + 1;
	// Walk the git global options preceding the subcommand. `-C`/`--git-dir`/`--work-tree`
	// take a path arg and, when it names the worktree, mark the op as worktree-scoped.
	while (i < tokens.length) {
		const t = tokens[i] ?? "";
		if (t === "-C" || t === "--git-dir" || t === "--work-tree") {
			const arg = tokens[i + 1] ?? "";
			if (isWorktreePath(arg)) scoped = true;
			i += 2;
			continue;
		}
		const eq = t.match(/^(--git-dir|--work-tree)=(.*)$/);
		if (eq) {
			if (isWorktreePath(eq[2] ?? "")) scoped = true;
			i += 1;
			continue;
		}
		if (t.startsWith("-C") && t.length > 2) {
			if (isWorktreePath(t.slice(2))) scoped = true;
			i += 1;
			continue;
		}
		if (t === "-c") {
			i += 2; // `-c key=value` takes an arg; irrelevant to scoping
			continue;
		}
		if (t.startsWith("-")) {
			i += 1;
			continue;
		}
		break;
	}
	const subcommand = i < tokens.length ? (tokens[i] ?? "") : "";
	return {isHeadMove: HEAD_MOVING.has(subcommand), worktreeScoped: scoped};
};

const REFUSE_REASON =
	"refused a bare HEAD-moving git op (checkout/switch/reset/rebase) in a guarded worktree — " +
	"unscoped, it would execute against the shared PRIMARY .git after the cwd reset and detach the " +
	"primary HEAD (the #1103/#1494 stall). Scope it to your worktree: " +
	'`git -C "$WT" <op> …`, or bring a PR head in by ref — ' +
	'`git -C "$WT" fetch origin pull/<N>/head && git -C "$WT" checkout FETCH_HEAD`.';

/**
 * Decide whether to pin/refuse a Bash command for a guarded worktree agent.
 *
 * - No `$WORKTREE_ROOT`, or a non-managed root → **allow** (not a guarded agent; this is
 *   also the orchestrator's own shell — its `git checkout main` is never reached here).
 * - An empty/whitespace-only command → **allow** (nothing to pin).
 * - A command with a leading `cd ` → **allow** (it sets its own cwd; don't fight it).
 * - A HEAD-moving git op NOT scoped to the worktree → **refuse** (issue #1571).
 * - A HEAD-moving git op already scoped to the worktree (`git -C "$WT" …`) → **allow**
 *   (the safe form; `-C` overrides cwd, so no cd-pin is needed).
 * - Otherwise → **rewrite** to `cd "<root>" && <command>` (the cwd-reset cd-pin).
 */
export const pinBash = (args: {
	readonly worktreeRoot: string;
	readonly command: string;
}): BashDecision => {
	const {worktreeRoot, command} = args;
	if (!worktreeRoot || !isManagedWorktree(worktreeRoot)) return {kind: "allow"};
	if (command.trim() === "") return {kind: "allow"};
	if (hasLeadingCd(command)) return {kind: "allow"};

	const gm = inspectGitHeadMove(command, worktreeRoot);
	if (gm.isHeadMove) {
		if (gm.worktreeScoped) return {kind: "allow"};
		return {kind: "refuse", reason: REFUSE_REASON};
	}

	const root = stripTrailingSlash(worktreeRoot.replace(/\\/g, "/"));
	return {
		kind: "rewrite",
		command: `cd "${root}" && ${command}`,
		reason:
			"pinned to $WORKTREE_ROOT (the worktree-agent cwd reset hazard, MEMORY: Worktree agent cwd reset)",
	};
};
