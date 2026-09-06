/**
 * The session-list reply as it crosses to the page: the unioned rows, and the backends that could
 * not be read.
 *
 * It lives here rather than beside the spell because both ends decode it — the kernel encodes a
 * reply through this schema and the page reads one back out of it — and the protocol module is the
 * one place neither side owns. Nothing here reaches a backend: a row is `SessionSummary`
 * (`../ai-agent/service/sessions.ts`) written as a schema, so neither store's own session type has
 * a way onto the wire.
 *
 * `unreadable` is a list beside `sessions` and never in place of it. A backend whose store refuses
 * the read is named here while every other backend's rows still arrive, so a window can say "Pi
 * could not be read" instead of showing a blank list that reads as "you have no sessions".
 */

import {Schema} from "effect";

/** The spell's address on the session-list program row: `session.list`. */
export const SESSION_LIST_PATH = ["session", "list"] as const;

/**
 * The row that spell is registered on. Spelled here rather than imported, so a page addressing the
 * call does not pull the kernel-side row in behind it — the transport's page-side client spells the
 * shell's program id for the same reason. `../ai-agent/session-list.ts` declares this id itself and
 * its unit test holds the two spellings together.
 */
export const SESSION_LIST_PROGRAM = "ai-agent-sessions";

/**
 * The whole address a caller sends. The registry keys a row's spell under `[programId, ...path]`
 * (`../commands/registry.ts`), so a call carrying the bare `session.list` reaches no spell.
 */
export const SESSION_LIST_CALL_PATH = [SESSION_LIST_PROGRAM, ...SESSION_LIST_PATH] as const;

/**
 * One session. The four optional fields are optional because a real store leaves them out, and an
 * absent key stays absent across the wire — a row renders an absence as an absence rather than as a
 * plausible-looking zero or empty string.
 */
export const SessionRow = Schema.Struct({
	sessionId: Schema.String,
	/** Milliseconds since the epoch, so the union sorts without parsing anything. */
	lastModified: Schema.Number,
	/**
	 * The registered program row's id — the routing key. A transcript read resolves the backend by
	 * it (`../ai-agent/transcripts.ts`) and a first send spawns it (`../ai-agent/window/opening.ts`),
	 * so it is the row's identity and never its copy.
	 */
	programId: Schema.String,
	/**
	 * The backend tag ruling 6 puts on the row's meta line — `claude`, `pi` — and nothing to route
	 * on. It is the implementation's own label, not the id it is registered under, and the two are
	 * different strings.
	 */
	backend: Schema.String,
	firstPrompt: Schema.optionalKey(Schema.String),
	folder: Schema.optionalKey(Schema.String),
	branch: Schema.optionalKey(Schema.String),
	messageCount: Schema.optionalKey(Schema.Number),
});
export type SessionRow = typeof SessionRow.Type;

/** One backend that could not answer, named so a surface can say which store is missing. */
export const UnreadableBackend = Schema.Struct({
	programId: Schema.String,
	/** `package/program@version (digest)` — the row's own provenance, as a refusal names it. */
	provenance: Schema.String,
	/** Why it could not answer, already rendered: a `Cause` is not something the wire can hold. */
	detail: Schema.String,
});
export type UnreadableBackend = typeof UnreadableBackend.Type;

export const SessionList = Schema.Struct({
	/** Every answering backend's sessions as one list, newest first, with no origin split. */
	sessions: Schema.Array(SessionRow),
	unreadable: Schema.Array(UnreadableBackend),
});
export type SessionList = typeof SessionList.Type;
