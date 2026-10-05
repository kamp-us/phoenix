/**
 * `boards` — the opt-in split of the table's work into a product board and an on-call board.
 *
 * **An absent block is one board**: the weekly table, with its Customers section, exactly as it runs
 * without this key. Declaring `boards.onCall` adds a second project for continuous work — customer
 * reports, crashes, CI breakage — that is pulled in order as it arrives instead of bet on weekly. Each
 * on-call item carries a response target instead of a size, and on-call work gets its own planned
 * share of the week's spend.
 *
 * A declared `onCall` that leaves a sub-key out gets that sub-key's shipped value, so
 * `"boards": {"onCall": {}}` is a working split. A malformed sub-key refuses the whole block, as the
 * `table` block does, because a routing rule silently restored to the shipped one sends work to a
 * board the operator did not choose.
 *
 * The shipped route keeps on-call small enough to empty: a bug at p0 or p1, and a bug a customer
 * reported at any priority. Every other issue, an untyped report included, stays on the table.
 *
 * No shipped value names a repository, path, issue number or login: the on-call project, like the
 * table's, defaults to the one `table setup` finds or creates on the repository's own owner.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9914
 * @ruling https://github.com/kamp-us/phoenix/issues/10353
 */

import {PRIORITIES} from "../../triage/facets.ts";
import type {JsonSchema} from "../json-schema.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";
import type {ProjectTarget} from "./table.ts";

export const BOARDS = "boards";

/**
 * One way an issue reaches the on-call board. It names one or more attributes, and an issue matches it
 * when it matches every attribute named: one of `origins`, one of `types` as a `type:` label, and one
 * of `labels`. An attribute the rule leaves out does not narrow it, and the decoder refuses a rule
 * that names none, since that rule would send every issue.
 */
export interface RouteRule {
	/** Origins as the Origin field names them, e.g. `customer`. */
	readonly origins?: ReadonlyArray<string>;
	/** Type names without the `type:` prefix, e.g. `bug`. */
	readonly types?: ReadonlyArray<string>;
	readonly labels?: ReadonlyArray<string>;
}

/**
 * Which issues land on the on-call board: an issue goes there when any one rule matches it.
 * Everything else stays on the product board, so an empty route sends nothing.
 */
export type Route = ReadonlyArray<RouteRule>;

/** How long an on-call item may wait before it is flagged. */
export interface ResponseTarget {
	readonly name: string;
	readonly hours: number;
}

/** A target for items carrying any of `labels`. */
export interface LabeledTarget extends ResponseTarget {
	readonly labels: ReadonlyArray<string>;
}

/**
 * The response targets, matched in order: the first labeled target whose labels an item carries,
 * else `otherwise`. The fallback is its own field, so every item gets exactly one target.
 */
export interface ResponseTargets {
	readonly byLabel: ReadonlyArray<LabeledTarget>;
	readonly otherwise: ResponseTarget;
}

export interface OnCallBoard {
	readonly route: Route;
	readonly responseTargets: ResponseTargets;
	/** The planned share of the week's spend on on-call work, in percent; more is flagged. */
	readonly spendShare: number;
	readonly project: ProjectTarget;
}

export type Boards =
	/** No `boards` block: the one weekly table. */
	{readonly _tag: "One"} | {readonly _tag: "Split"; readonly onCall: OnCallBoard};

export const ONE_BOARD: Boards = {_tag: "One"};

export const SHIPPED_ON_CALL: OnCallBoard = {
	route: [
		{types: ["bug"], labels: [PRIORITIES[0] as string, PRIORITIES[1] as string]},
		{types: ["bug"], origins: ["customer"]},
	],
	responseTargets: {
		byLabel: [{name: "same day", hours: 24, labels: [PRIORITIES[0] as string]}],
		otherwise: {name: "this week", hours: 168},
	},
	spendShare: 20,
	project: {owner: null, number: null},
};

const named = (path: string): string => `\`${BOARDS}.${path}\``;

const malformed = (reason: string): {readonly _tag: "Malformed"; readonly reason: string} => ({
	_tag: "Malformed",
	reason,
});

