import type * as React from "react";
import {Button} from "../../../components/ui/Button";
import {Dialog} from "../../../components/ui/Dialog";
import {defineExhibit} from "../exhibit";

function DialogDemo({showClose, defaultOpen}: {showClose?: boolean; defaultOpen?: boolean}) {
	return (
		<Dialog
			defaultOpen={defaultOpen}
			showCloseButton={showClose}
			trigger={<Button variant="secondary">İletişim kutusunu aç</Button>}
			title="Başlık"
			description="Kutunun kısa açıklama metni."
			footer={({close}) => (
				<>
					<Button variant="tertiary" onClick={close}>
						Vazgeç
					</Button>
					<Button variant="primary" onClick={close}>
						Onayla
					</Button>
				</>
			)}
		>
			<p style={{margin: 0}}>Gövde içeriği burada yer alır.</p>
		</Dialog>
	);
}

export const dialogExhibit = defineExhibit<React.ComponentProps<typeof DialogDemo>>({
	id: "dialog",
	title: "Dialog",
	summary: "Manti Dialog ile başlık, gövde ve render-prop eylemleri.",
	component: DialogDemo,
	knobs: {
		defaultOpen: {kind: "boolean", label: "Start open", default: false},
		showClose: {kind: "boolean", label: "Close button", default: true},
	},
});
