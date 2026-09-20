/**
 * @vitest-environment jsdom
 *
 * The running-subagent list in the window (#8405), and the removal it ships beside.
 *
 * Everything here mounts the whole `ChatWindow`, because both halves are about what an operator
 * sees: the list is a region that is either there or absent, and the removal is the absence of rows
 * from the transcript. What the list is a list *of* is proven without a DOM in
 * `./subagents.unit.test.ts`, and the row-level removal in `./rows.unit.test.ts`.
 */

import {act, render, screen} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {SubagentSlot} from "../../ai-agent/ports/index.ts";
import {subagentSlot} from "../../ai-agent-fixtures/transcripts.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {type ChatWindowOptions, chatWindow} from "./ChatWindow.tsx";
import {assistantItem, call, userItem, withTranscript} from "./chat.testing.ts";
import {type ChatView, initialChatView} from "./view.ts";

installDomShims();

const STARTED_AT = 1_756_000_000_000;

const slots = (...entries: ReadonlyArray<SubagentSlot>): Record<string, SubagentSlot> =>
	Object.fromEntries(entries.map((slot) => [slot.id, slot]));

/** A window at whatever flag, view and state a case needs, with its process kept for the inbox. */
const openWindow = async (
	state: AiAgentSessionState,
	options: ChatWindowOptions = {},
	view: ChatView = initialChatView,
) => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
	);
	const bound = await Effect.runPromise(process.window(WindowId.make("w1"), view));
	const writes: Array<ChatView> = [];
	const host = {
		...bound,
		setView: (next: ChatView) =>
			Effect.suspend(() => {
				writes.push(next);
				return bound.setView(next);
			}),
	};
	const rendered = render(
		chatWindow({scrollCommitMs: 0, scrollToFn: () => undefined, ...options}).render(
			host,
		) as ReactElement,
	);
	await screen.findByRole("log", {name: "Transcript"});
	return {rendered, process, writes};
};

const list = () => screen.queryByRole("list", {name: "Running subagents"});

const rowsOf = (): ReadonlyArray<HTMLElement> =>
	Array.from(document.querySelectorAll<HTMLElement>(".tuval-chat-subagent"));

const fieldsOf = (row: HTMLElement): Record<string, string> =>
	Object.fromEntries(
		Array.from(row.querySelectorAll<HTMLElement>("[data-field]")).map((field) => [
			field.dataset.field,
			field.textContent ?? "",
		]),
	);

afterEach(() => {
	vi.useRealTimers();
});

describe("the running-subagent list", () => {
	it("is not there at all when nothing is running — not an empty region (Q4)", async () => {
		const {rendered} = await openWindow(withTranscript([userItem("u1", "go")]), {
			subagentList: true,
		});
		expect(list()).toBeNull();
		expect(document.querySelector(".tuval-chat-subagents")).toBeNull();
		rendered.unmount();
	});

	it("is not there when every slot the session holds has finished", async () => {
		const {rendered} = await openWindow(
			withTranscript([userItem("u1", "go"), call("agent", {name: "Agent"})], {
				subagents: slots(subagentSlot("agent", {status: "finished"})),
			}),
			{subagentList: true},
		);
		expect(list()).toBeNull();
		rendered.unmount();
	});

	it("shows one row per running worker, each carrying four fields and no nested count (Q1)", async () => {
		vi.useFakeTimers({now: STARTED_AT + 3_000, shouldAdvanceTime: true});
		const {rendered} = await openWindow(
			withTranscript([userItem("u1", "go")], {
				subagents: slots(
					subagentSlot("a", {type: "reviewer", lastLine: "reading rows.ts", tokens: 900}),
					subagentSlot("b", {type: "builder", lastLine: "writing the test", tokens: 1_200}),
					subagentSlot("c", {type: "explorer", lastLine: "grep", tokens: 4_000}),
				),
			}),
			{subagentList: true},
		);

		expect(list()).not.toBeNull();
		const rows = rowsOf();
		expect(rows).toHaveLength(3);
		// Four fields and only four: a fifth would be the count of *rows* Q1 answered "no" to. The
		// worker count below is a different field and only a fan-out draws it.
		expect(fieldsOf(rows[0] as HTMLElement)).toEqual({
			type: "reviewer",
			line: "reading rows.ts",
			elapsed: "elapsed 3s",
			tokens: "900 tokens",
		});
		expect(fieldsOf(rows[2] as HTMLElement)).toEqual({
			type: "explorer",
			line: "grep",
			elapsed: "elapsed 3s",
			tokens: "4k tokens",
		});
		rendered.unmount();
	});

	// The founder ruled a fan-out stays one slot (2026-09-09 on #8664), so the count is the only
	// thing on the row saying its line, elapsed and tokens are several workers' together.
	it("says how many workers a fan-out slot holds, and says nothing on a single one", async () => {
		vi.useFakeTimers({now: STARTED_AT + 3_000, shouldAdvanceTime: true});
		const {rendered} = await openWindow(
			withTranscript([userItem("u1", "go")], {
				subagents: slots(
					subagentSlot("a", {type: "explorer", lastLine: "grep", tokens: 4_000, workers: 3}),
					subagentSlot("b", {type: "builder", lastLine: "writing", tokens: 900, workers: 1}),
				),
			}),
			{subagentList: true},
		);

		const rows = rowsOf();
		expect(fieldsOf(rows[0] as HTMLElement)).toEqual({
			type: "explorer",
			workers: "3 workers",
			line: "grep",
			elapsed: "elapsed 3s",
			tokens: "4k tokens",
		});
		expect(fieldsOf(rows[1] as HTMLElement)).not.toHaveProperty("workers");
		rendered.unmount();
	});

	it("shows five rows and one more row naming the remaining five (Q3)", async () => {
		const running = Array.from({length: 10}, (_, index) =>
			subagentSlot(`s${index}`, {type: `worker-${index}`, startedAt: STARTED_AT + index}),
		);
		const {rendered} = await openWindow(
			withTranscript([userItem("u1", "go")], {subagents: slots(...running)}),
			{subagentList: true},
		);

		expect(rowsOf().map((row) => fieldsOf(row).type)).toEqual([
			"worker-0",
			"worker-1",
			"worker-2",
			"worker-3",
			"worker-4",
		]);
		expect(screen.getByText("5 more running")).toBeTruthy();
		rendered.unmount();
	});

	// The tick is a render and nothing else. A per-second `Msg` would checkpoint the session once a
	// second per running worker, and a per-second view write would do the same to the window's slot.
	it("advances elapsed without dispatching a Msg or writing the view slot", async () => {
		vi.useFakeTimers({now: STARTED_AT, shouldAdvanceTime: true});
		const {rendered, process, writes} = await openWindow(
			withTranscript([userItem("u1", "go")], {subagents: slots(subagentSlot("a"))}),
			{subagentList: true},
		);

		expect(fieldsOf(rowsOf()[0] as HTMLElement).elapsed).toBe("elapsed 0s");
		const before = writes.length;

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});

		expect(fieldsOf(rowsOf()[0] as HTMLElement).elapsed).toBe("elapsed 5s");
		expect(process.inbox()).toEqual([]);
		expect(writes.length).toBe(before);
		rendered.unmount();
	});
});

