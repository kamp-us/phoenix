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
 * What an author writes against it: a window module's `default` export is a `windowRenderer` over a
 * `WindowHost`, and `ProgramEvent` is how that host's dispatch is typed at the program's own event
 * union. `withSelfReport` and `selfReportPorts` are how the kernel builds a row and stay
 * relative-only, the same line `./index.ts` draws.
 *
 * **This is the only door a window has, as of the ruling on #8946.** A program used to be able to
 * declare its window inline on the authored record; that key is gone, because the page cannot load
 * anything `./define-program.ts` compiled — that file reaches `node:crypto` through the kernel.
 * A window is its own browser module, named on the row by module specifier (ADR 0359), and what it
 * shares with its program comes through an `import type` or a leaf file that imports nothing.
 */

export type {
	AnyWindowRenderer,
	ViewState,
	WindowHost,
	WindowRenderer,
} from "../shell/window/index.ts";
export {windowRenderer} from "../shell/window/index.ts";
export type {DerivedLine, ProgramEvent} from "./view.ts";
