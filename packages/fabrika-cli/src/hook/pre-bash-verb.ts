/**
 * `hook pre-bash` — the one fabrika hook that decides something.
 *
 * It refuses a Bash command that opens with a directory jump out of the linked worktree it was
 * issued in. The decision itself is `./leading-jump.ts`, which is IO-free and carries the why; this
 * file is the envelope routing and the working-tree probe around it.
 *
 * Three properties are load-bearing and none of them is a style choice:
 *
 * - **The verdict travels as JSON on stdout, never as an exit code.** `2` is the harness's one
 *   blocking `PreToolUse` code and fabrika allocates it nowhere (`./harness-exit.ts`), so a deny
 *   rides `permissionDecision` at exit 0 and every refusal below exits non-blocking.
 * - **It arms only inside a linked worktree.** The primary checkout has nothing to escape from, and
 *   fabrika holds no opinion on which tree an operator works in — isolation is their call, made at
 *   spawn time. What is judged is leaving an isolated tree, not standing in one.
 * - **A ground it cannot establish fails open and loud.** An unprobeable cwd is a state in which
 *   nothing was judged, and a guard that never judged may not deny (`hook-surface.md`, *The
 *   dispatch-failure policy point*) — so it seats {@link GROUND_UNKNOWN}, whose stderr the user sees
 *   while the command proceeds.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {StdinRead} from "../io/stdin.ts";
import {deriveRepoRoot} from "../lane/ground.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	EMPTY_STDIN,
	ENVELOPE_UNKNOWN,
	GROUND_UNKNOWN,
	MALFORMED_ENVELOPE,
	WRONG_EVENT,
} from "./codes.ts";
import {classifyEnvelope, type Envelope, type EnvelopeRead} from "./envelope.ts";
import {type Decision, decideJump} from "./leading-jump.ts";

const VERB = "fabrika hook pre-bash";

/** The event and tool this verb judges. Anything else is a mis-wired declaration, not a payload bug. */
const EVENT = "PreToolUse";
const TOOL = "Bash";

export interface PreBashOptions {
	readonly stdin: Effect.Effect<StdinRead>;
	readonly env: Record<string, string | undefined>;
}

type Requirements = FileSystem.FileSystem | Path.Path;

const readEnvelope = (piped: StdinRead): EnvelopeRead =>
	piped._tag === "Text" ? classifyEnvelope(piped.text) : {_tag: "Unknown", reason: piped.reason};

/** The Bash command this envelope carries, or nothing — a payload with no command is not judgeable. */
const commandOf = (envelope: Envelope): string | undefined => {
	const input = envelope.payload.tool_input;
	if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
	const command = (input as Record<string, unknown>).command;
	return typeof command === "string" ? command : undefined;
};

/**
 * The harness reads `hookSpecificOutput.permissionDecision`, and reads it only when it is there.
 *
 * An allow therefore carries **no** decision field: `"allow"` is not "I have no objection" to the
 * harness — it bypasses the permission system the operator configured, which is a far larger claim
 * than this guard makes. So the allow answer is a fabrika-namespaced token the harness ignores,
 * which still satisfies the convention's positive-answer rule.
 */
const stdoutFor = (decision: Decision): string =>
	decision._tag === "Deny"
		? `${JSON.stringify({
				hookSpecificOutput: {
					hookEventName: EVENT,
					permissionDecision: "deny",
					permissionDecisionReason: decision.reason,
				},
			})}\n`
		: `${JSON.stringify({
				suppressOutput: true,
				fabrika: {verb: "hook pre-bash", outcome: "allow", because: decision.because},
			})}\n`;

const judge = (
	envelope: Envelope,
	command: string,
	env: Record<string, string | undefined>,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const ground = yield* deriveRepoRoot(envelope.cwd);
		if (ground._tag === "Unestablished") {
			return refuse(
				GROUND_UNKNOWN,
				`${VERB}: cannot establish which working tree ${envelope.cwd} belongs to: ${ground.reason} — the jump was NOT judged, and the command proceeds unguarded.`,
			);
		}
		if (ground._tag === "NotARepo") {
			return answer(stdoutFor({_tag: "Allow", because: `${envelope.cwd} is under no repository`}), [
				`${VERB}: ${envelope.cwd} is under no working tree — nothing to escape from.`,
			]);
		}
		if (ground.workingTree === ground.repoRoot) {
			return answer(
				stdoutFor({_tag: "Allow", because: `${ground.workingTree} is the primary checkout`}),
				[`${VERB}: ${ground.workingTree} is the primary checkout, not a linked worktree.`],
			);
		}

		const decision = decideJump({
			command,
			cwd: envelope.cwd,
			workingTree: ground.workingTree,
			home: env.HOME,
		});
		const scope = `${VERB}: judged the leading jump of \`${command}\` against ${ground.workingTree}`;
		return answer(stdoutFor(decision), [
			scope,
			decision._tag === "Deny"
				? `${VERB}: deny — ${decision.reason}`
				: `${VERB}: allow — ${decision.because}`,
		]);
	});

export const runPreBash = ({
	stdin,
	env,
}: PreBashOptions): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const piped = yield* stdin;
		const read = readEnvelope(piped);

		if (read._tag === "Empty") {
			return refuse(EMPTY_STDIN, `${VERB}: stdin was read and held nothing`);
		}
		if (read._tag === "Unknown") {
			return refuse(ENVELOPE_UNKNOWN, `${VERB}: envelope UNKNOWN — ${read.reason}`);
		}
		if (read._tag === "Malformed") {
			return refuse(MALFORMED_ENVELOPE, `${VERB}: not a hook envelope — ${read.reason}`, [
				`${VERB}: ${read.evidence}`,
			]);
		}

		const envelope = read.envelope;
		if (envelope.event !== EVENT) {
			return refuse(
				WRONG_EVENT,
				`${VERB}: judges ${EVENT}/${TOOL} and the envelope carries ${envelope.event} — the declaration is wired to an event this verb does not judge.`,
			);
		}
		const command = commandOf(envelope);
		if (command === undefined) {
			return refuse(
				WRONG_EVENT,
				`${VERB}: the ${EVENT} envelope carries no \`tool_input.command\` string, so no ${TOOL} command was judged — the declaration's matcher reached a tool this verb does not judge.`,
			);
		}
		return yield* judge(envelope, command, env);
	});
