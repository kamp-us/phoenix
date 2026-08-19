/**
 * What the `post.delete` call site does once the mutation settles. fate has already
 * evicted the post synchronously and rolls that back itself on failure, so this only
 * decides where the user ends up — see `.patterns/fate-mutations-client.md`.
 */
import type {FateWireCode} from "../lib/fateWireCodes";

export type OptimisticDeleteOutcome =
	| {readonly kind: "deleted"}
	| {readonly kind: "auth-redirect"}
	| {readonly kind: "restore"; readonly code: FateWireCode};

// `null` ⇒ the mutation resolved cleanly.
export function decideOptimisticDelete(failureCode: FateWireCode | null): OptimisticDeleteOutcome {
	if (failureCode == null) return {kind: "deleted"};
	if (failureCode === "UNAUTHORIZED") return {kind: "auth-redirect"};
	return {kind: "restore", code: failureCode};
}
