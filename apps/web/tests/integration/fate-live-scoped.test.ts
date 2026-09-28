/**
 * Live views over SSE — the auth-only half, on the run-scoped SHARED stage (ADR 0104 step 7,
 * #1027). Split from `fate-live.test.ts`: the global `topic:posts` cases (which interleave frames
 * under concurrency and can't share a worker) live in `fate-live-posts.test.ts` on a DEDICATED
 * stage, and the args-scoped `definition.add → appendNode` delivery is proven by
 * `fate-live-owner-fence.test.ts`, which drives that same subscribe → add → frame path.
 *
 * The 401 case never touches a topic DO, so it is shared-safe.
 */
import {describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";

const h = sharedStack();

describe("live views — /fate/live (auth gate)", () => {
	it("rejects a connect with no session cookie (401)", async () => {
		const res = await h.req("/fate/live?connectionId=no-cookie", {
			headers: {accept: "text/event-stream"},
		});
		expect(res.status).toBe(401);
		await res.body?.cancel();
	});
});
