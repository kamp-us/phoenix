/**
 * agy's `--output-format=stream-json` output, and the total read of one NDJSON line into it.
 *
 * Module-internal by construction: no type in this file appears on a public signature, which is
 * what keeps agy's protocol inside `src/agy/` the way Pi's stays inside `src/pi/`.
 *
 * Everything here is captured from **agy v1.1.27** (`agy --input-format=stream-json
 * --output-format=stream-json --print='' --sandbox --add-dir=<dir>`), and the stream carries no
 * protocol or schema version field of any kind — so nothing downstream can branch on a version,
 * and the two tolerances below are the only defence a later release leaves us:
 *
 * - **`step_type` is an open string, never a closed union.** Five values are observed at this pin —
 *   `user_input`, `agent_response`, `tool`, `subagent`, `system_message` — and two of those were
 *   found only after the first census. A sixth, `error_message`, was observed on a **later release,
 *   v1.2.0**, and is named here as a later-version reading rather than written back onto the five
 *   above: it rides the step agy emits when a reply was cut and the turn is about to retry, carries
 *   no `text_delta`, and `mapper.ts` now has an arm for it
 *   ([#8896](https://github.com/kamp-us/phoenix/issues/8896)). Six more (`thinking`, `plan`, `error`,
 *   `command`, `memory`, `checkpoint`) exist as strings in the binary and have never been emitted.
 *   `state` and `result.status` are typed open for the same reason — which is the tolerance that let
 *   the new value through without a decode change.
 * - **Only the fields that route a line are required.** Every other field is optional and
 *   defaulted, because a line refused for a key this pin has not seen is content the operator
 *   never gets. A default never aliases the unknown onto a real value a reader branches on, though:
 *   `result.num_turns` is `number | null` and not `0`, because `0` is a turn number the usage fold
 *   reads as a decision ([#8707](https://github.com/kamp-us/phoenix/issues/8707)).
 *
 * The envelope is nested and each payload is keyed by its own event name —
 * `{"event":"step_update","step_update":{…}}` — and `conversation_id` sits at the top level on
 * `init` but inside the payload on the other two.
 */

import {Predicate} from "effect";
import {isJsonValue, type JsonValue} from "../../ai-agent/ports/index.ts";

/**
 * The release every shape below was captured from. There is no version field on the wire.
 *
 * It stays at `1.1.27` deliberately. The v1.2.0 `error_message` reading above is one step type on one
 * machine, not a re-census, and moving this constant would restate the whole module's capture as a
 * v1.2.0 one — the laundering ADR 0362 rules out. It moves when the module is captured again.
 */
export const AGY_VERSION = "1.1.27";

/**
 * Token counts as v1.1.27 reports them. There is no cost field anywhere on the stream, and
 * `thinking_tokens` / `cache_read_tokens` have no port counterpart.
 */
export interface AgyUsage {
	readonly input_tokens: number;
	readonly output_tokens: number;
	readonly thinking_tokens: number;
	readonly cache_read_tokens: number;
	readonly total_tokens: number;
}

export interface AgyToolError {
	readonly type: string;
	readonly message: string;
}

/** A tool call and its outcome both ride here: `output` on `DONE`, `error` on `ERROR`. */
export interface AgyToolInfo {
	readonly name?: string;
	readonly parameters?: JsonValue;
	readonly output?: string;
	readonly error?: AgyToolError;
}

export interface AgySubagent {
	readonly type_name?: string;
	readonly role?: string;
	readonly initial_prompt?: string;
	readonly conversation_id?: string;
	readonly log_uri?: string;
	readonly workspace_uris?: ReadonlyArray<string>;
}

export interface AgySubagentInfo {
	readonly subagents: ReadonlyArray<AgySubagent>;
}

/** `model` is absent when the run took the CLI's own default rather than an explicit `--model`. */
export interface AgyInit {
	readonly model?: string;
	readonly cwd?: string;
	readonly tools?: ReadonlyArray<string>;
	readonly permission_mode?: string;
}

