/**
 * `table` — the weekly betting table: its cadence, its agenda, and every threshold its flags read.
 *
 * One key group, many sub-keys, each with its own shipped default. **An absent block is a working
 * table**: config only tunes it. A declared block that leaves a sub-key out gets that sub-key's
 * shipped value, so a repo writes only the numbers it disagrees with.
 *
 * The dollars each size is worth are not a sub-key: they are `appetiteSizes`, the key pitch-guard
 * reads, so the table and a pitch approval never name two amounts for one size.
 *
 * No shipped value names a repository, path, issue number or login. The one per-repo fact the table
 * needs, which project it lives in, defaults to `null`: `table setup` finds or creates the project
 * on the repository's own owner.
 *
 * A malformed sub-key refuses the whole block rather than falling back, because a threshold silently
 * restored to the shipped number is one the operator believes they set and did not.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import type {JsonSchema} from "../json-schema.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const TABLE = "table";

/** How often the table meets. `on-demand` still dates its rows by week. */
export type Cadence = "weekly" | "biweekly" | "on-demand";

export const CADENCES: ReadonlyArray<Cadence> = ["weekly", "biweekly", "on-demand"];

export type Weekday =
	| "monday"
	| "tuesday"
	| "wednesday"
	| "thursday"
	| "friday"
	| "saturday"
	| "sunday";

/** In `Date.getUTCDay()` order, so a weekday's index is the platform's own day number. */
export const WEEKDAYS: ReadonlyArray<Weekday> = [
	"sunday",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
];

/**
 * The agenda section un-bet lanes land in. Every `sections` list carries it: the Outside the bets
 * view and the lanes that fill it are keyed on this name, so a list without it would leave un-bet
 * work with nowhere to show.
 */
export const OUTSIDE_THE_BETS = "Outside the bets";

/** The flagged target share of weekly spend on fabrika's own work: one share at first, then another. */
export interface FabrikaShare {
	readonly percent: number;
	readonly forTables: number;
	readonly thenPercent: number;
	/**
	 * The issue labels that mark fabrika's own work. Shipped empty, because which label means that is
	 * a fact about one repository: with none declared nothing counts, and the share flag says so.
	 */
	readonly labels: ReadonlyArray<string>;
}

/**
 * One declared evidence source: a command `table prep` runs for each bet it brings back as a check,
 * whose output is attached to the check as text. An argv, never a shell line, and bounded by its
 * timeout, so a source can only add text and can never hang or load anything into prep.
 */
export interface EvidenceSource {
	readonly name: string;
	readonly command: readonly [string, ...ReadonlyArray<string>];
	readonly timeoutSeconds: number;
}

export const EVIDENCE_TIMEOUT_DEFAULT = 60;
export const EVIDENCE_TIMEOUT_MAX = 600;

/** Which project the table lives in. A `null` field is derived: the repo's owner, or a new project. */
export interface ProjectTarget {
	readonly owner: string | null;
	readonly number: number | null;
}

export interface TableSettings {
	readonly cadence: Cadence;
	readonly day: Weekday;
	/** Agenda sections in agenda order. Non-empty, unique, and always holding {@link OUTSIDE_THE_BETS}. */
	readonly sections: ReadonlyArray<string>;
	readonly agendaCap: number;
	/** A lane over its size keeps going; at this multiple of its size it stops. */
	readonly stopMultiple: number;
	/** The ask count at which a bet is flagged onto the next table. */
	readonly asksFlag: number;
	/** Days without activity before a lane is flagged as stuck. */
	readonly stuckDays: number;
	/** More active campaigns than this is flagged. */
	readonly activeCampaignFlag: number;
	readonly fabrikaShare: FabrikaShare;
	/** Days after ship before a bet returns as `check`. */
	readonly checkDelayDays: number;
	/** Commands whose output a check carries. Empty: the check carries GitHub's and fabrika's own evidence. */
	readonly evidenceSources: ReadonlyArray<EvidenceSource>;
	readonly project: ProjectTarget;
}

