/**
 * What a bound answers instead of cutting. Both planners are total functions over their input, so
 * a boundary they cannot honour comes back as a value the caller must read — never a thrown
 * `RangeError` (the POC's answer) and never a quiet cut, which is the one failure that would reach
 * the window as a tool call whose call is missing.
 */

export type PlanRefusal =
	| {readonly kind: "refused"; readonly reason: "cursor-not-found"; readonly cursor: string}
	| {readonly kind: "refused"; readonly reason: "cursor-splits-group"; readonly cursor: string}
	| {readonly kind: "refused"; readonly reason: "limit-not-positive"; readonly limit: number};

export const isRefusal = (value: {readonly kind: string}): value is PlanRefusal =>
	value.kind === "refused";
