import type {readUsageLedger} from "./usage-ledger.ts";
import {type Counter, type Measurement, recordKey, type UsageRecord} from "./usage-record.ts";

type Read = ReturnType<typeof readUsageLedger>;
type Response = typeof Measurement.Type;
type NativeCounter = typeof Counter.Type;
const coverageKey = (row: UsageRecord) =>
	JSON.stringify([row.source.host, row.work.repo, row.work.run, row.agent.rootSession]);

export interface UsageScope {
	readonly issue?: number | null;
	readonly run?: string | null;
	readonly repo?: string | null;
}

export interface CounterTotal {
	readonly host: string;
	readonly format: string;
	readonly provider: string | null;
	readonly field: string;
	readonly category: NativeCounter["category"];
	readonly meaning: NativeCounter["meaning"];
	readonly tokens: number | null;
	readonly states: Readonly<Record<NativeCounter["value"]["state"], number>>;
}

const countersOf = (rows: ReadonlyArray<Response>): CounterTotal[] => {
	const groups = new Map<string, {counter: CounterTotal; values: NativeCounter["value"][]}>();
	for (const row of rows) {
		for (const counter of row.counters) {
			const identity = {
				host: row.source.host,
				format: row.source.format,
				provider: row.provider,
				field: counter.field,
				category: counter.category,
				meaning: counter.meaning,
			};
			const key = JSON.stringify(identity);
			const group = groups.get(key) ?? {
				counter: {
					...identity,
					tokens: null,
					states: {measured: 0, absent: 0, unsupported: 0, unavailable: 0, "not-applicable": 0},
				},
				values: [],
			};
			group.values.push(counter.value);
			groups.set(key, group);
		}
	}
	return [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, {counter, values}]) => {
			const states = {...counter.states};
			states.absent =
				rows.filter(
					(row) =>
						row.source.host === counter.host &&
						row.source.format === counter.format &&
						row.provider === counter.provider,
				).length - values.length;
			let tokens: number | null = null;
			for (const value of values) {
				states[value.state]++;
				if (value.state === "measured") tokens = (tokens ?? 0) + value.tokens;
			}
			return {...counter, tokens, states};
		});
};

const coverageOf = (records: ReadonlyArray<UsageRecord>, measured: ReadonlyArray<Response>) => {
	const buckets = new Map<string, [UsageRecord, ...UsageRecord[]]>();
	for (const row of records) {
		const key = coverageKey(row);
		const bucket = buckets.get(key);
		if (bucket) bucket.push(row);
		else buckets.set(key, [row]);
	}
	const groups = [...buckets.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, rows]) => {
			const first = rows[0];
			const responses = measured.filter((row) => coverageKey(row) === key);
			const participants = new Set<string>();
			const measuredSessions = new Set(
				responses.flatMap((row) => (row.agent.session === null ? [] : [row.agent.session])),
			);
			const notices = rows
				.filter((row) => row.kind === "participant")
				.map((row) => ({
					participant: row.participant,
					attempt: row.work.attempt,
					state: row.state,
					measured: responses.some(
						(response) =>
							response.agent.session === row.participant &&
							(row.agent.session !== row.participant || response.work.attempt === row.work.attempt),
					),
				}));
			for (const row of rows) {
				if (row.agent.session !== null) participants.add(row.agent.session);
				if (row.kind === "participant" && row.participant !== null)
					participants.add(row.participant);
				if (row.kind === "coverage")
					for (const participant of row.participants) participants.add(participant);
			}
			const declarations = rows.filter((row) => row.kind === "coverage");
			const missing = [...participants]
				.filter(
					(id) =>
						!measuredSessions.has(id) ||
						notices.some((notice) => notice.participant === id && !notice.measured),
				)
				.sort();
			const discovery =
				declarations.length > 0 && declarations.every((row) => row.discovery === "enumerated")
					? "enumerated"
					: "unknown";
			const complete =
				discovery === "enumerated" &&
				missing.length === 0 &&
				responses.length > 0 &&
				declarations.every((row) => row.state === "complete") &&
				notices.every((row) => row.state === "expected") &&
				rows.every(
					(row) => row.agent.session !== null && row.work.run !== null && row.work.attempt !== null,
				);
			return {
				host: first.source.host,
				repo: first.work.repo,
				run: first.work.run,
				rootSession: first.agent.rootSession,
				state: complete ? "complete" : responses.length > 0 ? "partial" : "unavailable",
				discovery,
				participants: [...participants].sort(),
				measured: [...measuredSessions].sort(),
				missing,
				notices,
			};
		});
	const hosts = [...new Set(["claude", "codex", "pi", ...records.map((row) => row.source.host)])]
		.sort()
		.map((host) => {
			const own = groups.filter((row) => row.host === host);
			return {
				host,
				state:
					host === "pi" || own.length === 0
						? "unavailable"
						: own.every((row) => row.state === "complete")
							? "complete"
							: "partial",
				discovery:
					host !== "pi" && own.length > 0 && own.every((row) => row.discovery === "enumerated")
						? "enumerated"
						: "unknown",
				reason:
					host === "pi"
						? "Pi observer integration is not available; all-host acceptance remains pending."
						: own.length === 0
							? "No collector evidence in this scope; participation is unknown."
							: "Coverage is limited to collector evidence.",
			};
		});
	return {state: measured.length > 0 ? "partial" : "unavailable", hosts, groups};
};

