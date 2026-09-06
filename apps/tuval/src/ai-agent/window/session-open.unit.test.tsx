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
import {ItemId} from "../ports/index.ts";
import {bareSession, claudeSession, NOW, scrambled} from "./fixtures.ts";
import type {SendPlan, TranscriptRead} from "./opening.ts";
import {TRANSCRIPT_PAGE_SIZE} from "./opening.ts";
import {type SessionListWindowOptions, sessionListWindow} from "./SessionListWindow.tsx";
import type {TranscriptAnswer} from "./SessionTranscript.tsx";

installDomShims();

const listed = (sessions: ReadonlyArray<SessionRow>): SessionListAnswer => ({
	_tag: "Listed",
	sessions,
	unreadable: [],
});

const page = (texts: ReadonlyArray<string>): TranscriptAnswer => ({
	_tag: "Read",
	page: {
		items: texts.map((text, index) => ({
			kind: "user" as const,
			id: ItemId.make(`m-${index}`),
			timestamp: NOW,
			text,
		})),
		next: null,
	},
});

/** The window as a page mounts it, at whatever seams a test needs. */
const mount = (options: SessionListWindowOptions = {}): ReactElement => {
	const renderer = sessionListWindow({
		useAnswer: () => listed(scrambled),
		...options,
	});
	// The window host is unread by this surface (`SessionListWindow.tsx`), so none is handed over.
	return renderer.render(undefined as never) as ReactElement;
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
		activate({useTranscript: () => page(["turn one", "turn two"])});

		expect(screen.queryByRole("combobox", {name: "AI agent sessions"})).toBeNull();
		const transcript = screen.getByRole("region", {name: claudeSession.firstPrompt ?? ""});
		expect(transcript.textContent).toContain("turn one");
		expect(transcript.textContent).toContain("turn two");
	});

	it("asks for one page off the port's cursor rather than the whole transcript", () => {
		const reads: Array<TranscriptRead> = [];
		activate({
			useTranscript: (read) => {
				reads.push(read);
				return page([]);
			},
		});

		expect(reads[0]).toEqual({
			backend: claudeSession.backend,
			sessionId: claudeSession.sessionId,
			cwd: claudeSession.folder,
			before: null,
			limit: TRANSCRIPT_PAGE_SIZE,
		});
	});

	it("says a session it cannot open is unopenable rather than rendering it empty", () => {
		// The oldest row is the one whose store reported no folder, so it is the one Enter lands on
		// when it is the only row on offer.
		const renderer = sessionListWindow({useAnswer: () => listed([bareSession])});
		render(renderer.render(undefined as never) as ReactElement);
		fireEvent.keyDown(field(), {key: "Enter"});

		expect(screen.getByRole("alert").textContent).toContain("no folder");
	});

	it("opens no new window", () => {
		const elsewhere = vi.fn();
		activate({useTranscript: () => page([]), onOpenInNewWindow: elsewhere});
		expect(elsewhere).not.toHaveBeenCalled();
	});
});

describe("Cmd+Enter on a row", () => {
	it("opens it in the other window and leaves this one on the list", () => {
		const elsewhere = vi.fn();
		activate({useTranscript: () => page([]), onOpenInNewWindow: elsewhere}, {metaKey: true});

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

	it("creates exactly one process on that session id, and reuses it on the second", async () => {
		const plans: Array<SendPlan> = [];
		activate({
			useTranscript: () => page([]),
			onSend: (_session, _text, plan) => plans.push(plan),
		});

		await type("first");
		await type("second");

		expect(plans.map((plan) => plan.spawn)).toEqual([
			{
				programId: claudeSession.backend,
				cwd: claudeSession.folder,
				resume: claudeSession.sessionId,
			},
			null,
		]);
	});
});
