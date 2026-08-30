import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Effect, Layer} from "effect";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {fakeSeams, once, type Scripted} from "../fakes.test-support.ts";
import {forgetAmbientToken} from "../io/gh-api.ts";
import {ok} from "../io/git.ts";
import {runCiFetch} from "./ci-fetch-verb.ts";
import {CI_PROVENANCE_RECEIPT, declarationDigest} from "./localhost-evidence.ts";
import {sha256Hex} from "./manifest.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const PULL = /GET .*\/repos\/o\/r\/pulls\/7190\b/;
const REPO = /GET .*\/repos\/o\/r$/;
const AUTHORITY = /GET .*\/repos\/o\/r\/contents\/\.github\/review-ui-localhost-harnesses\.json/;
const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0,
	0, 0, 3, 32,
]);

const authority = JSON.stringify({
	schemaVersion: 1,
	harnesses: [
		{
			id: "tuval",
			workflow: ".github/workflows/review-ui-localhost-evidence.yml",
			check: "review-ui localhost evidence / tuval",
			event: "pull_request_target",
			artifact: "review-ui-localhost-tuval",
			captureCommand: ["pnpm", "--filter", "tuval", "test"],
			serverCommand: ["node", "server.mjs", "0"],
			readinessPattern: "ready (http://127.0.0.1:[0-9]+)",
			captureReadySelector: ".react-flow__node",
			surfaces: [{id: "desktop", route: "/", state: "desktop", width: 1280, height: 800}],
		},
	],
});

const pull = (head = HEAD) => ({
	status: 200,
	body: JSON.stringify({
		number: 7190,
		state: "open",
		head: {sha: head},
		base: {ref: "main"},
		body: "",
		changed_files: 1,
		comments: 0,
	}),
});

beforeEach(() => {
	forgetAmbientToken();
	vi.stubEnv("GITHUB_TOKEN", "token");
});

afterEach(() => {
	vi.unstubAllEnvs();
	forgetAmbientToken();
});

describe("runCiFetch", () => {
	it("materializes only a provenance-bound exact-head artifact and writes the consumer receipt", async () => {
		const root = await mkdtemp(join(tmpdir(), "ci-fetch-test-"));
		const artifact = join(root, "artifact");
		await mkdir(join(artifact, "captures"), {recursive: true});
		await writeFile(join(artifact, "captures/desktop.png"), PNG);
		const manifest = JSON.stringify({
			schemaVersion: 1,
			source: "github-actions",
			repository: "o/r",
			pr: 7190,
			head: HEAD,
			harness: "tuval",
			declarationSha256: declarationDigest(authority),
			producer: {
				workflow: ".github/workflows/review-ui-localhost-evidence.yml",
				check: "review-ui localhost evidence / tuval",
				event: "pull_request_target",
				runId: 42,
				artifact: "review-ui-localhost-tuval",
			},
			captures: [
				{
					surface: "desktop",
					path: "captures/desktop.png",
					width: 1280,
					height: 800,
					sha256: sha256Hex(PNG),
					pageErrors: {rows: [], more: 0},
					errorCoverage: {pageerror: "readable", consoleError: "readable"},
				},
			],
		});
		const script: ReadonlyArray<Scripted> = [
			[once(PULL), pull()],
			[REPO, {status: 200, body: JSON.stringify({default_branch: "main"})}],
			[AUTHORITY, {status: 200, body: authority}],
			[PULL, pull()],
		];
		const seams = fakeSeams(script);
		const outcome = await Effect.runPromise(
			Effect.provide(
				runCiFetch({
					pr: 7190,
					harness: "tuval",
					out: "judged",
					repo: "o/r",
					env: {},
					tmpRoot: root,
					fetchBundle: () =>
						Effect.succeed(
							ok({
								runId: 42,
								checkId: 51,
								artifactId: 61,
								artifactName: "review-ui-localhost-tuval",
								directory: artifact,
								manifestText: manifest,
							}),
						),
				}),
				Layer.mergeAll(seams.layer),
			),
		);
		expect(outcome.code).toBe(0);
		const answer = JSON.parse(outcome.stdout);
		expect(answer).toMatchObject({answer: "fetched", run: 42, artifact: 61, check: 51});
		const receipt = JSON.parse(
			await readFile(
				join(root, "fabrika-review-ui/7190-03135b91/judged", CI_PROVENANCE_RECEIPT),
				"utf8",
			),
		);
		expect(receipt).toMatchObject({runId: 42, checkId: 51, artifactId: 61, head: HEAD});
		await rm(root, {recursive: true, force: true});
	});
});
