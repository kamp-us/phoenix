/**
 * `parkCause` — what a repo does with a lane park: one that names no cause, and one whose cause
 * routes to the driver.
 *
 * Two sub-keys, each defaulting to the behaviour that shipped before it. `uncaused` says whether a
 * cause-less park is recorded as the bare `BLOCKED` it always was, or refused before the log is
 * touched. `driverRouted` says whether `recipe unpark` may clear a park whose cause routes `driver`
 * on the driver's own recorded rationale, or refuses it the way it always did.
 *
 * **`uncaused` ships as `record`.** A cause-less park is a bug — it folds to a `Novel` park no
 * recipe keys on, so it costs a human `UNBLOCKED` to say a thing the recorder already knew. But
 * every shell in flight when this lands still reports the bare park on some path, and flipping the
 * refusal on by default would brick those lanes mid-drive. So the strictness is a repo's to
 * declare, and a repo whose shells all name their causes declares `refuse` for itself.
 *
 * **`driverRouted` ships as `refuse`.** Taking the founder out of the engine loop is what the route
 * field on a park cause is for, and it is still a repo's call to make: a repo whose shells do not
 * name their causes yet would see the clearing reach almost nothing, so the flip waits until that
 * repo asks for it.
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const PARK_CAUSE = "parkCause";

/** What a `BLOCKED` with no `--cause` gets: recorded as the bare park, or refused unappended. */
export type Uncaused = "record" | "refuse";

const UNCAUSED_VALUES: ReadonlyArray<Uncaused> = ["record", "refuse"];

/**
 * What a park whose cause routes `driver` gets at `recipe unpark`: refused with the ledger
 * untouched, or cleared on the driver's own rationale.
 */
export type DriverRouted = "refuse" | "clear";

const DRIVER_ROUTED_VALUES: ReadonlyArray<DriverRouted> = ["refuse", "clear"];

export interface ParkCauseSurface {
	readonly uncaused: Uncaused;
	readonly driverRouted: DriverRouted;
}

/** The shipped park-cause surface — what a repo declaring nothing still gets. */
export const SHIPPED_PARK_CAUSE: ParkCauseSurface = {uncaused: "record", driverRouted: "refuse"};

const named = (path: string): string => `\`${PARK_CAUSE}\`'s \`${path}\``;

const asRecord = (raw: unknown): Record<string, unknown> | null =>
	typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;

const KNOWN: ReadonlyArray<string> = ["uncaused", "driverRouted"];

const decodeUncaused = (raw: unknown): Decoded<Uncaused> =>
	typeof raw === "string" && (UNCAUSED_VALUES as ReadonlyArray<string>).includes(raw.trim())
		? {_tag: "Value", value: raw.trim() as Uncaused}
		: {
				_tag: "Malformed",
				reason: `${named("uncaused")} is not one of ${UNCAUSED_VALUES.join(", ")}`,
			};

const decodeDriverRouted = (raw: unknown): Decoded<DriverRouted> =>
	typeof raw === "string" && (DRIVER_ROUTED_VALUES as ReadonlyArray<string>).includes(raw.trim())
		? {_tag: "Value", value: raw.trim() as DriverRouted}
		: {
				_tag: "Malformed",
				reason: `${named("driverRouted")} is not one of ${DRIVER_ROUTED_VALUES.join(", ")}`,
			};

const decode = (raw: unknown): Decoded<ParkCauseSurface> => {
	const record = asRecord(raw);
	if (record === null) return {_tag: "Malformed", reason: `\`${PARK_CAUSE}\` is not an object`};
	const stray = Object.keys(record).find((key) => !KNOWN.includes(key));
	if (stray !== undefined) {
		return {
			_tag: "Malformed",
			reason: `${named(stray)} is not a park-cause setting — one of ${KNOWN.join(", ")}`,
		};
	}

	const uncaused =
		record.uncaused === undefined
			? ({_tag: "Value", value: SHIPPED_PARK_CAUSE.uncaused} as const)
			: decodeUncaused(record.uncaused);
	if (uncaused._tag === "Malformed") return uncaused;

	const driverRouted =
		record.driverRouted === undefined
			? ({_tag: "Value", value: SHIPPED_PARK_CAUSE.driverRouted} as const)
			: decodeDriverRouted(record.driverRouted);
	if (driverRouted._tag === "Malformed") return driverRouted;

	return {_tag: "Value", value: {uncaused: uncaused.value, driverRouted: driverRouted.value}};
};

export const parkCauseKey: KeyGroup<ParkCauseSurface> = {
	key: PARK_CAUSE,
	shippedDefault: SHIPPED_PARK_CAUSE,
	decode,
	jsonSchema: {
		type: "object",
		description:
			"What this repo does with a lane park that names no cause, and with one whose cause routes to the driver.",
		properties: {
			uncaused: {
				type: "string",
				description:
					"What a BLOCKED carrying no `--cause` gets: `record` (the bare park, which routes to a human) or `refuse` (unappended, so every park names why).",
				enum: ["record", "refuse"],
			},
			driverRouted: {
				type: "string",
				description:
					"What `recipe unpark` does with a park whose cause routes `driver`: `refuse` (exit 12, the park routes to a human) or `clear` (the driver clears it on its own --rationale, recorded on the UNBLOCKED).",
				enum: ["refuse", "clear"],
			},
		},
		additionalProperties: false,
	},
};
