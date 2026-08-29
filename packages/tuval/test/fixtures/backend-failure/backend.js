import {Effect, Layer} from "effect";
export const makeLayer = () => Layer.effectDiscard(Effect.fail(new Error("fixture layer failed")));
