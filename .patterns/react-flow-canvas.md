# React Flow canvas

Prospective shape for Tuval's root session canvas after its React 19 migration. It applies when
`packages/tuval/src/frontend-shell/app.ts` becomes the React root; it does not make React Flow the
owner of session, relationship, transcript, prompt, or chat-pane state.

> Derived from `@xyflow/react@12.11.5` — re-verify on pin bump.

## Ownership boundary

Three kinds of state meet at the canvas and must not collapse into one store:

| Owner | State |
|---|---|
| Tuval domain | Session identity, lifecycle, transcript/model/thinking data, and relationships |
| Tuval canvas adapter | The controlled node/edge projection, including positions, dimensions, and selection |
| React Flow | Pointer/keyboard interaction, connection geometry, and the current pan/zoom transform |

Domain updates reconcile into the controlled projection by stable session and relationship ids.
For an existing node, reconciliation replaces domain-derived `data` but preserves React Flow fields
such as `position`, `measured`, `selected`, and `dragging`. A removed session removes its node; a new
session gets one deterministic initial position. The same keyed rule applies to relationship edges.
Test these reconciliation helpers as pure functions: a live session update must not snap a dragged
node back to its initial position.

React Flow reports interaction changes through `onNodesChange` and `onEdgesChange`. Apply the full
change arrays with `applyNodeChanges` and `applyEdgeChanges`; do not special-case only drag events.
The upstream controlled-flow test observes dimension, replacement, selection, position, and removal
changes, and the utility preserves unchanged object references while applying those variants.

Use one mode. Pass `nodes`/`edges` plus their change handlers, never those controlled props together
with `defaultNodes`/`defaultEdges`. The upstream mixed-mode example labels that combination bad
practice because it gives the same graph two state owners.

```tsx
import {
	Background,
	Controls,
	Handle,
	Position,
	ReactFlow,
	applyEdgeChanges,
	applyNodeChanges,
	type Edge,
	type EdgeTypes,
	type Node,
	type NodeProps,
	type NodeTypes,
	type OnEdgesChange,
	type OnNodesChange,
} from "@xyflow/react";
import {useCallback, useEffect, useState} from "react";
import "@xyflow/react/dist/style.css";

type SessionCanvasNode = Node<SessionNodeData, "session">;
type RelationshipEdge = Edge<RelationshipData, "relationship">;

const nodeTypes = {session: SessionNodeCard} satisfies NodeTypes;
const edgeTypes = {relationship: RelationshipEdgeView} satisfies EdgeTypes;

function SessionNodeCard({data}: NodeProps<SessionCanvasNode>) {
	return (
		<article className="tuval-session-node">
			<Handle id="relation-in" type="target" position={Position.Left} isConnectable={false} />
			<SessionSummary session={data} />
			<Handle id="relation-out" type="source" position={Position.Right} isConnectable={false} />
		</article>
	);
}

function TuvalCanvas({sessions, relationships}: TuvalCanvasProps) {
	const [nodes, setNodes] = useState(() => toSessionNodes(sessions));
	const [edges, setEdges] = useState(() => toRelationshipEdges(relationships));

	useEffect(() => setNodes((current) => reconcileSessionNodes(current, sessions)), [sessions]);
	useEffect(
		() => setEdges((current) => reconcileRelationshipEdges(current, relationships)),
		[relationships],
	);

	const onNodesChange = useCallback<OnNodesChange<SessionCanvasNode>>(
		(changes) => setNodes((current) => applyNodeChanges(changes, current)),
		[],
	);
	const onEdgesChange = useCallback<OnEdgesChange<RelationshipEdge>>(
		(changes) => setEdges((current) => applyEdgeChanges(changes, current)),
		[],
	);

	return (
		<ReactFlow<SessionCanvasNode, RelationshipEdge>
			nodes={nodes}
			edges={edges}
			onNodesChange={onNodesChange}
			onEdgesChange={onEdgesChange}
			nodeTypes={nodeTypes}
			edgeTypes={edgeTypes}
			ariaLabelConfig={tuvalFlowAriaLabels}
			nodesConnectable={false}
			deleteKeyCode={null}
			fitView
		>
			<Background />
			<Controls />
		</ReactFlow>
	);
}
```

