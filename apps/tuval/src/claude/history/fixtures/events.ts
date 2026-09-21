/**
 * A captured fixture as the agent events it maps to, frame by frame.
 *
 * The Agent SDK's surface stops at `src/claude/` (`../../agent/boundary.unit.test.ts`), and
 * `loadFixture` returns `unknown` — so a test outside this directory that wanted to drive a capture
 * through `toAgentEvents` had to name `SDKMessage` to bridge the two. That is the boundary breach
 * this file exists to remove: it does the naming here, once, and hands back `AgentEvent`s, which
 * every layer of the app already speaks.
 */

import type {SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import type {AgentEvent} from "../../../ai-agent/events.ts";
import {toAgentEvents} from "../events.ts";
import {emptyMapping, type MappingOptions} from "../map.ts";
import {type FixtureName, loadFixture} from "./load.ts";

/**
 * The events each frame of `name` maps to, in frame order, with the mapping carried across them as
 * the live layer carries it.
 *
 * One array per frame rather than one flat stream: a caller asking what the session looked like
 * *between* two frames — which is the whole subject of a background spawn — needs the seam, and a
 * flattened list has none.
 */
export const fixtureEventFrames = (
	name: FixtureName,
	options: MappingOptions,
): ReadonlyArray<ReadonlyArray<AgentEvent>> => {
	const frames = loadFixture(name) as ReadonlyArray<SDKMessage>;
	const perFrame: Array<ReadonlyArray<AgentEvent>> = [];
	let mapping = emptyMapping;
	for (const one of frames) {
		const step = toAgentEvents(one, mapping, options);
		mapping = step.mapping;
		perFrame.push(step.events);
	}
	return perFrame;
};

/**
 * The events a single-frame capture maps to, on an empty mapping.
 *
 * The frame-by-frame answer above is for a capture that is an array; a fixture that is one frame —
 * a local command's turn, say — has no seam to carry a mapping across, and a caller handed one
 * array per frame would only flatten it back.
 */
export const fixtureEvents = (
	name: FixtureName,
	options: MappingOptions,
): ReadonlyArray<AgentEvent> =>
	toAgentEvents(loadFixture(name) as SDKMessage, emptyMapping, options).events;
