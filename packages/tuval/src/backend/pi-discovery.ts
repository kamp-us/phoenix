import {Context, Effect, Layer} from "effect";
import type {DiscoveryOutcome} from "../shared/discovery.js";
import {defaultSessionRoots, scanPiHomes, toSessionMetadata} from "./pi-home.js";
import {listSessionsThroughProtocol, type ProtocolTransportOptions} from "./pi-protocol.js";

export interface PiDiscoveryOptions {
	readonly sessionRoots?: ReadonlyArray<string>;
	readonly transport?: ProtocolTransportOptions;
}

export interface PiDiscoveryService {
	readonly discover: Effect.Effect<DiscoveryOutcome>;
}

export class PiDiscovery extends Context.Service<PiDiscovery, PiDiscoveryService>()(
	"tuval/PiDiscovery",
) {}

export const discoverPiSessions = (options: PiDiscoveryOptions = {}): Promise<DiscoveryOutcome> =>
	(async () => {
		const scan = await scanPiHomes(options.sessionRoots ?? defaultSessionRoots());
		if (scan.sessions.length === 0 && scan.problems.length > 0) {
			return {
				_tag: "fatal",
				message: "Tuval could not read any configured pi session source",
				problems: [...scan.problems],
			};
		}
		let protocolSessions: Awaited<ReturnType<typeof listSessionsThroughProtocol>>;
		// biome-ignore lint/plugin: The promise-based pi-client boundary is normalized into the public transport outcome here.
		try {
			protocolSessions = await listSessionsThroughProtocol(
				scan.sessions.map(toSessionMetadata),
				options.transport,
			);
		} catch (error) {
			return {
				_tag: "transport",
				message: error instanceof Error ? error.message : String(error),
				retryable: true,
			};
		}
		const discoveredById = new Map(scan.sessions.map((session) => [session.piSessionId, session]));
		const sessions = protocolSessions.flatMap((metadata) => {
			const session = discoveredById.get(metadata.id);
			return session === undefined ? [] : [session];
		});
		if (scan.problems.length > 0) {
			return {_tag: "partial-source", sessions, problems: [...scan.problems]};
		}
		if (sessions.length === 0) return {_tag: "empty", sessions: []};
		return {_tag: "ready", sessions};
	})();

export const PiDiscoveryLive = (options: PiDiscoveryOptions = {}): Layer.Layer<PiDiscovery> =>
	Layer.succeed(PiDiscovery, {
		discover: Effect.tryPromise({
			try: () => discoverPiSessions(options),
			catch: (error): DiscoveryOutcome => ({
				_tag: "fatal",
				message: error instanceof Error ? error.message : String(error),
				problems: [],
			}),
		}).pipe(Effect.catch(Effect.succeed)),
	});