export const SHIPPED_TABLE: TableSettings = {
	cadence: "weekly",
	day: "monday",
	sections: ["Tails", "Customers", "New bets", OUTSIDE_THE_BETS],
	agendaCap: 25,
	stopMultiple: 2,
	asksFlag: 3,
	stuckDays: 3,
	activeCampaignFlag: 3,
	fabrikaShare: {percent: 40, forTables: 4, thenPercent: 30, labels: []},
	checkDelayDays: 14,
	evidenceSources: [],
	project: {owner: null, number: null},
};

const named = (path: string): string => `\`${TABLE}.${path}\``;

const child = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

const asRecord = (raw: unknown): Record<string, unknown> | null =>
	typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;

const malformed = (reason: string): {readonly _tag: "Malformed"; readonly reason: string} => ({
	_tag: "Malformed",
	reason,
});

type Field<A> = (raw: unknown, path: string) => Decoded<A>;

const oneOf =
	<A extends string>(values: ReadonlyArray<A>): Field<A> =>
	(raw, path) =>
		typeof raw === "string" && (values as ReadonlyArray<string>).includes(raw)
			? {_tag: "Value", value: raw as A}
			: malformed(`${named(path)} is not one of ${values.join(", ")}`);

const positiveInteger: Field<number> = (raw, path) =>
	typeof raw === "number" && Number.isInteger(raw) && raw >= 1
		? {_tag: "Value", value: raw}
		: malformed(`${named(path)} is not a positive integer`);

const percent: Field<number> = (raw, path) =>
	typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 100
		? {_tag: "Value", value: raw}
		: malformed(`${named(path)} is not a percentage above 0 and at most 100`);

const multiple: Field<number> = (raw, path) =>
	typeof raw === "number" && Number.isFinite(raw) && raw > 1
		? {_tag: "Value", value: raw}
		: malformed(
				`${named(path)} is not a number above 1 — a lane stopping at its size or below it never runs over`,
			);

const sectionList: Field<ReadonlyArray<string>> = (raw, path) => {
	if (!Array.isArray(raw) || raw.length === 0) {
		return malformed(`${named(path)} is not a non-empty list of section names`);
	}
	const names: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.trim() === "") {
			return malformed(`${named(path)} holds an entry that is not a section name`);
		}
		if (names.includes(entry.trim())) {
			return malformed(`${named(path)} names "${entry.trim()}" twice`);
		}
		names.push(entry.trim());
	}
	if (!names.includes(OUTSIDE_THE_BETS)) {
		return malformed(
			`${named(path)} leaves out "${OUTSIDE_THE_BETS}" — un-bet lanes land in that section, so every list carries it`,
		);
	}
	return {_tag: "Value", value: names};
};

const labelList: Field<ReadonlyArray<string>> = (raw, path) => {
	if (!Array.isArray(raw)) return malformed(`${named(path)} is not a list of label names`);
	const names: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.trim() === "") {
			return malformed(`${named(path)} holds an entry that is not a label name`);
		}
		if (names.includes(entry.trim()))
			return malformed(`${named(path)} names "${entry.trim()}" twice`);
		names.push(entry.trim());
	}
	return {_tag: "Value", value: names};
};

/** An object sub-key: unknown keys refuse, absent keys take the shipped value. */
const objectOf =
	<A extends object>(fields: {readonly [K in keyof A]: Field<A[K]>}, shipped: A): Field<A> =>
	(raw, path) => {
		const record = asRecord(raw);
		if (record === null) return malformed(`${named(path)} is not an object`);
		const known = Object.keys(fields);
		const stray = Object.keys(record).find((key) => !known.includes(key));
		if (stray !== undefined) {
			return malformed(
				`${named(child(path, stray))} is not a setting — one of ${known.join(", ")}`,
			);
		}
		const decoders = fields as Readonly<Record<string, Field<unknown>>>;
		const defaults = shipped as Readonly<Record<string, unknown>>;
		const out: Record<string, unknown> = {};
		for (const [key, decodeField] of Object.entries(decoders)) {
			const value = record[key];
			if (value === undefined) {
				out[key] = defaults[key];
				continue;
			}
			const decoded = decodeField(value, child(path, key));
			if (decoded._tag === "Malformed") return decoded;
			out[key] = decoded.value;
		}
		return {_tag: "Value", value: out as A};
	};

const nullable =
	<A>(field: Field<A>): Field<A | null> =>
	(raw, path) =>
		raw === null ? {_tag: "Value", value: null} : field(raw, path);

