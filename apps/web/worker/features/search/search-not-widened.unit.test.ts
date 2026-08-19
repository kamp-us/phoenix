/**
 * Search is NOT widened by the #6423 in-place opt-in (#6424, epic #4306).
 *
 * The opt-in widens *in-place* reads — a post in its feed, a definition on its term
 * page. Search is discovery: it ranks over a corpus, so admitting sandboxed rows there
 * would surface newcomer content out of context and shift the bm25 ranking of everything
 * around it. `searchPosts` masks through the shared `postVisibleWhere` seam, so nothing
 * inside `Search` could refuse the widening — the narrowing has to happen where the
 * viewer is resolved, and this asserts it does: the resolver hands `Search` a viewer with
 * `seesSandboxedInPlace: false` even for an opted-in yazar the flag is on for.
 */
import {assert, describe, it} from "@effect/vitest";
import {AgentAuthority, CurrentActor, human, RelationStore} from "@kampus/authz";
import {CurrentUser} from "@kampus/fate-effect";
import {Effect, Layer} from "effect";
import {emptyKeysetPage} from "../../db/keyset.ts";
import {inPlaceVisibilityLayer} from "../kunye/sandbox.testing.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {lists} from "./lists.ts";
import {Search} from "./Search.ts";

const VIEWER = {id: "opted-in-yazar", email: "kaan@kamp.us", name: "kaan", image: null};
const OPTED_IN_AT = new Date("2026-08-19T00:00:00.000Z");

// A `moderates`-tuple store nobody is in, so the moderator axis stays false and the
// assertion isolates the opt-in.
const noModerators = {
	has: () => Effect.succeed(false),
	hasSubjects: () => Effect.succeed(new Set<string>()),
	subjectsOf: () => Effect.succeed(new Set<string>()),
} as never;

/** Run `searchPosts` for an opted-in yazar and return the viewer `Search` was handed. */
const viewerHandedToSearch = Effect.gen(function* () {
	const seen: SandboxViewer[] = [];
	// biome-ignore lint/plugin: a service double — only `searchPosts` is on this path, and it captures the viewer it was handed.
	const SearchStub = Layer.succeed(Search, {
		searchTerms: () => Effect.die(new Error("searchPosts must not search terms")),
		searchPosts: (opts: {viewer?: SandboxViewer | undefined}) =>
			Effect.sync(() => {
				if (opts.viewer) seen.push(opts.viewer);
				return emptyKeysetPage;
			}),
	} as unknown as typeof Search.Service);

	yield* lists.searchPosts.resolve({args: {query: "yazilim"}, select: []}).pipe(
		Effect.provide(SearchStub),
		Effect.provideService(CurrentUser, {user: VIEWER}),
		Effect.provideService(CurrentActor, {actor: human(VIEWER.id)}),
		Effect.provideService(AgentAuthority, {admits: () => Effect.succeed(false)}),
		Effect.provideService(RelationStore, noModerators),
		Effect.provide(
			inPlaceVisibilityLayer({
				flagOn: true,
				tier: "yazar",
				preference: {optedIn: true, setAt: OPTED_IN_AT},
			}),
		),
	);

	const viewer = seen[0];
	assert.isDefined(viewer, "`Search.searchPosts` received a viewer");
	return viewer;
});

describe("searchPosts — the in-place opt-in never reaches the search mask (#6424)", () => {
	it.effect("an opted-in yazar's search viewer carries seesSandboxedInPlace: false", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* viewerHandedToSearch, {
				viewerId: VIEWER.id,
				canSeeSandboxed: false,
				seesSandboxedInPlace: false,
			});
		}),
	);
});
