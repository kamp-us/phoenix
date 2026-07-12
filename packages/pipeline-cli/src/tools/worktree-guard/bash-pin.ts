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
 * On top of the cd-pin, a **working-state-mutating git op**
 * (`checkout`/`switch`/`reset`/`rebase`/`stash`/`merge`) that is NOT already scoped
 * to a worktree is **refused**, not pinned: cd-pinning it would only relocate the
 * mutation into the worktree, but the #1103/#1494 detach class is a bare op escaping
 * to the shared *primary* `.git` — `checkout`/`switch`/`reset`/`rebase` move the
 * primary HEAD (the orchestrator's ff-pull then stalls on a detached HEAD), and
 * `stash`/`merge` mutate the primary working tree (#2030: a review-doc agent ran
 * `git stash pop` + `reset --hard` on the owner's checkout, silently discarding its
 * uncommitted state — same shared-checkout hazard, same fail-closed refusal). The owner's
 * ruling on the arm-vs-refuse posture (issue #1571) is REFUSE, scoped to guarded
 * agents: the refusal fires when `$WORKTREE_ROOT` names a managed worktree —
 * i.e. this hook is active for an `isolation:worktree` subagent — OR, per ADR 0172, when
 * isolation was EXPECTED (a direct isolation-asserting agent-type, OR a nested crew spawn whose
 * inherited agent-type masks that — detected via `git-dir == git-common-dir`; #2462) yet
 * `$WORKTREE_ROOT` is unset (the #2440 harness no-op that disarms the root-keyed branch and leaves
 * this the sole layer).
 * The orchestrator's own shell runs no such hook, carries no `$WORKTREE_ROOT`, and asserts no
 * isolation, so its legitimate `git checkout main` (the ff-pull/reattach flow) can never reach
 * either refusal. See `.patterns/worktree-agent-constraints.md` (the guard route, now enforced).
 *
 * A second, distinct refusal is the **auto-stage-all containment** (#2666): `git add -A/--all/.`
 * and `git commit -a` are refused in a guarded worktree because a fresh worktree can come up dirty
 * (an unauthored hunk present at spawn), so staging the whole tree captures that bleed into the
 * commit. Unlike the HEAD-move class this fires regardless of `-C "$WT"` scoping — the hazard is
 * unauthored-hunk capture, not a primary-tree escape — so commits must stage by explicit path only.
 */

export type BashDecision =
	| {readonly kind: "allow"}
	| {readonly kind: "rewrite"; readonly command: string; readonly reason: string}
	| {readonly kind: "refuse"; readonly reason: string};

// Strip trailing slashes without a `\/+$` regex (that `+` is a CodeQL ReDoS finding on
// many-slash input; mirrors `bash-attribution.ts`'s `stripTrailingSlashes`, #2792/#2789). The
// `length > 1` guard is preserved: a bare `/` (or shorter) is returned untouched.
const stripTrailingSlash = (p: string): string => {
	if (p.length <= 1) return p;
	let end = p.length;
	while (end > 0 && p[end - 1] === "/") end--;
	return p.slice(0, end);
};

const WORKTREE_SEGMENT = "/.claude/worktrees/";

/** True when `$WORKTREE_ROOT` is a managed agent worktree (`<main>/.claude/worktrees/<id>`). */
const isManagedWorktree = (worktreeRoot: string): boolean =>
	worktreeRoot.replace(/\\/g, "/").indexOf(WORKTREE_SEGMENT) > 0;

/** True when the command's FIRST effective token is `cd` (it sets its own cwd). */
export const hasLeadingCd = (command: string): boolean => /^\s*cd(\s|$)/.test(command);

/**
 * The git subcommands that mutate the shared primary's git working state — a bare one against the
 * shared primary is the #1103 detach (`checkout`/`switch`/`reset`/`rebase` move HEAD) or the #2030
 * working-tree corruption (`stash`/`merge` mutate the tree, e.g. the review-doc `git stash pop`).
 */
const HEAD_MOVING = new Set(["checkout", "switch", "reset", "rebase", "stash", "merge"]);

const dequote = (s: string): string => s.replace(/^["']/, "").replace(/["']$/, "");

/**
 * Inspect a command for a git invocation whose subcommand mutates the primary's working state
 * (moves HEAD, or mutates the working tree via `stash`/`merge`), and whether that invocation is
 * already **scoped to a worktree** — either via a `-C <path>` / `--git-dir` / `--work-tree` global
 * option pointing at `$WT`/`$WORKTREE_ROOT` (or a path under the worktree root), which is the
 * sanctioned safe form the refusal points agents to.
 *
 * The parse is intentionally shallow (whitespace tokens, first `git` token): guard commands
 * are simple invocations, and a shallow parse that errs toward *seeing* a mutating op is the
 * fail-closed direction (ambiguity → refuse, never silently allow a primary-tree mutation).
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

/**
 * Detect a `git` invocation that AUTO-STAGES THE WHOLE TREE rather than explicit paths — `git add`
 * with an all-staging pathspec (`-A` / `--all` / `.` / `--no-ignore-removal`), or `git commit -a`
 * (the `-am` bundle included). Containment for #2666: a fresh worktree can come up dirty (an
 * unauthored uncommitted hunk present at spawn), so a stage-everything op captures that bleed into
 * the commit silently — the fix is to stage by explicit path only.
 *
 * The parse mirrors {@link inspectGitHeadMove}'s shallow, fail-closed philosophy but scans EVERY
 * git segment (split on shell connectors), so a chained `git status && git add -A` is caught — and
 * errs toward *seeing* a stage-all (ambiguity → refuse). Unlike a HEAD-move, `-C "$WT"` scoping
 * does NOT make this safe: the hazard is unauthored-hunk capture, not a primary-tree escape, so the
 * caller refuses it regardless of worktree-scope or a leading `cd`.
 */
export const inspectGitStageAll = (command: string): boolean => {
	for (const segment of command.split(/&&|\|\||[;|]/)) {
		if (segmentStagesAll(segment)) return true;
	}
	return false;
};

// The short-flag-cluster predicates split "is a single-dash letter cluster" (a linear
// `^-[letters]$` test) from "carries the staging letter" (`includes`), deliberately NOT the
// ambiguous `^-[A-Za-z]*A[A-Za-z]*$` overlapping-quantifier form — that is polynomial
// backtracking on `-AAA…` (a CodeQL ReDoS finding); the split form is equivalent and linear
// (#2792, mirroring the rewrite `bash-attribution.ts` already carries from #2789).

/** A `git add` pathspec that stages the whole tree (not an explicit path). */
const isAddAllPathspec = (t: string): boolean =>
	t === "." ||
	t === "--all" ||
	t === "--no-ignore-removal" ||
	(/^-[A-Za-z]*$/.test(t) && t.includes("A")); // a short-flag cluster carrying `-A` (e.g. `-A`, `-Av`); NOT `--all`

/** A `git commit` flag that auto-stages tracked changes (`-a` / `-am` / `--all`); NOT `--amend`. */
const isCommitAllFlag = (t: string): boolean =>
	t === "--all" || (/^-[a-z]*$/.test(t) && t.includes("a"));

/** Walk a segment's git global options to the subcommand token index (skips `-C`/`-c`/`--git-dir`/`--work-tree` args). */
const gitSubcommandStart = (tokens: string[], gi: number): number => {
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

const segmentStagesAll = (segment: string): boolean => {
	const tokens = segment
		.trim()
		.split(/\s+/)
		.filter((t) => t !== "");
	const gi = tokens.indexOf("git");
	if (gi < 0) return false;
	const i = gitSubcommandStart(tokens, gi);
	const subcommand = tokens[i] ?? "";
	const rest = tokens.slice(i + 1);
	if (subcommand === "add") return rest.some(isAddAllPathspec);
	if (subcommand === "commit") return rest.some(isCommitAllFlag);
	return false;
};

const REFUSE_REASON_STAGE_ALL =
	"refused an auto-stage-all git op (git add -A/--all/., or git commit -a) in a guarded worktree — " +
	"a fresh worktree can come up dirty (an unauthored hunk present at spawn, #2666), so staging the " +
	"whole tree captures that bleed into the commit silently. Stage by EXPLICIT path only: " +
	'`git -C "$WT" add <path> …` then a plain `git -C "$WT" commit` (never `-a`).';

const REFUSE_REASON =
	"refused a bare working-state-mutating git op (checkout/switch/reset/rebase/stash/merge) in a " +
	"guarded worktree — unscoped, it would execute against the shared PRIMARY .git after the cwd " +
	"reset and detach the primary HEAD (the #1103/#1494 stall) or corrupt its working tree (#2030). " +
	"Scope it to your worktree: " +
	'`git -C "$WT" <op> …`, or bring a PR head in by ref — ' +
	'`git -C "$WT" fetch origin pull/<N>/head && git -C "$WT" checkout FETCH_HEAD`.';

// The #2452/#2453 detach: an isolation-expecting agent (coder/reviewer/shipper) whose harness
// no-op'd worktree provisioning (#2440) has NO worktree, so `$WORKTREE_ROOT` is unset — which ALSO
// disarms the whole $WORKTREE_ROOT-keyed refusal below, allowing everything. With no worktree, even
// the `-C "$WT"` "safe" form the REFUSE_REASON above points agents to resolves `$WT`
// (`git rev-parse --show-toplevel`) to the shared PRIMARY checkout and detaches its HEAD. So when
// isolation was expected but no managed worktree exists, a head-moving git op is REFUSED regardless
// of `-C` scoping — this preflight is then the surviving layer (ADR 0172).
const REFUSE_REASON_ISOLATION_NO_ROOT =
	"refused a working-state-mutating git op (checkout/switch/reset/rebase/stash/merge) for an " +
	"isolation-expecting agent (coder/reviewer/shipper) with NO provisioned worktree ($WORKTREE_ROOT " +
	'unset/non-managed — the #2440 harness no-op). With no worktree the `-C "$WT"` form resolves to ' +
	"the shared PRIMARY checkout and would detach its HEAD (#2452/#2453). This is a harness " +
	"provisioning failure: STOP and surface it up (do NOT retry the spawn), and do NOT self-provision " +
	"to route around it — that hides the failure and collapses the primary-corruption defense (ADR 0172, #2270).";

/**
 * Was worktree isolation EXPECTED for this run — the gate that arms the {@link pinBash}
 * no-worktree refusal (ADR 0172)?
 *
 * A **direct** guarded spawn names itself: `$CLAUDE_CODE_AGENT` is coder/reviewer/shipper. But a
 * **nested crew spawn** inherits the *parent's* agent-type (a coder spawned under the crew reads
 * `engineering-manager`), so the agent-type regex alone goes inert for it and ADR 0172's loud-fail
 * never arms (#2462). So we corroborate with an **env-independent** signal — `onPrimaryCheckout`
 * (`git-dir == git-common-dir`, the same primary-checkout signal write-code Step-4 uses): an
 * agent-context run (`$CLAUDE_CODE_AGENT` set) sitting on the primary checkout is a broken/absent
 * worktree, whatever its inherited agent-type. A genuine standalone (`$CLAUDE_CODE_AGENT` unset — a
 * human `/write-code`) matches neither clause, so it never over-refuses (ADR 0172's standalone path).
 */
export const isIsolationExpected = (args: {
	readonly agentType: string;
	readonly onPrimaryCheckout: boolean;
}): boolean =>
	/coder|reviewer|shipper/.test(args.agentType) ||
	(args.agentType.trim() !== "" && args.onPrimaryCheckout);

/**
 * Decide whether to pin/refuse a Bash command for a guarded worktree agent.
 *
 * - No managed `$WORKTREE_ROOT` **and isolation NOT expected** → **allow** (the orchestrator's own
 *   shell / a standalone run — its `git checkout main` is never reached here).
 * - No managed `$WORKTREE_ROOT` **but isolation WAS expected** (`isolationExpected`, from an
 *   isolation-asserting `$CLAUDE_CODE_AGENT`) → a head-moving git op is **refused** even in its
 *   `-C "$WT"` form: with no worktree provisioned `$WT` can only be the shared PRIMARY checkout (the
 *   #2440 no-op / #2452 detach), and the $WORKTREE_ROOT-keyed branch below is disarmed, so this is
 *   the surviving refusal (ADR 0172). A non-head-move command still allows (no over-refusal).
 * - An empty/whitespace-only command → **allow** (nothing to pin).
 * - An auto-stage-all git op (`git add -A/--all/.`, or `git commit -a`) → **refuse** even in its
 *   `cd "$WT" &&` / `-C "$WT"` scoped form: a fresh worktree can be dirty at spawn, so staging the
 *   whole tree captures unauthored bleed into the commit — stage by explicit path only (#2666).
 * - A command with a leading `cd ` → **allow** (it sets its own cwd; don't fight it).
 * - A working-state-mutating git op (`checkout`/`switch`/`reset`/`rebase`/`stash`/`merge`) NOT
 *   scoped to the worktree → **refuse** (issue #1571; `stash`/`merge` added #2030).
 * - Such an op already scoped to the worktree (`git -C "$WT" …`) → **allow**
 *   (the safe form; `-C` overrides cwd, so no cd-pin is needed).
 * - Otherwise → **rewrite** to `cd "<root>" && <command>` (the cwd-reset cd-pin).
 */
export const pinBash = (args: {
	readonly worktreeRoot: string;
	readonly command: string;
	readonly isolationExpected?: boolean;
}): BashDecision => {
	const {worktreeRoot, command, isolationExpected = false} = args;
	if (!worktreeRoot || !isManagedWorktree(worktreeRoot)) {
		// No managed worktree. Normally a clean allow — but if isolation was expected, the harness
		// no-op'd provisioning (#2440) and a mutating git op here hits the PRIMARY checkout: a
		// head-move detaches it (#2453), and a stage-all captures the owner's tree state (#2666).
		if (isolationExpected && command.trim() !== "" && inspectGitStageAll(command)) {
			return {kind: "refuse", reason: REFUSE_REASON_STAGE_ALL};
		}
		if (
			isolationExpected &&
			command.trim() !== "" &&
			!hasLeadingCd(command) &&
			inspectGitHeadMove(command, worktreeRoot).isHeadMove
		) {
			return {kind: "refuse", reason: REFUSE_REASON_ISOLATION_NO_ROOT};
		}
		return {kind: "allow"};
	}
	if (command.trim() === "") return {kind: "allow"};
	// A stage-all is refused BEFORE the leading-cd allow: `cd "$WT" && git add -A` still captures
	// unauthored bleed, and `-C "$WT"` scoping doesn't make it safe (#2666) — so it fires regardless.
	if (inspectGitStageAll(command)) return {kind: "refuse", reason: REFUSE_REASON_STAGE_ALL};
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
