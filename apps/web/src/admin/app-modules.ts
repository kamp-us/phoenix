import {lazy} from "react";
import {consoleRegistry} from "./module-registry.ts";

consoleRegistry.register({
	id: "bayraklar",
	label: "özellik bayrakları",
	panel: lazy(() => import("./flags/FlagsPanel.tsx")),
});

consoleRegistry.register({
	id: "e-posta-teslimati",
	label: "e-posta teslimatı",
	panel: lazy(() => import("./email-delivery/EmailDeliveryPanel.tsx")),
});

consoleRegistry.register({
	id: "kullanicilar",
	label: "kullanıcılar",
	panel: lazy(() => import("./kullanicilar/KullanicilarPanel.tsx")),
});

export {consoleRegistry};
