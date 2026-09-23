/**
 * The attachment tier: its upload and read-back request sequence, and its credential path.
 *
 * A fresh `github.com/user-attachments/assets/<uuid>` reads `404` at its own address until posted
 * content embeds it, so the tier proves an upload through GitHub's renderer instead: the signed link
 * `POST /markdown` rewrites the URL into must serve `200` with the capture's exact bytes, fetched
 * with no credential. Every other answer is a `Failed` the verb refuses on.
 *
 * The credential path keeps the two properties the old `execFileSync` pair carried: nothing is
 * resolved until an upload asks, and one repo is resolved once however many surfaces an evidence
 * post carries. `gh` is absent from PATH throughout, so a green here is a credential path that never
 * needed the binary.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeHttp, fakeShell, type HttpReply} from "../fakes.test-support.ts";
import {NO_TOKEN} from "../io/gh-api.ts";
import type {UploadTarget} from "./evidence-verb.ts";
import {attachmentUpload, forgetCredentials, ghAttachmentUpload} from "./http.ts";

const target = (surface: string): UploadTarget => ({
	surface,
	role: "after",
	fileName: `${surface}.png`,
	sha256: "0".repeat(64),
	bytes: new Uint8Array([1, 2, 3]),
});

const withToken = {GITHUB_TOKEN: "ghp_scripted"};

const run = (
	repo: string,
	surface: string,
	env: Readonly<Record<string, string | undefined>>,
	http: ReturnType<typeof fakeHttp>,
	shell: ReturnType<typeof fakeShell>,
) =>
	Effect.runPromise(
		Effect.provide(
			ghAttachmentUpload(env)(repo, target(surface)),
			Layer.merge(shell.layer, http.layer),
		),
	);

const UUID = "d8c7f5c8-a9de-4575-b418-8837ec743c5e";
const HOSTED = `https://github.com/user-attachments/assets/${UUID}`;
const SIGNED = `https://private-user-images.githubusercontent.com/1783869/657136403-${UUID}.png?jwt=private-fixture`;
const TOKEN = "scripted-upload-credential";
const BYTES_BODY = "\u0001\u0002\u0003";
/** GitHub's renderer output for one stored asset, `&` entity-escaped as the live HTML carries it. */
const rendered = (src: string = SIGNED): string =>
	`<p dir="auto"><a target="_blank" href="${src.replaceAll("&", "&amp;")}"><img src="${src.replaceAll("&", "&amp;")}" alt="evidence" style="max-width: 100%;"></a></p>`;

const UPLOAD = /^POST https:\/\/uploads\.github\.com\/user-attachments\/assets\?/;
const RENDER = /^POST https:\/\/api\.github\.com\/markdown$/;
const SERVED = /^GET https:\/\/private-user-images\.githubusercontent\.com\//;

const uploaded = (url: string = HOSTED): HttpReply => ({
	status: 201,
	body: JSON.stringify({url}),
});

const scripted = (
	overrides: {upload?: HttpReply; render?: HttpReply; served?: HttpReply} = {},
	unreachable: ReadonlyArray<RegExp> = [],
) =>
	fakeHttp(
		[
			[UPLOAD, overrides.upload ?? uploaded()],
			[RENDER, overrides.render ?? {status: 200, body: rendered()}],
			[SERVED, overrides.served ?? {status: 200, body: BYTES_BODY}],
		],
		undefined,
		unreachable,
	);

const upload = (http: ReturnType<typeof fakeHttp>) =>
	Effect.runPromise(
		Effect.provide(
			attachmentUpload({repo: "o/r", repositoryId: 918, token: TOKEN})(target("surface")),
			http.layer,
		),
	);

const expectPrivateFailure = (result: unknown) => {
	expect(result).toMatchObject({_tag: "Failed"});
	expect(JSON.stringify(result)).not.toContain(TOKEN);
	expect(JSON.stringify(result)).not.toContain("private-fixture");
};

