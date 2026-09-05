/**
 * The layout tree, bound to `react-resizable-panels@4.12.3` one node to one component: a
 * `StackNode` is a `Group`, its children are `Panel`s keyed by their own node id, and a `Separator`
 * sits between each pair. The full binding rationale — why `defaultLayout` alone cannot mirror a
 * second tab, and why `setLayout` is the write-back — is
 * [`.patterns/layout-tree-with-resizable-panels.md`](../../../../../.patterns/layout-tree-with-resizable-panels.md).
 *
 * Two things are load-bearing here and neither is obvious from the props.
 *
 * The library is **not prop-controlled** *within one panel set*: `defaultLayout` is read when the
 * group registers, so a later `sizes` from the kernel — another tab's drag — would never reach the
 * DOM if that prop were the whole binding. `useGroupRef().setLayout` is what pushes it in, and it
 * no-ops when the layout already matches, which is why the effect cannot loop against its own
 * write. But it **throws** when the layout names a panel set the group does not hold, and a split
 * or a close leaves it not holding one for a commit — so the write is guarded on `holdsPanels` and
 * a panel-set change is carried by `defaultLayout` instead.
 *
 * Zoom is a **conditional render**, never `collapse()`. The zoomed window is rendered alone and the
 * split is unmounted; RRP restores it from its own panel-id cache on remount, and `sizes` is never
 * written, so unzoom lands on the layout the user left (`../layout/tree.ts`, `zoom`).
 */

import type {ReactElement, ReactNode} from "react";
import {useEffect} from "react";
import {Group, type LayoutChangedMeta, Panel, Separator, useGroupRef} from "react-resizable-panels";
import type {ShellMsg} from "../core/index.ts";
import {type LayoutNode, SIZE_TOLERANCE, type StackNode} from "../layout/index.ts";
import {WindowId} from "../window/index.ts";
import {defaultLayoutOf, holdsPanels, sameLayout} from "./frame.ts";

export interface LayoutViewProps {
	readonly root: StackNode;
	/** The one window rendered alone, or `null` for the whole tree. */
	readonly zoomed: WindowId | null;
	readonly renderWindow: (windowId: WindowId) => ReactNode;
	readonly dispatch: (msg: ShellMsg) => void;
}

interface StackViewProps {
	readonly stack: StackNode;
	readonly renderWindow: (windowId: WindowId) => ReactNode;
	readonly dispatch: (msg: ShellMsg) => void;
}

const renderNode = (
	node: LayoutNode,
	renderWindow: (windowId: WindowId) => ReactNode,
	dispatch: (msg: ShellMsg) => void,
): ReactNode =>
	node.tag === "window" ? (
		// The one conversion the tree's plain ids need: `../layout/` stays free of Effect and so
		// types an id as `string`, while the window contract brands it (#7700, `../program.ts`).
		renderWindow(WindowId.make(node.id))
	) : (
		<StackView stack={node} renderWindow={renderWindow} dispatch={dispatch} />
	);

function StackView({stack, renderWindow, dispatch}: StackViewProps): ReactElement {
	const groupRef = useGroupRef();

	useEffect(() => {
		const group = groupRef.current;
		if (group === null) return;
		const reported = group.getLayout();
		// This gesture changed the panel set, and the group has not re-registered yet. Writing here
		// is the crash of #7839, and there is nothing to write: re-registration takes its layout from
		// the `defaultLayout` prop below for any set the group has not laid out before, so the
		// kernel's sizes arrive by that route.
		if (!holdsPanels(stack, reported)) return;
		// A `sizes` the kernel holds that this group does not is another tab's finished drag, or a
		// restored desk. `setLayout` no-ops when the two already agree, so the guard is about the
		// Msg round trip below, not about the write.
		if (sameLayout(stack, reported, SIZE_TOLERANCE)) return;
		group.setLayout(defaultLayoutOf(stack));
	}, [stack, groupRef]);

	const onLayoutChanged = (layout: Record<string, number>, meta: LayoutChangedMeta): void => {
		// `isUserInteraction` is the library's own answer to "did a person do this": `false` covers
		// the programmatic `setLayout` above, the initial mount and every constraint recompute. Only
		// a released drag or a resize key reaches the kernel, and each of those fires exactly once.
		if (!meta.isUserInteraction) return;
		dispatch({type: "layout.resize", stackId: stack.id, sizes: layout});
	};

	return (
		<Group
			className="tuval-tiling"
			groupRef={groupRef}
			orientation={stack.orientation}
			defaultLayout={defaultLayoutOf(stack)}
			onLayoutChanged={onLayoutChanged}
			// The separator paints as a 4px hairline (`./tokens.css`), and the library inflates the
			// grab rect to this minimum rather than to the painted box, which is what keeps a thin
			// divider a real pointer target. The pin's own defaults are 20 coarse / 10 fine.
			resizeTargetMinimumSize={{coarse: 36, fine: 24}}
			data-stack-id={stack.id}
		>
			{stack.children.flatMap((child, index) => {
				const panel = (
					<Panel key={child.id} id={child.id} className="tuval-window-panel" minSize="10">
						{renderNode(child, renderWindow, dispatch)}
					</Panel>
				);
				return index === 0
					? [panel]
					: [
							<Separator
								key={`separator-${child.id}`}
								className="tuval-separator"
								// One group can hold several separators, so the name says which pair this one
								// sits between — "Resize columns" three times over names nothing.
								aria-label={`Resize ${stack.orientation === "horizontal" ? "columns" : "rows"} before ${child.id}`}
							/>,
							panel,
						];
			})}
		</Group>
	);
}

export function LayoutView({
	root,
	zoomed,
	renderWindow,
	dispatch,
}: LayoutViewProps): ReactElement | null {
	if (zoomed !== null) return <div className="tuval-tiling">{renderWindow(zoomed)}</div>;
	return <StackView stack={root} renderWindow={renderWindow} dispatch={dispatch} />;
}
