/**
 * @vitest-environment jsdom
 *
 * The shared ai-agent inspector: the five facts the chat bar used to carry, and the walk that puts
 * them on screen.
 *
 * The last describe is the sharpest. It builds the snapshot out of the **real** `claude-session` and
 * `pi-session` rows and the **real** page inspector table, so what it proves is that a reference a
 * row declares resolves to the renderer the page binds — not that two hand-written tables agree
 * with each other. Both rows and the table are imported; nothing here restates a reference.
 */

import {readFileSync} from "node:fs";
import {join} from "node:path";
import {render, screen, waitFor, within} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import {claudeSession} from "../../claude/program.ts";
import {pageInspectors} from "../../page/renderers.tsx";
import {piSessionProgram} from "../../pi/program.ts";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import {deskSnapshot} from "../../shell/desk/fixtures.ts";
import {inspectorFor} from "../../shell/desk/index.ts";
import {installDomShims} from "../../shell/ui/dom.testing.ts";
import {testProcess} from "../../shell/window/fixtures.ts";
import {type AnyWindowHost, WindowId} from "../../shell/window/index.ts";
import type {AgentAccount, AiAgentSessionMsg, AiAgentSessionState} from "../core/index.ts";
import {ScriptedAiAgent} from "../service/index.ts";
import {AiAgentInspector} from "./AiAgentInspector.tsx";
import {agentSessionState, CWD, SESSION_ID, usageOf} from "./inspector.testing.ts";

installDomShims();

const processId = ProcessId.make("p1");

/** The panel over a live process, mounted the way the desk region mounts it. */
const open = async (state: AiAgentSessionState) => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(processId, state),
	);
	const host = await Effect.runPromise(process.window(WindowId.make("w0"), {selected: null}));
	render(AiAgentInspector.render(host as AnyWindowHost) as ReactElement);
	await screen.findByRole("group", {name: "Agent session"});
	return {process};
};

const panel = (): HTMLElement => screen.getByRole("group", {name: "Agent session"});

