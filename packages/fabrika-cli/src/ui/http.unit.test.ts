/**
 * The attachment tier's credential path, since the port moved it onto `../io/gh-api.ts`.
 *
 * The two properties the old `execFileSync` pair carried and the port had to keep are asserted here
 * rather than described: nothing is resolved until an upload asks, and one repo is resolved once
 * however many surfaces an evidence post carries. `gh` is absent from PATH throughout, so a green
 * here is a credential path that never needed the binary.
 */
import {Effect, Layer} from "effect";
import {afterEach, describe, expect, it, vi} from "vitest";
import {fakeHttp, fakeShell} from "../fakes.test-support.ts";
import {NO_TOKEN} from "../io/gh-api.ts";
import type {UploadTarget} from "./evidence-verb.ts";
import {encodePng, solid} from "./fakes.test-support.ts";
import {attachmentUpload, forgetCredentials, ghAttachmentUpload} from "./http.ts";
import {sha256Of} from "./png.ts";

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

const HOSTED = "https://github.com/user-attachments/assets/d8c7f5c8-a9de-4575-b418-8837ec743c5e";
const SIGNED = "https://asset.example/screenshot.png?signature=private-fixture";
const TOKEN = "scripted-upload-credential";
const PNG = encodePng(2, 2, solid(2, 2, [0, 0, 0, 255]));
const capture: UploadTarget = {
	...target("surface"),
	bytes: PNG,
	sha256: sha256Of(PNG),
};
const uploaded = (url = HOSTED) => Response.json({href: url}, {status: 201});
const image = (bytes: Uint8Array = PNG) =>
	new Response(bytes, {
		headers: {
			"content-type": "image/png",
		},
	});
const redirect = (location = SIGNED) =>
	new Response(null, {
		status: 302,
		headers: {
			location,
		},
	});
const upload = (input = capture) =>
	Effect.runPromise(attachmentUpload({repositoryId: 918, token: TOKEN})(input));

const scriptedFetch = (...responses: Array<Response | Error>) => {
	const mock = vi.spyOn(globalThis, "fetch");
	for (const response of responses) {
		if (response instanceof Error) mock.mockRejectedValueOnce(response);
		else mock.mockResolvedValueOnce(response);
	}
	mock.mockRejectedValue(new Error("unexpected fetch"));
	return mock;
};

const expectPrivateFailure = (result: unknown) => {
	expect(result).toMatchObject({_tag: "Failed"});
	expect(JSON.stringify(result)).not.toContain(TOKEN);
	expect(JSON.stringify(result)).not.toContain(SIGNED);
	expect(JSON.stringify(result)).not.toContain("private-fixture");
};

