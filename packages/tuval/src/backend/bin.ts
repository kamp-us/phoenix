#!/usr/bin/env node
import {createUnixTransportFactory} from "@earendil-works/pi-client/unix";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect, Option, Schema} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {startTuval} from "./server.js";

class CliFailure extends Schema.TaggedErrorClass<CliFailure>()("tuval/CliFailure", {
	message: Schema.String,
}) {}

const portFlag = Flag.integer("port").pipe(
	Flag.optional,
	Flag.withDescription("Loopback port (0-65535); omitted chooses a free port"),
);

const openFlag = Flag.boolean("open").pipe(
	Flag.withDefault(true),
	Flag.withDescription("Open Tuval in the default browser after readiness"),
);

const piSocketFlag = Flag.string("pi-socket").pipe(
	Flag.optional,
	Flag.withDescription("Unix socket exposed by `pi --experimental server --listen unix:///path`"),
);

export const tuvalCommand = Command.make(
	"tuval",
	{port: portFlag, open: openFlag, piSocket: piSocketFlag},
	Effect.fn("tuval")(function* ({port, open, piSocket}) {
		const selectedPort = Option.getOrUndefined(port);
		if (selectedPort !== undefined && (selectedPort < 0 || selectedPort > 65_535)) {
			return yield* new CliFailure({message: "--port requires an integer between 0 and 65535"});
		}
		const socketPath = Option.getOrUndefined(piSocket);
		return yield* Effect.scoped(
			Effect.gen(function* () {
				yield* startTuval({
					...(selectedPort === undefined ? {} : {port: selectedPort}),
					...(open ? {} : {openBrowser: () => Effect.void}),
					...(socketPath === undefined
						? {}
						: {liveSessionTransport: createUnixTransportFactory({path: socketPath})}),
					log: (line) => console.log(line),
				});
				return yield* Effect.never;
			}),
		);
	}),
).pipe(Command.withDescription("Run the localhost Tuval pi-session workspace"));

tuvalCommand.pipe(
	Command.run({version: "0.0.0"}),
	Effect.tapError((error) =>
		Console.error(
			`${error instanceof Error ? error.name : "TuvalFailure"}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		),
	),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
