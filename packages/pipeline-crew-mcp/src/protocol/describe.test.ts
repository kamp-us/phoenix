/**
 * The discoverable kind→shape surface (#3622): a peer resolves each kind's payload shape and the
 * whole shared kind set BEFORE sending, instead of discovering a shape by triggering a send-time
 * reject. Covers `describeKind` (per-kind shape + reply flag), the full-set resolution, and the
 * startup invariant's loud fail on an unresolvable kind.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	ChannelContractError,
	describeKind,
	resolveKindContracts,
	resolveKindContractsFor,
} from "./describe.ts";
import {crewMessageKinds} from "./group.ts";

describe("protocol/describe — the discoverable kind→shape surface (#3622)", () => {
	it.effect("describes every catalog kind, sourced from the same map (no divergent kind set)", () =>
		Effect.gen(function* () {
			for (const kind of crewMessageKinds) {
				const contract = yield* describeKind(kind);
				assert.isDefined(contract, `every catalog kind is describable: ${kind}`);
				assert.strictEqual(contract?.kind, kind);
			}
		}),
	);

	it.effect(
		"surfaces IntakePing.issue as an INTEGER shape ahead of a send (the footgun, now discoverable)",
		() =>
			Effect.gen(function* () {
				const contract = yield* describeKind("IntakePing");
				assert.isDefined(contract);
				// the payload shape a sender resolves — `issue` is an integer, so `{ "issue": 3621 }` is
				// legible as the accepted shape without triggering the send-time reject that hid it (#3622).
				const issue = (contract?.payload.schema as {properties?: {issue?: {type?: string}}})
					.properties?.issue;
				assert.strictEqual(issue?.type, "integer");
			}),
	);

	it.effect("marks request-response kinds as awaiting a reply, fire-and-forget kinds as not", () =>
		Effect.gen(function* () {
			// Claim + LookupRole carry a typed reply; the rest default to Schema.Void (fire-and-forget).
			assert.isTrue((yield* describeKind("Claim"))?.awaitsReply);
			assert.isTrue((yield* describeKind("LookupRole"))?.awaitsReply);
			assert.isFalse((yield* describeKind("IntakePing"))?.awaitsReply);
			assert.isFalse((yield* describeKind("EngineNudge"))?.awaitsReply);
			assert.isFalse((yield* describeKind("Heartbeat"))?.awaitsReply);
		}),
	);

	it.effect("resolves undefined for a kind outside the catalog", () =>
		Effect.gen(function* () {
			assert.isUndefined(yield* describeKind("NotAKind"));
		}),
	);

	it.effect("resolveKindContracts resolves the WHOLE shared kind set (the startup invariant)", () =>
		Effect.gen(function* () {
			const contracts = yield* resolveKindContracts();
			assert.deepStrictEqual(contracts.map((c) => c.kind).sort(), [...crewMessageKinds].sort());
		}),
	);

	it.effect("fails LOUD naming the unresolvable kinds — a gap never waits until first send", () =>
		Effect.gen(function* () {
			const error = yield* resolveKindContractsFor(["IntakePing", "NotAKind", "AlsoMissing"]).pipe(
				Effect.flip,
			);
			assert.instanceOf(error, ChannelContractError);
			assert.deepStrictEqual([...error.unresolved], ["NotAKind", "AlsoMissing"]);
			assert.include(error.message, "NotAKind");
		}),
	);
});