export const rollUpUsage = (read: Read, scope: UsageScope = {}) => {
	const identities = new Map<string, number>();
	for (const row of read.records)
		identities.set(recordKey(row), (identities.get(recordKey(row)) ?? 0) + 1);
	const inRun = read.records.filter(
		(row) =>
			(scope.run == null || row.work.run === scope.run) &&
			(scope.repo == null || row.work.repo === scope.repo),
	);
	const selected = inRun.filter((row) => scope.issue == null || row.work.issue === scope.issue);
	const roots = new Set(selected.map(coverageKey));
	const coverage = inRun.filter(
		(row) =>
			selected.includes(row) ||
			(row.kind !== "measurement" && row.work.issue === null && roots.has(coverageKey(row))),
	);
	const measurements = selected.filter((row): row is Response => row.kind === "measurement");
	const rows = measurements.filter(
		(row) => row.basis.kind === "response" && identities.get(recordKey(row)) === 1,
	);
	const groups = new Map<string, [Response, ...Response[]]>();
	for (const row of rows) {
		const key = JSON.stringify([row.source.host, row.source.format, row.provider, row.model]);
		const group = groups.get(key);
		if (group) group.push(row);
		else groups.set(key, [row]);
	}
	return {
		scope: {repo: scope.repo ?? null, issue: scope.issue ?? null, run: scope.run ?? null},
		responses: rows.length,
		counters: countersOf(rows),
		byModel: [...groups.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, rows]) => ({
				host: rows[0].source.host,
				format: rows[0].source.format,
				provider: rows[0].provider,
				model: rows[0].model,
				responses: rows.length,
				counters: countersOf(rows),
			})),
		excluded: {
			cumulative: measurements.filter((row) => row.basis.kind === "cumulative").length,
			conflicting: measurements.filter((row) => identities.get(recordKey(row)) !== 1).length,
			unattributed:
				scope.issue == null
					? 0
					: inRun.filter(
							(row) =>
								row.kind === "measurement" &&
								row.basis.kind === "response" &&
								row.work.issue === null,
						).length,
		},
		unattributed: {
			responses: rows.filter((row) => row.work.issue === null).length,
			counters: countersOf(rows.filter((row) => row.work.issue === null)),
		},
		coverage: coverageOf(coverage, rows),
		diagnostics: read.diagnostics,
	};
};
