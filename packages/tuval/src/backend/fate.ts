import {Fate, FateServer} from "@kampus/fate-effect";
import {Effect, Schema} from "effect";
import {AttachLiveSessionRequest, PromptLiveSessionRequest} from "../shared/live-session.js";
import {LineageIndex} from "./lineage.js";
import {LiveSession} from "./live-session.js";
import {PiDiscovery} from "./pi-discovery.js";

export const tuvalFateConfig = FateServer.config({
	queries: {
		lineage: Fate.query(
			{type: "TuvalLineage"},
			Effect.fn("lineage")(function* () {
				const lineage = yield* LineageIndex;
				return yield* lineage.project().pipe(Effect.orDie);
			}),
		),
		discovery: Fate.query(
			{type: "TuvalDiscovery"},
			Effect.fn("discovery")(function* () {
				const discovery = yield* PiDiscovery;
				return yield* discovery.discover();
			}),
		),
		"liveSession.current": Fate.query(
			{type: "TuvalLiveSession"},
			Effect.fn("liveSession.current")(function* () {
				const liveSession = yield* LiveSession;
				return yield* liveSession.current();
			}),
		),
	},
	mutations: {
		"liveSession.attach": Fate.mutation(
			{input: AttachLiveSessionRequest, type: "TuvalLiveSession"},
			Effect.fn("liveSession.attach")(function* ({input}) {
				const liveSession = yield* LiveSession;
				return yield* liveSession.attach(input.sessionId);
			}),
		),
		"liveSession.prompt": Fate.mutation(
			{input: PromptLiveSessionRequest, type: "TuvalPromptOutcome"},
			Effect.fn("liveSession.prompt")(function* ({input}) {
				const liveSession = yield* LiveSession;
				return yield* liveSession.prompt(input);
			}),
		),
		"liveSession.release": Fate.mutation(
			{input: Schema.Struct({}), type: "TuvalLiveSession"},
			Effect.fn("liveSession.release")(function* () {
				const liveSession = yield* LiveSession;
				return yield* liveSession.release();
			}),
		),
	},
});

export const TuvalFateServerLive = FateServer.layer(tuvalFateConfig);
