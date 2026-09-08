/**
 * @vitest-environment jsdom
 *
 * The five agent controls the window adds on top of the transcript: the collapsible tool row, the
 * permission cards, the mode switch, and the composer's model and slash-command pickers. Same test
 * double as the transcript's own tests (`../window/fixtures.ts`) — no kernel, no socket, no layer.
 *
 * Every control here is Manti-backed, so a click and a same-tick read prove nothing: Zag defers the
 * transition by at least one microtask (`.patterns/zag-machine-interaction-tests.md`). Each
 * interaction below is inside `act` for exactly that reason.
 */

import {act, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims, TEST_VIEWPORT} from "../ui/dom.testing.ts";
import {type TestProcess, testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {type ChatWindowHost, chatWindow} from "./ChatWindow.tsx";
import {
	assistantItem,
	call,
	commands,
	models,
	modes,
	pendingPermission,
	permissionRequest,
	thinking,
	userItem,
	withTranscript,
} from "./chat.testing.ts";
import {initialChatView} from "./view.ts";

installDomShims();

const processId = ProcessId.make("p1");

const open = async (
	state: AiAgentSessionState,
): Promise<{
	readonly process: TestProcess<AiAgentSessionState, AiAgentSessionMsg>;
	readonly host: ChatWindowHost;
}> => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(processId, state),
	);
	const host = await Effect.runPromise(process.window(WindowId.make("w1"), initialChatView));
	render(chatWindow({scrollCommitMs: 0, scrollToFn: () => undefined}).render(host) as ReactElement);
	await screen.findByRole("log", {name: "Transcript"});
	return {process, host};
};

const click = async (element: HTMLElement): Promise<void> => {
	await act(async () => {
		fireEvent.click(element);
	});
};

/**
 * Whether a disclosure's panel is exposed. Zag hides a closed panel with the `hidden` attribute
 * (`@zag-js/collapsible@1.43.0`, `collapsible.connect.mjs` `getContentProps`), which leaves its text
 * in the DOM — so a `queryByText` proves nothing about what a reader can reach, and this reads the
 * attribute the machine actually sets.
 */
const panelsShown = (): ReadonlyArray<HTMLElement> =>
	Array.from(
		document.querySelectorAll<HTMLElement>('[data-scope="collapsible"][data-part="content"]'),
	).filter((panel) => !panel.hidden);

describe("a collapsible tool row", () => {
	it("shows the name and the status collapsed, and the input and result expanded", async () => {
		const {host} = await open(
			withTranscript([call("t1", {name: "grep", input: {pattern: "TODO"}, output: "3 hits"})]),
		);
		const trigger = await screen.findByRole("button", {name: "grep ok"});
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(panelsShown()).toEqual([]);

		await click(trigger);
		await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
		const [panel] = panelsShown();
		expect(panel?.textContent).toContain("3 hits");
		expect(panel?.textContent).toContain('"pattern": "TODO"');
		expect(host.view().expanded).toEqual(["t1"]);
	});

	it("renders an edit call as a diff, with a marker word per changed line", async () => {
		await open(
			withTranscript([
				call("t1", {
					name: "edit",
					input: {
						path: "src/a.ts",
						old_text: "const a = 1;\nkeep();",
						new_text: "const a = 2;\nkeep();",
					},
				}),
			]),
		);
		await click(await screen.findByRole("button", {name: "edit ok"}));
		const table = await screen.findByRole("table", {name: "Changes to src/a.ts"});
		expect(within(table).getByRole("rowheader", {name: "removed"})).toBeDefined();
		expect(within(table).getByRole("rowheader", {name: "added"})).toBeDefined();
		expect(within(table).getByText("const a = 1;")).toBeDefined();
		expect(within(table).getByText("const a = 2;")).toBeDefined();
		// The unchanged line is present and is named, so a screen reader reads context as context.
		expect(within(table).getAllByRole("rowheader", {name: "unchanged"}).length).toBe(1);
	});

	it("renders a shell call as the command plus the output", async () => {
		await open(
			withTranscript([
				call("t1", {name: "bash", input: {command: "pnpm test"}, output: "12 passed"}),
			]),
		);
		await click(await screen.findByRole("button", {name: "bash ok"}));
		expect(await screen.findByText("command")).toBeDefined();
		expect(screen.getByText("pnpm test")).toBeDefined();
		expect(screen.getByText("output")).toBeDefined();
		expect(screen.getByText("12 passed")).toBeDefined();
	});

	it("says how many bytes the per-item bound left out", async () => {
		await open(
			withTranscript([call("t1", {output: "0123456789abcdef-and-more", resultLimit: 16})]),
		);
		await click(await screen.findByRole("button", {name: "read_file ok"}));
		expect(await screen.findByText("9 bytes omitted from this result")).toBeDefined();
	});

	it("says nothing about omission when the result came back whole", async () => {
		await open(withTranscript([call("t1", {output: "short"})]));
		await click(await screen.findByRole("button", {name: "read_file ok"}));
		await screen.findByText("short");
		expect(screen.queryByText(/bytes omitted/)).toBeNull();
	});

	it("keeps the open row open across a state update, off the view slot", async () => {
		const {process, host} = await open(withTranscript([call("t1"), userItem("u1", "next")]));
		await click(await screen.findByRole("button", {name: "read_file ok"}));
		await waitFor(() => expect(host.view().expanded).toEqual(["t1"]));

		await act(async () => {
			await Effect.runPromise(
				process.commit(withTranscript([call("t1"), userItem("u1", "next")], {phase: "prompting"})),
			);
		});
		const trigger = await screen.findByRole("button", {name: "read_file ok"});
		expect(trigger.getAttribute("aria-expanded")).toBe("true");

		await click(trigger);
		await waitFor(() => expect(host.view().expanded).toEqual([]));
	});
});

