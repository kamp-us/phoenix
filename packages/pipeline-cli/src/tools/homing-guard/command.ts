/**
 * The `homing-guard` tool — `pipeline-cli homing-guard check [--issue <N>]`.
 *
 * The enforcement half of the triage rubric's home-or-exempt-or-kill outcome (#3939, ADR
 * 0202 forward-motion doctrine + ADR 0208 standing-lane exemption). Reds when an issue
 * leaves triage with neither an arc/campaign milestone nor one of the two standing-lane
 * labels — the invariant is enforced at the seam, not re-swept by hand:
 *
 *   pipeline-cli homing-guard check              # the whole open status:triaged backlog
 *   pipeline-cli homing-guard check --issue 123  # one issue (the per-issue seam check)
 *
 * The pure decision lives in `homing-guard.ts` (unit-tested); the `gh api` read in
 * `github.ts`/`gate.ts`. `TriagedIssuesLive` is baked in with `Command.provide(...)` so the
 * registered command's residual requirement is the Node platform union (the registry seam,
 * epic #994).
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — an un-homed issue, the zero-scope
 * fail-closed (ADR 0092), and a `gh`/repo failure all exit non-zero, undistinguished.
 */
import {Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {onCheckFailed} from "../../gate-fail.ts";
import {checkHoming} from "./gate.ts";
import {TriagedIssuesLive} from "./github.ts";

const issueFlag = Flag.integer("issue").pipe(
	Flag.optional,
	Flag.withDescription("check one issue instead of the whole open status:triaged backlog"),
);

const check = Command.make(
	"check",
	{issue: issueFlag},
	Effect.fn(function* ({issue}) {
		yield* checkHoming(issue).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Fail the build if a status:triaged issue carries neither a milestone nor a standing-lane label",
	),
);

export const homingGuardCommand = Command.make("homing-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: every triaged issue is milestone-homed or standing-lane exempt (ADR 0202/0208, #3939)",
	),
	Command.provide(TriagedIssuesLive),
);
