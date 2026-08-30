import {execFileSync} from "node:child_process";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {subjectPrepareServerContainerArgs, subjectServerContainerArgs} from "./ci-produce-verb.ts";

const dockerAvailable = (() => {
	try {
		execFileSync("docker", ["info"], {stdio: "ignore"});
		return true;
	} catch {
		return false;
	}
})();

const docker = (args: readonly string[]): string =>
	execFileSync("docker", args, {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();

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
			const container = `${image}-server`;
			await mkdir(source, {recursive: true});
			await mkdir(join(fixture, "sessions"), {recursive: true});
			await writeFile(
				join(source, "server-source.mjs"),
				`import {writeFileSync} from "node:fs";
import {createServer} from "node:http";
try { writeFileSync("/subject/must-stay-read-only", "bad"); process.exit(2); } catch {}
createServer((_request, response) => response.end("ok")).listen(4173, "127.0.0.1", () => console.log("Tuval ready at http://127.0.0.1:4173"));
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
				docker(
					subjectPrepareServerContainerArgs(image, volume, ["pnpm", "--filter", "tuval", "build"]),
				);
				docker(
					subjectServerContainerArgs(image, container, volume, fixture, [
						"node",
						"dist/server.mjs",
					]),
				);

				let logs = "";
				for (let attempt = 0; attempt < 40; attempt += 1) {
					logs = docker(["logs", container]);
					if (logs.includes("Tuval ready at")) break;
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				expect(logs).toContain("Tuval ready at http://127.0.0.1:4173");
				expect(docker(["inspect", "--format", "{{.State.Running}}", container])).toBe("true");
			} finally {
				try {
					docker(["rm", "--force", container]);
				} catch {}
				try {
					docker(["volume", "rm", "--force", volume]);
				} catch {}
				try {
					docker(["image", "rm", "--force", image]);
				} catch {}
				await rm(root, {recursive: true, force: true});
			}
		},
		120_000,
	);
});
