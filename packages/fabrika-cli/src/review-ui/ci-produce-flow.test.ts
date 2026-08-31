import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {CapturedSurface} from "../capture/capture.ts";
import {errOut, fakeSeams, okOut, once, type Scripted} from "../fakes.test-support.ts";
import type {ChildRunner} from "../io/exec.ts";
import {encodePng, solid} from "../ui/fakes.test-support.ts";
import {
	createFixture,
	isDockerResourceAlreadyAbsent,
	readSidecarCaptures,
	runCiProduce,
	type TrustedFixtureOperations,
} from "./ci-produce-verb.ts";
import {LOCALHOST_DECLARATIONS_PATH, parseCiCaptureManifest} from "./localhost-evidence.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const AUTHORITY_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PNG = encodePng(5, 3, solid(5, 3, [12, 34, 56, 255]));

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
			readinessPattern: "ready",
			captureReadySelector: ".react-flow__node",
			surfaces: [{id: "desktop", route: "/", state: "desktop", width: 1280, height: 800}],
		},
	],
});

const captureWithStatus = (status?: number) => (_url: string, outputDir: string) =>
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
					...(status === undefined ? {} : {status}),
				},
			];
		},
		catch: (cause) => String(cause),
	});

const capture = captureWithStatus(200);

const serverInspect = (running = true, exitCode = 0) =>
	okOut(
		JSON.stringify({
			id: "container-id",
			name: "/fabrika-review-ui-subject-42-server",
			image: "fabrika-review-ui-subject-42",
			state: {
				Status: running ? "running" : "exited",
				Running: running,
				ExitCode: exitCode,
				Error: "",
			},
		}),
	);