const login: Field<string> = (raw, path) =>
	typeof raw === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(raw)
		? {_tag: "Value", value: raw}
		: malformed(`${named(path)} is not a GitHub user or organization login`);

const evidenceSource = (raw: unknown, path: string): Decoded<EvidenceSource> => {
	const record = asRecord(raw);
	if (record === null) return malformed(`${named(path)} is not an object`);
	const known = ["name", "command", "timeoutSeconds"];
	const stray = Object.keys(record).find((key) => !known.includes(key));
	if (stray !== undefined) {
		return malformed(`${named(child(path, stray))} is not a setting — one of ${known.join(", ")}`);
	}
	const {name, command, timeoutSeconds} = record;
	if (typeof name !== "string" || name.trim() === "") {
		return malformed(`${named(child(path, "name"))} is not a source name`);
	}
	if (
		!Array.isArray(command) ||
		command.length === 0 ||
		command.some((part) => typeof part !== "string") ||
		(command[0] as string).trim() === ""
	) {
		return malformed(
			`${named(child(path, "command"))} is not a non-empty argv of strings — e.g. ["pnpm", "metrics"]`,
		);
	}
	const timeout = timeoutSeconds ?? EVIDENCE_TIMEOUT_DEFAULT;
	if (
		typeof timeout !== "number" ||
		!Number.isInteger(timeout) ||
		timeout < 1 ||
		timeout > EVIDENCE_TIMEOUT_MAX
	) {
		return malformed(
			`${named(child(path, "timeoutSeconds"))} is not a whole number of seconds from 1 to ${EVIDENCE_TIMEOUT_MAX}`,
		);
	}
	const [binary, ...args] = command as string[];
	return {
		_tag: "Value",
		value: {name: name.trim(), command: [binary as string, ...args], timeoutSeconds: timeout},
	};
};

const evidenceSources: Field<ReadonlyArray<EvidenceSource>> = (raw, path) => {
	if (!Array.isArray(raw)) return malformed(`${named(path)} is not a list of evidence sources`);
	const sources: EvidenceSource[] = [];
	for (const [index, entry] of raw.entries()) {
		const decoded = evidenceSource(entry, `${path}[${index}]`);
		if (decoded._tag === "Malformed") return decoded;
		if (sources.some((one) => one.name === decoded.value.name)) {
			return malformed(`${named(path)} names the source "${decoded.value.name}" twice`);
		}
		sources.push(decoded.value);
	}
	return {_tag: "Value", value: sources};
};

const SUB_KEYS: {readonly [K in keyof TableSettings]: Field<TableSettings[K]>} = {
	cadence: oneOf(CADENCES),
	day: oneOf(WEEKDAYS),
	sections: sectionList,
	agendaCap: positiveInteger,
	stopMultiple: multiple,
	asksFlag: positiveInteger,
	stuckDays: positiveInteger,
	activeCampaignFlag: positiveInteger,
	fabrikaShare: objectOf<FabrikaShare>(
		{percent, forTables: positiveInteger, thenPercent: percent, labels: labelList},
		SHIPPED_TABLE.fabrikaShare,
	),
	checkDelayDays: positiveInteger,
	evidenceSources,
	project: objectOf<ProjectTarget>(
		{owner: nullable(login), number: nullable(positiveInteger)},
		SHIPPED_TABLE.project,
	),
};

const decode = (raw: unknown): Decoded<TableSettings> => {
	if (asRecord(raw) === null) return malformed(`\`${TABLE}\` is not an object`);
	return objectOf<TableSettings>(SUB_KEYS, SHIPPED_TABLE)(raw, "");
};

const integer = (description: string, minimum = 1): JsonSchema => ({
	type: "integer",
	minimum,
	description,
});

const percentage = (description: string): JsonSchema => ({
	type: "number",
	exclusiveMinimum: 0,
	maximum: 100,
	description,
});

