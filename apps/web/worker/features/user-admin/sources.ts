/**
 * user-admin fate source — `UserAdmin` is delivered INLINE by the `userAdmin.list`
 * resolver and never read by id (a private, `requireAdmin`-gated admin surface), so it is a
 * capability-less `Fate.syntheticSource` (view-reachable, no fetch path). Mirrors divan's
 * `DivanCaylak` source. See `.patterns/fate-effect-sources.md`.
 */
import {Fate} from "@kampus/fate-effect";
import {UserAdminView} from "./views.ts";

export const userAdminSource = Fate.syntheticSource(UserAdminView);
