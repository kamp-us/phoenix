import {execFileSync, spawnSync} from "node:child_process";
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {execRecord} from "../io/exec.ts";
import {formatDockerReadinessFailure, waitForDockerReadiness} from "./ci-produce-readiness.ts";
import {
	runCiProduce,
	subjectPrepareServerContainerArgs,
	subjectServerContainerArgs,
	subjectVolumeKeeperContainerArgs,
} from "./ci-produce-verb.ts";
import {parseCiCaptureManifest} from "./localhost-evidence.ts";

const dockerAvailable = spawnSync("docker", ["info"], {stdio: "ignore"}).status === 0;

const docker = (args: readonly string[]): string =>
	execFileSync("docker", args, {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();

const commitFixture = (root: string): string => {
	execFileSync("git", ["init", "--quiet"], {cwd: root});
	execFileSync("git", ["config", "user.name", "review-ui integration"], {cwd: root});
	execFileSync("git", ["config", "user.email", "review-ui@example.test"], {cwd: root});
	execFileSync("git", ["add", "."], {cwd: root});
	execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "fixture"], {cwd: root});
	return execFileSync("git", ["rev-parse", "HEAD"], {cwd: root, encoding: "utf8"}).trim();
};

describe("trusted localhost producer Docker boundary", () => {
	it.runIf(dockerAvailable)(
		"builds the isolated server workspace and reaches readiness from its read-only mount",
		async () => {
			const nonce = `${process.pid}-${Date.now()}`;
			const root = await mkdtemp(join(tmpdir(), "review-ui-docker-integration-"));
			const source = join(root, "subject-source");
			const fixture = join(root, "fixture");
			const image = `fabrika-review-ui-integration-${nonce}`;
			const volume = `${image}-workspace`;
			const keeper = `${image}-keeper`;
			const container = `${image}-server`;
			await mkdir(source, {recursive: true});
			await mkdir(join(fixture, "sessions"), {recursive: true});
			await writeFile(
				join(source, "server-source.mjs"),
				`import {writeFileSync} from "node:fs";
import {createServer} from "node:http";
try { writeFileSync("/subject/must-stay-read-only", "bad"); process.exit(2); } catch {}
setTimeout(() => createServer((_request, response) => response.end("ok")).listen(4173, "127.0.0.1", () => console.log("Tuval ready at http://127.0.0.1:4173")), 300);
`,
			);
			await writeFile(
				join(root, "pnpm"),
				`#!/bin/sh
set -u
if [ "\${3:-}" = "build" ]; then
  mkdir -p dist
  cp server-source.mjs dist/server.mjs
fi
`,
				{mode: 0o755},
			);
			await writeFile(
				join(root, "Dockerfile"),
				`FROM node:22-alpine
COPY --chown=node:node subject-source /subject-source
COPY pnpm /usr/local/bin/pnpm
RUN mkdir /subject && chown node:node /subject && chmod 0755 /usr/local/bin/pnpm
USER node
`,
			);

			try {
				docker(["build", "--tag", image, root]);
				docker(["volume", "create", volume]);
				const keeperId = docker(subjectVolumeKeeperContainerArgs(image, volume, keeper));
				expect(docker(["inspect", "--format", "{{.State.Running}}", keeperId])).toBe("true");
				docker(
					subjectPrepareServerContainerArgs(image, volume, ["pnpm", "--filter", "tuval", "build"]),
				);
				const containerId = docker(
					subjectServerContainerArgs(image, container, volume, fixture, [
						"node",
						"dist/server.mjs",
					]),
				);

				const readiness = await Effect.runPromise(
					Effect.provide(
						waitForDockerReadiness({
							containerId,
							containerName: container,
							readinessPattern: /Tuval ready at http:\/\/127\.0\.0\.1:4173/,
							run: (args, timeoutSeconds) =>
								execRecord({
									file: "docker",
									args,
									cwd: root,
									env: {PATH: process.env.PATH ?? ""},
									timeoutSeconds,
									captureBytes: 1_048_576,
								}),
						}),
						NodeServices.layer,
					),
				);
				if (readiness._tag !== "Ready") {
					throw new Error(formatDockerReadinessFailure(readiness));
				}
				expect(readiness.observation.state).toMatchObject({
					id: containerId,
					name: `/${container}`,
					running: true,
					exitCode: 0,
				});
			} finally {
				spawnSync("docker", ["rm", "--force", container], {stdio: "ignore"});
				spawnSync("docker", ["rm", "--force", keeper], {stdio: "ignore"});
				spawnSync("docker", ["volume", "rm", "--force", volume], {stdio: "ignore"});
				spawnSync("docker", ["image", "rm", "--force", image], {stdio: "ignore"});
				await rm(root, {recursive: true, force: true});
			}
		},
		120_000,
	);

	it.runIf(dockerAvailable)(
		"keeps tmpfs capture bytes alive from the trusted sidecar through artifact materialization",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "review-ui-docker-producer-integration-"));
			const subjectRoot = join(root, "subject");
			const authorityRoot = join(root, "authority");
			const outputDir = join(root, "artifact");
			await mkdir(subjectRoot, {recursive: true});
			await mkdir(join(authorityRoot, ".github"), {recursive: true});
			await mkdir(join(authorityRoot, "packages/fabrika-cli/src/review-ui"), {recursive: true});

			await writeFile(
				join(subjectRoot, "server-source.mjs"),
				`import {createServer} from "node:http";
createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end("<main>trusted sidecar fixture</main>");
}).listen(4173, "127.0.0.1", () => console.log("fixture ready"));
`,
			);
			await writeFile(join(subjectRoot, "pnpm"), "#!/bin/sh\nexit 0\n", {mode: 0o755});
			await writeFile(
				join(authorityRoot, ".github/review-ui-localhost-subject.Dockerfile"),
				`FROM node:26-alpine
COPY --chown=node:node . /subject-source
COPY pnpm /usr/local/bin/pnpm
RUN chmod 0755 /usr/local/bin/pnpm && mkdir /subject /capture-output && chown node:node /subject /capture-output
USER node
`,
			);
			await writeFile(
				join(authorityRoot, ".github/review-ui-localhost-harnesses.json"),
				JSON.stringify({
					schemaVersion: 1,
					harnesses: [
						{
							id: "fixture",
							workflow: ".github/workflows/review-ui-localhost-evidence.yml",
							check: "review-ui localhost evidence / fixture",
							event: "pull_request_target",
							artifact: "review-ui-localhost-fixture",
							captureCommand: ["sh", "-c", "test -f server-source.mjs"],
							serverBuildCommand: ["cp", "server-source.mjs", "server.mjs"],
							serverCommand: ["node", "server.mjs"],
							containerPort: 4173,
							readinessPattern: "fixture ready",
							captureReadySelector: "main",
							surfaces: [{id: "desktop", route: "/", state: "desktop", width: 5, height: 3}],
						},
					],
				}),
			);
			await writeFile(
				join(authorityRoot, "packages/fabrika-cli/src/review-ui/ci-capture-sidecar.ts"),
				`import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
const [port, outputDir] = process.argv.slice(2);
const response = await fetch(\`http://127.0.0.1:\${port}/\`);
if (!response.ok || !(await response.text()).includes("trusted sidecar fixture")) process.exit(2);
const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,5,0,0,0,3,8,6,0,0,0,91,54,197,248,0,0,0,18,73,68,65,84,120,156,99,224,81,178,248,143,142,25,136,22,4,0,125,71,20,236,96,202,120,172,0,0,0,0,73,69,78,68,174,66,96,130]);
await mkdir(join(outputDir, "captures"), {recursive: true});
await writeFile(join(outputDir, "captures/desktop.png"), png);
await writeFile(join(outputDir, "capture-result.json"), JSON.stringify([{surface:"desktop",route:"/",state:"desktop",fileName:"desktop.png",pageErrors:[],status:200}]));
`,
			);

			const subjectHead = commitFixture(subjectRoot);
			const authorityHead = commitFixture(authorityRoot);
			const runId = process.pid * 100_000 + (Date.now() % 100_000);
			try {
				const outcome = await Effect.runPromise(
					Effect.provide(
						runCiProduce({
							pr: 7190,
							head: subjectHead,
							authorityHead,
							harness: "fixture",
							runId,
							repository: "kamp-us/phoenix",
							subjectRoot,
							authorityRoot,
							outputDir,
							env: {PATH: process.env.PATH},
						}),
						NodeServices.layer,
					),
				);
				expect(outcome.code, outcome.stderr.join("\n")).toBe(0);
				const manifestText = await readFile(join(outputDir, "manifest.json"), "utf8");
				const parsed = parseCiCaptureManifest(manifestText);
				expect(parsed._tag).toBe("Manifest");
				if (parsed._tag === "Manifest") {
					expect(parsed.value).toMatchObject({
						repository: "kamp-us/phoenix",
						pr: 7190,
						head: subjectHead,
						harness: "fixture",
						producer: {runId, authorityHead},
					});
					expect(parsed.value.captures[0]).toMatchObject({
						path: "captures/desktop.png",
						width: 5,
						height: 3,
					});
				}
				const members = (await readdir(outputDir, {recursive: true}))
					.filter((entry) => entry === "manifest.json" || entry.endsWith(".png"))
					.sort();
				expect(members).toEqual(["captures/desktop.png", "manifest.json"]);
				expect(await readFile(join(outputDir, "captures/desktop.png"))).toEqual(
					Buffer.from(
						"iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAYAAABbNsX4AAAAEklEQVR4nGPgUbL4j44ZiBYEAH1HFOxgynisAAAAAElFTkSuQmCC",
						"base64",
					),
				);
				await expect(readFile(join(outputDir, "capture-result.json"))).rejects.toThrow();
			} finally {
				await rm(root, {recursive: true, force: true});
			}
		},
		240_000,
	);
});
