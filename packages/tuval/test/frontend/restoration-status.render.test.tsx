// @vitest-environment jsdom
import {cleanup, render, screen} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {RestorationStatus} from "../../src/frontend-shell/restoration-status.js";

const degradedSnapshot = {
	stages: [
		{stage: "discovery" as const, status: "restored" as const},
		{stage: "lineage" as const, status: "degraded" as const},
	],
	selectedSessionId: "missing-child",
	settings: {},
	packageRegistrations: ["healthy-package"],
	extensionUI: [],
	diagnostics: [
		{
			category: "persistence" as const,
			code: "selected-session-state-invalid" as const,
			message: "Persisted selected-session state was invalid",
			action: "Select a retained session again",
		},
		{
			category: "package" as const,
			code: "package-registration-unavailable" as const,
			message: "One package is unavailable",
			action: "Review that package registration",
			packageName: "broken-package",
		},
	],
};

afterEach(cleanup);

describe("RestorationStatus", () => {
	it("keeps independent diagnostics actionable beside healthy state", () => {
		const useFirst = vi.fn();
		render(
			<RestorationStatus
				snapshot={degradedSnapshot}
				failure={null}
				selection={{
					_tag: "unavailable",
					sessionId: "missing-child",
					reason: "Kalıcı seçim artık kullanılabilir oturumlar arasında değil.",
				}}
				onUseFirstSession={useFirst}
			/>,
		);
		expect(screen.getByText("Kalıcı bağlar")).toBeTruthy();
		expect(screen.getByText("Kalıcı çalışma alanı")).toBeTruthy();
		expect(screen.getByText("Paket")).toBeTruthy();
		expect(screen.getByText("Önceki sohbet kullanılamıyor")).toBeTruthy();
		screen.getByRole("button", {name: "Kullanılabilir oturuma geç"}).click();
		expect(useFirst).toHaveBeenCalledOnce();
	});

	it("keeps the safe fallback reachable when durable selection was cleared", () => {
		const useFirst = vi.fn();
		render(
			<RestorationStatus
				snapshot={{...degradedSnapshot, selectedSessionId: null}}
				failure={null}
				selection={{
					_tag: "unavailable",
					sessionId: null,
					reason: "Kalıcı oturum artık kullanılamıyor.",
				}}
				onUseFirstSession={useFirst}
			/>,
		);
		expect(screen.getByText("Önceki sohbet kullanılamıyor")).toBeTruthy();
		expect(screen.queryByText(/^Oturum:/)).toBeNull();
		screen.getByRole("button", {name: "Kullanılabilir oturuma geç"}).click();
		expect(useFirst).toHaveBeenCalledOnce();
	});

	it("renders the compact healthy restoration state without a false warning", () => {
		render(
			<RestorationStatus
				snapshot={{...degradedSnapshot, stages: [], diagnostics: []}}
				failure={null}
				selection={{_tag: "restored", sessionId: "child"}}
				onUseFirstSession={() => undefined}
			/>,
		);
		expect(screen.getByText("Çalışma alanı geri yüklendi")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