describe("attachmentUpload's served-image verification", () => {
	afterEach(() => vi.restoreAllMocks());

	it("uploads PNG with auth, follows a GET-only signed asset, and returns only the stable URL", async () => {
		const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			if (init?.method === "POST") return uploaded();
			if (String(input) === HOSTED) return redirect();
			if (String(input) === SIGNED) {
				return init?.method === "GET" ? image() : new Response(null, {status: 403});
			}
			throw new Error("unexpected fetch");
		});
		expect(await upload()).toEqual({_tag: "Ok", url: HOSTED});
		expect(mock).toHaveBeenCalledTimes(3);
		const [endpoint, request] = mock.mock.calls[0] ?? [];
		expect(String(endpoint)).toContain("https://uploads.github.com/user-attachments/assets?");
		expect(String(endpoint)).toContain("repository_id=918");
		expect(request).toMatchObject({
			method: "POST",
			body: PNG,
			headers: {
				authorization: `token ${TOKEN}`,
				"content-type": "image/png",
			},
		});
		expect(mock.mock.calls[1]).toEqual([
			HOSTED,
			{
				method: "GET",
				redirect: "manual",
				headers: {
					authorization: `token ${TOKEN}`,
				},
			},
		]);
		expect(mock.mock.calls[2]).toEqual([
			SIGNED,
			{
				method: "GET",
				redirect: "manual",
				headers: {},
			},
		]);
	});

	it("also accepts a directly served verified PNG", async () => {
		scriptedFetch(uploaded(), image());
		expect(await upload()).toEqual({_tag: "Ok", url: HOSTED});
	});

	it("keeps auth on a same-origin redirect but never restores it after crossing origins", async () => {
		const sameOrigin = `${HOSTED}?download=1`;
		const mock = scriptedFetch(
			uploaded(),
			redirect("?download=1"),
			redirect("https://assets.github.com/signed"),
			redirect(HOSTED),
			image(),
		);
		expect(await upload()).toEqual({_tag: "Ok", url: HOSTED});
		expect(mock.mock.calls[2]?.[0]).toBe(sameOrigin);
		expect(
			mock.mock.calls.slice(1).map(([, init]) => new Headers(init?.headers).get("authorization")),
		).toEqual([`token ${TOKEN}`, `token ${TOKEN}`, null, null]);
	});

	it.each([
		SIGNED,
		"https://github.com.evil.example/user-attachments/assets/a",
		"https://github.com@evil.example/user-attachments/assets/a",
		HOSTED.replace("https:", "http:"),
		`${HOSTED}?signature=private-fixture`,
		`${HOSTED}#private-fixture`,
		"https://github.com/user-attachments/assets/../../private-fixture",
		"https://github.com/user-attachments/assets/not-an-asset",
	])("rejects an untrusted uploaded destination without requesting it: %s", async (url) => {
		const mock = scriptedFetch(uploaded(url));
		expectPrivateFailure(await upload());
		expect(mock).toHaveBeenCalledTimes(1);
	});

	it.each([
		"http://asset.example/image",
		"https://user:password@asset.example/image",
		"https://[",
	])("rejects an unsafe redirect without requesting it: %s", async (location) => {
		const mock = scriptedFetch(uploaded(), redirect(location));
		expectPrivateFailure(await upload());
		expect(mock).toHaveBeenCalledTimes(2);
	});

	it("rejects a redirect without a destination", async () => {
		scriptedFetch(uploaded(), new Response(null, {status: 302}));
		expectPrivateFailure(await upload());
	});

	it("bounds a redirect loop rather than calling a redirect evidence", async () => {
		const mock = scriptedFetch(uploaded(), ...Array.from({length: 21}, () => redirect(HOSTED)));
		expectPrivateFailure(await upload());
		expect(mock).toHaveBeenCalledTimes(22);
	});

	it.each([204, 206, 304, 403, 404, 500])("rejects final HTTP %s", async (status) => {
		scriptedFetch(uploaded(), redirect(), new Response(null, {status}));
		expectPrivateFailure(await upload());
	});

	it.each([
		"text/html",
		"image/jpeg",
		"application/octet-stream",
		"",
	])("rejects a non-PNG content type: %s", async (contentType) => {
		scriptedFetch(
			uploaded(),
			new Response(PNG, {
				headers: {
					"content-type": contentType,
				},
			}),
		);
		expectPrivateFailure(await upload());
	});

	it.each([
		new Uint8Array(),
		new TextEncoder().encode("<html>not an image</html>"),
		PNG.slice(0, 40),
		encodePng(2, 2, solid(2, 2, [255, 0, 0, 255])),
	])("rejects empty, non-image, truncated, or different served bytes", async (bytes) => {
		scriptedFetch(uploaded(), image(bytes));
		expectPrivateFailure(await upload());
	});

	it("decodes the PNG rather than trusting even a matching digest", async () => {
		const bytes = new TextEncoder().encode("not a PNG");
		scriptedFetch(uploaded(), image(bytes));
		expectPrivateFailure(await upload({...capture, bytes, sha256: sha256Of(bytes)}));
	});

	it.each([
		"upload",
		"initial GET",
		"redirected GET",
	])("absorbs a %s transport failure without leaking secrets", async (stage) => {
		const error = new Error(`${TOKEN} ${SIGNED}`);
		const responses =
			stage === "upload" ? [] : stage === "initial GET" ? [uploaded()] : [uploaded(), redirect()];
		scriptedFetch(...responses, error);
		expectPrivateFailure(await upload());
	});

	it.each([
		"upload",
		"GET",
	])("absorbs an unreadable %s body without leaking secrets", async (stage) => {
		const response = stage === "upload" ? uploaded() : image();
		vi.spyOn(response, stage === "upload" ? "text" : "arrayBuffer").mockRejectedValue(
			new Error(`${TOKEN} ${SIGNED}`),
		);
		scriptedFetch(...(stage === "upload" ? [response] : [uploaded(), redirect(), response]));
		expectPrivateFailure(await upload());
	});

	it.each([201, 403])("does not echo an invalid upload response body (HTTP %s)", async (status) => {
		const mock = scriptedFetch(new Response(`${TOKEN} ${SIGNED}`, {status}));
		expectPrivateFailure(await upload());
		expect(mock).toHaveBeenCalledTimes(1);
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
});
