/**
 * The `session.transcript` spell: one page of one session's history, read without opening it.
 *
 * It is declared on the session-list row beside `session.list` (`./session-list.ts`) because it
 * answers the question that list's rows raise — an operator picks a row and the surface has to show
 * the session behind it — and because both are on-demand reads of a backend's store rather than
 * state the kernel holds and republishes (ADR 0348 R1.3).
 *
 * **It is bounded the same way and for the same reason.** Nothing on the spell path carries a
 * timeout, so a read that walks a store on an unreachable mount would be a call the page waits on
 * forever. The overrun becomes `SessionTranscriptTimedOut`, which the executor turns into a
 * `SpellReplyError` a window can render.
 *
 * **It opens no process.** The read builds the backend's layer inside its own Scope
 * (`./transcripts.ts`), so `Processes`, `ProcessTable` and `Checkpoints` are untouched: reading a
 * session is read-only until the operator sends (epic #8070, ruling 2). Creating the live process
 * is the first send's act, and it happens through the picker's ordinary open with a session on it
 * (`../shell/picker/intent.ts`).
 */

import {Context, Effect, Schema} from "effect";
import {defineSpell} from "../commands/spell.ts";
import {
	SESSION_TRANSCRIPT_PATH,
	SessionTranscript,
	SessionTranscriptRequest,
} from "../protocol/session-transcript.ts";
import {ProgramId} from "../registry/program.ts";
import type {Registry} from "../registry/Registry.ts";
import type {PageError, StartError} from "./service/index.ts";
import {
	type BackendTranscript,
	type BackendUnknown,
	readAiAgentTranscript,
	type TranscriptRequest,
} from "./transcripts.ts";

/** Why one transcript read could not answer: the three refusals `readAiAgentTranscript` raises. */
export type TranscriptRefusal = BackendUnknown | StartError | PageError;

/**
 * One session's history over the kernel's own context. A service for the same reason
 * `AiAgentSessionList` is one: the read builds a backend's layer under the context a spawn of that
 * row would run under, and `AnySpell` erases a spell's requirements, so the obligation is spent at
 * the composition root (`src/boot.ts`) rather than named here.
 */
export class AiAgentTranscripts extends Context.Service<
	AiAgentTranscripts,
	{
		readonly read: (
			request: TranscriptRequest,
		) => Effect.Effect<BackendTranscript, TranscriptRefusal>;
	}
>()("tuval/AiAgentTranscripts") {}

export const aiAgentTranscriptsKernel = (
	services: Context.Context<Registry>,
): AiAgentTranscripts["Service"] => ({
	read: (request) => readAiAgentTranscript(services, request).pipe(Effect.provideContext(services)),
});

/** How long one page read may take before the call answers with a refusal instead of waiting. */
export const SESSION_TRANSCRIPT_DEADLINE_MILLIS = 10_000;

export class SessionTranscriptTimedOut extends Schema.TaggedError<SessionTranscriptTimedOut>()(
	"tuval/SessionTranscriptTimedOut",
	{millis: Schema.Number},
) {
	override get message(): string {
		return `the session transcript did not answer within ${this.millis}ms`;
	}
}

export interface SessionTranscriptSpellOptions {
	/** Hard bound on one page read, in milliseconds. A parameter so a test can move it. */
	readonly deadlineMillis?: number;
}

export const sessionTranscriptSpell = ({
	deadlineMillis = SESSION_TRANSCRIPT_DEADLINE_MILLIS,
}: SessionTranscriptSpellOptions = {}) =>
	defineSpell({
		path: [...SESSION_TRANSCRIPT_PATH],
		describe: "Read one page of a session's transcript without opening the session.",
		params: SessionTranscriptRequest,
		result: SessionTranscript,
		execute: Effect.fn("Tuval.sessionTranscript")(function* (args) {
			const transcripts = yield* AiAgentTranscripts;
			const page = yield* transcripts
				.read({
					programId: ProgramId.make(args.programId),
					sessionId: args.sessionId,
					cwd: args.cwd,
					before: args.before,
					limit: args.limit,
				})
				.pipe(
					// A deadline that fires interrupts the read, so the caller reads it as the timeout it
					// is rather than waiting the store walk out (`Effect.timeout`, `effect/Effect`).
					Effect.timeout(deadlineMillis),
					Effect.catchTag(
						"TimeoutError",
						() => new SessionTranscriptTimedOut({millis: deadlineMillis}),
					),
				);
			return {items: page.items, next: page.next};
		}),
		capabilities: [{family: "filesystem", detail: "one registered backend's session store"}],
	});