describe("permission cards", () => {
	const pending = (requests: AiAgentSessionState["permissions"]): AiAgentSessionState =>
		withTranscript([userItem("u1", "go")], {permissions: requests});

	it("renders the request's fields as a named region", async () => {
		await open(pending({r1: pendingPermission()}));
		const card = await screen.findByRole("region", {name: "Run a command"});
		expect(within(card).getByText("bash")).toBeDefined();
		expect(
			within(card).getByText("The agent wants to run a shell command in the project."),
		).toBeDefined();
		expect(within(card).getByText(/"command": "rm -rf build"/)).toBeDefined();
	});

	it("dispatches exactly one answer per action, carrying the decision", async () => {
		const {process} = await open(pending({r1: pendingPermission()}));
		const card = await screen.findByRole("region", {name: "Run a command"});
		await click(within(card).getByRole("button", {name: "Allow once"}));
		await waitFor(() => expect(process.inbox().length).toBe(1));
		expect(process.inbox()[0]).toEqual({type: "answer", request: "r1", decision: "allow-once"});
	});

	it("carries the operator's optional message when one was typed", async () => {
		const {process} = await open(pending({r1: pendingPermission()}));
		const card = await screen.findByRole("region", {name: "Run a command"});
		await act(async () => {
			fireEvent.change(within(card).getByRole("textbox", {name: /Message/}), {
				target: {value: "  not on this project  "},
			});
		});
		await click(within(card).getByRole("button", {name: "Deny"}));
		await waitFor(() => expect(process.inbox().length).toBe(1));
		expect(process.inbox()[0]).toEqual({
			type: "answer",
			request: "r1",
			decision: "deny",
			message: "not on this project",
		});
	});

	it("offers allow-always only when the request says it is on offer", async () => {
		await open(
			pending({r1: pendingPermission({request: permissionRequest({offersAlways: false})})}),
		);
		const card = await screen.findByRole("region", {name: "Run a command"});
		expect(within(card).queryByRole("button", {name: "Allow always"})).toBeNull();
		expect(within(card).getByRole("button", {name: "Allow once"})).toBeDefined();
		expect(within(card).getByRole("button", {name: "Deny"})).toBeDefined();
	});

	it("stops offering an answer while one is awaiting confirmation, and says so", async () => {
		await open(
			pending({
				r1: pendingPermission({progress: {status: "answering", decision: "allow-once"}}),
			}),
		);
		const card = await screen.findByRole("region", {name: "Run a command"});
		for (const name of ["Allow once", "Allow always", "Deny"]) {
			expect(within(card).getByRole("button", {name}).getAttribute("disabled")).not.toBeNull();
		}
		expect(
			within(card)
				.getByRole("textbox", {name: /Message/})
				.getAttribute("disabled"),
		).not.toBeNull();
		expect(within(card).getByText(/waiting for the agent to confirm/i)).toBeDefined();
	});

	// No retry: the answer may already have been applied, so the card states the doubt instead of
	// offering a second authorization (#8006).
	it("offers no second answer to a card whose outcome is unknown", async () => {
		await open(
			pending({r1: pendingPermission({progress: {status: "unresolved", decision: "deny"}})}),
		);
		const card = await screen.findByRole("region", {name: "Run a command"});
		expect(
			within(card).getByRole("button", {name: "Deny"}).getAttribute("disabled"),
		).not.toBeNull();
		expect(within(card).getByText(/was not confirmed/i)).toBeDefined();
	});

	it("drops a card when the state drops it, and renders none when a process raises none", async () => {
		const {process} = await open(
			pending({
				r1: pendingPermission(),
				r2: pendingPermission({request: permissionRequest({title: "Read a file"})}),
			}),
		);
		expect(await screen.findByRole("region", {name: "Read a file"})).toBeDefined();
		await act(async () => {
			await Effect.runPromise(process.commit(pending({r1: pendingPermission()})));
		});
		await waitFor(() => expect(screen.queryByRole("region", {name: "Read a file"})).toBeNull());
		expect(screen.getByRole("region", {name: "Run a command"})).toBeDefined();

		await act(async () => {
			await Effect.runPromise(process.commit(pending({})));
		});
		await waitFor(() => expect(screen.queryByRole("region", {name: "Run a command"})).toBeNull());
	});
});

