/**
 * @vitest-environment jsdom
 *
 * The admission test in front of the page's renderers, proved through a desk — because what #8157
 * cost the founder was not "an unvalidated cast" but every window on the surface going blank while
 * one process's state was a version behind.
 */

import {act, render, screen} from "@testing-library/react";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {isAiAgentSessionState} from "../ai-agent/core/snapshot.ts";
import type {AiAgentSessionState} from "../ai-agent/core/state.ts";
import {claudeSessionState} from "../claude/window/claude-window.testing.ts";
import {CLAUDE_CHAT_WINDOW_REF} from "../claude/window/index.ts";
import type {CounterState} from "../demo/counter.ts";
import {ProcessId} from "../process/process.ts";
import {defaultPrefixTable} from "../shell/keys/index.ts";
import {createStack, createTree, createWindow} from "../shell/layout/index.ts";
import {Desk} from "../shell/ui/Desk.tsx";
import {installDomShims} from "../shell/ui/dom.testing.ts";
import {deskWith} from "../shell/ui/fixtures.ts";
import {boundMount, type MountResolver} from "../shell/ui/mount.ts";
import {refused} from "../shell/ui/press.ts";
import {testProcess} from "../shell/window/fixtures.ts";
import {empty, processGone, WindowId} from "../shell/window/index.ts";
import type {ReadableRenderer} from "./readable-state.tsx";
import {pageRenderers} from "./renderers.tsx";

/** The table over a socket that answers nothing: this file judges the entries, never their answers. */
const renderers = pageRenderers(() => Effect.never);

installDomShims();

/**
 * The permission entry a kernel from before `a864e555` kept putting on the wire: a bare
 * `PermissionRequest`, with no `progress` for `PermissionCards` to read a `status` off and no
 * `permissionsRaised` beside it. Written out rather than derived, because the shape it reproduces is
 * the one the code no longer has a type for.
 */
const stalePermissionState = (): unknown => {
	const {permissionsRaised: _raised, ...rest} = claudeSessionState();
	return {
		...rest,
		permissions: {
			toolu_01QWCPwn: {
				title: "Bash",
				displayName: "Bash",
				description: "ls -la",
				input: {command: "ls -la"},
				offersAlways: true,
			},
		},
	};
};

const CLAUDE_WINDOW = WindowId.make("window-1");
const COUNTER_WINDOW = WindowId.make("window-2");
const CLAUDE_PROCESS = ProcessId.make("claude-1");
const COUNTER_PROCESS = ProcessId.make("counter-1");

/** The table entry under test, or a failure that names the missing key rather than a `?.` further down. */
const entryFor = (ref: string): ReadableRenderer => {
	const entry = renderers[ref];
	if (entry === undefined) throw new Error(`the page's table answers to no renderer named ${ref}`);
	return entry;
};

const claudeEntry = entryFor(CLAUDE_CHAT_WINDOW_REF.ref);
const counterEntry = entryFor("tuval/demo/counter");

const twoWindowDesk = () =>
	deskWith(
		createTree(
			createStack("stack-root", "horizontal", [
				createWindow(CLAUDE_WINDOW, CLAUDE_PROCESS),
				createWindow(COUNTER_WINDOW, COUNTER_PROCESS),
			]),
		),
		CLAUDE_WINDOW,
	);

/**
 * A desk whose chat window is bound to a process holding `sessionState` and whose second window is
 * bound to the counter demo — both through the page's real table, so what is under test is the
 * wiring a founder actually runs.
 */
const deskOver = (sessionState: unknown): Effect.Effect<MountResolver> =>
	Effect.gen(function* () {
		const chat = yield* testProcess<unknown>(CLAUDE_PROCESS, sessionState);
		const counter = yield* testProcess<CounterState>(COUNTER_PROCESS, {count: 7});
		const chatHost = yield* chat.window(CLAUDE_WINDOW, null);
		const counterHost = yield* counter.window(COUNTER_WINDOW, null);
		return (_windowId, processId) => {
			if (processId === CLAUDE_PROCESS) return boundMount(chatHost, claudeEntry.render);
			if (processId === COUNTER_PROCESS) return boundMount(counterHost, counterEntry.render);
			return processId === null ? empty : processGone(ProcessId.make(processId));
		};
	});

/** Render the desk and let both windows' subscriptions deliver their first state. */
const mountDesk = async (sessionState: unknown): Promise<void> => {
	const resolveMount = await Effect.runPromise(deskOver(sessionState));
	await act(async () => {
		render(
			<Desk
				state={twoWindowDesk()}
				dispatch={() => {}}
				press={() => Promise.resolve(refused)}
				resolveMount={resolveMount}
				table={defaultPrefixTable}
			/>,
		);
	});
};

describe("the shape a stale kernel kept sending", () => {
	it("is not a session state, which is why the renderer threw on it", () => {
		expect(isAiAgentSessionState(stalePermissionState())).toBe(false);
		expect(isAiAgentSessionState(claudeSessionState())).toBe(true);
	});

	it("renders a refusal in its own window instead of blanking the desk", async () => {
		await mountDesk(stalePermissionState());

		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain(`Process ${CLAUDE_PROCESS} is sending a state this window`);
		expect(alert.textContent).toContain("restart the kernel");
		// The refusal, not the boundary's panel: nothing threw, so nothing was caught.
		expect(alert.textContent).not.toContain("stopped rendering");
	});

	it("leaves every other window rendered and the desk usable", async () => {
		await mountDesk(stalePermissionState());

		expect(screen.getByLabelText("Counter value").textContent).toBe("7");
		expect(screen.getByRole("region", {name: "Shell status"})).toBeDefined();
		expect(screen.queryByRole("region", {name: "Agent chat"})).toBeNull();
	});
});

describe("a state the renderer's predicate admits", () => {
	it("mounts the renderer as before", async () => {
		await mountDesk(claudeSessionState() satisfies AiAgentSessionState);

		expect(screen.getAllByRole("region", {name: "Agent chat"})).toHaveLength(1);
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("the page's renderer table", () => {
	it("holds a type only `readsState` mints: an entry written by hand is not one", () => {
		// @ts-expect-error — the brand is a module-private `unique symbol`, so nothing outside
		// `./readable-state.tsx` can produce a `ReadableRenderer`. This line failing to error is the
		// rule quietly gone (ADR 0358).
		const forged: ReadableRenderer = {
			kind: "host-native",
			render: () => null,
			admits: () => true,
			renderer: claudeEntry.renderer,
		};
		expect(forged.admits({})).toBe(true);
	});

	it("carries an admission test on every entry, and each one refuses an empty object", () => {
		const entries = Object.values(renderers);
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			expect(typeof entry.admits).toBe("function");
			expect(entry.admits({})).toBe(false);
		}
	});
});