const asRecord = (raw: unknown): Record<string, unknown> | null =>
	typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;

/** A record holding only `known` keys, or the refusal naming the first stray one. */
const recordOf = (
	raw: unknown,
	path: string,
	known: ReadonlyArray<string>,
): Decoded<Record<string, unknown>> => {
	const record = asRecord(raw);
	if (record === null) return malformed(`${named(path)} is not an object`);
	const stray = Object.keys(record).find((key) => !known.includes(key));
	return stray === undefined
		? {_tag: "Value", value: record}
		: malformed(`${named(`${path}.${stray}`)} is not a setting — one of ${known.join(", ")}`);
};

const nameList = (
	raw: unknown,
	path: string,
	what: string,
	fallback: ReadonlyArray<string>,
): Decoded<ReadonlyArray<string>> => {
	if (raw === undefined) return {_tag: "Value", value: fallback};
	if (!Array.isArray(raw)) return malformed(`${named(path)} is not a list of ${what}s`);
	const names: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.trim() === "") {
			return malformed(`${named(path)} holds an entry that is not a ${what}`);
		}
		if (names.includes(entry.trim()))
			return malformed(`${named(path)} names "${entry.trim()}" twice`);
		names.push(entry.trim());
	}
	return {_tag: "Value", value: names};
};

const ROUTE_ATTRIBUTES = [
	["origins", "origin"],
	["types", "type name"],
	["labels", "label name"],
] as const;

const routeRule = (raw: unknown, path: string): Decoded<RouteRule> => {
	const read = recordOf(
		raw,
		path,
		ROUTE_ATTRIBUTES.map(([key]) => key),
	);
	if (read._tag === "Malformed") return read;
	const rule: {-readonly [K in keyof RouteRule]: RouteRule[K]} = {};
	for (const [key, what] of ROUTE_ATTRIBUTES) {
		if (read.value[key] === undefined) continue;
		const decoded = nameList(read.value[key], `${path}.${key}`, what, []);
		if (decoded._tag === "Malformed") return decoded;
		if (decoded.value.length === 0) {
			return malformed(`${named(`${path}.${key}`)} names no ${what} — leave it out to match any`);
		}
		rule[key] = decoded.value;
	}
	return Object.keys(rule).length === 0
		? malformed(`${named(path)} names no origin, type or label, so it would send every issue`)
		: {_tag: "Value", value: rule};
};

const route = (raw: unknown): Decoded<Route> => {
	if (raw === undefined) return {_tag: "Value", value: SHIPPED_ON_CALL.route};
	const path = "onCall.route";
	if (!Array.isArray(raw)) {
		return malformed(
			`${named(path)} is not a list of rules — an issue routes when any rule matches, and a rule matches when the issue matches every one of the origins, types and labels it names; a rule per attribute sends an issue when any one matches`,
		);
	}
	const rules: RouteRule[] = [];
	for (const [index, entry] of raw.entries()) {
		const decoded = routeRule(entry, `${path}[${index}]`);
		if (decoded._tag === "Malformed") return decoded;
		rules.push(decoded.value);
	}
	return {_tag: "Value", value: rules};
};

const target = (raw: unknown, path: string, labeled: boolean): Decoded<LabeledTarget> => {
	const known = labeled ? ["name", "hours", "labels"] : ["name", "hours"];
	const read = recordOf(raw, path, known);
	if (read._tag === "Malformed") return read;
	const record = read.value;
	const {name, hours} = record;
	if (typeof name !== "string" || name.trim() === "") {
		return malformed(`${named(`${path}.name`)} is not a target name`);
	}
	if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) {
		return malformed(`${named(`${path}.hours`)} is not a positive number of hours`);
	}
	if (!labeled) return {_tag: "Value", value: {name: name.trim(), hours, labels: []}};
	const labels = nameList(record.labels, `${path}.labels`, "label name", []);
	if (labels._tag === "Malformed") return labels;
	if (labels.value.length === 0) {
		return malformed(
			`${named(`${path}.labels`)} names no label — an unlabeled target is \`onCall.responseTargets.otherwise\``,
		);
	}
	return {_tag: "Value", value: {name: name.trim(), hours, labels: labels.value}};
};

