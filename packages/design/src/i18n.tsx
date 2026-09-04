import {createContext, type ReactNode, useContext} from "react";

export const designTrMessages = {
	"ui.caylakBadge": "çaylak katkısı",
	"ui.caylakBadge.stage": ", hazırlık aşamasında",
	"ui.reviewBadge": "incelemede",
	"ui.edited": "düzenlendi",
	"ui.share.label": "paylaş",
	"ui.share.copied": "kopyalandı",
	"ui.share.error": "kopyalanamadı",
	"ui.report.action": "bildir",
	"ui.report.reported": "bildirildi",
	"ui.report.already": "zaten bildirildi",
	"ui.draftRestore.label": "kaydedilmiş taslak",
	"ui.draftRestore.text": "kaydedilmiş bir taslağın var. geri yüklemek ister misin?",
	"ui.draftRestore.restore": "taslağı geri yükle",
	"ui.draftRestore.dismiss": "yoksay",
	"admin.agent.label": "Agent chat input",
	"admin.agent.scope": "yalnızca yerel atölye",
	"admin.agent.compose.label": "Pi'ye mesaj yaz",
	"admin.agent.compose.placeholder": "Pi'ye ne yapmak istediğini söyle…",
	"admin.agent.completions": "Pi tamamlamaları",
	"admin.agent.attachments": "Görsel ekleri",
	"admin.agent.attachment.remove": "{name} görselini kaldır",
	"admin.agent.image.add": "Görsel ekle",
	"admin.agent.settings": "Pi ayarları",
	"admin.agent.picker.loading": "yükleniyor",
	"admin.agent.setting.model": "model",
	"admin.agent.setting.thinking": "düşünme eforu",
	"admin.agent.select.model": "Pi modeli",
	"admin.agent.select.thinking": "Pi düşünme eforu",
	"admin.agent.select.trust":
		"Pi proje izni. Güven, yerel proje kaynaklarını yükler; yoksay bunları devre dışı bırakır.",
	"admin.agent.select.delivery": "Pi teslim modu",
	"admin.agent.resources": "kaynaklar",
	"admin.agent.resources.label": "Proje kaynakları ve gönderme ayarları",
	"admin.agent.menu.streaming": "çalışırken gönderme",
	"admin.agent.menu.projectResources": "proje kaynakları",
	"admin.agent.trust.load": "kaynakları yükle",
	"admin.agent.trust.skip": "kaynakları yükleme",
	"admin.agent.trust.approve": "güven",
	"admin.agent.trust.ignore": "yoksay",
	"admin.agent.delivery.prompt": "gönder",
	"admin.agent.delivery.steer": "yönlendir",
	"admin.agent.delivery.followUp": "sonraya al",
	"admin.agent.thinking.off": "kapalı",
	"admin.agent.thinking.minimal": "minimal",
	"admin.agent.thinking.low": "düşük",
	"admin.agent.thinking.medium": "orta",
	"admin.agent.thinking.high": "yüksek",
	"admin.agent.thinking.xhigh": "çok yüksek",
	"admin.agent.thinking.max": "maksimum",
	"admin.agent.stop": "durdur",
	"admin.agent.send": "gönder",
	"admin.agent.queue": "kuyruğa al",
	"admin.agent.status.loading": "Pi aranıyor…",
	"admin.agent.status.working": "Pi çalışıyor",
	"admin.agent.status.ready": "Pi hazır",
	"admin.agent.status.readyWithModel": "Pi hazır · {model}",
	"admin.agent.status.unavailable": "Pi yerelde kullanılamıyor",
	"admin.agent.hint.send": "gönder",
	"admin.agent.hint.newline": "satır ekle",
	"admin.agent.hint.command": "komut",
	"admin.agent.hint.file": "dosya",
	"admin.agent.hint.pasteImage": "görseli yapıştır",
	"admin.agent.hint.addOrPasteImage": "görsel ekle veya yapıştır",
	"admin.agent.inspector": "Pi denetçisi",
	"admin.agent.activity.title": "harness etkinliği",
	"admin.agent.activity.empty": "Pi yanıtı ve araç etkinlikleri burada görünür.",
	"admin.agent.activity.started": "Pi çalışmaya başladı.",
	"admin.agent.activity.settled": "Pi turu tamamlandı.",
	"admin.agent.activity.tool": "Pi {tool} kullanıyor.",
	"admin.agent.activity.toolFallback": "araç",
	"admin.agent.activity.steered": "İstem, çalışan tur için yönlendirme olarak kuyruğa alındı.",
	"admin.agent.activity.prompted": "İstem Pi'ye gönderildi.",
	"admin.agent.activity.steerQueued": "Yönlendirme Pi kuyruğuna alındı.",
	"admin.agent.activity.followUpQueued": "Sonraki istem Pi kuyruğuna alındı.",
	"admin.agent.activity.stopped": "Pi durdurma isteğini aldı.",
	"admin.agent.activity.modelChanged": "Pi modeli {model} olarak değiştirildi.",
	"admin.agent.activity.thinkingChanged": "Pi düşünme eforu {level} olarak değiştirildi.",
	"admin.agent.activity.trustLoaded":
		"Pi proje kaynaklarını yükleyecek şekilde yeniden başlatıldı.",
	"admin.agent.activity.trustSkipped":
		"Pi proje kaynaklarını yoksayacak şekilde yeniden başlatıldı.",
	"admin.agent.mock.prompted": "Deploy preview istemi mock harness'a gönderildi.",
	"admin.agent.mock.reply": "Bu, Agent Chat Input görünümünü denemek için üretilen mock yanıttır.",
	"admin.agent.mock.stopped": "Mock tur durduruldu.",
	"admin.agent.mock.modelChanged": "Mock Pi modeli {model} olarak değiştirildi.",
	"admin.agent.mock.thinkingChanged": "Mock düşünme eforu {level} olarak değiştirildi.",
	"admin.agent.mock.trustLoaded": "Mock proje kaynakları yüklendi.",
	"admin.agent.mock.trustSkipped": "Mock proje kaynakları yoksayıldı.",
	"admin.agent.mock.command.review": "Değişiklikleri gözden geçir.",
	"admin.agent.mock.command.compact": "Oturum bağlamını sıkıştır.",
	"admin.agent.imageOnlyPrompt": "Bu görseli incele.",
	"admin.agent.extension.title": "Pi eklentisi",
	"admin.agent.extension.input": "Pi eklentisi yanıtı",
	"admin.agent.extension.editor": "Pi eklentisi metni",
	"admin.agent.extension.cancel": "vazgeç",
	"admin.agent.extension.confirm": "onayla",
	"admin.agent.extension.submit": "gönder",
	"admin.agent.error.connect": "Pi harness'a bağlanılamadı.",
	"admin.agent.error.send": "İstem gönderilemedi.",
	"admin.agent.error.stop": "Pi durdurulamadı.",
	"admin.agent.error.model": "Pi modeli değiştirilemedi.",
	"admin.agent.error.thinking": "Pi düşünme eforu değiştirilemedi.",
	"admin.agent.error.trust": "Pi proje izni değiştirilemedi.",
	"admin.agent.error.imagesOnly": "Pi RPC prototipi yalnızca görsel eklerini kabul ediyor.",
	"admin.agent.error.imageTooLarge": "Görsel 5 MB'dan küçük olmalı.",
	"admin.agent.error.imageRead": "Görsel okunamadı.",
	"admin.agent.error.imageAdd": "Görsel eklenemedi.",
	"admin.agent.error.extension": "Pi eklentisine yanıt verilemedi.",
} as const;

export type DesignCatalogKey = keyof typeof designTrMessages;
export type DesignMessageParams = Readonly<Record<string, string | number>>;
export type DesignTranslate = (key: DesignCatalogKey, params?: DesignMessageParams) => string;

const PLACEHOLDER = /\{(\w+)\}/g;

export const defaultDesignTranslate: DesignTranslate = (key, params) => {
	const message = designTrMessages[key];
	if (!params) return message;
	return message.replace(PLACEHOLDER, (whole, name: string) =>
		Object.hasOwn(params, name) ? String(params[name]) : whole,
	);
};

// Package consumers may inject their catalog without making the package import an app.
// The Turkish fallback preserves standalone renders and the pre-extraction component contract.
const DesignTranslationContext = createContext<DesignTranslate>(defaultDesignTranslate);

export function DesignTranslationProvider({
	translate,
	children,
}: {
	translate: DesignTranslate;
	children: ReactNode;
}) {
	return (
		<DesignTranslationContext.Provider value={translate}>
			{children}
		</DesignTranslationContext.Provider>
	);
}

export function useDesignT(): DesignTranslate {
	return useContext(DesignTranslationContext);
}
