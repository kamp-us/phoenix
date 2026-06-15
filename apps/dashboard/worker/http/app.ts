/**
 * `AppLive` — the single router layer the worker's `fetch` is compiled from
 * (ADR 0027, `.patterns/worker-http-transport-layout.md`). The scaffold mounts
 * only the typed-JSON `health` group; per-feature raw routes (`features/<f>/route.ts`)
 * are merged in here as the app grows (mirrors apps/web's `makeAppLive`).
 */
import {healthApiLayer} from "./health.ts";

/** Build the application router layer. */
export const makeAppLive = () => healthApiLayer;
