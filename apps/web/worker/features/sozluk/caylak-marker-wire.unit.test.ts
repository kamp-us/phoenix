/**
 * The reader-facing çaylak marker on the sözlük `Definition` wire shape (#6425) — the
 * third surface of the slice, the twin of `pano/caylak-marker-wire.unit.test.ts`.
 * Driven through the REAL `Sozluk.getDefinitionsByIds` over a substituted `Drizzle`
 * access plus service doubles, then through the real `toDefinition` shaper, so what is
 * asserted is the object a client receives.
 *
 * Tier note: see the pano twin's header — the integration tier can neither seed a
 * sandboxed row nor flip `PHOENIX_CAYLAK_VISIBILITY`, so the viewer shapes the
 * acceptance criteria name are proven here.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import type {ReactionEmoji} from "../../db/reaction-emoji.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {makePasaportStub} from "../pasaport/Pasaport.testing.ts";
import {Reaction, type ReactionAggregate} from "../reaction/Reaction.ts";
import {Vote} from "../vote/Vote.ts";
import {Sozluk, SozlukLive} from "./Sozluk.ts";
import {toDefinition} from "./shapers.ts";

const CAYLAK = "u-caylak";
const YAZAR = "u-yazar";
const SANDBOXED_AT = new Date("2026-08-01T00:00:00.000Z");

// The same four viewer shapes the pano twin asserts, so the three surfaces are judged
// against one matrix rather than three hand-synced ones.
const viewers = {
	anonymous: {viewerId: null, canSeeSandboxed: false, seesSandboxedInPlace: false},
	notOptedInYazar: {viewerId: YAZAR, canSeeSandboxed: false, seesSandboxedInPlace: false},
	otherCaylak: {viewerId: "u-other-caylak", canSeeSandboxed: false, seesSandboxedInPlace: false},
	optedInYazar: {viewerId: YAZAR, canSeeSandboxed: false, seesSandboxedInPlace: true},
} satisfies Record<string, SandboxViewer>;

const maskedShapes = ["anonymous", "notOptedInYazar", "otherCaylak"] as const;

const definitionRecord = (over: {authorId: string; sandboxedAt: Date | null}) => ({
	id: "def_1",
	body: "tanım gövdesi",
	bodyExcerpt: null,
	score: 3,
	author: null,
	authorId: over.authorId,
	authorName: `snapshot-${over.authorId}`,
	termSlug: "bir-baslik",
	termTitle: "bir başlık",
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-02T00:00:00.000Z"),
	removedAt: null,
	removedBy: null,
	removedReason: null,
	sandboxedAt: over.sandboxedAt,
});

// biome-ignore lint/plugin: a service double — only `readMine` is on the read path.
const VoteStub = Layer.succeed(Vote, {
	cast: () => Effect.die(new Error("read path must not cast")),
	readMine: () => Effect.succeed(new Set<string>()),
	clearTarget: () => Effect.void,
} as unknown as typeof Vote.Service);

const ReactionStub = Layer.succeed(Reaction, {
	react: () => Effect.die(new Error("read path must not react")),
	readMine: () => Effect.succeed(new Map<string, ReactionEmoji>()),
	clearTarget: () => Effect.void,
	readAggregate: () => Effect.succeed(new Map<string, ReactionAggregate>()),
} satisfies typeof Reaction.Service);

const PasaportStub = makePasaportStub({getProfileIdentitiesByIds: () => Effect.succeed([])});

// `getDefinitionsByIds` issues exactly one `run` (the fetch); `run` ignores its query fn
// (no engine) and answers the scripted row.
const scriptedAccess = (record: ReturnType<typeof definitionRecord>): DrizzleAccess => ({
	run: <A>(_fn: (db: DrizzleDb) => Promise<A>) => Effect.succeed([record] as A),
	batch: () => Effect.die(new Error("read path must not batch")),
});

// Every case below reads a row the viewer IS entitled to (masking is the
// `sandboxVisibleWhere` predicate's job, proven in `lifecycle/SandboxVisibility.unit.test.ts`),
// so an empty batch here is a broken fixture, not an expected outcome.
const only = <A>(rows: ReadonlyArray<A>): A => {
	const row = rows[0];
	if (row === undefined) throw new Error("the read returned no row");
	return row;
};

const readDefinition = (
	record: ReturnType<typeof definitionRecord>,
	sandboxViewer: SandboxViewer,
) =>
	Effect.gen(function* () {
		const sozluk = yield* Sozluk;
		const rows = yield* sozluk.getDefinitionsByIds(["def_1"], {
			viewerId: sandboxViewer.viewerId,
			sandboxViewer,
		});
		return toDefinition(only(rows));
	}).pipe(
		Effect.provide(
			SozlukLive.pipe(
				Layer.provide(VoteStub),
				Layer.provide(ReactionStub),
				Layer.provide(PasaportStub),
				Layer.provide(Layer.succeed(Drizzle, scriptedAccess(record))),
			),
		),
	);

const caylakSandboxed = () => definitionRecord({authorId: CAYLAK, sandboxedAt: SANDBOXED_AT});
const yazarLive = () => definitionRecord({authorId: YAZAR, sandboxedAt: null});

describe("Definition — the çaylak marker on the wire (#6425)", () => {
	it.effect("an opted-in yazar receives it true on a çaylak's sandboxed definition", () =>
		Effect.gen(function* () {
			const definition = yield* readDefinition(caylakSandboxed(), viewers.optedInYazar);
			assert.isTrue(definition.sandboxedInPlace);
			// The owner-scoped field is untouched: this reader is not the author.
			assert.isFalse(definition.sandboxed);
		}),
	);

	it.effect("the same yazar receives it false on a yazar-authored live definition", () =>
		Effect.gen(function* () {
			const definition = yield* readDefinition(yazarLive(), viewers.optedInYazar);
			assert.isFalse(definition.sandboxedInPlace);
		}),
	);

	for (const shape of maskedShapes) {
		it.effect(`${shape} never receives it on a çaylak's sandboxed definition`, () =>
			Effect.gen(function* () {
				const definition = yield* readDefinition(caylakSandboxed(), viewers[shape]);
				assert.isFalse(definition.sandboxedInPlace);
			}),
		);
	}

	it.effect("with PHOENIX_CAYLAK_VISIBILITY off it is false for every viewer shape", () =>
		Effect.gen(function* () {
			for (const viewer of Object.values(viewers)) {
				const definition = yield* readDefinition(caylakSandboxed(), {
					...viewer,
					seesSandboxedInPlace: false,
				});
				assert.isFalse(definition.sandboxedInPlace);
			}
		}),
	);
});