`deleteKeyCode` defaults to Backspace and the upstream test proves it emits a removal change. Keep it
`null` while Tuval has no product command for deleting a live session from the canvas. Likewise,
keep `nodesConnectable={false}` until creating a relationship is a real domain operation; visual
handles still provide edge geometry without inventing a client-only relationship.

## Custom nodes and edges

Declare `nodeTypes` and `edgeTypes` once at module scope. React Flow's development hook compares
each registered component by identity and emits warning `002` when it changes. An object literal
created during every render defeats stable registration and can trigger avoidable node work.

Every relationship edge must name real endpoints. If an edge supplies `sourceHandle` or
`targetHandle`, the corresponding custom node renders a `<Handle>` with that exact id and type. The
edge-position source returns `null` and emits error `008` when either handle cannot be resolved. A
node with one unnamed handle of a type may omit the edge handle id; multiple handles require stable,
explicit ids.

Inner buttons, links, and inputs that must not start a node drag carry React Flow's `nodrag` class.
A scrollable region also carries `nowheel` so its wheel input does not zoom the canvas. Add `nopan`
when an inner control does not stop pointer events and would otherwise pan the viewport. These are
React Flow's default interaction-class names; do not replace them with Tuval-only event suppression.

Node cards remain Phoenix UI. They consume role tokens and shared components, and their detail level
is Tuval's `bare`/`meta`/`live`/`full` domain setting. Do not copy React Flow example colors or build
a second card/button system. The package stylesheet is imported once for graph mechanics; Phoenix
styles layer the paint above it.

## Focus and accessibility

The node and edge projections set `ariaLabel` from user-visible session and relationship text. Do
not leave relationship edges on the wrapper's fallback `Edge from <id> to <id>` label. Keep
`nodesFocusable`, `edgesFocusable`, and keyboard accessibility at their defaults: the pinned store
enables node and edge focus, and the wrappers then provide one `tabIndex=0` graph-item target, an
ARIA role, descriptions, Enter/Space selection, Escape clearing, and arrow-key movement for a
selected draggable node. Keep `autoPanOnNodeFocus` enabled so an off-screen focused node is brought
into view.

Do not add `tabIndex` to `SessionNodeCard`'s root: React Flow's wrapper is the graph-item focus
target. Real controls inside the card remain separate native focus targets and carry the interaction
classes above. Keep `disableKeyboardA11y` false so the wrapper descriptions and live movement
announcements remain wired through `A11yDescriptions`.

Because Tuval sets `deleteKeyCode={null}`, provide a stable Turkish `ariaLabelConfig` that removes
the default node and edge instructions to press Delete. Override both node-description variants,
the edge description, the movement announcement, and the visible control labels so assistive copy
matches the enabled commands; do not disable keyboard support to hide a stale instruction.

## Provider and viewport

`ReactFlow` supplies its own store when no provider exists. Add an explicit `ReactFlowProvider` only
when a sibling outside `<ReactFlow>` needs `useReactFlow`, `useViewport`, or another store hook, and
put the provider above both the canvas and that sibling. A hook cannot create its own provider, and
the upstream hooks throw outside a provider. Keep one provider for Tuval's one canvas; remounting it
creates a new store.

Leave the `viewport` prop uncontrolled for the founder-ruled free-pan canvas. The `fitView` prop is
an initial fit: the provider describes it as fitting initially supplied nodes and the store clears
its queued fit after nodes initialize. Later `fitView()` calls belong to explicit reveal/reset user
actions, not to every session or SSE update. If a future feature truly persists viewport state, it
must pass both `viewport` and `onViewportChange`, following the upstream controlled-viewport pair;
never pass a viewport without relaying user pan/zoom changes back.

The canvas parent must have non-zero dimensions: React Flow's root wrapper is `width: 100%` and
`height: 100%`. Render `Background` and `Controls` as children so they read the same internal
transform; `Background` derives its scale and offset directly from that transform.

## Test contracts

Test the adapter as pure functions before rendering: stable ids, accessible labels, relationship
handle ids, and domain reconciliation must be deterministic, and a live update must preserve an
existing node's position, dimensions, selection, and drag state.

Rendered component tests mount the real `ReactFlow` in a non-zero-size container. Assert the custom
node and relationship edge render, each has its projected accessible name, the node and edge
wrappers are keyboard-focusable without a second focusable custom-node root, the relationship uses
existing source/target handles, and inner controls carry the required interaction classes. Treat a
missing edge or React Flow handle-resolution error as a failure, not as a screenshot difference.

