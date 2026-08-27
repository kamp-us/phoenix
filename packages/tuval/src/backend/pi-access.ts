import {Context, Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {configuredAgentDirs, type PiSourceScan, scanAgentDir} from "./pi-scan.ts";

export type {PiSourceScan} from "./pi-scan.ts";
export {configuredAgentDirs, sessionIdentity, sourceIdentity} from "./pi-scan.ts";

export class PiTransportError extends Schema.TaggedErrorClass<PiTransportError>()(
	"tuval/PiTransportError",
	{message: Schema.String},
) {}

export class PiFatalError extends Schema.TaggedErrorClass<PiFatalError>()("tuval/PiFatalError", {
	message: Schema.String,
}) {}

export interface PiAccessShape {
	readonly scan: Effect.Effect<ReadonlyArray<PiSourceScan>, PiTransportError | PiFatalError>;
}

export class PiAccess extends Context.Service<PiAccess, PiAccessShape>()("tuval/PiAccess") {}

export const makePiAccess = (agentDirs: ReadonlyArray<string>): PiAccessShape => ({
	scan: Effect.tryPromise({
		try: () => Promise.all(agentDirs.map(scanAgentDir)),
		catch: (error) =>
			new PiTransportError({
				message: `pi session transport failed: ${error instanceof Error ? error.message : String(error)}`,
			}),
	}),
});

export const PiAccessLive = Layer.succeed(PiAccess, makePiAccess(configuredAgentDirs()));
