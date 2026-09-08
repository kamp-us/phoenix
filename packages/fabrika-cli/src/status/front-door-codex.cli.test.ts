import {spawn, spawnSync} from "node:child_process";
import {cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";

const source = fileURLToPath(
	new URL("../../../../claude-plugins/fabrika/skills/front-door/", import.meta.url),
);

describe.runIf(process.env.FABRIKA_CODEX_PROOF === "1")(
	"front-door in the installed Codex runtime (loopback provider, no model calls)",
	{timeout: SUBPROCESS_TEST_TIMEOUT_MS},
	() => {
		it("withholds implicit discovery but expands an explicit skill invocation", async () => {
			const root = mkdtempSync(join(tmpdir(), "fabrika-codex-policy-"));
			const home = join(root, "home");
			const repo = join(root, "repo");
			const market = join(root, "market");
			const plugin = join(market, "fabrika");
			const env = {PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: home};
			let accept: (body: string) => void = () => {};
			const server = createServer(async (req, res) => {
				const chunks: Buffer[] = [];
				for await (const chunk of req) chunks.push(Buffer.from(chunk));
				if (req.method === "POST" && req.url?.includes("responses")) {
					accept(Buffer.concat(chunks).toString());
					res.writeHead(503).end("request captured; no model invoked");
				} else res.writeHead(404).end();
			});
			try {
				for (const dir of [
					home,
					repo,
					join(market, ".claude-plugin"),
					join(plugin, ".claude-plugin"),
				]) {
					mkdirSync(dir, {recursive: true});
				}
				cpSync(source, join(plugin, "skills/front-door"), {recursive: true});
				mkdirSync(join(plugin, "skills/control"), {recursive: true});
				writeFileSync(
					join(plugin, "skills/control/SKILL.md"),
					"---\nname: control\ndescription: Codex policy proof discovery control.\n---\nSay hello.\n",
				);
				writeFileSync(
					join(market, ".claude-plugin/marketplace.json"),
					JSON.stringify({
						name: "policy-proof",
						owner: {name: "proof"},
						plugins: [{name: "fabrika", source: "./fabrika"}],
					}),
				);
				writeFileSync(
					join(plugin, ".claude-plugin/plugin.json"),
					JSON.stringify({name: "fabrika", version: "0.1.0", description: "Policy proof"}),
				);
				for (const args of [
					["plugin", "marketplace", "add", market],
					["plugin", "add", "fabrika@policy-proof"],
				]) {
					const run = spawnSync("codex", args, {
						env,
						encoding: "utf8",
						timeout: SUBPROCESS_TEST_TIMEOUT_MS,
					});
					expect(run.status, run.stderr).toBe(0);
				}
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(0, "127.0.0.1", resolve);
				});
				const address = server.address();
				if (address === null || typeof address === "string") throw new Error("No loopback port");
				for (const [prompt, explicit] of [
					["Say hello.", false],
					["$fabrika:front-door", true],
				] as const) {
					const captured = new Promise<string>((resolve) => {
						accept = resolve;
					});
					const child = spawn(
						"codex",
						[
							"exec",
							"--skip-git-repo-check",
							"-C",
							repo,
							"-c",
							'model_provider="proof"',
							"-c",
							'model="proof-model"',
							"-c",
							'model_providers.proof.name="proof"',
							"-c",
							'model_providers.proof.wire_api="responses"',
							"-c",
							"model_providers.proof.requires_openai_auth=false",
							"-c",
							`model_providers.proof.base_url="http://127.0.0.1:${address.port}/v1"`,
							prompt,
						],
						{env, stdio: ["ignore", "ignore", "pipe"]},
					);
					let stderr = "";
					child.stderr.on("data", (chunk) => {
						stderr += chunk;
					});
					const exited = new Promise<void>((resolve) => {
						child.once("close", () => resolve());
					});
					const failed = new Promise<never>((_, reject) => {
						child.once("error", reject);
						child.once("exit", () => reject(new Error(`Codex exited before capture: ${stderr}`)));
					});
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						const timeout = new Promise<never>((_, reject) => {
							timer = setTimeout(
								() => reject(new Error(`No request captured: ${stderr}`)),
								SUBPROCESS_TEST_TIMEOUT_MS / 4,
							);
						});
						const body = await Promise.race([captured, failed, timeout]);
						expect(body).toContain("Codex policy proof discovery control.");
						expect(body.includes("The operating front door — explicitly invoke")).toBe(explicit);
						expect(body.includes("Run the readout through the shell tool:")).toBe(explicit);
					} finally {
						clearTimeout(timer);
						child.kill("SIGKILL");
						await exited;
					}
				}
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				rmSync(root, {recursive: true, force: true});
			}
		});
	},
);
