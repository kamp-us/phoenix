/**
 * The cohort week entity (#7031) is delivered inline by the two gated list resolvers and
 * never read by id, so it is a capability-less `syntheticSource` — registered for
 * source-completeness validation, with any capability call failing loudly. See the escape
 * hatch in `.patterns/fate-effect-sources.md`. The `FunnelCohorts` singleton stays off the
 * source path entirely (it rides a custom-resolver query root, like `FunnelSummary`).
 */
import {Fate} from "@kampus/fate-effect";
import {FunnelCohortWeekView} from "./views.ts";

export const funnelCohortWeekSource = Fate.syntheticSource(FunnelCohortWeekView);
