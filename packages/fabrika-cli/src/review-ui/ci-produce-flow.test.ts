import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {CapturedSurface} from "../capture/capture.ts";
import {errOut, fakeSeams, okOut, once, type Scripted} from "../fakes.test-support.ts";
import {readSidecarCaptures, runCiProduce} from "./ci-produce-verb.ts";
import {LOCALHOST_DECLARATIONS_PATH, parseCiCaptureManifest} from "./localhost-evidence.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const AUTHORITY_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
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
			readinessPattern: "ready",
			captureReadySelector: ".react-flow__node",
			surfaces: [{id: "desktop", route: "/", state: "desktop", width: 1280, height: 800}],
		},
	],
});

const capture = (_url: string, outputDir: string) =>
	Effect.tryPromise({
		try: async (): Promise<readonly CapturedSurface[]> => {
			const path = join(outputDir, "captures/desktop.png");
			await mkdir(join(outputDir, "captures"), {recursive: true});
			await writeFile(path, PNG);
			return [
				{
					surface: "desktop",
					route: "/",
					state: "desktop",
					localPath: path,
					fileName: "desktop.png",
					pngBytes: PNG,
					pageErrors: [
						{kind: "console.error", text: "console one"},
						{kind: "console.error", text: "console two"},
						{kind: "console.error", text: "console three"},
						{kind: "pageerror", text: "TypeError: boom"},
					],
				},
			];
		},
		catch: (cause) => String(cause),
	});

