/**
 * @vitest-environment jsdom
 *
 * What picking a row does to the window (epic #8070, rulings 2 and 5): the list is replaced in
 * place, the read that replaces it opens nothing, Cmd+Enter goes to the other window instead, and
 * the first send is the one that creates the process.
 *
 * The read is a spy rather than a kernel here, and the assertion is on what it was asked for: the
 * proof that a read opens no process is `../transcripts.unit.test.ts`, which runs the real one over
 * a real process table. What this file holds is the window's half — that it asks for a read at all,
 * that it asks for one page rather than the transcript, and that the send transition happens once.
 */

import {act, fireEvent, render, screen} from "@testing-library/react";
import type {ReactElement} from "react";
import {describe, expect, it, vi} from "vitest";
import type {SessionListAnswer} from "../../page/session-list.ts";
import type {SessionRow} from "../../protocol/session-list.ts";
import {installDomShims} from "../../shell/ui/dom.testing.ts";
import type {WindowHost} from "../../shell/window/index.ts";
import {WindowId} from "../../shell/window/index.ts";
import {ItemId} from "../ports/index.ts";
import {bareSession, claudeSession, NOW, scrambled} from "./fixtures.ts";
import type {OpenRequest, SendPlan, TranscriptRead} from "./opening.ts";
import * as opening from "./opening.ts";
import {TRANSCRIPT_PAGE_SIZE} from "./opening.ts";
import type {TranscriptPaged} from "./SessionListWindow.tsx";
import {type SessionListWindowOptions, sessionListWindow} from "./SessionListWindow.tsx";

installDomShims();

const listed = (sessions: ReadonlyArray<SessionRow>): SessionListAnswer => ({
	_tag: "Listed",
	sessions,
	unreadable: [],
});

const paged = (texts: ReadonlyArray<string>): TranscriptPaged => ({
	answer: {
		_tag: "Read",
		older: {_tag: "Idle"},
		page: {
			items: texts.map((text, index) => ({
				kind: "user" as const,
				id: ItemId.make(`m-${index}`),
				timestamp: NOW,
				text,
			})),
			next: null,
		},
	},
});

/**
 * The one thing this surface reads off its host: the window its call would name
 * (`SessionListWindow.tsx`). Everything else on a host is unread here, so nothing else is filled.
 */
const host = {windowId: WindowId.make("w-1")} as WindowHost;

/** The window as a page mounts it, at whatever seams a test needs. */
const mount = (options: SessionListWindowOptions = {}): ReactElement => {
	const renderer = sessionListWindow({
		useAnswer: () => ({status: listed(scrambled)}),
		...options,
	});
	return renderer.render(host) as ReactElement;
};

const field = (): HTMLElement => screen.getByRole("combobox", {name: "AI agent sessions"});

const activate = (
	options: SessionListWindowOptions = {},
	key: {readonly metaKey?: boolean} = {},
) => {
	render(mount(options));
	fireEvent.keyDown(field(), {key: "Enter", ...key});
};

describe("activating a row inline", () => {
	it("replaces the list with that session's transcript in the same window", () => {
		activate({useTranscript: () => paged(["turn one", "turn two"])});

		expect(screen.queryByRole("combobox", {name: "AI agent sessions"})).toBeNull();
		const transcript = screen.getByRole("region", {name: claudeSession.firstPrompt ?? ""});
		expect(transcript.textContent).toContain("turn one");
		expect(transcript.textContent).toContain("turn two");
	});

	it("asks for one page off the port's cursor rather than the whole transcript", () => {
		const reads: Array<TranscriptRead> = [];
		activate({
			useTranscript: (request: OpenRequest) => {
				if (request._tag === "Read") reads.push(request.read);
				return paged([]);
			},
		});

		expect(reads[0]).toEqual({
			programId: claudeSession.programId,
			sessionId: claudeSession.sessionId,
			cwd: claudeSession.folder,
			before: null,
			limit: TRANSCRIPT_PAGE_SIZE,
		});
	});

	it("says a session it cannot open is unopenable rather than rendering it empty", () => {
		// The oldest row is the one whose store reported no folder, so it is the one Enter lands on
		// when it is the only row on offer.
		const renderer = sessionListWindow({useAnswer: () => ({status: listed([bareSession])})});
		render(renderer.render(host) as ReactElement);
		fireEvent.keyDown(field(), {key: "Enter"});

		expect(screen.getByRole("alert").textContent).toContain("no folder");
	});

	it("opens no new window", () => {
		const elsewhere = vi.fn();
		activate({useTranscript: () => paged([]), onOpenInNewWindow: elsewhere});
		expect(elsewhere).not.toHaveBeenCalled();
	});
});

describe("Cmd+Enter on a row", () => {
	it("opens it in the other window and leaves this one on the list", () => {
		const elsewhere = vi.fn();
		activate({useTranscript: () => paged([]), onOpenInNewWindow: elsewhere}, {metaKey: true});

		expect(elsewhere).toHaveBeenCalledWith(claudeSession);
		expect(screen.getByRole("combobox", {name: "AI agent sessions"})).toBeTruthy();
	});
});

