import {Effect, Layer} from "effect";

export const makeTuvalBuiltinLayer = () => Layer.effectDiscard(Effect.void);