describe("attachmentUpload's read-back through GitHub's renderer", () => {
	it("uploads, renders the URL in the repo's context, then fetches the signed link anonymously", async () => {
		const http = scripted();
		expect(await upload(http)).toEqual({_tag: "Ok", url: HOSTED});
		expect(http.calls).toHaveLength(3);
		expect(http.calls[0]).toMatch(UPLOAD);
		const query = new URL((http.calls[0] ?? "").replace(/^POST /, "")).searchParams;
		expect(Object.fromEntries(query)).toEqual({
			repository_id: "918",
			name: "surface.png",
			size: "3",
			content_type: "image/png",
		});
		expect(http.bodies[0]).toBe(BYTES_BODY);
		expect(http.headers[0]?.authorization).toBe(`token ${TOKEN}`);
		expect(http.calls[1]).toMatch(RENDER);
		expect(JSON.parse(http.bodies[1] ?? "")).toEqual({
			text: `![evidence](${HOSTED})`,
			mode: "gfm",
			context: "o/r",
		});
		expect(http.headers[1]?.authorization).toBe(`token ${TOKEN}`);
		expect(http.calls[2]).toBe(`GET ${SIGNED}`);
		expect(http.headers[2]?.authorization).toBeUndefined();
	});

	it("never fetches the fresh URL itself — it reads 404 until something posted embeds it", async () => {
		const http = scripted();
		await upload(http);
		expect(http.calls.some((call) => call.startsWith(`GET ${HOSTED}`))).toBe(false);
	});

	it("sends the token to the GitHub API only, never to the served-asset host", async () => {
		const http = scripted();
		await upload(http);
		http.calls.forEach((call, index) => {
			const host = new URL(call.replace(/^\w+ /, "")).host;
			const carriesToken = Object.values(http.headers[index] ?? {}).some((value) =>
				value.includes(TOKEN),
			);
			expect(carriesToken).toBe(host === "api.github.com" || host === "uploads.github.com");
		});
	});

	it.each([
		"https://github.com.evil.example/user-attachments/assets/a",
		`${HOSTED}?signature=private-fixture`,
		`${HOSTED}#private-fixture`,
		"https://github.com/user-attachments/assets/../../private-fixture",
		"https://github.com/user-attachments/assets/not-an-asset",
	])("rejects an untrusted uploaded destination without rendering it: %s", async (url) => {
		const http = scripted({upload: uploaded(url)});
		expectPrivateFailure(await upload(http));
		expect(http.calls).toHaveLength(1);
	});

	it.each([
		{status: 201, body: `${TOKEN} not json`},
		{status: 403, body: `${TOKEN} forbidden`},
	])("does not echo an invalid upload response body (HTTP $status)", async (reply) => {
		const http = scripted({upload: reply});
		expectPrivateFailure(await upload(http));
		expect(http.calls).toHaveLength(1);
	});

	it("absorbs an upload transport fault", async () => {
		const http = scripted({}, [UPLOAD]);
		expectPrivateFailure(await upload(http));
		expect(http.calls).toHaveLength(1);
	});

	it("fails when the renderer cannot be read", async () => {
		const http = scripted({render: {status: 502, body: "bad gateway"}});
		const result = await upload(http);
		expectPrivateFailure(result);
		expect(result).toMatchObject({reason: expect.stringMatching(/HTTP 502/)});
		expect(http.calls).toHaveLength(2);
	});

	it("fails when the renderer leaves the asset unsigned — the upload stored nothing", async () => {
		const http = scripted({
			render: {status: 200, body: `<p><a href="${HOSTED}">${HOSTED}</a></p>`},
		});
		const result = await upload(http);
		expectPrivateFailure(result);
		expect(result).toMatchObject({reason: expect.stringMatching(/no served link/)});
		expect(http.calls).toHaveLength(2);
	});

	it.each([302, 403, 404, 500])("fails when the signed link answers HTTP %s", async (status) => {
		const http = scripted({served: {status, body: ""}});
		const result = await upload(http);
		expectPrivateFailure(result);
		expect(result).toMatchObject({reason: `the hosted asset probed back HTTP ${status}`});
	});

	it.each([
		"",
		"\u0001\u0002",
		"\u0001\u0002\u0004",
		"<html>not an image</html>",
	])("fails when the signed link serves other bytes: %j", async (body) => {
		const http = scripted({served: {status: 200, body}});
		const result = await upload(http);
		expectPrivateFailure(result);
		expect(result).toMatchObject({reason: expect.stringMatching(/not the 3-byte capture/)});
	});

	it("absorbs a transport fault on the signed link without printing the link", async () => {
		const http = scripted({}, [SERVED]);
		const result = await upload(http);
		expectPrivateFailure(result);
		expect(result).toMatchObject({reason: expect.stringMatching(/could not be probed back/)});
	});
});

