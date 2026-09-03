import {Effect} from "effect";
import {boot, defaultConfigModule} from "./boot.ts";

const configModule = process.argv[2] ?? defaultConfigModule;

process.exitCode = await Effect.runPromise(
	boot(configModule).pipe(
		Effect.match({
			onFailure: (error) => {
				console.error(`tuval: refusing to boot — ${error.message}`);
				return 1;
			},
			onSuccess: (report) => {
				console.log(
					`tuval: booted — ${report.programCount} program(s) registered from ${report.configModule}`,
				);
				return 0;
			},
		}),
	),
);
