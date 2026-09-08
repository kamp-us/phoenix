/** @vitest-environment jsdom */
import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {Effect, Schema} from "effect";
import {expect, it, vi} from "vitest";
import {WindowId} from "../../protocol/ids.ts";
import {PROTOCOL_VERSION, type SpellCall, SpellReplyOk} from "../../protocol/messages.ts";
import type {RegistryDescription} from "../../protocol/registry-description.ts";
import {initialState} from "../core/machine.ts";
import {installDomShims} from "./dom.testing.ts";
import {PaletteHost} from "./PaletteHost.tsx";

installDomShims();
const registry: RegistryDescription = [
	{
		path: ["counter", "echo"],
		describe: "Echo ordinary program text.",
		params: Schema.toJsonSchemaDocument(Schema.Struct({text: Schema.String})),
		capabilities: [],
	},
];

it("discovers a live program command and calls its actual address with focused scope", async () => {
	const onClose = vi.fn();
	const call = vi.fn((spell: SpellCall) =>
		Effect.succeed(
			new SpellReplyOk({
				type: "spell.reply",
				version: PROTOCOL_VERSION,
				id: spell.id,
				ok: true,
				result: "hello",
			}),
		),
	);
	render(
		<PaletteHost
			state={initialState()}
			registry={registry}
			call={call}
			window={WindowId.make("window-1")}
			onClose={onClose}
		/>,
	);
	const input = screen.getByRole("combobox");
	fireEvent.change(input, {target: {value: "counter"}});
	expect(screen.getByRole("option", {name: /counter echo/})).toBeDefined();
	fireEvent.change(input, {target: {value: "counter echo hello"}});
	fireEvent.keyDown(input, {key: "Enter"});
	await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
	expect(call.mock.calls[0]?.[0]).toMatchObject({
		path: ["counter", "echo"],
		args: {text: "hello"},
		window: "window-1",
	});
});

it("offers each shell shortcut once, preferring it over a colliding registry path", async () => {
	const live: RegistryDescription = [
		{
			path: ["shell", "window", "close"],
			describe: "Registered shell close.",
			params: Schema.toJsonSchemaDocument(Schema.Struct({})),
			capabilities: [],
		},
		{
			path: ["window", "close"],
			describe: "Colliding core close.",
			params: Schema.toJsonSchemaDocument(Schema.Struct({})),
			capabilities: [],
		},
	];
	const call = vi.fn((_spell: SpellCall) => Effect.never);
	render(
		<PaletteHost
			state={initialState()}
			registry={live}
			call={call}
			window={undefined}
			onClose={vi.fn()}
		/>,
	);
	const input = screen.getByRole("combobox");
	expect(screen.getAllByRole("option")).toHaveLength(1);
	expect(screen.getByRole("option").textContent).toContain("Registered shell close.");
	expect(screen.getByRole("option").textContent).not.toContain("shell window close");
	fireEvent.change(input, {target: {value: "window close"}});
	fireEvent.keyDown(input, {key: "Enter"});
	await waitFor(() => expect(call).toHaveBeenCalledOnce());
	expect(call.mock.calls[0]?.[0]).toMatchObject({path: ["shell", "window", "close"]});
});

it("updates discovery after catalogue replacement and rejects replies from a replaced attachment", async () => {
	let answer: (() => void) | undefined;
	const call = (spell: SpellCall) =>
		Effect.callback<SpellReplyOk>((resume) => {
			answer = () =>
				resume(
					Effect.succeed(
						new SpellReplyOk({
							type: "spell.reply",
							version: PROTOCOL_VERSION,
							id: spell.id,
							ok: true,
							result: "old",
						}),
					),
				);
		});
	const onClose = vi.fn();
	const props = {state: initialState(), window: undefined, onClose};
	const view = render(<PaletteHost {...props} registry={registry} call={call} />);
	const input = screen.getByRole("combobox");
	fireEvent.change(input, {target: {value: "counter echo hello"}});
	fireEvent.keyDown(input, {key: "Enter"});
	view.rerender(<PaletteHost {...props} registry={[]} call={() => Effect.never} />);
	fireEvent.change(input, {target: {value: "counter"}});
	expect(screen.queryByRole("option")).toBeNull();
	await act(async () => {
		answer?.();
		await Promise.resolve();
	});
	expect(onClose).not.toHaveBeenCalled();
});
