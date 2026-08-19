/**
 * `UserAdmin` is delivered INLINE by the `userAdmin.list` resolver and never read by id (a
 * private, `requireAdmin`-gated surface), so it is a capability-less `Fate.syntheticSource`.
 * See `.patterns/fate-effect-sources.md`.
 */
import {Fate} from "@kampus/fate-effect";
import {UserAdminView} from "./views.ts";

export const userAdminSource = Fate.syntheticSource(UserAdminView);
