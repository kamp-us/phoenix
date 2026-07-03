/**
 * The pipeline-cli router wiring — the real bin body, behind `bin.ts`'s bootstrap.
 *
 * This holds the static imports of the whole tool graph (`registry.ts` → every
 * tool → their deps, incl. `yaml`). It is loaded via a **dynamic** `import()`
 * from `bin.ts` on purpose (#1798): deferring the tool-graph link until inside a
 * `try` is what makes an unlinked-`catalog:`-dep `ERR_MODULE_NOT_FOUND`
 * catchable, so the bin can print a remediation instead of a raw stack. Keeping
 * the wiring here (not in `bin.ts`) keeps that boundary clean.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/decisions-index` /
 * `@kampus/epic-ledger`): `effect/unstable/cli` for the typed subcommands, the
 * Node platform over `NodeServices.layer`, run via `NodeRuntime.runMain`.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {Command} from "effect/unstable/cli";
import {registeredTools} from "./registry.ts";
import {VERSION} from "./version.ts";

const cli = Command.make("pipeline-cli").pipe(
	Command.withSubcommands(registeredTools),
	Command.withDescription("The pipeline tooling router — `pipeline-cli <tool> …` (epic #994)"),
);

cli.pipe(Command.run({version: VERSION}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
