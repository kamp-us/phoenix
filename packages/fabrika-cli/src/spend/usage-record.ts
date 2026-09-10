import {Result, Schema} from "effect";

const Id = Schema.String.check(Schema.isNonEmpty());
const KnownId = Schema.NullOr(Id);
export const USAGE_RECORD_VERSION = 2;
const Tokens = Schema.Finite.check(
	Schema.isInt(),
	Schema.isGreaterThanOrEqualTo(0),
	Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

export const Counter = Schema.Struct({
	field: Id,
	category: Schema.Literals([
		"input",
		"output",
		"nonCachedInput",
		"nonCachedOutput",
		"cacheRead",
		"cacheWrite",
		"cacheWrite5m",
		"cacheWrite1h",
		"reasoning",
		"total",
		"cachedOutput",
		"other",
	]),
	value: Schema.Union([
		Schema.Struct({state: Schema.Literal("measured"), tokens: Tokens}),
		Schema.Struct({
			state: Schema.Literals(["absent", "unsupported", "unavailable", "not-applicable"]),
		}),
	]),
	meaning: Schema.Union([
		Schema.Struct({kind: Schema.Literals(["additive", "unknown"])}),
		Schema.Struct({kind: Schema.Literal("subset"), of: Id}),
		Schema.Struct({
			kind: Schema.Literal("aggregate"),
			of: Schema.Array(Id).check(Schema.isNonEmpty()),
		}),
	]),
});

const counterRelationships = (counters: ReadonlyArray<typeof Counter.Type>): boolean => {
	const byField = new Map(counters.map((counter) => [counter.field, counter]));
	if (byField.size !== counters.length) return false;
	for (const counter of counters) {
		const meaning = counter.meaning;
		const references =
			meaning.kind === "subset" ? [meaning.of] : meaning.kind === "aggregate" ? meaning.of : [];
		if (references.some((field) => field === counter.field || !byField.has(field))) return false;
		const parentCategory =
			counter.category === "reasoning"
				? "output"
				: counter.category === "cacheWrite5m" || counter.category === "cacheWrite1h"
					? "cacheWrite"
					: null;
		if (
			counter.value.state === "measured" &&
			parentCategory !== null &&
			(meaning.kind !== "subset" || byField.get(meaning.of)?.category !== parentCategory)
		)
			return false;
		if (counter.category === "total" && meaning.kind === "additive") return false;
	}
	const visiting = new Set<string>();
	const done = new Set<string>();
	const acyclic = (field: string): boolean => {
		if (visiting.has(field)) return false;
		if (done.has(field)) return true;
		visiting.add(field);
		const meaning = byField.get(field)?.meaning;
		const edges =
			meaning?.kind === "subset" ? [meaning.of] : meaning?.kind === "aggregate" ? meaning.of : [];
		if (!edges.every(acyclic)) return false;
		visiting.delete(field);
		done.add(field);
		return true;
	};
	return counters.every((counter) => acyclic(counter.field));
};

const common = {
	v: Schema.Literal(USAGE_RECORD_VERSION),
	recordId: Id,
	source: Schema.Struct({host: Id, format: Id, version: Id}),
	work: Schema.Struct({
		repo: KnownId,
		issue: Schema.NullOr(Tokens.check(Schema.isGreaterThanOrEqualTo(1))),
		run: KnownId,
		attempt: KnownId,
	}),
	agent: Schema.Struct({
		session: KnownId,
		nativeSession: KnownId,
		rootSession: KnownId,
		parent: Schema.Union([
			Schema.Struct({kind: Schema.Literals(["root", "unknown"])}),
			Schema.Struct({kind: Schema.Literal("known"), session: Id}),
		]),
	}),
};

export const Measurement = Schema.Struct({
	...common,
	kind: Schema.Literal("measurement"),
	response: KnownId,
	turn: KnownId,
	rootTurn: KnownId,
	parentTurn: KnownId,
	provider: KnownId,
	model: KnownId,
	basis: Schema.Union([
		Schema.Struct({kind: Schema.Literal("response")}),
		Schema.Struct({
			kind: Schema.Literal("cumulative"),
			snapshot: Id,
			scope: Schema.Literals(["session", "turn"]),
		}),
	]),
	counters: Schema.Array(Counter).check(
		Schema.isNonEmpty(),
		Schema.makeFilter(counterRelationships, {
			message:
				"counter relationships must name distinct existing fields without cycles; reasoning and cache TTL counts are subsets",
		}),
	),
});

export const Participant = Schema.Struct({
	...common,
	kind: Schema.Literal("participant"),
	participant: KnownId,
	state: Schema.Literals(["expected", "absent", "unreadable", "unsupported", "usage-missing"]),
});

export const Coverage = Schema.Union([
	Schema.Struct({
		...common,
		kind: Schema.Literal("coverage"),
		state: Schema.Literal("complete"),
		discovery: Schema.Literal("enumerated"),
		participants: Schema.Array(Id).check(Schema.isNonEmpty()),
	}),
	Schema.Struct({
		...common,
		kind: Schema.Literal("coverage"),
		state: Schema.Literals(["partial", "unavailable", "unsupported"]),
		discovery: Schema.Literals(["enumerated", "unknown"]),
		participants: Schema.Array(Id),
	}),
]);

export const UsageRecord = Schema.Union([Measurement, Participant, Coverage]);
export type UsageRecord = typeof UsageRecord.Type;

export const recordKey = (record: UsageRecord): string => {
	const native =
		record.kind !== "measurement"
			? null
			: record.basis.kind === "response"
				? record.response
				: record.basis.snapshot;
	return JSON.stringify(
		record.agent.session !== null && native !== null && record.work.attempt !== null
			? [
					record.source.host,
					record.agent.session,
					record.work.attempt,
					record.kind === "measurement" ? record.basis : record.kind,
					record.kind === "measurement" ? record.turn : null,
					native,
				]
			: [
					record.source.host,
					record.agent.session,
					record.work.run,
					record.work.attempt,
					record.kind,
					"record",
					record.recordId,
				],
	);
};

const canonical = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
			.join(",")}}`;
	return JSON.stringify(value);
};

export const sameRecord = (left: UsageRecord, right: UsageRecord): boolean => {
	const content = ({recordId: _, ...record}: UsageRecord) =>
		record.kind === "measurement"
			? {...record, counters: [...record.counters].sort((a, b) => a.field.localeCompare(b.field))}
			: record;
	return canonical(content(left)) === canonical(content(right));
};

export const decodeUsageRecord = Schema.decodeUnknownResult(UsageRecord, {
	onExcessProperty: "error",
});

export const parseUsageRecord = (text: string): Result.Result<UsageRecord, string> => {
	const parsed = Result.try({try: (): unknown => JSON.parse(text), catch: () => "invalid JSON"});
	if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
	return decodeUsageRecord(parsed.success).pipe(Result.mapError(() => "invalid usage record"));
};
