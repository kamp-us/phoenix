/**
 * `ship release` — dark-ship detection and the `status:awaiting-release` label.
 *
 * Agents deploy, humans release (ADR 0083): the label is the seam and the whole action. Nothing here
 * flips or validates a flag.
 *
 * `no-issue` is deliberately its own answer, never folded into `n/a`: a dark-ship signal fired and
 * there is no linked issue to label, which means a dark ship the release queue cannot see — the
 * exact hazard this verb exists to prevent. The label write is read back, because v1's unverified
 * POST could report a release queued that no human would ever find.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {addLabels, getIssue} from "../io/issues.ts";
import {getPullDiff, listPullFiles} from "../io/pulls.ts";
import {linkedIssueOf} from "../review/classes.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";
import {detect, FLAG_REGISTRY} from "./dark-ship.ts";
import {readFileAtRef} from "./github.ts";
import {badNumber, NULL_TOKEN, resolvePull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "ship release";
const AWAITING_RELEASE = "status:awaiting-release";

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

		const files = yield* listPullFiles(repo, pr);
		if (files._tag === "Failure") {
			return refuse(PRECONDITION_UNKNOWN, unreadable("the changed-file list", files.reason));
		}
		const diagnostics = [
			scannedLine(VERB, files.value.length, "changed file", `${pull.changedFiles} declared`),
		];
		if (files.value.length < pull.changedFiles) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${files.value.length} of ${pull.changedFiles} declared files — refusing to scan a truncated diff for flag signals.`,
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
