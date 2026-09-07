import {Effect, Schema} from "effect";
import {createRoot} from "react-dom/client";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../../ai-agent/core/index.ts";
import type {PagingReplay} from "../../../claude/proof/paging-replay.ts";
import {ProcessId} from "../../../process/process.ts";
import {testProcess} from "../../window/fixtures.ts";
import {WindowId} from "../../window/index.ts";
import {type ChatWindowHost, chatWindow} from "../ChatWindow.tsx";
import {userItem, withTranscript} from "../chat.testing.ts";
import {initialChatView} from "../view.ts";

class ReplayFailed extends Schema.TaggedError<ReplayFailed>()("tuval/chat-proof/ReplayFailed", {
	detail: Schema.String,
}) {}

type Inspection = {
	replay: PagingReplay;
	requests: Array<{before: string | null; elapsedMs: number}>;
	stage: string;
	failure?: string;
	anchor: null | {
		sameNode: boolean;
		beforeTop: number;
		afterTop: number;
		scrollTop: number;
		otherWindowCursor: string | null;
	};
};

declare global {
	interface Window {
		pagingProof: Inspection;
	}
}

const fail = (message: string): never => {
	throw new Error(message);
};
const raise = (error: unknown): never => {
	throw error;
};

const wait = (millis: number) => new Promise<void>((resolve) => setTimeout(resolve, millis));

const beginInspection = async () => {
	const url = `/paging-inspection?run=${crypto.randomUUID()}`;
	const response = await fetch(url);
	const settled = response.text().then((text) => {
		if (text !== "settled") fail("paging inspection timed out before its DOM assertions finished");
	});
	return async () => {
		await fetch(url, {method: "POST"});
		await settled;
	};
};

/** The replay crosses into a scripted WindowHost here, not through a kernel or a socket. */
export const mountPagingProof = (element: HTMLElement) =>
	Effect.gen(function* () {
		const replay: PagingReplay = yield* Effect.tryPromise({
			try: async () => {
				const response = await fetch("/paging-replay");
				if (!response.ok) return fail(await response.text());
				return response.json();
			},
			catch: (cause) => new ReplayFailed({detail: String(cause)}),
		});
		const started = performance.now();
		const inspection: Inspection = {replay, requests: [], stage: "partial", anchor: null};
		window.pagingProof = inspection;
		const requestCount = () => inspection.requests.length;
		// Layout-only local rows make scrolling observable without supplying another eligible cursor.
		const padding = Array.from({length: 20}, (_, index) => ({
			...userItem(`local:layout-${index}`, `Layout-only local echo ${index + 1}`),
			local: true,
		}));
		const stateFor = (complete: boolean, allLocal = false) =>
			withTranscript(
				[
					replay.local,
					...(allLocal ? [] : [complete ? replay.completed : replay.partial]),
					...padding,
				],
				{phase: complete ? "ready" : "prompting"},
			);
		let state = stateFor(false, location.pathname === "/paging-local");
		const process = yield* testProcess<AiAgentSessionState, AiAgentSessionMsg>(
			ProcessId.make("paging-proof"),
			state,
		);
		const view = {...initialChatView, pinned: false};
		const left = yield* process.window(WindowId.make("paging-left"), view);
		const right = yield* process.window(WindowId.make("paging-right"), view);
		const host: ChatWindowHost = {
			...left,
			dispatch: (msg) =>
				Effect.gen(function* () {
					if (msg.type !== "page") return yield* left.dispatch(msg);
					inspection.requests.push({before: msg.before, elapsedMs: performance.now() - started});
					if (replay.cursor.kind !== "page" || msg.before !== replay.cursor.before) {
						return yield* Effect.die(
							new Error("window dispatched a cursor other than the replay's live cursor"),
						);
					}
					yield* Effect.sleep("250 millis");
					const completed: AiAgentSessionState = {
						...state,
						pageOutcome: {status: "success", page: replay.page},
					};
					yield* process.commit(completed);
					return {_tag: "Delivered", view: {revision: 1, state: completed}} as const;
				}),
		};
		const complete = () =>
			Effect.runPromise(
				Effect.gen(function* () {
					state = stateFor(true);
					yield* process.commit(state);
					inspection.stage = "completed";
				}),
			);
		const renderer = chatWindow();
		createRoot(element).render(
			<div className="tuval-surface proof-paging" data-scheme="dark">
				<header className="proof-paging-header">
					<p>
						Paging identity replay — real ChatWindow and styles; scripted SDK, store and window
						host. No live Claude.
					</p>
					<p>Left pages; right stays independent. Numbered local echoes are layout-only padding.</p>
				</header>
				<div className="tuval-surface proof-desk">
					<div className="proof-pane">{renderer.render(host)}</div>
					<div className="proof-pane">{renderer.render(right)}</div>
				</div>
			</div>,
		);
		const inspect = async () => {
			const finish = await beginInspection();
			try {
				for (
					let attempt = 0;
					attempt < 100 && element.querySelectorAll('[role="log"]').length !== 2;
					attempt += 1
				)
					await wait(20);
				const log = element.querySelector<HTMLElement>('[data-window="paging-left"] [role="log"]');
				if (log === null) return fail("paging proof did not mount its real transcript");
				await wait(300);
				const scrollToTop = async () => {
					log.scrollTop = 150;
					await wait(100);
					log.scrollTop = 0;
					await wait(400);
				};
				await scrollToTop();
				if (requestCount() !== 0) return fail("local/partial transcript dispatched history");
				if (location.pathname === "/paging-partial" || location.pathname === "/paging-local") {
					inspection.stage =
						location.pathname === "/paging-local" ? "local-no-request" : "partial-no-request";
					return;
				}
				await complete();
				await wait(300);
				if (location.pathname === "/paging-completed") return;
				const anchor = Array.from(log.querySelectorAll<HTMLElement>(".tuval-chat-row")).find(
					(row) => row.textContent?.includes(replay.local.text),
				);
				if (anchor === undefined) return fail("local visual anchor is not mounted");
				const beforeTop = anchor.getBoundingClientRect().top - log.getBoundingClientRect().top;
				await scrollToTop();
				for (let attempt = 0; attempt < 100 && !left.view().atOldest; attempt += 1) await wait(20);
				await wait(300);
				const same = Array.from(log.querySelectorAll<HTMLElement>(".tuval-chat-row")).find((row) =>
					row.textContent?.includes(replay.local.text),
				);
				const afterTop = anchor.getBoundingClientRect().top - log.getBoundingClientRect().top;
				inspection.anchor = {
					sameNode: anchor === same && anchor.isConnected,
					beforeTop,
					afterTop,
					scrollTop: log.scrollTop,
					otherWindowCursor: right.view().cursor,
				};
				if (
					requestCount() !== 1 ||
					!left.view().atOldest ||
					right.view().cursor !== null ||
					!inspection.anchor.sameNode ||
					Math.abs(afterTop - log.clientTop) > 1
				) {
					return fail(`prepend proof failed: ${JSON.stringify(inspection)}`);
				}
				inspection.stage = "prepended-same-anchor";
			} finally {
				await finish();
			}
		};
		void inspect().catch((error: unknown) => {
			inspection.failure = `${String(error)}; left view: ${JSON.stringify(left.view())}`;
			inspection.stage = "failed";
			setTimeout(() => {
				raise(error);
			});
		});
	});