describe("ghAttachmentUpload's credentials", () => {
	it("resolves nothing until an upload asks for them", () => {
		forgetCredentials();
		const http = fakeHttp([]);
		const noGh = fakeShell([], undefined, [/^gh /]);
		const leg = ghAttachmentUpload(withToken);
		expect(typeof leg).toBe("function");
		expect(http.calls).toEqual([]);
		expect(noGh.calls).toEqual([]);
	});

	it("resolves one repo once, and each repo on its own — never once per surface", async () => {
		forgetCredentials();
		const http = fakeHttp([[/repos\//, {status: 500, body: "{}"}]]);
		const noGh = fakeShell([], undefined, [/^gh /]);
		await run("o/r", "one", withToken, http, noGh);
		await run("o/r", "two", withToken, http, noGh);
		await run("o/other", "one", withToken, http, noGh);
		expect(http.calls).toEqual([
			"GET https://api.github.com/repos/o/r",
			"GET https://api.github.com/repos/o/other",
		]);
		expect(noGh.calls).toEqual([]);
	});

	it("refuses naming both env vars when nothing resolves a token, and reads nothing", async () => {
		forgetCredentials();
		const http = fakeHttp([]);
		const noGh = fakeShell([], undefined, [/^gh /]);
		expect(await run("o/r", "one", {}, http, noGh)).toEqual({_tag: "Failed", reason: NO_TOKEN});
		expect(http.calls).toEqual([]);
	});

	it("tells a repo that is absent from one whose id could not be read", async () => {
		forgetCredentials();
		const noGh = fakeShell([], undefined, [/^gh /]);
		const gone = await run(
			"o/gone",
			"one",
			withToken,
			fakeHttp([[/repos\//, {status: 404, body: "{}"}]]),
			noGh,
		);
		expect(gone).toEqual({
			_tag: "Failed",
			reason: "o/gone does not exist, so it names no repository id",
		});
		const unreadable = await run(
			"o/unreadable",
			"one",
			withToken,
			fakeHttp([[/repos\//, {status: 502, body: "{}"}]]),
			noGh,
		);
		expect(unreadable).toEqual({
			_tag: "Failed",
			reason: "cannot resolve o/unreadable's numeric id: GitHub answered HTTP 502",
		});
	});

	it("refuses a 200 that names no numeric id rather than uploading against one it invented", async () => {
		forgetCredentials();
		const http = fakeHttp([[/repos\//, {status: 200, body: JSON.stringify({id: "918"})}]]);
		const noGh = fakeShell([], undefined, [/^gh /]);
		const result = await run("o/r", "one", withToken, http, noGh);
		expect(result).toEqual({
			_tag: "Failed",
			reason: "cannot resolve o/r's numeric id: GitHub answered 200 but named no repository id",
		});
	});

	it("reads the resolved repo's upload back in that repo's rendering context", async () => {
		forgetCredentials();
		const http = fakeHttp([
			[/^GET https:\/\/api\.github\.com\/repos\/o\/r$/, {status: 200, body: '{"id":918}'}],
			[UPLOAD, uploaded()],
			[RENDER, {status: 200, body: rendered()}],
			[SERVED, {status: 200, body: BYTES_BODY}],
		]);
		const noGh = fakeShell([], undefined, [/^gh /]);
		expect(await run("o/r", "one", withToken, http, noGh)).toEqual({_tag: "Ok", url: HOSTED});
		expect(JSON.parse(http.bodies[2] ?? "")).toMatchObject({context: "o/r"});
	});
});
