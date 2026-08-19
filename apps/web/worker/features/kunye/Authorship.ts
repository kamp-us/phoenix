/**
 * The earned-ladder capability-per-right instances (ADR 0107 §2-3). Each is one
 * `Capability.Level` class whose tag IS the right, floored against the account-level
 * standing {@link Kunye} reads. Definitions only — wiring them into the sözlük create
 * paths happens elsewhere.
 */
import {Capability, type Principal} from "@kampus/authz";
import {Effect} from "effect";
import {RequiresLevel} from "./errors.ts";
import {authorshipLadder, Kunye} from "./Kunye.ts";

const standingOf = (principal: Principal) =>
	Effect.flatMap(Kunye, (kunye) => kunye.tierOf(principal.id));

export class OpenTerm extends Capability.Level<OpenTerm>()("kunye/OpenTerm", {
	scale: authorshipLadder,
	min: "yazar",
	read: standingOf,
	deny: () => new RequiresLevel({message: "Başlık açmak için yazar olmalısın.", need: "yazar"}),
}) {}

export class AddEntry extends Capability.Level<AddEntry>()("kunye/AddEntry", {
	scale: authorshipLadder,
	min: "çaylak",
	read: standingOf,
	deny: () => new RequiresLevel({message: "Entry girmek için çaylak olmalısın.", need: "çaylak"}),
}) {}