describe("the first send on an opened session", () => {
	const composer = (): HTMLElement =>
		screen.getByRole("combobox", {name: "Write a message to the agent"});

	const type = async (text: string): Promise<void> => {
		await act(async () => {
			fireEvent.change(composer(), {target: {value: text}});
		});
		await act(async () => {
			fireEvent.keyDown(composer(), {key: "Enter"});
		});
	};

	it.each([
		[],
		["existing turn"],
	])("creates one process for readable history %j and reuses it", async (...texts) => {
		const plans: Array<SendPlan> = [];
		const sends: Array<{session: SessionRow; text: string}> = [];
		activate({
			useTranscript: () => paged(texts),
			onSend: (session, text, plan) => {
				plans.push(plan);
				sends.push({session, text});
			},
		});

		await type("first");
		await type("second");

		expect(sends).toEqual([
			{session: claudeSession, text: "first"},
			{session: claudeSession, text: "second"},
		]);
		expect(plans.every((plan) => plan.phase === "live" && plan.refused === null)).toBe(true);
		expect(plans.map((plan) => plan.spawn)).toEqual([
			{
				programId: claudeSession.programId,
				cwd: claudeSession.folder,
				resume: claudeSession.sessionId,
			},
			null,
		]);
	});
});

describe("refused session sends", () => {
	it.each([
		"missing-folder",
		"read-refused",
	])("offers no impossible keyboard send for %s, and Back opens a fresh valid session", async (kind) => {
		const onSend = vi.fn();
		const bad = {
			...bareSession,
			title: "Unopenable session",
			...(kind === "missing-folder" ? {} : {folder: "project"}),
		};
		activate(
			{
				useAnswer: () => ({status: listed([bad, claudeSession])}),
				useTranscript: (request) =>
					request._tag === "Read" && request.read.sessionId === claudeSession.sessionId
						? paged([])
						: {
								answer: {
									_tag: "Refused",
									failure: {
										tag: "refused",
										message: "Transcript unavailable",
										path: ["session", "transcript"],
									},
								},
							},
				onSend,
			},
			{},
		);
		fireEvent.click(screen.getByRole("button", {name: "Back to the session list"}));
		fireEvent.change(field(), {target: {value: "Unopenable session"}});
		fireEvent.keyDown(field(), {key: "Enter"});
		expect(screen.getByRole("alert")).toBeTruthy();
		expect(screen.queryByRole("combobox", {name: "Write a message to the agent"})).toBeNull();
		fireEvent.keyDown(
			screen.getByRole("region", {name: /Unopenable session|Wire the session list window/}),
			{key: "Enter"},
		);
		expect(onSend).not.toHaveBeenCalled();
		expect(
			screen
				.getByRole("region", {name: /Unopenable session|Wire the session list window/})
				.getAttribute("data-sent"),
		).toBe("false");
		fireEvent.click(screen.getByRole("button", {name: "Back to the session list"}));
		fireEvent.keyDown(field(), {key: "Enter"});
		expect(screen.queryByRole("alert")).toBeNull();
		expect(
			screen
				.getByRole("region", {name: /Unopenable session|Wire the session list window/})
				.getAttribute("data-sent"),
		).toBe("false");
		await act(async () => {
			fireEvent.change(screen.getByRole("combobox", {name: "Write a message to the agent"}), {
				target: {value: "new send"},
			});
		});
		await act(async () => {
			fireEvent.keyDown(screen.getByRole("combobox", {name: "Write a message to the agent"}), {
				key: "Enter",
			});
		});
		expect(onSend).toHaveBeenCalledExactlyOnceWith(
			claudeSession,
			"new send",
			opening.send("reading", claudeSession),
		);
	});

	it("consumes a refused plan before marking sent or forwarding a successful send", async () => {
		const refused = opening.send("reading", bareSession);
		const plan = vi.spyOn(opening, "send").mockReturnValueOnce(refused);
		const onSend = vi.fn();
		try {
			activate({useTranscript: () => paged([]), onSend});
			const input = screen.getByRole("combobox", {name: "Write a message to the agent"});
			await act(async () => {
				fireEvent.change(input, {target: {value: "refused send"}});
			});
			await act(async () => {
				fireEvent.keyDown(input, {key: "Enter"});
			});
			expect(plan).toHaveBeenCalledWith("reading", claudeSession);
			expect(onSend).not.toHaveBeenCalled();
			expect(screen.getByRole("alert").textContent).toContain("no folder");
			expect(
				screen
					.getByRole("region", {name: /Unopenable session|Wire the session list window/})
					.getAttribute("data-sent"),
			).toBe("false");
			expect(screen.queryByRole("combobox", {name: "Write a message to the agent"})).toBeNull();
			fireEvent.click(screen.getByRole("button", {name: "Back to the session list"}));
			fireEvent.keyDown(field(), {key: "Enter"});
			expect(screen.queryByRole("alert")).toBeNull();
			expect(
				screen
					.getByRole("region", {name: /Unopenable session|Wire the session list window/})
					.getAttribute("data-sent"),
			).toBe("false");
		} finally {
			plan.mockRestore();
		}
	});
});
