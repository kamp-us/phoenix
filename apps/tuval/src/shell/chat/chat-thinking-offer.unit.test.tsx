/**
 * @vitest-environment jsdom
 *
 * A resolved empty thinking offer is not a loading one (#8425).
 *
 * The composer used to read both off one fact — an empty row list — so Pi's faux backend, which
 * offers no levels at all, sat on "loading" for the whole session while answering turns. These
 * cases run the real seam end to end: `composerBridge` decides whether the offer is resolved and
 * `AgentChatInput` renders it, in both variants, so neither half can be right on its own.
 */

import {AgentChatInput, DesignTranslationProvider} from "@kampus/design";
import {act, render, screen, waitFor} from "@testing-library/react";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {ModelState, ThinkingState} from "../../ai-agent/core/index.ts";
import type {Phase} from "../../ai-agent/events.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {type ComposerBridge, composerBridge} from "./composer-bridge.ts";
import {tuvalDesignTranslate} from "./copy.ts";

installDomShims();

const noModels: ModelState = {current: null, available: []};
const noThinking: ThinkingState = {current: null, available: []};
/** Pi's faux backend, which advertises no levels — the session this bug was reported on. */
const emptyOffer: ThinkingState = {current: null, available: []};
const offered: ThinkingState = {current: null, available: ["low", "medium", "high"]};
const picked: ThinkingState = {current: "medium", available: ["low", "medium", "high"]};

type Variant = "focused" | "harness";

const mount = (
	phase: Phase,
	variant: Variant,
	thinking: ThinkingState = noThinking,
): ComposerBridge => {
	const composer = composerBridge({
		initialPhase: phase,
		initialModels: noModels,
		initialCommands: [],
		initialThinking: thinking,
		onPrompt: () => undefined,
		onInterrupt: () => undefined,
		onSetModel: () => undefined,
		onSetThinkingLevel: () => undefined,
	});
	render(
		(
			<DesignTranslationProvider translate={tuvalDesignTranslate}>
				<AgentChatInput bridge={composer.bridge} variant={variant} />
			</DesignTranslationProvider>
		) as ReactElement,
	);
	return composer;
};

/**
 * The control's own reading. The focused variant names itself `<label>: <state>` on a button; the
 * harness variant is a Manti `Select`, whose unselected reading is its placeholder — so this reads
 * the rendered text rather than the accessible name for that one.
 */
const control = async (variant: Variant): Promise<HTMLElement> =>
	variant === "focused"
		? await screen.findByRole("button", {name: /^thinking effort: /})
		: await screen.findByRole("combobox", {name: "Agent thinking effort"});

const reading = async (variant: Variant): Promise<string> =>
	variant === "focused"
		? ((await control(variant)).getAttribute("aria-label") ?? "")
		: ((await control(variant)).textContent ?? "");

describe.each(["focused", "harness"] as const)("the %s thinking control", (variant) => {
	it("says loading only while the offer is unresolved", async () => {
		const composer = mount("starting", variant);
		await waitFor(async () => expect(await reading(variant)).toContain("loading"));

		// The phase carries the answer because every layer owes its catalogs ahead of the `ready`
		// that closes its open — `.patterns/agent-layer-phase-contract.md`, "The open's `ready`
		// ships with its catalogs" — so crossing it resolves the question the control waited on.
		await act(async () => composer.setPhase("ready"));
		await waitFor(async () => expect(await reading(variant)).not.toContain("loading"));
	});

	it("stays on loading across a Claude open's catalog round-trips (#8425)", async () => {
		// `ClaudeAiAgent.open` reads four catalogs off the subprocess before it closes the open, and
		// each is a real IPC round-trip, so its events reach the composer over several ticks. The
		// order that keeps this honest is the layer's own: every catalog first, `ready` last.
		const composer = mount("starting", variant);
		await waitFor(async () => expect(await reading(variant)).toContain("loading"));

		// The `thinking` emit — a model offering no levels, which is what a Claude row without an
		// effort axis answers. The offer is now known and still unresolved to the control, because
		// the open has not closed.
		await act(async () => composer.setThinking(emptyOffer));
		await waitFor(async () => expect(await reading(variant)).toContain("loading"));
		expect(await reading(variant)).not.toContain("none offered");

		// The handshake's `ready`, a tick later. Only here does the empty offer become an answer.
		await act(async () => composer.setPhase("ready"));
		await waitFor(async () => expect(await reading(variant)).toContain("none offered"));
	});

	it("reads a resolved empty offer as nothing offered, and refuses to open", async () => {
		mount("ready", variant, emptyOffer);
		await waitFor(async () => expect(await reading(variant)).toContain("none offered"));
		expect((await control(variant)).getAttribute("disabled")).not.toBeNull();
	});

	it("keeps resolved-populated-unselected apart from resolved-populated-selected", async () => {
		const composer = mount("ready", variant, offered);
		// No row is checked, so the control says so rather than borrowing the first row's label —
		// a fallback would report a level the operator never picked as their selection.
		await waitFor(async () => expect(await reading(variant)).toContain("none selected"));
		expect(await reading(variant)).not.toContain("low");

		await act(async () => composer.setThinking(picked));
		await waitFor(async () => expect(await reading(variant)).toContain("medium"));
	});

	it("follows the offer both ways as the session changes model", async () => {
		const composer = mount("ready", variant, emptyOffer);
		await waitFor(async () => expect(await reading(variant)).toContain("none offered"));

		await act(async () => composer.setThinking(picked));
		await waitFor(async () => expect(await reading(variant)).toContain("medium"));

		// Back to a model that offers none: the rows go, and no level the session no longer runs on
		// is left standing as the current one.
		await act(async () => composer.setThinking(emptyOffer));
		await waitFor(async () => expect(await reading(variant)).toContain("none offered"));
		expect(screen.queryByRole(variant === "focused" ? "menuitemradio" : "option")).toBeNull();
	});

	it("says nothing offered on a restored session whose backend offers no levels", async () => {
		// The reported shape: a restored Pi faux desk, past its turns, phase `ready`. Every capture
		// of it read `loading`, and the session it describes was never going to fill.
		mount("ready", variant, emptyOffer);
		await waitFor(async () => expect(await reading(variant)).toContain("none offered"));
		await waitFor(async () => expect(await reading(variant)).not.toContain("loading"));
	});
});

/**
 * The other half of the same fact, on the axis #8542's founder ruling puts beside the model one: a
 * level held with no live catalog behind it. The focused variant is Tuval's own, and the only one
 * that can name a selection its offer carries no row for.
 */
it("names a held level beside the empty offer rather than instead of it", async () => {
	const composer = mount("ready", "focused", picked);
	await waitFor(async () => expect(await reading("focused")).toContain("medium"));

	// The session goes and its levels go with it. The pick is the operator's, so it stays named.
	await act(async () => composer.setThinking({current: "medium", available: []}));
	await waitFor(async () => expect(await reading("focused")).toContain("none offered"));
	expect(await reading("focused")).toContain("medium");
});
