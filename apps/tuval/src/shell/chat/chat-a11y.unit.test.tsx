/**
 * @vitest-environment jsdom
 *
 * The property-based a11y pass over this window's own primitives.
 *
 * `@kampus/design`'s harness (`.patterns/property-based-a11y.md`) generates valid props for each
 * package primitive in isolation. That gate does not reach what this window builds, for two
 * reasons: the compositions here are the package's `deferred` ones — `Collapsible` and `Select` need
 * composition and a portal to be representative — and the markup around them (the diff table, the
 * card's labelled region) is Tuval's, which the package's registry never sees. So the same
 * `runEnforcedInvariants` runs here over *these* compositions, with `fast-check` generating session
 * states rather than props.
 *
 * Only the jsdom-decidable invariants run, exactly as upstream: contrast and tap-target are
 * `warning` posture there because jsdom applies no CSS and has no layout, and asserting either here
 * would be a false gate.
 */

import type {PrimitiveSpec} from "@kampus/design/a11y";
import {runEnforcedInvariants} from "@kampus/design/a11y";
import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {Effect} from "effect";
import fc from "fast-check";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {JsonValue, PermissionRequest, ToolStatus} from "../../ai-agent/ports/index.ts";
import {subagentSlot} from "../../ai-agent-fixtures/transcripts.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {chatWindow} from "./ChatWindow.tsx";
import {
	assistantItem,
	call,
	compactionItem,
	models,
	modes,
	pendingPermission,
	systemItem,
	thinkingItem,
	userItem,
	withTranscript,
} from "./chat.testing.ts";
import {type ChatView, initialChatView} from "./view.ts";

installDomShims();

const word = fc.constantFrom("plan", "build", "review", "read_file", "bash", "edit", "grep");
const line = fc.constantFrom("do the thing", "src/a.ts", "42", "kamp.us", "");
const status: fc.Arbitrary<ToolStatus> = fc.constantFrom("running", "ok", "error");

const toolInput: fc.Arbitrary<JsonValue> = fc.oneof(
	fc.record({path: line, old_text: line, new_text: line}),
	fc.record({command: line}),
	fc.record({pattern: line, glob: line}),
	fc.constant(null),
);

const requestArb: fc.Arbitrary<PermissionRequest> = fc.record({
	title: word,
	displayName: word,
	description: line,
	input: toolInput,
	offersAlways: fc.boolean(),
});

/** One whole session state: every control's input, generated together rather than one at a time. */
const stateArb: fc.Arbitrary<AiAgentSessionState> = fc
	.record({
		calls: fc.array(fc.record({name: word, input: toolInput, status}), {
			minLength: 1,
			maxLength: 3,
		}),
		requests: fc.array(requestArb, {maxLength: 2}),
		available: fc.subarray(["plan", "build", "review"]),
		phase: fc.constantFrom<AiAgentSessionState["phase"]>("idle", "ready", "prompting"),
	})
	.map(({calls, requests, available, phase}) =>
		withTranscript(
			[userItem("u1", "go"), ...calls.map((options, index) => call(`t${index}`, options))],
			{
				phase,
				permissions: Object.fromEntries(
					requests.map((request, index) => [`r${index}`, pendingPermission({request})]),
				),
				modes: modes(available),
			},
		),
	);

/**
 * The harness's `PrimitiveSpec` carries an arbitrary because its own runner generates from it;
 * `runEnforcedInvariants` reads only `kind` and `selector`. This is a real arbitrary rather than a
 * cast, and nothing here draws from it.
 */
const unusedArb = fc.constant(<span />);

const presentational: PrimitiveSpec = {kind: "presentational", arb: unusedArb};

const CONTROLS = "button, [role='combobox'], input, textarea";

/** Two lines, so the disclosure's name is provably the first of them and not the whole of it. */
const THINKING = "Weighing the two lanes.\nThe second one is stalled on a review.";

