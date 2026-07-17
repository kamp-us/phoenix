import type * as React from "react";
import {Button} from "../../../components/ui/Button";
import {Dialog} from "../../../components/ui/Dialog";
import {defineExhibit} from "../exhibit";

function DialogDemo({showClose, defaultOpen}: {showClose?: boolean; defaultOpen?: boolean}) {
	return (
		<Dialog.Root defaultOpen={defaultOpen}>
			<Dialog.Trigger render={<Button variant="secondary">İletişim kutusunu aç</Button>} />
			<Dialog.Popup>
				<Dialog.Head
					title="Başlık"
					description="Kutunun kısa açıklama metni."
					showClose={showClose}
				/>
				<Dialog.Body>
					<p style={{margin: 0}}>Gövde içeriği burada yer alır.</p>
				</Dialog.Body>
				<Dialog.Foot>
					<Dialog.Close render={<Button variant="tertiary">Vazgeç</Button>} />
					<Dialog.Close render={<Button variant="primary">Onayla</Button>} />
				</Dialog.Foot>
			</Dialog.Popup>
		</Dialog.Root>
	);
}

export const dialogExhibit = defineExhibit<React.ComponentProps<typeof DialogDemo>>({
	id: "dialog",
	title: "Dialog",
	summary: "Modal dialog with a title, body, and actions — built on base-ui Dialog.",
	component: DialogDemo,
	knobs: {
		defaultOpen: {kind: "boolean", label: "Start open", default: false},
		showClose: {kind: "boolean", label: "Close button", default: true},
	},
});
