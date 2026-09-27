/**
 * @vitest-environment jsdom
 *
 * The half of the window title `window-title.unit.test.ts` cannot state: that a re-emitted `title@1`
 * moves the title row *without* tearing the window down under the reader (#8721, epic ruling R4.1).
 * The renderer's own DOM node is compared across the re-render, because a remount is exactly what a
 * title-keyed boundary would cause and a text assertion alone would not notice.
 */

import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {WindowId} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {installDomShims} from "@kampus/tuval-ui/testing/dom";
import {render, screen} from "@testing-library/react";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import {noEntries} from "../picker/browser.ts";
import {boundMount, type ProcessName, type WindowMount} from "./mount.ts";
import {WindowView} from "./WindowView.tsx";

installDomShims();

const windowId = WindowId.make("window-1");
const claude = ProgramId.make("claude-session");

const mountNamed = (name: ProcessName | null): WindowMount =>
	boundMount(
		{
			windowId,
			processId: ProcessId.make("process-1"),
			readProcess: undefined as never,
			dispatch: undefined as never,
			view: () => null,
			setView: undefined as never,
		},
		() => <p data-testid="body">the session</p>,
		name,
	);

const view = (mount: WindowMount): ReactElement => (
	<WindowView
		windowId={windowId}
		mount={mount}
		focused={true}
		view={undefined}
		entries={noEntries}
		dispatch={() => undefined}
		reducedMotion={true}
	/>
);

describe("a window whose process re-emits its title", () => {
	it("moves the title and keeps the window mounted", () => {
		const {rerender} = render(
			view(mountNamed({title: "claude · fable · phoenix", programId: claude})),
		);
		const body = screen.getByTestId("body");
		expect(screen.getByText("claude · fable · phoenix")).toBeTruthy();

		rerender(view(mountNamed({title: "claude · fable · reading #8721", programId: claude})));
		expect(screen.getByText("claude · fable · reading #8721")).toBeTruthy();
		expect(screen.queryByText("claude · fable · phoenix")).toBeNull();
		expect(screen.getByTestId("body")).toBe(body);
	});
});
