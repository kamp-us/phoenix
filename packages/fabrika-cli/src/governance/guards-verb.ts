/**
 * `governance guards` — the anchored invariants the bound diff removes or modifies, and the
 * guard-bearing files it touches.
 *
 * **The three outcomes are distinct facts and none is a clearance.** `hits` — an anchored invariant
 * moved. `no-anchor-change` — anchors exist in the diff's reach and none moved. `no-anchors-in-reach`
 * — the touched files carry no anchors at all, so this scan had nothing to look at. That third one is
 * the mechanical floor reporting its own silence, not a statement that no guard was weakened: a guard
 * weakened in prose carrying no anchor is invisible here by construction, and the skill's judgment is
 * what covers it.
 *
 * A truncated diff is refused rather than scanned, and what proves it truncated is git against git:
 * the served diff body against the status enumeration of the same range. GitHub's `changed_files` is
 * not that proof and no longer refuses here — the file set is {@link readLocalFileSet}'s local read,
 * shared with `review scope` and `governance scope`, and the count disagreement leaves as a
 * diagnostic line. An under-reported hit list reads as a
 * checked-clean answer that was never checked. A local read of **zero** files is refused at the
 * group's zero-scope seat for that same reason: `inReach` is a denominator only over files that were
 * read, so an empty set renders `no-anchors-in-reach` at exit 0 — a scan of nothing printing clean.
 * For the same reason each changed
 * file is read at the merge base as well as at the head, so an anchor's paragraph is compared whole
 * instead of only where the diff happens to touch it — see `anchors.ts`. That "before" read
 * is a point read at one commit, not a range, so nothing recomputes a merge base for it the way a
 * three-dot diff would: reading it at the base *branch tip* compares this PR's anchors against
 * main's newest bytes and invents a move nobody made.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {capAndCount} from "../evidence.ts";
import {diffRange, diffRangeStatuses, readFileAt} from "../io/git.ts";
import {readLocalFileSet} from "../review/local-file-set.ts";
import {badNumber, openPull, resolveTargetRepo} from "../review/target.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import type {AnchorHit} from "./anchors.ts";
import {
	anchorsIn,
	filesInDiff,
	isGuardBearing,
	mergeHits,
	scanAnchorBlocks,
	scanAnchors,
} from "./anchors.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {bindGovernanceHead, boundLine} from "./head.ts";

const VERB = "governance guards";

const UNKNOWN_TAIL = "the diff cannot be bound to a commit, so what it shows is UNKNOWN.";

/**
 * How many guard-bearing files survive the collapse. The list is evidence, not an answer:
 * the skill cites its existence and never reads a row, so a handful of paths names the neighbourhood
 * the reader then opens for themselves, and `more` carries the rest.
 */
const GUARD_FILE_CAP = 5;

