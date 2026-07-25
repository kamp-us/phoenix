/**
 * The lazy tool registration — a tool's name is static, its module load is deferred (#4008).
 *
 * The registry used to `import` every tool's `command.ts` statically, so the whole
 * tool graph linked before any tool ran. That coupled every invocation to every
 * registration: one lane's half-written tool in the shared checkout every agent
 * executes from made *any* `pipeline-cli <anything>` die with an `ERR_MODULE_NOT_FOUND`
 * naming a tool the caller never asked for. A registration therefore carries only
 * the selector name eagerly and a thunk that imports the module when — and only
 * when — that verb is dispatched, so a broken registration is contained to itself.
 *
 * The containment is only as good as the error: a load fault is reported as a
 * `ToolLoadError` naming the registration, not as a bare module-resolution stack.
 */
import type {NodeServices} from "@effect/platform-node";
import type {Command} from "effect/unstable/cli";
import {isUnlinkedDependencyError} from "./module-load-guard.ts";

/** The Node platform service union the bin provides — the requirement ceiling for a tool. */
type Platform = NodeServices.NodeServices;

/**
 * A loaded pipeline tool: a top-level `effect/unstable/cli` `Command` whose `name`
 * is the `pipeline-cli <name>` selector.
 *
 * The requirement row is bounded by **the Node platform services** — the one layer
 * the bin provides at the run boundary (`bin.ts`). A tool that needs more than the
 * Node platform (a `Github` capability, a DB) must bake its own layer into its
 * `Command` with `Command.provide(...)` **before** registering, so the registered
 * command's residual requirement is the platform union. That keeps the bin and the
 * router core stable as tools fold in: a tool self-contains its services, the bin
 * never grows a per-tool layer. The `Name`/`Input`/`ContextInput`/`E` slots are left
 * at their widest so the registry stays heterogeneous over tools with different
 * names, args, flags, and error rows. Both `Name` and `Input` are `any` because each
 * sits in a contravariant slot (`CommandContext<Name>`, `Variance<in Input, …>`): a
 * concrete literal name (`"version"`) is not assignable to `string`, and a tool's
 * concrete input shape (`{epic, dryRun}`) is not assignable from `object` — so only
 * `any` admits tools with different literal names and different arg/flag inputs into
 * one registry array.
 */
export type RegisteredTool = Command.Command<any, any, object, unknown, Platform>;

/** One row of the registry: the selector name, plus the deferred load of its `Command`. */
export interface ToolRegistration {
	readonly name: string;
	readonly load: () => Promise<RegisteredTool>;
}

/** A registration whose module could not be loaded, paired with the fault that stopped it. */
export interface ToolLoadFailure {
	readonly name: string;
	readonly error: ToolLoadError;
}

/** The outcome of loading a whole registry: the tools that resolved, and the ones that didn't. */
export interface LoadedRegistry {
	readonly tools: ReadonlyArray<RegisteredTool>;
	readonly failures: ReadonlyArray<ToolLoadFailure>;
}

/**
 * A registration that did not resolve to a usable `Command`, named by its selector.
 *
 * This is the attributable half of the containment: the raw throw is an
 * `ERR_MODULE_NOT_FOUND` for a path, which tells a caller nothing about *which
 * registration* is at fault or that the fault is not theirs. The message names the
 * registration and points at the most likely cause — a tool mid-write in the working
 * tree this CLI is executing from.
 */
export class ToolLoadError extends Error {
	readonly tool: string;

	constructor(tool: string, detail: string, options?: {cause?: unknown}) {
		super(
			[
				`pipeline-cli: registered tool \`${tool}\` failed to load — ${detail}`,
				`  The registration is in packages/pipeline-cli/src/registry.ts. A tool that is mid-write in the`,
				`  working tree this CLI runs from looks exactly like this; every OTHER tool still works.`,
			].join("\n"),
			options,
		);
		this.name = "ToolLoadError";
		this.tool = tool;
	}
}

/**
 * Declare one registration. `name` MUST equal the `Command.make("<name>")` name of the
 * loaded command — `loadRegistration` asserts it, because a drift would let the router
 * select a registration the CLI runtime then can't dispatch.
 */
export const tool = (name: string, load: () => Promise<RegisteredTool>): ToolRegistration => ({
	name,
	load,
});

/**
 * Load one registration's `Command`, converting any load fault into an attributable
 * `ToolLoadError`.
 *
 * An **unlinked dependency** miss is deliberately rethrown untouched: `bin.ts` classifies
 * that exact shape to run its bounded one-shot `pnpm install` self-heal (#2459) and, failing
 * that, print the install remediation (#1798). Wrapping it here would swallow both.
 */
export const loadRegistration = async (registration: ToolRegistration): Promise<RegisteredTool> => {
	let loaded: RegisteredTool;
	// biome-ignore lint/plugin: pre-runtime bootstrap — this guards the dynamic import that loads a tool's module BEFORE any Effect runtime exists to carry an `E` channel (the exemption the rule names).
	try {
		loaded = await registration.load();
	} catch (err) {
		if (isUnlinkedDependencyError(err)) throw err;
		const detail = err instanceof Error ? err.message : String(err);
		throw new ToolLoadError(registration.name, `its command module did not resolve (${detail})`, {
			cause: err,
		});
	}
	if (loaded === undefined || typeof loaded.name !== "string") {
		throw new ToolLoadError(registration.name, "its module exported no `Command`");
	}
	if (loaded.name !== registration.name) {
		throw new ToolLoadError(
			registration.name,
			`its module exports a command named \`${loaded.name}\` — the registered selector and the \`Command.make\` name must match`,
		);
	}
	return loaded;
};

/**
 * Load every registration, keeping the ones that resolve and collecting the ones that
 * don't. Used only where the caller genuinely asks about *all* tools (`--help`, the
 * `commands` index) — a single broken registration degrades that listing instead of
 * killing it, and the caller decides whether to report or fail on `failures`.
 */
export const loadRegistry = async (
	registry: ReadonlyArray<ToolRegistration>,
): Promise<LoadedRegistry> => {
	const tools: Array<RegisteredTool> = [];
	const failures: Array<ToolLoadFailure> = [];
	for (const registration of registry) {
		// biome-ignore lint/plugin: pre-runtime bootstrap — same module-load boundary as `loadRegistration`, still before any Effect runtime.
		try {
			tools.push(await loadRegistration(registration));
		} catch (err) {
			if (!(err instanceof ToolLoadError)) throw err;
			failures.push({name: registration.name, error: err});
		}
	}
	return {tools, failures};
};
