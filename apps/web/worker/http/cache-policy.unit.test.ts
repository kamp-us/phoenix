import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {describe, expect, it} from "vitest";
import {CachePolicyLive, privateResponse} from "./cache-policy.ts";

describe("worker response caching", () => {
	it("defaults headerless responses to no-store while preserving the public feed policy", async () => {
		const {handler, dispose} = HttpRouter.toWebHandler(
			Layer.mergeAll(
				HttpRouter.add("GET", "/session", HttpServerResponse.jsonUnsafe(null)),
				HttpRouter.add("GET", "/hidden", HttpServerResponse.empty({status: 404})),
				HttpRouter.add(
					"GET",
					"/fresh",
					HttpServerResponse.empty({
						headers: {"cache-control": "no-store"},
					}),
				),
				HttpRouter.add(
					"GET",
					"/feed",
					HttpServerResponse.jsonUnsafe([], {
						headers: {"cache-control": "public, s-maxage=30", "cache-tag": "pano-feed"},
					}),
				),
				CachePolicyLive,
			),
			{disableLogger: true},
		);
		try {
			const session = await handler(new Request("https://worker.test/session"));
			expect(session.headers.get("cache-control")).toBe("private, no-store");
			expect(await session.json()).toBeNull();
			const hidden = await handler(new Request("https://worker.test/hidden"));
			expect(hidden.status).toBe(404);
			expect(hidden.headers.get("cache-control")).toBe("private, no-store");
			const fresh = await handler(new Request("https://worker.test/fresh"));
			expect(fresh.headers.get("cache-control")).toBe("no-store");
			const feed = await handler(new Request("https://worker.test/feed"));
			expect(feed.headers.get("cache-control")).toBe("public, s-maxage=30");
			expect(feed.headers.get("cache-tag")).toBe("pano-feed");
		} finally {
			await dispose();
		}
	});

	it("replaces inherited CDN caching on private responses without losing cookies or body", async () => {
		const response = HttpServerResponse.fromWeb(
			new Response("personalized", {
				headers: {
					"cache-control": "public, max-age=3600",
					"cdn-cache-control": "public, max-age=3600",
					"cloudflare-cdn-cache-control": "public, max-age=7200",
					expires: "Wed, 01 Jan 2031 00:00:00 GMT",
					"set-cookie": "session=fixture; HttpOnly",
				},
			}),
		);
		const web = HttpServerResponse.toWeb(privateResponse(response));
		expect(web.headers.get("cache-control")).toBe("private, no-store");
		for (const name of ["cdn-cache-control", "cloudflare-cdn-cache-control", "expires"]) {
			expect(web.headers.has(name)).toBe(false);
		}
		expect(web.headers.get("set-cookie")).toBe("session=fixture; HttpOnly");
		expect(await web.text()).toBe("personalized");
	});
});
