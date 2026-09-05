/**
 * `ModelRef` — one model, named the way a picker names one, and the only place under `ports/`
 * where the interface says the word.
 *
 * It rides no port. The five ports are the interface a *second process* drives (`ports.ts`), and
 * the model picker lives in the window, which already reads the whole `AiAgentSessionState` and
 * writes through `dispatch` — so a sixth port would buy nothing and would red the five-ports,
 * eight-keys claim beside it (#7981).
 *
 * `provider` is optional because only some backends have one: Pi names a model by provider and id,
 * Claude by a bare id. `name` is the label a menu renders; `id` plus `provider` is the identity two
 * refs are compared on.
 *
 * This is the one deliberate exception to the model-blind rule `boundary.unit.test.ts` holds over
 * this directory. The founder wants the model chosen from the composer, so the generic interface
 * has to carry a model; every payload a port carries stays blind, and that file skips this source
 * by name rather than widening its ban.
 */

import {Predicate} from "effect";

export interface ModelRef {
	readonly id: string;
	readonly name: string;
	readonly provider?: string;
}

export const isModelRef = (value: unknown): value is ModelRef =>
	Predicate.isObject(value) &&
	typeof value.id === "string" &&
	value.id.length > 0 &&
	typeof value.name === "string" &&
	(value.provider === undefined || typeof value.provider === "string");

/** Two refs name one model when their provider and id agree; the label is not part of identity. */
export const sameModel = (left: ModelRef, right: ModelRef): boolean =>
	left.id === right.id && (left.provider ?? null) === (right.provider ?? null);
