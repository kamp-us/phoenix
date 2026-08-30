import {fauxAssistantMessage, fauxProvider, fauxText, fauxThinking} from "@earendil-works/pi-ai";

export default function productionCodingAgentFixture(pi) {
	const faux = fauxProvider({
		provider: "tuval-faux",
		models: [{id: "daily-driver", reasoning: true}],
	});
	faux.setResponses([
		fauxAssistantMessage([
			fauxThinking("Tuval kara kutu yolculuğu yanıtı hazırlanıyor."),
			fauxText("Üretim kodlama ajanı yanıtı."),
		]),
	]);
	pi.registerProvider(faux.provider);
}
