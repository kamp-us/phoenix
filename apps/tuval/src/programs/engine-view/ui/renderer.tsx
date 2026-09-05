/**
 * The `engine-view` row's window renderer, in the two shapes the app needs it.
 *
 * `engineViewRenderer` is the window contract's own `WindowRenderer` — a kind plus a function of one
 * `WindowHost` — and it is what the row's `RendererRef` names. Its host type is pinned at this
 * program's state and Msg, so a renderer written against another program's host is a compile error
 * where this one is required (`../../../shell/window/renderer.ts`).
 *
 * `engineViewReactRenderer` is the same function at the browser surface's own type. The page keys
 * its table by program id rather than by the row's reference, because the process-table wire carries
 * no renderer field (`../../../page/renderers.tsx`), so both spellings have to exist and neither is
 * a second implementation.
 */

import type {ReactNode} from "react";
import type {ReactWindowRenderer} from "../../../shell/ui/mount.ts";
import type {AnyWindowHost, ViewState, WindowHost} from "../../../shell/window/host.ts";
import {type WindowRenderer, windowRenderer} from "../../../shell/window/renderer.ts";
import type {EngineViewMsg, EngineViewState} from "../program.ts";
import {EngineViewCanvas} from "./EngineViewCanvas.tsx";

export type EngineViewHost = WindowHost<EngineViewState, EngineViewMsg, ViewState>;

export const engineViewRenderer: WindowRenderer<
	ReactNode,
	EngineViewState,
	EngineViewMsg,
	ViewState
> = windowRenderer("host-native", (host: EngineViewHost) => <EngineViewCanvas host={host} />);

export const engineViewReactRenderer: ReactWindowRenderer = (host: AnyWindowHost): ReactNode =>
	engineViewRenderer.render(host as EngineViewHost);
