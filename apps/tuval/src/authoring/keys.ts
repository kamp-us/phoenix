/**
 * The keyboard opt-in: a `key` cell in an authored `update` table is the whole declaration (#8716
 * R18.1). A program whose `update` has one receives keystrokes when its window is focused and the
 * prefix is unarmed; one without does not.
 *
 * Nothing downstream changes. The compiler sets the row's existing `takesKeys` from the cell's
 * presence, so `takesForwardedKeys` (`../registry/program.ts`), the shell's `window.bind` and the
 * `forwardKey` path keep reading the row they always read. What the two-fact shape allowed — a row
 * declaring `takesKeys: true` with no cell for a key, or a cell no key ever reaches — is what a
 * single fact removes: the invariant #7973 protects cannot drift when the flag *is* the handler.
 *
 * **`key` is the keyboard's name and a port may not take it.** The cell's event is the forwarded
 * keystroke, not a port arrival, so a program declaring an in-port called `key` would be claiming
 * one name for two arrivals; the keyboard wins the cell's type here and #8771 tracks refusing the
 * collision outright.
 */

import type {AnyAuthoredProgram} from "./define-program.ts";

/** The cell's name in an authored `update`, and the type tag the forwarded keystroke carries. */
export const KEY_EVENT = "key";

/**
 * A forwarded keystroke as the author's `key` cell sees it — the shape the shell already dispatches
 * (`../shell/host/effects.ts`), named here so the cell's event is a stated type rather than
 * `unknown`. `key` is the pressed key as the terminal reported it.
 *
 * **A type alias, and it may not become an `interface` (#9543).** A module window types its
 * `WindowHost` dispatch at its program's `ProgramEvent` union (`./view.ts`), and that parameter is
 * constrained to the kernel's `Message` (`../process/process.ts`), which carries an index
 * signature. TypeScript gives a type alias of an object literal the implicit index signature that
 * satisfies it and never gives an interface one, so a `key` cell declared as an interface makes the
 * keyboard opt-in and a typed window dispatch mutually exclusive — with an error naming `Message`,
 * which the author never wrote. `ArrivalEvent` and `RequestArrivalEvent` (`./define-program.ts`)
 * are aliases for the same reason.
 */
export type KeyEvent = {
	readonly type: typeof KEY_EVENT;
	readonly key: string;
};

/**
 * The row's `takesKeys`, read off the `update` table. `undefined` leaves the field off the row —
 * the registry types it `true`-or-absent, and an absent field is how a program that never asked for
 * keys is never sent one.
 */
export const compileTakesKeys = (authored: AnyAuthoredProgram): true | undefined =>
	typeof authored.update?.[KEY_EVENT] === "function" ? true : undefined;
