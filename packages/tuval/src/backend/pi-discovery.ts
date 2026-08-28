import type {ByteTransportFactory} from "@earendil-works/pi-client";
import type {SessionMetadata} from "@earendil-works/pi-protocol";
import {Context, Effect, FileSystem, Layer, Path, Result} from "effect";
import type {DiscoveryOutcome} from "../shared/discovery.js";
import {defaultSessionRoots, scanPiHomes, toSessionMetadata} from "./pi-home.js";
import {
	listSessionsFromTransport,
	listSessionsThroughProtocol,
	type PiProtocolError,
	type ProtocolTransportOptions,
} from "./pi-protocol.js";

export interface PiDiscoveryOptions {
	readonly sessionRoots?: ReadonlyArray<string>;
	readonly transport?: ProtocolTransportOptions;
	readonly protocolTransport?: ByteTransportFactory;
}

export type PiSessionMetadataOutcome =
	| {readonly _tag: "not-configured"}
	| {readonly _tag: "available"; readonly sessions: ReadonlyArray<SessionMetadata>}
	| {readonly _tag: "failed"; readonly message: string};

export interface PiDiscoveryService {
	readonly discover: () => Effect.Effect<DiscoveryOutcome>;
	readonly sessionMetadata: () => Effect.Effect<PiSessionMetadataOutcome>;
}

export class PiDiscovery extends Context.Service<PiDiscovery, PiDiscoveryService>()(
	"tuval/PiDiscovery",
) {}

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export const discoverPiSessions = Effect.fn("PiDiscovery.discover")(function* (
	options: PiDiscoveryOptions = {},
) {
	const roots = options.sessionRoots ?? (yield* defaultSessionRoots());
	const scan = yield* scanPiHomes(roots);
	if (scan.sessions.length === 0 && scan.problems.length > 0) {
		return {
			_tag: "fatal" as const,
			message: "Tuval could not read any configured pi session source",
			problems: [...scan.problems],
		};
	}
	const protocolSessions = yield* Effect.result(
		listSessionsThroughProtocol(scan.sessions.map(toSessionMetadata), options.transport),
	);
	if (Result.isFailure(protocolSessions)) {
		const error: PiProtocolError = protocolSessions.failure;
		return {
			_tag: "transport" as const,
			message: messageOf(error.cause),
			retryable: true as const,
		};
	}
	const discoveredById = new Map(scan.sessions.map((session) => [session.piSessionId, session]));
	const sessions = protocolSessions.success.flatMap((metadata) => {
		const session = discoveredById.get(metadata.id);
		return session === undefined ? [] : [session];
	});
	if (scan.problems.length > 0) {
		return {_tag: "partial-source" as const, sessions, problems: [...scan.problems]};
	}
	if (sessions.length === 0) return {_tag: "empty" as const, sessions: [] as const};
	return {_tag: "ready" as const, sessions};
});

export const discoverPiSessionMetadata = Effect.fn("PiDiscovery.sessionMetadata")(function* (
	options: PiDiscoveryOptions = {},
) {
	if (options.protocolTransport === undefined) {
		return {_tag: "not-configured" as const} satisfies PiSessionMetadataOutcome;
	}
	const metadata = yield* Effect.result(listSessionsFromTransport(options.protocolTransport));
	return Result.isSuccess(metadata)
		? ({_tag: "available", sessions: metadata.success} satisfies PiSessionMetadataOutcome)
		: ({
				_tag: "failed",
				message: messageOf(metadata.failure.cause),
			} satisfies PiSessionMetadataOutcome);
});

export const PiDiscoveryLive = (
	options: PiDiscoveryOptions = {},
): Layer.Layer<PiDiscovery, never, FileSystem.FileSystem | Path.Path> =>
	Layer.effect(
		PiDiscovery,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			return {
				discover: Effect.fn("PiDiscovery.discover")(() =>
					discoverPiSessions(options).pipe(
						Effect.provideService(FileSystem.FileSystem, fs),
						Effect.provideService(Path.Path, path),
					),
				),
				sessionMetadata: Effect.fn("PiDiscovery.sessionMetadata")(() =>
					discoverPiSessionMetadata(options).pipe(
						Effect.provideService(FileSystem.FileSystem, fs),
						Effect.provideService(Path.Path, path),
					),
				),
			};
		}),
	);
