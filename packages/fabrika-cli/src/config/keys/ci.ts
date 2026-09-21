/**
 * `ci` — what fabrika may assume about the repo's continuous-integration producer.
 *
 * Three sub-keys, one question each. `noProducer` says what a repo with **zero Actions workflows**
 * gets; `gateWorkflow` is the filename fabrika names when it points a reader at the gate that
 * supersedes an in-tree prediction; `mainAlarm` is who the main-went-red alarm wakes and which
 * label carries its issue.
 *
 * **Workflow existence is the whole test, and nothing here inspects what a workflow does.** The
 * rule is deliberate — no job-name matching, no expected set, because any such set is a second
 * place the repo's CI shape is written down and a second place it drifts.
 *
 * **The shipped default is `refuse`, and that is today's behaviour, not a new strictness.** A repo
 * with no producer cannot evidence anything about a head, so a rollup over its empty enumeration is
 * vacuous. A repo that knowingly runs no Actions workflows declares `degrade` for
 * itself; the default never quietly greens on the repo that simply forgot to set up CI.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9508
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const CI = "ci";

/** What a repo with zero workflows gets: refused, or answered with the no-producer fact. */
export type NoProducer = "refuse" | "degrade";

const NO_PRODUCER_VALUES: ReadonlyArray<NoProducer> = ["refuse", "degrade"];

/**
 * Who the main-went-red alarm wakes, and the label its issue carries.
 *
 * An **empty `mention` disables nothing**: the alarm still files its issue and triage still drains
 * it, so the empty shipped default is the strict answer rather than an off switch. Who to wake is
 * the adopting repository's fact and cannot have a sensible shipped value — a handle baked into the
 * package would ping a stranger in every other repo.
 */
export interface MainAlarmSurface {
	/** The handles the alarm `@`-mentions, as the repo writes them. Empty mentions nobody. */
	readonly mention: ReadonlyArray<string>;
	/** The label the alarm issue carries, which is also how the standing one is found again. */
	readonly label: string;
}

/** The shipped alarm surface: fabrika's own label, and nobody to wake until a repo says who. */
export const SHIPPED_MAIN_ALARM: MainAlarmSurface = {mention: [], label: "fabrika-main-alarm"};

export interface CiSurface {
	readonly noProducer: NoProducer;
	/** The CI gate's workflow filename, as `gh api actions/workflows/<file>` names it. */
	readonly gateWorkflow: string;
	readonly mainAlarm: MainAlarmSurface;
}

/** The shipped CI surface — what a repo declaring nothing still gets. */
export const SHIPPED_CI: CiSurface = {
	noProducer: "refuse",
	gateWorkflow: "ci.yml",
	mainAlarm: SHIPPED_MAIN_ALARM,
};

const named = (path: string): string => `\`${CI}\`'s \`${path}\``;

const asRecord = (raw: unknown): Record<string, unknown> | null =>
	typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;

const KNOWN: ReadonlyArray<string> = ["noProducer", "gateWorkflow", "mainAlarm"];

const decodeNoProducer = (raw: unknown): Decoded<NoProducer> =>
	typeof raw === "string" && (NO_PRODUCER_VALUES as ReadonlyArray<string>).includes(raw.trim())
		? {_tag: "Value", value: raw.trim() as NoProducer}
		: {
				_tag: "Malformed",
				reason: `${named("noProducer")} is not one of ${NO_PRODUCER_VALUES.join(", ")}`,
			};

/**
 * A bare workflow filename — the shape the Actions API addresses a workflow by.
 *
 * A path is refused rather than trimmed to its basename: `.github/workflows/ci.yml` would look
 * accepted and then be looked up as a workflow nobody has, and a silently-repaired declaration is
 * one the operator believes is configured and is not.
 */
const decodeGateWorkflow = (raw: unknown): Decoded<string> => {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (value === "" || value.includes("/")) {
		return {
			_tag: "Malformed",
			reason: `${named("gateWorkflow")} is not a bare workflow filename — e.g. "ci.yml", not a path under .github/workflows`,
		};
	}
	return {_tag: "Value", value};
};

const MAIN_ALARM_KNOWN: ReadonlyArray<string> = ["mention", "label"];

/**
 * A handle list, refused whole on any bad entry.
 *
 * A handle carrying whitespace is refused rather than trimmed into shape: the value is pasted into
 * an issue body where GitHub either resolves it or renders it as literal text, and a declaration
 * quietly repaired is one the operator believes is configured and is not. The leading `@` is
 * optional here and normalised where the line is written, so the file may read either way.
 */
