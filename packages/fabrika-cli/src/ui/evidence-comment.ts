/**
 * The line that opens every `ui evidence` comment, and the read that recognises one.
 *
 * Both live here so the composer and every reader of a PR's comments resolve one definition: a
 * comment `ui evidence` posted is the builder's own captures, and a reader that must tell it from a
 * person's screenshots cannot drift from the header the composer writes.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10370
 */

const LEAD = "**UI evidence**";

export const evidenceHeader = (head: string): string => `${LEAD} — rendered at head \`${head}\`.`;

export const isUiEvidence = (body: string): boolean => body.trimStart().startsWith(LEAD);