export interface AgyStepUpdate {
	readonly conversation_id: string;
	readonly step_index: number;
	/** `ACTIVE | DONE | ERROR` at v1.1.27, typed open for the reason `step_type` is. */
	readonly state: string;
	/** Open by ruling, never a union — see the module note. */
	readonly step_type: string;
	/** Incremental: the `DONE` step carries the last chunk, never the accumulation. */
	readonly text_delta?: string;
	readonly tool_name?: string;
	readonly tool_info?: AgyToolInfo;
	readonly subagent_info?: AgySubagentInfo;
	readonly duration_seconds?: number;
	readonly usage?: AgyUsage;
}

export interface AgyResult {
	readonly conversation_id: string;
	/** `SUCCESS | ERROR` at v1.1.27. Anything else reads as a failure — never as a success. */
	readonly status: string;
	/** The turn's whole reply. The step deltas are lossy against this; this one is authoritative. */
	readonly response: string;
	readonly error?: string;
	/**
	 * `null` when the line carried no `num_turns` — the unknown is kept distinct from the real value
	 * `0`, because the mapper reads the turn number to decide whether a cumulative contains turns
	 * this child never ran, and a missing field defaulted to a turn number picks that arm for it
	 * ([#8707](https://github.com/kamp-us/phoenix/issues/8707)).
	 */
	readonly num_turns: number | null;
	readonly usage?: AgyUsage;
	/** Element shape unmeasured at this pin, so it stays `JsonValue` and is rendered, not parsed. */
	readonly denied_actions?: ReadonlyArray<JsonValue>;
}

export type AgyEvent =
	| {readonly event: "init"; readonly conversation_id: string; readonly init: AgyInit}
	| {readonly event: "step_update"; readonly step_update: AgyStepUpdate}
	| {readonly event: "result"; readonly result: AgyResult};

/**
 * One line, read. `blank` is a separator and means nothing; `unreadable` is content the mapper
 * still has to show, because a line the reader cannot parse is not a line it may swallow.
 */
export type AgyLine =
	| {readonly kind: "event"; readonly event: AgyEvent}
	| {readonly kind: "blank"}
	| {readonly kind: "unreadable"; readonly raw: string; readonly reason: string};

type Fields = {readonly [key: string]: unknown};

const fields = (value: unknown): Fields | undefined =>
	Predicate.isObject(value) && !Array.isArray(value) ? (value as Fields) : undefined;

const text = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

const count = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const texts = (value: unknown): ReadonlyArray<string> | undefined =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string")
		? (value as ReadonlyArray<string>)
		: undefined;

const json = (value: unknown): JsonValue | undefined => (isJsonValue(value) ? value : undefined);

/** Present-or-absent, never `undefined`-valued: the tree is checked under `exactOptionalPropertyTypes`. */
const optional = <K extends string, T>(key: K, value: T | undefined): {[P in K]?: T} =>
	(value === undefined ? {} : {[key]: value}) as {[P in K]?: T};

const readUsage = (value: unknown): AgyUsage | undefined => {
	const source = fields(value);
	if (source === undefined) return undefined;
	return {
		input_tokens: count(source.input_tokens) ?? 0,
		output_tokens: count(source.output_tokens) ?? 0,
		thinking_tokens: count(source.thinking_tokens) ?? 0,
		cache_read_tokens: count(source.cache_read_tokens) ?? 0,
		total_tokens: count(source.total_tokens) ?? 0,
	};
};

const readToolError = (value: unknown): AgyToolError | undefined => {
	const source = fields(value);
	if (source === undefined) return undefined;
	return {type: text(source.type) ?? "", message: text(source.message) ?? ""};
};

const readToolInfo = (value: unknown): AgyToolInfo | undefined => {
	const source = fields(value);
	if (source === undefined) return undefined;
	return {
		...optional("name", text(source.name)),
		...optional("parameters", json(source.parameters)),
		...optional("output", text(source.output)),
		...optional("error", readToolError(source.error)),
	};
};

const readSubagent = (value: unknown): AgySubagent => {
	const source = fields(value) ?? {};
	return {
		...optional("type_name", text(source.type_name)),
		...optional("role", text(source.role)),
		...optional("initial_prompt", text(source.initial_prompt)),
		...optional("conversation_id", text(source.conversation_id)),
		...optional("log_uri", text(source.log_uri)),
		...optional("workspace_uris", texts(source.workspace_uris)),
	};
};

