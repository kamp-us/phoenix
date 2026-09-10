/**
 * `machineryLaps` — whether `lane emit` gives an epic's machine the machinery event class.
 *
 * One sub-key. `onEmit` says what an emission does with the lap axis: `off` emits the machine
 * exactly as it always did, `on` adds the `LAP` arms and seeds each task's lap counter.
 *
 * **The shipped default is `off`, which is today's behaviour byte for byte.** The machine is fixed
 * at emission, so a lane already on disk keeps whatever it was emitted with and no live run changes
 * arithmetic mid-flight; a repo opts the axis in for its next emission and nothing else moves.
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const MACHINERY_LAPS = "machineryLaps";

/** What an emitted machine gets: today's arms, or the lap-guarded ones beside them. */
export type OnEmit = "off" | "on";

const ON_EMIT_VALUES: ReadonlyArray<OnEmit> = ["off", "on"];

export interface MachineryLapsSurface {
	readonly onEmit: OnEmit;
}

/** The shipped surface — what a repo declaring nothing still gets: the machine it has today. */
export const SHIPPED_MACHINERY_LAPS: MachineryLapsSurface = {onEmit: "off"};

const named = (path: string): string => `\`${MACHINERY_LAPS}\`'s \`${path}\``;

const asRecord = (raw: unknown): Record<string, unknown> | null =>
	typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;

const KNOWN: ReadonlyArray<string> = ["onEmit"];

const decodeOnEmit = (raw: unknown): Decoded<OnEmit> =>
	typeof raw === "string" && (ON_EMIT_VALUES as ReadonlyArray<string>).includes(raw.trim())
		? {_tag: "Value", value: raw.trim() as OnEmit}
		: {
				_tag: "Malformed",
				reason: `${named("onEmit")} is not one of ${ON_EMIT_VALUES.join(", ")}`,
			};

const decode = (raw: unknown): Decoded<MachineryLapsSurface> => {
	const record = asRecord(raw);
	if (record === null) {
		return {_tag: "Malformed", reason: `\`${MACHINERY_LAPS}\` is not an object`};
	}
	const stray = Object.keys(record).find((key) => !KNOWN.includes(key));
	if (stray !== undefined) {
		return {
			_tag: "Malformed",
			reason: `${named(stray)} is not a machinery-laps setting — one of ${KNOWN.join(", ")}`,
		};
	}

	const onEmit =
		record.onEmit === undefined
			? ({_tag: "Value", value: SHIPPED_MACHINERY_LAPS.onEmit} as const)
			: decodeOnEmit(record.onEmit);
	if (onEmit._tag === "Malformed") return onEmit;

	return {_tag: "Value", value: {onEmit: onEmit.value}};
};

export const machineryLapsKey: KeyGroup<MachineryLapsSurface> = {
	key: MACHINERY_LAPS,
	shippedDefault: SHIPPED_MACHINERY_LAPS,
	decode,
	jsonSchema: {
		type: "object",
		description:
			"Whether an emitted epic machine carries the machinery event class, whose laps are counted apart from the repair budget.",
		properties: {
			onEmit: {
				type: "string",
				description:
					"What `lane emit` writes: `off` (today's machine, byte for byte — the shipped default) or `on` (the machinery `LAP` arms beside the existing ones, each task's lap counter seeded, and lap exhaustion parking on `human:machinery-stall` rather than freezing). The machine is fixed at emission, so flipping this moves no lane already on disk.",
				enum: ["off", "on"],
			},
		},
		additionalProperties: false,
	},
};
