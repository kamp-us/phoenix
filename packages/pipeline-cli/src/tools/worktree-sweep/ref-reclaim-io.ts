/**
 * Ref-reclaim git boundary + the shared phase both reclaimers run (issue #4190). The decision
 * itself is the pure core in `ref-reclaim.ts`; this module only gathers facts, prints the plan,
 * and performs the deletion. Shared by `worktree-sweep` (which reclaims the refs of the trees it
 * removed, and the whole accumulated namespace under `--reclaim-refs`) and `worktree-reap` (which
 * reclaims the ref of each tree it reaped), so the ongoing teardown and the retro cleanup can
 * never drift apart on what "safe to delete" means.
 *
 * Every probe here is written so that a failure reads as `"unknown"` (⇒ KEEP), never as a licence
 * to delete: an unresolvable `origin/main` disables containment for the whole run, a failed
 * enumeration aborts the phase entirely, and a ref beyond the probe budget stays unknown.
 */
import {execFileSync} from "node:child_process";
import {Console, Effect} from "effect";
import {
	computeRefReclaimPlan,
	isManagedWorktreeRef,
	parseRefList,
	type RefCandidate,
	type RefContainment,
} from "./ref-reclaim.ts";
import {parseWorktreeList} from "./worktree-sweep.ts";

interface GitResult {
	readonly ok: boolean;
	readonly stdout: string;
	readonly stderr: string;
}