const readSubagentInfo = (value: unknown): AgySubagentInfo | undefined => {
	const source = fields(value);
	if (source === undefined) return undefined;
	const subagents = Array.isArray(source.subagents) ? source.subagents : [];
	return {subagents: subagents.map(readSubagent)};
};

const readInit = (value: unknown): AgyInit => {
	const source = fields(value) ?? {};
	return {
		...optional("model", text(source.model)),
		...optional("cwd", text(source.cwd)),
		...optional("tools", texts(source.tools)),
		...optional("permission_mode", text(source.permission_mode)),
	};
};

/** `conversation_id`, `step_index`, `state` and `step_type` route the line; nothing else does. */
const readStepUpdate = (value: unknown): AgyStepUpdate | undefined => {
	const source = fields(value);
	if (source === undefined) return undefined;
	const conversationId = text(source.conversation_id);
	const stepIndex = count(source.step_index);
	const state = text(source.state);
	const stepType = text(source.step_type);
	if (
		conversationId === undefined ||
		stepIndex === undefined ||
		state === undefined ||
		stepType === undefined
	)
		return undefined;
	return {
		conversation_id: conversationId,
		step_index: stepIndex,
		state,
		step_type: stepType,
		...optional("text_delta", text(source.text_delta)),
		...optional("tool_name", text(source.tool_name)),
		...optional("tool_info", readToolInfo(source.tool_info)),
		...optional("subagent_info", readSubagentInfo(source.subagent_info)),
		...optional("duration_seconds", count(source.duration_seconds)),
		...optional("usage", readUsage(source.usage)),
	};
};

const readResult = (value: unknown): AgyResult | undefined => {
	const source = fields(value);
	if (source === undefined) return undefined;
	const conversationId = text(source.conversation_id);
	const status = text(source.status);
	if (conversationId === undefined || status === undefined) return undefined;
	const denied = Array.isArray(source.denied_actions)
		? source.denied_actions.map((entry) => json(entry) ?? null)
		: undefined;
	return {
		conversation_id: conversationId,
		status,
		response: text(source.response) ?? "",
		num_turns: count(source.num_turns) ?? null,
		...optional("error", text(source.error)),
		...optional("usage", readUsage(source.usage)),
		...optional("denied_actions", denied),
	};
};

/** Total: every string is an `AgyLine`, and nothing here throws on any input. */
export const decodeLine = (line: string): AgyLine => {
	if (line.trim().length === 0) return {kind: "blank"};
	let parsed: unknown;
	// biome-ignore lint/plugin: this reader is pure and total by contract — it hands the mapper a value, never an Effect — and `JSON.parse` is the one primitive here that throws, a failure `AgyLine`'s `unreadable` arm already models.
	try {
		parsed = JSON.parse(line);
	} catch {
		return {kind: "unreadable", raw: line, reason: "not JSON"};
	}
	const source = fields(parsed);
	if (source === undefined) return {kind: "unreadable", raw: line, reason: "not a JSON object"};
	switch (source.event) {
		case "init": {
			const conversationId = text(source.conversation_id);
			if (conversationId === undefined)
				return {kind: "unreadable", raw: line, reason: "init carries no conversation_id"};
			return {
				kind: "event",
				event: {event: "init", conversation_id: conversationId, init: readInit(source.init)},
			};
		}
		case "step_update": {
			const step = readStepUpdate(source.step_update);
			return step === undefined
				? {kind: "unreadable", raw: line, reason: "step_update is missing a routing field"}
				: {kind: "event", event: {event: "step_update", step_update: step}};
		}
		case "result": {
			const result = readResult(source.result);
			return result === undefined
				? {kind: "unreadable", raw: line, reason: "result is missing a routing field"}
				: {kind: "event", event: {event: "result", result}};
		}
		default:
			return {
				kind: "unreadable",
				raw: line,
				reason: `unrecognised event ${JSON.stringify(source.event) ?? "<absent>"}`,
			};
	}
};