/**
 * The regions this child builds. The composer is deliberately outside the scan: `AgentChatInput` is
 * a `@kampus/design` primitive #7604 mounted whole, and it fails `aria-allowed-role` today with a
 * `role="combobox"` on its own `textarea` — a defect in the package, tracked as #7876, that this
 * window can neither cause nor fix. Scanning it here would red this gate on somebody else's bug and
 * teach the next builder to widen the scope instead of fixing the primitive.
 */
const REGIONS = [
	".tuval-chat-transcript",
	".tuval-chat-subagents",
	".tuval-chat-permissions",
	".tuval-chat-mode",
] as const;

/**
 * The focus probe takes a root and a selector, and `querySelector` searches descendants — so a
 * control cannot be its own root. Each one is marked, probed from the window root by that mark, and
 * unmarked.
 */
const probeFocus = async (root: HTMLElement, control: HTMLElement) => {
	control.setAttribute("data-a11y-probe", "");
	const found = await runEnforcedInvariants(root, {
		kind: "interactive",
		selector: "[data-a11y-probe]",
		arb: unusedArb,
	});
	control.removeAttribute("data-a11y-probe");
	return found.filter((violation) => violation.id === "focusable");
};

const mountWindow = async (state: AiAgentSessionState, view: ChatView = initialChatView) => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
	);
	const host = await Effect.runPromise(process.window(WindowId.make("w1"), view));
	const rendered = render(
		chatWindow({scrollCommitMs: 0, scrollToFn: () => undefined}).render(host) as ReactElement,
	);
	await screen.findByRole("log", {name: "Transcript"});
	return rendered;
};

const scanRegions = async (root: HTMLElement): Promise<ReadonlyArray<string>> => {
	const found: Array<{readonly id: string; readonly detail: string}> = [];
	for (const selector of REGIONS) {
		const region = root.querySelector<HTMLElement>(selector);
		if (region === null) continue;
		found.push(...(await runEnforcedInvariants(region, presentational)));
		for (const control of region.querySelectorAll<HTMLElement>(CONTROLS)) {
			found.push(...(await probeFocus(root, control)));
		}
	}
	// The transcript is a scroll container and the only way to older turns on a plain transcript, so
	// it is a control in its own right and must take focus (#7610 criterion 4). axe's
	// scrollable-region-focusable is not in the enforced set and jsdom lays nothing out, so the
	// harness's focus probe is what proves it; dropping the scroller's tabIndex reds this.
	const transcript = root.querySelector<HTMLElement>(".tuval-chat-transcript");
	if (transcript !== null) found.push(...(await probeFocus(root, transcript)));
	return found.map((violation) => `${violation.id}: ${violation.detail}`);
};

const violationsFor = async (state: AiAgentSessionState): Promise<ReadonlyArray<string>> => {
	// The rows are opened through the slot rather than by clicking, so the property spends no Zag
	// microtask flush per row per run — and an open panel is what puts the diff table in the tree.
	const rendered = await mountWindow(state, {
		...initialChatView,
		expanded: state.transcript.items
			.filter((item) => item.kind === "tool")
			.map((item) => String(item.id)),
	});
	const found = await scanRegions(rendered.container.firstElementChild as HTMLElement);
	rendered.unmount();
	return found;
};

// axe is the cost in both tests below — one pass per region per state, plus one per control for the
// focus probe — so each runs in seconds rather than milliseconds and carries its own timeout.
// Vitest's 5s default passes them alone and times the property out inside a loaded full run.
const SLOW = 60_000;

/**
 * The composer's agent-settings group, with a model list present (#7981).
 *
 * Scoped to the settings fieldset rather than to the whole composer, because the composer's own
 * textarea carries the `role="combobox"` that fails `aria-allowed-role` today — #7876, a defect in
 * `@kampus/design` this window can neither cause nor fix, and the reason `REGIONS` leaves the
 * composer out. The fieldset does not contain that textarea, so the same `runEnforcedInvariants`
 * runs over it whole, and every control inside it is probed for keyboard reach.
 */
