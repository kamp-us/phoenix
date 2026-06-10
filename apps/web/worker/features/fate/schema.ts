/**
 * The fate codegen entry module — the single module the fate Vite plugin reads
 * (`fate({module: ".../worker/features/fate/schema.ts", transport: "native"})`).
 *
 * The plugin imports this module at build time (`runnerImport`) and needs three
 * things from one place:
 *   1. the runtime data-view objects (it filters `Object.values` for views to
 *      build the schema + manifest),
 *   2. the `fateServer` value (it reads `fateServer.manifest` and
 *      `InferFateAPI<typeof fateServer>` for the typed client roots/mutations),
 *   3. the entity *type* names (`User`, `Term`, `Definition`, `Post`, `Comment`,
 *      `Tag`, `Profile`, `Contribution`) — imported verbatim as the client's
 *      view types — and `Root`.
 *
 * `views.ts` owns 1 + 3; `fateServer` here is the BUILD-TIME form of the one
 * config (`config.ts`): `FateExecutor.toCodegenServer` makes the identical
 * `createFateServer` call the live compile step makes — same record keys, same
 * `type` strings, same `roots: {}`, same `live` passthrough, so the manifest
 * matches the served server's — with every resolver/source executor INERT.
 * Importing this module constructs pure data: no handler runs, no database, no
 * bindings (`.patterns/fate-effect-compiler.md` § "The codegen server"). The
 * worker entry never imports this file — it serves the live compile through
 * `FateExecutor.toFetchHandler` (`route.ts`).
 */
import {FateExecutor} from "@phoenix/fate-effect";
import {fateConfig} from "./config.ts";

export const fateServer = FateExecutor.toCodegenServer(fateConfig);
export * from "./views.ts";
