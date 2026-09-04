import * as React from "react";
import {useNavigate} from "react-router";
import {type Translate, useT} from "../../i18n";
import {slugifyTerm} from "../../lib/slugifyTerm";
import {Button} from "../ui/Button";
import {Dialog} from "../ui/Dialog";
import {Form, Input} from "../ui/Form";
import {useSozlukCreateDialog} from "./SozlukCreateDialogState";

// sözlük's create CTA — never a second search surface; the "go to a term" search folded
// into the global ⌘K `ara` (#2995). The dialog exists because the composer is
// slug-addressed: submit slugifies the typed term and routes to `/sozluk/:slug`.
export function SozlukSubnavCta() {
	// `open` is hoisted above the unmounting boundary — see `SozlukCreateDialogState` (#3840).
	// A component-local `useState` here is the exact fragility that vanished the dialog.
	const {open, setOpen} = useSozlukCreateDialog();
	const t = useT();
	const navigate = useNavigate();
	const [term, setTerm] = React.useState("");
	const [termError, setTermError] = React.useState<string | null>(null);
	function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const validationError = validateTerm(t, term);
		if (validationError) {
			setTermError(validationError);
			return;
		}
		const slug = slugifyTerm(term);
		if (!slug) return;
		setOpen(false);
		setTerm("");
		setTermError(null);
		navigate(`/sozluk/${slug}`);
	}
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setTermError(null);
			}}
			trigger={
				<Button variant="primary" icon={<PlusGlyph />}>
					{t("sozluk.cta.newEntry")}
				</Button>
			}
			title={t("sozluk.createDialog.title")}
			description={t("sozluk.createDialog.description")}
		>
			<Form onSubmit={onSubmit}>
				<Input
					name="term"
					label={t("sozluk.createDialog.termLabel")}
					className="kp-field--semantic-required"
					value={term}
					onChange={(event) => {
						setTerm(event.currentTarget.value);
						setTermError(null);
					}}
					error={termError}
					required
					autoFocus
					fullWidth
					placeholder={t("sozluk.createDialog.termPlaceholder")}
				/>
				<div className="kp-dialog-actions">
					<Button variant="tertiary" type="button" onClick={() => setOpen(false)}>
						{t("sozluk.createDialog.cancel")}
					</Button>
					<Button variant="primary" type="submit">
						{t("sozluk.createDialog.submit")}
					</Button>
				</div>
			</Form>
		</Dialog>
	);
}

// A punctuation-only term (e.g. "!!!") is a non-empty value `required` accepts but that
// `slugifyTerm` reduces to "" — the composer is slug-addressed, so it has nowhere to go.
// Empty is left to `required`; only the non-empty-but-unslugifiable term errors here, replacing
// the silent no-op the bare `if (!slug) return` guard left behind (#3789).
function validateTerm(t: Translate, value: unknown): string | null {
	const term = String(value ?? "");
	if (!term.trim()) return null;
	return slugifyTerm(term) ? null : t("sozluk.createDialog.termUnslugifiable");
}

function PlusGlyph() {
	return (
		<svg
			width="11"
			height="11"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.4"
			aria-hidden="true"
		>
			<path d="M12 5v14M5 12h14" />
		</svg>
	);
}
