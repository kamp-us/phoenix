/**
 * The attachment tier's credential path, since the port moved it onto `../io/gh-api.ts`.
 *
 * The two properties the old `execFileSync` pair carried and the port had to keep are asserted here
 * rather than described: nothing is resolved until an upload asks, and one repo is resolved once
 * however many surfaces an evidence post carries. `gh` is absent from PATH throughout, so a green
 * here is a credential path that never needed the binary.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeHttp, fakeShell} from "../fakes.test-support.ts";
import {NO_TOKEN} from "../io/gh-api.ts";
import type {UploadTarget} from "./evidence-verb.ts";
import {forgetCredentials, ghAttachmentUpload} from "./http.ts";

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
