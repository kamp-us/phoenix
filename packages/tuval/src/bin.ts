#!/usr/bin/env node
import {NodeRuntime} from "@effect/platform-node";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {discoverSessions} from "./backend/discovery.ts";
import {PiAccessLive} from "./backend/pi-access.ts";
import {defaultOpenBrowser, startTuvalServer} from "./backend/server.ts";

const discover = () => Effect.runPromise(discoverSessions.pipe(Effect.provide(PiAccessLive)));

class StartupError extends Schema.TaggedErrorClass<StartupError>()("tuval/StartupError", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

const acquire = Effect.tryPromise({
	try: () =>
		startTuvalServer({
			discover,
			onReady: (url) => console.log(JSON.stringify({event: "ready", url: url.href})),
			...(process.env.TUVAL_NO_OPEN === "1" ? {} : {openBrowser: defaultOpenBrowser}),
		}),
	catch: (cause) =>
		new StartupError({
			message: `Tuval startup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			cause,
		}),
});

Effect.acquireRelease(acquire, (server) =>
	Effect.tryPromise({
		try: () => server.close(),
		catch: (cause) => new StartupError({message: "Tuval shutdown failed", cause}),
	}).pipe(Effect.orDie),
).pipe(
	Effect.flatMap(() => Effect.never),
	Effect.scoped,
	NodeRuntime.runMain,
);