const settingsViolationsFor = async (
	state: AiAgentSessionState,
): Promise<ReadonlyArray<string>> => {
	const rendered = await mountWindow(state);
	const root = rendered.container.firstElementChild as HTMLElement;
	// The list reaches the picker through a pushed event after the composer's own loads resolve,
	// so the enabled control is what proves the push landed as well as what is being scanned.
	const picker = await screen.findByRole("button", {name: /^model: /});
	await waitFor(() => expect(picker.getAttribute("disabled")).toBeNull());
	const settings = root.querySelector<HTMLElement>(".kp-agent-chat__settings");
	expect(settings).not.toBeNull();
	const found = [...(await runEnforcedInvariants(settings as HTMLElement, presentational))];
	for (const control of (settings as HTMLElement).querySelectorAll<HTMLElement>(CONTROLS)) {
		found.push(...(await probeFocus(root, control)));
	}
	rendered.unmount();
	return found.map((violation) => `${violation.id}: ${violation.detail}`);
};

describe("the window's own primitives hold the enforced pillar-4 invariants", () => {
	it(
		"over a generated cross-product of tool rows, permission cards and mode states",
		async () => {
			await fc.assert(
				fc.asyncProperty(stateArb, async (state) => {
					expect(await violationsFor(state)).toEqual([]);
				}),
				{numRuns: 12},
			);
		},
		SLOW,
	);

	it(
		"reaches every control of a fully-loaded window from the keyboard",
		async () => {
			const state = withTranscript(
				[userItem("u1", "go"), call("t0", {name: "bash", input: {command: "ls"}})],
				{
					permissions: {r0: pendingPermission()},
					modes: modes(["plan", "build"], "plan"),
				},
			);
			expect(await violationsFor(state)).toEqual([]);
		},
		SLOW,
	);

	it(
		"holds them over a group head with its fold open, where an idref list would dangle (#8057)",
		async () => {
			const state = withTranscript([
				userItem("u1", "go"),
				call("agent", {name: "Agent"}),
				call("child-1", {name: "bash", parentId: "agent"}),
				call("child-2", {name: "grep", parentId: "agent"}),
			]);
			const rendered = await mountWindow(state, {...initialChatView, unfolded: ["agent"]});
			const root = rendered.container.firstElementChild as HTMLElement;

			const fold = await screen.findByRole("button", {name: /nested calls?$/});
			expect(fold.getAttribute("aria-expanded")).toBe("true");
			expect(await scanRegions(root)).toEqual([]);

			// The clean pass above is only worth something if the rule can fire on this markup at all,
			// and whether it can turns on jsdom mounting the rows — which is why the control is here
			// rather than assumed: the dropped attribute, pointed at an id the document does not hold.
			fold.setAttribute("aria-controls", "tuval-row-w1-not-mounted");
			const dangling = await scanRegions(root);
			expect(dangling.some((v) => v.startsWith("valid-aria: aria-valid-attr-value"))).toBe(true);

			rendered.unmount();
		},
		SLOW,
	);

	it(
		"holds them over the composer's agent settings with a model list present",
		async () => {
			const state = withTranscript([userItem("u1", "go")], {
				modes: modes(["plan", "build"], "plan"),
				models: models(["claude-opus-5", "claude-sonnet-5"]),
			});
			expect(await settingsViolationsFor(state)).toEqual([]);
		},
		SLOW,
	);

	it(
		"holds them over a transcript carrying the thinking row and the compaction marker",
		async () => {
			const state = withTranscript([
				userItem("u1", "go"),
				thinkingItem("t1", THINKING),
				compactionItem("c1", "context compacted"),
			]);
			expect(await violationsFor(state)).toEqual([]);
		},
		SLOW,
	);

	// All three shapes the session row takes, in one transcript: a lone notice with nothing to
	// disclose, a lone notice with a detail, and a run of them collapsed into one row.
	it(
		"holds them over a transcript carrying every shape of the session row",
		async () => {
			const state = withTranscript([
				systemItem("s0", "session resumed"),
				userItem("u1", "go"),
				systemItem("s1", "hook refused the call", 1, "PreToolUse hook exited 1"),
				assistantItem("a1", "done"),
				systemItem("s2", "hook started"),
				systemItem("s3", "hook finished"),
			]);
			expect(await violationsFor(state)).toEqual([]);
		},
		SLOW,
	);
});

