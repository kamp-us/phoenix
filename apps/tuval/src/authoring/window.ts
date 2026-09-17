/**
 * The window half of the authoring API — what `@kampus/tuval/window` resolves to (#8943).
 *
 * It is its own door rather than a section of `./index.ts` because the two halves have different
 * closures and only one of them is browser-safe. The kernel-side barrel reaches
 * `../process/Processes.ts` and `../commands/core/process.ts`, both `node:crypto` importers, so a
 * page that imported it for `windowRenderer` would pull the kernel in behind it. This door's own
 * closure reaches no `node:` module at all, and `window-closure.unit.test.ts` walks it at every run
 * so the day an import here changes that, a test says so rather than a browser does.
 *
 * What an author writes against it: `window` on the authored record is an `AuthoredWindow` —
 * `{state, send}` in, a `WindowView` out — and a `kind: module` window module is a
 * `windowRenderer` over a `WindowHost`. `compileWindow`, `withSelfReport`, `selfReportPorts` and
 * `authoredWindowRenderers` are how the kernel builds a row from that and stay relative-only, the
 * same line `./index.ts` draws.
 *
 * #8946 is a different chain and is not what this door opens or closes: it reports a window module
 * importing its *own program's* file, which reaches the kernel through `./define-program.ts`.
 * Nothing here makes that import safe, and nothing here depends on it.
 */

export type {
	AnyWindowRenderer,
	ViewState,
	WindowHost,
	WindowRenderer,
} from "../shell/window/index.ts";
export {windowRenderer} from "../shell/window/index.ts";
export type {
	AuthoredWindow,
	AuthoredWindowRenderer,
	DerivedLine,
	ProgramEvent,
	WindowView,
} from "./view.ts";
