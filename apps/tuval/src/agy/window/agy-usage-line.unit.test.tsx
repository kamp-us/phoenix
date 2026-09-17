/**
 * @vitest-environment jsdom
 *
 * What the agy usage line says about the release the session is running on (#9191).
 *
 * The version arrives on this line the same way the model does — off `AiAgentSessionState`, folded
 * from the `version` event `../preflight.ts` announces — so the proof walks that fold rather than
 * handing the component a string: a test that skipped the reducer would pass with the event wired
 * to nothing.
 */

import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {foldEvent, initialState, usageTotals} from "../../ai-agent/core/index.ts";
import {installDomShims} from "../../shell/ui/dom.testing.ts";
import {UsageLine} from "./AgyChatWindow.tsx";

installDomShims();

/** The version arm of the fold sheds nothing, so the window's own limits are left at their defaults. */
const announced = (version: string) =>
	foldEvent(initialState("/repo"), {kind: "version", version}, {});

describe("the agy usage line's version", () => {
	it("names the release the launch read, inside the labelled usage group", () => {
		const state = announced("1.2.1");
		render(<UsageLine usage={usageTotals(state.usage)} agentVersion={state.agentVersion} />);
		expect(screen.getByLabelText("Session usage").textContent).toContain("agy 1.2.1");
	});

	it("says nothing about a version before a session has announced one", () => {
		const state = initialState("/repo");
		expect(state.agentVersion).toBeNull();
		render(<UsageLine usage={usageTotals(state.usage)} agentVersion={state.agentVersion} />);
		expect(screen.getByLabelText("Session usage").textContent).not.toContain("agy");
	});
});