describe("a subagent's rows in the agent window", () => {
	/** A worker that spawned a worker: the shape Q5 names, at every depth it reaches. */
	const nested = [
		userItem("u1", "go"),
		call("agent", {name: "Agent"}),
		call("inner", {name: "Agent", parentId: "agent"}),
		call("leaf", {name: "bash", parentId: "inner"}),
		{...assistantItem("inner-reply", "done"), parentId: call("inner").id},
		call("own", {name: "Bash"}),
	];

	const state = (status: SubagentSlot["status"] = "running") =>
		withTranscript(nested, {subagents: slots(subagentSlot("agent", {status}))});

	const transcriptIds = (): ReadonlyArray<string> =>
		Array.from(document.querySelectorAll<HTMLElement>(".tuval-chat-row"))
			.map((row) => row.dataset.kind ?? "")
			.filter((kind) => kind.length > 0);

	it("are gone from the transcript at every depth, with the flag on", async () => {
		const {rendered} = await openWindow(
			state(),
			{subagentList: true},
			{
				...initialChatView,
				unfolded: ["agent", "inner"],
			},
		);
		expect(screen.queryByText("done")).toBeNull();
		expect(document.querySelector('[data-nested="true"]')).toBeNull();
		// A mounted window holds no walk however its slot was written (`./view.ts`, #9047), so the
		// head row offering one leads every list of rows a mount renders.
		expect(transcriptIds()).toEqual(["older", "user", "tool", "tool"]);
		rendered.unmount();
	});

	// Q2: the head grows nothing in this PR. A finished worker's spawning call is the plain tool row
	// it always was — no elapsed, no token readout, and no fold, because it heads no rows now.
	it("leave the spawning call a plain tool row with no fold and no readout", async () => {
		const {rendered} = await openWindow(state("finished"), {subagentList: true}, initialChatView);
		expect(screen.queryByRole("button", {name: /nested calls?$/})).toBeNull();
		expect(screen.queryByText(/elapsed/)).toBeNull();
		expect(screen.queryByText(/tokens/)).toBeNull();
		rendered.unmount();
	});

	it("fold exactly as they do at main with the flag off, and no list is drawn", async () => {
		const {rendered} = await openWindow(
			state(),
			{subagentList: false},
			{
				...initialChatView,
				unfolded: ["agent", "inner"],
			},
		);
		expect(list()).toBeNull();
		expect(screen.getByText("done")).toBeTruthy();
		expect(document.querySelectorAll('[data-nested="true"]').length).toBe(3);
		rendered.unmount();
	});
});
