/**
 * Divan fate sources — both views are delivered INLINE by their `divan.*` list
 * resolver and never read by id (a private moderation/proving-ground surface), so
 * each is a capability-less `Fate.syntheticSource` (view-reachable, no fetch path).
 * Mirrors `report`'s `OpenReport` source. See `.patterns/fate-effect-sources.md`.
 */
import {Fate} from "@kampus/fate-effect";
import {DivanBacklogItemView, DivanCaylakView, DivanVoteReceiptView} from "./views.ts";

export const divanCaylakSource = Fate.syntheticSource(DivanCaylakView);
export const divanBacklogItemSource = Fate.syntheticSource(DivanBacklogItemView);
export const divanVoteReceiptSource = Fate.syntheticSource(DivanVoteReceiptView);
