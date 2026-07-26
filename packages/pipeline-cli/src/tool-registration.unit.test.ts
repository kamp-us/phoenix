import {Effect, Result} from "effect";
import {Command} from "effect/unstable/cli";
import {describe, expect, it} from "vitest";
import {registeredTools} from "./registry.ts";
import {dispatch} from "./router.ts";
import {
	loadRegistration,
	loadRegistry,
	type RegisteredTool,
	ToolLoadError,
	type ToolRegistration,
	tool,
} from "./tool-registration.ts";

const alpha = Command.make("alpha", {}, () => Effect.void);
const beta = Command.make("beta", {}, () => Effect.void);

/** The shape Node throws for a missing relative source file — a half-written tool. */
const missingModule = (path: string): Error =>
	Object.assign(new Error(`Cannot find module '${path}' imported from registry.ts`), {
		code: "ERR_MODULE_NOT_FOUND",
	});

/** The shape Node throws for an unlinked package — the install-timing case bin.ts self-heals. */
const unlinkedDependency = (pkg: string): Error =>
	Object.assign(new Error(`Cannot find package '${pkg}' imported from run.ts`), {
		code: "ERR_MODULE_NOT_FOUND",
	});

const broken = (name: string, err: Error): ToolRegistration =>
	tool(name, () => Promise.reject(err));

describe("loadRegistration", () => {
	it("loads a registration's command", async () => {
		await expect(loadRegistration(tool("alpha", () => Promise.resolve(alpha)))).resolves.toBe(
			alpha,
		);
	});

	it("names the registration that failed, and keeps the underlying fault as the cause", async () => {
		const cause = missingModule("/repo/packages/pipeline-cli/src/tools/run-evidence/command.ts");
		const err = await loadRegistration(broken("run-evidence", cause)).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ToolLoadError);
		const loadError = err as ToolLoadError;
		expect(loadError.tool).toBe("run-evidence");
		expect(loadError.message).toContain("`run-evidence`");
		expect(loadError.message).toContain("registry.ts");
		expect(loadError.cause).toBe(cause);
	});

	it("rethrows an unlinked-dependency miss untouched, so bin.ts can still self-heal it", async () => {
		const cause = unlinkedDependency("yaml");
		const err = await loadRegistration(broken("epic-ledger", cause)).catch((e: unknown) => e);
		expect(err).toBe(cause);
	});

	it("rejects a registration whose name drifted from its `Command.make` name", async () => {
		const err = await loadRegistration(tool("alpha", () => Promise.resolve(beta))).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(ToolLoadError);
		expect((err as ToolLoadError).message).toContain("must match");
	});
});

describe("loadRegistry", () => {
	// The #4008 containment: one lane's half-written tool used to take out every OTHER tool,
	// because the registry static-imported the whole graph before any tool could run.
	it("keeps the resolvable tools when one registration fails, and attributes the failure", async () => {
		const {tools, failures} = await loadRegistry([
			tool("alpha", () => Promise.resolve(alpha)),
			broken("run-evidence", missingModule("/repo/src/tools/run-evidence/command.ts")),
			tool("beta", () => Promise.resolve(beta)),
		]);
		expect(tools).toEqual([alpha, beta]);
		expect(failures.map((f) => f.name)).toEqual(["run-evidence"]);
		expect(failures[0]?.error.message).toContain("`run-evidence`");
	});
});

describe("laziness", () => {
	it("loads only the dispatched registration", async () => {
		const loaded: Array<string> = [];
		const load = (name: string, command: RegisteredTool) =>
			tool(name, () => {
				loaded.push(name);
				return Promise.resolve(command);
			});
		const registry = [load("alpha", alpha), load("beta", beta)];

		const selected = dispatch(registry, ["beta", "--flag"]);
		expect(Result.isSuccess(selected)).toBe(true);
		if (Result.isSuccess(selected)) {
			const dispatched = await loadRegistration(selected.success.tool);
			expect(dispatched).toBe(beta);
		}

		expect(loaded).toEqual(["beta"]);
	});
});

// The one suite that pays the whole-graph link the rest of the CLI no longer pays: it loads
// every registration to check the name it is registered under against the name its command
// declares. Type-stripping ~70 tool modules is well past vitest's 5s default under load.
describe("the real registry", {timeout: 60_000}, () => {
	it("registers every tool under the name its own command declares", async () => {
		const {tools, failures} = await loadRegistry(registeredTools);
		expect(failures).toEqual([]);
		expect(tools.map((t) => t.name)).toEqual(registeredTools.map((r) => r.name));
	});
});
