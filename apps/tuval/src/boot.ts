import {fileURLToPath} from "node:url";
import {Effect, Layer} from "effect";
import {loadConfigModule} from "./config.ts";
import {Checkpoints} from "./durability/Checkpoints.ts";
import {restore} from "./durability/restore.ts";
import {fileStores} from "./durability/stores.ts";
import {Processes} from "./process/Processes.ts";
import type {AnyProgram} from "./registry/program.ts";
import {Registry} from "./registry/Registry.ts";

/** The config module Tuval boots from when nothing else is named: the app-root `tuval.config.ts`. */
export const defaultConfigModule = fileURLToPath(new URL("../tuval.config.ts", import.meta.url));

/** Where the local app checkpoints: `<app root>/.tuval`, through Demlik's `fileStore` (gitignored). */
export const defaultStateDir = fileURLToPath(new URL("../.tuval", import.meta.url));

export interface BootOptions {
	readonly configModule: string;
	readonly stateDir: string;
}

export interface BootReport {
	readonly configModule: string;
	readonly programCount: number;
	readonly stateDir: string;
	readonly restoredCount: number;
}

/**
 * Register the config's rows, then restore every checkpointed process from `stateDir`. A snapshot
 * under another definition refuses the boot here, with nothing fresh-booted (#7467, #7514). The
 * kernel is built into the caller's Scope, so the restored processes live until it closes.
 */
export const boot = Effect.fn("Tuval.boot")(function* (options: BootOptions) {
	// Config rows are trusted local code (#7484 R1.1); the loader checks the list, not each row's shape.
	const rows = (yield* loadConfigModule(options.configModule)) as ReadonlyArray<AnyProgram>;
	const kernel = yield* Layer.build(
		Processes.layer.pipe(
			Layer.provideMerge(Checkpoints.layer(fileStores(options.stateDir))),
			Layer.provide(Registry.layer(rows)),
		),
	);
	const restored = yield* restore.pipe(Effect.provideContext(kernel));
	return {
		configModule: options.configModule,
		programCount: rows.length,
		stateDir: options.stateDir,
		restoredCount: restored.length,
	} satisfies BootReport;
});
