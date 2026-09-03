import {Effect} from "effect";
import {boot, defaultConfigModule, defaultStateDir} from "./boot.ts";

const configModule = process.argv[2] ?? defaultConfigModule;
const stateDir = process.argv[3] ?? defaultStateDir;

process.exitCode = await Effect.runPromise(
	boot({configModule, stateDir}).pipe(
		Effect.match({
			onFailure: (error) => {
				console.error(`tuval: refusing to boot — ${error.message}`);
				return 1;
			},
			onSuccess: (report) => {
				console.log(
					`tuval: booted — ${report.programCount} program(s) registered from ${report.configModule}; ${report.restoredCount} process(es) restored from ${report.stateDir}`,
				);
				return 0;
			},
		}),
		Effect.scoped,
	),
);
