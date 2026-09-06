/**
 * @vitest-environment jsdom
 *
 * The one claim `useForwardedKey` makes about time: a renderer sees only keys forwarded after it
 * mounted (#8279). The desk never clears the last forwarded key, so a renderer mounting into a
 * window that already had one is the ordinary case, not the exotic one.
 */

import {render} from "@testing-library/react";
import type {ReactElement} from "react";
import {StrictMode} from "react";
import {describe, expect, it} from "vitest";
import {WindowId} from "../window/index.ts";
import {installDomShims} from "./dom.testing.ts";
import {type ForwardedKey, ForwardedKeyProvider, useForwardedKey} from "./forwarded-key.tsx";

installDomShims();

const window0 = WindowId.make("window-0");
const window1 = WindowId.make("window-1");

const forward = (key: string, seq: number, windowId: WindowId = window0): ForwardedKey => ({
	windowId,
	key,
	seq,
});

interface ProbeProps {
	readonly windowId: WindowId;
	readonly received: Array<string>;
}

function Probe({windowId, received}: ProbeProps): ReactElement {
	useForwardedKey(windowId, (key) => received.push(key));
	return <p>probe</p>;
}

interface StageProps extends ProbeProps {
	readonly forwarded: ForwardedKey | null;
	/** The probe mounts late, the way a picker does when `window:pick` drops the renderer. */
	readonly mounted: boolean;
	readonly strict?: boolean;
}

function Stage({forwarded, mounted, windowId, received, strict = false}: StageProps): ReactElement {
	const tree = (
		<ForwardedKeyProvider value={forwarded}>
			{mounted ? <Probe windowId={windowId} received={received} /> : null}
		</ForwardedKeyProvider>
	);
	return strict ? <StrictMode>{tree}</StrictMode> : tree;
}

describe("a renderer sees only keys forwarded after it mounted", () => {
	it("never receives the key that was already forwarded, and receives the next one once", () => {
		const received: Array<string> = [];
		const view = render(
			<Stage
				forwarded={forward("<enter>", 1)}
				mounted={false}
				windowId={window0}
				received={received}
			/>,
		);

		view.rerender(
			<Stage
				forwarded={forward("<enter>", 1)}
				mounted={true}
				windowId={window0}
				received={received}
			/>,
		);
		expect(received).toEqual([]);

		view.rerender(
			<Stage forwarded={forward("j", 2)} mounted={true} windowId={window0} received={received} />,
		);
		expect(received).toEqual(["j"]);
	});

	it("holds the same floor through StrictMode's second mount effect", () => {
		const received: Array<string> = [];
		const view = render(
			<Stage
				forwarded={forward("<enter>", 1)}
				mounted={false}
				windowId={window0}
				received={received}
				strict
			/>,
		);

		view.rerender(
			<Stage
				forwarded={forward("<enter>", 1)}
				mounted={true}
				windowId={window0}
				received={received}
				strict
			/>,
		);
		expect(received).toEqual([]);

		view.rerender(
			<Stage
				forwarded={forward("j", 2)}
				mounted={true}
				windowId={window0}
				received={received}
				strict
			/>,
		);
		expect(received).toEqual(["j"]);
	});

	it("takes its floor from the desk's counter, not from its own window's traffic", () => {
		const received: Array<string> = [];
		// The last thing forwarded went to another window; `seq` is monotonic per desk, so the floor
		// is that number and a key arriving here afterwards still clears it.
		const view = render(
			<Stage
				forwarded={forward("<enter>", 7, window1)}
				mounted={true}
				windowId={window0}
				received={received}
			/>,
		);
		expect(received).toEqual([]);

		view.rerender(
			<Stage forwarded={forward("k", 8)} mounted={true} windowId={window0} received={received} />,
		);
		expect(received).toEqual(["k"]);
	});

	it("still delivers a repeated key, which is the whole reason `seq` exists", () => {
		const received: Array<string> = [];
		const view = render(
			<Stage forwarded={null} mounted={true} windowId={window0} received={received} />,
		);

		view.rerender(
			<Stage forwarded={forward("j", 1)} mounted={true} windowId={window0} received={received} />,
		);
		view.rerender(
			<Stage forwarded={forward("j", 2)} mounted={true} windowId={window0} received={received} />,
		);
		expect(received).toEqual(["j", "j"]);
	});
});
