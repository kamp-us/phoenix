/**
 * The fate codegen entry module — the single module the fate Vite plugin reads
 * at build time (`fate({module: ".../fate/schema.ts", transport: "native"})`):
 * the data-view objects + entity types (re-exported from `views.ts`) and the
 * `fateServer` value (its manifest + `InferFateAPI` for the typed client).
 *
 * `fateServer` is the BUILD-TIME form of `config.ts`'s one config:
 * `toCodegenServer` calls `createFateServer` over the same records (so the
 * manifest matches the served wire contract) with every executor INERT —
 * importing this module constructs pure data, no handler/database/bindings
 * (`.patterns/fate-effect-compiler.md`). The worker entry never imports this
 * file; it serves through the native interpreter (`route.ts`, ADR 0043).
 */
import {FateExecutor} from "@phoenix/fate-effect";
import {fateConfig} from "./config.ts";

export const fateServer = FateExecutor.toCodegenServer(fateConfig);
export * from "./views.ts";
