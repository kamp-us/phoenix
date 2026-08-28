import {createFateServer} from "@nkzw/fate/server";
import {Schema} from "effect";
import type {DiscoveryOutcome} from "../shared/discovery.js";
import {
	type AttachLiveSessionRequest as AttachLiveSessionInput,
	AttachLiveSessionRequest,
	LiveSessionEventsRequest,
	type PromptLiveSessionRequest as PromptLiveSessionInput,
	PromptLiveSessionRequest,
} from "../shared/live-session.js";
import type {LiveSessionService} from "./live-session.js";

const attachInput = {
	parse: (input: unknown): AttachLiveSessionInput =>
		Schema.decodeUnknownSync(AttachLiveSessionRequest)(input),
};
const promptInput = {
	parse: (input: unknown): PromptLiveSessionInput =>
		Schema.decodeUnknownSync(PromptLiveSessionRequest)(input),
};

const noSources = {
	registry: new Map(),
	getSource: (): never => {
		throw new Error("Tuval has no entity sources");
	},
};

export const makeFateServer = (
	discover: () => Promise<DiscoveryOutcome>,
	liveSession: LiveSessionService,
) =>
	createFateServer({
		roots: {},
		sources: noSources,
		queries: {
			discovery: {
				type: "TuvalDiscovery",
				resolve: discover,
			},
			"liveSession.current": {
				type: "TuvalLiveSession",
				resolve: () => liveSession.current(),
			},
			"liveSession.events": {
				type: "TuvalLiveSessionEvent",
				resolve: ({input}: {input: {args?: unknown}}) => {
					const args = Schema.decodeUnknownSync(LiveSessionEventsRequest)(input.args ?? {});
					return liveSession.eventsAfter(args.afterSequence);
				},
			},
		},
		mutations: {
			"liveSession.attach": {
				type: "TuvalLiveSession",
				input: attachInput,
				resolve: ({input}: {input: AttachLiveSessionInput}) => liveSession.attach(input.sessionId),
			},
			"liveSession.prompt": {
				type: "TuvalPromptOutcome",
				input: promptInput,
				resolve: ({input}: {input: PromptLiveSessionInput}) => liveSession.prompt(input),
			},
			"liveSession.release": {
				type: "TuvalLiveSession",
				resolve: () => liveSession.release(),
			},
		},
	});
