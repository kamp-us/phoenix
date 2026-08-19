/**
 * `stampAuthorIdentity` — the batched live-author-identity stamp (#2139), covering the
 * display-consistency AC of #2126 plus the N+1-avoidance contract.
 */
import {describe, expect, it} from "@effect/vitest";
import {Effect} from "effect";
// `authorDisplayLabel` is the worker-side parity twin of the SPA's `actorLabel`; the
// worker cannot import the SPA module, so asserting the render through it is how the
// label is checked without crossing that boundary.
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
			// `author` is the OLD label baked in at write time; the read below returns the
			// CURRENT one.
			const rows = [{id: "def-1", authorId: "u-1", author: "Eski Ad"}];
			const read = (ids: ReadonlyArray<string>) =>
				Effect.succeed(
					ids.map((userId) => identity({userId, username: "ada", displayName: "Yeni Ad"})),
				);

			const [stamped] = yield* stampAuthorIdentity(read, rows);

			expect(stamped?.authorDisplayName).toBe("Yeni Ad");
			expect(stamped?.authorUsername).toBe("ada");
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

			expect(calls.length).toBe(1);
			expect([...(calls[0] ?? [])].sort()).toEqual(["u-1", "u-2"]);
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

			expect(called).toBe(false);
			expect(stamped?.authorUsername).toBeNull();
			expect(stamped?.authorDisplayName).toBeNull();
		}),
	);
});
