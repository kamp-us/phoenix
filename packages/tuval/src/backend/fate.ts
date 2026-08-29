import {Fate, FateServer} from "@kampus/fate-effect";
import {Effect, Schema} from "effect";
import {
	ExtensionUICancelRequest,
	ExtensionUIResponseRequest,
	ExtensionUIUnloadRequest,
} from "../shared/extension-ui.js";
import {
	AbortLiveSessionRequest,
	AttachLiveSessionRequest,
	CreateLiveSessionRequest,
	OpenLiveSessionRequest,
	PromptLiveSessionRequest,
	SetModelLiveSessionRequest,
	SetThinkingLiveSessionRequest,
	SteerLiveSessionRequest,
} from "../shared/live-session.js";
import {ExtensionUI} from "./extension-ui.js";
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
		"extensionUi.current": Fate.query(
			{type: "TuvalExtensionUISnapshots"},
			Effect.fn("extensionUi.current")(function* () {
				const extensionUI = yield* ExtensionUI;
				return yield* extensionUI.snapshots();
			}),
		),
	},
	mutations: {
		"extensionUi.respond": Fate.mutation(
			{input: ExtensionUIResponseRequest, type: "TuvalExtensionUIResponseOutcome"},
			Effect.fn("extensionUi.respond")(function* ({input}) {
				const extensionUI = yield* ExtensionUI;
				return yield* extensionUI.respond(input);
			}),
		),
		"extensionUi.cancel": Fate.mutation(
			{input: ExtensionUICancelRequest, type: "TuvalExtensionUIResponseOutcome"},
			Effect.fn("extensionUi.cancel")(function* ({input}) {
				const extensionUI = yield* ExtensionUI;
				return yield* extensionUI.cancel(input);
			}),
		),
		"extensionUi.unload": Fate.mutation(
			{input: ExtensionUIUnloadRequest, type: "TuvalExtensionUIUnloadOutcome"},
			Effect.fn("extensionUi.unload")(function* ({input}) {
				const extensionUI = yield* ExtensionUI;
				return yield* extensionUI.unload(input.scope);
			}),
		),
		"liveSession.create": Fate.mutation(
			{input: CreateLiveSessionRequest, type: "TuvalControlOutcome"},
			Effect.fn("liveSession.create")(function* ({input}) {
				const liveSession = yield* LiveSession;
				return yield* liveSession.create(input);
			}),
		),
		"liveSession.open": Fate.mutation(
			{input: OpenLiveSessionRequest, type: "TuvalControlOutcome"},
			Effect.fn("liveSession.open")(function* ({input}) {
				const liveSession = yield* LiveSession;
				return yield* liveSession.open(input);
			}),
		),
		"liveSession.steer": Fate.mutation(
			{input: SteerLiveSessionRequest, type: "TuvalControlOutcome"},
			Effect.fn("liveSession.steer")(function* ({input}) {
				const liveSession = yield* LiveSession;
				return yield* liveSession.steer(input);
			}),
		),
		"liveSession.abort": Fate.mutation(
			{input: AbortLiveSessionRequest, type: "TuvalControlOutcome"},
			Effect.fn("liveSession.abort")(function* ({input}) {
				const liveSession = yield* LiveSession;
				return yield* liveSession.abort(input);
			}),
		),
		"liveSession.setModel": Fate.mutation(
			{input: SetModelLiveSessionRequest, type: "TuvalControlOutcome"},
			Effect.fn("liveSession.setModel")(function* ({input}) {
				const liveSession = yield* LiveSession;
				return yield* liveSession.setModel(input);
			}),
		),
		"liveSession.setThinking": Fate.mutation(
			{input: SetThinkingLiveSessionRequest, type: "TuvalControlOutcome"},
			Effect.fn("liveSession.setThinking")(function* ({input}) {
				const liveSession = yield* LiveSession;
				return yield* liveSession.setThinking(input);
			}),
		),
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
