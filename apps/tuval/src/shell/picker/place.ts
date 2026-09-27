/**
 * Where a session a picker entry opens will run (#9694, rulings #9668 R3.1 and R6.3): the home
 * folder when no project is open, or one open project's folder. It rides the entry, the intent, the
 * shell Msg and the Cmd as plain data, and the kernel turns it into a folder
 * (`./open.ts`), so the page never names a path.
 *
 * A project is named by the key its ids are scoped by (`../../project-id.ts`), not by its folder:
 * the key is what the page already holds, and a key that no longer names an open project is refused
 * rather than guessed at. The label rides beside it only for what a person reads.
 */

export type SessionPlace =
	| {readonly _tag: "Home"}
	| {readonly _tag: "Project"; readonly key: string; readonly label: string};

export const HOME_PLACE: SessionPlace = {_tag: "Home"};

/** What the place is called on an entry and on its group: the project's label, or `home`. */
export const placeName = (place: SessionPlace): string =>
	place._tag === "Home" ? "home" : place.label;