/**
 * The mode control lives in the composer's settings fieldset since #8190, beside the model and
 * thinking pickers and built from the same `AgentSettingMenu` — so it answers to the same roles
 * those two do, a `button` named `<label>: <value>` over `menuitemradio` rows, and not to the
 * `combobox`/`option` pair the chat bar's `Select` used to render.
 */
describe("the mode switch", () => {
	const picker = () => screen.findByRole("button", {name: /^Mode: /});

	it("is absent while the program offers no modes", async () => {
		await open(withTranscript([userItem("u1", "go")]));
		expect(screen.queryByRole("button", {name: /^Mode/})).toBeNull();
		expect(document.querySelector(".tuval-chat-mode")).toBeNull();
	});

	it("sits in the composer's settings, not in the chat bar", async () => {
		await open(withTranscript([userItem("u1", "go")], {modes: modes(["plan", "build"], "plan")}));
		const control = document.querySelector(".tuval-chat-mode");
		expect(control).not.toBeNull();
		expect(control?.closest(".kp-agent-chat__settings")).not.toBeNull();
		expect(control?.closest(".tuval-chat-bar")).toBeNull();
	});

	it("shows the current mode and dispatches setMode for another", async () => {
		const {process} = await open(
			withTranscript([userItem("u1", "go")], {modes: modes(["plan", "build"], "plan")}),
		);
		const trigger = await picker();
		expect(trigger.textContent).toContain("plan");

		await click(trigger);
		await click(await screen.findByRole("menuitemradio", {name: "build"}));
		await waitFor(() => expect(process.inbox().length).toBe(1));
		expect(process.inbox()[0]).toEqual({type: "setMode", mode: "build"});
	});

	it("names itself unselected, not loading, when modes are offered but none is current", async () => {
		await open(withTranscript([userItem("u1", "go")], {modes: modes(["plan", "build"], null)}));
		const trigger = await screen.findByRole("button", {name: /^Mode: /});
		expect(trigger.getAttribute("aria-label")).toBe("Mode: none selected");
		expect(trigger.textContent).toContain("none selected");
		expect(trigger.textContent).not.toContain("loading");
	});

	it("dispatches nothing when the mode picked is the one already current", async () => {
		const {process} = await open(
			withTranscript([userItem("u1", "go")], {modes: modes(["plan", "build"], "plan")}),
		);
		await click(await picker());
		await click(await screen.findByRole("menuitemradio", {name: "plan"}));
		await waitFor(() => expect(screen.queryByRole("menuitemradio", {name: "plan"})).toBeNull());
		expect(process.inbox()).toEqual([]);
	});
});