describe("trusted localhost producer flow", () => {
	it("makes the bind-mounted fixture traversable and readable by the unprivileged subject", async () => {
		const root = await createFixture();
		const sessions = join(root, "sessions");
		const fixture = join(sessions, "2026-08-29T10-00-00-000Z_review-ui.jsonl");
		expect((await stat(root)).mode & 0o777).toBe(0o755);
		expect((await stat(sessions)).mode & 0o777).toBe(0o755);
		expect((await stat(fixture)).mode & 0o777).toBe(0o644);
		await rm(root, {recursive: true, force: true});
	});

	it.each([
		"mkdir",
		"writeFile",
		"chmod-root",
		"chmod-sessions",
		"chmod-fixture",
	])("removes the fixture root when %s fails after ownership begins", async (failure) => {
		const calls: string[] = [];
		let chmodCall = 0;
		const operations: TrustedFixtureOperations = {
			mkdtemp: async () => {
				calls.push("mkdtemp");
				return "/fixture-root";
			},
			mkdir: async () => {
				calls.push("mkdir");
				if (failure === "mkdir") throw new Error("mkdir failed");
			},
			writeFile: async () => {
				calls.push("writeFile");
				if (failure === "writeFile") throw new Error("writeFile failed");
			},
			chmod: async () => {
				chmodCall += 1;
				const phase = ["chmod-root", "chmod-sessions", "chmod-fixture"][chmodCall - 1];
				calls.push(phase ?? "chmod");
				if (failure === phase) throw new Error(`${phase} failed`);
			},
			rm: async (path) => {
				calls.push(`rm ${path}`);
			},
		};

		await expect(createFixture(operations)).rejects.toThrow(`${failure} failed`);
		expect(calls.at(-1)).toBe("rm /fixture-root");
	});

	it("preserves fixture setup and cleanup diagnostics when both fail", async () => {
		const operations: TrustedFixtureOperations = {
			mkdtemp: async () => "/fixture-root",
			mkdir: async () => {
				throw new Error("mkdir failed first");
			},
			writeFile: async () => undefined,
			chmod: async () => undefined,
			rm: async () => {
				throw new Error("rm failed second");
			},
		};
		await expect(createFixture(operations)).rejects.toThrow(
			/mkdir failed first.*fixture cleanup failed.*rm failed second/,
		);
	});

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
					status: 200,
				},
			]),
		);
		const captures = await readSidecarCaptures(root);
		expect(captures).toHaveLength(1);
		expect(captures[0]?.status).toBe(200);
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

	it("refuses a subject-controlled .dockerignore that hides the rendered surface", async () => {
		const root = await mkdtemp(join(tmpdir(), "ci-produce-dockerignore-refusal-"));
		const authorityRoot = join(root, "authority");
		const subjectRoot = join(root, "subject");
		const outputDir = join(root, "output");
		await mkdir(join(authorityRoot, ".github"), {recursive: true});
		await mkdir(subjectRoot, {recursive: true});
		await writeFile(join(authorityRoot, LOCALHOST_DECLARATIONS_PATH), authority);
		await writeFile(join(subjectRoot, ".dockerignore"), "packages/tuval/**\n");
		const seams = fakeSeams([
			[once(/^git rev-parse HEAD$/), okOut(HEAD)],
			[/^git rev-parse HEAD$/, okOut(AUTHORITY_HEAD)],
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
		expect(outcome.code).toBe(10);
		expect(outcome.stderr.join("\n")).toContain("must not contain a root .dockerignore");
		expect(seams.calls.some((call) => call.startsWith("docker "))).toBe(false);
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
			[/^docker volume rm .*capture-output$/, okOut("")],
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

		expect(outcome.code).toBe(11);
		expect(seams.calls.some((call) => call.includes("server-workspace,dst=/subject"))).toBe(false);
		expect(seams.calls.filter((call) => call.startsWith("docker rm --force "))).toEqual([
			"docker rm --force fabrika-review-ui-subject-42-test",
			"docker rm --force fabrika-review-ui-subject-42-server-prepare",
			"docker rm --force fabrika-review-ui-subject-42-server-keeper",
			"docker rm --force fabrika-review-ui-subject-42-server",
			"docker rm --force fabrika-review-ui-subject-42-capture",
			"docker rm --force fabrika-review-ui-subject-42-capture-keeper",
			"docker rm --force fabrika-review-ui-subject-42-capture-extract",
		]);
		await expect(readFile(join(outputDir, "manifest.json"), "utf8")).rejects.toThrow();
		await rm(root, {recursive: true, force: true});
	});

	it("force-removes the capture keeper and every named container after the sidecar times out", async () => {
		const root = await mkdtemp(join(tmpdir(), "ci-produce-timeout-cleanup-"));
		const authorityRoot = join(root, "authority");
		const subjectRoot = join(root, "subject");
		const outputDir = join(root, "output");
		await mkdir(join(authorityRoot, ".github"), {recursive: true});
		await mkdir(subjectRoot, {recursive: true});
		await writeFile(join(authorityRoot, LOCALHOST_DECLARATIONS_PATH), authority);
		const calls: string[] = [];
		let gitRead = 0;
		const bytes = (text: string) => new TextEncoder().encode(text);
		const runner: ChildRunner = (request) => {
			const line = `${request.file} ${request.args.join(" ")}`;
			calls.push(line);
			if (request.file === "git") {
				gitRead += 1;
				return Effect.succeed({
					_tag: "Ran" as const,
					exitCode: 0,
					timedOut: false,
					stdout: bytes(gitRead === 1 ? HEAD : AUTHORITY_HEAD),
					stderr: bytes(""),
					truncated: false,
				});
			}
			const timedOut = line.startsWith("docker run --rm --network container:container-id");
			const stdout = line.startsWith("docker run --detach")
				? line.includes("capture-keeper")
					? "capture-keeper-id"
					: line.includes("server-keeper")
						? "server-keeper-id"
						: "container-id"
				: line === "docker logs container-id"
					? "ready"
					: line.startsWith("docker inspect --format") && line.endsWith("-keeper-id")
						? "true"
						: "";
			return Effect.succeed({
				_tag: "Ran" as const,
				exitCode: timedOut ? null : 0,
				timedOut,
				stdout: bytes(stdout),
				stderr: bytes(""),
				truncated: false,
			});
		};
		const seams = fakeSeams([]);
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
					runner,
				}),
				seams.layer,
			),
		);
		expect(outcome.code).toBe(11);
		expect(calls.filter((call) => call.startsWith("docker rm --force "))).toEqual([
			"docker rm --force fabrika-review-ui-subject-42-test",
			"docker rm --force fabrika-review-ui-subject-42-server-prepare",
			"docker rm --force fabrika-review-ui-subject-42-server-keeper",
			"docker rm --force fabrika-review-ui-subject-42-server",
			"docker rm --force fabrika-review-ui-subject-42-capture",
			"docker rm --force fabrika-review-ui-subject-42-capture-keeper",
			"docker rm --force fabrika-review-ui-subject-42-capture-extract",
		]);
		expect(
			calls.some((call) => call.startsWith("docker run") && call.includes("capture-extract")),
		).toBe(false);
		await rm(root, {recursive: true, force: true});
	});

	it.each([
		{phase: "preparation", inspections: ["true", "false"], serverStarted: false},
		{phase: "server startup", inspections: ["true", "true", "false"], serverStarted: true},
	])("refuses when the bounded server-volume keeper dies during $phase", async ({
		phase,
		inspections,
		serverStarted,
	}) => {
		const root = await mkdtemp(join(tmpdir(), "ci-produce-server-keeper-death-"));
		const authorityRoot = join(root, "authority");
		const subjectRoot = join(root, "subject");
		const outputDir = join(root, "output");
		await mkdir(join(authorityRoot, ".github"), {recursive: true});
		await mkdir(subjectRoot, {recursive: true});
		await writeFile(join(authorityRoot, LOCALHOST_DECLARATIONS_PATH), authority);
		const keeperInspections = inspections.map(
			(value) => [once(/^docker inspect --format .* server-keeper-id$/), okOut(value)] as const,
		);
		const seams = fakeSeams([
			[once(/^git rev-parse HEAD$/), okOut(HEAD)],
			[/^git rev-parse HEAD$/, okOut(AUTHORITY_HEAD)],
			[/^docker build /, okOut("")],
			[/^docker volume create .*test-workspace$/, okOut("test-workspace")],
			[/^docker volume create .*server-workspace$/, okOut("server-workspace")],
			[/^docker run --rm --network none .*test-workspace/, okOut("")],
			[/^docker run --detach --network none .*server-keeper/, okOut("server-keeper-id")],
			...keeperInspections,
			[/^docker run --rm --network none .*server-workspace/, okOut("")],
			[/^docker run --detach .*server-workspace/, okOut("container-id")],
			[/^docker rm /, okOut("")],
			[/^docker volume rm /, okOut("")],
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
		expect(outcome.code).toBe(11);
		expect(outcome.stderr.join("\n")).toContain(`keeper exited during ${phase}`);
		expect(
			seams.calls.some(
				(call) => call.startsWith("docker run --detach") && call.includes("-server --network none"),
			),
		).toBe(serverStarted);
		expect(seams.calls.some((call) => call.startsWith("docker logs container-id"))).toBe(false);
		await rm(root, {recursive: true, force: true});
	});

	it("recognizes only exact Docker kind/name absence diagnostics", () => {
		expect(
			isDockerResourceAlreadyAbsent(
				"container",
				"subject-server",
				"Error response from daemon: No such container: subject-server",
			),
		).toBe(true);
		expect(
			isDockerResourceAlreadyAbsent(
				"volume",
				"subject-workspace",
				"Error response from daemon: get subject-workspace: no such volume",
			),
		).toBe(true);
		expect(
			isDockerResourceAlreadyAbsent(
				"image",
				"subject-image",
				"Error response from daemon: No such image: subject-image:latest",
			),
		).toBe(true);
		expect(
			isDockerResourceAlreadyAbsent(
				"container",
				"subject-server",
				"dependency not found while removing container subject-server",
			),
		).toBe(false);
		expect(
			isDockerResourceAlreadyAbsent(
				"container",
				"subject-server",
				"Error response from daemon: No such container: different-server",
			),
		).toBe(false);
	});

	it("makes cleanup command failure blocking and retains an earlier operation failure", async () => {
		const run = async (
			journey: Scripted[1],
			cleanupFailure: Scripted[1] = errOut("daemon refused cleanup"),
		) => {
			const root = await mkdtemp(join(tmpdir(), "ci-produce-cleanup-failure-"));
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
				[/^docker run --rm --network none .*test-workspace/, journey],
				[/^docker run --detach --network none .*server-keeper/, okOut("server-keeper-id")],
				[/^docker inspect --format .* server-keeper-id$/, okOut("true")],
				[/^docker run --rm --network none .*server-workspace/, okOut("")],
				[/^docker run --detach .*server-workspace/, okOut("container-id")],
				[/^docker logs container-id$/, okOut("ready")],
				[/^docker inspect --format .* container-id$/, serverInspect()],
				[/^docker rm --force .*server-keeper$/, cleanupFailure],
				[/^docker rm /, okOut("")],
				[/^docker volume rm /, okOut("")],
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
			await rm(root, {recursive: true, force: true});
			return {outcome, calls: seams.calls};
		};

		const cleanupOnly = await run(okOut(""));
		expect(cleanupOnly.outcome.code).toBe(11);
		expect(cleanupOnly.outcome.stdout).toBe("");
		expect(cleanupOnly.outcome.stderr.join("\n")).toContain("daemon refused cleanup");
		expect(cleanupOnly.calls.filter((call) => call.startsWith("docker rm --force "))).toHaveLength(
			7,
		);
		expect(
			cleanupOnly.calls.filter((call) => call.startsWith("docker volume rm --force ")),
		).toHaveLength(3);

		const operationAndCleanup = await run(errOut("journey failed first"));
		expect(operationAndCleanup.outcome.code).toBe(11);
		expect(operationAndCleanup.outcome.stderr.join("\n")).toContain("journey failed first");
		expect(operationAndCleanup.outcome.stderr.join("\n")).toContain("daemon refused cleanup");

		const unrelatedNotFound = await run(
			okOut(""),
			errOut(
				"dependency not found while removing container fabrika-review-ui-subject-42-server-keeper",
			),
		);
		expect(unrelatedNotFound.outcome.code).toBe(11);
		expect(unrelatedNotFound.outcome.stderr.join("\n")).toContain("dependency not found");

		const exactAlreadyAbsent = await run(
			okOut(""),
			errOut(
				"Error response from daemon: No such container: fabrika-review-ui-subject-42-server-keeper",
			),
		);
		expect(exactAlreadyAbsent.outcome.code).toBe(0);
	});

	it("fails immediately with recorded diagnostics when the built server exits before readiness", async () => {
		const root = await mkdtemp(join(tmpdir(), "ci-produce-readiness-refusal-"));
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
			[/^docker run --rm --network none .*test-workspace/, okOut("")],
			[/^docker run --detach --network none .*server-keeper/, okOut("server-keeper-id")],
			[/^docker inspect --format .* server-keeper-id$/, okOut("true")],
			[/^docker run --rm --network none .*server-workspace/, okOut("")],
			[/^docker run --detach .*server-workspace/, okOut("container-id")],
			[/^docker logs container-id$/, okOut("ERR_MODULE_NOT_FOUND: dist/backend/server.js")],
			[/^docker inspect --format .* container-id$/, serverInspect(false, 1)],
			[/^docker rm /, okOut("")],
			[/^docker volume rm .*test-workspace$/, okOut("")],
			[/^docker volume rm .*server-workspace$/, okOut("")],
			[/^docker volume rm .*capture-output$/, okOut("")],
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
		expect(outcome.code).toBe(11);
		expect(outcome.stderr.join("\n")).toContain("readiness=Exited");
		expect(outcome.stderr.join("\n")).toContain("exitCode=1");
		expect(outcome.stderr.join("\n")).toContain("ERR_MODULE_NOT_FOUND");
		expect(seams.calls.filter((call) => call === "docker logs container-id")).toHaveLength(1);
		await rm(root, {recursive: true, force: true});
	});

	it.each([
		{name: "absent", status: undefined, message: "returned no HTTP response"},
		{name: "404", status: 404, message: "returned HTTP 404"},
		{name: "500", status: 500, message: "returned HTTP 500"},
	])("refuses a $name navigation response before manifest creation", async ({status, message}) => {
		const root = await mkdtemp(join(tmpdir(), "ci-produce-http-refusal-"));
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
			[/^docker run --rm --network none .*test-workspace/, okOut("")],
			[/^docker run --detach --network none .*server-keeper/, okOut("server-keeper-id")],
			[/^docker inspect --format .* server-keeper-id$/, okOut("true")],
			[/^docker run --rm --network none .*server-workspace/, okOut("")],
			[/^docker run --detach .*server-workspace/, okOut("container-id")],
			[/^docker logs container-id$/, okOut("ready")],
			[/^docker inspect --format .* container-id$/, serverInspect()],
			[/^docker rm /, okOut("")],
			[/^docker volume rm .*test-workspace$/, okOut("")],
			[/^docker volume rm .*server-workspace$/, okOut("")],
			[/^docker volume rm .*capture-output$/, okOut("")],
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
					capture: captureWithStatus(status),
				}),
				seams.layer,
			),
		);

		expect(outcome.code).toBe(14);
		expect(outcome.stderr.join("\n")).toContain(message);
		await expect(readFile(join(outputDir, "manifest.json"), "utf8")).rejects.toThrow();
		await rm(root, {recursive: true, force: true});
	});

	it("replays the Docker build/readiness trace and publishes page-error evidence", async () => {
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
			[/^docker run --detach --network none .*server-keeper/, okOut("server-keeper-id")],
			[/^docker inspect --format .* server-keeper-id$/, okOut("true")],
			[/^docker run --rm --network none .*server-workspace/, okOut("")],
			[/^docker run --detach .*server-workspace/, okOut("container-id")],
			[/^docker logs container-id$/, okOut("ready")],
			[/^docker inspect --format .* container-id$/, serverInspect()],
			[/^docker volume create .*o=size=256m .*capture-output$/, okOut("capture-output")],
			[/^docker run --detach --network none .*capture-keeper/, okOut("keeper-id")],
			[/^docker inspect --format .* keeper-id$/, okOut("true")],
			[/^docker run --rm --network container:container-id /, okOut("")],
			[/^docker run --rm --network none .*capture-extract/, okOut("")],
			[/^docker rm /, okOut("")],
			[/^docker volume rm .*test-workspace$/, okOut("")],
			[/^docker volume rm .*server-workspace$/, okOut("")],
			[/^docker volume rm .*capture-output$/, okOut("")],
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
			expect(parsed.value.captures[0]).toMatchObject({
				surface: "desktop",
				route: "/",
				state: "desktop",
			});
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
		const server = seams.calls.find(
			(call) => call.startsWith("docker run --detach") && call.includes("-server --network none"),
		);
		const serverKeeper = seams.calls.find((call) => call.includes("-server-keeper"));
		const captureKeeper = seams.calls.find((call) => call.includes("-capture-keeper"));
		const sidecar = seams.calls.find((call) =>
			call.startsWith("docker run --rm --network container:container-id"),
		);
		const extraction = seams.calls.find(
			(call) =>
				call.startsWith("docker run --rm --network none") && call.includes("capture-extract"),
		);
		expect(subjectRun).toContain("--read-only --cap-drop ALL");
		expect(subjectRun).toContain("--memory 4g --memory-swap 4g");
		expect(subjectRun).toContain("/tmp:rw,nosuid,nodev,size=1g");
		expect(subjectRun).toContain("/home/node/.cache:rw,nosuid,nodev,size=64m,uid=1000,gid=1000");
		expect(subjectRun).toContain(
			"/home/node/.local/share/pnpm:rw,nosuid,nodev,size=64m,uid=1000,gid=1000",
		);
		expect(subjectRun).toContain("no-new-privileges");
		expect(subjectRun).toContain("pnpm install --offline --frozen-lockfile");
		expect(subjectRun).toContain("pnpm --filter tuval test:browser");
		expect(subjectRun).not.toContain("GITHUB_TOKEN");
		expect(serverPreparation).toContain("cp -R /subject-source/. /subject/");
		expect(serverPreparation).toContain("--ignore-scripts --ignore-pnpmfile");
		expect(serverPreparation).toContain(
			"/home/node/.local/share/pnpm:rw,nosuid,nodev,size=64m,uid=1000,gid=1000",
		);
		expect(serverPreparation).toContain("pnpm --filter tuval build");
		expect(serverPreparation).not.toContain("test-workspace");
		expect(server).toContain("--network none");
		expect(server).not.toContain("--rm");
		expect(server).not.toContain("--publish");
		expect(server).toContain("server-workspace,dst=/subject,readonly");
		expect(server).not.toContain("test-workspace");
		expect(serverKeeper).toContain("--cpus 0.1 --memory 64m --memory-swap 64m --pids-limit 16");
		expect(serverKeeper).toContain("server-workspace,dst=/subject");
		expect(captureKeeper).toContain("--cpus 0.1 --memory 64m --memory-swap 64m --pids-limit 16");
		expect(captureKeeper).toContain("--network none");
		expect(captureKeeper).toContain("capture-output,dst=/capture-output");
		expect(captureKeeper).not.toContain("authority");
		expect(captureKeeper).not.toContain("GITHUB_TOKEN");
		expect(
			seams.calls.filter(
				(call) => call.startsWith("docker inspect") && call.endsWith(" server-keeper-id"),
			),
		).toHaveLength(3);
		expect(
			seams.calls.filter(
				(call) => call.startsWith("docker inspect") && call.endsWith(" keeper-id"),
			),
		).toHaveLength(2);
		expect(sidecar).toContain("/tmp:rw,nosuid,nodev,size=1g");
		expect(sidecar).toContain("/home/node/.cache:rw,nosuid,nodev,size=64m,uid=1000,gid=1000");
		expect(sidecar).toContain("/authority,dst=/authority,readonly");
		expect(sidecar).toContain("capture-output,dst=/capture-output");
		expect(sidecar).toContain("ci-capture-sidecar.ts 4173 /capture-output tuval");
		expect(extraction).toContain("capture-output,dst=/capture,readonly");
		expect(extraction).toContain(`${outputDir},dst=/output`);
		await rm(root, {recursive: true, force: true});
	});
});
