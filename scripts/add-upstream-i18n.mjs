// One-shot script: add git:upstream.* keys (Repository Upstream Profile, PART 3)
// to all locales. Run: node scripts/add-upstream-i18n.mjs
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve('src/locales')
const translations = {
  'en-US': {
    badge: { fork: 'Fork verified', commonHistory: 'Shared history', declared: 'Declared origin', unknown: 'Origin unknown' },
    kicker: 'Upstream profile', title: 'Repository origin',
    detect: 'Detect origin', detecting: 'Detecting…',
    typeLabel: 'Assessment', upstreamLabel: 'Upstream repository', mergeBaseLabel: 'Common ancestor', declaredLabel: 'Declaration', checkedLabel: 'Last check', neverChecked: 'Never checked',
    declareSummary: 'Declare a ZIP re-upload or third-party origin',
    declareDetail: 'Candidates are never auto-bound from names. A declaration is stored with time and evidence; GitHub then verifies whether a fork relation or shared history exists.',
    upstreamRepoLabel: 'Upstream repository (owner/repo)', kindLabel: 'Kind', kindZip: 'ZIP re-upload', kindThird: 'Third-party continuation', versionLabel: 'Original version (optional)',
    declare: 'Save declaration', declaring: 'Saving…',
    evidenceSummary: 'Evidence ({{count}})',
    detectedToast: 'Origin: {{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    declaredToast: 'Declaration saved: {{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    detectFailed: 'Origin detection failed.', declareFailed: 'The declaration could not be saved.', repoRequired: 'Enter the upstream repository as owner/repo.'
  },
  'zh-CN': {
    badge: { fork: 'Fork 已验证', commonHistory: '共同历史', declared: '已申报来源', unknown: '来源未知' },
    kicker: '上游档案', title: '仓库来源',
    detect: '检测来源', detecting: '正在检测…',
    typeLabel: '判定', upstreamLabel: '上游仓库', mergeBaseLabel: '共同祖先', declaredLabel: '申报记录', checkedLabel: '最近检查', neverChecked: '尚未检查',
    declareSummary: '申报 ZIP 重传或第三方来源',
    declareDetail: '系统不会根据仓库名猜测并自动绑定上游。申报会连同时间与证据一起保存；随后 GitHub 会核实是否存在 Fork 关系或共同历史。',
    upstreamRepoLabel: '上游仓库（owner/repo）', kindLabel: '类型', kindZip: 'ZIP 下载重传', kindThird: '第三方二次开发', versionLabel: '原始版本（可选）',
    declare: '保存申报', declaring: '正在保存…',
    evidenceSummary: '证据（{{count}}）',
    detectedToast: '来源判定：{{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    declaredToast: '申报已保存：{{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    detectFailed: '来源检测失败。', declareFailed: '申报保存失败。', repoRequired: '请以 owner/repo 形式填写上游仓库。'
  },
  'zh-TW': {
    badge: { fork: 'Fork 已驗證', commonHistory: '共同歷史', declared: '已申報來源', unknown: '來源未知' },
    kicker: '上游檔案', title: '儲存庫來源',
    detect: '偵測來源', detecting: '正在偵測…',
    typeLabel: '判定', upstreamLabel: '上游儲存庫', mergeBaseLabel: '共同祖先', declaredLabel: '申報紀錄', checkedLabel: '最近檢查', neverChecked: '尚未檢查',
    declareSummary: '申報 ZIP 重傳或協力廠商來源',
    declareDetail: '系統不會根據儲存庫名稱猜測並自動綁定上游。申報會連同時間與證據一起保存；隨後 GitHub 會核實是否存在 Fork 關係或共同歷史。',
    upstreamRepoLabel: '上游儲存庫（owner/repo）', kindLabel: '類型', kindZip: 'ZIP 下載重傳', kindThird: '協力廠商二次開發', versionLabel: '原始版本（可選）',
    declare: '儲存申報', declaring: '正在儲存…',
    evidenceSummary: '證據（{{count}}）',
    detectedToast: '來源判定：{{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    declaredToast: '申報已儲存：{{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    detectFailed: '來源偵測失敗。', declareFailed: '申報儲存失敗。', repoRequired: '請以 owner/repo 形式填寫上游儲存庫。'
  },
  'ja-JP': {
    badge: { fork: 'Fork 検証済み', commonHistory: '共通履歴', declared: '申告済みの由来', unknown: '由来不明' },
    kicker: '上流プロファイル', title: 'リポジトリの由来',
    detect: '由来を検出', detecting: '検出中…',
    typeLabel: '判定', upstreamLabel: '上流リポジトリ', mergeBaseLabel: '共通祖先', declaredLabel: '申告内容', checkedLabel: '最終確認', neverChecked: '未確認',
    declareSummary: 'ZIP 再アップロードまたはサードパーティ由来を申告',
    declareDetail: '名前だけで上流を自動バインドすることはありません。申告は時刻と証拠とともに保存され、その後 GitHub が Fork 関係や共通履歴の有無を検証します。',
    upstreamRepoLabel: '上流リポジトリ（owner/repo）', kindLabel: '種別', kindZip: 'ZIP 再アップロード', kindThird: 'サードパーティ改変版', versionLabel: '元のバージョン（任意）',
    declare: '申告を保存', declaring: '保存中…',
    evidenceSummary: '証拠（{{count}}）',
    detectedToast: '由来判定：{{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    declaredToast: '申告を保存しました：{{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    detectFailed: '由来の検出に失敗しました。', declareFailed: '申告を保存できませんでした。', repoRequired: '上流リポジトリを owner/repo 形式で入力してください。'
  },
  'ko-KR': {
    badge: { fork: 'Fork 검증됨', commonHistory: '공통 이력', declared: '신고된 출처', unknown: '출처 미상' },
    kicker: '업스트림 프로필', title: '저장소 출처',
    detect: '출처 탐지', detecting: '탐지 중…',
    typeLabel: '판정', upstreamLabel: '업스트림 저장소', mergeBaseLabel: '공통 조상', declaredLabel: '신고 기록', checkedLabel: '마지막 확인', neverChecked: '확인된 적 없음',
    declareSummary: 'ZIP 재업로드 또는 서드파티 출처 신고',
    declareDetail: '이름만으로 업스트림을 자동 바인딩하지 않습니다. 신고는 시각·증거와 함께 저장되며, 이후 GitHub가 포크 관계나 공통 이력의 존재를 검증합니다.',
    upstreamRepoLabel: '업스트림 저장소(owner/repo)', kindLabel: '종류', kindZip: 'ZIP 재업로드', kindThird: '서드파티 수정판', versionLabel: '원본 버전(선택)',
    declare: '신고 저장', declaring: '저장 중…',
    evidenceSummary: '증거({{count}})',
    detectedToast: '출처 판정: {{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    declaredToast: '신고 저장됨: {{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    detectFailed: '출처 탐지에 실패했습니다.', declareFailed: '신고를 저장하지 못했습니다.', repoRequired: '업스트림 저장소를 owner/repo 형식으로 입력하세요.'
  },
  'de-DE': {
    badge: { fork: 'Fork verifiziert', commonHistory: 'Gemeinsame Historie', declared: 'Deklarierte Herkunft', unknown: 'Herkunft unbekannt' },
    kicker: 'Upstream-Profil', title: 'Repository-Herkunft',
    detect: 'Herkunft erkennen', detecting: 'Erkenne…',
    typeLabel: 'Bewertung', upstreamLabel: 'Upstream-Repository', mergeBaseLabel: 'Gemeinsamer Vorfahre', declaredLabel: 'Deklaration', checkedLabel: 'Zuletzt geprüft', neverChecked: 'Nie geprüft',
    declareSummary: 'ZIP-Neuupload oder Dritt-Herkunft deklarieren',
    declareDetail: 'Kandidaten werden niemals allein aus Namen automatisch gebunden. Eine Deklaration wird mit Zeitpunkt und Nachweis gespeichert; GitHub prüft anschließend, ob eine Fork-Beziehung oder gemeinsame Historie existiert.',
    upstreamRepoLabel: 'Upstream-Repository (owner/repo)', kindLabel: 'Art', kindZip: 'ZIP-Neuupload', kindThird: 'Drittanbieter-Fortführung', versionLabel: 'Originalversion (optional)',
    declare: 'Deklaration speichern', declaring: 'Speichere…',
    evidenceSummary: 'Nachweise ({{count}})',
    detectedToast: 'Herkunft: {{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    declaredToast: 'Deklaration gespeichert: {{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    detectFailed: 'Herkunftserkennung fehlgeschlagen.', declareFailed: 'Deklaration konnte nicht gespeichert werden.', repoRequired: 'Bitte das Upstream-Repository als owner/repo angeben.'
  },
  'es-ES': {
    badge: { fork: 'Fork verificado', commonHistory: 'Historial compartido', declared: 'Origen declarado', unknown: 'Origen desconocido' },
    kicker: 'Perfil de origen', title: 'Procedencia del repositorio',
    detect: 'Detectar origen', detecting: 'Detectando…',
    typeLabel: 'Evaluación', upstreamLabel: 'Repositorio origen', mergeBaseLabel: 'Ancestro común', declaredLabel: 'Declaración', checkedLabel: 'Última comprobación', neverChecked: 'Sin comprobar',
    declareSummary: 'Declarar una re-subida ZIP o un origen de terceros',
    declareDetail: 'Los candidatos nunca se enlazan automáticamente por nombre. La declaración se guarda con fecha y evidencia; después GitHub verifica si existe relación de fork o historial compartido.',
    upstreamRepoLabel: 'Repositorio origen (owner/repo)', kindLabel: 'Tipo', kindZip: 'Re-subida ZIP', kindThird: 'Continuación de terceros', versionLabel: 'Versión original (opcional)',
    declare: 'Guardar declaración', declaring: 'Guardando…',
    evidenceSummary: 'Evidencias ({{count}})',
    detectedToast: 'Origen: {{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    declaredToast: 'Declaración guardada: {{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    detectFailed: 'La detección de origen falló.', declareFailed: 'No se pudo guardar la declaración.', repoRequired: 'Introduce el repositorio origen como owner/repo.'
  },
  'fr-FR': {
    badge: { fork: 'Fork vérifié', commonHistory: 'Historique partagé', declared: 'Origine déclarée', unknown: 'Origine inconnue' },
    kicker: 'Profil amont', title: 'Origine du dépôt',
    detect: 'Détecter l’origine', detecting: 'Détection…',
    typeLabel: 'Évaluation', upstreamLabel: 'Dépôt amont', mergeBaseLabel: 'Ancêtre commun', declaredLabel: 'Déclaration', checkedLabel: 'Dernière vérification', neverChecked: 'Jamais vérifié',
    declareSummary: 'Déclarer un re-téléversement ZIP ou une origine tierce',
    declareDetail: 'Les candidats ne sont jamais liés automatiquement d’après le nom. La déclaration est conservée avec horodatage et preuves ; GitHub vérifie ensuite s’il existe un lien de fork ou un historique commun.',
    upstreamRepoLabel: 'Dépôt amont (owner/repo)', kindLabel: 'Type', kindZip: 'Re-téléversement ZIP', kindThird: 'Suite tierce', versionLabel: 'Version d’origine (optionnel)',
    declare: 'Enregistrer la déclaration', declaring: 'Enregistrement…',
    evidenceSummary: 'Preuves ({{count}})',
    detectedToast: 'Origine : {{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    declaredToast: 'Déclaration enregistrée : {{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    detectFailed: 'Échec de la détection d’origine.', declareFailed: 'Impossible d’enregistrer la déclaration.', repoRequired: 'Saisissez le dépôt amont sous la forme owner/repo.'
  },
  'pt-BR': {
    badge: { fork: 'Fork verificado', commonHistory: 'Histórico compartilhado', declared: 'Origem declarada', unknown: 'Origem desconhecida' },
    kicker: 'Perfil de origem', title: 'Procedência do repositório',
    detect: 'Detectar origem', detecting: 'Detectando…',
    typeLabel: 'Avaliação', upstreamLabel: 'Repositório de origem', mergeBaseLabel: 'Ancestral comum', declaredLabel: 'Declaração', checkedLabel: 'Última verificação', neverChecked: 'Nunca verificado',
    declareSummary: 'Declarar reenvio ZIP ou origem de terceiros',
    declareDetail: 'Candidatos nunca são vinculados automaticamente pelo nome. A declaração é armazenada com data e evidências; em seguida o GitHub verifica se existe relação de fork ou histórico compartilhado.',
    upstreamRepoLabel: 'Repositório de origem (owner/repo)', kindLabel: 'Tipo', kindZip: 'Reenvio ZIP', kindThird: 'Continuação de terceiros', versionLabel: 'Versão original (opcional)',
    declare: 'Salvar declaração', declaring: 'Salvando…',
    evidenceSummary: 'Evidências ({{count}})',
    detectedToast: 'Origem: {{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    declaredToast: 'Declaração salva: {{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    detectFailed: 'Falha ao detectar a origem.', declareFailed: 'Não foi possível salvar a declaração.', repoRequired: 'Informe o repositório de origem como owner/repo.'
  },
  'ru-RU': {
    badge: { fork: 'Fork подтверждён', commonHistory: 'Общая история', declared: 'Заявленное происхождение', unknown: 'Происхождение неизвестно' },
    kicker: 'Профиль источника', title: 'Происхождение репозитория',
    detect: 'Определить источник', detecting: 'Определение…',
    typeLabel: 'Оценка', upstreamLabel: 'Исходный репозиторий', mergeBaseLabel: 'Общий предок', declaredLabel: 'Заявление', checkedLabel: 'Последняя проверка', neverChecked: 'Не проверялось',
    declareSummary: 'Заявить повторную загрузку ZIP или стороннее происхождение',
    declareDetail: 'Кандидаты никогда не привязываются автоматически по имени. Заявление сохраняется со временем и доказательствами; затем GitHub проверяет наличие связи форка или общей истории.',
    upstreamRepoLabel: 'Исходный репозиторий (owner/repo)', kindLabel: 'Тип', kindZip: 'Повторная загрузка ZIP', kindThird: 'Стороннее продолжение', versionLabel: 'Исходная версия (необязательно)',
    declare: 'Сохранить заявление', declaring: 'Сохранение…',
    evidenceSummary: 'Доказательства ({{count}})',
    detectedToast: 'Происхождение: {{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    declaredToast: 'Заявление сохранено: {{badge}}{{upstream ? ` · ${upstream}` : ""}}',
    detectFailed: 'Не удалось определить источник.', declareFailed: 'Не удалось сохранить заявление.', repoRequired: 'Укажите исходный репозиторий в формате owner/repo.'
  }
}

for (const [locale, section] of Object.entries(translations)) {
  const file = path.join(root, locale, 'git.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!data.upstream) data.upstream = section
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  console.log(`${locale}: ok`)
}
