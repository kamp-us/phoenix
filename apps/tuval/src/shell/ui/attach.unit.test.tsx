/**
 * @vitest-environment jsdom
 *
 * Attaching, dropping and re-attaching. The one behaviour worth a test on its own is the negative
 * one: a drop must not clear the desk, because a page that blanked on every reconnect would be
 * worse than one that never reconnected.
 */

import {act, render, screen} from "@testing-library/react";
import type {ReactElement} from "react";
import {useCallback} from "react";
import {describe, expect, it} from "vitest";
import {initialState} from "../core/index.ts";
import {type AttachEvent, attachInitial, onAttachEvent, useDeskAttachment} from "./attach.ts";
import {installDomShims} from "./dom.testing.ts";
import {threeWindowDesk} from "./fixtures.ts";

installDomShims();

const desk = threeWindowDesk();

describe("the attachment machine", () => {
	it("starts connecting with no desk", () => {
		expect(attachInitial).toMatchObject({status: "connecting", desk: null, attachments: 0});
	});

	it("counts each attach and takes the first snapshot as the desk", () => {
		const attached = onAttachEvent(attachInitial, {_tag: "Attached"});
		expect(attached).toMatchObject({status: "attached", attachments: 1});

		const shown = onAttachEvent(attached, {_tag: "Snapshot", state: desk});
		expect(shown.desk).toEqual(desk);
	});

	it("keeps the desk across a drop, and through the re-attach", () => {
		const shown = [{_tag: "Attached"} as const, {_tag: "Snapshot", state: desk} as const].reduce<
			ReturnType<typeof onAttachEvent>
		>(onAttachEvent, attachInitial);

		const dropped = onAttachEvent(shown, {_tag: "Dropped", reason: "socket closed"});
		expect(dropped.status).toBe("reattaching");
		expect(dropped.desk).toEqual(desk);
		expect(dropped.lastDrop).toBe("socket closed");

		const again = onAttachEvent(dropped, {_tag: "Attached"});
		expect(again).toMatchObject({status: "attached", attachments: 2});
		expect(again.desk).toEqual(desk);
	});

	it("counts a snapshot the shell's own guard refuses and keeps the last sound desk", () => {
		const shown = onAttachEvent(onAttachEvent(attachInitial, {_tag: "Attached"}), {
			_tag: "Snapshot",
			state: desk,
		});
		const refused = onAttachEvent(shown, {_tag: "Snapshot", state: {workspaces: "not a map"}});
		expect(refused.refusedSnapshots).toBe(1);
		expect(refused.desk).toEqual(desk);
	});

	it("takes a fresh desk over the one it was holding", () => {
		const first = onAttachEvent(attachInitial, {_tag: "Snapshot", state: desk});
		const next = initialState();
		expect(onAttachEvent(first, {_tag: "Snapshot", state: next}).desk).toEqual(next);
	});
});

function Attachment({
	emitter,
}: {
	readonly emitter: {current: ((e: AttachEvent) => void) | null};
}): ReactElement {
	const source = useCallback(
		(emit: (event: AttachEvent) => void) => {
			emitter.current = emit;
			return () => {
				emitter.current = null;
			};
		},
		[emitter],
	);
	const state = useDeskAttachment(source);
	return (
		<output>
			{state.status} · attachments {state.attachments} · windows{" "}
			{state.desk === null ? "none" : Object.keys(state.desk.views).length + 3}
		</output>
	);
}

describe("useDeskAttachment", () => {
	it("attaches on mount and re-attaches after a drop without losing the desk", () => {
		const emitter: {current: ((e: AttachEvent) => void) | null} = {current: null};
		render(<Attachment emitter={emitter} />);
		expect(emitter.current).not.toBeNull();

		act(() => {
			emitter.current?.({_tag: "Attached"});
			emitter.current?.({_tag: "Snapshot", state: desk});
		});
		expect(screen.getByRole("status").textContent).toContain("attached · attachments 1");
		expect(screen.getByRole("status").textContent).toContain("windows 3");

		act(() => emitter.current?.({_tag: "Dropped", reason: "socket closed"}));
		expect(screen.getByRole("status").textContent).toContain("reattaching");
		// The desk is still on screen through the gap — that is the whole point of the arm.
		expect(screen.getByRole("status").textContent).toContain("windows 3");

		act(() => emitter.current?.({_tag: "Attached"}));
		expect(screen.getByRole("status").textContent).toContain("attached · attachments 2");
		expect(screen.getByRole("status").textContent).toContain("windows 3");
	});

	it("stops listening when the page goes away", () => {
		const emitter: {current: ((e: AttachEvent) => void) | null} = {current: null};
		const {unmount} = render(<Attachment emitter={emitter} />);
		unmount();
		expect(emitter.current).toBeNull();
	});
});
