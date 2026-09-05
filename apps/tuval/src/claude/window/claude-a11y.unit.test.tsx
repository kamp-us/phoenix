/**
 * @vitest-environment jsdom
 *
 * The property-based a11y pass over the one region this child builds.
 *
 * `@kampus/design`'s harness covers a primitive in isolation; it does not cover what an app builds
 * out of one (`.patterns/property-based-a11y.md`), and both extra lines are `MetaRow` compositions
 * with Tuval's own text in them. So `runEnforcedInvariants` runs here, scoped to
 * `.tuval-claude-extras` alone: the rest of the window is #7604/#7610's and has its own pass
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
import {claudeChatWindow} from "./ClaudeChatWindow.tsx";
import {claudeSessionState, usageOf} from "./claude-window.testing.ts";

installDomShims();

/**
 * The harness's `PrimitiveSpec` carries an arbitrary because its own runner generates from it;
 * `runEnforcedInvariants` reads only `kind` and `selector`. This is a real arbitrary rather than a
 * cast, and nothing here draws from it.
 */
const presentational: PrimitiveSpec = {kind: "presentational", arb: fc.constant(<span />)};

/** Model names that actually turn up on a Claude session: a short id and a dated long one. */
const model = fc.constantFrom(
	"claude-sonnet-4-5",
	"claude-sonnet-4-5-20250929",
	"claude-opus-4-1-20250805",
	"claude-3-5-haiku-20241022",
);

const usageArb = fc.record({
	model,
	cost: fc.double({min: 0, max: 1_000, noNaN: true, noDefaultInfinity: true}),
	input: fc.nat({max: 5_000_000}),
	output: fc.nat({max: 5_000_000}),
});

/** A session id and a cwd are both operator-visible strings the window does not get to shape. */
const sessionArb = fc.record({
	sessionId: fc.oneof(fc.constant(null), fc.uuid(), fc.string({minLength: 1, maxLength: 60})),
	cwd: fc.constantFrom("/", "/tmp/project", "/a/very/long/path/that/keeps/going/for/a/while/here"),
});

const violationsFor = async (state: AiAgentSessionState): Promise<ReadonlyArray<string>> => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
	);
	const host = await Effect.runPromise(
		process.window<ChatView>(WindowId.make("w1"), initialChatView),
	);
	const rendered = render(
		claudeChatWindow({scrollCommitMs: 0, scrollToFn: () => undefined}).render(host) as ReactElement,
	);
	await screen.findByRole("log", {name: "Transcript"});
	const region = rendered.container.querySelector<HTMLElement>(".tuval-claude-extras");
	const found = region === null ? [] : await runEnforcedInvariants(region, presentational);
	rendered.unmount();
	// A missing region is a failure, not a vacuous pass: the scan below would be empty either way.
	return region === null
		? ["missing: the window rendered no .tuval-claude-extras region"]
		: found.map((violation) => `${violation.id}: ${violation.detail}`);
};

// axe is the cost here — one pass per generated state — so this runs in seconds rather than
// milliseconds and carries its own timeout; Vitest's 5s default times it out in a loaded run.
const SLOW = 60_000;

describe("the two extra lines hold the enforced pillar-4 invariants", () => {
	it(
		"over generated models, costs and token counts",
		async () => {
			await fc.assert(
				fc.asyncProperty(usageArb, async (usage) => {
					expect(await violationsFor(claudeSessionState({usage: usageOf(usage)}))).toEqual([]);
				}),
				{numRuns: 10},
			);
		},
		SLOW,
	);

	it(
		"over generated session ids and working directories",
		async () => {
			await fc.assert(
				fc.asyncProperty(sessionArb, async (session) => {
					expect(await violationsFor(claudeSessionState(session))).toEqual([]);
				}),
				{numRuns: 10},
			);
		},
		SLOW,
	);

	it(
		"and before any usage event has named a model",
		async () => {
			expect(await violationsFor(claudeSessionState())).toEqual([]);
		},
		SLOW,
	);
});
