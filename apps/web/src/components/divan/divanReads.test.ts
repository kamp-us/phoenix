import {describe, expect, it, vi} from "vitest";
import {refreshDivanReview} from "./divanReads";

// The request shapes, the one network-only refresh and which promote outcomes warrant it are
// read off the real component in `CaylakDetail.promote-refresh.test.tsx` (#7036).
describe("refreshDivanReview — one network-only re-pull of both review roots (#7036)", () => {
	it("returns the client's promise so the caller can swallow a failed refresh", async () => {
		const marker = Symbol("done");
		const client = {request: vi.fn(async () => marker)};
		await expect(refreshDivanReview(client as never, "u-1")).resolves.toBe(marker);
	});
});
