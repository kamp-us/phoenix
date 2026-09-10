import {Result} from "effect";
import type {Counter, Measurement, UsageRecord} from "./usage-record.ts";

export const object = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
export const id = (value: unknown): string | null =>
	typeof value === "string" && value.trim() !== "" ? value : null;
export const json = (text: string): unknown => {
	const parsed = Result.try({try: (): unknown => JSON.parse(text), catch: () => null});
	return Result.isSuccess(parsed) ? parsed.success : null;
};
export interface CodexWork {
	readonly repo: string | null;
	readonly issue: number | null;
	readonly run: string;
}
export interface NativeSession {
	readonly thread: string;
	readonly root: string;
	readonly parent: string | null;
	readonly version: string;
	readonly provider: string | null;
	readonly cwd: string | null;
	readonly rows: ReadonlyArray<Record<string, unknown>>;
	readonly malformed: boolean;
}
export const readCodexSession = (text: string): NativeSession | null => {
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	const rows = lines.map((line) => object(json(line)));
	const first = rows[0];
	const meta = object(first?.payload);
	const thread = id(meta.id);
	if (first?.type !== "session_meta" || thread === null) return null;
	return {
		thread,
		root: id(meta.session_id) ?? thread,
		parent: id(meta.parent_thread_id),
		version: id(meta.cli_version) ?? "unknown",
		provider: id(meta.model_provider),
		cwd: id(meta.cwd),
		rows,
		malformed: rows.some((row) => Object.keys(row).length === 0),
	};
};

const definitions: ReadonlyArray<
	readonly [string, (typeof Counter.Type)["category"], (typeof Counter.Type)["meaning"]]
> = [
	["input_tokens", "input", {kind: "additive"}],
	["cached_input_tokens", "cacheRead", {kind: "subset", of: "input_tokens"}],
	["cache_write_input_tokens", "cacheWrite", {kind: "unknown"}],
	["output_tokens", "output", {kind: "additive"}],
	["reasoning_output_tokens", "reasoning", {kind: "subset", of: "output_tokens"}],
	["total_tokens", "total", {kind: "aggregate", of: ["input_tokens", "output_tokens"]}],
];
const counters = (value: unknown): ReadonlyArray<typeof Counter.Type> | null => {
	const fields = object(value);
	if (Object.values(fields).some((n) => typeof n !== "number" || !Number.isSafeInteger(n) || n < 0))
		return null;
	const result: Array<typeof Counter.Type> = definitions.map(([field, category, meaning]) => ({
		field,
		category,
		meaning,
		value:
			typeof fields[field] === "number"
				? {state: "measured", tokens: fields[field]}
				: {state: "absent"},
	}));
	for (const [field, tokens] of Object.entries(fields)) {
		if (!definitions.some(([known]) => known === field))
			result.push({
				field,
				category: "other",
				meaning: {kind: "unknown"},
				value: {state: "measured", tokens: tokens as number},
			});
	}
	result.push({
		field: "cached_output_tokens",
		category: "cachedOutput",
		meaning: {kind: "unknown"},
		value: {state: "unsupported"},
	});
	return result;
};

export const codexCommon = (
	thread: string,
	parent: string | null,
	root: string,
	version: string,
	work: CodexWork,
) => ({
	v: 2 as const,
	source: {host: "codex", format: "token_usage_record", version},
	work: {...work, attempt: thread},
	agent: {
		session: thread,
		nativeSession: root,
		rootSession: root,
		parent: parent === null ? {kind: "root" as const} : {kind: "known" as const, session: parent},
	},
});

export const codexRecords = (
	session: NativeSession,
	root: string,
	work: CodexWork,
	rootTurn?: string,
) => {
	const records: UsageRecord[] = [];
	const notices: string[] = [];
	const common = codexCommon(session.thread, session.parent, root, session.version, work);
	if (!["0.153.4", "0.154.0"].includes(session.version))
		return {
			records,
			notices: [`Unsupported Codex schema version ${session.version} for ${session.thread}.`],
		};
	if (session.malformed)
		notices.push(`Unreadable record in ${session.thread}; replay after the native writer flushes.`);
	const models = new Map<string, string | null>();
	for (const row of session.rows) {
		const payload = object(row.payload);
		if (row.type === "turn_context" && id(payload.turn_id))
			models.set(payload.turn_id as string, id(payload.model));
		if (row.type !== "event_msg") continue;
		if (payload.type === "token_count") continue;
		if (payload.type !== "token_usage_record") continue;
		if (id(payload.thread_id) !== session.thread) continue;
		if (rootTurn !== undefined && payload.root_turn_id !== rootTurn) continue;
		const response = id(payload.response_id),
			turn = id(payload.turn_id),
			nativeRoot = id(payload.session_id),
			rootTurnId = id(payload.root_turn_id);
		if (!response || !turn || !nativeRoot || !rootTurnId) {
			notices.push(`Unsupported response identity in ${session.thread}.`);
			continue;
		}
		for (const [field, basis] of [
			["usage", {kind: "response"}],
			["turn_token_usage", {kind: "cumulative", snapshot: response, scope: "turn"}],
			["thread_token_usage", {kind: "cumulative", snapshot: response, scope: "session"}],
		] as const) {
			const counts = counters(payload[field]);
			if (!counts || Object.keys(object(payload[field])).length === 0) {
				notices.push(`Unsupported ${field} for ${session.thread}/${response}.`);
				continue;
			}
			const record: typeof Measurement.Type = {
				...common,
				agent: {...common.agent, nativeSession: nativeRoot},
				kind: "measurement",
				recordId: JSON.stringify([session.thread, turn, response, field]),
				response,
				turn,
				rootTurn: rootTurnId,
				parentTurn: null,
				model: models.get(turn) ?? null,
				provider: session.provider,
				basis,
				counters: counts,
			};
			records.push(record);
		}
	}
	if (!records.some((row) => row.kind === "measurement"))
		notices.push(`No supported response records for ${session.thread}; coverage is incomplete.`);
	return {records, notices};
};
