/**
 * The pipeline-cli tool registry — the extension seam (epic #994).
 *
 * Each entry is one pipeline tool exposed as `pipeline-cli <name> …`. A Phase-2
 * child folds its tool in by authoring an `effect/unstable/cli` `Command` and
 * appending it to `registeredTools` here — it never reshapes the router core
 * (`router.ts`) or the bin (`bin.ts`), both of which consume this array opaquely.
 *
 * That is the whole contract of the seam: the router is closed for modification
 * and the registry is open for extension. A tool's subcommand surface (its own
 * args/flags) lives on the `Command` it registers, not here.
 */
import type {NodeServices} from "@effect/platform-node";
import type {Command} from "effect/unstable/cli";
import {versionCommand} from "./version.ts";

/** The Node platform service union the bin provides — the requirement ceiling for a tool. */
type Platform = NodeServices.NodeServices;

/**
 * A registered pipeline tool: a top-level `effect/unstable/cli` `Command` whose
 * `name` is the `pipeline-cli <name>` selector.
 *
 * The requirement row is bounded by **the Node platform services** — the one
 * layer the bin provides at the run boundary (`bin.ts`). A tool that needs more
 * than the Node platform (a `Github` capability, a DB) must bake its own layer
 * into its `Command` with `Command.provide(...)` **before** registering, so the
 * registered command's residual requirement is the platform union. That keeps
 * the bin and the router core stable as tools fold in: a tool self-contains its
 * services, the bin never grows a per-tool layer. The `Name`/`Input`/
 * `ContextInput`/`E` slots are left at their widest so the registry stays
 * heterogeneous over tools with different names, args, flags, and error rows;
 * `Name` is `any` because it appears in the contravariant `CommandContext<Name>`
 * position, where a concrete literal (`"version"`) is not assignable to `string` —
 * only `any` admits tools with different literal names into one registry array.
 */
export type RegisteredTool = Command.Command<any, object, object, unknown, Platform>;

/**
 * The registered pipeline tools, in the order they list under `--help`.
 *
 * Phase 1 ships the tracer tool only (`version`); Phase-2 children append their
 * moved tool's `Command` to this array — that single append is the entire
 * registration step (epic #994). The router and bin read this array opaquely, so
 * a new entry needs no edit anywhere else.
 */
export const registeredTools: ReadonlyArray<RegisteredTool> = [versionCommand];
