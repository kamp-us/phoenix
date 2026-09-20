/**
 * agy's on-disk `transcript.jsonl` line, and the total read of one line into it.
 *
 * **A different schema from the live stream, not a variant of it.** `wire.ts` decodes
 * `--output-format=stream-json`, whose lines are nested envelopes keyed by `event` and routed by
 * `step_type`. A transcript line is flat and routed by `source`/`type`, carries `created_at` where
 * the stream carries nothing, and pairs a call with its result across two lines where the stream
 * puts both on one. Sharing a decoder between them would mean one type whose fields are half absent
 * on each side; sharing the *projection* is what `items.ts` is for.
 *
 * Everything below is a census of the two files agy v1.1.27 wrote for one 7,671-line conversation
 * under `$HOME/.gemini/antigravity-cli/brain/<cid>/.system_generated/logs/`, taken at the pin:
 *
 * - **Five keys are on every line** — `step_index`, `source`, `type`, `status`, `created_at` — and
 *   four are conditional: `content` (4,125), `tool_calls` (3,534), `thinking` (911),
 *   `truncated_fields` (1,085).
 * - **Six `source`/`type` combinations were observed**, and the file format carries no version
 *   field of any kind, so the set is open exactly as `step_type` is: `USER_EXPLICIT`/`USER_INPUT`,
 *   `MODEL`/`PLANNER_RESPONSE`, `MODEL`/`GENERIC`, `SYSTEM`/`SYSTEM_MESSAGE`, `SYSTEM`/`CHECKPOINT`
 *   and `SYSTEM`/`ERROR_MESSAGE`. Three of those six are absent from the epic's own written spec,
 *   which is the whole argument for typing all three fields open.
 * - **`status` is `DONE` or `RUNNING`** at this pin — no `ERROR` was observed, and it is read open
 *   for the same reason.
 * - **`tool_calls[]` carries `name` and `args` only** — never an output. A call's result is the
 *   *next* line, a `MODEL`/`GENERIC`; see `transcript.ts`.
 * - **`truncated_fields` is an array of field names**, `["content"]`, `["tool_calls"]`,
 *   `["thinking"]` or a combination, naming which fields on this line were clipped and must be read
 *   from `transcript_full.jsonl` instead.
 *
 * Nothing here throws on any input: a line that cannot be read is a value, because the file is a
 * live append-only log whose last line may be half-written.
 */

import {Predicate} from "effect";
import {isJsonValue, type JsonValue} from "../../ai-agent/ports/index.ts";

/** One tool invocation. `args` is double-encoded in the wild — each value is itself JSON text. */
export interface AgyToolCall {
	readonly name: string;
	readonly args: JsonValue;
}

export interface AgyTranscriptLine {
	readonly step_index: number;
	/** `USER_EXPLICIT | MODEL | SYSTEM` at v1.1.27, open by ruling — see the module note. */
	readonly source: string;
	/** `USER_INPUT | PLANNER_RESPONSE | GENERIC | SYSTEM_MESSAGE | CHECKPOINT | ERROR_MESSAGE`. */
	readonly type: string;
	/** `DONE | RUNNING` at v1.1.27; a `GENERIC` line reads `RUNNING` while its tool is in flight. */
	readonly status: string;
	/** RFC 3339, UTC. Unparseable reads as the epoch rather than failing the line. */
	readonly created_at: string;
	readonly content?: string;
	readonly thinking?: string;
	readonly tool_calls?: ReadonlyArray<AgyToolCall>;
	readonly truncated_fields?: ReadonlyArray<string>;
}

/**
 * One line, read. `blank` is a separator; `unreadable` is a line no reader can use — a half-written
 * trailing record, which is what an append-only log looks like while agy is still writing to it.
 */
export type AgyTranscriptRead =
	| {readonly kind: "line"; readonly line: AgyTranscriptLine}
	| {readonly kind: "blank"}
	| {readonly kind: "unreadable"; readonly reason: string};

type Fields = {readonly [key: string]: unknown};

const fields = (value: unknown): Fields | undefined =>
	Predicate.isObject(value) && !Array.isArray(value) ? (value as Fields) : undefined;

const text = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

const texts = (value: unknown): ReadonlyArray<string> | undefined =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string")
		? (value as ReadonlyArray<string>)
		: undefined;

/** Present-or-absent, never `undefined`-valued: the tree is checked under `exactOptionalPropertyTypes`. */
const optional = <K extends string, T>(key: K, value: T | undefined): {[P in K]?: T} =>
	(value === undefined ? {} : {[key]: value}) as {[P in K]?: T};

const readToolCalls = (value: unknown): ReadonlyArray<AgyToolCall> | undefined => {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap((entry) => {
		const source = fields(entry);
		if (source === undefined) return [];
		const name = text(source.name);
		if (name === undefined) return [];
		return [{name, args: isJsonValue(source.args) ? source.args : null}];
	});
};

/**
 * `step_index`, `source` and `type` route the line and are required; `status` and `created_at` are
 * defaulted despite being universal at this pin, because a line refused for a field that only
 * *labels* it is history the operator loses over a cosmetic change.
 */
export const decodeTranscriptLine = (raw: string): AgyTranscriptRead => {
	if (raw.trim().length === 0) return {kind: "blank"};
	let parsed: unknown;
	// biome-ignore lint/plugin: this reader is pure and total by contract — it hands the caller a value, never an Effect — and `JSON.parse` is the one primitive here that throws, a failure `AgyTranscriptRead`'s `unreadable` arm already models.
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {kind: "unreadable", reason: "not JSON"};
	}
	const source = fields(parsed);
	if (source === undefined) return {kind: "unreadable", reason: "not a JSON object"};
	const stepIndex = source.step_index;
	const origin = text(source.source);
	const type = text(source.type);
	if (typeof stepIndex !== "number" || !Number.isFinite(stepIndex))
		return {kind: "unreadable", reason: "no step_index"};
	if (origin === undefined || type === undefined)
		return {kind: "unreadable", reason: "no source or type"};
	return {
		kind: "line",
		line: {
			step_index: stepIndex,
			source: origin,
			type,
			status: text(source.status) ?? "",
			created_at: text(source.created_at) ?? "",
			...optional("content", text(source.content)),
			...optional("thinking", text(source.thinking)),
			...optional("tool_calls", readToolCalls(source.tool_calls)),
			...optional("truncated_fields", texts(source.truncated_fields)),
		},
	};
};