/**
 * The session row's disclosure, at the semantics the harness above cannot decide. It is the same
 * assertion the thinking row gets, on the row that carries every `system` subtype the SDK raises —
 * so a subtype landing here can never arrive as an unannounced burst of rows.
 */
describe("the session row's disclosure", () => {
	const DETAIL = "PreToolUse hook exited 1\n  at guard.sh:12";

	const mountSession = () =>
		mountWindow(
			withTranscript([userItem("u1", "go"), systemItem("s1", "hook refused the call", 1, DETAIL)]),
		);

	const trigger = (): HTMLElement => screen.getByRole("button", {name: "hook refused the call"});

	it("is a real button naming the region it reveals", async () => {
		const rendered = await mountSession();

		const control = trigger();
		expect(control.tagName).toBe("BUTTON");
		expect(control.getAttribute("aria-expanded")).toBe("false");

		const region = document.getElementById(control.getAttribute("aria-controls") ?? "");
		expect(region).not.toBeNull();
		expect(region?.textContent).toBe(DETAIL);
		expect(region?.hidden).toBe(true);

		rendered.unmount();
	});

	it("takes focus, and activating it opens the region", async () => {
		const rendered = await mountSession();

		const control = trigger();
		control.focus();
		expect(document.activeElement).toBe(control);

		await act(async () => {
			fireEvent.click(control);
		});

		const opened = trigger();
		expect(opened.getAttribute("aria-expanded")).toBe("true");
		expect(document.getElementById(opened.getAttribute("aria-controls") ?? "")?.hidden).toBe(false);

		rendered.unmount();
	});
});

/**
 * The thinking row's disclosure, at the semantics the harness above cannot decide: `Collapsible`
 * wires `aria-expanded` and `aria-controls`, and what is asserted here is that they point at the
 * region the reasoning actually lands in, on both the pointer and the keyboard path.
 */
describe("the thinking row's disclosure", () => {
	const mountThinking = () =>
		mountWindow(withTranscript([userItem("u1", "go"), thinkingItem("t1", THINKING)]));

	const trigger = (): HTMLElement => screen.getByRole("button", {name: "Weighing the two lanes."});

	it("is a real button naming the region it reveals", async () => {
		const rendered = await mountThinking();

		const control = trigger();
		expect(control.tagName).toBe("BUTTON");
		expect(control.getAttribute("aria-expanded")).toBe("false");

		const region = document.getElementById(control.getAttribute("aria-controls") ?? "");
		expect(region).not.toBeNull();
		expect(region?.textContent).toBe(THINKING);
		expect(region?.hidden).toBe(true);

		rendered.unmount();
	});

	// Reachability itself is the property above, which probes every control in the transcript; what
	// is left here is that the control the keyboard reaches is the one that opens the region — a
	// native `button`, so Enter and Space activate it with no key handler of this window's own.
	it("takes focus, and activating it opens the region", async () => {
		const rendered = await mountThinking();

		const control = trigger();
		control.focus();
		expect(document.activeElement).toBe(control);

		await act(async () => {
			fireEvent.click(control);
		});

		const opened = trigger();
		expect(opened.getAttribute("aria-expanded")).toBe("true");
		expect(document.getElementById(opened.getAttribute("aria-controls") ?? "")?.hidden).toBe(false);

		rendered.unmount();
	});
});

/**
 * The running list (#8405), at the semantics the property above cannot decide. Its whole job is to
 * be read at a glance, and a screen reader gets that from list structure: a named list, one item
 * per worker, each item's own name carrying the four fields — never a stack of divs.
 */