describe("trusted localhost producer flow", () => {
	it("consumes the sidecar control record without leaving it in the artifact", async () => {
		const root = await mkdtemp(join(tmpdir(), "ci-capture-sidecar-"));
		await mkdir(join(root, "captures"), {recursive: true});
		await writeFile(join(root, "captures/desktop.png"), PNG);
		await writeFile(
			join(root, "capture-result.json"),
			JSON.stringify([
				{
					surface: "desktop",
					route: "/",
					state: "desktop",
					fileName: "desktop.png",
					pageErrors: [],
				},
			]),
		);
		const captures = await readSidecarCaptures(root);
		expect(captures).toHaveLength(1);
		expect(Array.from(captures[0]?.pngBytes ?? [])).toEqual(Array.from(PNG));
		await expect(readFile(join(root, "capture-result.json"), "utf8")).rejects.toThrow();
		await rm(root, {recursive: true, force: true});
	});

	it("refuses a non-positive PR and relative root operands at the verb seam", async () => {
		const seams = fakeSeams([]);
		const base = {
			pr: 7190,
			head: HEAD,
			authorityHead: AUTHORITY_HEAD,
			harness: "tuval",
			runId: 42,
			repository: "kamp-us/phoenix",
			subjectRoot: "/subject",
			authorityRoot: "/authority",
			outputDir: "/output",
			env: {},
			capture,
		};
		const badPr = await Effect.runPromise(
			Effect.provide(runCiProduce({...base, pr: 0}), seams.layer),
		);
		const relative = await Effect.runPromise(
			Effect.provide(runCiProduce({...base, outputDir: "relative-output"}), seams.layer),
		);
		expect(badPr.code).toBe(1);
		expect(relative.code).toBe(10);
		expect(seams.calls).toEqual([]);
	});

	it("refuses subject and authority checkout head mismatches before producer execution", async () => {
		const root = await mkdtemp(join(tmpdir(), "ci-produce-head-refusal-"));
		const authorityRoot = join(root, "authority");
		const subjectRoot = join(root, "subject");
		const outputDir = join(root, "output");
		await mkdir(join(authorityRoot, ".github"), {recursive: true});
		await mkdir(subjectRoot, {recursive: true});
		await writeFile(join(authorityRoot, LOCALHOST_DECLARATIONS_PATH), authority);
		const wrong = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		for (const script of [
			[[/^git rev-parse HEAD$/, okOut(wrong)]],
			[
				[once(/^git rev-parse HEAD$/), okOut(HEAD)],
				[/^git rev-parse HEAD$/, okOut(wrong)],
			],
		] satisfies ReadonlyArray<ReadonlyArray<Scripted>>) {
			const seams = fakeSeams(script);
			const outcome = await Effect.runPromise(
				Effect.provide(
					runCiProduce({
						pr: 7190,
						head: HEAD,
						authorityHead: AUTHORITY_HEAD,
						harness: "tuval",
						runId: 42,
						repository: "kamp-us/phoenix",
						subjectRoot,
						authorityRoot,
						outputDir,
						env: {PATH: "/bin"},
						capture,
					}),
					seams.layer,
				),
			);
			expect(outcome.code).toBe(12);
			expect(seams.calls.some((call) => call.startsWith("docker "))).toBe(false);
		}
		await rm(root, {recursive: true, force: true});
	});

	it("stops a failed governed journey before server preparation, capture, and manifest", async () => {
		const root = await mkdtemp(join(tmpdir(), "ci-produce-failed-journey-"));
		const authorityRoot = join(root, "authority");
		const subjectRoot = join(root, "subject");
		const outputDir = join(root, "output");
		await mkdir(join(authorityRoot, ".github"), {recursive: true});
		await mkdir(subjectRoot, {recursive: true});
		await writeFile(join(authorityRoot, LOCALHOST_DECLARATIONS_PATH), authority);

		const seams = fakeSeams([
			[once(/^git rev-parse HEAD$/), okOut(HEAD)],
			[/^git rev-parse HEAD$/, okOut(AUTHORITY_HEAD)],
			[/^docker build /, okOut("")],
			[/^docker volume create .*test-workspace$/, okOut("test-workspace")],
			[/^docker volume create .*server-workspace$/, okOut("server-workspace")],
			[/^docker run --rm --network none .*test-workspace/, errOut("journey failed")],
			[/^docker rm /, okOut("")],
			[/^docker volume rm .*test-workspace$/, okOut("")],
			[/^docker volume rm .*server-workspace$/, okOut("")],
			[/^docker image rm /, okOut("")],
		]);
		const outcome = await Effect.runPromise(
			Effect.provide(
				runCiProduce({
					pr: 7190,
					head: HEAD,
					authorityHead: AUTHORITY_HEAD,
					harness: "tuval",
					runId: 42,
					repository: "kamp-us/phoenix",
					subjectRoot,
					authorityRoot,
					outputDir,
					env: {PATH: "/bin"},
					capture,
				}),
				seams.layer,
			),
		);

		expect(outcome.code).toBe(13);
		expect(seams.calls.some((call) => call.includes("server-workspace,dst=/subject"))).toBe(false);
		await expect(readFile(join(outputDir, "manifest.json"), "utf8")).rejects.toThrow();
		await rm(root, {recursive: true, force: true});
	});

	it("isolates install/test and publishes page-error evidence for the fetch FAIL route", async () => {
		const root = await mkdtemp(join(tmpdir(), "ci-produce-flow-"));
		const authorityRoot = join(root, "authority");
		const subjectRoot = join(root, "subject");
		const outputDir = join(root, "output");
		await mkdir(join(authorityRoot, ".github"), {recursive: true});
		await mkdir(subjectRoot, {recursive: true});
		await writeFile(join(authorityRoot, LOCALHOST_DECLARATIONS_PATH), authority);

		const script: ReadonlyArray<Scripted> = [
			[once(/^git rev-parse HEAD$/), okOut(HEAD)],
			[/^git rev-parse HEAD$/, okOut(AUTHORITY_HEAD)],
			[/^docker build /, okOut("")],
			[/^docker volume create .*test-workspace$/, okOut("test-workspace")],
			[/^docker volume create .*server-workspace$/, okOut("server-workspace")],
			[/^docker run --rm --network none .*test-workspace/, okOut("")],
			[/^docker run --rm --network none .*server-workspace/, okOut("")],
			[/^docker run --detach .*server-workspace/, okOut("container-id")],
			[/^docker logs container-id$/, okOut("ready")],
			[/^docker run --rm --network container:container-id /, okOut("")],
			[/^docker rm /, okOut("")],
			[/^docker volume rm .*test-workspace$/, okOut("")],
			[/^docker volume rm .*server-workspace$/, okOut("")],
			[/^docker image rm /, okOut("")],
		];
		const seams = fakeSeams(script);
		const outcome = await Effect.runPromise(
			Effect.provide(
				runCiProduce({
					pr: 7190,
					head: HEAD,
					authorityHead: AUTHORITY_HEAD,
					harness: "tuval",
					runId: 42,
					repository: "kamp-us/phoenix",
					subjectRoot,
					authorityRoot,
					outputDir,
					env: {PATH: "/bin", GITHUB_TOKEN: "not-for-subject"},
					readSidecar: (directory) => Effect.runPromise(capture("", directory)),
				}),
				seams.layer,
			),
		);

		expect(outcome.code).toBe(0);
		const parsed = parseCiCaptureManifest(await readFile(join(outputDir, "manifest.json"), "utf8"));
		expect(parsed._tag).toBe("Manifest");
		if (parsed._tag === "Manifest") {
			expect(parsed.value.producer.authorityHead).toBe(AUTHORITY_HEAD);
			expect(parsed.value.captures[0]?.pageErrors).toEqual({
				rows: [
					{kind: "pageerror", text: "TypeError: boom"},
					{kind: "console.error", text: "console one"},
					{kind: "console.error", text: "console two"},
				],
				more: 1,
			});
		}
		const subjectRun = seams.calls.find(
			(call) =>
				call.startsWith("docker run --rm --network none") && call.includes("test-workspace"),
		);
		const serverPreparation = seams.calls.find(
			(call) =>
				call.startsWith("docker run --rm --network none") && call.includes("server-workspace"),
		);
		const server = seams.calls.find((call) => call.startsWith("docker run --detach"));
		const sidecar = seams.calls.find((call) =>
			call.startsWith("docker run --rm --network container:container-id"),
		);
		expect(subjectRun).toContain("--read-only --cap-drop ALL");
		expect(subjectRun).toContain("no-new-privileges");
		expect(subjectRun).toContain("pnpm install --offline --frozen-lockfile");
		expect(subjectRun).not.toContain("GITHUB_TOKEN");
		expect(serverPreparation).toContain("cp -a /subject-source/. /subject/");
		expect(serverPreparation).toContain("--ignore-scripts --ignore-pnpmfile");
		expect(serverPreparation).not.toContain("test-workspace");
		expect(server).toContain("--network none");
		expect(server).not.toContain("--publish");
		expect(server).toContain("server-workspace,dst=/subject,readonly");
		expect(server).not.toContain("test-workspace");
		expect(sidecar).toContain("/authority,dst=/authority,readonly");
		expect(sidecar).toContain("/output,dst=/capture-output");
		expect(sidecar).toContain("ci-capture-sidecar.ts 4173 /capture-output tuval");
		await rm(root, {recursive: true, force: true});
	});
});
