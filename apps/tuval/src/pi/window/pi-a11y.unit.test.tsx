/**
 * @vitest-environment jsdom
 *
 * The property-based a11y pass over the one region this backend contributes.
 *
 * That region moved with #8190: the Pi window's usage line went to the desk inspector the
 * `pi-session` row now declares, so this pass follows it and scans `.tuval-agent-inspector` over Pi
 * session states. The window itself is #7604/#7610's and has its own pass
 * (`../../shell/chat/chat-a11y.unit.test.tsx`); widening the scope here would red this gate on
 * somebody else's defect — the composer's `role="combobox"` textarea (#7876) is exactly that.
 *
 * The renderer is shared with Claude, and so is this scan — but the *states* are not, which is why
 * this pass stays beside the Pi row rather than folding into the Claude one: a Pi session names its
 * models differently and its cwd is whatever project the operator opened.
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
import {AiAgentInspector} from "../../ai-agent/window/index.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../../shell/ui/dom.testing.ts";
import {testProcess} from "../../shell/window/fixtures.ts";
import {type AnyWindowHost, WindowId} from "../../shell/window/index.ts";
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
	const host = await Effect.runPromise(process.window(WindowId.make("w1"), {selected: null}));
	const rendered = render(AiAgentInspector.render(host as AnyWindowHost) as ReactElement);
	await screen.findByRole("group", {name: "Agent session"});
	const region = rendered.container.querySelector<HTMLElement>(".tuval-agent-inspector");
	const found = region === null ? [] : await runEnforcedInvariants(region, presentational);
	rendered.unmount();
	// A missing region is a failure, not a vacuous pass: the scan below would be empty either way.
	return region === null
		? ["missing: the row rendered no .tuval-agent-inspector region"]
		: found.map((violation) => `${violation.id}: ${violation.detail}`);
};

// axe is the cost here — one pass per generated state — so this runs in seconds rather than
// milliseconds and carries its own timeout; Vitest's 5s default times it out in a loaded run.
const SLOW = 60_000;

describe("a Pi session's inspector holds the enforced pillar-4 invariants", () => {
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
