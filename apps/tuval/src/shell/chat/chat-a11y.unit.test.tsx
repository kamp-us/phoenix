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
import {render, screen, waitFor} from "@testing-library/react";
import {Effect} from "effect";
import fc from "fast-check";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {JsonValue, PermissionRequest, ToolStatus} from "../../ai-agent/ports/index.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {chatWindow} from "./ChatWindow.tsx";
import {call, models, modes, permissionRequest, userItem, withTranscript} from "./chat.testing.ts";
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
				permissions: Object.fromEntries(requests.map((request, index) => [`r${index}`, request])),
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

/**
 * The regions this child builds. The composer is deliberately outside the scan: `AgentChatInput` is
 * a `@kampus/design` primitive #7604 mounted whole, and it fails `aria-allowed-role` today with a
 * `role="combobox"` on its own `textarea` — a defect in the package, tracked as #7876, that this
 * window can neither cause nor fix. Scanning it here would red this gate on somebody else's bug and
 * teach the next builder to widen the scope instead of fixing the primitive.
 */
const REGIONS = [".tuval-chat-transcript", ".tuval-chat-permissions", ".tuval-chat-mode"] as const;

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

const violationsFor = async (state: AiAgentSessionState): Promise<ReadonlyArray<string>> => {
	// The rows are opened through the slot rather than by clicking, so the property spends no Zag
	// microtask flush per row per run — and an open panel is what puts the diff table in the tree.
	const rendered = await mountWindow(state, {
		...initialChatView,
		expanded: state.transcript.items
			.filter((item) => item.kind === "tool")
			.map((item) => String(item.id)),
	});
	const root = rendered.container.firstElementChild as HTMLElement;

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
	rendered.unmount();
	return found.map((violation) => `${violation.id}: ${violation.detail}`);
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
					permissions: {r0: permissionRequest()},
					modes: modes(["plan", "build"], "plan"),
				},
			);
			expect(await violationsFor(state)).toEqual([]);
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
});
