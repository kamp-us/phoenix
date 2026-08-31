import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Effect, Layer} from "effect";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {fakeSeams, once, type Scripted} from "../fakes.test-support.ts";
import {forgetAmbientToken} from "../io/gh-api.ts";
import {encodePng, solid} from "../ui/fakes.test-support.ts";
import {evidenceFailureOutcome, runCiFetch} from "./ci-fetch-verb.ts";
import {
	authorityReadUnknown,
	ciOk,
	malformedArtifact,
	producerUnavailable,
	runtimeUnknown,
	scratchUnknown,
	tokenUnknown,
	transportUnknown,
	unzipUnknown,
} from "./ci-github.ts";
import {EVIDENCE_UNAVAILABLE} from "./codes.ts";
import {CI_PROVENANCE_RECEIPT, declarationDigest} from "./localhost-evidence.ts";
import {sha256Hex} from "./manifest.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const AUTHORITY_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PULL = /GET .*\/repos\/o\/r\/pulls\/7190\b/;
const REPO = /GET .*\/repos\/o\/r$/;
const AUTHORITY_COMMIT = /GET .*\/repos\/o\/r\/commits\/main$/;
const AUTHORITY = /GET .*\/repos\/o\/r\/contents\/\.github\/review-ui-localhost-harnesses\.json/;
const WORKFLOW_RUNS =
	/GET .*\/repos\/o\/r\/actions\/workflows\/review-ui-localhost-evidence\.yml\/runs/;
const SUITE_CHECKS = /GET .*\/repos\/o\/r\/check-suites\/7\/check-runs/;
const RUN_ARTIFACTS = /GET .*\/repos\/o\/r\/actions\/runs\/42\/artifacts/;
const ARTIFACT_ZIP = /GET .*\/repos\/o\/r\/actions\/artifacts\/61\/zip/;
const PNG = encodePng(1280, 800, solid(1280, 800, [12, 34, 56, 255]));
const CRC_CORRUPT_PNG = PNG.slice();
CRC_CORRUPT_PNG[29] = (CRC_CORRUPT_PNG[29] ?? 0) ^ 0xff;

