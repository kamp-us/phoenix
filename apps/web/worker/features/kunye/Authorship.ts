/**
 * `Authorship` — the earned-ladder capability-per-right instances (ADR 0107
 * §2-3): `OpenTerm` (floor `yazar`) and `AddEntry` (floor `çaylak`). Each is a
 * single `Capability.Level` class — the tag IS the right, yielding the proof
 * tag, its `Grant` type, `.require`, and `.provide` from one name — that floors
 * the GLOBAL account-level standing read from {@link Kunye} against the
 * {@link authorshipLadder} and denies with {@link RequiresLevel} (`FORBIDDEN`).
 *
 * #1203 wires these into the sözlük term/entry create paths; this module is the
 * capability definitions only.
 */
import {Capability, type Principal} from "@kampus/authz";
import {Effect} from "effect";
import {RequiresLevel} from "./errors.ts";
import {authorshipLadder, Kunye} from "./Kunye.ts";

/** Read a principal's global account-level rank off the {@link Kunye} standing service. */
const standingOf = (principal: Principal) =>
	Effect.flatMap(Kunye, (kunye) => kunye.tierOf(principal.id));

/** Open a new sözlük başlık — requires `yazar` earned standing. */
export class OpenTerm extends Capability.Level<OpenTerm>()("kunye/OpenTerm", {
	scale: authorshipLadder,
	min: "yazar",
	read: standingOf,
	deny: () => new RequiresLevel({message: "Başlık açmak için yazar olmalısın.", need: "yazar"}),
}) {}

/** Add an entry under a başlık — requires `çaylak`+ earned standing. */
export class AddEntry extends Capability.Level<AddEntry>()("kunye/AddEntry", {
	scale: authorshipLadder,
	min: "çaylak",
	read: standingOf,
	deny: () => new RequiresLevel({message: "Entry girmek için çaylak olmalısın.", need: "çaylak"}),
}) {}