export const tableKey: KeyGroup<TableSettings> = {
	key: TABLE,
	shippedDefault: SHIPPED_TABLE,
	decode,
	jsonSchema: {
		type: "object",
		description:
			"The weekly betting table on GitHub Projects: its cadence, agenda and every threshold its flags read. Its size dollars come from `appetiteSizes`. Leave it out for a working table on the shipped values; declare only the sub-keys you want to change.",
		properties: {
			cadence: {
				type: "string",
				enum: [...CADENCES],
				description:
					"How often the table meets. Default weekly. The project's iteration field runs 7 days for weekly and on-demand, 14 for biweekly.",
			},
			day: {
				type: "string",
				enum: [...WEEKDAYS],
				description: "The weekday the table meets and each iteration starts. Default monday.",
			},
			sections: {
				type: "array",
				items: {type: "string", minLength: 1},
				minItems: 1,
				uniqueItems: true,
				description: `Agenda sections in agenda order. Default Tails, Customers, New bets, ${OUTSIDE_THE_BETS}. Must include "${OUTSIDE_THE_BETS}", where un-bet lanes land.`,
			},
			agendaCap: integer("The most proposed rows agenda prep adds for one table. Default 25."),
			stopMultiple: {
				type: "number",
				exclusiveMinimum: 1,
				description:
					"A lane over its size keeps going and is flagged; at this multiple of its size it stops. Default 2. Must be above 1. What each size is worth is `appetiteSizes`, not a `table` sub-key.",
			},
			asksFlag: integer("The ask count at which a bet is flagged onto the next table. Default 3."),
			stuckDays: integer("Days without activity before a lane is flagged as stuck. Default 3."),
			activeCampaignFlag: integer("More active campaigns than this is flagged. Default 3."),
			fabrikaShare: {
				type: "object",
				description:
					"The flagged target share of weekly spend on fabrika's own work, and the labels that mark that work. Default 40 percent for the first 4 tables, then 30, with no label.",
				properties: {
					percent: percentage("The target share, in percent, for the first tables. Default 40."),
					forTables: integer("How many tables the first share holds for. Default 4."),
					thenPercent: percentage("The target share, in percent, after that. Default 30."),
					labels: {
						type: "array",
						items: {type: "string", minLength: 1},
						uniqueItems: true,
						description:
							"The issue labels that mark fabrika's own work; a lane on an issue carrying any of them counts toward the share. Default none, so nothing counts until the repo names its labels.",
					},
				},
				additionalProperties: false,
			},
			checkDelayDays: integer("Days after ship before a bet returns as `check`. Default 14."),
			evidenceSources: {
				type: "array",
				description:
					"Commands `fabrika table prep` runs for each shipped bet it brings back as a check; each one's standard output is attached to the check as text. Each runs as an argv (never through a shell) in the repository root, with only PATH, HOME, LANG, LC_ALL, TZ and TMPDIR inherited plus FABRIKA_CHECK_REPO, FABRIKA_CHECK_ISSUE, FABRIKA_CHECK_PRS (space-separated) and FABRIKA_CHECK_SHIPPED_AT. A source that exits non-zero, times out or cannot start is reported on the check and prep goes on. Default none: the check still carries the Success line, GitHub signals and fabrika's own numbers.",
				items: {
					type: "object",
					properties: {
						name: {
							type: "string",
							minLength: 1,
							description: "The name the check shows the output under.",
						},
						command: {
							type: "array",
							items: {type: "string"},
							minItems: 1,
							description: 'The argv to run — e.g. ["pnpm", "metrics", "--since", "14d"].',
						},
						timeoutSeconds: {
							type: "integer",
							minimum: 1,
							maximum: EVIDENCE_TIMEOUT_MAX,
							description: `Seconds before the source is stopped and reported as timed out. Default ${EVIDENCE_TIMEOUT_DEFAULT}, at most ${EVIDENCE_TIMEOUT_MAX}.`,
						},
					},
					required: ["name", "command"],
					additionalProperties: false,
				},
			},
			project: {
				type: "object",
				description:
					"Which GitHub project holds the table. Leave both out to have `fabrika table setup` find or create one on the repository's own owner.",
				properties: {
					owner: {
						type: ["string", "null"],
						description:
							"The user or organization that owns the project. Default: the repository's owner.",
					},
					number: {
						type: ["integer", "null"],
						minimum: 1,
						description:
							"The project number. Default: the open project `fabrika table setup` finds by its title, linked to this repository or under its owner, or creates.",
					},
				},
				additionalProperties: false,
			},
		},
		additionalProperties: false,
	},
};
