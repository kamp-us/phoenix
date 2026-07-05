/**
 * `stampAuthorIdentity` — the batched live-author-identity stamp (#2139). Proves the
 * three facets #2126's display-consistency AC needs on the denormalized surfaces:
 *
 *  1. A user who RENAMED after posting reflects the NEW `displayName` (the live-resolve
 *     proof — the stamp reads current `user_profile`, not the write-time `authorName`
 *     snapshot), so `actorLabel` on the stamped fields renders the current name.
 *  2. A null-`displayName` author resolves to `@username` (via the client `actorLabel`).
 *  3. A both-null author (no profile / no handle) resolves to the fixed fallback noun.
 *
 * Plus the N+1-avoidance contract: ONE batched read for the whole page, keyed by
 * distinct `authorId`, and a blank `authorId` (the `[silindi]` tombstone) is never read.
 */
import {describe, expect, it} from "@effect/vitest";
import {Effect} from "effect";
// `authorDisplayLabel` is the worker-side parity twin of the SPA's `actorLabel` (same
// display-name → @username → fallback rule; the worker cannot import the SPA module — the
// no-worker→src boundary). Asserting the client render through it proves the stamped
// fields resolve to the same label the surfaces show, without crossing that boundary.
import {AUTHOR_FALLBACK_LABEL, authorDisplayLabel} from "../pasaport/author-label.ts";
import type {ProfileIdentityRow} from "../pasaport/Pasaport.ts";
import {stampAuthorIdentity} from "./author-identity.ts";

const identity = (over: Partial<ProfileIdentityRow> & {userId: string}): ProfileIdentityRow => ({
	username: null,
	displayName: null,
	totalKarma: 0,
	...over,
});

describe("stampAuthorIdentity — live author identity on the denormalized read surfaces (#2139)", () => {
	it.effect("a RENAMED user reflects the new displayName, not the write-time snapshot", () =>
		Effect.gen(function* () {
			// The row's `authorName` snapshot is the OLD label baked in at write time.
			const rows = [{id: "def-1", authorId: "u-1", author: "Eski Ad"}];
			// The live profile read returns the CURRENT display name (the user renamed since).
			const read = (ids: ReadonlyArray<string>) =>
				Effect.succeed(
					ids.map((userId) => identity({userId, username: "ada", displayName: "Yeni Ad"})),
				);

			const [stamped] = yield* stampAuthorIdentity(read, rows);

			expect(stamped?.authorDisplayName).toBe("Yeni Ad");
			expect(stamped?.authorUsername).toBe("ada");
			// The client renders the live name (parity twin of `actorLabel`) — the new name,
			// never the "Eski Ad" snapshot.
			expect(
				authorDisplayLabel({name: stamped?.authorDisplayName, username: stamped?.authorUsername}),
			).toBe("Yeni Ad");
		}),
	);

	it.effect("a null displayName falls back to @username", () =>
		Effect.gen(function* () {
			const rows = [{id: "p-1", authorId: "u-2", author: "@ada"}];
			const read = () =>
				Effect.succeed([identity({userId: "u-2", username: "ada", displayName: null})]);

			const [stamped] = yield* stampAuthorIdentity(read, rows);

			expect(stamped?.authorDisplayName).toBeNull();
			expect(stamped?.authorUsername).toBe("ada");
			expect(
				authorDisplayLabel({name: stamped?.authorDisplayName, username: stamped?.authorUsername}),
			).toBe("@ada");
		}),
	);

	it.effect("a both-null author resolves to the fixed fallback noun", () =>
		Effect.gen(function* () {
			const rows = [{id: "c-1", authorId: "u-3", author: AUTHOR_FALLBACK_LABEL}];
			// No profile row for this author (an id absent from the batched read).
			const read = () => Effect.succeed<ProfileIdentityRow[]>([]);

			const [stamped] = yield* stampAuthorIdentity(read, rows);

			expect(stamped?.authorDisplayName).toBeNull();
			expect(stamped?.authorUsername).toBeNull();
			expect(
				authorDisplayLabel({name: stamped?.authorDisplayName, username: stamped?.authorUsername}),
			).toBe(AUTHOR_FALLBACK_LABEL);
		}),
	);

	it.effect("ONE batched read over DISTINCT authorIds — the N+1-avoidance contract", () =>
		Effect.gen(function* () {
			const rows = [
				{id: "a", authorId: "u-1", author: "x"},
				{id: "b", authorId: "u-2", author: "y"},
				{id: "c", authorId: "u-1", author: "z"}, // same author as row `a`
			];
			const calls: Array<ReadonlyArray<string>> = [];
			const read = (ids: ReadonlyArray<string>) => {
				calls.push(ids);
				return Effect.succeed(ids.map((userId) => identity({userId, displayName: `Ad ${userId}`})));
			};

			const stamped = yield* stampAuthorIdentity(read, rows);

			// Exactly one read, over the two DISTINCT ids (u-1 once, not twice).
			expect(calls.length).toBe(1);
			expect([...(calls[0] ?? [])].sort()).toEqual(["u-1", "u-2"]);
			// Both rows of u-1 get the same live identity from the single read.
			expect(stamped[0]?.authorDisplayName).toBe("Ad u-1");
			expect(stamped[2]?.authorDisplayName).toBe("Ad u-1");
		}),
	);

	it.effect("a blank authorId (the `[silindi]` tombstone) is never read and stamps null", () =>
		Effect.gen(function* () {
			const rows = [{id: "c-1", authorId: "", author: "[silindi]"}];
			let called = false;
			const read = (ids: ReadonlyArray<string>) => {
				called = true;
				return Effect.succeed(ids.map((userId) => identity({userId})));
			};

			const [stamped] = yield* stampAuthorIdentity(read, rows);

			// No id to resolve ⇒ the reader is never invoked (empty-id short-circuit).
			expect(called).toBe(false);
			expect(stamped?.authorUsername).toBeNull();
			expect(stamped?.authorDisplayName).toBeNull();
		}),
	);
});
