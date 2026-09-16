/**
 * `ship release` — dark-ship detection and the `status:awaiting-release` label.
 *
 * Agents deploy, humans release: the label is the seam and the whole action. Nothing here
 * flips or validates a flag.
 *
 * `no-issue` is deliberately its own answer, never folded into `n/a`: a dark-ship signal fired and
 * there is no linked issue to label, which means a dark ship the release queue cannot see — the
 * exact hazard this verb exists to prevent. The label write is read back, because v1's unverified
 * POST could report a release queued that no human would ever find.
 *
 * The write is also taxonomy-guarded like every other board-label writer: GitHub's
 * label POST creates what it cannot find, so on a repo that never bootstrapped its taxonomy an
 * unguarded write mints `status:awaiting-release` with a random colour and no description.
 *
 * **The flag scan runs over the enumerated file list, not over GitHub's `changed_files`.** A list
 * short of that declared count used to refuse at `13`, and the count is the stale side: GitHub
 * computes it against a base cached at the PR's last push, which nothing on the caller's side can
 * invalidate, so the refusal blocked the scan with no act available to clear it.
 * {@link platformFileSet} owns that argument; the disagreement leaves as a `scanned` line.
 *
 * **What survives is an empty list and the endpoint's own ceiling.** A zero would answer `n/a` over
 * a diff nobody read, which is the dark ship this verb exists to catch, so it refuses at `7`. And
 * `pulls/<n>/files` serves at most 3000 files (`PULL_FILES_CAP`) and ends its Link chain normally
 * there, so a flag declaration could sit in the part the platform never served — that stays `13`.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9322#issuecomment-5703498377
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {addLabels, getIssue, listLabels} from "../io/issues.ts";
import {getPullDiff, listPullFiles} from "../io/pulls.ts";
import {AWAITING_RELEASE} from "../labels.ts";
import {linkedIssueOf} from "../review/classes.ts";
import {platformCapLine, platformFileSet} from "../review/local-file-set.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	INCOMPLETE_SCAN,
	LABEL_ABSENT,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {detect, FLAG_REGISTRY} from "./dark-ship.ts";
import {readFileAtRef} from "./github.ts";
import {badNumber, NULL_TOKEN, resolvePull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "ship release";

export interface ReleaseOptions {
	readonly pr: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runRelease = (
	options: ReleaseOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const unreadable = (what: string, reason: string): string =>
			`${VERB}: cannot read ${what}: ${reason} — whether this is a dark ship is UNKNOWN, never "n/a".`;

		const target = yield* resolvePull(VERB, repo, pr, {
			unknownMessage: (reason) => unreadable(`PR #${pr}`, reason),
		});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;

		const listed = platformFileSet(
			VERB,
			`#${pr}`,
			pull.changedFiles,
			yield* listPullFiles(repo, pr),
		);
		if (listed._tag === "Unreadable") {
			return refuse(PRECONDITION_UNKNOWN, unreadable("the changed-file list", listed.reason));
		}
		const files = listed.set.files;
		const diagnostics = [
			scannedLine(VERB, files.length, "changed file", `${pull.changedFiles} declared`),
			...(listed.set.disagreement === null ? [] : [listed.set.disagreement]),
		];
		// Zero is the shortfall the enumeration alone establishes, and with the declared count no longer
		// refusing it is the only seat left: an empty list carries no flag declaration to find, so `n/a`
		// would be answered over a diff nobody read.
		if (files.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: PR #${pr} has zero changed files — whether it carries a flag signal is unanswerable, and "n/a" would be a dark ship nobody queued.`,
				diagnostics,
			);
		}
		// The ceiling is the one truncation the enumeration cannot rule out on its own: the endpoint
		// stops serving files there and ends its Link chain as a complete read ends.
		if (listed.set.capped) {
			return refuse(
				INCOMPLETE_SCAN,
				platformCapLine(
					VERB,
					`#${pr}`,
					"a flag declaration could sit in the part the platform never served.",
				),
				diagnostics,
			);
		}

		const diff = yield* getPullDiff(repo, pr);
		if (diff._tag === "Failure") {
			return refuse(PRECONDITION_UNKNOWN, unreadable("the diff", diff.reason), diagnostics);
		}
		const registry = yield* readFileAtRef(repo, FLAG_REGISTRY, pull.baseRef);
		if (registry._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				unreadable("the flag registry", registry.reason),
				diagnostics,
			);
		}
		// An ABSENT registry is a fact about the repo — a foreign install with no flag substrate has no
		// declared keys, so signal (c) simply finds none. Only a FAILED read is UNKNOWN.
		const declaredIn = registry._tag === "Present" ? registry.value : "";

		const shipped = detect(diff.value, pull.body, declaredIn);
		const emit = (outcome: string, key: string | null, issue: number | null): VerbOutcome =>
			json
				? answer(JSON.stringify({outcome, flagKey: key, issue}), diagnostics)
				: answer(`release\t${outcome}\t${key ?? NULL_TOKEN}`, diagnostics);

		if (!shipped.dark) return emit("n/a", null, null);

		const issue = linkedIssueOf(pull.body);
		if (issue === null) return emit("no-issue", shipped.key, null);

		// Guarded here and not earlier: it is the POST below that mints an unknown label, so an `n/a`
		// or `no-issue` run — which posts nothing — owes the taxonomy no read (`plan flip` too).
		const taxonomy = yield* listLabels(repo);
		if (taxonomy._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${repo}'s label taxonomy: ${taxonomy.reason} — nothing was written, and a real dark ship is not queued; escalate.`,
				diagnostics,
			);
		}
		if (!taxonomy.value.includes(AWAITING_RELEASE)) {
			return refuse(
				LABEL_ABSENT,
				`${VERB}: label "${AWAITING_RELEASE}" is absent from ${repo}'s taxonomy — refusing to create it. A real dark ship is not queued; run \`fabrika status bootstrap label-taxonomy\` and re-run.`,
				diagnostics,
			);
		}

		const labelled = yield* addLabels(repo, issue, [AWAITING_RELEASE]);
		if (labelled._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: label write failed: ${labelled.reason} — a real dark ship may be missing from the release queue; escalate.`,
				diagnostics,
			);
		}
		const after = yield* getIssue(repo, issue);
		if (after._tag !== "Present") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: label write failed: the confirming re-read of #${issue} failed — a real dark ship may be missing from the release queue; escalate.`,
				diagnostics,
			);
		}
		if (!after.value.labels.includes(AWAITING_RELEASE)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: label read-back does not show ${AWAITING_RELEASE} on #${issue} — inspect it.`,
				diagnostics,
			);
		}
		return emit("queued", shipped.key, issue);
	});
