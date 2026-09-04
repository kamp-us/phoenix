import {readdirSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Option, Schema} from "effect";
import type {CapabilityRequest as KernelCapabilityRequest} from "../registry/program.ts";
import type {TableRow} from "../table/row.ts";
import {
	decodeKernelMessage,
	decodePageMessage,
	encodeKernelMessage,
	encodePageMessage,
} from "./codec.ts";
import type {ProtocolRefused} from "./errors.ts";
import * as fixtures from "./fixtures.ts";
import {
	type KernelToPage,
	type PageToKernel,
	Patch,
	PROTOCOL_VERSION,
	Snapshot,
	SpellCall,
	SpellReply,
} from "./messages.ts";
import {ProcessRow} from "./process-row.ts";
import {CapabilityRequest, RegistryDescription} from "./registry-description.ts";

const roundTripsPage = (message: PageToKernel) =>
	Effect.gen(function* () {
		const text = yield* encodePageMessage(message);
		const decoded = yield* decodePageMessage(text);
		assert.deepStrictEqual(decoded, message);
		assert.strictEqual(yield* encodePageMessage(decoded), text);
	});

const roundTripsKernel = (message: KernelToPage) =>
	Effect.gen(function* () {
		const text = yield* encodeKernelMessage(message);
		const decoded = yield* decodeKernelMessage(text);
		assert.deepStrictEqual(decoded, message);
		assert.strictEqual(yield* encodeKernelMessage(decoded), text);
	});

const refusalOf = <A>(decoded: Effect.Effect<A, ProtocolRefused>) => Effect.flip(decoded);

describe("the direction unions", () => {
	it.effect("admit exactly the four message classes", () =>
		Effect.gen(function* () {
			assert.instanceOf(
				yield* decodePageMessage(yield* encodePageMessage(fixtures.spellCall)),
				SpellCall,
			);
			assert.instanceOf(
				yield* decodeKernelMessage(yield* encodeKernelMessage(fixtures.spellReply)),
				SpellReply,
			);
			assert.instanceOf(
				yield* decodeKernelMessage(yield* encodeKernelMessage(fixtures.snapshot)),
				Snapshot,
			);
			assert.instanceOf(
				yield* decodeKernelMessage(yield* encodeKernelMessage(fixtures.patch)),
				Patch,
			);
		}),
	);

	it.effect("refuse a kernel message on the page-to-kernel side", () =>
		Effect.gen(function* () {
			const text = yield* encodeKernelMessage(fixtures.spellReply);
			const refusal = yield* refusalOf(decodePageMessage(text));
			assert.strictEqual(refusal.direction, "page-to-kernel");
		}),
	);

	it.effect("refuse a page message on the kernel-to-page side", () =>
		Effect.gen(function* () {
			const text = yield* encodePageMessage(fixtures.spellCall);
			const refusal = yield* refusalOf(decodeKernelMessage(text));
			assert.strictEqual(refusal.direction, "kernel-to-page");
		}),
	);
});

describe("round trips", () => {
	it.effect("SpellCall", () => roundTripsPage(fixtures.spellCall));
	it.effect("SpellReply, succeeded", () => roundTripsKernel(fixtures.spellReply));
	it.effect("SpellReply, failed", () => roundTripsKernel(fixtures.spellRefusal));
	it.effect("Snapshot", () => roundTripsKernel(fixtures.snapshot));
	it.effect("Patch", () => roundTripsKernel(fixtures.patch));
});

