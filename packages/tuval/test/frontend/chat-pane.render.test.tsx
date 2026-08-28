// @vitest-environment jsdom

import {cleanup, render, screen} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {ChatPane} from "../../src/frontend-shell/chat-pane.js";
import type {DiscoveredSession} from "../../src/shared/discovery.js";
import type {AttachedLiveSession} from "../../src/shared/live-session.js";

const selected: DiscoveredSession = {
	identity: "pi:alpha" as DiscoveredSession["identity"],
	piSessionId: "alpha",
	createdAt: 1,
	updatedAt: 2,
	cwd: "/work/alpha",
	sourceFile: "/fixtures/alpha.jsonl",
};

const attached: AttachedLiveSession = {
	_tag: "attached",
	sessionId: "alpha",
	revision: 4,
	phase: "idle",
	model: {provider: "anthropic", id: "claude-sonnet"},
	thinkingLevel: "high",
	completion: "complete",
	transcript: [
		{
			id: "user-1",
			role: "user",
			content: [{type: "text", text: "Canlı arayüzü hazırla"}],
			timestamp: 1,
			status: "complete",
		},
		{
			id: "assistant-1",
			role: "assistant",
			content: [{type: "text", text: "Arayüz hazır."}],
			timestamp: 2,
			status: "complete",
		},
	],
	lastEventSequence: 8,
	connection: "connected",
	ownership: "exclusive",
};

afterEach(cleanup);

describe("ChatPane", () => {
	it("renders the existing transcript and truthful terminal phase through shared primitives", () => {
		const view = render(
			<ChatPane
				selected={selected}
				connection="attached"
				session={attached}
				onClose={vi.fn()}
				onSend={async () => ({ok: true, message: "onaylandı"})}
			/>,
		);
		expect(screen.getByRole("heading", {name: "alpha"})).toBeTruthy();
		expect(screen.getByText("Canlı arayüzü hazırla")).toBeTruthy();
		expect(screen.getByText("Arayüz hazır.")).toBeTruthy();
		expect(screen.getByText("Tur tamamlandı")).toBeTruthy();
		expect(screen.getByRole("textbox", {name: "İstem"})).toBeTruthy();
		expect(view.container.querySelector(".chat-pane.kp-surface")).toBeTruthy();
		expect(view.container.querySelectorAll(".transcript-entry.kp-card")).toHaveLength(2);
		expect(screen.getByRole("button", {name: "Gönder"}).getAttribute("data-scope")).toBe("button");
	});

	it("announces ownership refusal and malformed stream states as accessible errors", () => {
		const view = render(
			<ChatPane
				selected={selected}
				connection="refused"
				session={null}
				message="Başka bir Tuval bu oturumun sahibi."
				onClose={vi.fn()}
				onSend={async () => ({ok: false, message: "reddedildi"})}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain("Oturum açılamadı");
		expect(screen.getByRole("alert").textContent).toContain("Başka bir Tuval");
		expect(screen.getByTestId("empty-state")).toBeTruthy();

		view.rerender(
			<ChatPane
				selected={selected}
				connection="malformed"
				session={attached}
				message="Olay doğrulanamadı."
				onClose={vi.fn()}
				onSend={async () => ({ok: false, message: "reddedildi"})}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain("Canlı akış okunamadı");
		expect(screen.getByText("Arayüz hazır.")).toBeTruthy();
	});
});
