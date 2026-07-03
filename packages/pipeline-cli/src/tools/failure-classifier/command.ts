/**
 * The `failure-classifier` tool — `pipeline-cli failure-classifier classify [flags]`.
 *
 *   pipeline-cli failure-classifier classify --reason "null subagent result"
 *   pipeline-cli failure-classifier classify --reason "TypeError: …" --stage review-code
 *   pipeline-cli failure-classifier classify --error-kind process_exit
 *   echo '{"reason":"…","stage":"…"}' | pipeline-cli failure-classifier classify   # JSON on stdin
 *
 * The pure, default-deny crash classifier (epic #1751, child #1758). Prints the class
 * word (`transient` / `logic`) to **stdout** and the deciding rationale to **stderr**,
 * exiting 0 on any completed classification — the class is the value, read it from stdout.
 * This tool only *builds* the verdict; wiring it to an ACTUAL resume + the K=2 cap is
 * sibling #1759. It ships correct, tested, and dormant.
 *
 * The IO lives here (the thin bin), the decision in `failure-classifier.ts` (the pure
 * core): flags/stdin are read into a `CrashSignal`, `classify` decides. Default-deny by
 * construction: any input the core does not positively recognize as TRANSIENT yields
 * `logic`, so a classifier miss can only ever over-surface, never over-resume.
 */
import {readFileSync} from "node:fs";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {type CrashSignal, classify} from "./failure-classifier.ts";

const reasonFlag = Flag.string("reason").pipe(
	Flag.optional,
	Flag.withDescription("the crash reason / error message text (the primary discriminator)"),
);

const errorKindFlag = Flag.string("error-kind").pipe(
	Flag.optional,
	Flag.withDescription("a structured error kind if resolved (e.g. TypeError, process_exit)"),
);

const stageFlag = Flag.string("stage").pipe(
	Flag.optional,
	Flag.withDescription("the failed stage name (diagnostic; carried into the rationale)"),
);

/**
 * Read a `CrashSignal` from stdin when it is a JSON object with any of the known fields —
 * the orchestrator can pipe the whole crash payload in one shot. A non-JSON or empty stdin
 * yields an empty signal (the core then default-denies), so this never throws.
 */
const readStdinSignal = (): CrashSignal => {
	let raw = "";
	try {
		raw = readFileSync(0, "utf8");
	} catch {
		return {};
	}
	if (raw.trim() === "") return {};
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return {
			reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
			errorKind: typeof parsed.errorKind === "string" ? parsed.errorKind : undefined,
			stage: typeof parsed.stage === "string" ? parsed.stage : undefined,
		};
	} catch {
		// Non-JSON stdin: treat the whole blob as the reason text.
		return {reason: raw};
	}
};

const classifyCmd = Command.make(
	"classify",
	{reason: reasonFlag, errorKind: errorKindFlag, stage: stageFlag},
	Effect.fn(function* ({reason, errorKind, stage}) {
		// Flags win when present; otherwise fall back to a stdin JSON/text signal.
		const anyFlag = Option.isSome(reason) || Option.isSome(errorKind) || Option.isSome(stage);
		const base: CrashSignal = anyFlag ? {} : readStdinSignal();
		const signal: CrashSignal = {
			reason: Option.getOrUndefined(reason) ?? base.reason,
			errorKind: Option.getOrUndefined(errorKind) ?? base.errorKind,
			stage: Option.getOrUndefined(stage) ?? base.stage,
		};
		const verdict = classify(signal);
		yield* Effect.sync(() => process.stderr.write(`failure-classifier: ${verdict.rationale}\n`));
		yield* Console.log(verdict.class);
	}),
).pipe(
	Command.withDescription(
		"Classify a crashed Workflow's failure signal as transient / logic (default-deny to logic; #1758)",
	),
);

export const failureClassifierCommand = Command.make("failure-classifier").pipe(
	Command.withSubcommands([classifyCmd]),
	Command.withDescription(
		"Pure default-deny crash classifier: TRANSIENT vs LOGIC for crashed dynamic workflows (epic #1751)",
	),
);
