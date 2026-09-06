/**
 * One page of a session's transcript as it crosses to the page, read without opening the session.
 *
 * It lives here for the same reason `./session-list.ts` does: both ends decode it, and the protocol
 * module is the one place neither side owns. The item union is `TranscriptItem`
 * (`../ai-agent/ports/transcript-item.ts`) written as a schema — the ports slice states that union
 * as types plus predicates, which is what `../ports/` routes on, and a spell result needs a codec.
 * The two are held together by `session-transcript.unit.test.ts`, which decodes the very items the
 * ports slice's predicate admits.
 *
 * `next` is the cursor for the page older than this one, or `null` at the beginning of history —
 * the same grammar `transcript-page`'s payload carries, so a caller that pages here and a window
 * that pages over the live port ask for older history the one way.
 */

import {Schema} from "effect";
import type {JsonValue} from "../ai-agent/ports/transcript-item.ts";

/** The spell's address on the session-list program row: `session.transcript`. */
export const SESSION_TRANSCRIPT_PATH = ["session", "transcript"] as const;

/** A tool's input, as `TranscriptItem` declares it: plain JSON and never a backend's own type. */
export const Json: Schema.Codec<JsonValue, JsonValue> = Schema.suspend(() =>
	Schema.Union([
		Schema.Null,
		Schema.Boolean,
		Schema.Number,
		Schema.String,
		Schema.Array(Json),
		Schema.Record(Schema.String, Json),
	]),
) as Schema.Codec<JsonValue, JsonValue>;

const ItemId = Schema.String;
const Timestamp = Schema.Number;

export const UserItem = Schema.Struct({
	kind: Schema.Literal("user"),
	id: ItemId,
	timestamp: Timestamp,
	text: Schema.String,
	local: Schema.optionalKey(Schema.Boolean),
});

export const AssistantItem = Schema.Struct({
	kind: Schema.Literal("assistant"),
	id: ItemId,
	timestamp: Timestamp,
	text: Schema.String,
	interrupted: Schema.optionalKey(Schema.Boolean),
});

export const ToolItem = Schema.Struct({
	kind: Schema.Literal("tool"),
	id: ItemId,
	timestamp: Timestamp,
	name: Schema.String,
	input: Json,
	result: Schema.Struct({
		text: Schema.String,
		omitted: Schema.Struct({bytes: Schema.Number}),
	}),
	status: Schema.Literals(["running", "ok", "error"]),
	parentId: Schema.optionalKey(ItemId),
});

export const SystemItem = Schema.Struct({
	kind: Schema.Literal("system"),
	id: ItemId,
	timestamp: Timestamp,
	text: Schema.String,
});

export const TranscriptItem = Schema.Union([UserItem, AssistantItem, ToolItem, SystemItem]);
export type TranscriptItemWire = typeof TranscriptItem.Type;

/**
 * Which session to read and how far back. `backend` is the registered program row's id rather than
 * the row's label, and `cwd` is the folder the store filed the session under: the pair is what a
 * backend needs to find a session it did not open in this desk (epic #8070, ruling 3).
 */
export const SessionTranscriptRequest = Schema.Struct({
	backend: Schema.String,
	sessionId: Schema.String,
	cwd: Schema.String,
	/** The oldest item the caller already holds, or `null` for the newest end of the transcript. */
	before: Schema.NullOr(Schema.String),
	limit: Schema.Number,
});
export type SessionTranscriptRequest = typeof SessionTranscriptRequest.Type;

export const SessionTranscript = Schema.Struct({
	/** Oldest first, exactly as `TuvalAiAgent.page` answers. */
	items: Schema.Array(TranscriptItem),
	/** The cursor for the page older than this one, or `null` at the beginning of history. */
	next: Schema.NullOr(Schema.String),
});
export type SessionTranscript = typeof SessionTranscript.Type;
