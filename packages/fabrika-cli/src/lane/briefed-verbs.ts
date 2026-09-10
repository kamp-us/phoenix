/**
 * Whether the tree a brief's `fabrika:` entrypoint will resolve in actually carries the lane verbs
 * the brief instructs the shell to run.
 *
 * The entrypoint is repo-relative in a checkout, so it resolves inside the *shell's* worktree, not
 * the driver's. An epic run cuts its assembly branch once and every child's worktree comes off that
 * branch, so a lane verb that landed on the trunk after the cut is simply absent from the copy of
 * this CLI the child will run — and the shell then does real work, produces a real verdict, and
 * cannot record it. Reading the branch's own tree before the brief is emitted is what turns that
 * quiet loss into a refusal the driver can act on (`lane refresh`).
 *
 * Only a brief whose ground names an assembly branch is judged, and only in a checkout: an absolute
 * entrypoint is an installed copy the branch does not carry at all, so the branch's tree says
 * nothing about it, and every other brief's shell stands in a worktree cut from the driver's own
 * head — the tree this very process is running out of.
 */
import {Effect, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {execCapture} from "../io/exec.ts";
import type {FabrikaEntry, GitRef} from "../wire/lane-brief.ts";

/**
 * The lane verbs a brief instructs its shell to run.
 *
 * `report` is the whole set today: every stage skill ends on
 * `node <fabrika> lane report <lane> …`, and it is the one verb whose absence loses a verdict the
 * shell already produced. Nothing else in the rules reaches the `lane` group.
 */
export const BRIEFED_LANE_VERBS = ["report"] as const;

export type BriefedLaneVerb = (typeof BRIEFED_LANE_VERBS)[number];

/**
 * The module each briefed verb lives in, relative to the entrypoint's own directory and without an
 * extension — the entrypoint's is reused, so a source checkout reads `.ts` and a built one `.js`.
 *
 * Declared rather than derived from the verb name: a naming convention that silently stops holding
 * would make every tree read as carrying every verb, which is the failure this module exists to
 * catch. `briefed-verbs.unit.test.ts` reads each path off this tree, so a rename reds here.
 */
export const VERB_MODULES: Readonly<Record<BriefedLaneVerb, string>> = {
	report: "lane/report-verb",
};

export type VerbCarriage =
	/** Every briefed verb is in that tree, or the tree is not one the branch decides. */
	| {readonly _tag: "Carried"; readonly why: string}
	| {readonly _tag: "Missing"; readonly verbs: ReadonlyArray<BriefedLaneVerb>}
	/** The branch or one of its paths could not be read — UNKNOWN, never "carried". */
	| {readonly _tag: "Unreadable"; readonly reason: string};

const modulePath = (path: Path.Path, entrypoint: string, verb: BriefedLaneVerb): string =>
	`${path.join(path.dirname(entrypoint), VERB_MODULES[verb])}${path.extname(entrypoint)}`;

export const carriedVerbs = (
	path: Path.Path,
	branch: GitRef,
	entrypoint: FabrikaEntry,
): Effect.Effect<VerbCarriage, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (path.isAbsolute(entrypoint)) {
			return {
				_tag: "Carried",
				why: `${entrypoint} is an installed copy of fabrika, which ${branch} does not carry — the shell runs this repo's dependency, not the branch's source`,
			} as const;
		}
		const resolved = yield* execCapture("git", [
			"rev-parse",
			"--verify",
			"--quiet",
			`${branch}^{commit}`,
		]);
		if (!resolved.ok || resolved.stdout.trim() === "") {
			return {
				_tag: "Unreadable",
				reason: `this tree cannot resolve ${branch}${resolved.reason === "" ? "" : `: ${resolved.reason}`}`,
			} as const;
		}
		const sha = resolved.stdout.trim();
		const missing: BriefedLaneVerb[] = [];
		for (const verb of BRIEFED_LANE_VERBS) {
			const file = modulePath(path, entrypoint, verb);
			const listed = yield* execCapture("git", ["ls-tree", "--name-only", sha, "--", file]);
			// `ls-tree` exits 0 whether or not the path is in the tree, so an empty answer is a PROVEN
			// absence and a non-zero exit is the read itself failing — the two must not collapse.
			if (!listed.ok) {
				return {
					_tag: "Unreadable",
					reason: `cannot read ${file} in ${branch}: ${listed.reason}`,
				} as const;
			}
			if (listed.stdout.trim() === "") missing.push(verb);
		}
		return missing.length === 0
			? ({
					_tag: "Carried",
					why: `${branch} carries ${entrypoint} and every lane verb the brief names`,
				} as const)
			: ({_tag: "Missing", verbs: missing} as const);
	});
