/**
 * The two legs over a scripted transport; the read-back's pure core is tested beside it in
 * `../io/attachment-read-back.unit.test.ts`. The read-back exists
 * because a fresh user-attachment URL reads `404` at its own address until something posted embeds
 * it, so the leg proves the upload through GitHub's renderer instead: the signed link it
 * rewrites the URL into must serve `200` with the capture's exact bytes.
 */
import {describe, expect, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {fakeHttp, fakeShell} from "../fakes.test-support.ts";
import {NO_TOKEN} from "../io/gh-api.ts";
import {
	githubAttachmentUploadLeg,
	githubPostedEvidenceCheck,
	renderedCommentCall,
} from "./upload-leg.ts";

const UUID = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";
const HOSTED = `https://github.com/user-attachments/assets/${UUID}`;
const SIGNED = `https://private-user-images.githubusercontent.com/1783869/657136403-${UUID}.png?jwt=a.b.c&X-Amz-Expires=300`;
/** GitHub's renderer output for one stored asset, `&` entity-escaped as the live HTML carries it. */
const rendered = (src: string = SIGNED): string =>
	`<p dir="auto"><a target="_blank" href="${src.replaceAll("&", "&amp;")}"><img src="${src.replaceAll("&", "&amp;")}" alt="evidence" style="max-width: 100%;"></a></p>`;
const BYTES = new Uint8Array([1, 2, 3]);
const BYTES_BODY = "\u0001\u0002\u0003";

describe("renderedCommentCall", () => {
	it("reads the posted comment as the HTML a reader's browser renders", () => {
		expect(renderedCommentCall("o/r", 42)).toEqual({
			method: "GET",
			path: "repos/o/r/issues/comments/42",
			accept: "application/vnd.github.html+json",
		});
	});
});

const noGh = () => fakeShell([], undefined, [/^gh /]);

/**
 * The credential path, since the port moved it onto `../io/gh-api.ts`. Every case below runs with
 * `gh` absent from PATH, so a green here is a leg that never needed the binary.
 */
describe("githubAttachmentUploadLeg over the fetch client", () => {
	const request = {repo: "o/r", fileName: "surface.png", bytes: BYTES};

	const run = (
		env: Readonly<Record<string, string | undefined>>,
		http: ReturnType<typeof fakeHttp>,
	) => {
		const shell = noGh();
		return Effect.runPromise(
			Effect.provide(githubAttachmentUploadLeg(env)(request), Layer.merge(shell.layer, http.layer)),
		).then((result) => ({result, spawned: shell.calls}));
	};

	const REPO = /GET https:\/\/api\.github\.com\/repos\/o\/r$/;
	const UPLOAD = /POST https:\/\/uploads\.github\.com\/user-attachments\/assets\?/;
	const RENDER = /POST https:\/\/api\.github\.com\/markdown$/;
	const FETCH = /GET https:\/\/private-user-images\.githubusercontent\.com\//;

	const served = (overrides: {render?: string; fetch?: {status: number; body: string}} = {}) =>
		fakeHttp([
			[REPO, {status: 200, body: JSON.stringify({id: 918})}],
			[UPLOAD, {status: 201, body: JSON.stringify({url: HOSTED})}],
			[RENDER, {status: 200, body: overrides.render ?? rendered()}],
			[FETCH, overrides.fetch ?? {status: 200, body: BYTES_BODY}],
		]);

	it("sends the four requests in order — repo id, upload, render, anonymous fetch", async () => {
		const http = served();
		const {result, spawned} = await run({GITHUB_TOKEN: "ghp_scripted"}, http);
		expect(result).toEqual({_tag: "Hosted", url: HOSTED});
		expect(spawned).toEqual([]);
		expect(http.calls).toHaveLength(4);
		expect(http.calls[0]).toMatch(REPO);
		expect(http.calls[1]).toMatch(UPLOAD);
		const upload = new URL((http.calls[1] ?? "").replace(/^POST /, "")).searchParams;
		expect(Object.fromEntries(upload)).toEqual({
			repository_id: "918",
			name: "surface.png",
			size: "3",
			content_type: "image/png",
		});
		expect(http.headers[1]?.authorization).toBe("token ghp_scripted");
		expect(http.calls[2]).toMatch(RENDER);
		expect(JSON.parse(http.bodies[2] ?? "")).toEqual({
			text: `![evidence](${HOSTED})`,
			mode: "gfm",
			context: "o/r",
		});
		expect(http.headers[2]?.authorization).toBe("token ghp_scripted");
		expect(http.calls[3]).toBe(`GET ${SIGNED}`);
		expect(http.headers[3]?.authorization).toBeUndefined();
	});

	it("never probes the fresh URL itself — it reads 404 until something posted embeds it", async () => {
		const http = served();
		await run({GITHUB_TOKEN: "ghp_scripted"}, http);
		expect(http.calls.some((call) => call.startsWith(`GET ${HOSTED}`))).toBe(false);
	});

	it("refuses naming both env vars when nothing resolves a token, and reads nothing", async () => {
		const http = served();
		const {result} = await run({}, http);
		expect(result).toEqual({_tag: "Failed", reason: NO_TOKEN});
		expect(http.calls).toEqual([]);
	});

	it("refuses when the repository id is unreadable — the endpoint 404s without it", async () => {
		const http = fakeHttp([[REPO, {status: 404, body: "{}"}]]);
		const {result} = await run({GITHUB_TOKEN: "ghp_scripted"}, http);
		expect(result).toEqual({_tag: "Failed", reason: "cannot resolve o/r's numeric id"});
	});

	it("keeps a 404 on the served link a refusal rather than evidence (#3925)", async () => {
		const http = served({fetch: {status: 404, body: ""}});
		const {result} = await run({GITHUB_TOKEN: "ghp_scripted"}, http);
		expect(result).toEqual({_tag: "Failed", reason: "the hosted asset probed back HTTP 404"});
	});

	it("refuses when the served link answers 200 with other bytes", async () => {
		const http = served({fetch: {status: 200, body: "\u0009\u0009\u0009"}});
		const {result} = await run({GITHUB_TOKEN: "ghp_scripted"}, http);
		expect(result).toMatchObject({_tag: "Failed", reason: expect.stringMatching(/not the 3-byte/)});
	});

	it("refuses when the renderer leaves the asset unsigned — the upload stored nothing", async () => {
		const http = served({render: `<p><a href="${HOSTED}">${HOSTED}</a></p>`});
		const {result} = await run({GITHUB_TOKEN: "ghp_scripted"}, http);
		expect(result).toMatchObject({_tag: "Failed", reason: expect.stringMatching(/no served link/)});
		expect(http.calls).toHaveLength(3);
	});

	it("refuses when the renderer cannot be read", async () => {
		const http = fakeHttp([
			[REPO, {status: 200, body: JSON.stringify({id: 918})}],
			[UPLOAD, {status: 201, body: JSON.stringify({url: HOSTED})}],
			[RENDER, {status: 502, body: "bad gateway"}],
		]);
		const {result} = await run({GITHUB_TOKEN: "ghp_scripted"}, http);
		expect(result).toMatchObject({_tag: "Failed", reason: expect.stringMatching(/HTTP 502/)});
	});
});

describe("githubPostedEvidenceCheck over the fetch client", () => {
	const COMMENT = /GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/comments\/42$/;
	const FETCH = /GET https:\/\/private-user-images\.githubusercontent\.com\//;
	const check = {repo: "o/r", commentId: 42, evidence: [{url: HOSTED, bytes: BYTES}]};

	const run = (
		http: ReturnType<typeof fakeHttp>,
		env: Readonly<Record<string, string | undefined>> = {GITHUB_TOKEN: "ghp_scripted"},
	) =>
		Effect.runPromise(
			Effect.provide(githubPostedEvidenceCheck(env)(check), Layer.merge(noGh().layer, http.layer)),
		);

	it("reads the posted comment's HTML and fetches each embedded capture's served link", async () => {
		const http = fakeHttp([
			[COMMENT, {status: 200, body: JSON.stringify({body_html: rendered()})}],
			[FETCH, {status: 200, body: BYTES_BODY}],
		]);
		expect(await run(http)).toEqual({_tag: "Resolved"});
		expect(http.calls).toEqual([
			"GET https://api.github.com/repos/o/r/issues/comments/42",
			`GET ${SIGNED}`,
		]);
		expect(http.headers[0]?.accept).toBe("application/vnd.github.html+json");
	});

	it("names each capture the posted comment does not serve", async () => {
		const http = fakeHttp([
			[COMMENT, {status: 200, body: JSON.stringify({body_html: rendered()})}],
			[FETCH, {status: 404, body: ""}],
		]);
		expect(await run(http)).toEqual({
			_tag: "Unresolved",
			reasons: [`${HOSTED}: the hosted asset probed back HTTP 404`],
		});
	});

	it("is unresolved, never resolved, when the comment cannot be read", async () => {
		const http = fakeHttp([[COMMENT, {status: 404, body: "{}"}]]);
		expect(await run(http)).toMatchObject({
			_tag: "Unresolved",
			reasons: [expect.stringMatching(/could not be read/)],
		});
	});

	it("is unresolved when no token resolves", async () => {
		const http = fakeHttp([]);
		expect(await run(http, {})).toEqual({
			_tag: "Unresolved",
			reasons: [NO_TOKEN],
		});
	});
});