describe("the running-subagent list", () => {
	const mountList = async () => {
		const state = withTranscript([userItem("u1", "go"), call("agent", {name: "Agent"})], {
			subagents: {
				agent: subagentSlot("agent", {type: "reviewer", lastLine: "reading rows.ts"}),
				other: subagentSlot("other", {type: "builder", lastLine: "writing the test"}),
			},
		});
		const process = await Effect.runPromise(
			testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
		);
		const host = await Effect.runPromise(process.window(WindowId.make("w1"), initialChatView));
		const rendered = render(
			chatWindow({scrollCommitMs: 0, scrollToFn: () => undefined, subagentList: true}).render(
				host,
			) as ReactElement,
		);
		await screen.findByRole("log", {name: "Transcript"});
		return rendered;
	};

	it("is a named list whose rows are list items naming their worker", async () => {
		const rendered = await mountList();

		const region = screen.getByRole("list", {name: "Running subagents"});
		const rows = screen.getAllByRole("listitem");
		expect(rows).toHaveLength(2);
		expect(region.contains(rows[0] as HTMLElement)).toBe(true);
		expect(rows[0]?.textContent).toContain("reviewer");
		expect(rows[0]?.textContent).toContain("reading rows.ts");
		// The units ride the row rather than the layout, so the numbers mean something read aloud.
		expect(rows[0]?.textContent).toContain("elapsed");
		expect(rows[0]?.textContent).toContain("tokens");

		rendered.unmount();
	});

	it(
		"holds the enforced pillar-4 invariants with workers running",
		async () => {
			const rendered = await mountList();
			const root = rendered.container.firstElementChild as HTMLElement;
			expect(await scanRegions(root)).toEqual([]);
			rendered.unmount();
		},
		SLOW,
	);

	/**
	 * The swap (#8406). A `log` announces what is *appended* to it, so replacing the whole transcript
	 * under a reader announces nothing at all — the window owes a live region of its own, and it owes
	 * the picking control to the keyboard as much as to the mouse.
	 */
	it("reaches every navigator row from the keyboard and announces the swap", async () => {
		const rendered = await mountList();
		const root = rendered.container.firstElementChild as HTMLElement;
		const status = () =>
			Array.from(root.querySelectorAll<HTMLElement>('[role="status"]'))
				.map((region) => region.textContent ?? "")
				.join(" ");

		const picks = Array.from(root.querySelectorAll<HTMLButtonElement>(".tuval-chat-subagent-pick"));
		expect(picks).toHaveLength(2);
		expect(status()).toContain("Showing the agent's own transcript.");
		for (const control of picks) {
			expect(await probeFocus(root, control)).toEqual([]);
			expect(control.getAttribute("aria-current")).toBeNull();
		}

		// A button is activated by Enter and Space, so pressing it *is* the keyboard path — what a
		// keyboard user needs beyond that is to reach it, which the focus probe above just proved.
		const reviewer = picks[0] as HTMLButtonElement;
		await act(async () => {
			reviewer.focus();
			reviewer.click();
		});

		expect(document.activeElement).toBe(reviewer);
		expect(reviewer.getAttribute("aria-current")).toBe("true");
		expect(status()).toContain("Showing the reviewer subagent's transcript.");
		expect(screen.getByRole("log", {name: "Transcript: reviewer subagent"})).toBeTruthy();

		const back = root.querySelector<HTMLButtonElement>(".tuval-chat-subagent-pick");
		expect(back?.textContent).toBe("Back to the agent transcript");
		expect(await probeFocus(root, back as HTMLElement)).toEqual([]);
		await act(async () => {
			(back as HTMLButtonElement).click();
		});
		expect(status()).toContain("Showing the agent's own transcript.");

		rendered.unmount();
	});

	it(
		"holds the enforced pillar-4 invariants inside a subagent's own view",
		async () => {
			const rendered = await mountList();
			const root = rendered.container.firstElementChild as HTMLElement;
			await act(async () => {
				root.querySelector<HTMLButtonElement>(".tuval-chat-subagent-pick")?.click();
			});
			expect(await scanRegions(root)).toEqual([]);
			rendered.unmount();
		},
		SLOW,
	);
});
