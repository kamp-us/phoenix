import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Effect, Layer} from "effect";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {fakeSeams, once, type Scripted} from "../fakes.test-support.ts";
import {forgetAmbientToken} from "../io/gh-api.ts";
import {fail, ok} from "../io/git.ts";
import {runCiFetch} from "./ci-fetch-verb.ts";
import {CI_PROVENANCE_RECEIPT, declarationDigest} from "./localhost-evidence.ts";
import {sha256Hex} from "./manifest.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const AUTHORITY_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PULL = /GET .*\/repos\/o\/r\/pulls\/7190\b/;
const REPO = /GET .*\/repos\/o\/r$/;
const AUTHORITY_COMMIT = /GET .*\/repos\/o\/r\/commits\/main$/;
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
			serverCommand: ["node", "server.mjs", "4173"],
			containerPort: 4173,
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

const ciManifest = (
	overrides: Record<string, unknown> = {},
	captureOverrides: Record<string, unknown> = {},
) =>
	JSON.stringify({
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
			authorityHead: AUTHORITY_HEAD,
		},
		captures: [
			{
				surface: "desktop",
				route: "/",
				state: "desktop",
				path: "captures/desktop.png",
				width: 1280,
				height: 800,
				sha256: sha256Hex(PNG),
				pageErrors: {rows: [], more: 0},
				errorCoverage: {pageerror: "readable", consoleError: "readable"},
				...captureOverrides,
			},
		],
		...overrides,
	});

describe("runCiFetch", () => {
	it("materializes only a provenance-bound exact-head artifact and writes the consumer receipt", async () => {
		const root = await mkdtemp(join(tmpdir(), "ci-fetch-test-"));
		const artifact = join(root, "artifact");
		await mkdir(join(artifact, "captures"), {recursive: true});
		await writeFile(join(artifact, "captures/desktop.png"), PNG);
		const manifest = `${ciManifest()}\n`;
		const script: ReadonlyArray<Scripted> = [
			[once(PULL), pull()],
			[REPO, {status: 200, body: JSON.stringify({default_branch: "main"})}],
			[AUTHORITY_COMMIT, {status: 200, body: JSON.stringify({sha: AUTHORITY_HEAD})}],
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
								authorityHead: AUTHORITY_HEAD,
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
		expect(
			await readFile(join(root, "fabrika-review-ui/7190-03135b91/judged/manifest.json"), "utf8"),
		).toBe(manifest);
		await rm(root, {recursive: true, force: true});
	});

	it("covers producer, head, schema, integrity, error-evidence, and artifact refusals", async () => {
		const producerMismatchCases = (
			[
				["workflow", ".github/workflows/other.yml"],
				["check", "wrong check"],
				["event", "pull_request"],
				["runId", 43],
				["artifact", "wrong-artifact"],
				["authorityHead", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
			] as const
		).map(([field, value]) => ({
			name: `producer ${field} mismatch`,
			manifest: ciManifest({producer: {...JSON.parse(ciManifest()).producer, [field]: value}}),
			expected: 4,
		}));
		const cases: ReadonlyArray<{
			name: string;
			manifest: string;
			expected: number;
			secondHead?: string;
			bytes?: Uint8Array | null;
			bundleFailure?: string;
			bundleFailureKind?: "malformed-members";
			materializedOnRefusal?: boolean;
		}> = [
			...producerMismatchCases,
			{
				name: "missing declared route",
				manifest: ciManifest({}, {route: undefined}),
				expected: 4,
			},
			{
				name: "wrong declared route",
				manifest: ciManifest({}, {route: "/wrong"}),
				expected: 4,
			},
			{
				name: "missing declared state",
				manifest: ciManifest({}, {state: undefined}),
				expected: 4,
			},
			{
				name: "wrong declared state",
				manifest: ciManifest({}, {state: "mobile"}),
				expected: 4,
			},
			{
				name: "moved head",
				manifest: ciManifest(),
				secondHead: "0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192",
				expected: 12,
			},
			{
				name: "invalid capture bytes",
				manifest: ciManifest(),
				bytes: new TextEncoder().encode("tampered"),
				expected: 15,
			},
			{
				name: "valid PNG hash mismatch",
				manifest: ciManifest({}, {sha256: "b".repeat(64)}),
				expected: 15,
			},
			{
				name: "valid PNG dimension mismatch",
				manifest: ciManifest({}, {width: 1279}),
				expected: 15,
			},
			{
				name: "unreadable error evidence",
				manifest: ciManifest(
					{},
					{
						errorCoverage: {pageerror: "unreadable", consoleError: "readable"},
					},
				),
				expected: 4,
			},
			{
				name: "unsafe or duplicate artifact members",
				manifest: ciManifest(),
				bundleFailure: "the artifact has unsafe, duplicate, or incomplete members",
				bundleFailureKind: "malformed-members",
				expected: 4,
			},
			{
				name: "ambiguous artifact",
				manifest: ciManifest(),
				bundleFailure: "produced 2 review-ui-localhost-tuval artifacts — ambiguous",
				expected: 11,
			},
			{
				name: "uncaught page error remains a materialized red render",
				manifest: ciManifest(
					{},
					{
						pageErrors: {rows: [{kind: "pageerror", text: "boom"}], more: 0},
					},
				),
				expected: 13,
				materializedOnRefusal: true,
			},
		];

		for (const row of cases) {
			const root = await mkdtemp(join(tmpdir(), "ci-fetch-refusal-test-"));
			const artifact = join(root, "artifact");
			await mkdir(join(artifact, "captures"), {recursive: true});
			if (row.bytes !== null) {
				await writeFile(join(artifact, "captures/desktop.png"), row.bytes ?? PNG);
			}
			const seams = fakeSeams([
				[once(PULL), pull()],
				[REPO, {status: 200, body: JSON.stringify({default_branch: "main"})}],
				[AUTHORITY_COMMIT, {status: 200, body: JSON.stringify({sha: AUTHORITY_HEAD})}],
				[AUTHORITY, {status: 200, body: authority}],
				[PULL, pull(row.secondHead ?? HEAD)],
			]);
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
								row.bundleFailure === undefined
									? ok({
											runId: 42,
											checkId: 51,
											artifactId: 61,
											artifactName: "review-ui-localhost-tuval",
											authorityHead: AUTHORITY_HEAD,
											directory: artifact,
											manifestText: row.manifest,
										})
									: row.bundleFailureKind === undefined
										? fail(row.bundleFailure)
										: {...fail(row.bundleFailure), kind: row.bundleFailureKind},
							),
					}),
					Layer.mergeAll(seams.layer),
				),
			);
			expect(outcome.code, row.name).toBe(row.expected);
			const receiptPath = join(
				root,
				"fabrika-review-ui/7190-03135b91/judged",
				CI_PROVENANCE_RECEIPT,
			);
			if (row.materializedOnRefusal === true) {
				expect(await readFile(receiptPath, "utf8"), row.name).toContain('"runId":42');
				expect(outcome.stderr.join("\n"), row.name).toContain(
					join(root, "fabrika-review-ui/7190-03135b91/judged/captures/desktop.png"),
				);
			} else {
				await expect(readFile(receiptPath, "utf8"), row.name).rejects.toThrow();
			}
			await rm(root, {recursive: true, force: true});
		}
	});
});
