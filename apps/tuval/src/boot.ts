import {fileURLToPath} from "node:url";
import {Effect} from "effect";
import {loadConfigModule} from "./config.ts";

/** The config module Tuval boots from when nothing else is named: the app-root `tuval.config.ts`. */
export const defaultConfigModule = fileURLToPath(new URL("../tuval.config.ts", import.meta.url));

export interface BootReport {
	readonly configModule: string;
	readonly programCount: number;
}

export const boot = Effect.fn("Tuval.boot")(function* (configModule: string) {
	const rows = yield* loadConfigModule(configModule);
	return {configModule, programCount: rows.length} satisfies BootReport;
});
