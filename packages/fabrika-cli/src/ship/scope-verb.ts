/**
 * `ship scope` — one PR's state, head, linked issue, artifact classes with the review namespaces
 * they require, and the three-state §CP classification.
 *
 * **The class partition and the namespace derivation are one derivation, printed once.** v1 printed
 * the class set from one derivation in one script and hand-copied it in another, and the copy
 * dropped a class on a live PR (#4730) — so the map is shared code with `review scope`
 * (`../review/classes.ts`), extended here with the `ui` class and nothing else.
 *
 * A `merged`, `draft` or `closed` PR is an **answer**, not a refusal: this verb reports state and
 * the skill acts on it. The write verbs downstream refuse a non-open PR themselves — no verb trusts
 * its dispatch.
 *
 * The `landing` line is the one place the two landing paths are named, so a shipper reads its route
 * here rather than composing it from a merge-queue read and a repository-settings read on two
 * different APIs (#6018). It is the one field that **degrades instead of refusing**: an unreadable
 * landing prints `unknown` and costs the run nothing else, because the guard that matters sits on
 * the write — `ship merge` re-derives the same fact itself and refuses `11` where this printed
 * `unknown`, so a degraded read here can never license a landing.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {governedRootsOr} from "../config/paths.ts";
import {listPullFiles} from "../io/pulls.ts";
import {issueRefOf, partitionWithUi, renderIssueRef, shipNamespacesOf} from "../review/classes.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {readBoundary} from "./boundary.ts";
import {classify} from "./codeowners.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {readLanding} from "./landing.ts";
import {badNumber, NULL_TOKEN, resolvePull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "ship scope";

export interface ScopeOptions {
	readonly pr: number;
	readonly repo: string | null;
	readonly json: boolean;
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** `open` / `draft` / `merged` / `closed` — four lifecycle words over two REST fields. */
const lifecycleOf = (merged: boolean, draft: boolean, state: string): string =>
	merged ? "merged" : state !== "open" ? "closed" : draft ? "draft" : "open";

export const runScope = (
	options: ScopeOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	| ChildProcessSpawner.ChildProcessSpawner
	| FileSystem.FileSystem
	| HttpClient.HttpClient
	| Path.Path
> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const governed = yield* governedRootsOr(
			VERB,
			options.cwd,
			"whether this diff derives the governance namespace is UNKNOWN, and a required set short one namespace is a merge gated on less than the diff earns.",
		);
		if (governed._tag === "Refused") return refuse(PRECONDITION_UNKNOWN, governed.message);

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* resolvePull(VERB, repo, pr, {
			unknownMessage: (reason) =>
				`${VERB}: cannot read the pull request for #${pr}: ${reason} — the scope is UNKNOWN.`,
		});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;

		const listed = yield* listPullFiles(repo, pr);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the changed-file list for #${pr}: ${listed.reason} — the scope is UNKNOWN.`,
			);
		}
		const files = listed.value;
		const diagnostics = [
			scannedLine(VERB, files.length, "changed file", `${pull.changedFiles} declared`),
		];
		if (files.length < pull.changedFiles) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: file list shows ${files.length} of ${pull.changedFiles} declared files — refusing to partition a truncated read.`,
				diagnostics,
			);
		}
		if (files.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: PR #${pr} has zero changed files — nothing to ship (ADR 0092).`,
				diagnostics,
			);
		}

		const partition = partitionWithUi(files, governed.roots);
		const namespaces = shipNamespacesOf(partition);
		if (namespaces.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: #${pr}'s diff derives zero review namespaces — a merge gated on nothing is vacuously green (#2765); the class map has a hole, file it.`,
				diagnostics,
			);
		}

		const boundary = yield* readBoundary(repo, pull.baseRef);
		if (boundary._tag === "Unreadable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the §CP boundary for #${pr}: ${boundary.reason} — the scope is UNKNOWN.`,
				diagnostics,
			);
		}
		const cp = classify(boundary.rows, files);
		const state = lifecycleOf(pull.merged, pull.draft, pull.state);
		const issue = issueRefOf(pull.body);

		const read = yield* readLanding(repo, pull.baseRef, options.env);
		if (read._tag === "Failure") {
			diagnostics.push(
				`${VERB}: cannot read ${pull.baseRef}'s landing path: ${read.reason} — reporting it unknown; \`ship merge\` refuses on the same read rather than landing.`,
			);
		}
		const landing = read._tag === "Failure" ? {path: "unknown", method: null} : read.value;

		if (json) {
			return answer(
				JSON.stringify({
					outcome: "scoped",
					head: pull.headSha,
					state,
					issue,
					classes: partition.classes,
					namespaces,
					cp,
					landing,
					scanned: partition.scanned,
				}),
				diagnostics,
			);
		}
		return answer(
			[
				`scoped\t${pull.headSha}\t${state}\t${renderIssueRef(issue, NULL_TOKEN)}`,
				...partition.classes.map((entry) => `class\t${entry.name}\t${entry.files}`),
				...namespaces.map((namespace) => `namespace\t${namespace}`),
				`cp\t${cp}`,
				`landing\t${landing.path}\t${landing.method ?? NULL_TOKEN}`,
				`files\t${partition.scanned}`,
			].join("\n"),
			diagnostics,
		);
	});
