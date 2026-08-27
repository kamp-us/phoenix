import {Effect} from "effect";
import type {DiscoveryOutcome} from "../shared/wire.ts";
import {PiAccess, type PiSourceScan} from "./pi-access.ts";

export const assembleDiscovery = (scans: ReadonlyArray<PiSourceScan>): DiscoveryOutcome => {
	const sources = scans.map((scan) => scan.source);
	const issues = scans.flatMap((scan) => scan.issues);
	const byIdentity = new Map(
		scans
			.flatMap((scan) => scan.sessions)
			.map((session) => [session.identity.id, session] as const),
	);
	const sessions = [...byIdentity.values()].sort(
		(left, right) =>
			right.updatedAt - left.updatedAt || left.identity.id.localeCompare(right.identity.id),
	);
	if (issues.length > 0) return {kind: "partial", sessions, sources, issues};
	if (sessions.length === 0) return {kind: "empty", sessions, sources};
	return {kind: "ready", sessions, sources};
};

export const discoverSessions: Effect.Effect<DiscoveryOutcome, never, PiAccess> = Effect.gen(
	function* () {
		const access = yield* PiAccess;
		return yield* access.scan.pipe(
			Effect.match({
				onSuccess: assembleDiscovery,
				onFailure: (error): DiscoveryOutcome => ({
					kind: error._tag === "tuval/PiTransportError" ? "transport" : "fatal",
					message: error.message,
					sessions: [],
					sources: [],
				}),
			}),
		);
	},
);
