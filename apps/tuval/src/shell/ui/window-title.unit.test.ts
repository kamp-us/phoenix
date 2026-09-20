import {describe, expect, it} from "vitest";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import {empty, processGone} from "../window/host.ts";
import {WindowId} from "../window/index.ts";
import {boundMount, noRenderer, type ProcessName, type WindowMount} from "./mount.ts";
import {windowTitle} from "./window-title.ts";

const pid = ProcessId.make("process-1");

const bound = (name: ProcessName | null): WindowMount =>
	boundMount(
		{
			windowId: WindowId.make("window-1"),
			processId: pid,
			readProcess: undefined as never,
			dispatch: undefined as never,
			view: () => null,
			setView: undefined as never,
		},
		() => null,
		name,
	);

const claude = ProgramId.make("claude-session");

describe("windowTitle", () => {
	it("shows the line the process published, as it published it", () => {
		expect(windowTitle(bound({title: "claude · fable · phoenix", programId: claude}))).toBe(
			"claude · fable · phoenix",
		);
	});

	it("moves with the line, because it is a function of the mount and holds nothing", () => {
		const first = windowTitle(bound({title: "reading the epic", programId: claude}));
		expect(first).toBe("reading the epic");
		expect(windowTitle(bound({title: "writing the title child", programId: claude}))).toBe(
			"writing the title child",
		);
	});

	it("names a process that published no title by its program, never by its id", () => {
		expect(windowTitle(bound({title: null, programId: claude}))).toBe("claude-session");
	});

	it("treats a blank line as no title, so the row is never empty", () => {
		expect(windowTitle(bound({title: "   ", programId: claude}))).toBe("claude-session");
		expect(windowTitle(bound({title: "", programId: claude}))).toBe("claude-session");
	});

	it("keeps the pre-flag title on a window the desk does not name", () => {
		expect(windowTitle(bound(null))).toBe("process process-1");
		expect(windowTitle(noRenderer(pid, "its program declares no renderer"))).toBe(
			"process process-1",
		);
	});

	it("names a running process whose renderer is missing the same way a bound one is named", () => {
		expect(
			windowTitle(
				noRenderer(pid, "its program declares no renderer", {title: "counting", programId: claude}),
			),
		).toBe("counting");
	});

	it("leaves the two arms that name no live process exactly as they were", () => {
		expect(windowTitle(processGone(pid))).toBe("process process-1 — gone");
		expect(windowTitle(empty)).toBe("empty window");
	});
});