export interface GuardsOptions {
	readonly pr: number;
	readonly sha: string | null;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runGuards = (
	options: GuardsOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openPull(VERB, repo, pr, {
			requireOpen: true,
			closedReason: "nothing to scan.",
			requireFiles: true,
			emptyReason: "nothing to scan.",
			unknownMessage: (reason) =>
				`${VERB}: cannot read PR #${pr} in ${repo}: ${reason} — UNKNOWN, never "nothing moved".`,
		});
		if (target._tag === "Refused") return target.outcome;

		const bound = yield* bindGovernanceHead(VERB, UNKNOWN_TAIL, repo, pr, target.pull, options.sha);
		if (bound._tag === "Refused") return bound.outcome;
		const head = bound.head;
		const diagnostics = [boundLine(VERB, head)];

		const diff = yield* diffRange(head.mergeBase, head.sha);
		if (diff._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the diff for #${pr} at ${head.sha}: ${diff.reason} — UNKNOWN, never "nothing moved".`,
				diagnostics,
			);
		}
		// The local three-dot list is the scan's file set, and GitHub's `changed_files` is reported
		// beside it rather than refused on — `readLocalFileSet` carries why that count is not a floor.
		const listed = yield* readLocalFileSet(
			VERB,
			`#${pr}`,
			{base: head.mergeBase, tip: head.sha},
			target.pull.changedFiles,
			diffRangeStatuses,
		);
		if (listed._tag === "Unreadable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the changed files of #${pr} at ${head.sha}: ${listed.reason} — UNKNOWN, never "nothing moved".`,
				diagnostics,
			);
		}
		if (listed.set.disagreement !== null) diagnostics.push(listed.set.disagreement);
		const changed = listed.set.files;

		// Zero files is the one shortfall a local read alone establishes, and it is the floor `inReach`
		// cannot supply: with no files the scan below never runs, so `no-anchors-in-reach` would print at
		// exit 0 over a read that looked at nothing. Nothing earlier in this verb refuses that zero any
		// more, now that GitHub's declared count is reported and not obeyed, so this seat is the floor.
		if (changed.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: ${head.mergeBase}...${head.sha} changes no path — refusing to scan an empty file set.`,
				diagnostics,
			);
		}

		// The completeness proof that survives is git against git: the served diff body against the
		// status enumeration of the same range. A body short of that list really is truncated, and an
		// under-reported hit list reads as a checked-clean answer that was never checked.
		const carried = filesInDiff(diff.value);
		if (carried < changed.length) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: the diff at ${head.sha} carries ${carried} of the ${changed.length} files git reports for the same range ${head.mergeBase}...${head.sha} — both counts from git, so this diff is provably short; refusing a partial anchor scan.`,
				diagnostics,
			);
		}

		// Anchors are counted at the bound commit rather than off the diff: `inReach` is how many
		// anchored invariants EXIST in the files this diff touches, which is a denominator only over the
		// set that was read. On its own it is no floor, since an empty set renders `no-anchors-in-reach`
		// at exit 0, and the zero-scope refusal above is what keeps a scan of nothing from printing clean.
		const inTree: Array<{readonly path: string; readonly anchors: number}> = [];
		const blockHits: AnchorHit[] = [];
		let compared = 0;
		for (const entry of changed) {
			if (entry.status.startsWith("D")) continue;
			const bytes = yield* readFileAt(head.sha, entry.path);
			if (bytes._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${entry.path} at ${head.sha}: ${bytes.reason} — UNKNOWN, never "nothing moved".`,
					diagnostics,
				);
			}
			inTree.push({path: entry.path, anchors: anchorsIn(bytes.value)});
			// Only a path that names the same file at both commits can be block-compared. An addition has
			// no base side, and a rename's base path is the source `--name-status` drops, so both fall
			// back to the diff walk rather than being read at a path the base commit does not carry.
			if (!(entry.status.startsWith("M") || entry.status.startsWith("T"))) continue;
			const before = yield* readFileAt(head.mergeBase, entry.path);
			if (before._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${entry.path} at ${head.mergeBase}: ${before.reason} — UNKNOWN, never "nothing moved".`,
					diagnostics,
				);
			}
			compared += 1;
			blockHits.push(...scanAnchorBlocks(entry.path, before.value, bytes.value));
		}

		const hits = mergeHits(scanAnchors(diff.value), blockHits);
		const inReach = inTree.reduce((total, file) => total + file.anchors, 0);
		const moved = new Set(hits.map((hit) => hit.file));
		const guardFiles = inTree.filter(
			(file) => isGuardBearing(file.path, file.anchors) && !moved.has(file.path),
		);

		const outcome =
			hits.length > 0 ? "hits" : inReach === 0 ? "no-anchors-in-reach" : "no-anchor-change";
		const collapsed = capAndCount(
			guardFiles.map((file) => ({path: file.path, anchors: file.anchors})),
			GUARD_FILE_CAP,
		);
		diagnostics.push(
			`${VERB}: scanned ${changed.length} files, ${inReach} anchored invariants in reach, ${compared} compared block-by-block against ${head.mergeBase}.`,
		);

		if (json) {
			return answer(
				JSON.stringify({
					outcome,
					hits,
					guardFiles: collapsed,
					inReach,
					scanned: changed.length,
				}),
				diagnostics,
			);
		}
		return answer(
			[
				`guards\t${outcome}\t${inReach}`,
				...hits.map((hit) => `anchor\t${hit.kind}\t${hit.name}\t${hit.file}:${hit.line}`),
				...collapsed.rows.map((file) => `guard-file\t${file.path}\t${file.anchors}`),
				...(collapsed.more > 0 ? [`guard-file-more\t${collapsed.more}`] : []),
			].join("\n"),
			diagnostics,
		);
	});
