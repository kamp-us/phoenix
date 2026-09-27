/**
 * `parkCause` — what a repo does with a lane park: one that names no cause, one whose cause
 * routes to the driver, and a spent repair budget.
 *
 * Three sub-keys, each defaulting to the behaviour that shipped before it. `uncaused` says whether a
 * cause-less park is recorded as the bare `BLOCKED` it always was, or refused before the log is
 * touched. `driverRouted` says whether `recipe unpark` may clear a park whose cause routes `driver`
 * on the driver's own recorded rationale, or refuses it the way it always did. `repairBudgetSpent`
 * says whose park a spent repair budget is: the driver's, which grants the next round itself, or
 * the founder's, which parks the task on a human like any other founder-routed park.
 *
 * The two verbs that record a park — `lane transition` and `lane report` — and the one that
 * clears it, `recipe unpark`, resolve it out of the repository that OWNS the cwd
 * ([`configRootOrRefuse`](../../lane/ground.ts)), because the rule is weighed against that
 * repository's one shared lane ledger: a linked worktree's tracked copy would decide which parks
 * reach, or leave, a log it does not own.
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
 *
 * **`repairBudgetSpent` ships as `driver`.** That is the route the `repair-budget-spent` cause
 * carried before any repo could declare one, so a repo declaring nothing keeps it. A repo that wants
 * every spent budget in front of a person declares `founder`. Either way the pull-request half of the
 * grant is still gated by `capClearAuthors`: this key says whose call the round is, not which
 * account may record it.
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

/** Whose park a spent repair budget is: the driver grants the round, or a human is asked. */
export type RepairBudgetSpent = "driver" | "founder";

const REPAIR_BUDGET_SPENT_VALUES: ReadonlyArray<RepairBudgetSpent> = ["driver", "founder"];

export interface ParkCauseSurface {
	readonly uncaused: Uncaused;
	readonly driverRouted: DriverRouted;
	readonly repairBudgetSpent: RepairBudgetSpent;
}

/** The shipped park-cause surface — what a repo declaring nothing still gets. */
export const SHIPPED_PARK_CAUSE: ParkCauseSurface = {
	uncaused: "record",
	driverRouted: "refuse",
	repairBudgetSpent: "driver",
};

const named = (path: string): string => `\`${PARK_CAUSE}\`'s \`${path}\``;

const asRecord = (raw: unknown): Record<string, unknown> | null =>
	typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;

const KNOWN: ReadonlyArray<string> = ["uncaused", "driverRouted", "repairBudgetSpent"];

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

const decodeRepairBudgetSpent = (raw: unknown): Decoded<RepairBudgetSpent> =>
	typeof raw === "string" &&
	(REPAIR_BUDGET_SPENT_VALUES as ReadonlyArray<string>).includes(raw.trim())
		? {_tag: "Value", value: raw.trim() as RepairBudgetSpent}
		: {
				_tag: "Malformed",
				reason: `${named("repairBudgetSpent")} is not one of ${REPAIR_BUDGET_SPENT_VALUES.join(", ")}`,
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

	const repairBudgetSpent =
		record.repairBudgetSpent === undefined
			? ({_tag: "Value", value: SHIPPED_PARK_CAUSE.repairBudgetSpent} as const)
			: decodeRepairBudgetSpent(record.repairBudgetSpent);
	if (repairBudgetSpent._tag === "Malformed") return repairBudgetSpent;

	return {
		_tag: "Value",
		value: {
			uncaused: uncaused.value,
			driverRouted: driverRouted.value,
			repairBudgetSpent: repairBudgetSpent.value,
		},
	};
};

export const parkCauseKey: KeyGroup<ParkCauseSurface> = {
	key: PARK_CAUSE,
	shippedDefault: SHIPPED_PARK_CAUSE,
	decode,
	jsonSchema: {
		type: "object",
		description:
			"What this repo does with a lane park that names no cause, with one whose cause routes to the driver, and with a spent repair budget.",
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
			repairBudgetSpent: {
				type: "string",
				description:
					"Whose park a spent repair budget (`repair-budget-spent`) is: `driver` (the driver grants the next round itself with `lane clear`; the pull-request half still needs its account in `capClearAuthors`) or `founder` (the task parks on a human like any founder-routed park).",
				enum: ["driver", "founder"],
			},
		},
		additionalProperties: false,
	},
};
