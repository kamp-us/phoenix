/**
 * The shared client code→message lookup (#1421).
 *
 * The copy itself lives in the catalog (`i18n/{tr,en}/wire.ts`), which is where the
 * exhaustiveness guarantee now sits too: `WireCodeKey` is `wire.${FateWireCode}`, so a code
 * with no message is a compile error in both locales rather than a silent generic fallback
 * (#1422). This module is only the key derivation and the override arm — never give
 * `messageForCode` a `default` arm.
 *
 * The active locale arrives as the bound `Translate`, not as a `Locale`: the English catalog
 * is reachable only through `catalog.ts`'s dynamic import (ADR 0347), so nothing outside a
 * `LocaleProvider` subtree can resolve `en` synchronously.
 */

import type {Translate} from "../i18n/LocaleProvider";
import type {WireCodeKey} from "../i18n/tr/wire";
import {FATE_WIRE_CODES, type FateWireCode} from "../lib/fateWireCodes";

export function wireMessageKey(code: FateWireCode): WireCodeKey {
	return `wire.${code}`;
}

/** Per-surface copy that wins over the catalog's base message for the codes it names. */
export type WireMessageOverrides = Partial<Record<FateWireCode, string>>;

export function messageForCode(
	t: Translate,
	code: FateWireCode,
	overrides?: WireMessageOverrides,
): string {
	return overrides?.[code] ?? t(wireMessageKey(code));
}

/** The wire-code vocabulary, re-exported so coverage tests have one import site. */
export {FATE_WIRE_CODES};
