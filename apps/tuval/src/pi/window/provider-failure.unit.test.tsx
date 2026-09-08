/** @vitest-environment jsdom */
import type {SessionEntry} from "@earendil-works/pi-coding-agent";
import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {ProcessId} from "../../process/process.ts";
import {chatWindow} from "../../shell/chat/ChatWindow.tsx";
import {withTranscript} from "../../shell/chat/chat.testing.ts";
import {mergeOlder} from "../../shell/chat/rows.ts";
import {type ChatView, initialChatView} from "../../shell/chat/view.ts";
import {installDomShims} from "../../shell/ui/dom.testing.ts";
import {testProcess} from "../../shell/window/fixtures.ts";
import {WindowId} from "../../shell/window/index.ts";
import {pageCursorAliases, pageItems} from "../ai-agent/entries.ts";
import {emptyProjection, eventsOf, itemsOf, paintOf, projectionOf} from "../ai-agent/items.ts";
import {projectTranscript, type SourceMessage} from "../server/transcript.ts";
import {
	createServerMessageDecoder,
	encodeServerMessage,
	SESSION_SUBSCRIPTION_ID,
	type SessionSnapshot,
} from "../wire/index.ts";

installDomShims();
const credit =
	"You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.";
const guidance =
	"Turn failed: the provider reports no credits remaining. Add credits in your provider account before sending again.";
const generic =
	"Turn failed: the provider could not complete the response. Check your provider account or try again later.";
const failed = (
	errorMessage: unknown = credit,
	content: Extract<SourceMessage, {role: "assistant"}>["content"] = [],
): SourceMessage =>
	({
		role: "assistant",
		content,
		provider: "openai",
		model: "synthetic",
		stopReason: "error",
		errorMessage,
		timestamp: 2,
	}) as SourceMessage;
const snapshotOf = (messages: ReadonlyArray<SourceMessage>): SessionSnapshot => {
	const snapshot: SessionSnapshot = {
		id: "failure",
		cwd: "/workspace",
		createdAt: 0,
		updatedAt: 2,
		phase: "idle",
		model: {provider: "openai", id: "synthetic"},
		thinkingLevel: "off",
		attached: true,
		locked: false,
		revision: 1,
		transcript: [...projectTranscript(messages)],
		queuedSteer: [],
		queuedSteerCount: 0,
	};
	const decoder = createServerMessageDecoder();
	const [decoded] = decoder.push(
		encodeServerMessage({
			type: "service_update",
			subscriptionId: SESSION_SUBSCRIPTION_ID,
			update: {type: "session_snapshot", snapshot},
		}),
	);
	decoder.end();
	if (decoded?.type !== "service_update" || decoded.update.type !== "session_snapshot")
		throw new Error("Expected snapshot roundtrip");
	return decoded.update.snapshot;
};
const rows = (snapshot: SessionSnapshot) => snapshot.transcript.flatMap(itemsOf);

