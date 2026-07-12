/**
 * The declared boolean feature-flag registry (admin-console epic #2711, #2741) — every
 * boolean dark-ship flag the admin flag-state view lists, paired with its declared default.
 * The single in-worker source of "which flags exist + their default", read by the
 * `flags.state` view resolver to enumerate the console's flag list.
 *
 * Keys come from the shared `src/flags/keys.ts` register (the one home the gate and the
 * Flagship IaC declaration both name), so this list can never name a string neither half
 * knows. All current flags are default-OFF dark-ship booleans (ADR 0083) — `defaultValue:
 * false`; a future non-default-off flag adds its own row. The non-boolean demo/targeting flag
 * (`phoenix-flags-targeting-demo`) is deliberately absent — the runtime-override surface is
 * the boolean dark-ship primitive (mirroring `DEV_OVERRIDABLE_FLAGS`), not typed variations.
 */
import {
	MECMUA_FEED,
	MECMUA_PUBLIC_READ,
	MECMUA_WRITE,
	PANO_BASE_FEED,
	PANO_DRAFT_SAVE,
	PANO_FEED_EDGE_CACHE,
	PANO_OPTIMISTIC_COMMENT_ADD,
	PANO_OPTIMISTIC_COMMENT_DELETE,
	PANO_OPTIMISTIC_POST_DELETE,
	PANO_OPTIMISTIC_SUBMIT,
	PHOENIX_ADMIN_CONSOLE,
	PHOENIX_AUTHORSHIP_LOOP,
	PHOENIX_BILDIRIM,
	PHOENIX_EMAIL_DELIVERY_ADMIN,
	PHOENIX_FUNNEL_READOUT,
	PHOENIX_KARMA_GATES,
	PHOENIX_MOD_QUEUE,
	PHOENIX_NAV_IA,
	PHOENIX_OPTIMISTIC_DEFINITION_ADD,
	PHOENIX_OPTIMISTIC_DEFINITION_DELETE,
	PHOENIX_OPTIMISTIC_EDITS,
	PHOENIX_REACTIONS,
	PHOENIX_USER_BAN,
} from "../../../src/flags/keys.ts";

/** One declared boolean flag: its key and the default the safe-path evaluation falls back to. */
export interface DeclaredFlag {
	readonly key: string;
	readonly defaultValue: boolean;
}

// Every boolean dark-ship flag defaults OFF (ADR 0083), so the list is the key set at
// `defaultValue: false`; a flag that ever ships default-on adds an explicit `true` row.
const declared = (key: string): DeclaredFlag => ({key, defaultValue: false});

export const DECLARED_FLAGS: ReadonlyArray<DeclaredFlag> = [
	declared(PANO_DRAFT_SAVE),
	declared(PANO_FEED_EDGE_CACHE),
	declared(PANO_OPTIMISTIC_SUBMIT),
	declared(PANO_OPTIMISTIC_COMMENT_ADD),
	declared(PANO_OPTIMISTIC_COMMENT_DELETE),
	declared(PANO_OPTIMISTIC_POST_DELETE),
	declared(PANO_BASE_FEED),
	declared(MECMUA_WRITE),
	declared(MECMUA_PUBLIC_READ),
	declared(MECMUA_FEED),
	declared(PHOENIX_AUTHORSHIP_LOOP),
	declared(PHOENIX_BILDIRIM),
	declared(PHOENIX_FUNNEL_READOUT),
	declared(PHOENIX_MOD_QUEUE),
	declared(PHOENIX_OPTIMISTIC_EDITS),
	declared(PHOENIX_OPTIMISTIC_DEFINITION_ADD),
	declared(PHOENIX_OPTIMISTIC_DEFINITION_DELETE),
	declared(PHOENIX_REACTIONS),
	declared(PHOENIX_KARMA_GATES),
	declared(PHOENIX_USER_BAN),
	declared(PHOENIX_EMAIL_DELIVERY_ADMIN),
	declared(PHOENIX_NAV_IA),
	declared(PHOENIX_ADMIN_CONSOLE),
];
