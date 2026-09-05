/**
 * @vitest-environment jsdom
 *
 * The property-based a11y pass over the one region this child builds.
 *
 * `@kampus/design`'s harness covers a primitive in isolation; it does not cover what an app builds
 * out of one (`.patterns/property-based-a11y.md`), and the usage line is a `MetaRow` composition
 * with Tuval's own text in it. So `runEnforcedInvariants` runs here, scoped to `.tuval-pi-usage`
 * alone: the rest of the window is #7604/#7610's and has its own pass
 * (`../../shell/chat/chat-a11y.unit.test.tsx`), and widening the scope here would red this gate on
 * somebody else's defect — the composer's `role="combobox"` textarea (#7876) is exactly that.
 *
 * Only the jsdom-decidable invariants run, as upstream: contrast and tap-target are `warning`
 * posture because jsdom applies no CSS and has no layout, and asserting either would be a false
 * gate.
 */

import type {PrimitiveSpec} from "@kampus/design/a11y";
import {runEnforcedInvariants} from "@kampus/design/a11y";
import {render, screen} from "@testing-library/react";
import {Effect} from "effect";
import fc from "fast-check";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {ProcessId} from "../../process/process.ts";
import {type ChatView, initialChatView} from "../../shell/chat/index.ts";
import {installDomShims} from "../../shell/ui/dom.testing.ts";
import {testProcess} from "../../shell/window/fixtures.ts";
import {WindowId} from "../../shell/window/index.ts";
import {piChatWindow} from "./PiChatWindow.tsx";
import {piSession, usageOf} from "./pi-window.testing.ts";

installDomShims();

/**
 * The harness's `PrimitiveSpec` carries an arbitrary because its own runner generates from it;
 * `runEnforcedInvariants` reads only `kind` and `selector`. This is a real arbitrary rather than a
 * cast, and nothing here draws from it.
 */
const presentational: PrimitiveSpec = {kind: "presentational", arb: fc.constant(<span />)};

/** Model names that actually turn up: a provider pair, a bare id, a long one, and none at all. */
const model = fc.constantFrom(
	"faux/faux-1",
	"anthropic/claude-sonnet-4-5-20250929",
	"gpt-5",
	"openai/o4-mini-high-2025-04-16-preview",
);

const usageArb = fc.record({
	model,
	cost: fc.double({min: 0, max: 1_000, noNaN: true, noDefaultInfinity: true}),
	input: fc.nat({max: 5_000_000}),
	output: fc.nat({max: 5_000_000}),
});

const violationsFor = async (state: AiAgentSessionState): Promise<ReadonlyArray<string>> => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
	);
	const host = await Effect.runPromise(
		process.window<ChatView>(WindowId.make("w1"), initialChatView),
	);
	const rendered = render(
		piChatWindow({scrollCommitMs: 0, scrollToFn: () => undefined}).render(host) as ReactElement,
	);
	await screen.findByRole("log", {name: "Transcript"});
	const region = rendered.container.querySelector<HTMLElement>(".tuval-pi-usage");
	const found = region === null ? [] : await runEnforcedInvariants(region, presentational);
	rendered.unmount();
	// A missing region is a failure, not a vacuous pass: the scan below would be empty either way.
	return region === null
		? ["missing: the window rendered no .tuval-pi-usage region"]
		: found.map((violation) => `${violation.id}: ${violation.detail}`);
};

// axe is the cost here — one pass per generated state — so this runs in seconds rather than
// milliseconds and carries its own timeout; Vitest's 5s default times it out in a loaded run.
const SLOW = 60_000;

describe("the usage line holds the enforced pillar-4 invariants", () => {
	it(
		"over generated models, costs and token counts",
		async () => {
			await fc.assert(
				fc.asyncProperty(usageArb, async (usage) => {
					expect(await violationsFor(piSession({usage: usageOf(usage)}))).toEqual([]);
				}),
				{numRuns: 10},
			);
		},
		SLOW,
	);

	it(
		"and before any usage event has named a model",
		async () => {
			expect(await violationsFor(piSession())).toEqual([]);
		},
		SLOW,
	);
});
