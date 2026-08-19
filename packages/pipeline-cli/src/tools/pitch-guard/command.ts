/**
 * The `pitch-guard` tool — `pipeline-cli pitch-guard check [--issue <N>]`.
 *
 * The enforcement half of the pitch requirement (#3963; founder ruling #3909's §PITCH intake
 * format — its v1 skill-doc home retired with ADR 0303). Reds when lane-entering
 * work is pickable (`status:triaged`) without a well-formed, founder-approved pitch — the teeth
 * that keep the format from landing advisory-only:
 *
 *   pipeline-cli pitch-guard check              # the whole open lane-entering backlog
 *   pipeline-cli pitch-guard check --issue 123  # one issue (the triage-seam check)
 *
 * Intake-only by contract: the founder ruling that requires a pitch also forbids any
 * merge-blocking conformance gate on shipped work, so this never gates a PR (#3909).
 *
 * The pure decision lives in `pitch-guard.ts` (unit-tested); the `gh api` reads in
 * `github.ts`/`gate.ts`.
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — an unpitched bet, the zero-scope
 * fail-closed (ADR 0092), and a `gh`/repo failure all exit non-zero, undistinguished.
 */
import {Effect, Layer} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {onCheckFailed} from "../../gate-fail.ts";
import {RepoLabelsLive} from "../vocabulary-preflight/github.ts";
import {checkPitches} from "./gate.ts";
import {PitchCandidatesLive} from "./github.ts";

const issueFlag = Flag.integer("issue").pipe(
	Flag.optional,
	Flag.withDescription("check one issue instead of the whole open lane-entering backlog"),
);

const check = Command.make(
	"check",
	{issue: issueFlag},
	Effect.fn(function* ({issue}) {
		yield* checkPitches(issue).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Fail the build if lane-entering work is pickable without a founder-approved pitch",
	),
);

export const pitchGuardCommand = Command.make("pitch-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed intake gate: every pickable bet carries a founder-approved pitch (§PITCH, #3909/#3963)",
	),
	Command.provide(Layer.merge(PitchCandidatesLive, RepoLabelsLive)),
);
