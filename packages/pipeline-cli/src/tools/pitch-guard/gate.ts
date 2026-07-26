/**
 * The `pitch-guard` gate — the IO seam wiring the pure core to the facts it judges: the open
 * lane-entering `status:triaged` set with each candidate's pitch body and ACL-resolved comments
 * (read over `gh api` via `PitchCandidates`). Split from `command.ts` so the wiring is crossable
 * in tests, and kept thin: it reads, delegates the verdict to `pitch-guard.ts`, and fails
 * `CheckFailed` (exit non-zero) on any non-passing verdict — including ADR 0092's zero-scope.
 */
import {Console, Effect, Option} from "effect";
import * as Schema from "effect/Schema";
import type {PitchGuardError} from "./github.ts";
import {PitchCandidates} from "./github.ts";
import {judge, renderReport, type Scope} from "./pitch-guard.ts";

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

/**
 * The intake gate: read the lane-entering set in scope and judge pitch-and-approval over it.
 * `issue` narrows the scan to one issue — the per-issue seam check triage runs right after it
 * drafts a pitch, so a red names that draft rather than the whole backlog.
 */
export const checkPitches = (
	issue: Option.Option<number>,
): Effect.Effect<void, CheckFailed | PitchGuardError, PitchCandidates> =>
	Effect.gen(function* () {
		const candidates = yield* PitchCandidates;
		const [issues, scope] = yield* Option.match(issue, {
			onNone: () =>
				candidates.list().pipe(Effect.map((is) => [is, {_tag: "backlog"} as Scope] as const)),
			onSome: (n) =>
				candidates
					.get(n)
					.pipe(Effect.map((is) => [is, {_tag: "issue", number: n} as Scope] as const)),
		});
		const verdict = judge(issues, scope);
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
