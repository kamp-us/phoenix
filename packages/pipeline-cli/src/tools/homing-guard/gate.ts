/**
 * The `homing-guard` gate — the IO seam wiring the pure core to the one fact it judges: the
 * open `status:triaged` set (read over `gh api` via `TriagedIssues`). Split from `command.ts`
 * so the wiring is crossable in tests, and kept thin: it reads, delegates the verdict to
 * `homing-guard.ts`, and fails `CheckFailed` (exit non-zero) on any non-passing verdict —
 * including the zero-scope fail-closed of ADR 0092.
 */
import {Console, Effect, Option} from "effect";
import * as Schema from "effect/Schema";
import type {RepoLabelsError} from "../vocabulary-preflight/github.ts";
import {RepoLabels} from "../vocabulary-preflight/github.ts";
import type {GhCommandError, GhParseError, RepoResolutionError} from "./github.ts";
import {TriagedIssues} from "./github.ts";
import {judge, renderReport, type Scope, TRIAGED_LABEL} from "./homing-guard.ts";

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

/**
 * The CI gate: read the triaged set in scope and judge home-or-exempt over it. `issue`
 * narrows the scan to one issue — the per-issue seam check a triage sweep runs right after
 * it stamps `status:triaged`, so a red names the issue that just lost its home rather than
 * the whole backlog. Succeeds only on a passing verdict.
 */
export const checkHoming = (
	issue: Option.Option<number>,
): Effect.Effect<
	void,
	| CheckFailed
	| RepoResolutionError
	| GhCommandError
	| GhParseError
	| Schema.SchemaError
	| RepoLabelsError,
	TriagedIssues | RepoLabels
> =>
	Effect.gen(function* () {
		const triaged = yield* TriagedIssues;
		const labels = yield* RepoLabels;
		const [issues, scope] = yield* Option.match(issue, {
			onNone: () =>
				triaged.list().pipe(Effect.map((is) => [is, {_tag: "backlog"} as Scope] as const)),
			// The issue fork reads the label universe too: without it an empty result cannot be told
			// from a repo that never had `status:triaged`, and the core would pass vacuously (#4272).
			onSome: (n) =>
				Effect.all([triaged.get(n), labels.presence([TRIAGED_LABEL])], {
					concurrency: "unbounded",
				}).pipe(
					Effect.map(
						([is, vocabulary]) => [is, {_tag: "issue", number: n, vocabulary} as Scope] as const,
					),
				),
		});
		const verdict = judge(issues, scope);
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
