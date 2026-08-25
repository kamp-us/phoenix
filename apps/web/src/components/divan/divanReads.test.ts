import {describe, expect, it, vi} from "vitest";
import {promoteRefreshWarranted} from "./divanGating";
import {divanBacklogRequest, divanRosterRequest, refreshDivanReview} from "./divanReads";

describe("divan request builders — the one shape both the mounted read and the refresh use (#7036)", () => {
	it("the roster request names the gated divan.roster root with its page size", () => {
		expect(divanRosterRequest()).toEqual({
			"divan.roster": {list: expect.anything(), args: {first: 50}},
		});
	});

	it("the backlog request scopes to the open author", () => {
		expect(divanBacklogRequest("u-1")).toEqual({
			"divan.backlog": {list: expect.anything(), args: {authorId: "u-1", first: 50}},
		});
	});

	it("both builders are stable across calls, so a re-driven request hits the same keys", () => {
		expect(divanRosterRequest()).toEqual(divanRosterRequest());
		expect(divanBacklogRequest("u-1")).toEqual(divanBacklogRequest("u-1"));
	});
});

describe("refreshDivanReview — one network-only re-pull of both review roots (#7036)", () => {
	it("issues ONE network-only request carrying both roots", () => {
		const client = {request: vi.fn(async () => ({}))};
		void refreshDivanReview(client as never, "u-1");
		expect(client.request).toHaveBeenCalledTimes(1);
		expect(client.request).toHaveBeenCalledWith(
			{
				"divan.roster": {list: expect.anything(), args: {first: 50}},
				"divan.backlog": {list: expect.anything(), args: {authorId: "u-1", first: 50}},
			},
			{mode: "network-only"},
		);
	});

	it("returns the client's promise so the caller can swallow a failed refresh", async () => {
		const marker = Symbol("done");
		const client = {request: vi.fn(async () => marker)};
		await expect(refreshDivanReview(client as never, "u-1")).resolves.toBe(marker);
	});
});

describe("promoteRefreshWarranted — which outcomes re-pull the reads (#7036)", () => {
	it("a flip refreshes", () => {
		expect(promoteRefreshWarranted("promoted")).toBe(true);
	});
	it("an already-yazar answer means the screen was already stale, so it refreshes too", () => {
		expect(promoteRefreshWarranted("alreadyYazar")).toBe(true);
	});
	it("denied and errored attempts leave the rendering untouched", () => {
		expect(promoteRefreshWarranted("denied")).toBe(false);
		expect(promoteRefreshWarranted("error")).toBe(false);
	});
});
