/**
 * The `ps` program's window renderer, at both the shapes a surface asks for.
 *
 * `psWindowRenderer` is the window contract's own `WindowRenderer` (`../../shell/window/renderer.ts`)
 * with this program's state and Msg fixed by `windowRenderer`'s inference, so a renderer written
 * against another program's host is a compile error where this type is required. `psReactRenderer`
 * is the same function at the browser surface's `ReactWindowRenderer` shape, which is what the page's
 * program-id-keyed table holds.
 */

import type {ReactNode} from "react";
import type {ReactWindowRenderer} from "../../shell/ui/mount.ts";
import type {ViewState, WindowRenderer} from "../../shell/window/index.ts";
import {windowRenderer} from "../../shell/window/index.ts";
import {PsTable} from "./PsTable.tsx";
import type {PsMsg, PsState} from "./state.ts";

export const psWindowRenderer: WindowRenderer<ReactNode, PsState, PsMsg, ViewState> =
	windowRenderer<ReactNode, PsState, PsMsg, ViewState>("host-native", (host) => (
		<PsTable host={host} />
	));

export const psReactRenderer: ReactWindowRenderer = (host) => psWindowRenderer.render(host);