/**
 * The composer's own picker, driven through the bridge rather than through a port (#7981). The
 * catalog is not known when the composer mounts — the agent has not started — so every case here
 * also proves the push: the control is enabled by a list that arrived after the loads ran.
 */
describe("the composer's model picker", () => {
	const picker = () => screen.findByRole("button", {name: /^model: /});

	it("stays disabled on a list shorter than two", async () => {
		await open(
			withTranscript([userItem("u1", "go")], {models: models(["claude-opus-5"], "claude-opus-5")}),
		);
		expect((await picker()).getAttribute("disabled")).not.toBeNull();
	});

	it("shows the session's current model and lists the offered catalog", async () => {
		await open(
			withTranscript([userItem("u1", "go")], {
				models: models(["claude-opus-5", "claude-sonnet-5"], "claude-opus-5"),
			}),
		);
		const trigger = await picker();
		await waitFor(() => expect(trigger.getAttribute("disabled")).toBeNull());
		expect(trigger.textContent).toContain("claude-opus-5");
		await click(trigger);
		expect(await screen.findByRole("menuitemradio", {name: "claude-sonnet-5"})).toBeTruthy();
	});

	it("dispatches one setModel carrying the session's own ref", async () => {
		const {process} = await open(
			withTranscript([userItem("u1", "go")], {
				models: models(["claude-opus-5", "claude-sonnet-5"], "claude-opus-5"),
			}),
		);
		const trigger = await picker();
		await waitFor(() => expect(trigger.getAttribute("disabled")).toBeNull());
		await click(trigger);
		await click(await screen.findByRole("menuitemradio", {name: "claude-sonnet-5"}));
		await waitFor(() => expect(process.inbox().length).toBe(1));
		expect(process.inbox()[0]).toEqual({
			type: "setModel",
			model: {provider: "anthropic", id: "claude-sonnet-5", name: "claude-sonnet-5"},
		});
	});

	it("shows the switched model once the session commits it", async () => {
		const state = withTranscript([userItem("u1", "go")], {
			models: models(["claude-opus-5", "claude-sonnet-5"], "claude-opus-5"),
		});
		const {process} = await open(state);
		const trigger = await picker();
		await waitFor(() => expect(trigger.getAttribute("disabled")).toBeNull());
		// What the layer's `model` event folds into state, which is the only thing that moves the
		// selected row: the pick itself never writes it, so a refused switch shows the old one.
		await act(async () => {
			await Effect.runPromise(
				process.commit({
					...state,
					models: models(["claude-opus-5", "claude-sonnet-5"], "claude-sonnet-5"),
				}),
			);
		});
		await waitFor(() =>
			expect(screen.getByRole("button", {name: "model: claude-sonnet-5"})).toBeTruthy(),
		);
	});
});

