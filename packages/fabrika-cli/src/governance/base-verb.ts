/**
 * `governance base` — this skill's own text at the merge base of a PR that edits it.
 *
 * **The verb exists so the self fence is a pasteable literal.** The rule it serves — judge a
 * self-editing PR by the merge-base revision of its own text (ADR 0052) — otherwise needs a merge-base
 * SHA the model would have to compute and interpolate, which the harness's isolation verifier refuses.
 * Resolving a merge base and reading named paths at it is mechanical; judging by them is not.
 *
 * **`--path` is fenced to this skill's own directory, and that directory is resolved, not hardcoded.**
 * The fence is deliberate: a general "read any file at the merge base" verb would be a second way to
 * load instructions out of a tree, which is what the whole no-checkout posture exists to prevent. And
 * nothing is checked out here either — the bytes come from the object database.
 *
 * The `11` refusal never falls back to the head. A self fence that degrades to the head's rules on a
 * failed read is a fence that opens exactly when it is being tested.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {listTreePaths, readFileAt} from "../io/git.ts";
import {getPullRequest} from "../io/pulls.ts";
import {badNumber, openPull, resolveTargetRepo} from "../review/target.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN, STALE_HEAD, ZERO_SCOPE} from "./codes.ts";
import {bindGovernanceHead} from "./head.ts";
import {insideRoot, resolveSkillRoots} from "./skill-root.ts";

const VERB = "governance base";

/** The two files the self fence reads when the caller names none. */
const DEFAULT_FILES = ["SKILL.md", "contract.md"];

export interface BaseOptions {
	readonly pr: number;
	readonly path: ReadonlyArray<string>;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export const runBase = (
	options: BaseOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openPull(VERB, repo, pr, {
			requireOpen: true,
			closedReason: "there is no base revision to judge by.",
			requireFiles: false,
			unknownMessage: (reason) =>
				`${VERB}: cannot read PR #${pr} in ${repo}: ${reason} — the base rules are UNKNOWN; refusing to judge by the head's.`,
		});
		if (target._tag === "Refused") return target.outcome;

		// This verb takes no `--sha`, so the binding runs against the live head and the staleness check
		// below is what pairs the two.
		const bound = yield* bindGovernanceHead(
			VERB,
			"the merge base cannot be resolved, so the base rules are UNKNOWN.",
			repo,
			pr,
			target.pull,
			null,
		);
		if (bound._tag === "Refused") return bound.outcome;
		const head = bound.head;

		// The binding already resolved this, and resolving it twice is how two answers to one question
		// come to disagree (#5770). A failed resolve refuses inside `bindGovernanceHead` above, wearing
		// this verb's own tail.
		const base = head.mergeBase;

		// A base paired with a head nobody judged is not a fence, so the head is re-read after the
		// binding rather than trusted from before it.
		const after = yield* getPullRequest(repo, pr);
		if (after._tag !== "Present") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot re-read PR #${pr} in ${repo}: ${after._tag === "Unknown" ? after.reason : "it is no longer there"} — the base rules are UNKNOWN; refusing to judge by the head's.`,
			);
		}
		if (after.value.headSha !== head.sha) {
			return refuse(
				STALE_HEAD,
				`${VERB}: #${pr}'s head moved to ${after.value.headSha} while resolving — re-run.`,
			);
		}

		const tree = yield* listTreePaths(base);
		if (tree._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot list the tree at merge base ${base}: ${tree.reason} — the base rules are UNKNOWN; refusing to judge by the head's.`,
			);
		}
		const roots = resolveSkillRoots(tree.value);
		if (roots._tag === "None") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: no \`*/fabrika/skills/governance/SKILL.md\` at merge-base ${base} — this skill is not installed in the base revision, so there is no self fence to run.`,
			);
		}
		if (roots._tag === "Many") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: ${roots.candidates.length} candidate skill roots at merge-base ${base} (${roots.candidates.join(", ")}) — which one is this skill is UNKNOWN; refusing to guess.`,
			);
		}
		const root = roots.root;
		const diagnostics = [
			`${VERB}: resolved this skill's own directory to ${root} at merge-base ${base}.`,
		];

		const wanted =
			options.path.length === 0 ? DEFAULT_FILES.map((name) => `${root}${name}`) : options.path;
		for (const path of wanted) {
			if (!insideRoot(root, path)) {
				return refuse(
					OFF_VOCABULARY,
					`${VERB}: --path "${path}" is outside this skill's own directory (${root}) — this verb reads only this skill's own text.`,
					diagnostics,
				);
			}
		}

		const present = new Set(tree.value);
		const blocks: string[] = [];
		for (const path of wanted) {
			// Absence is PROVEN from the tree listing, so a path that is simply not there is skipped and
			// a path that is there and will not read is `11` — the two are different facts.
			if (!present.has(path)) continue;
			const bytes = yield* readFileAt(base, path);
			if (bytes._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${path} at ${base}: ${bytes.reason} — UNKNOWN.`,
					diagnostics,
				);
			}
			blocks.push(`file\t${path}\t${byteLength(bytes.value)}\n${bytes.value}`);
		}
		if (blocks.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: none of the requested paths exist at merge-base ${base} — there is no base revision to judge by.`,
				diagnostics,
			);
		}

		diagnostics.push(`${VERB}: merge base of #${pr} is ${base}.`);
		return answer(`base\t${base}\t${blocks.length}\n${blocks.join("")}`, diagnostics);
	});
