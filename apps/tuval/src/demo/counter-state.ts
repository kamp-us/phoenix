/**
 * A counter's state and the predicate over it, in a file that imports nothing.
 *
 * **That emptiness is the whole point, and it is the law an author follows (#8946).** A window is a
 * browser module and a program is compiled by Node, so a window that imports its program's file to
 * borrow the state type pulls the program's whole runtime graph into the page behind it — and an
 * authored program's graph reaches `node:crypto` through the SDK's `authoring/define-program.ts`, which
 * Vite externalises and which throws on the first property read. A leaf like this one is the way
 * across: both halves import it, and neither imports the other.
 *
 * The other way across is `import type`, which a bundler erases before it can follow anything. Use
 * that for a type; use a file like this for a value a window needs at runtime — a predicate, a view
 * function, an event constructor.
 *
 * Two programs read it: `./counter.ts`, the hand-written demo row, and `./module-counter.ts`, the
 * authored one whose window is `./module-window.tsx`.
 */

export type CounterState = {readonly count: number};

/**
 * Is this a counter's state? The admission test a window renderer is seated behind
 * (`.patterns/window-renderer-admission.md`): a program owns the predicate over its own state, so a
 * wire that carries something else is refused in the window rather than rendered over (#8157).
 */
export const isCounterState = (value: unknown): value is CounterState =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as {readonly count?: unknown}).count === "number" &&
	Number.isFinite((value as {readonly count: number}).count);
