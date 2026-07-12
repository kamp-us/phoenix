/**
 * The `campaign` tool — `pipeline-cli campaign verify-trace <wave-label> [--founder <login>]`.
 *
 * The fail-closed founder-approval-trace verifier (issue #2658). The campaign skill is
 * invoker-agnostic — a human OR an agent may run it — so the sole authorization that a wave may
 * become a campaign is a durable, auditable, founder-authored approval marker bound to the wave
 * label. This is the seam the skill calls at pre-flight, and that CI can re-check: it exits 0
 * ONLY on a present, well-formed, founder-authored, wave-bound trace, and exits non-zero on
 * absence, malformation, a non-founder author, or zero scope (ADR 0092). The IO-free decision
 * lives in `campaign-trace.ts` (unit-tested exhaustively); the `gh api` boundary is `github.ts`.
 *
 * The founder identity is resolved from `--founder` or `$CAMPAIGN_FOUNDER_LOGIN` — never hardcoded
 * (no named identity in a committed artifact). With neither set the verifier fails closed rather
 * than fall back to any implicit login, so a missing config can never be mistaken for approval.
 *
 * `GithubLive` is baked in with `Command.provide(...)` so the registered command's residual
 * requirement is the Node platform union (the registry seam, epic #994).
 */
import {Console, Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {renderReport} from "./campaign-trace.ts";
import {Github, GithubLive} from "./github.ts";

const FAIL_EXIT_CODE = 1;

const waveLabelArg = Argument.string("wave-label").pipe(
	Argument.withDescription("the wave label whose cluster's founder-approval trace to verify"),
);

const founderFlag = Flag.string("founder").pipe(
	Flag.optional,
	Flag.withDescription(
		"the founder's GitHub login (default: $CAMPAIGN_FOUNDER_LOGIN) — the authorization anchor",
	),
);

/** Print `reason` on stderr and exit non-zero — the fail-closed signal a skill/CI caller branches on. */
const fail = (reason: string): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`${reason}\n`);
		process.exit(FAIL_EXIT_CODE);
	});

/** Resolve the founder login from the flag, else the env — trimmed; empty ⇒ unresolved. */
const resolveFounder = (flag: Option.Option<string>): string =>
	Option.getOrElse(flag, () => process.env.CAMPAIGN_FOUNDER_LOGIN ?? "").trim();

const verifyTrace = Command.make(
	"verify-trace",
	{waveLabel: waveLabelArg, founder: founderFlag},
	Effect.fn(function* ({waveLabel, founder}) {
		const founderLogin = resolveFounder(founder);
		if (founderLogin === "") {
			return yield* fail(
				"campaign verify-trace: FAIL (zero-scope) — no founder identity configured " +
					"(pass --founder or set $CAMPAIGN_FOUNDER_LOGIN). Refusing to verify without an " +
					"authorization anchor rather than fall back to any implicit login (ADR 0092).",
			);
		}
		const result = yield* (yield* Github).verify(waveLabel, founderLogin);
		if (result.verdict.pass) {
			yield* Console.log(renderReport(result.verdict));
			return;
		}
		return yield* fail(renderReport(result.verdict));
	}),
).pipe(
	Command.withDescription(
		"Verify a wave's founder-approval trace (exit 0 = present, well-formed, founder-authored, wave-bound)",
	),
);

export const campaignCommand = Command.make("campaign").pipe(
	Command.withSubcommands([verifyTrace]),
	Command.withDescription(
		"Campaign gate tooling — the fail-closed founder-approval-trace verifier (#2658)",
	),
	Command.provide(GithubLive),
);
