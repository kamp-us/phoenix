/**
 * The dark-ship default-=-safe-state invariant for pano taslak (draft-save), #746.
 * Two proofs the AC names:
 *
 *   (a) IaC default-off — the `panoDraftSaveFlag` config ships `defaultVariation:
 *       "off"` and `variations.off === false`. Inspected off the exported
 *       `PANO_DRAFT_SAVE_FLAG` record (the same object the factory spreads into
 *       `FlagshipFlag`), so no alchemy resource is constructed.
 *
 *   (b) Mutation gate — with `Flags` stubbed OFF, `post.saveDraft` fails
 *       `DraftsDisabled` and NEVER touches the service (the dark path is
 *       unreachable even if a client bypasses the UI). With `Flags` stubbed ON, it
 *       calls `Pano.saveDraft` and returns a `Post` carrying `isDraft: true`.
 *
 * Wire-boundary unit test (ADR 0082): the `Pano`/`Flags`/`LivePublisher` seams are
 * substituted directly — no DB, no Flagship binding. Mirrors
 * `report-mutation.unit.test.ts` (handler-drive + `CurrentUser`) and
 * `Flags.unit.test.ts` (Flagship-free `Flags` stub).
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {Flags} from "../flagship/Flags.ts";
import {PANO_DRAFT_SAVE_FLAG, panoDraftSaveFlag} from "../flagship/resources.ts";
import {mutations} from "./mutations.ts";
import {Pano, type SaveDraftResult} from "./Pano.ts";

const AUTHOR = {id: "u-author", email: "elif@example.com", name: "elif"};

const runtimeContextStub: BaseRuntimeContext = {
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

// A `Flags` whose `getBoolean` returns a fixed value — the only method the gate
// calls. Every typed read dies so an accidental call is loud.
const flagsStub = (value: boolean): Layer.Layer<Flags> =>
	Layer.succeed(Flags, {
		getBoolean: () => Effect.succeed(value),
		getString: () => Effect.die("getString not exercised"),
		getNumber: () => Effect.die("getNumber not exercised"),
		getObject: () => Effect.die("getObject not exercised"),
	} as typeof Flags.Service);

// A `LivePublisher` that records nothing — the publish is fire-and-forget and its
// error channel is `never`, so it can never fail the mutation.
const liveStub = Layer.succeed(LivePublisher)(
	livePublisherFor({publish: () => Effect.void, waitUntil: () => {}}),
);

// A `Pano` stub whose `saveDraft` is scripted; every other method dies. Cast to the
// full service tag — the gate path only ever reaches `saveDraft`.
const panoStub = (saveDraft: (typeof Pano.Service)["saveDraft"]): Layer.Layer<Pano> =>
	Layer.succeed(
		Pano,
		new Proxy({saveDraft} as Partial<typeof Pano.Service>, {
			get(target, prop) {
				if (prop in target) return (target as Record<string, unknown>)[prop as string];
				return () => Effect.die(`Pano.${String(prop)} not exercised in draft-save.invariant`);
			},
		}) as typeof Pano.Service,
	);

const draftRow: SaveDraftResult = {
	postId: "post_draft1",
	title: "yarım kalmış",
	url: null,
	host: null,
	body: null,
	authorId: AUTHOR.id,
	authorName: AUTHOR.name,
	score: 0,
	commentCount: 0,
	tags: [],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	isDraft: true,
};

const saveDraft = (
	pano: Layer.Layer<Pano>,
	flags: Layer.Layer<Flags>,
	user: typeof AUTHOR | undefined = AUTHOR,
) =>
	mutations["post.saveDraft"]
		.handler({
			input: {title: "yarım kalmış"},
			select: ["id", "title", "isDraft"],
		})
		.pipe(
			Effect.provide(Layer.mergeAll(pano, flags, liveStub)),
			Effect.provideService(CurrentUser, {user}),
			Effect.provideService(RuntimeContext, runtimeContextStub),
		);

describe("pano draft-save — (a) IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(PANO_DRAFT_SAVE_FLAG.defaultVariation, "off");
		assert.strictEqual(PANO_DRAFT_SAVE_FLAG.variations.off, false);
		assert.strictEqual(PANO_DRAFT_SAVE_FLAG.variations.on, true);
		assert.strictEqual(PANO_DRAFT_SAVE_FLAG.key, "pano-draft-save");
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof panoDraftSaveFlag, "function");
	});
});

describe("pano draft-save — (b) the mutation gate is the safe default", () => {
	it.effect("flag OFF → DraftsDisabled, and Pano.saveDraft is never called", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				saveDraft(
					panoStub(() => Effect.die("Pano.saveDraft ran with the flag off")),
					flagsStub(false),
				),
			);
			assert.isTrue(exit._tag === "Failure", "off-path fails");
			assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /DraftsDisabled/);
		}),
	);

	it.effect("flag ON → Pano.saveDraft runs and the returned Post carries isDraft: true", () =>
		Effect.gen(function* () {
			const post = yield* saveDraft(
				panoStub(() => Effect.succeed(draftRow)),
				flagsStub(true),
			);
			assert.strictEqual((post as {isDraft?: boolean}).isDraft, true);
			assert.strictEqual((post as {id?: string}).id, "post_draft1");
		}),
	);
});
