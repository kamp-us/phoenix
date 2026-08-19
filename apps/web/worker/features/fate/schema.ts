/**
 * The fate codegen entry module: the one module the fate Vite plugin reads at build
 * time. `fateServer` is the BUILD-TIME form of `config.ts`'s config, built over the
 * same records so the manifest matches the served wire contract, but with every
 * executor inert — importing this constructs pure data, no handlers or bindings (see
 * .patterns/fate-effect-compiler.md). The worker entry never imports this file; it
 * serves through the native interpreter (ADR 0043).
 */
import {FateExecutor} from "@kampus/fate-effect";
import {fateConfig} from "./config.ts";

export const fateServer = FateExecutor.toCodegenServer(fateConfig);
export * from "./views.ts";
