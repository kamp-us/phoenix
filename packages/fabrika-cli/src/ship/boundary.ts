/**
 * Reading the §CP boundary once, for the two verbs that need it.
 *
 * The ref is the PR's **base branch**, not the PR — a PR must not reclassify itself (#981), and not
 * a literal trunk name either: the base ref is that same branch in this repo and the honest
 * generalization in an adopter repo whose trunk is called something else (#5067 clause 4).
 *
 * A **proven-absent** CODEOWNERS (404) is an empty row set, which classifies as the `unknown` hold.
 * A **failed read** is neither — it is the caller's `11`, the distinction v1 collapsed when a failed
 * §CP read reported "awaiting approval" (#4223). Neither answers `not-control-plane`: ADR 0220 §4
 * names collapsing `unknown` → `not-control-plane` the recurring fail-open defect, and `unknown` is
 * the state that holds the PR.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type OwnerRow, parseCodeowners} from "./codeowners.ts";
import {readFileAtRef} from "./github.ts";

export const CODEOWNERS_PATH = ".github/CODEOWNERS";

export type BoundaryRead =
	| {readonly _tag: "Unreadable"; readonly reason: string}
	| {readonly _tag: "Rows"; readonly rows: ReadonlyArray<OwnerRow>};

export const readBoundary = (
	repo: string,
	ref: string,
): Effect.Effect<BoundaryRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* readFileAtRef(repo, CODEOWNERS_PATH, ref);
		if (found._tag === "Unknown") return {_tag: "Unreadable" as const, reason: found.reason};
		return {
			_tag: "Rows" as const,
			rows: found._tag === "Absent" ? [] : parseCodeowners(found.value),
		};
	});