describe("refusals", () => {
	const withField = (message: object, field: string, value: unknown) =>
		JSON.stringify({...message, [field]: value});

	const callBody = {
		type: "spell.call",
		version: PROTOCOL_VERSION,
		id: "call-1",
		path: ["window", "split"],
		args: {},
	};

	const replyBody = {
		type: "spell.reply",
		version: PROTOCOL_VERSION,
		id: "call-1",
		outcome: {ok: true, result: null},
	};

	it.effect("a wrong version, page to kernel", () =>
		Effect.gen(function* () {
			const refusal = yield* refusalOf(decodePageMessage(withField(callBody, "version", 2)));
			assert.strictEqual(refusal.direction, "page-to-kernel");
			assert.include(refusal.reason, "version");
		}),
	);

	it.effect("a wrong version, kernel to page", () =>
		Effect.gen(function* () {
			const refusal = yield* refusalOf(decodeKernelMessage(withField(replyBody, "version", 2)));
			assert.strictEqual(refusal.direction, "kernel-to-page");
			assert.include(refusal.reason, "version");
		}),
	);

	it.effect("an unknown type, page to kernel", () =>
		Effect.gen(function* () {
			const refusal = yield* refusalOf(
				decodePageMessage(withField(callBody, "type", "spell.cast")),
			);
			assert.strictEqual(refusal.direction, "page-to-kernel");
			assert.include(refusal.reason, "type");
		}),
	);

	it.effect("an unknown type, kernel to page", () =>
		Effect.gen(function* () {
			const refusal = yield* refusalOf(
				decodeKernelMessage(withField(replyBody, "type", "snapshut")),
			);
			assert.strictEqual(refusal.direction, "kernel-to-page");
		}),
	);

	it.effect("a missing field, page to kernel", () =>
		Effect.gen(function* () {
			const {id: _id, ...withoutId} = callBody;
			const refusal = yield* refusalOf(decodePageMessage(JSON.stringify(withoutId)));
			assert.strictEqual(refusal.direction, "page-to-kernel");
			assert.include(refusal.reason, "id");
		}),
	);

	it.effect("a missing field, kernel to page", () =>
		Effect.gen(function* () {
			const {outcome: _outcome, ...withoutOutcome} = replyBody;
			const refusal = yield* refusalOf(decodeKernelMessage(JSON.stringify(withoutOutcome)));
			assert.strictEqual(refusal.direction, "kernel-to-page");
			assert.include(refusal.reason, "outcome");
		}),
	);

	it.effect("bytes that are not JSON at all", () =>
		Effect.gen(function* () {
			const refusal = yield* refusalOf(decodePageMessage("not json"));
			assert.include(refusal.reason, "not JSON");
		}),
	);
});

describe("Snapshot.registry", () => {
	// The shape `SpellRegistry.describe` renders (#7627's plan): one row per spell, its params as
	// JSON Schema. The registry itself is an independent sibling (#7636) this module may not
	// import, so the rows are written out here at the shape it emits.
	const described: RegistryDescription = [
		{
			path: ["help"],
			describe: "Show what a spell does.",
			params: {type: "object", properties: {path: {type: "array"}}},
			capabilities: [],
		},
		fixtures.spellDescription,
	];

	it("decodes what a registry description emits", () => {
		assert.deepStrictEqual(Schema.decodeUnknownSync(RegistryDescription)(described), described);
	});

	it.effect("rides in a Snapshot across the wire", () =>
		Effect.gen(function* () {
			const text = yield* encodeKernelMessage(
				new Snapshot({...fixtures.snapshot, registry: described}),
			);
			const decoded = yield* decodeKernelMessage(text);
			assert.strictEqual(decoded.type, "snapshot");
			if (decoded.type !== "snapshot") return;
			assert.deepStrictEqual(decoded.registry, described);
		}),
	);

	it("admits every capability family the kernel can request", () => {
		const requests: ReadonlyArray<KernelCapabilityRequest> = [
			{family: "filesystem", detail: "/tmp"},
			{family: "network"},
			{family: "process"},
			{family: "model"},
			{family: "github"},
			{family: "process-control"},
		];
		for (const request of requests) {
			assert.deepStrictEqual(Schema.decodeUnknownSync(CapabilityRequest)(request), request);
		}
	});
});

describe("Snapshot.processes", () => {
	it("decodes a projected process-table row", () => {
		const row: TableRow = {
			id: fixtures.counterProcess,
			programId: fixtures.counterRow.programId,
			parentId: Option.none(),
			ports: {increment: {kind: "count", direction: "in"}},
			stateSummary: {lifecycle: "running", revision: 3},
		};
		const wire = {...row, parentId: Option.getOrNull(row.parentId)};
		assert.deepStrictEqual(Schema.decodeUnknownSync(ProcessRow)(wire), wire);
	});
});

describe("the module's dependencies", () => {
	const here = dirname(fileURLToPath(import.meta.url));

	it("reach no process, shell, React or DOM code", () => {
		const sources = readdirSync(here).filter((name) => name.endsWith(".ts"));
		assert.isAbove(sources.length, 0);
		for (const name of sources) {
			if (name.endsWith(".unit.test.ts")) continue;
			const text = readFileSync(join(here, name), "utf8");
			for (const banned of ["../process/", "../shell/", '"react"', '"react-dom"']) {
				assert.notInclude(text, banned, `${name} reaches ${banned}`);
			}
		}
	});
});
