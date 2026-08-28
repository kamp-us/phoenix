---
id: 0335
title: Tuval's canvas uses React Flow
status: accepted
date: 2026-08-28
tags: [tuval, frontend, react-flow]
---

# 0335 — Tuval's canvas uses React Flow

**What this decides:** Tuval builds its free-pan session canvas on `@xyflow/react`, not on a custom canvas that imitates React Flow.

## Context

Tuval presents Pi sessions as a spatial canvas. The product decision in epic
[#7140](https://github.com/kamp-us/phoenix/issues/7140#issuecomment-5449853931) requires a free-pan
canvas implemented with actual React Flow. The follow-on child
[#7165](https://github.com/kamp-us/phoenix/issues/7165#issuecomment-5449854114) binds that choice to
the React 19 migration before the Composer chat pane extends the frontend. This is a founder-owned
product-shape decision under ADR [0078](0078-product-driven-decisions-by-default.md); the library
serves the ruled interaction rather than choosing it.

The first canvas scaffold proved the screen composition with static DOM and CSS, but keeping that
implementation as the interaction engine would make each later child invent panning, zooming,
selection, dragging, connection geometry, and viewport state separately. The authoritative
`@xyflow/react@12.11.5` source exposes those responsibilities on `ReactFlow` while accepting
controlled `nodes`, `edges`, change handlers, node types, and viewport callbacks
([source](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/react/src/container/ReactFlow/index.tsx)); its
package documentation names panning, zooming, graph selection, custom nodes, handles, and controlled
node/edge state as the supported shape
([documentation](https://github.com/xyflow/xyflow/blob/b1b99e9773040e25bd6099762491ab23d8ea6910/packages/react/README.md)).

## Decision

**Tuval's root canvas uses React Flow through `@xyflow/react`; a custom canvas is not an equivalent implementation.**

React 19 owns Tuval's component tree. React Flow owns graph interaction and viewport mechanics.
Tuval's domain state remains authoritative for sessions, relationships, node detail, and prompt
state, and maps that state into React Flow nodes and edges. The exact controlled-state, custom-node,
handle, and viewport shape lives in `.patterns/react-flow-canvas.md`, not in this decision record.

**Binding constraints.**

- The root session canvas renders through `ReactFlow` from `@xyflow/react`.
- The Tuval frontend migrates to React 19 before later UI children extend the canvas.
- Session and relationship truth stays in Tuval domain state; React Flow is not a second product-data store.
- React Flow's viewport and interaction state must preserve the founder-ruled free-pan canvas.
- Tuval's custom node paint uses Phoenix design tokens and shared components; adopting React Flow does not create a second design system.
- A hand-built DOM, SVG, or canvas interaction engine that merely resembles React Flow is banned.

## Consequences

Tuval gains the library's tested pan, zoom, selection, dragging, connection, and viewport behavior
instead of maintaining those mechanics itself. The cost is a pinned frontend dependency and an
explicit mapping between Tuval domain objects and React Flow's node and edge contracts. The mapping
must avoid feedback loops between incoming domain updates and user-driven position or viewport
changes; the pattern records that boundary against the pinned dependency source.

## Records

no vocabulary impact
