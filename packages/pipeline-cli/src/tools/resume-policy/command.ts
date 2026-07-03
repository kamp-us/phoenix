/**
 * The `resume-policy` tool — `pipeline-cli resume-policy decide [flags]`.
 *
 *   pipeline-cli resume-policy decide \
 *     --reason "null subagent result" \
 *     --run-id run_abc --script-path .claude/workflows/drive-issue.js --prior-resumes 0
 *
 *   echo '{"reason":"…","resumeFromRunId":"run_abc","scriptPath":"…","priorResumes":1}' \
 *     | pipeline-cli resume-policy decide     # whole payload as JSON on stdin
 *
 * The capped, TRANSIENT-only auto-resume decision for a crashed dynamic Workflow (ADR
 * 0130, epic #1751, child #1759). Prints the action word (`resume` / `surface`) to
 * **stdout** and the deciding rationale to **stderr**, exiting 0 on any completed
 * decision — the action is the value, read it from stdout. On `resume`, the resume
 * arguments the driving session must pass — `{scriptPath, resumeFromRunId}` — and the
 * 1-based `attempt` are also printed to stderr.
 *
 * The IO lives here (the thin bin), the decision in `resume-policy.ts` (the pure core),
 * which composes #1758's `classify()` for the class and applies the K=2 per-run cap. So
 * "resume up to K then surface" is decided by pure, unit-tested code, and this bin only
 * marshals flags/stdin into it.
 */
import {readFileSync} from "node:fs";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import type {CrashSignal} from "../failure-classifier/failure-classifier.ts";
import {decideResume, type ResumeLedger} from "./resume-policy.ts";

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

const runIdFlag = Flag.string("run-id").pipe(
	Flag.optional,
	Flag.withDescription("the crashed run's id — the resumeFromRunId a resume would replay from"),
);

const scriptPathFlag = Flag.string("script-path").pipe(
	Flag.optional,
	Flag.withDescription("the workflow script to re-invoke on a resume (from the <recovery> block)"),
);

const priorResumesFlag = Flag.integer("prior-resumes").pipe(
	Flag.optional,
	Flag.withDescription("how many times THIS run has already been auto-resumed (0 on first crash)"),
);

/** The ledger fields a stdin payload may carry — each independently absent. */
interface PartialLedger {
	readonly resumeFromRunId?: string | undefined;
	readonly scriptPath?: string | undefined;
	readonly priorResumes?: number | undefined;
}

interface StdinPayload {
	readonly signal: CrashSignal;
	readonly ledger: PartialLedger;
}

/**
 * Read a crash signal + resume ledger from a stdin JSON object. The orchestrator can pipe
 * the whole crash payload in one shot; a non-JSON or empty stdin yields empties (the flags
 * then fill in, or the core default-denies), so this never throws.
 */
const readStdin = (): StdinPayload => {
	let raw = "";
	try {
		raw = readFileSync(0, "utf8");
	} catch {
		return {signal: {}, ledger: {}};
	}
	if (raw.trim() === "") return {signal: {}, ledger: {}};
	try {
		const p = JSON.parse(raw) as Record<string, unknown>;
		return {
			signal: {
				reason: typeof p.reason === "string" ? p.reason : undefined,
				errorKind: typeof p.errorKind === "string" ? p.errorKind : undefined,
				stage: typeof p.stage === "string" ? p.stage : undefined,
			},
			ledger: {
				resumeFromRunId: typeof p.resumeFromRunId === "string" ? p.resumeFromRunId : undefined,
				scriptPath: typeof p.scriptPath === "string" ? p.scriptPath : undefined,
				priorResumes: typeof p.priorResumes === "number" ? p.priorResumes : undefined,
			},
		};
	} catch {
		return {signal: {reason: raw}, ledger: {}};
	}
};

const decideCmd = Command.make(
	"decide",
	{
		reason: reasonFlag,
		errorKind: errorKindFlag,
		stage: stageFlag,
		runId: runIdFlag,
		scriptPath: scriptPathFlag,
		priorResumes: priorResumesFlag,
	},
	Effect.fn(function* ({reason, errorKind, stage, runId, scriptPath, priorResumes}) {
		const base = readStdin();
		const signal: CrashSignal = {
			reason: Option.getOrUndefined(reason) ?? base.signal.reason,
			errorKind: Option.getOrUndefined(errorKind) ?? base.signal.errorKind,
			stage: Option.getOrUndefined(stage) ?? base.signal.stage,
		};
		const ledger: ResumeLedger = {
			resumeFromRunId: Option.getOrUndefined(runId) ?? base.ledger.resumeFromRunId ?? "",
			scriptPath: Option.getOrUndefined(scriptPath) ?? base.ledger.scriptPath ?? "",
			priorResumes: Option.getOrUndefined(priorResumes) ?? base.ledger.priorResumes ?? 0,
		};

		const action = decideResume(signal, ledger);
		yield* Effect.sync(() => process.stderr.write(`resume-policy: ${action.rationale}\n`));
		if (action.action === "resume") {
			yield* Effect.sync(() =>
				process.stderr.write(
					`resume-policy: re-invoke {scriptPath: ${action.scriptPath}, resumeFromRunId: ${action.resumeFromRunId}} (attempt ${action.attempt})\n`,
				),
			);
		}
		yield* Console.log(action.action);
	}),
).pipe(
	Command.withDescription(
		"Decide resume vs surface for a crashed workflow: TRANSIENT + under the K=2 per-run cap → resume, else surface (ADR 0130; #1759)",
	),
);

export const resumePolicyCommand = Command.make("resume-policy").pipe(
	Command.withSubcommands([decideCmd]),
	Command.withDescription(
		"Capped TRANSIENT-only auto-resume for crashed dynamic workflows (ADR 0130, epic #1751)",
	),
);