Playwright covers the browser-owned interaction contract: Tab reaches named nodes and edges;
Enter/Space and Escape select and clear them; arrow keys move a selected draggable node; pointer
drag moves a node; pane drag and wheel/controls change pan and zoom; and valid handle ids keep the
relationship edge rendered. After moving a node and the viewport, inject a live session update and
assert both the node transform and viewport transform remain unchanged while the node's live content
updates. This is the integration proof that `fitView` stayed initial and reconciliation did not
steal the user's position.

## Prospective scope

This pattern begins with child
[#7165](https://github.com/kamp-us/phoenix/issues/7165#issuecomment-5449854114). There is no current
React Flow call site in phoenix. It governs Tuval's graph canvas and its adapter tests, not ordinary
lists, the slide-in Composer chat pane, or `apps/web` screens that have no graph interaction.

## Binding decision

ADR [0335](../.decisions/0335-tuval-canvas-uses-react-flow.md) and the founder's
[binding ruling](https://github.com/kamp-us/phoenix/issues/7140#issuecomment-5449853931) require
actual `@xyflow/react`, not a custom canvas with similar styling. This document records the source-
grounded implementation shape only; the decision record owns the why.

## Grounding

All dependency links below are pinned to the recorded commit:

- [`ReactFlow`](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/react/src/container/ReactFlow/index.tsx)
  accepts controlled nodes/edges, change callbacks, type registries, viewport callbacks, and the
  interaction props used here.
- [`applyNodeChanges` / `applyEdgeChanges`](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/react/src/utils/changes.ts)
  and the [controlled-flow Cypress test](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/examples/react/cypress/components/reactflow/on-nodes-change.cy.tsx)
  define the change-relay contract.
- The [mixed controlled/uncontrolled example](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/examples/react/src/examples/ControlledUncontrolled/index.tsx)
  explicitly rejects using both modes, while the [controlled viewport example](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/examples/react/src/examples/ControlledViewport/index.tsx)
  pairs `viewport` with `onViewportChange`.
- The [type-registry warning](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/react/src/container/GraphView/useNodeOrEdgeTypesWarning.ts),
  [provider](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/react/src/components/ReactFlowProvider/index.tsx),
  [custom-node example](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/examples/react/src/examples/CustomNode/ColorSelectorNode.tsx),
  and [edge-position resolver](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/system/src/utils/edges/positions.ts)
  ground the registration, provider, handle, and fit/viewport boundaries.
- [`NodeWrapper`](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/react/src/components/NodeWrapper/index.tsx),
  [`EdgeWrapper`](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/react/src/components/EdgeWrapper/index.tsx),
  [`A11yDescriptions`](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/react/src/components/A11yDescriptions/index.tsx),
  the public [component props](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/react/src/types/component-props.ts),
  [node](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/react/src/types/nodes.ts)
  and [edge](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/react/src/types/edges.ts)
  types, the pinned [store defaults](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/react/src/store/initialState.ts),
  and [ARIA defaults](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/system/src/constants.ts)
  define focus, labels, keyboard behavior, live descriptions, and interaction classes.
- The upstream [basic-props](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/examples/react/cypress/components/reactflow/basic-props.cy.tsx),
  [view-props](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/examples/react/cypress/components/reactflow/view-props.cy.tsx),
  and [interaction](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/examples/react/cypress/e2e/interaction.cy.ts)
  Cypress tests exercise rendered custom nodes/edges, dragging, panning, zooming, and fitting.
- The package [README](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/react/README.md)
  supplies the controlled quickstart, stylesheet import, and supported pan/zoom/custom-node scope.

## Why it is not obvious

A canvas can appear correct while carrying three delayed failures: live domain updates reset user
positions, recreated type registries churn custom nodes, and edges silently disappear because their
handle ids do not exist. A fully controlled viewport can also overwrite free pan on each data
refresh. The ownership and callback rules above prevent those failures without turning React Flow's
internal store into Tuval's product-data store.

> Source checkout evidence: https://github.com/xyflow/xyflow at `b1b99e9773040e25bd6099762491ab23d8ea6910`; package `@xyflow/react@12.11.5`; inspected `packages/react/src/additional-components/Background/Background.tsx`, `examples/svelte/src/routes/tests/generic/[topic]/[example]/+page.svelte`, and `packages/react/README.md`.