const responseTargets = (raw: unknown): Decoded<ResponseTargets> => {
	if (raw === undefined) return {_tag: "Value", value: SHIPPED_ON_CALL.responseTargets};
	const path = "onCall.responseTargets";
	const read = recordOf(raw, path, ["byLabel", "otherwise"]);
	if (read._tag === "Malformed") return read;
	const record = read.value;
	const byLabel: LabeledTarget[] = [];
	const rawList = record.byLabel ?? SHIPPED_ON_CALL.responseTargets.byLabel;
	if (!Array.isArray(rawList)) return malformed(`${named(`${path}.byLabel`)} is not a list`);
	for (const [index, entry] of rawList.entries()) {
		const decoded = target(entry, `${path}.byLabel[${index}]`, true);
		if (decoded._tag === "Malformed") return decoded;
		byLabel.push(decoded.value);
	}
	const fallback =
		record.otherwise === undefined
			? {_tag: "Value" as const, value: {...SHIPPED_ON_CALL.responseTargets.otherwise, labels: []}}
			: target(record.otherwise, `${path}.otherwise`, false);
	if (fallback._tag === "Malformed") return fallback;
	const otherwise = {name: fallback.value.name, hours: fallback.value.hours};
	const names = [...byLabel.map((one) => one.name), otherwise.name];
	const twice = names.find((name, index) => names.indexOf(name) !== index);
	if (twice !== undefined) {
		return malformed(
			`${named(path)} names the target "${twice}" twice — each is one option of the Response target field`,
		);
	}
	return {_tag: "Value", value: {byLabel, otherwise}};
};

const spendShare = (raw: unknown): Decoded<number> => {
	if (raw === undefined) return {_tag: "Value", value: SHIPPED_ON_CALL.spendShare};
	return typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 100
		? {_tag: "Value", value: raw}
		: malformed(`${named("onCall.spendShare")} is not a percentage above 0 and at most 100`);
};

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

const project = (raw: unknown): Decoded<ProjectTarget> => {
	if (raw === undefined) return {_tag: "Value", value: SHIPPED_ON_CALL.project};
	const read = recordOf(raw, "onCall.project", ["owner", "number"]);
	if (read._tag === "Malformed") return read;
	const record = read.value;
	const owner = record.owner ?? null;
	const number = record.number ?? null;
	if (owner !== null && (typeof owner !== "string" || !LOGIN.test(owner))) {
		return malformed(`${named("onCall.project.owner")} is not a GitHub user or organization login`);
	}
	if (number !== null && (typeof number !== "number" || !Number.isInteger(number) || number < 1)) {
		return malformed(`${named("onCall.project.number")} is not a positive integer`);
	}
	return {_tag: "Value", value: {owner, number}};
};

const onCall = (raw: unknown): Decoded<OnCallBoard> => {
	const read = recordOf(raw, "onCall", ["route", "responseTargets", "spendShare", "project"]);
	if (read._tag === "Malformed") return read;
	const record = read.value;
	const routed = route(record.route);
	if (routed._tag === "Malformed") return routed;
	const targets = responseTargets(record.responseTargets);
	if (targets._tag === "Malformed") return targets;
	const share = spendShare(record.spendShare);
	if (share._tag === "Malformed") return share;
	const where = project(record.project);
	if (where._tag === "Malformed") return where;
	return {
		_tag: "Value",
		value: {
			route: routed.value,
			responseTargets: targets.value,
			spendShare: share.value,
			project: where.value,
		},
	};
};

