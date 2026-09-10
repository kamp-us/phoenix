import {Effect, Schema} from "effect";
import type {TranscriptItem} from "../ai-agent/ports/index.ts";
import type {TransportError} from "../ai-agent/service/index.ts";
import {historyItem} from "./history.ts";
import {ReadThread} from "./protocol.ts";
import type {CodexConnection} from "./transport.ts";

export class ChildTranscriptError extends Schema.TaggedError<ChildTranscriptError>()(
	"CodexChildTranscriptError",
	{
		reason: Schema.Literals(["unsupported", "missing", "unreadable", "malformed"]),
		detail: Schema.String,
	},
) {}

const ChildMetadata = Schema.Struct({
	id: Schema.String,
	historyMode: Schema.Literals(["legacy", "paginated"]),
	source: Schema.Struct({
		subagent: Schema.Struct({thread_spawn: Schema.Struct({parent_thread_id: Schema.String})}),
	}),
	status: Schema.Union([
		Schema.Struct({type: Schema.Literals(["notLoaded", "idle", "systemError"])}),
		Schema.Struct({type: Schema.Literal("active"), activeFlags: Schema.Array(Schema.String)}),
	]),
	agentRole: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export interface ChildTranscript {
	readonly items: ReadonlyArray<TranscriptItem>;
	readonly type: string;
	readonly status: "running" | "finished";
	readonly turnId: string | null;
}
const malformed = (detail: unknown) =>
	new ChildTranscriptError({reason: "malformed", detail: String(detail)});
// thread_processor.rs at rust-v0.153.4: read_thread_view and unsupported_thread_store_operation.
const readFailure = (id: string, error: TransportError) =>
	new ChildTranscriptError({
		reason:
			error.detail === `thread not loaded: ${id}` || error.detail === `thread not found: ${id}`
				? "missing"
				: error.detail.endsWith(" is not supported yet") ||
						error.detail === "ephemeral threads do not support includeTurns"
					? "unsupported"
					: "unreadable",
		detail: error.detail,
	});

/** A read-only app-server request: it neither loads the child nor attaches a tool server. */
export const readChildTranscript = Effect.fn("Codex.readChildTranscript")(function* (
	connection: CodexConnection,
	parent: string,
	id: string,
) {
	const raw = yield* connection
		.request("thread/read", {threadId: id, includeTurns: true})
		.pipe(Effect.mapError((error) => readFailure(id, error)));
	return yield* Effect.try({
		try: (): ChildTranscript => {
			const {thread} = Schema.decodeUnknownSync(ReadThread)(raw);
			const metadata = Schema.decodeUnknownSync(Schema.Struct({thread: ChildMetadata}))(raw).thread;
			if (thread.id !== id || metadata.source.subagent.thread_spawn.parent_thread_id !== parent)
				// biome-ignore lint/plugin: Effect.try immediately maps this correlation refusal to ChildTranscriptError.
				throw new Error("Codex returned a child from a different parent or thread");
			const items = new Map<string, TranscriptItem>();
			for (const turn of thread.turns) {
				for (const rawItem of turn.items) {
					const item = historyItem(
						rawItem,
						(turn.startedAt ?? thread.createdAt) * 1000,
						turn.status === "inProgress",
					);
					const previous = items.get(item.id);
					items.set(
						item.id,
						previous === undefined ? item : {...item, timestamp: previous.timestamp},
					);
				}
			}
			return {
				items: [...items.values()],
				// `||`, not `??`: an empty role is no role, and `""` reaching the slot makes the port
				// refuse it and sink the whole checkpoint (#8701).
				type: metadata.agentRole || "agent",
				status: metadata.status.type === "active" ? "running" : "finished",
				turnId: thread.turns.findLast((turn) => turn.status === "inProgress")?.id ?? null,
			};
		},
		catch: malformed,
	});
});
