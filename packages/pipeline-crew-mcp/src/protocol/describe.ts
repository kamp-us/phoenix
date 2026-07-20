/**
 * protocol/describe — the DISCOVERABLE half of the typed catalog: render each wire kind to a
 * resolvable shape a peer can read BEFORE it sends, instead of discovering the shape only by
 * triggering a send-time reject (#3622). The send boundary already enforces the catalog
 * (`../edge/send-tool.ts`, #3229); this is the read-ahead surface that enforcement lacked.
 *
 * Generic (crew-agnostic); see the boundary note in `../index.ts`. Every descriptor is derived
 * straight from `CrewProtocol` — the SAME single source `crewMessageKinds` / `payloadSchemaForKind`
 * derive from — so the described kind set can never be a second, divergent copy of the catalog.
 */
import {Effect, Schema} from "effect";
import {CrewProtocol, crewMessageKinds, payloadSchemaForKind} from "./group.ts";

/** A kind's resolvable contract: its wire name, whether it awaits a typed reply, and its payload JSON Schema. */
export interface KindContract {
	readonly kind: string;
	/** Request-response (awaits a typed reply) vs fire-and-forget (`success` defaults to `Schema.Void`). */
	readonly awaitsReply: boolean;
	/** The payload's shape as a JSON Schema document — what a sender resolves to build a valid `body`. */
	readonly payload: ReturnType<typeof Schema.toJsonSchemaDocument>;
}

/**
 * A boot failure: the shared kind set could not be fully resolved to a describable shape, so a peer
 * would discover the gap only at first send. Raised by `resolveKindContracts` and surfaced as the
 * startup invariant (#3622) — a crew session refuses to come up rather than serve an unresolvable
 * contract.
 */
export class ChannelContractError extends Schema.TaggedErrorClass<ChannelContractError>()(
	"@kampus/pipeline-crew-mcp/ChannelContractError",
	{
		unresolved: Schema.Array(Schema.String),
		reason: Schema.String,
	},
) {
	override get message(): string {
		return this.reason;
	}
}

/** Whether a kind awaits a typed reply — its `success` schema is not the fire-and-forget `Schema.Void` default. */
const awaitsReplyForKind = (kind: string): boolean => {
	const rpc = CrewProtocol.requests.get(kind);
	return rpc !== undefined && rpc.successSchema.ast._tag !== "Void";
};

/**
 * Describe one kind → its resolvable contract, or `undefined` if the kind is outside the catalog OR
 * its payload can't be rendered to a JSON Schema. Effect-typed because the render is the one fallible
 * step — `toJsonSchemaDocument` throws on an unrepresentable schema, folded to `undefined` here (never
 * a native throw; #2736); the `undefined` is what `resolveKindContractsFor` turns into the loud boot
 * failure below.
 */
export const describeKind = (kind: string): Effect.Effect<KindContract | undefined> =>
	Effect.suspend(() => {
		const schema = payloadSchemaForKind(kind);
		if (schema === undefined) {
			return Effect.succeed(undefined);
		}
		return Effect.try({
			try: () => Schema.toJsonSchemaDocument(schema),
			catch: (cause) => String(cause),
		}).pipe(
			Effect.map(
				(payload): KindContract => ({kind, awaitsReply: awaitsReplyForKind(kind), payload}),
			),
			Effect.orElseSucceed(() => undefined),
		);
	});

/**
 * Resolve a contract for EVERY kind in `kinds`, or fail loud naming the ones that don't resolve — the
 * parametric core of the startup invariant. `resolveKindContracts` binds this to the real catalog;
 * exposed so the fail branch (an unresolvable kind ⇒ loud `ChannelContractError`) is directly testable.
 */
export const resolveKindContractsFor = (
	kinds: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<KindContract>, ChannelContractError> =>
	Effect.suspend(() => {
		return Effect.gen(function* () {
			const contracts: Array<KindContract> = [];
			const unresolved: Array<string> = [];
			for (const kind of kinds) {
				const contract = yield* describeKind(kind);
				if (contract === undefined) {
					unresolved.push(kind);
				} else {
					contracts.push(contract);
				}
			}
			if (unresolved.length > 0) {
				return yield* Effect.fail(
					new ChannelContractError({
						unresolved,
						reason: `cannot resolve the shared message-kind contract for: ${unresolved.join(", ")} — refusing to serve a channel whose kind set is not fully discoverable (#3622).`,
					}),
				);
			}
			return contracts;
		});
	});

/**
 * The full kind→shape contract over the shared catalog — or fail loud. This is the startup invariant
 * (#3622): a peer that cannot resolve the WHOLE shared kind set fails at boot, so a gap never waits to
 * be discovered at first send. Success means every `crewMessageKinds` entry described cleanly.
 */
export const resolveKindContracts = (): Effect.Effect<
	ReadonlyArray<KindContract>,
	ChannelContractError
> => resolveKindContractsFor(crewMessageKinds);