const decode = (raw: unknown): Decoded<Boards> => {
	const record = asRecord(raw);
	if (record === null) return malformed(`\`${BOARDS}\` is not an object`);
	const stray = Object.keys(record).find((key) => key !== "onCall");
	if (stray !== undefined) return malformed(`${named(stray)} is not a setting — onCall`);
	if (record.onCall === undefined) {
		return malformed(
			`\`${BOARDS}\` declares no \`onCall\` board — declare \`"onCall": {}\` to split, or leave \`${BOARDS}\` out for one board`,
		);
	}
	const board = onCall(record.onCall);
	return board._tag === "Malformed"
		? board
		: {_tag: "Value", value: {_tag: "Split", onCall: board.value}};
};

const names = (description: string): JsonSchema => ({
	type: "array",
	items: {type: "string", minLength: 1},
	uniqueItems: true,
	description,
});

const hours: JsonSchema = {
	type: "number",
	exclusiveMinimum: 0,
	description: "How many hours an item may wait before it is flagged as past its target.",
};

const targetName: JsonSchema = {
	type: "string",
	minLength: 1,
	description: "The option the on-call board's Response target field shows.",
};

export const boardsKey: KeyGroup<Boards> = {
	key: BOARDS,
	shippedDefault: ONE_BOARD,
	decode,
	render: (value) => (value._tag === "One" ? null : {onCall: value.onCall}),
	jsonSchema: {
		type: "object",
		description:
			"Split the table's work into a product board (the weekly table) and an on-call board: continuous work pulled in order as it arrives, each item with a response target instead of a size, and its own planned share of weekly spend. Leave it out for one board with a Customers section.",
		properties: {
			onCall: {
				type: "object",
				description:
					'The on-call board. `"onCall": {}` splits on the shipped values; declare only the sub-keys you want to change.',
				properties: {
					route: {
						type: "array",
						description:
							"Which issues land on the on-call board: an issue that matches any one rule goes there; everything else stays on the product board. Default: a bug at the first or second priority label (p0, p1), and a bug a customer reported at any priority. An issue with no `type:` label matches neither default rule, so an untriaged report stays off on-call.",
						items: {
							type: "object",
							description:
								"One rule. An issue matches it when it matches every attribute the rule names; an attribute left out does not narrow it, and a rule must name at least one.",
							properties: {
								origins: {
									...names(
										"Origins, one of which the issue must be known by, as the Origin field names them (customer, hand-start, driver pick, found mid-lane, experiment, bet). An issue reads as customer when its filer only uses the product.",
									),
									minItems: 1,
								},
								types: {
									...names(
										"Type names, without the `type:` prefix, one of which the issue must carry as a `type:` label.",
									),
									minItems: 1,
								},
								labels: {
									...names("Labels, one of which the issue must carry."),
									minItems: 1,
								},
							},
							minProperties: 1,
							additionalProperties: false,
						},
					},
					responseTargets: {
						type: "object",
						description:
							"How long an on-call item may wait: the first `byLabel` target whose labels the item carries, else `otherwise`. Default: same day (24 hours) for the first priority label, this week (168 hours) otherwise.",
						properties: {
							byLabel: {
								type: "array",
								description: "Targets for items carrying any of their labels, matched in order.",
								items: {
									type: "object",
									properties: {
										name: targetName,
										hours,
										labels: {...names("The labels this target applies to."), minItems: 1},
									},
									required: ["name", "hours", "labels"],
									additionalProperties: false,
								},
							},
							otherwise: {
								type: "object",
								description: "The target for every item no `byLabel` target matches.",
								properties: {name: targetName, hours},
								required: ["name", "hours"],
								additionalProperties: false,
							},
						},
						additionalProperties: false,
					},
					spendShare: {
						type: "number",
						exclusiveMinimum: 0,
						maximum: 100,
						description:
							"The planned share of the week's spend on on-call work, in percent. More is flagged, never stopped. Default 20.",
					},
					project: {
						type: "object",
						description:
							'Which GitHub project holds the on-call board. Leave both out to have `fabrika table setup` find or create "<repo name> on-call" on the repository\'s own owner.',
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
									"The project number. Default: the open project `fabrika table setup` finds by its title, or creates.",
							},
						},
						additionalProperties: false,
					},
				},
				additionalProperties: false,
			},
		},
		required: ["onCall"],
		additionalProperties: false,
	},
};
