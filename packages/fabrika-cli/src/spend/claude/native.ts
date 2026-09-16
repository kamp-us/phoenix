import {createHash} from "node:crypto";
import {Result, Schema} from "effect";
import {parseLaneBranch} from "../../build/lane.ts";
import type {Counter, Measurement, UsageRecord} from "../usage-record.ts";

const Id = Schema.String.check(Schema.isNonEmpty());
const optionalId = Schema.optional(Id);
export const Hook = Schema.Struct({
	session_id: Id,
	transcript_path: Id,
	cwd: Id,
	hook_event_name: Id,
	agent_id: Schema.optional(Id.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/))),
	agent_transcript_path: optionalId,
});
export const NativeRow = Schema.Struct({
	type: Id,
	sessionId: optionalId,
	agentId: optionalId,
	version: optionalId,
	uuid: optionalId,
	promptId: optionalId,
	gitBranch: optionalId,
	message: Schema.optional(
		Schema.Struct({
			id: optionalId,
			role: optionalId,
			model: optionalId,
			usage: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
			content: Schema.optional(
				Schema.Union([
					Schema.String,
					Schema.Array(
						Schema.Struct({
							type: Id,
							id: optionalId,
							name: optionalId,
						}),
					),
				]),
			),
		}),
	),
});
export const decodeJson = <A>(
	schema: Schema.ConstraintDecoder<A, never>,
	text: string,
): Result.Result<A, string> =>
	Result.try({try: (): unknown => JSON.parse(text), catch: () => "invalid JSON"}).pipe(
		Result.flatMap((value) =>
			Schema.decodeUnknownResult(schema)(value).pipe(Result.mapError(() => "invalid shape")),
		),
	);
export const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const sessionKey = (root: string, child: string | null) =>
	child === null ? root : `${root}/agent/${child}`;

export interface Binding {
	readonly root: string;
	readonly run: string;
	readonly repo: string | null;
	readonly branch: string | null;
	readonly provider: string | null;
}
export const common = (
	binding: Binding,
	child: string | null,
	parent: string | null,
	branch = binding.branch,
) => {
	const lane = branch === null ? null : parseLaneBranch(branch);
	return {
		v: 2 as const,
		source: {host: "claude", format: "claude-code-jsonl", version: "unknown"},
		work: {
			repo: binding.repo,
			issue: lane?._tag === "Create" ? lane.number : null,
			run: binding.run,
			attempt: `${binding.root}/${lane?.nonce ?? "interactive"}`,
		},
		agent: {
			session: sessionKey(binding.root, child),
			nativeSession: child ?? binding.root,
			rootSession: binding.root,
			parent:
				child === null
					? {kind: "root" as const}
					: parent === null
						? {kind: "unknown" as const}
						: {kind: "known" as const, session: parent},
		},
	};
};

const value = (raw: unknown): typeof Counter.Type.value =>
	raw === undefined
		? {state: "absent"}
		: typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
			? {state: "measured", tokens: raw}
			: {state: "unavailable"};
const cacheSchema = Schema.Struct({
	ephemeral_5m_input_tokens: Schema.optional(Schema.Unknown),
	ephemeral_1h_input_tokens: Schema.optional(Schema.Unknown),
});
export const counters = (usage: Readonly<Record<string, unknown>>): (typeof Counter.Type)[] => {
	const cache = Schema.decodeUnknownResult(cacheSchema)(usage.cache_creation);
	const ttl = Result.isSuccess(cache) ? cache.success : {};
	const ttlValue = (raw: unknown): typeof Counter.Type.value =>
		usage.cache_creation !== undefined && Result.isFailure(cache)
			? {state: "unavailable"}
			: value(raw);
	return [
		...[
			["input_tokens", "nonCachedInput"],
			["output_tokens", "output"],
			["cache_read_input_tokens", "cacheRead"],
			["cache_creation_input_tokens", "cacheWrite"],
		].map(([field, category]) => ({
			field: field as string,
			category: category as typeof Counter.Type.category,
			value: value(usage[field as string]),
			meaning: {kind: "additive" as const},
		})),
		{
			field: "cache_creation.ephemeral_5m_input_tokens",
			category: "cacheWrite5m",
			value: ttlValue(ttl.ephemeral_5m_input_tokens),
			meaning: {kind: "subset", of: "cache_creation_input_tokens"},
		},
		{
			field: "cache_creation.ephemeral_1h_input_tokens",
			category: "cacheWrite1h",
			value: ttlValue(ttl.ephemeral_1h_input_tokens),
			meaning: {kind: "subset", of: "cache_creation_input_tokens"},
		},
		{
			field: "cached_output_tokens",
			category: "cachedOutput",
			value: {state: "unsupported"},
			meaning: {kind: "unknown"},
		},
	];
};

export const measurement = (
	row: typeof NativeRow.Type,
	binding: Binding,
	child: string | null,
	parent: string | null,
): typeof Measurement.Type | null => {
	const message = row.message;
	if (row.type !== "assistant" || message?.role !== "assistant" || !message.id || !message.usage)
		return null;
	if (row.sessionId !== binding.root || (row.agentId ?? null) !== child) return null;
	return {
		...common(binding, child, parent, row.gitBranch ?? binding.branch),
		source: {host: "claude", format: "claude-code-jsonl", version: row.version ?? "unknown"},
		recordId: message.id,
		kind: "measurement",
		response: message.id,
		turn: null,
		rootTurn: null,
		parentTurn: null,
		provider: binding.provider,
		model: message.model ?? null,
		basis: {kind: "response"},
		counters: counters(message.usage),
	};
};

export const participant = (
	binding: Binding,
	child: string | null,
	parent: string | null,
	state: "expected" | "absent" | "unreadable" | "usage-missing" | "unsupported",
): UsageRecord => {
	const fields = {
		...common(binding, child, parent),
		kind: "participant" as const,
		participant: sessionKey(binding.root, child),
		state,
	};
	return {...fields, recordId: digest(fields)};
};
