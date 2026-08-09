/**
 * `review scope` — the head SHA, the linked issue, the artifact-class partition of the PR's changed
 * files, and the `self` / `harness` flags.
 *
 * The refusals are the point: the partition is total over **what was read**, so the verb exists to
 * make sure it is never run over less than everything. A zero-file PR reds (v1's `class-probe` read
 * 0 files and classified `has-code` exit 0 — #4060), and a file list short of the declared count reds
 * rather than partitioning a truncated read (#3999).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {listPullFiles} from "../io/pulls.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {linkedIssueOf, namespacesOf, partition} from "./classes.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {badNumber, openPull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "review scope";

/** The null token this group prints for a field with no value. One token, every verb. */
export const NULL_TOKEN = "-";

export interface ScopeOptions {
	readonly pr: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runScope = (
	options: ScopeOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openPull(VERB, repo, pr, {requireOpen: true, requireFiles: true});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;

		const listed = yield* listPullFiles(repo, pr);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read PR #${pr} in ${repo}: ${listed.reason} — the scope is UNKNOWN.`,
			);
		}
		const files = listed.value;
		const diagnostics = [
			scannedLine(VERB, files.length, "changed file", `${pull.changedFiles} declared`),
		];
		if (files.length < pull.changedFiles) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: file list shows ${files.length} of ${pull.changedFiles} declared files — refusing to partition a truncated read (#3999).`,
				diagnostics,
			);
		}

		const result = partition(files);
		const issue = linkedIssueOf(pull.body);
		if (json) {
			return answer(
				JSON.stringify({
					outcome: "scoped",
					head: pull.headSha,
					issue,
					classes: result.classes,
					self: result.self,
					harness: result.harness,
					scanned: result.scanned,
					namespaces: namespacesOf(result),
				}),
				diagnostics,
			);
		}
		return answer(
			[
				`scoped\t${pull.headSha}\t${issue ?? NULL_TOKEN}`,
				...result.classes.map((entry) => `class\t${entry.name}\t${entry.files}`),
				`self\t${result.self}`,
				`harness\t${result.harness}`,
			].join("\n"),
			diagnostics,
		);
	});
