/**
 * Read one page of a session's transcript without opening a process on it — the read half of epic
 * #8070's ruling 2, "read-only until send".
 *
 * It sits beside `./backends.ts` rather than inside it because the two answer different questions
 * of the same set: that module asks every registered backend one thing, this one asks a single
 * named backend for one session. What they share is the mechanism, and it is the load-bearing part
 * here: the layer is built and torn down inside this call's own Scope, so nothing on this path
 * reaches `Processes`, `ProcessTable` or `Checkpoints`. Opening a session to read it leaves no
 * process behind and no restore state to bring one back, which is what
 * `transcripts.unit.test.ts` asserts directly.
 *
 * The one call it makes is `sessionTranscript`, the store-level read (founder ruling, 2026-09-07,
 * https://github.com/kamp-us/phoenix/issues/8233#issuecomment-5567691729). It opens no backend
 * session: nothing attaches, nothing resumes, and none of the replay a resume would fold is built
 * for a page this call would discard. A session the store has since lost comes back as
 * `TranscriptError({reason: "session-not-found"})`, which is why a lost session cannot render as an
 * empty transcript.
 */

import {Context, Effect, Layer, Schema} from "effect";
import type {ProgramId} from "../registry/program.ts";
import type {Registry} from "../registry/Registry.ts";
import {type AiAgentBackendRow, readAiAgentBackends} from "./backends.ts";
import type {TranscriptItem} from "./ports/index.ts";
import {type TranscriptError, TuvalAiAgent} from "./service/index.ts";

/** The request named a program row that is not a registered AI agent backend on this desk. */
export class BackendUnknown extends Schema.TaggedError<BackendUnknown>()(
	"tuval/ai-agent/BackendUnknown",
	{programId: Schema.String, registered: Schema.Array(Schema.String)},
) {
	override get message(): string {
		return `no registered AI agent backend has the program id "${this.programId}"; registered: ${
			this.registered.join(", ") || "none"
		}`;
	}
}

/**
 * Which session to read from which registered backend, and how far back to read. The backend is
 * named by its registered program row id and never by the row's backend tag: the tag is a display
 * label (`claude`, `pi`) that no lookup here would find (epic #8070).
 */
export interface TranscriptRequest {
	readonly programId: ProgramId;
	readonly sessionId: string;
	readonly cwd: string;
	/** The oldest item the caller already holds, or `null` for the newest end of the transcript. */
	readonly before: string | null;
	readonly limit: number;
}

/** One page of a session's history, oldest first, with the cursor for the page older than it. */
export interface BackendTranscript {
	readonly items: ReadonlyArray<TranscriptItem>;
	/** The cursor for the page older than this one, or `null` at the beginning of history. */
	readonly next: string | null;
}

const readFrom = (
	row: AiAgentBackendRow,
	request: TranscriptRequest,
): Effect.Effect<BackendTranscript, TranscriptError, never> =>
	Effect.scoped(
		Effect.gen(function* () {
			const built = yield* Layer.build(row.aiAgent.layer as Layer.Layer<TuvalAiAgent>);
			const agent = Context.get(built, TuvalAiAgent);
			const page = yield* agent.sessionTranscript({
				sessionId: request.sessionId,
				cwd: request.cwd,
				before: request.before,
				limit: request.limit,
			});
			// The port answers `hasMore`; the cursor it implies is this page's oldest item, which is
			// what a caller hands back as `before` to walk one page further into history.
			return {items: page.items, next: page.hasMore ? (page.items[0]?.id ?? null) : null};
		}),
	);

export const readAiAgentTranscript = (
	services: Context.Context<never>,
	request: TranscriptRequest,
): Effect.Effect<BackendTranscript, BackendUnknown | TranscriptError, Registry> =>
	Effect.gen(function* () {
		const rows = yield* readAiAgentBackends;
		const row = rows.find((candidate) => candidate.id === request.programId);
		return row === undefined
			? yield* new BackendUnknown({
					programId: request.programId,
					registered: rows.map((candidate) => candidate.id as string),
				})
			: yield* readFrom(row, request).pipe(Effect.provideContext(services));
	});