describe("what the inspector shows", () => {
	it("uses tabular figures only for cost and token counts", async () => {
		const style = document.createElement("style");
		style.textContent = readFileSync(join(import.meta.dirname, "ai-agent-inspector.css"), "utf8");
		document.head.append(style);
		try {
			await open(agentSessionState({agentVersion: "2.1.259"}));
			for (const row of panel().querySelectorAll(".tuval-agent-inspector-row")) {
				const label = row.querySelector("dt")?.textContent;
				const value = row.querySelector("dd") as HTMLElement;
				const numeric = ["Cost", "Input tokens", "Output tokens"].includes(label ?? "");
				expect(getComputedStyle(value).fontVariantNumeric === "tabular-nums").toBe(numeric);
				if (label === "Session" || label === "Directory")
					expect(getComputedStyle(value).overflowWrap).toBe("anywhere");
			}
		} finally {
			style.remove();
		}
	});
	it("renders the cost, the token counts, the session id and the cwd off the state", async () => {
		await open(
			agentSessionState({
				usage: usageOf({model: "claude-sonnet-4-5", cost: 0.0142, input: 1204, output: 340}),
			}),
		);
		const region = panel();
		expect(within(region).getByText("$0.0142")).toBeDefined();
		expect(within(region).getByText("1,204")).toBeDefined();
		expect(within(region).getByText("340")).toBeDefined();
		expect(within(region).getByText(SESSION_ID)).toBeDefined();
		expect(within(region).getByText(CWD)).toBeDefined();
	});

	it("renders the version the layer reported, beside the session id and the cwd", async () => {
		await open(agentSessionState({agentVersion: "2.1.259"}));
		const region = panel();
		expect(within(region).getByText("Version")).toBeDefined();
		expect(within(region).getByText("2.1.259")).toBeDefined();
		expect(within(region).getByText(SESSION_ID)).toBeDefined();
		expect(within(region).getByText(CWD)).toBeDefined();
	});

	// Unlike the session id, an absent version is not a state the operator is owed a word about.
	it("leaves the row out entirely while no layer has reported one", async () => {
		await open(agentSessionState({agentVersion: null}));
		expect(within(panel()).queryByText("Version")).toBeNull();
	});

	it("names the account the session booted on, as organization and plan", async () => {
		await open(agentSessionState({account: {organization: "kamp.us", subscriptionType: "max"}}));
		const region = panel();
		expect(within(region).getByText("Account (booted on)")).toBeDefined();
		expect(within(region).getByText("kamp.us · max")).toBeDefined();
	});

	// Each field stands alone: an API-key login reports a plan and no organization, and a fixed
	// `org · plan` template would render a separator against nothing.
	it("shows whichever of the two fields the login reported", async () => {
		await open(agentSessionState({account: {subscriptionType: "max"}}));
		expect(within(panel()).getByText("max")).toBeDefined();
	});

	it("leaves the row out while no layer has reported an account", async () => {
		await open(agentSessionState({account: null}));
		expect(within(panel()).queryByText("Account (booted on)")).toBeNull();
	});

	// An account with neither field is what a third-party provider answers with, and a row reading
	// `Account (booted on)` against an empty value says less than no row at all.
	it("leaves the row out when the reported account carries neither field", async () => {
		await open(agentSessionState({account: {}}));
		expect(within(panel()).queryByText("Account (booted on)")).toBeNull();
	});

	// The founder ruled org and plan only, and the ruling holds at two places on this path. Here is
	// the render: an account is one line of the fields the row shows, so nothing else on it reaches
	// the panel however the state was built.
	it("renders the row as the two ruled fields and nothing else", async () => {
		await open(agentSessionState({account: {organization: "kamp.us", subscriptionType: "max"}}));
		const row = [...panel().querySelectorAll(".tuval-agent-inspector-row")].find(
			(candidate) => candidate.querySelector("dt")?.textContent === "Account (booted on)",
		);
		expect(row?.querySelector("dd")?.textContent).toBe("kamp.us · max");
	});

	// And here is the reader in front of it. `AgentAccount` has no email field, so a state carrying
	// one was not written by this program — `isAiAgentSessionState` refuses it, and the panel never
	// takes the state rather than taking it and filtering the field at the edge.
	it("refuses a state whose account carries an email, so none is ever on screen", async () => {
		const email = "someone@example.com";
		render(
			AiAgentInspector.render(
				(await Effect.runPromise(
					Effect.flatMap(
						testProcess<AiAgentSessionState, AiAgentSessionMsg>(
							ProcessId.make("p-email"),
							agentSessionState({
								account: {organization: "kamp.us", subscriptionType: "max", email} as AgentAccount,
							}),
						),
						(process) => process.window(WindowId.make("w-email"), {selected: null}),
					),
				)) as AnyWindowHost,
			) as ReactElement,
		);
		await screen.findByTestId("empty-state");
		expect(screen.queryByRole("group", {name: "Agent session"})).toBeNull();
		expect(document.body.textContent).not.toContain(email);
	});

	it("names every value, because a bare number names nothing to a screen reader", async () => {
		await open(agentSessionState());
		for (const label of ["Cost", "Input tokens", "Output tokens", "Session", "Directory"]) {
			expect(within(panel()).getByText(label)).toBeDefined();
		}
	});

	it("says so rather than blanking before start has answered with a session id", async () => {
		await open(agentSessionState({sessionId: null, phase: "starting"}));
		expect(within(panel()).getByText("no session yet")).toBeDefined();
		expect(within(panel()).getByText("$0.00")).toBeDefined();
	});

	it("moves as usage accumulates on the process", async () => {
		const state = agentSessionState({
			usage: usageOf({model: "faux/faux-1", cost: 0.01, input: 100, output: 10}),
		});
		const {process} = await open(state);
		expect(within(panel()).getByText("100")).toBeDefined();

		await Effect.runPromise(
			process.commit({
				...state,
				sessionId: "second",
				usage: usageOf({model: "faux/faux-2", cost: 0.0325, input: 2500, output: 640}),
			}),
		);

		await waitFor(() => {
			const region = panel();
			expect(within(region).getByText("$0.0325")).toBeDefined();
			expect(within(region).getByText("2,500")).toBeDefined();
			expect(within(region).getByText("640")).toBeDefined();
			expect(within(region).getByText("second")).toBeDefined();
		});
	});

	// Cost and token counts move on every usage event of a running turn, so a live region here would
	// narrate the whole turn to a screen-reader user.
	it("is not a live region", async () => {
		await open(agentSessionState({phase: "prompting"}));
		expect(panel().tagName).toBe("FIELDSET");
		expect(panel().getAttribute("aria-live")).toBeNull();
	});
});

describe("the reference both backend rows declare", () => {
	// The layer is a stub: these two cases read what the rows *declare*, and never run one.
	const scripted = ScriptedAiAgent.layer({
		sessionId: "inspector-test",
		history: [],
		modes: {current: null, available: []},
		models: {current: null, available: []},
		thinking: {current: null, available: []},
		interrupt: [],
		turns: [],
	});
	const claudeRow = claudeSession({cwd: CWD, layer: scripted});
	const piRow = piSessionProgram({cwd: CWD, layer: scripted});

	it("is the same one, because every value in the panel is generic session state", () => {
		expect(claudeRow.inspector).toBeDefined();
		expect(claudeRow.inspector).toEqual(piRow.inspector);
	});

	it.each([
		["claude-session", claudeRow],
		["pi-session", piRow],
	])("resolves to the page's inspector renderer for %s", async (_name, row) => {
		const programId = ProgramId.make(row.id);
		const process = await Effect.runPromise(
			testProcess<AiAgentSessionState, AiAgentSessionMsg>(processId, agentSessionState()),
		);
		const host = await Effect.runPromise(process.window(WindowId.make("w0"), {selected: null}));
		const region = inspectorFor(
			deskSnapshot({
				focused: {windowId: WindowId.make("w0"), processId, host: host as AnyWindowHost},
				processes: {[processId]: {programId}},
				programs: {[programId]: row},
				inspectors: pageInspectors,
			}),
		);
		expect(region._tag).toBe("Inspector");
		if (region._tag !== "Inspector") return;
		expect(region.renderer).toBe(AiAgentInspector);
	});
});
