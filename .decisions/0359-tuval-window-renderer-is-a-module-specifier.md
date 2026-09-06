---
id: 0359
title: A Tuval program's window renderer may be a module specifier the page loads, keyed by the row's own ref
status: accepted
date: 2026-09-06
tags: [tuval, shell, window, renderer, config, extensibility]
---

# 0359 — A Tuval program's window renderer may be a module specifier the page loads, keyed by the row's own ref

**What this decides:** a program row may declare `renderer: {kind: "module", ref: "<specifier>"}`,
where `ref` is a module specifier and the module's `default` export is the renderer. The page loads
every such module at boot and seats it in its renderer table under the same `ref`, so a program
installed with `pnpm add` and registered in one `tuval.config.ts` row is whole — kernel half and
window half — with no edit to the app. A specifier that does not resolve refuses the page at boot;
a module that loads into something that is not a renderer is a placeholder in the window, as a
value, never a throw.

## Context

A row (`apps/tuval/src/registry/program.ts`) names its window renderer by `RendererRef = {kind, ref}`,
and the page answers the name from a table compiled into it (`src/page/renderers.tsx`, resolved by
`resolverFromTable` in `src/shell/window/renderer.ts`). A miss is the value
`{_tag: "RendererUnresolved", reason: "unknown-ref" | "kind-mismatch"}` and renders a placeholder.
That was the right shape for the programs in the box, whose rows and renderers ship together.

It has no answer for a third-party program. The kernel half already works: config rows are opaque
beyond their id (`Schema.Unknown.check(hasStringId)`, `src/config.ts`), so a row from any package
registers and runs. The window half cannot: the page's table is compiled, and the only way to add a
name to it is to edit `renderers.tsx` — which is what the demo of `@csirin/tuval-calc` (csirin/monorepo,
unpublished) had to do to show its window at all. A program whose window needs a patch to the app
is not an installed program.

Two constraints shape the answer. The config module is evaluated by **Node** (`src/config.ts`, from
`src/bin.ts`); the renderer is a React component that cannot cross the kernel→browser wire, and
kernel-side code must never enter the browser bundle (#7836, `src/pi/renderer-ref.ts`). So whatever
the row carries must be a string. And the page is served by **Vite** in dev (`src/page/dev-server.ts`),
which rewrites only the imports it can read statically: a bare specifier handed to `import()` at
runtime in the browser does not resolve.

## Options

**A. A second, browser-side config file** — `~/.tuval/renderers.ts`, a module the page imports that
maps `ref` strings to renderers. Rejected: it splits one program across two files, and the author
writes the ref string twice, once on the row and once in the map, with nothing holding the two
together. The failure of a mismatch is the quiet one — an unresolved reference is a value, so the
window simply comes up on its placeholder.

**B. A new renderer kind, `module`, whose `ref` is the specifier** — chosen. One file, one row, one
string. The row is self-describing: everything a page needs to find the window is on the row the
kernel already sends over the registry frame (`src/shell/transport/wire.ts`, #7788).

## Decision

**1. `kind: "module"` is a `RendererKind`.** Its `ref` is a module specifier resolved from the app
root the way any import there is — a bare package entry, `@csirin/tuval-calc/window`, or a
root-relative path for a module in the tree, `/src/demo/module-window.tsx`. The wire admits the kind
(`isRendererRef`), so a module row crosses to the page like any other windowed row.

**2. The module exports two things.** `default` is the renderer, minted with
`windowRenderer("module", …)` so the resolver's kind check still holds — a `host-native` export
behind a `module` reference is a `kind-mismatch`, not a quiet acceptance. `admits` is the predicate
over the state the renderer reads. The page seats the loaded renderer through `readsState(admits,
default)`, so an external window gets the same admission test every in-tree one has
([0358](0358-window-renderer-admission-and-per-window-boundary.md)); the rule does not bend for a
renderer that arrived by `pnpm add`, and the predicate still belongs to the program whose state it is.

**3. Resolution goes through a generated module, not a runtime `import()` of the string.** Node holds
every row at boot, so `src/bin.ts` collects the module references (`moduleRendererRefs`) and hands
them to `servePage`, which registers a Vite plugin serving `virtual:tuval/module-renderers`: one
static `() => import("<ref>")` per reference, keyed by the reference (`moduleRenderersSource`). Vite
then resolves, prebundles and serves each specifier exactly as it does the app's own imports —
including prebundling a package against the page's one React, which is what keeps a module
renderer's hooks working at first paint. `src/page/boot.tsx` imports the virtual module, runs
`loadModuleRenderers` over it, and merges the result over `pageRenderers`; the desk waits for the
table as it waits for the socket, so a module window never resolves against a table its seat has not
reached.

**4. Two failure points, two shapes.** A specifier that does not resolve refuses the page at boot:
`servePage` resolves every reference through Vite's own resolver after binding and fails with
`PageServerFailed` naming the specifier and the root — the graph compiler's stance, refuse before
anything is shown. A module that resolves but does not load, or loads into something that is not the
contract above, is a `RendererLoadFailure` in that reference's seat of the table; `resolverFromTable`
reports it as `RendererUnresolved` with the new reason `module-load-failed` and the load's sentence
as `detail`, and the window's placeholder says it. The desk, every other window and the process keep
running.

**5. Trust model: unchanged.** A module renderer is local code the founder installed and named in a
config module they own. It runs in the page with every capability the page has, exactly as the
in-tree renderers do. Tuval's row already says this of the identity, capability and placement records
— they are "INERT DATA, ENFORCED BY NOTHING … local program code is fully trusted, there is no
sandbox, ever" (#7484 R1.1, the Neovim model) — and this decision extends the same sentence to the
window half. `module` is a resolution strategy, not an isolation tier; the tier a remote process
would need is `isolated-frame`, still reserved.

## Consequences

- The config a third party writes is one row and nothing else:
  ```ts
  calcProgram({packs: [basePack]})  // its row declares renderer: {kind: "module", ref: "@csirin/tuval-calc/window"}
  ```
  with `@csirin/tuval-calc` installed in the app's `node_modules`, and `@csirin/tuval-calc/window`
  exporting `default` and `admits`. `@csirin/tuval-calc` is the demo of this seam, not a test
  dependency of it; the in-tree proof is `apps/tuval/src/demo/module-window.tsx` through the same
  loader and the same served module.
- The renderer table is no longer only compiled code: its type is now `RendererTable`, a renderer or
  a load failure per reference, and `AttachedDesk` reads the failure's sentence into the placeholder.
- The loader module is generated once, at boot, from the rows booted. A reload
  (`Booted.reload`) that adds a module row does not regenerate it: that row's window is
  `unknown-ref` until the next boot. Follow-up, not decided here.
- Only the window renderer is loadable this way. The desk-level `inspector` and `status` references
  (`src/shell/desk/`, #7500) still resolve from compiled tables; the `module-load-failed` sentence exists for them so their reason
  record stays total, but no loader feeds them yet. Follow-up.
- A package authoring a renderer needs the types — `Program`, `WindowHost`, `windowRenderer`,
  `defineSpell` — and `@kampus/tuval` is private with no entry point to import them from
  ([0345](0345-tuval-lives-under-apps.md) keeps Tuval an app, not a package). Whether and how an
  authoring surface is published is a separate decision; today the demo compiles against a copy.
- Brushes [0348](0348-tuval-command-framework-spell-registry-versioned-protocol.md): a module
  program's spells register through the same row, so nothing there moves.
