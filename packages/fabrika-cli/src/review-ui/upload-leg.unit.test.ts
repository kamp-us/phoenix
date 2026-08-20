/**
 * The verify probe's pure core: the request it builds and the statuses it accepts. Both are the
 * #6520 fix — the probe used to be built with no authorization header, so GitHub answered `404` on
 * every healthy upload and no `review-ui` verdict could post.
 */
import {describe, expect, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {fakeHttp, fakeShell} from "../fakes.test-support.ts";
import {NO_TOKEN} from "../io/gh-api.ts";
import {classifyProbe, githubAttachmentUploadLeg, probeRequest} from "./upload-leg.ts";

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

/**
 * The credential path, since the port moved it onto `../io/gh-api.ts`. Every case below runs with
 * `gh` absent from PATH, so a green here is a leg that never needed the binary.
 */
describe("githubAttachmentUploadLeg over the fetch client", () => {
	const request = {repo: "o/r", fileName: "surface.png", bytes: new Uint8Array([1, 2, 3])};

	const run = (
		env: Readonly<Record<string, string | undefined>>,
		http: ReturnType<typeof fakeHttp>,
	) => {
		const noGh = fakeShell([], undefined, [/^gh /]);
		return Effect.runPromise(
			Effect.provide(githubAttachmentUploadLeg(env)(request), Layer.merge(noGh.layer, http.layer)),
		).then((result) => ({result, spawned: noGh.calls}));
	};

	const served = () =>
		fakeHttp([
			[/api\.github\.com\/repos\/o\/r/, {status: 200, body: JSON.stringify({id: 918})}],
			[/uploads\.github\.com/, {status: 200, body: JSON.stringify({href: HOSTED})}],
			[/user-attachments\/assets/, {status: 302, body: ""}],
		]);

	it("uploads and verifies with `gh` off PATH, passing the resolved repository id", async () => {
		const http = served();
		const {result, spawned} = await run({GITHUB_TOKEN: "ghp_scripted"}, http);
		expect(result).toEqual({_tag: "Hosted", url: HOSTED});
		expect(spawned).toEqual([]);
		expect(http.calls[0]).toBe("GET https://api.github.com/repos/o/r");
		expect(http.calls[1]).toContain("repository_id=918");
	});

	it("refuses naming both env vars when nothing resolves a token, and reads nothing", async () => {
		const http = served();
		const {result} = await run({}, http);
		expect(result).toEqual({_tag: "Failed", reason: NO_TOKEN});
		expect(http.calls).toEqual([]);
	});

	it("refuses when the repository id is unreadable — the endpoint 404s without it", async () => {
		const http = fakeHttp([[/api\.github\.com\/repos/, {status: 404, body: "{}"}]]);
		const {result} = await run({GITHUB_TOKEN: "ghp_scripted"}, http);
		expect(result).toEqual({_tag: "Failed", reason: "cannot resolve o/r's numeric id"});
	});

	it("keeps a failed probe a refusal rather than evidence (#3925)", async () => {
		const http = fakeHttp([
			[/api\.github\.com\/repos\/o\/r/, {status: 200, body: JSON.stringify({id: 918})}],
			[/uploads\.github\.com/, {status: 200, body: JSON.stringify({href: HOSTED})}],
			[/user-attachments\/assets/, {status: 404, body: ""}],
		]);
		const {result} = await run({GITHUB_TOKEN: "ghp_scripted"}, http);
		expect(result).toEqual({_tag: "Failed", reason: "the hosted asset probed back HTTP 404"});
	});
});
