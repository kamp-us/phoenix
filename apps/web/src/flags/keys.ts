/**
 * Flag-key constants shared by both halves of the codec — the client (`FlagGate` /
 * `useFlag`) and the server (the IaC declaration in
 * `worker/features/flagship/resources.ts` + the
 * mutation gate). A plain-string module (no alchemy/React import) so it is safe in
 * the worker bundle AND the SPA bundle, mirroring `src/lib/fateWireCodes.ts`.
 * One home per key means the gate and the declaration can never name different
 * strings.
 */

/** Pano taslak (draft-save) dark-ship flag (#746). */
export const PANO_DRAFT_SAVE = "pano-draft-save";

/**
 * Earned-authorship loop (çaylak→yazar) dark-ship flag (#1204, epic #1202). The
 * single seam every authorship-loop surface gates behind: cross-cutting
 * (`phoenix`) because the loop touches sözlük/pano/pasaport, default-off so the
 * loop ships dark until a human flips it at release (ADR 0083).
 */
export const PHOENIX_AUTHORSHIP_LOOP = "phoenix-authorship-loop";

/**
 * Conversion-funnel readout dark-ship flag (#1589). The founder/mod aggregate
 * tier-count surface (`/funnel` + the `funnel.summary` read) gates behind this key;
 * default-off so the readout reaches production dark until a human flips it at
 * release (ADR 0083). Its OWN key, not the `phoenix-authorship-loop` seam — the
 * funnel is a separate mod-only destination with its own lifecycle.
 */
export const PHOENIX_FUNNEL_READOUT = "phoenix-funnel-readout";
