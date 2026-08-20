/**
 * The verify probe's pure core: the request it builds and the statuses it accepts. Both are the
 * #6520 fix — the probe used to be built with no authorization header, so GitHub answered `404` on
 * every healthy upload and no `review-ui` verdict could post.
 */
import {describe, expect, it} from "@effect/vitest";
import {classifyProbe, probeRequest} from "./upload-leg.ts";

const HOSTED = "https://github.com/user-attachments/assets/0a1b2c3d-4e5f-6789-abcd-ef0123456789";

describe("probeRequest", () => {
	it("carries the upload token in the same `token <t>` spelling the upload sends", () => {
		const request = probeRequest(HOSTED, "ghp_probe");
		expect(request.headers.authorization).toBe("token ghp_probe");
	});

	it("probes the hosted URL itself with a GET", () => {
		const request = probeRequest(HOSTED, "ghp_probe");
		expect(request.method).toBe("GET");
		expect(request.url).toBe(HOSTED);
	});
});

describe("classifyProbe", () => {
	it("accepts the 302 the authenticated probe answers with, and the 200 behind it", () => {
		expect(classifyProbe(302)).toBeNull();
		expect(classifyProbe(200)).toBeNull();
	});

	it("keeps a 404 a failure — a URL that does not resolve is not evidence (#3925)", () => {
		expect(classifyProbe(404)).toMatch(/probed back HTTP 404/);
		expect(classifyProbe(500)).toMatch(/probed back HTTP 500/);
	});
});
