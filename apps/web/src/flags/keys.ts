/**
 * Flag-key constants shared by both halves of the codec — the client (`FlagGate` /
 * `useFlag`) and the server (the IaC declaration in `worker/db/resources.ts` + the
 * mutation gate). A plain-string module (no alchemy/React import) so it is safe in
 * the worker bundle AND the SPA bundle, mirroring `src/lib/fateWireCodes.ts`.
 * One home per key means the gate and the declaration can never name different
 * strings.
 */

/** Pano taslak (draft-save) dark-ship flag (#746). */
export const PANO_DRAFT_SAVE = "pano-draft-save";
