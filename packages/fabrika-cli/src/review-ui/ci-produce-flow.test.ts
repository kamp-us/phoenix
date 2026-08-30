import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {CapturedSurface} from "../capture/capture.ts";
import {fakeSeams, okOut, type Scripted} from "../fakes.test-support.ts";
import {runCiProduce} from "./ci-produce-verb.ts";
import {LOCALHOST_DECLARATIONS_PATH, parseCiCaptureManifest} from "./localhost-evidence.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
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
	it("refuses a non-positive PR and relative root operands at the verb seam", async () => {
		const seams = fakeSeams([]);
		const base = {
			pr: 7190,
			head: HEAD,
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

	it("isolates install/test and publishes page-error evidence for the fetch FAIL route", async () => {
		const root = await mkdtemp(join(tmpdir(), "ci-produce-flow-"));
		const authorityRoot = join(root, "authority");
		const subjectRoot = join(root, "subject");
		const outputDir = join(root, "output");
		await mkdir(join(authorityRoot, ".github"), {recursive: true});
		await mkdir(subjectRoot, {recursive: true});
		await writeFile(join(authorityRoot, LOCALHOST_DECLARATIONS_PATH), authority);

		const script: ReadonlyArray<Scripted> = [
			[/^git rev-parse HEAD$/, okOut(HEAD)],
			[/^docker build /, okOut("")],
			[/^docker volume create /, okOut("workspace")],
			[/^docker run --rm --network none /, okOut("")],
			[/^docker run --detach /, okOut("container-id")],
			[/^docker logs container-id$/, okOut("ready")],
			[/^docker port container-id 4173\/tcp$/, okOut("127.0.0.1:49152")],
			[/^docker rm /, okOut("")],
			[/^docker volume rm /, okOut("")],
			[/^docker image rm /, okOut("")],
		];
		const seams = fakeSeams(script);
		const outcome = await Effect.runPromise(
			Effect.provide(
				runCiProduce({
					pr: 7190,
					head: HEAD,
					harness: "tuval",
					runId: 42,
					repository: "kamp-us/phoenix",
					subjectRoot,
					authorityRoot,
					outputDir,
					env: {PATH: "/bin", GITHUB_TOKEN: "not-for-subject"},
					capture,
				}),
				seams.layer,
			),
		);

		expect(outcome.code).toBe(0);
		const parsed = parseCiCaptureManifest(await readFile(join(outputDir, "manifest.json"), "utf8"));
		expect(parsed._tag).toBe("Manifest");
		if (parsed._tag === "Manifest") {
			expect(parsed.value.captures[0]?.pageErrors).toEqual({
				rows: [
					{kind: "pageerror", text: "TypeError: boom"},
					{kind: "console.error", text: "console one"},
					{kind: "console.error", text: "console two"},
				],
				more: 1,
			});
		}
		const subjectRun = seams.calls.find((call) =>
			call.startsWith("docker run --rm --network none"),
		);
		expect(subjectRun).toContain("--read-only --cap-drop ALL");
		expect(subjectRun).toContain("no-new-privileges");
		expect(subjectRun).toContain("pnpm install --offline --frozen-lockfile");
		expect(subjectRun).not.toContain("GITHUB_TOKEN");
		await rm(root, {recursive: true, force: true});
	});
});
