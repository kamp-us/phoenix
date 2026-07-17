/**
 * The catalog-shape guarantees: the `RpcGroup` covers all 7 kinds (acceptance criterion
 * 1), the claim/collision-check kind is a request-response RPC with a typed reply rather
 * than fire-and-forget (criterion 4), and the whole `protocol/` module imports nothing
 * from `crew/` — the generic boundary holds (criterion 3).
 */
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {Schema} from "effect";
import {Rpc} from "effect/unstable/rpc";
import {
	AnnouncePresence,
	Claim,
	CrewProtocol,
	crewMessageKinds,
	payloadSchemaForKind,
	Release,
} from "./group.ts";
import * as Messages from "./schema.ts";

describe("protocol/group catalog", () => {
	it("covers all 8 message kinds (9 rpcs — presence is announce + lookup, claim is claim + release)", () => {
		assert.deepStrictEqual([...CrewProtocol.requests.keys()].sort(), [
			"AckInbox",
			"AnnouncePresence",
			"Claim",
			"DrainProgress",
			"EpicHandoff",
			"Heartbeat",
			"IntakePing",
			"LookupRole",
			"Release",
		]);
	});

	it("every rpc in the group is a real Rpc definition", () => {
		for (const rpc of CrewProtocol.requests.values()) {
			assert.isTrue(Rpc.isRpc(rpc));
		}
	});

	it("claim/collision-check is a request-response RPC with a typed reply (not fire-and-forget)", () => {
		// A fire-and-forget rpc's success defaults to Schema.Void; a non-void success schema
		// that decodes a structured reply is what makes this kind request-response.
		const reply = {
			resource: "issue:3054",
			granted: true,
			collision: false,
			owner: "peer-a",
			since: "2026-07-16T10:00:00Z",
		};
		assert.deepStrictEqual(Schema.decodeUnknownSync(Claim.successSchema)(reply), reply);
	});

	it("a fire-and-forget kind carries no reply (success is Void)", () => {
		assert.strictEqual(AnnouncePresence.successSchema, Schema.Void);
	});

	it("Release is fire-and-forget: no reply schema, so releasing is idempotent (ADR 0191)", () => {
		assert.strictEqual(Release.successSchema, Schema.Void);
	});

	it("payloadSchemaForKind resolves a catalog kind to its payload schema (#3229)", () => {
		// the resolver is derived from the catalog, so every kind resolves and a valid payload decodes
		assert.strictEqual(payloadSchemaForKind("IntakePing"), Messages.IntakePing);
		const ping = {issue: "3057", from: "intake", at: "2026-07-16T10:00:00Z"};
		assert.deepStrictEqual(
			Schema.decodeUnknownSync(payloadSchemaForKind("IntakePing")!)(ping),
			ping,
		);
	});

	it("payloadSchemaForKind returns undefined for a kind outside the catalog (#3229)", () => {
		assert.strictEqual(payloadSchemaForKind("IntakePng"), undefined);
		assert.strictEqual(payloadSchemaForKind(""), undefined);
	});

	it("crewMessageKinds is exactly the catalog's kind names", () => {
		assert.deepStrictEqual([...crewMessageKinds].sort(), [...CrewProtocol.requests.keys()].sort());
	});

	it("no protocol source file imports from crew/ (the generic boundary holds)", () => {
		const dir = fileURLToPath(new URL(".", import.meta.url));
		const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
		for (const file of sources) {
			const body = readFileSync(new URL(file, new URL(".", import.meta.url)), "utf8");
			assert.isFalse(/from\s+["'][^"']*crew/.test(body), `${file} imports from crew/`);
		}
	});
});