describe("the composer's slash-command picker", () => {
	const composer = () => screen.findByLabelText("Write a message to the agent");

	const type = async (value: string): Promise<HTMLElement> => {
		const input = await composer();
		await act(async () => {
			fireEvent.change(input, {target: {value}});
		});
		return input;
	};

	it("offers the session's catalog and writes the pick into the draft", async () => {
		await open(withTranscript([userItem("u1", "go")], {commands: commands(["compact", "clear"])}));
		const input = await type("/comp");
		await click(await screen.findByRole("option", {name: /\/compact/}));
		expect((input as HTMLTextAreaElement).value).toBe("/compact ");
	});

	it("sends a picked command to the backend as ordinary prompt text", async () => {
		const {process} = await open(
			withTranscript([userItem("u1", "go")], {commands: commands(["compact"])}),
		);
		await type("/comp");
		await click(await screen.findByRole("option", {name: /\/compact/}));
		await act(async () => {
			fireEvent.submit((await composer()).closest("form") as HTMLFormElement);
		});
		await waitFor(() => expect(process.inbox().length).toBe(1));
		const sent = process.inbox()[0] as {type: string; text: string};
		expect([sent.type, sent.text]).toEqual(["prompt", "/compact"]);
	});

	it("advertises no sigil and opens no menu on a backend offering no commands", async () => {
		await open(withTranscript([userItem("u1", "go")], {commands: []}));
		const hint = await screen.findByText(/file/);
		expect(hint.textContent).not.toContain("command");
		await type("/");
		expect(screen.queryByRole("listbox", {name: "Completions"})).toBeNull();
	});

	it("takes a catalog that arrives after mount without re-entering loading", async () => {
		const state = withTranscript([userItem("u1", "go")], {commands: []});
		const {process} = await open(state);
		// The send button is the composer's `loading` tell: it is disabled while the load runs and
		// enabled once it resolves, so a bridge rebuilt by the catalog would disable it again.
		const send = await screen.findByRole("button", {name: /send/i});
		await waitFor(() => expect(send.getAttribute("disabled")).toBeNull());
		await act(async () => {
			await Effect.runPromise(process.commit({...state, commands: commands(["compact"])}));
		});
		expect(send.getAttribute("disabled")).toBeNull();
		await type("/comp");
		expect(await screen.findByRole("option", {name: /\/compact/})).toBeTruthy();
	});
});

/**
 * The picker beside the model one, which was live over no rows until #8062: the bridge answered an
 * empty list and a no-op setter, and the composer's fallback still rendered a selected value.
 */
describe("the composer's thinking picker", () => {
	const picker = () => screen.findByRole("button", {name: /^thinking effort: /});

	it("shows the session's current level and lists only what the backend offers", async () => {
		await open(withTranscript([userItem("u1", "go")], {thinking: thinking()}));
		const trigger = await picker();
		await waitFor(() => expect(trigger.getAttribute("disabled")).toBeNull());
		expect(trigger.textContent).toContain("low");
		await click(trigger);
		expect(await screen.findByRole("menuitemradio", {name: "maximum"})).toBeTruthy();
		// Claude has no effort below `low`, and the founder ruled the picker shows only what the
		// backend supports rather than mapping the missing two onto something.
		expect(screen.queryByRole("menuitemradio", {name: "minimal"})).toBeNull();
		expect(screen.queryByRole("menuitemradio", {name: "off"})).toBeNull();
	});

	it("dispatches one setThinkingLevel carrying the level the session offered", async () => {
		const {process} = await open(withTranscript([userItem("u1", "go")], {thinking: thinking()}));
		const trigger = await picker();
		await waitFor(() => expect(trigger.getAttribute("disabled")).toBeNull());
		await click(trigger);
		await click(await screen.findByRole("menuitemradio", {name: "maximum"}));
		await waitFor(() => expect(process.inbox().length).toBe(1));
		expect(process.inbox()[0]).toEqual({type: "setThinkingLevel", level: "max"});
	});

	it("takes a level set that lands after mount without re-entering loading", async () => {
		// The agent has not started when the composer runs its loads, so the set is empty then. It
		// arrives on a commit, and it has to reach the picker through the pushed `harness_status`
		// event rather than a rebuilt bridge — a rebuild puts the composer back in `loading`, which
		// disables the send button and every setting on it (#8062).
		const state = withTranscript([userItem("u1", "go")], {
			thinking: {current: null, available: []},
		});
		const {process} = await open(state);
		const trigger = await picker();
		expect(trigger.getAttribute("disabled")).not.toBeNull();
		await act(async () => {
			await Effect.runPromise(process.commit({...state, thinking: thinking()}));
		});
		// Enabled, not merely re-rendered: a composer that had dropped back to `loading` would leave
		// this disabled however many rows the list holds.
		await waitFor(() =>
			expect(
				screen.getByRole("button", {name: /^thinking effort: /}).getAttribute("disabled"),
			).toBeNull(),
		);
		// The model picker beside it stays untouched by the push, which is the other half of "no
		// rebuild": a new bridge identity would have re-run its load and emptied this too.
		expect(screen.queryByRole("button", {name: /^model: /})).toBeTruthy();
	});

	it("says nothing is offered on a ready backend that offers no levels", async () => {
		// The reported desk (#8425): Pi's faux backend advertises no levels, so this control read
		// `loading` from boot to exit on a session that was answering turns. It is the same empty
		// list as the case above; the phase is what tells the two apart.
		const answered = withTranscript([userItem("u1", "go"), assistantItem("a1", "done")], {
			thinking: {current: null, available: []},
		});
		const {process} = await open(answered);
		const trigger = await picker();
		await waitFor(() =>
			expect(trigger.getAttribute("aria-label")).toBe("thinking effort: none offered"),
		);
		expect(trigger.getAttribute("disabled")).not.toBeNull();

		// And it stays settled across the restore the report also captured: a rebuilt session with
		// the same empty offer has nothing new to say, and nothing re-enters loading.
		await act(async () => {
			await Effect.runPromise(process.commit({...answered, sessionId: "session-2"}));
		});
		await waitFor(() =>
			expect(
				screen.getByRole("button", {name: /^thinking effort: /}).getAttribute("aria-label"),
			).toBe("thinking effort: none offered"),
		);
	});
});

