/**
 * `governance base` — this skill's own text at the merge base of the diff that edits it.
 *
 * **The verb exists so the self fence is a pasteable literal.** The rule it serves — judge a
 * self-editing diff by the merge-base revision of its own text (ADR 0052) — otherwise needs a merge-base
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
 *
 * **`--base`/`--tip` gives an epic child the same fence (#6064).** A child has no PR mid-run
 * (ADR 0285), so before this form a child range editing this skill was judged by its own new rules —
 * the guard opening exactly on the diff that edits the guard. The merge base of a range is
 * `merge-base(base, tip)`, the same commit the range's own three-dot diff is taken from; see
 * `../review/range-flags.ts`, which owns that grounding.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CommitRange, listTreePaths, readFileAt} from "../io/git.ts";
import {getPullRequest} from "../io/pulls.ts";
import {rangeMergeBase, readRangeFlags} from "../review/range-flags.ts";
import {badNumber, openPull, resolveTargetRepo} from "../review/target.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import type {HeadSha} from "../wire/marker-line.ts";
import {renderRange} from "../wire/range-verdict-marker.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN, STALE_HEAD, ZERO_SCOPE} from "./codes.ts";
import {bindGovernanceHead} from "./head.ts";
import {insideRoot, resolveSkillRoots} from "./skill-root.ts";

const VERB = "governance base";

/** The two files the self fence reads when the caller names none. */
const DEFAULT_FILES = ["SKILL.md", "contract.md"];

/** The tail every refusal on this verb wears — the fence never degrades to the head's rules. */
const UNKNOWN_TAIL = "the base rules are UNKNOWN; refusing to judge by the head's.";

export interface BaseOptions {
	/** The pull request to judge — `null` only in range mode, which resolves no PR at all. */
	readonly pr: number | null;
	readonly path: ReadonlyArray<string>;
	/** The two ends of a range-scoped fence — both or neither. This verb has no `--sha` to refuse. */
	readonly base: string | null;
	readonly tip: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** The merge base to read at, and how the diagnostics name the diff it came from. */
interface Resolution {
	readonly base: string;
	readonly subject: string;
}

type Resolved =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Resolved"; readonly resolution: Resolution};

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The merge base of a live PR, with the head it was paired against re-read afterwards.
 *
 * A base paired with a head nobody judged is not a fence, so the head is re-read after the binding
 * rather than trusted from before it.
 */
const pullBase = (
	options: BaseOptions,
	pr: number,
): Effect.Effect<Resolved, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return {_tag: "Refused" as const, outcome: resolved.outcome};
		const repo = resolved.repo;

		const target = yield* openPull(VERB, repo, pr, {
			requireOpen: true,
			closedReason: "there is no base revision to judge by.",
			requireFiles: false,
			unknownMessage: (reason) =>
				`${VERB}: cannot read PR #${pr} in ${repo}: ${reason} — ${UNKNOWN_TAIL}`,
		});
		if (target._tag === "Refused") return {_tag: "Refused" as const, outcome: target.outcome};

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
		if (bound._tag === "Refused") return {_tag: "Refused" as const, outcome: bound.outcome};
		const head = bound.head;

		const after = yield* getPullRequest(repo, pr);
		if (after._tag !== "Present") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot re-read PR #${pr} in ${repo}: ${after._tag === "Unknown" ? after.reason : "it is no longer there"} — ${UNKNOWN_TAIL}`,
				),
			};
		}
		if (after.value.headSha !== head.sha) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					STALE_HEAD,
					`${VERB}: #${pr}'s head moved to ${after.value.headSha} while resolving — re-run.`,
				),
			};
		}
		// The binding already resolved this, and resolving it twice is how two answers to one question
		// come to disagree (#5770).
		return {_tag: "Resolved" as const, resolution: {base: head.mergeBase, subject: `#${pr}`}};
	});

/**
 * The merge base of a range — the one commit its own three-dot diff is taken from.
 *
 * There is no staleness check here and none is missing: a PR's head is a moving name this verb has
 * to re-read, where a range's two ends are revisions the caller already fixed, so nothing can move
 * between resolving and reading.
 */
const rangeBase = (
	range: CommitRange<HeadSha>,
): Effect.Effect<Resolved, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const subject = renderRange(range);
		const base = yield* rangeMergeBase(range);
		return base._tag === "Failure"
			? {
					_tag: "Refused" as const,
					outcome: refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot resolve the merge base of ${subject}: ${base.reason} — ${UNKNOWN_TAIL}`,
					),
				}
			: {_tag: "Resolved" as const, resolution: {base: base.value, subject}};
	});

export const runBase = (
	options: BaseOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr} = options;

		const flags = readRangeFlags(VERB, {base: options.base, tip: options.tip, sha: null});
		if (flags._tag === "Refused") return flags.outcome;

		let resolved: Resolved;
		if (flags._tag === "Ranged") {
			if (pr !== null) {
				return refuse(
					OFF_VOCABULARY,
					`${VERB}: a range is its own subject — drop the pull-request number, or drop --base/--tip.`,
				);
			}
			resolved = yield* rangeBase(flags.range);
		} else {
			if (pr === null) {
				return refuse(
					OFF_VOCABULARY,
					`${VERB}: name a pull request, or scope a range with --base and --tip — there is no subject here.`,
				);
			}
			const bad = badNumber(VERB, "a pull-request number", pr);
			if (bad !== null) return bad;
			resolved = yield* pullBase(options, pr);
		}
		if (resolved._tag === "Refused") return resolved.outcome;
		const {base, subject} = resolved.resolution;

		const tree = yield* listTreePaths(base);
		if (tree._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot list the tree at merge base ${base}: ${tree.reason} — ${UNKNOWN_TAIL}`,
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

		diagnostics.push(`${VERB}: merge base of ${subject} is ${base}.`);
		return answer(`base\t${base}\t${blocks.length}\n${blocks.join("")}`, diagnostics);
	});
