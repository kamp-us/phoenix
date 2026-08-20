/**
 * The parent-term re-read in `definition.delete` and `definition.restore` carries the acting
 * author's identity (#6473).
 *
 * `Sozluk.getTerm` masks the term's definitions on the sandbox dimension, so a re-read handed
 * no viewer resolved anonymously and dropped the author's own still-sandboxed rows: the
 * returned `Term` under-counted them, and `definition.restore`'s `page.definitions.find` then
 * missed the row it had just restored, skipping the term-topic re-append.
 *
 * The term row itself is never sandboxed, so — unlike the pano handlers this shares an issue
 * with — the page comes back non-null either way; what moves is which definitions it carries.
 * The stub filters through the real `lifecycleVisibilityRule` rather than restating the mask.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {
	lifecycleVisibilityRule,
	ruleVisibleTo,
	type SandboxViewer,
} from "../lifecycle/EntityLifecycle.ts";
import {resolveSandboxViewer} from "../lifecycle/SandboxVisibility.ts";
import type {DefinitionRow, TermPage} from "./definition-fields.ts";
import {mutations} from "./mutations.ts";
import {Sozluk} from "./Sozluk.ts";

const AUTHOR = {id: "u-caylak", email: "caylak@kamp.us", name: "çaylak"};
const OTHER_MEMBER = {id: "u-yazar", email: "yazar@kamp.us", name: "yazar"};
const SLUG = "kamp-us";
const DEFINITION_ID = "def_sb1";

const runtimeContextStub: BaseRuntimeContext = {
	Type: "mutation-term-reread-viewer",
	id: "mutation-term-reread-viewer",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

/** The çaylak's own still-sandboxed definition, the only row on the term. */
const sandboxedDefinition: DefinitionRow = {
	id: DEFINITION_ID,
	body: "tanım",
	score: 3,
	author: "çaylak",
	authorId: AUTHOR.id,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const termPageFor = (definitions: DefinitionRow[]): TermPage => ({
	id: SLUG,
	slug: SLUG,
	title: "kamp us",
	totalDefinitions: definitions.length,
	totalScore: definitions.reduce((s, d) => s + d.score, 0),
	firstAt: sandboxedDefinition.createdAt,
	lastEdit: sandboxedDefinition.updatedAt,
	definitions,
});

const noopLive = Layer.succeed(LivePublisher)(
	livePublisherFor({publish: () => Effect.void, waitUntil: () => {}}),
);

/**
 * Every service the two handlers reach. `getTerm` applies the REAL sandbox rule to the viewer
 * the call site resolved, so a call that omits the viewer masks exactly as D1 does.
 */
const contextFor = (user: typeof AUTHOR) =>
	Layer.mergeAll(
		// biome-ignore lint/plugin: a service double — the writes are scripted and only the term re-read is under test.
		Layer.succeed(Sozluk, {
			lookupDefinitionTermSlug: () => Effect.succeed(SLUG),
			deleteDefinition: () => Effect.succeed({definitionId: DEFINITION_ID, deleted: true}),
			restoreDefinition: () =>
				Effect.succeed({definitionId: DEFINITION_ID, deleted: false, sandboxedAt: new Date()}),
			getTerm: (_slug: string, opts?: {viewerId?: string | null; sandboxViewer?: SandboxViewer}) =>
				Effect.sync(() => {
					const viewer = resolveSandboxViewer(opts ?? {});
					return termPageFor(
						[sandboxedDefinition].filter((d) =>
							ruleVisibleTo(lifecycleVisibilityRule.Sandboxed, d.authorId, viewer),
						),
					);
				}),
		} as unknown as typeof Sozluk.Service),
		noopLive,
		Layer.succeed(CurrentUser, {user}),
		Layer.succeed(RuntimeContext, runtimeContextStub),
	);

// Named at each call site rather than looked up from a union, so `resolveWire`'s inference
// survives — matching `../pano/mutation-parent-reread-viewer.unit.test.ts`.
const HANDLERS = [
	{
		name: "definition.delete",
		run: (ctx: ReturnType<typeof contextFor>) =>
			resolveWire(mutations["definition.delete"], {
				input: {id: DEFINITION_ID},
				select: ["id", "count"],
			}).pipe(Effect.provide(ctx)),
	},
	{
		name: "definition.restore",
		run: (ctx: ReturnType<typeof contextFor>) =>
			resolveWire(mutations["definition.restore"], {
				input: {id: DEFINITION_ID},
				select: ["id", "count"],
			}).pipe(Effect.provide(ctx)),
	},
] as const;

describe("the sözlük term re-reads carry the acting author (#6473)", () => {
	for (const handler of HANDLERS) {
		it.effect(`${handler.name} returns a term page carrying the author's own sandboxed row`, () =>
			Effect.gen(function* () {
				const term = yield* handler.run(contextFor(AUTHOR));
				assert.isNotNull(term, `${handler.name} answered null on a write that landed`);
				assert.strictEqual(term?.count, 1);
			}),
		);

		it.effect(`${handler.name} still masks the sandboxed row from another member`, () =>
			Effect.gen(function* () {
				assert.strictEqual((yield* handler.run(contextFor(OTHER_MEMBER)))?.count, 0);
			}),
		);
	}
});