const runGit = (args: ReadonlyArray<string>): GitResult => {
	// biome-ignore lint/plugin: best-effort git shell — a non-zero exit is fully absorbed into a {ok:false} GitResult the caller branches on, never the E channel; a total helper, not Effect-cosplay.
	try {
		const stdout = execFileSync("git", [...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return {ok: true, stdout, stderr: ""};
	} catch (cause) {
		const e = cause as {stdout?: Buffer | string; stderr?: Buffer | string};
		return {ok: false, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "")};
	}
};

/**
 * How many refs may pay the (4-git-call) squash-merge probe in one run. Ancestry is resolved for
 * the whole namespace in a single `--merged` enumeration, so only the refs that ancestry MISSED
 * reach this budget — on the measured host, 86 of 2056. The cap bounds a pathological namespace
 * to a predictable run cost; refs past it read `"unknown"` and are KEPT, so exhausting the budget
 * costs a later run, never a wrong deletion.
 */
const SQUASH_PROBE_BUDGET = 500;

/** How many per-ref lines to print before collapsing to a count — the tally carries the rest. */
const MAX_LISTED = 20;

/**
 * Short ref name → path of the registered worktree holding it. `null` when `git worktree list`
 * failed, which aborts the whole phase: without this map a checked-out ref is indistinguishable
 * from a free one, and that is precisely the distinction protecting a live lane.
 */
const checkedOutRefs = (): ReadonlyMap<string, string> | null => {
	const listed = runGit(["worktree", "list", "--porcelain"]);
	if (!listed.ok) return null;
	const map = new Map<string, string>();
	for (const wt of parseWorktreeList(listed.stdout)) {
		if (wt.branch !== null) map.set(wt.branch, wt.path);
	}
	return map;
};

/** Every `refs/heads/worktree-*` ref with its tip, or `null` when the enumeration failed. */
const managedRefs = (): ReadonlyArray<{name: string; tip: string | null}> | null => {
	const r = runGit([
		"for-each-ref",
		"--format=%(refname:short)%09%(objectname)",
		"refs/heads/worktree-*",
	]);
	if (!r.ok) return null;
	return parseRefList(r.stdout);
};

/** Tip of one ref, or `null` when it does not resolve (a deleted or malformed ref). */
const refTip = (name: string): string | null => {
	const r = runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
	const tip = r.stdout.trim();
	return r.ok && tip !== "" ? tip : null;
};

/**
 * The `worktree-*` refs whose tips are commit-ancestors of `origin/main`, resolved in ONE
 * enumeration rather than a probe per ref. `null` when the enumeration failed — typically an
 * unresolvable `origin/main`, which must disable containment for the entire run rather than
 * silently read as "nothing is merged" (that would be indistinguishable from a correct answer,
 * and here the two point at opposite actions).
 */
const ancestorMergedRefs = (): ReadonlySet<string> | null => {
	const r = runGit([
		"for-each-ref",
		"--merged",
		"origin/main",
		"--format=%(refname:short)",
		"refs/heads/worktree-*",
	]);
	if (!r.ok) return null;
	return new Set(parseRefList(r.stdout).map((e) => e.name));
};

/**
 * Has this tip's content already squash-merged into `origin/main`? Same patch-id technique the
 * tree sweep uses for a branch (#1328, ADR 0048): synthesize a dangling commit carrying the
 * cumulative diff against the merge-base, then ask `git cherry` whether that change already
 * exists upstream (`-` ⇒ equivalent). Every git failure collapses to `false`, which the caller
 * turns into `"absent"` only when ancestry ALSO ran — so a broken probe never invents containment.
 */
const squashMergedToOriginMain = (tip: string): boolean => {
	const base = runGit(["merge-base", "origin/main", tip]);
	if (!base.ok) return false;
	const tree = runGit(["rev-parse", `${tip}^{tree}`]);
	if (!tree.ok) return false;
	const dangling = runGit(["commit-tree", tree.stdout.trim(), "-p", base.stdout.trim(), "-m", "_"]);
	if (!dangling.ok) return false;
	const cherry = runGit(["cherry", "origin/main", dangling.stdout.trim()]);
	if (!cherry.ok) return false;
	return cherry.stdout.trimStart().startsWith("-");
};

/**
 * Delete one ref with `git update-ref -d <ref> <expected-tip>` — never `git branch -D`. Passing the
 * expected old value makes the delete a compare-and-swap: a ref that MOVED between the containment
 * probe and this call (an agent that committed onto it in the meantime) fails the update instead of
 * silently deleting the new commits, so the plan can never be stale in the destructive direction.
 */
const deleteRef = (name: string, expectedTip: string): GitResult =>
	runGit(["update-ref", "-d", `refs/heads/${name}`, expectedTip]);

/** Which refs a phase considers: the whole managed namespace, or just the named ones. */
export type RefReclaimScope =
	| {readonly kind: "namespace"}
	| {readonly kind: "named"; readonly names: ReadonlyArray<string>};

export interface RefReclaimSummary {
	readonly deleted: number;
	readonly kept: number;
	/** The phase could not run at all (an enumeration failed) — nothing was touched. */
	readonly aborted: boolean;
}

/**
 * Gather the facts for the scoped refs. Returns `null` when a mandatory enumeration failed, which
 * the caller reports and treats as "nothing reclaimed" — the fail-closed abort.
 */
const gatherCandidates = (scope: RefReclaimScope): ReadonlyArray<RefCandidate> | null => {
	const checkedOut = checkedOutRefs();
	if (checkedOut === null) return null;
	const listed =
		scope.kind === "namespace"
			? managedRefs()
			: scope.names.map((name) => ({name, tip: refTip(name)}));
	if (listed === null) return null;
	const ancestors = ancestorMergedRefs();
	let squashBudget = SQUASH_PROBE_BUDGET;
	return listed.map((entry) => {
		// Only a managed ref with a resolvable tip is probed for containment — the classifier
		// short-circuits on the other two facts first, so a foreign name never costs a git call.
		const tip = entry.tip;
		let containment: RefContainment = "unknown";
		if (tip !== null && isManagedWorktreeRef(entry.name) && ancestors !== null) {
			if (ancestors.has(entry.name)) {
				containment = "reachable";
			} else if (squashBudget > 0) {
				squashBudget -= 1;
				containment = squashMergedToOriginMain(tip) ? "squash-merged" : "absent";
			}
		}
		return {
			name: entry.name,
			tip: entry.tip,
			checkedOutAt: checkedOut.get(entry.name) ?? null,
			containment,
		};
	});
};

/**
 * The shared ref-reclaim phase: gather → classify → print the plan → delete (only when
 * `execute`). Dry-run prints exactly what it would do and touches nothing, so the retro cleanup
 * is always inspectable before it is performed.
 */
export const runRefReclaim = (options: {
	readonly label: string;
	readonly scope: RefReclaimScope;
	readonly execute: boolean;
}): Effect.Effect<RefReclaimSummary> =>
	Effect.gen(function* () {
		const {label, scope, execute} = options;
		if (scope.kind === "named" && scope.names.length === 0) {
			return {deleted: 0, kept: 0, aborted: false};
		}
		const candidates = gatherCandidates(scope);
		if (candidates === null) {
			yield* Console.error(
				`${label}: ref reclaim ABORTED — could not enumerate worktrees/refs; no ref was touched (fail-closed)`,
			);
			return {deleted: 0, kept: 0, aborted: true};
		}
		const plan = computeRefReclaimPlan(candidates);

		// ADR 0092 "emit what you scanned": the per-reason tally is what makes an all-keep run
		// diagnosable — a wall of `containment-unknown` (a broken probe) reads differently from a
		// wall of `unmerged` (real work), and the bare count collapses both into a silent no-op.
		yield* Console.log(
			`${label}: ${candidates.length} ref(s) scanned — ${plan.toDelete.length} deletable, ${plan.kept.length} kept${execute ? " (EXECUTE)" : " (dry-run)"}`,
		);
		if (plan.kept.length > 0) {
			const tally = new Map<string, number>();
			for (const k of plan.kept) tally.set(k.reason, (tally.get(k.reason) ?? 0) + 1);
			yield* Console.log(
				`  kept by reason: ${[...tally].map(([reason, n]) => `${reason}=${n}`).join(" ")}`,
			);
		}
		for (const d of plan.toDelete.slice(0, MAX_LISTED)) {
			yield* Console.log(`  deletable ${d.reason.padEnd(14)} ${d.ref.name}`);
		}
		if (plan.toDelete.length > MAX_LISTED) {
			yield* Console.log(`  … and ${plan.toDelete.length - MAX_LISTED} more deletable ref(s)`);
		}

		if (!execute) {
			if (plan.toDelete.length > 0) {
				yield* Console.log("  (dry-run — nothing deleted)");
			}
			return {deleted: 0, kept: plan.kept.length, aborted: false};
		}

		let deleted = 0;
		let refused = 0;
		for (const d of plan.toDelete) {
			const res = deleteRef(d.ref.name, d.ref.tip);
			if (res.ok) {
				deleted += 1;
			} else {
				refused += 1;
				yield* Console.error(
					`  KEPT (ref moved or delete refused) ${d.ref.name} — ${res.stderr.trim()}`,
				);
			}
		}
		yield* Console.log(
			`${label}: deleted ${deleted} ref(s), kept ${plan.kept.length + refused}${refused > 0 ? ` (${refused} deletable but refused → kept)` : ""}`,
		);
		return {deleted, kept: plan.kept.length + refused, aborted: false};
	});