describe("two windows over one process", () => {
	it("keep their own expanded rows and share the cards and the mode", async () => {
		// A reply between the two calls, so each is a row of its own with a disclosure of its own —
		// consecutive calls are one collapsed run (#8612), and this case is about two open rows.
		const state = withTranscript(
			[call("t1"), assistantItem("a1", "on it"), call("t2", {name: "grep"})],
			{
				permissions: {r1: pendingPermission()},
				modes: modes(["plan", "build"], "plan"),
			},
		);
		const shared = await Effect.runPromise(
			testProcess<AiAgentSessionState, AiAgentSessionMsg>(processId, state),
		);
		const left = await Effect.runPromise(shared.window(WindowId.make("left"), initialChatView));
		const right = await Effect.runPromise(shared.window(WindowId.make("right"), initialChatView));
		const renderer = chatWindow({scrollCommitMs: 0, scrollToFn: () => undefined});
		render(
			<>
				{renderer.render(left)}
				{renderer.render(right)}
			</>,
		);

		// One card and one mode control per window, over one shared session fact.
		const cards = await screen.findAllByRole("region", {name: "Run a command"});
		expect(cards.length).toBe(2);
		expect((await screen.findAllByRole("button", {name: /^Mode: /})).length).toBe(2);

		const triggers = await screen.findAllByRole("button", {name: "read_file ok"});
		expect(triggers.length).toBe(2);
		await click(triggers[0] as HTMLElement);
		await waitFor(() => expect(left.view().expanded).toEqual(["t1"]));
		expect(right.view().expanded).toEqual([]);
		expect((triggers[1] as HTMLElement).getAttribute("aria-expanded")).toBe("false");

		// The other window opens a different row; neither one's slot reaches the other's.
		const others = await screen.findAllByRole("button", {name: "grep ok"});
		await click(others[1] as HTMLElement);
		await waitFor(() => expect(right.view().expanded).toEqual(["t2"]));
		expect(left.view().expanded).toEqual(["t1"]);

		// An answer from either window is the one shared session's answer.
		await click(within(cards[0] as HTMLElement).getByRole("button", {name: "Deny"}));
		await waitFor(() => expect(shared.inbox().length).toBe(1));
		expect(shared.inbox()[0]).toEqual({type: "answer", request: "r1", decision: "deny"});

		// And the mark that answer leaves reaches both windows, so neither offers a second one.
		await act(async () => {
			await Effect.runPromise(
				shared.commit({
					...state,
					permissions: {
						r1: pendingPermission({progress: {status: "answering", decision: "deny"}}),
					},
				}),
			);
		});
		await waitFor(() => {
			for (const card of screen.getAllByRole("region", {name: "Run a command"})) {
				expect(
					within(card).getByRole("button", {name: "Deny"}).getAttribute("disabled"),
				).not.toBeNull();
			}
		});
		expect(TEST_VIEWPORT.height).toBe(1_000);
	});
});