const authority = JSON.stringify({
	schemaVersion: 1,
	harnesses: [
		{
			id: "tuval",
			workflow: ".github/workflows/review-ui-localhost-evidence.yml",
			check: "review-ui localhost evidence / tuval",
			event: "pull_request_target",
			artifact: "review-ui-localhost-tuval",
			captureCommand: ["pnpm", "--filter", "tuval", "test:browser"],
			serverBuildCommand: ["pnpm", "--filter", "tuval", "build"],
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
	it("routes only the proven producer-unavailable tag to 18 and keeps every UNKNOWN tag on 11", () => {
		expect(evidenceFailureOutcome(producerUnavailable("none")).code).toBe(EVIDENCE_UNAVAILABLE);
		for (const failure of [
			transportUnknown("transport"),
			tokenUnknown("token"),
			authorityReadUnknown("authority"),
			scratchUnknown("scratch"),
			unzipUnknown("unzip"),
			runtimeUnknown("runtime"),
		]) {
			const outcome = evidenceFailureOutcome(failure);
			expect(outcome.code, failure._tag).toBe(11);
			expect(outcome.stdout, failure._tag).toBe("");
		}
	});

	it("drives the real GitHub resolver through final producer-unavailable and UNKNOWN fetch mappings", async () => {
		const common: ReadonlyArray<Scripted> = [
			[PULL, pull()],
			[REPO, {status: 200, body: JSON.stringify({default_branch: "main"})}],
			[AUTHORITY_COMMIT, {status: 200, body: JSON.stringify({sha: AUTHORITY_HEAD})}],
			[AUTHORITY, {status: 200, body: authority}],
		];
		const absentSeams = fakeSeams([
			...common,
			[WORKFLOW_RUNS, {status: 200, body: JSON.stringify({total_count: 0, workflow_runs: []})}],
		]);
		const absent = await Effect.runPromise(
			Effect.provide(
				runCiFetch({
					pr: 7190,
					harness: "tuval",
					out: "judged",
					repo: "o/r",
					env: {},
					tmpRoot: tmpdir(),
				}),
				absentSeams.layer,
			),
		);
		expect(absent.code).toBe(EVIDENCE_UNAVAILABLE);
		expect(absent.stdout).toBe("");

		const unreadableSeams = fakeSeams([
			...common,
			[WORKFLOW_RUNS, {status: 500, body: "producer inventory unavailable"}],
		]);
		const unreadable = await Effect.runPromise(
			Effect.provide(
				runCiFetch({
					pr: 7190,
					harness: "tuval",
					out: "judged",
					repo: "o/r",
					env: {},
					tmpRoot: tmpdir(),
				}),
				unreadableSeams.layer,
			),
		);
		expect(unreadable.code).toBe(11);
		expect(unreadable.stdout).toBe("");
		expect(unreadable.stderr.join("\n")).toContain("TransportUnknown");

		const runRow = {
			id: 42,
			status: "completed",
			conclusion: "success",
			event: "pull_request_target",
			path: ".github/workflows/review-ui-localhost-evidence.yml",
			repository: {full_name: "o/r"},
			head_sha: HEAD,
			display_title: `review-ui localhost evidence / tuval / PR #7190 / subject ${HEAD} / authority ${AUTHORITY_HEAD}`,
			check_suite_id: 7,
		};
		const identity: ReadonlyArray<Scripted> = [
			...common,
			[
				WORKFLOW_RUNS,
				{status: 200, body: JSON.stringify({total_count: 1, workflow_runs: [runRow]})},
			],
			[
				SUITE_CHECKS,
				{
					status: 200,
					body: JSON.stringify({
						total_count: 1,
						check_runs: [
							{
								id: 51,
								name: "review-ui localhost evidence / tuval",
								status: "completed",
								conclusion: "success",
							},
						],
					}),
				},
			],
			[
				RUN_ARTIFACTS,
				{
					status: 200,
					body: JSON.stringify({
						total_count: 1,
						artifacts: [{id: 61, name: "review-ui-localhost-tuval", expired: false}],
					}),
				},
			],
			[ARTIFACT_ZIP, {status: 200, body: "PK-not-a-real-archive"}],
		];

		const missingScratch = join(tmpdir(), `missing-ci-fetch-${Date.now()}`, "child");
		const scratchSeams = fakeSeams(identity);
		const scratch = await Effect.runPromise(
			Effect.provide(
				runCiFetch({
					pr: 7190,
					harness: "tuval",
					out: "judged",
					repo: "o/r",
					env: {},
					tmpRoot: missingScratch,
				}),
				scratchSeams.layer,
			),
		);
		expect(scratch.code).toBe(11);
		expect(scratch.stderr.join("\n")).toContain("ScratchUnknown");

		const root = await mkdtemp(join(tmpdir(), "ci-fetch-adapter-test-"));
		const unzipSeams = fakeSeams(identity);
		const unzip = await Effect.runPromise(
			Effect.provide(
				runCiFetch({
					pr: 7190,
					harness: "tuval",
					out: "judged",
					repo: "o/r",
					env: {},
					tmpRoot: root,
				}),
				unzipSeams.layer,
			),
		);
		expect(unzip.code).toBe(4);
		expect(unzip.stderr.join("\n")).toContain("unsafe, duplicate, extra, incomplete, or malformed");
		expect(unzipSeams.calls.some((call) => call.startsWith("unzip "))).toBe(false);
		await rm(root, {recursive: true, force: true});
	});

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
							ciOk({
								runId: 42,
								checkId: 51,
								artifactId: 61,
								artifactName: "review-ui-localhost-tuval",
								authorityHead: AUTHORITY_HEAD,
								directory: artifact,
								manifestText: manifest,
								memberBytes: {"captures/desktop.png": PNG},
							}),
						),
				}),
				Layer.mergeAll(seams.layer),
			),
		);
		expect(outcome.code).toBe(0);
		const answer = JSON.parse(outcome.stdout);
		expect(answer).toMatchObject({
			answer: "fetched",
			render: "clean",
			run: 42,
			artifact: 61,
			check: 51,
		});
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
			bundleFailure?: "malformed" | "producer-unavailable" | "runtime-unknown";
			materializedRed?: boolean;
		}> = [
			...producerMismatchCases,
			{
				name: "stale full manifest head",
				manifest: ciManifest({head: "0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192"}),
				expected: 4,
			},
			{
				name: "wrong manifest repository",
				manifest: ciManifest({repository: "attacker/fork"}),
				expected: 4,
			},
			{
				name: "wrong manifest PR",
				manifest: ciManifest({pr: 1}),
				expected: 4,
			},
			{
				name: "wrong manifest harness",
				manifest: ciManifest({harness: "other"}),
				expected: 4,
			},
			{
				name: "wrong manifest declaration digest",
				manifest: ciManifest({declarationSha256: "b".repeat(64)}),
				expected: 4,
			},
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
				name: "truncated PNG",
				manifest: ciManifest(),
				bytes: PNG.subarray(0, PNG.length - 5),
				expected: 15,
			},
			{
				name: "CRC-corrupt PNG",
				manifest: ciManifest(),
				bytes: CRC_CORRUPT_PNG,
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
				bundleFailure: "malformed",
				expected: 4,
			},
			{
				name: "ambiguous artifact",
				manifest: ciManifest(),
				bundleFailure: "producer-unavailable",
				expected: EVIDENCE_UNAVAILABLE,
			},
			{
				name: "runtime failure remains UNKNOWN",
				manifest: ciManifest(),
				bundleFailure: "runtime-unknown",
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
				expected: 0,
				materializedRed: true,
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
									? ciOk({
											runId: 42,
											checkId: 51,
											artifactId: 61,
											artifactName: "review-ui-localhost-tuval",
											authorityHead: AUTHORITY_HEAD,
											directory: artifact,
											manifestText: row.manifest,
											memberBytes: {"captures/desktop.png": row.bytes ?? PNG},
										})
									: row.bundleFailure === "malformed"
										? malformedArtifact("unsafe members")
										: row.bundleFailure === "producer-unavailable"
											? producerUnavailable("ambiguous artifact")
											: runtimeUnknown("runtime failed"),
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
			if (row.materializedRed === true) {
				expect(await readFile(receiptPath, "utf8"), row.name).toContain('"runId":42');
				expect(JSON.parse(outcome.stdout), row.name).toMatchObject({
					answer: "fetched",
					render: "red",
					captures: [
						{
							path: join(root, "fabrika-review-ui/7190-03135b91/judged/captures/desktop.png"),
						},
					],
				});
			} else {
				await expect(readFile(receiptPath, "utf8"), row.name).rejects.toThrow();
			}
			await rm(root, {recursive: true, force: true});
		}
	});
});
