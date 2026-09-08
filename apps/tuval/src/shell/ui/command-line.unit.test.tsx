/** @vitest-environment jsdom */
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {Effect} from "effect";
import {Socket} from "effect/unstable/socket";
import {afterEach, expect, it, vi} from "vitest";
import {descriptions, snapshot} from "../../commands/parse/fixtures.ts";
import {
	PROTOCOL_VERSION,
	type SpellCall,
	type SpellReply,
	SpellReplyError,
	SpellReplyOk,
} from "../../protocol/messages.ts";
import {CommandLine} from "./CommandLine.tsx";

afterEach(cleanup);

it("shows a connection failure instead of a success", async () => {
	render(
		<CommandLine
			dispatch={vi.fn()}
			onClose={vi.fn()}
			registry={descriptions}
			snapshot={snapshot}
			call={() =>
				Effect.fail(new Socket.SocketError({reason: new Socket.SocketCloseError({code: 1006})}))
			}
		/>,
	);
	fireEvent.change(screen.getByRole("textbox"), {target: {value: "window close"}});
	fireEvent.submit(screen.getByRole("form"));
	await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Disconnected"));
	expect(screen.queryByRole("status")).toBeNull();
});

it("keeps a program result visible and calls the actual transport once", async () => {
	const call = vi.fn((spell: SpellCall) =>
		Effect.succeed(
			new SpellReplyOk({
				type: "spell.reply",
				version: PROTOCOL_VERSION,
				id: spell.id,
				ok: true,
				result: {done: "yes"},
			}),
		),
	);
	const close = vi.fn();
	render(
		<CommandLine
			dispatch={vi.fn()}
			onClose={close}
			registry={descriptions}
			snapshot={snapshot}
			call={call}
		/>,
	);
	fireEvent.change(screen.getByRole("textbox"), {target: {value: "window close"}});
	fireEvent.submit(screen.getByRole("form"));
	await waitFor(() => expect(screen.getByRole("status").textContent).toContain('"done": "yes"'));
	expect(call).toHaveBeenCalledTimes(1);
	expect(close).not.toHaveBeenCalled();
});

it("suppresses double Enter and ignores a late reply after newer input or attachment", async () => {
	const waiting: Array<() => void> = [];
	const call = vi.fn((spell: SpellCall) =>
		Effect.callback<SpellReply>((resume) => {
			waiting.push(() =>
				resume(
					Effect.succeed(
						new SpellReplyOk({
							type: "spell.reply",
							version: PROTOCOL_VERSION,
							id: spell.id,
							ok: true,
							result: "old result",
						}),
					),
				),
			);
		}),
	);
	const props = {dispatch: vi.fn(), onClose: vi.fn(), registry: descriptions, snapshot};
	const view = render(<CommandLine {...props} call={call} />);
	fireEvent.change(screen.getByRole("textbox"), {target: {value: "window close"}});
	fireEvent.submit(screen.getByRole("form"));
	fireEvent.submit(screen.getByRole("form"));
	expect(call).toHaveBeenCalledTimes(1);
	fireEvent.change(screen.getByRole("textbox"), {target: {value: "window close "}});
	fireEvent.submit(screen.getByRole("form"));
	expect(call).toHaveBeenCalledTimes(2);
	await act(async () => {
		waiting[0]?.();
		await Promise.resolve();
	});
	expect(screen.getByRole("status").textContent).toBe("Running…");
	view.rerender(<CommandLine {...props} call={() => Effect.never} />);
	await act(async () => {
		waiting[1]?.();
		await Promise.resolve();
	});
	expect(screen.queryByRole("status")).toBeNull();
});

it("shows the typed executor refusal and preserves Escape", async () => {
	const close = vi.fn();
	render(
		<CommandLine
			dispatch={vi.fn()}
			onClose={close}
			registry={descriptions}
			snapshot={snapshot}
			call={(spell) =>
				Effect.succeed(
					new SpellReplyError({
						type: "spell.reply",
						version: PROTOCOL_VERSION,
						id: spell.id,
						ok: false,
						error: {tag: "Denied", message: "That program refused"},
					}),
				)
			}
		/>,
	);
	fireEvent.change(screen.getByRole("textbox"), {target: {value: "window close"}});
	fireEvent.submit(screen.getByRole("form"));
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toBe("Denied: That program refused"),
	);
	fireEvent.keyDown(screen.getByRole("textbox"), {key: "Escape"});
	expect(close).toHaveBeenCalledTimes(1);
});
