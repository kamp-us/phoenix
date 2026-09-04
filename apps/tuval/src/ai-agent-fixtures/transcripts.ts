/**
 * Transcript builders and a seeded random-transcript generator, for the property-style tests over
 * the history bounds.
 *
 * It lives outside `src/ai-agent/` for the same reason `programs.ts` does: `ItemId` is a branded
 * schema, so minting one needs `effect`, and nothing under `src/ai-agent/history/` may import it.
 * The generator is deterministic — a seed names a transcript, so a red run is reproducible from
 * the seed the failure prints, with no dependency on a property-testing library.
 */

import {
	type AssistantItem,
	boundToolResult,
	ItemId,
	type SystemItem,
	type ToolItem,
	type TranscriptItem,
	type UserItem,
} from "../ai-agent/ports/index.ts";

const AT = 1_756_000_000_000;

export const userItem = (id: string, text = "prompt", timestamp = AT): UserItem => ({
	kind: "user",
	id: ItemId.make(id),
	timestamp,
	text,
});

export const assistantItem = (
	id: string,
	text = "answer",
	timestamp = AT,
	interrupted?: boolean,
): AssistantItem => ({
	kind: "assistant",
	id: ItemId.make(id),
	timestamp,
	text,
	...(interrupted === undefined ? {} : {interrupted}),
});

export const toolItem = (id: string, output = "ok", timestamp = AT): ToolItem => ({
	kind: "tool",
	id: ItemId.make(id),
	timestamp,
	name: "read_file",
	input: {path: "README.md"},
	result: boundToolResult(output),
	status: "ok",
});

export const systemItem = (id: string, text = "resumed", timestamp = AT): SystemItem => ({
	kind: "system",
	id: ItemId.make(id),
	timestamp,
	text,
});

/**
 * A 32-bit linear congruential generator (Numerical Recipes' constants). Deterministic and tiny:
 * the point is a reproducible stream of transcripts, not statistical quality.
 */
export const randomStream = (seed: number) => {
	let state = seed >>> 0 || 1;
	const next = () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
	return {
		next,
		int: (bound: number) => Math.floor(next() * bound),
		chance: (probability: number) => next() < probability,
	};
};

export interface RandomTranscriptOptions {
	/** How many exchanges, system notices and orphan turns to lay down, oldest-first. */
	readonly groups?: number;
	/** Longest tool result the generator emits, before the per-item bound. */
	readonly maxOutput?: number;
}

/**
 * A well-formed oldest-first transcript: prompt-led exchanges, the occasional session notice, and
 * an occasional leading orphan turn so a slice that starts mid-exchange is exercised too.
 */
export const randomTranscript = (
	seed: number,
	options: RandomTranscriptOptions = {},
): ReadonlyArray<TranscriptItem> => {
	const random = randomStream(seed);
	const groups = options.groups ?? 12;
	const maxOutput = options.maxOutput ?? 400;
	const items: Array<TranscriptItem> = [];
	const id = () => `i${items.length}`;
	for (let group = 0; group < groups; group += 1) {
		if (random.chance(0.15)) {
			items.push(systemItem(id(), "x".repeat(random.int(40))));
			continue;
		}
		if (group > 0 || random.chance(0.5)) {
			items.push(userItem(id(), "x".repeat(random.int(120))));
		}
		items.push(assistantItem(id(), "x".repeat(random.int(200))));
		const tools = random.int(4);
		for (let tool = 0; tool < tools; tool += 1) {
			items.push(toolItem(id(), "x".repeat(random.int(maxOutput))));
		}
	}
	return items;
};