describe("Pi provider failures across the owned transcript", () => {
	it("retains a useful safe exhausted-credit notice through source, codec, mapper and rendering", async () => {
		const snapshot = snapshotOf([failed()]);
		expect(rows(snapshot)).toEqual([
			{kind: "system", id: "item-0:failure", timestamp: 2, text: guidance},
		]);
		const process = await Effect.runPromise(
			testProcess<AiAgentSessionState, AiAgentSessionMsg>(
				ProcessId.make("failure"),
				withTranscript(rows(snapshot)),
			),
		);
		const host = await Effect.runPromise(
			process.window<ChatView>(WindowId.make("failure"), {...initialChatView, pinned: true}),
		);
		render(chatWindow({scrollToFn: () => {}}).render(host) as ReactElement);
		expect(screen.getByText(guidance)).toBeDefined();
		expect(screen.queryByText("AGENT", {exact: true})).toBeNull();
		const composer = screen.getByRole("combobox");
		expect(composer.hasAttribute("disabled")).toBe(false);
		await act(async () => {
			fireEvent.change(composer, {target: {value: "Try a later turn"}});
			fireEvent.keyDown(composer, {key: "Enter", code: "Enter"});
		});
		await waitFor(() =>
			expect(process.inbox()).toContainEqual(expect.objectContaining({type: "prompt"})),
		);
		expect(screen.queryByRole("link")).toBeNull();
	});

	it.each([
		undefined,
		null,
		"",
		"   ",
		{secret: "sensitive"},
		"<script>secret()</script>",
		"Authorization: Bearer synthetic-private-token",
		"billing maybe?",
		"invalid api keyboard",
	])("uses a generic explanation without forwarding unusable or unknown data: %j", (error) => {
		const message = failed(error);
		const snapshot = snapshotOf([{...message, errorMessage: error} as SourceMessage]);
		expect(rows(snapshot)).toEqual([
			{kind: "system", id: "item-0:failure", timestamp: 2, text: generic},
		]);
	});

	it.each([
		[
			"Rate limit exceeded: private request",
			"Turn failed: the provider reports a rate limit. Wait before sending again.",
		],
		[
			"Invalid API key: synthetic-private-token",
			"Turn failed: the provider rejected the API key. Check the credentials in your provider configuration.",
		],
		[
			"You exceeded your current quota, private account details",
			"Turn failed: the provider reports an exceeded quota. Check your provider plan and billing limits before sending again.",
		],
		[`${credit} Authorization: Bearer synthetic-private-token`, guidance],
	])("keeps recognized guidance without diagnostic tails: %s", (error, expected) => {
		expect(rows(snapshotOf([failed(error)]))[0]).toMatchObject({kind: "system", text: expected});
	});

	it("preserves text, reasoning, tool rows, usage and readiness when a partial reply fails", () => {
		const content = [
			{type: "thinking" as const, thinking: "Check the evidence"},
			{type: "text" as const, text: "Partial answer"},
			{type: "toolCall" as const, id: "call", name: "read", arguments: {}},
		];
		const partial = {
			...snapshotOf([]),
			transcript: [
				...projectTranscript([], {...failed(credit, content), stopReason: "stop"} as Extract<
					SourceMessage,
					{role: "assistant"}
				>),
			],
		};
		const previous = eventsOf(emptyProjection, partial);
		const settled = snapshotOf([
			{
				...failed(credit, content),
				usage: {
					input: 3,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					cost: {input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3},
				},
			} as SourceMessage,
			{
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				content: [{type: "text", text: "Tool output"}],
				isError: false,
				timestamp: 3,
			},
		]);
		const projected = rows(settled);
		expect(projected.map((item) => item.kind)).toEqual(["thinking", "assistant", "system", "tool"]);
		expect(new Set(projected.map((item) => item.id)).size).toBe(4);
		expect(projected[1]).toMatchObject({text: "Partial answer"});
		expect(projected[1]).not.toHaveProperty("partial");
		const delta = eventsOf(previous.next, settled);
		expect(delta.events).toContainEqual({
			kind: "usage",
			turn: "item-0",
			model: "openai/synthetic",
			inputTokens: 3,
			outputTokens: 2,
			cost: 0.3,
		});
		expect(
			delta.events.filter((event) => event.kind === "item" && event.item.kind === "system"),
		).toHaveLength(1);
		expect(eventsOf(delta.next, settled).events).toEqual([]);
		expect(eventsOf(emptyProjection, settled).events).toContainEqual({
			kind: "phase",
			phase: "ready",
		});
	});

	it("keeps failure identity in history, initial paint, reattach, overlap and a later successful turn", () => {
		const messages = [
			failed(),
			{
				role: "assistant",
				content: [{type: "text", text: "Later answer"}],
				provider: "openai",
				model: "synthetic",
				stopReason: "stop",
				timestamp: 3,
			},
		] satisfies ReadonlyArray<SourceMessage>;
		const snapshot = snapshotOf(messages);
		const entries = messages.map((message, index) => ({
			type: "message",
			id: `entry-${index}`,
			parentId: index === 0 ? null : "entry-0",
			timestamp: new Date(message.timestamp).toISOString(),
			message,
		})) as SessionEntry[];
		const tail = rows(snapshot);
		const page = pageItems(entries);
		expect(page[0]).toMatchObject({
			kind: "system",
			id: "entry-0:failure",
			alias: "item-0:failure",
			text: guidance,
		});
		expect(pageCursorAliases(entries).get("item-0:failure")).toBe("entry-0:failure");
		expect(mergeOlder(tail, page)).toEqual(tail);
		expect(
			paintOf(snapshot)
				.events.filter((event) => event.kind === "item")
				.map((event) => event.item),
		).toEqual(tail);
		expect(
			eventsOf(projectionOf(snapshot, tail), snapshot).events.filter(
				(event) => event.kind === "item",
			),
		).toEqual([]);
		expect(tail[1]).toMatchObject({kind: "assistant", text: "Later answer"});
	});
});
