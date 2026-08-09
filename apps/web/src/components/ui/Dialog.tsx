import "./Dialog.css";

/**
 * @component Dialog
 * @whenToUse The Manti-backed modal surface for confirmations, forms and focused
 *   overlay tasks. Supply `title` for its accessible name and use the footer
 *   render prop when actions need the provided `close` callback.
 * @slot trigger Optional element that opens the dialog.
 * @slot children The dialog body.
 * @slot footer Optional action row, accepting Manti's dialog render props.
 */
export type {DialogProps, DialogSize} from "@manti-ui/react";
export {Dialog} from "@manti-ui/react";