const decodeMention = (raw: unknown): Decoded<ReadonlyArray<string>> => {
	if (!Array.isArray(raw)) {
		return {_tag: "Malformed", reason: `${named("mainAlarm.mention")} is not a list of handles`};
	}
	const handles: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.trim() === "" || /\s/.test(entry.trim())) {
			return {
				_tag: "Malformed",
				reason: `${named("mainAlarm.mention")} carries an entry that is not a handle — e.g. "@someone"`,
			};
		}
		handles.push(entry.trim());
	}
	return {_tag: "Value", value: handles};
};

/**
 * The alarm label, which is also the dedup narrowing.
 *
 * A comma is refused because the label is spent as one term of the REST issue list's
 * comma-separated `labels` query, where an embedded comma would silently widen the lookup to two
 * labels and make the standing alarm unfindable.
 */
const decodeLabel = (raw: unknown): Decoded<string> => {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (value === "" || value.includes(",")) {
		return {
			_tag: "Malformed",
			reason: `${named("mainAlarm.label")} is not a single label name — e.g. "fabrika-main-alarm"`,
		};
	}
	return {_tag: "Value", value};
};

const decodeMainAlarm = (raw: unknown): Decoded<MainAlarmSurface> => {
	const record = asRecord(raw);
	if (record === null) {
		return {_tag: "Malformed", reason: `${named("mainAlarm")} is not an object`};
	}
	const stray = Object.keys(record).find((key) => !MAIN_ALARM_KNOWN.includes(key));
	if (stray !== undefined) {
		return {
			_tag: "Malformed",
			reason: `${named(`mainAlarm.${stray}`)} is not a main-alarm setting — one of ${MAIN_ALARM_KNOWN.join(", ")}`,
		};
	}

	const mention =
		record.mention === undefined
			? ({_tag: "Value", value: SHIPPED_MAIN_ALARM.mention} as const)
			: decodeMention(record.mention);
	if (mention._tag === "Malformed") return mention;

	const label =
		record.label === undefined
			? ({_tag: "Value", value: SHIPPED_MAIN_ALARM.label} as const)
			: decodeLabel(record.label);
	if (label._tag === "Malformed") return label;

	return {_tag: "Value", value: {mention: mention.value, label: label.value}};
};

const decode = (raw: unknown): Decoded<CiSurface> => {
	const record = asRecord(raw);
	if (record === null) return {_tag: "Malformed", reason: `\`${CI}\` is not an object`};
	const stray = Object.keys(record).find((key) => !KNOWN.includes(key));
	if (stray !== undefined) {
		return {
			_tag: "Malformed",
			reason: `${named(stray)} is not a CI setting — one of ${KNOWN.join(", ")}`,
		};
	}

	const noProducer =
		record.noProducer === undefined
			? ({_tag: "Value", value: SHIPPED_CI.noProducer} as const)
			: decodeNoProducer(record.noProducer);
	if (noProducer._tag === "Malformed") return noProducer;

	const gateWorkflow =
		record.gateWorkflow === undefined
			? ({_tag: "Value", value: SHIPPED_CI.gateWorkflow} as const)
			: decodeGateWorkflow(record.gateWorkflow);
	if (gateWorkflow._tag === "Malformed") return gateWorkflow;

	const mainAlarm =
		record.mainAlarm === undefined
			? ({_tag: "Value", value: SHIPPED_MAIN_ALARM} as const)
			: decodeMainAlarm(record.mainAlarm);
	if (mainAlarm._tag === "Malformed") return mainAlarm;

	return {
		_tag: "Value",
		value: {
			noProducer: noProducer.value,
			gateWorkflow: gateWorkflow.value,
			mainAlarm: mainAlarm.value,
		},
	};
};

export const ciKey: KeyGroup<CiSurface> = {
	key: CI,
	shippedDefault: SHIPPED_CI,
	decode,
	jsonSchema: {
		type: "object",
		description: "What fabrika may assume about the repo's continuous-integration producer.",
		properties: {
			noProducer: {
				type: "string",
				description:
					"What a repo with zero Actions workflows gets: `refuse` (a rollup over no producer is vacuous) or `degrade`.",
				enum: ["refuse", "degrade"],
			},
			gateWorkflow: {
				type: "string",
				description:
					"The CI gate's workflow filename, as `gh api actions/workflows/<file>` names it — a bare filename, not a path.",
				minLength: 1,
				pattern: "^[^/]+$",
			},
			mainAlarm: {
				type: "object",
				description:
					"The main-went-red alarm: who it wakes, and the label its tracking issue carries.",
				properties: {
					mention: {
						type: "array",
						description:
							'The handles the alarm mentions — e.g. ["@someone"]. Empty mentions nobody and still files.',
						items: {type: "string", minLength: 1, pattern: "^\\S+$"},
					},
					label: {
						type: "string",
						description:
							"The label the alarm issue carries, which is also how the standing one is found again.",
						minLength: 1,
						pattern: "^[^,]+$",
					},
				},
				additionalProperties: false,
			},
		},
		additionalProperties: false,
	},
};
