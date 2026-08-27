#!/usr/bin/env node
import {NodeRuntime} from "@effect/platform-node";
import {Effect} from "effect";
import {StartupFailure, startTuval} from "./server.js";

interface CliOptions {
	readonly port?: number;
	readonly open: boolean;
}

class CliFailure extends Error {
	override readonly name = "CliFailure";
}

export const parseCliArgs = (args: ReadonlyArray<string>): CliOptions => {
	let port: number | undefined;
	let open = true;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--no-open") {
			open = false;
			continue;
		}
		if (argument === "--port") {
			const value = args[index + 1];
			if (value === undefined || !/^\d+$/.test(value)) {
				throw new CliFailure("--port requires an integer between 0 and 65535");
			}
			port = Number(value);
			if (port > 65_535) throw new CliFailure("--port requires an integer between 0 and 65535");
			index += 1;
			continue;
		}
		throw new CliFailure(`Unknown Tuval option: ${argument ?? ""}`);
	}
	return {open, ...(port === undefined ? {} : {port})};
};

const program = Effect.acquireUseRelease(
	Effect.tryPromise({
		try: async () => {
			const options = parseCliArgs(process.argv.slice(2));
			return await startTuval({
				...(options.port === undefined ? {} : {port: options.port}),
				...(options.open ? {} : {openBrowser: async () => {}}),
				log: (line) => console.log(line),
			});
		},
		catch: (error) =>
			error instanceof StartupFailure || error instanceof CliFailure
				? error
				: new StartupFailure("Tuval failed during startup", error),
	}),
	() => Effect.never,
	(server) =>
		Effect.tryPromise({
			try: () => server.close(),
			catch: (error) => new StartupFailure("Tuval failed while shutting down", error),
		}).pipe(Effect.orDie),
).pipe(
	Effect.tapError((error) => Effect.sync(() => console.error(`${error.name}: ${error.message}`))),
);

NodeRuntime.runMain(program);
