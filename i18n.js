/**
 * Shared i18n for Evigrade extension.
 *
 * Loaded as the first content script (parser.js depends on it) and as
 * a <script> tag in popup.html / compare.html / welcome.html before
 * their own scripts.
 *
 * Locale resolution priority:
 *   1. User preference saved in chrome.storage.sync ("evgLocale")
 *   2. Page language (document.documentElement.lang) on marketplaces
 *   3. Host map (russian shops → ru, spanish shops → es, else en)
 *   4. Browser UI language (chrome.i18n.getUILanguage)
 *   5. Fallback: en
 */
(() => {
  const STORAGE_KEY = "evgLocale";
  const SUPPORTED = ["ru", "en", "es"];
  const RU_HOST_MARKERS = ["wildberries.", "ozon.ru", "ozon.com", "goldapple."];
  const ES_HOST_MARKERS = ["sephora.es", "douglas.es", "notino.es", "primor.es", "druni.es"];

  function normalize(code) {
    const c = String(code || "").toLowerCase().split("-")[0];
    return SUPPORTED.includes(c) ? c : null;
  }

  function pickLocale({ host = "", docLang = "", uiLang = "", stored = "" } = {}) {
    const fromStored = normalize(stored);
    if (fromStored) return fromStored;
    const dl = String(docLang || "").toLowerCase();
    if (dl.startsWith("ru")) return "ru";
    if (dl.startsWith("es")) return "es";
    if (dl.startsWith("en")) return "en";
    const h = String(host || "").toLowerCase();
    for (const m of RU_HOST_MARKERS) if (h.includes(m)) return "ru";
    for (const m of ES_HOST_MARKERS) if (h.includes(m)) return "es";
    if (h.includes("iherb.com")) {
      const ul = String(uiLang || "").toLowerCase();
      if (ul.startsWith("ru")) return "ru";
      if (ul.startsWith("es")) return "es";
      return "en";
    }
    if (h) return "en";
    const ul = String(uiLang || "").toLowerCase();
    if (ul.startsWith("ru")) return "ru";
    if (ul.startsWith("es")) return "es";
    return "en";
  }

  const DICT = {
    ru: {
      // Popup-only keys (back-compat with old _locales/messages.json)
      scanning: "Сканирую страницу...",
      error: "Ошибка соединения с сервером",
      pasteManually: "Вставить состав вручную",
      pastePlaceholder: "Вставьте список ингредиентов через запятую...",
      analyze: "Проверить",
      green: "Работает",
      yellow: "Спорно",
      red: "Не работает",
      unknown: "Нет в базе",
      // Traffic light – short
      tlGreen: "Работает",
      tlYellow: "Спорно",
      tlRed: "Не работает",
      tlGray: "Нет в базе",
      tlNoData: "Нет данных",
      tlPrescription: "Рецептурный препарат",
      // Traffic light – tooltips
      tlGreenLong: "Работает – есть РКИ",
      tlYellowLong: "Спорно – слабая доказательная база",
      // Counts (used inline)
      countWorks: "{0} работает",
      countUncertain: "{0} спорно",
      countDoesntWork: "{0} не работает",
      countFunctional: "{0} базовых",
      catAntiAging: "anti-age",
      catBrightening: "осветляет",
      catBarrier: "барьер",
      catMoisturizing: "увлажняет",
      catAcne: "против акне",
      catProtection: "защита",
      catSoothing: "успокаивает",
      catFunctional: "базовый",
      filterAll: "Показать все",
      concEffective: "работает",
      concEffectiveTitle: "Позиция в INCI указывает на эффективную концентрацию",
      concBorderline: "на грани",
      concBorderlineTitle: "Концентрация близка к нижней границе. Минимальная эффективная: {0}",
      concDecorative: "декорация",
      concDecorativeTitle:
        "Позиция в INCI ниже 1%-линии. Минимальная эффективная концентрация: {0}",
      concDisclaimer:
        "Мы оцениваем концентрацию по позиции компонента в INCI. Точную концентрацию знает только производитель.",
      // Panel / badge
      panelClose: "Закрыть",
      panelAddCompare: "+ Сравнить",
      panelAdded: "\u2713 Добавлено",
      panelMaxCompare: "Макс. 5",
      panelOpenSite: "На сайте",
      panelOpenSiteTitle: "Открыть состав в чекере на evigrade.com",
      panelMedsExtCta: "Принимаете препараты? Поставьте Evigrade Meds",
      panelMatchOf: "{0} из {1}",
      panelBlacklistTitle: "Содержит ваши нежелательные компоненты!",
      panelUnknownHeader: "Пока нет в базе ({0}):",
      badgeBlSuffix: "{0} нежелат.",
      noProductName: "Без названия",
      // Composite warnings
      compositeContains: "В составе:",
      compositeTitlePilling: "Риск скатывания",
      compositeTitleSurfactantHarsh: "Жесткая моющая база – может сушить кожу",
      compositeTitleSurfactantMixed: "Жесткий ПАВ смягчен мягкими со-ПАВ",
      compositeTitleSurfactantModerate: "Моющая база средней жесткости",
      compositeTitleSurfactantGentle: "Мягкая моющая база",
      compositeTitleSurfactantGentleUltra: "Очень мягкая моющая база – подойдет чувствительной коже",
      compositeTitleFormaldehydeMulti: "Несколько доноров формальдегида в составе",
      formaldehydeMultiHint:
        "Формальдегид от нескольких консервантов суммируется. Важно при аллергии на формальдегид или очень чувствительной коже",
      compositeTitleNitrosamineRisk: "Риск нитрозаминов: нитрозирующий агент и амин вместе",
      nitrosamineRiskHint:
        "Нитрозирующий консервант (бронопол) вместе с амином DEA/TEA может образовать канцерогенные нитрозамины. В ЕС сочетание ограничено, но в импортной косметике встречается",
      pillingHint:
        "Может давать белые катышки при нанесении, особенно поверх других средств с полимерами",
      surfactantHarshHint:
        "Жесткие ПАВ активно обезжиривают и нарушают липидный барьер. При чувствительной, сухой или атопичной коже ищите средства с мягкими глюкозидами или amino-acid ПАВ",
      surfactantMixedHint:
        "Формула смягчает действие основного ПАВ – переносимость лучше, но для очень чувствительной кожи все равно стоит присмотреться к составу",
      surfactantModerateHint:
        "ПАВ средней жесткости. Подойдет для нормальной, жирной и комбинированной кожи; при сухой и чувствительной может сушить",
      surfactantGentleHint:
        "Мягкие ПАВ – не нарушают липидный барьер, подходят для ежедневного использования",
      // Surfactant chip labels
      surfUltraMild: "очень мягкий",
      surfMild: "мягкий",
      surfModerate: "средний",
      surfHarsh: "жесткий",
      surfTitlePrefix: "ПАВ",
      legendSurfTitle: "ПАВ:",
      // SPF chip labels
      spfModern: "современный",
      spfClassic: "классический",
      spfOutdated: "устаревший",
      spfAvoid: "избегать",
      spfModernLong: "Современный фильтр – новейшее поколение (Tinosorb, DHHB, Mexoryl XL)",
      spfClassicLong: "Проверенный фильтр – давно на рынке, без серьезных претензий",
      spfOutdatedLong: "Устаревший фильтр – есть лучшие альтернативы",
      spfAvoidLong: "Не рекомендуется – документированные проблемы (EU-ограничения)",
      legendSpfTitle: "SPF-фильтры:",
      // Risk badges
      badgeAllergenLetter: "А",
      badgeAllergenTitle: "Высокий аллергенный потенциал",
      badgeComedogenicLetter: "К",
      badgeComedogenicTitle: "Комедогенный потенциал",
      badgePregnancyLetter: "Б",
      badgePregnancyTitle: "Не рекомендуют при беременности",
      badgeIrritationLetter: "Р",
      badgeIrritationTitle: "Высокий раздражающий потенциал",
      // Legend
      legendAllergen: "аллерген",
      legendComedogenic: "комедоген",
      legendPregnancy: "не рекомендуют при беременности",
      legendIrritation: "раздражает",
      // Blacklist hits in panel
      blAllergen: "аллерген",
      blComedogenic: "комедогенный",
      blAvoid: "нежелательный",
      blAllergenForYou: "Ваш аллерген",
      blComedogenicForYou: "Комедогенный для вас",
      blAvoidForYou: "Нежелательный",
      // Misc
      auxIngredient: "Вспомогательный компонент",
      // Popup tabs and account
      popupSubtitle: "Проверка состава косметики",
      tabAnalysis: "Анализ",
      tabBlacklist: "Мои аллергены",
      tabCompare: "Сравнение",
      accountSignIn: "Войти",
      accountProfile: "Профиль",
      tierFree: "Free",
      tierPro: "Pro",
      tierProfi: "Профи",
      // Popup statuses
      statusOpenComposition:
        "Откройте раздел «Состав» / «Ingredients» на странице товара – анализ появится автоматически",
      statusAnalysisShown: "Анализ показан на странице",
      // Blacklist tab
      blAllergensTitle: "Аллергены",
      blAllergensDesc: "Компоненты, на которые у вас аллергия",
      blComedogenicTitle: "Комедогенные",
      blComedogenicDesc: "Компоненты, которые забивают ваши поры",
      blAvoidTitle: "Другие нежелательные",
      blAvoidDesc: "Любые компоненты, которых вы хотите избегать",
      blInputPlaceholder: "Название компонента...",
      // Paywall
      paywallTitle: "Это фича Pro",
      paywallUpgrade: "Перейти на Pro",
      paywallClose: "Закрыть",
      paywallBlacklistLimit:
        "На бесплатном тарифе доступно до {0} компонентов в категории. Pro – безлимит.",
      paywallIntlPayNote: "Оплата зарубежной картой – скоро. Сейчас принимаем карты РФ через ЮKassa.",
      // Compare in popup
      compareEmptyText: "Пока нет товаров для сравнения",
      compareEmptyHint:
        "Откройте товар на поддерживаемом сайте и нажмите «+ Сравнить» в панели Evigrade",
      compareSubmit: "Сравнить",
      compareClear: "Очистить",
      compareIngredientCount: "{0} компонентов",
      compareUpsellMore: "+{0} – доступно в Pro",
      compareRemoveTitle: "Убрать",
      // Compare page
      comparePageTitle: "Сравнение составов",
      compareEmpty2: "Добавьте минимум 2 товара для сравнения",
      compareEmptyHint2:
        "Откройте товар на поддерживаемом сайте, нажмите «+ Сравнить» в панели Evigrade",
      compareSecCleanser: "Моющая база",
      compareSecCleanserDesc: "Оценка жесткости ПАВ в умывалках, гелях и шампунях",
      compareSecCommon: "Общие активные компоненты",
      compareSecCommonDesc:
        "Компоненты, которые есть в нескольких средствах. Позиция в составе = предполагаемая концентрация.",
      compareSecUnique: "Уникальные для каждого средства",
      compareSecFull: "Полная таблица",
      compareSecFullDesc: "Все компоненты всех средств с оценкой концентрации",
      compareBlAlertTitle: "\u26a0 Найдены ваши нежелательные компоненты",
      cleanserUltraMild: "Очень мягкая",
      cleanserMild: "Мягкая",
      cleanserModerate: "Средняя",
      cleanserHarsh: "Жесткая",
      cleanserUltraMildNote:
        "Подходит для ежедневного умывания, включая чувствительную и атопичную кожу",
      cleanserMildNote: "Подходит для большинства типов кожи",
      cleanserModerateNote: "Может сушить при сухой или чувствительной коже",
      cleanserHarshNote:
        "Может нарушать барьер при регулярном использовании – ищите средство с мягкими со-ПАВ",
      cleanserNotApplicable: "Не умывалка",
      cleanserNoSurfactants: "В этом средстве нет ПАВ в верхних позициях",
      summaryWorking: "Работающих",
      summaryUncertain: "Спорных",
      summaryNotWorking: "Не работающих",
      summaryEffectivePct: "% эффективных",
      uniqueOnlyIn: "Только в {0} ({1})",
      tableComponent: "Компонент",
      // Welcome page
      welcomeTitle: "Расширение установлено",
      welcomeLead:
        "Теперь при открытии любого товара на поддерживаемых сайтах – состав будет подсвечиваться автоматически",
      welcomeTlGreenDesc: "Есть РКИ, рекомендуют дерматологи",
      welcomeTlYellowDesc: "Слабая доказательная база",
      welcomeTlRedDesc: "Молекула не проникает или эффект не доказан",
      welcomeStep1Title: "Открой любое косметическое средство",
      welcomeStep1Desc:
        "На Wildberries, Ozon, iHerb, Золотом Яблоке, Sephora, Ulta, Boots, Lookfantastic, Cult Beauty, Beauty Bay, Notino, Douglas, dm, Rossmann или Druni",
      welcomeStep2Title: "Перейди в раздел «Состав» / «Ingredients»",
      welcomeStep2Desc:
        "На англоязычных сайтах раскрой аккордеон Ingredients, на ЗЯ – таб «Состав», на WB – «Характеристики и описание»",
      welcomeStep3Title: "Посмотри на цвета",
      welcomeStep3Desc:
        "Через секунду каждый компонент в списке подсветится зеленым, желтым или красным. Снизу – панель со сводкой",
      welcomeStoresTitle: "Работает на этих магазинах",
      welcomeCtaPrimary: "Попробовать на Золотом Яблоке",
      welcomeCtaSecondary: "База компонентов",
      welcomeCtaPrimaryHref: "https://goldapple.ru/uhod-za-licom",
      welcomeFooter:
        "Расширение работает анонимно – мы не собираем историю посещений или персональные данные. На сервер отправляется только список ингредиентов с текущей страницы для сверки с базой.",
      welcomeDocTitle: "Evigrade Skin – добро пожаловать",
      compareDocTitle: "Evigrade Skin – сравнение составов",
      // Language switcher
      langMenuTitle: "Язык интерфейса",
      langRu: "Русский",
      langEn: "English",
      langEs: "Español",
      langSwitchAria: "Сменить язык",
      welcomeLangPrompt: "Выберите язык интерфейса",
      // Health filters (pregnancy / lactation)
      healthFiltersTitle: "Особые состояния",
      healthFiltersHint: "Отметьте, чтобы подсвечивать запрещённые компоненты",
      healthPregnancy: "Беременность",
      healthLactation: "Лактация",
      healthAvoidPregnancy: "Избегать при беременности",
      healthAvoidLactation: "Избегать при лактации",
      healthCautionPregnancy: "С осторожностью при беременности",
      healthCautionLactation: "С осторожностью при лактации",
      welcomeHealthPrompt: "У вас особое состояние?",
      welcomeHealthNone: "Нет",
      welcomeHealthPregnant: "Беременность",
      welcomeHealthLactating: "Лактация",
      // Telemetry opt-out (popup footer + welcome strip)
      telemetryLabel: "Анонимная статистика использования",
      telemetryHint:
        "Помогает чинить баги и понимать, какими фичами пользуются. Передаём только тип события, версию расширения и анонимный ID – без истории посещений и личных данных.",
      telemetryDisable: "Отключить",
      telemetryEnable: "Включить",
      telemetryDisabled: "Статистика выключена",
      telemetryEnabled: "Спасибо, помогает делать расширение лучше",
    },
    en: {
      scanning: "Scanning page...",
      error: "Server connection error",
      pasteManually: "Paste ingredients manually",
      pastePlaceholder: "Paste comma-separated ingredient list...",
      analyze: "Check",
      green: "Works",
      yellow: "Uncertain",
      red: "Doesn't work",
      unknown: "Not in database",
      tlGreen: "Works",
      tlYellow: "Uncertain",
      tlRed: "Doesn't work",
      tlGray: "Not in database",
      tlNoData: "No data",
      tlPrescription: "Prescription",
      tlGreenLong: "Works – RCT evidence",
      tlYellowLong: "Uncertain – weak evidence",
      countWorks: "{0} working",
      countUncertain: "{0} uncertain",
      countDoesntWork: "{0} not working",
      countFunctional: "{0} basic",
      catAntiAging: "anti-age",
      catBrightening: "brightening",
      catBarrier: "barrier",
      catMoisturizing: "hydration",
      catAcne: "acne care",
      catProtection: "protection",
      catSoothing: "soothing",
      catFunctional: "functional",
      filterAll: "Show all",
      concEffective: "active",
      concEffectiveTitle: "INCI position indicates an effective concentration",
      concBorderline: "borderline",
      concBorderlineTitle: "Concentration is near the lower limit. Minimum effective: {0}",
      concDecorative: "decoration",
      concDecorativeTitle:
        "INCI position is below the 1%-line. Minimum effective concentration: {0}",
      concDisclaimer:
        "We estimate concentration by INCI position. Only the manufacturer knows the exact value.",
      panelClose: "Close",
      panelAddCompare: "+ Compare",
      panelAdded: "\u2713 Added",
      panelMaxCompare: "Max 5",
      panelOpenSite: "Open on site",
      panelOpenSiteTitle: "Open composition in the checker on evigrade.com",
      panelMedsExtCta: "Take medication? Install Evigrade Meds",
      panelMatchOf: "{0} of {1}",
      panelBlacklistTitle: "Contains your unwanted ingredients!",
      panelUnknownHeader: "Not in database ({0}):",
      badgeBlSuffix: "{0} unwanted",
      noProductName: "Untitled",
      compositeContains: "Contains:",
      compositeTitlePilling: "Pilling risk",
      compositeTitleSurfactantHarsh: "Harsh cleansing base – may dry out skin",
      compositeTitleSurfactantMixed: "Harsh surfactant buffered by mild co-surfactants",
      compositeTitleSurfactantModerate: "Moderate cleansing base",
      compositeTitleSurfactantGentle: "Mild cleansing base",
      compositeTitleSurfactantGentleUltra: "Very mild cleansing base – good for sensitive skin",
      compositeTitleFormaldehydeMulti: "Several formaldehyde releasers in the formula",
      formaldehydeMultiHint:
        "Formaldehyde from several preservatives adds up. Matters if you're allergic to formaldehyde or have very sensitive skin",
      compositeTitleNitrosamineRisk: "Nitrosamine risk: nitrosating agent and amine together",
      nitrosamineRiskHint:
        "A nitrosating preservative (bronopol) together with a DEA/TEA amine can form carcinogenic nitrosamines. The EU restricts this combination, but it appears in imported cosmetics",
      pillingHint:
        "May produce white flakes on application, especially on top of other polymer-containing products",
      surfactantHarshHint:
        "Harsh surfactants strip oils and disrupt the lipid barrier. For sensitive, dry or atopic skin look for products with mild glucosides or amino-acid surfactants",
      surfactantMixedHint:
        "The formula softens the main surfactant – tolerance is better, but for very sensitive skin still review the composition",
      surfactantModerateHint:
        "Moderate surfactants. Suitable for normal, oily and combination skin; may dry out sensitive or dry skin",
      surfactantGentleHint: "Mild surfactants – preserve the lipid barrier, suitable for daily use",
      surfUltraMild: "ultra mild",
      surfMild: "mild",
      surfModerate: "moderate",
      surfHarsh: "harsh",
      surfTitlePrefix: "Surfactant",
      legendSurfTitle: "Surfactants:",
      spfModern: "modern",
      spfClassic: "classic",
      spfOutdated: "outdated",
      spfAvoid: "avoid",
      spfModernLong: "Modern UV filter – latest generation (Tinosorb, DHHB, Mexoryl XL)",
      spfClassicLong: "Established UV filter – long market history, no serious concerns",
      spfOutdatedLong: "Outdated UV filter – better alternatives exist",
      spfAvoidLong: "Not recommended – documented issues (EU restrictions)",
      legendSpfTitle: "UV filters:",
      badgeAllergenLetter: "A",
      badgeAllergenTitle: "High allergen potential",
      badgeComedogenicLetter: "C",
      badgeComedogenicTitle: "Comedogenic potential",
      badgePregnancyLetter: "P",
      badgePregnancyTitle: "Not recommended during pregnancy",
      badgeIrritationLetter: "I",
      badgeIrritationTitle: "High irritation potential",
      legendAllergen: "allergen",
      legendComedogenic: "comedogenic",
      legendPregnancy: "avoid during pregnancy",
      legendIrritation: "irritating",
      blAllergen: "allergen",
      blComedogenic: "comedogenic",
      blAvoid: "unwanted",
      blAllergenForYou: "Your allergen",
      blComedogenicForYou: "Comedogenic for you",
      blAvoidForYou: "Unwanted",
      auxIngredient: "Auxiliary ingredient",
      popupSubtitle: "Cosmetic ingredient checker",
      tabAnalysis: "Analysis",
      tabBlacklist: "My allergens",
      tabCompare: "Compare",
      accountSignIn: "Sign in",
      accountProfile: "Account",
      tierFree: "Free",
      tierPro: "Pro",
      tierProfi: "Profi",
      statusOpenComposition:
        "Open the «Ingredients» section on the product page – analysis appears automatically",
      statusAnalysisShown: "Analysis shown on page",
      blAllergensTitle: "Allergens",
      blAllergensDesc: "Ingredients you're allergic to",
      blComedogenicTitle: "Comedogenic",
      blComedogenicDesc: "Ingredients that clog your pores",
      blAvoidTitle: "Other unwanted",
      blAvoidDesc: "Any ingredients you want to avoid",
      blInputPlaceholder: "Ingredient name...",
      paywallTitle: "This is a Pro feature",
      paywallUpgrade: "Upgrade to Pro",
      paywallClose: "Close",
      paywallBlacklistLimit:
        "Free plan allows up to {0} ingredients per category. Pro – unlimited.",
      paywallIntlPayNote:
        "International card payments coming soon. Right now we accept Russian cards only, via YooKassa.",
      compareEmptyText: "No products to compare yet",
      compareEmptyHint:
        "Open a product on a supported site and click «+ Compare» in the Evigrade panel",
      compareSubmit: "Compare",
      compareClear: "Clear",
      compareIngredientCount: "{0} ingredients",
      compareUpsellMore: "+{0} more – Pro only",
      compareRemoveTitle: "Remove",
      comparePageTitle: "Ingredient comparison",
      compareEmpty2: "Add at least 2 products to compare",
      compareEmptyHint2:
        "Open a product on a supported site and click «+ Compare» in the Evigrade panel",
      compareSecCleanser: "Cleansing base",
      compareSecCleanserDesc: "Surfactant harshness in cleansers, gels and shampoos",
      compareSecCommon: "Common active ingredients",
      compareSecCommonDesc:
        "Ingredients found in multiple products. Position in INCI = approximate concentration.",
      compareSecUnique: "Unique to each product",
      compareSecFull: "Full table",
      compareSecFullDesc: "All ingredients of all products with concentration estimates",
      compareBlAlertTitle: "\u26a0 Your unwanted ingredients found",
      cleanserUltraMild: "Ultra mild",
      cleanserMild: "Mild",
      cleanserModerate: "Moderate",
      cleanserHarsh: "Harsh",
      cleanserUltraMildNote: "Suitable for daily cleansing, including sensitive and atopic skin",
      cleanserMildNote: "Suitable for most skin types",
      cleanserModerateNote: "May dry out dry or sensitive skin",
      cleanserHarshNote:
        "May disrupt the barrier with regular use – look for products with mild co-surfactants",
      cleanserNotApplicable: "Not a cleanser",
      cleanserNoSurfactants: "No surfactants in the top INCI positions",
      summaryWorking: "Working",
      summaryUncertain: "Uncertain",
      summaryNotWorking: "Not working",
      summaryEffectivePct: "% effective",
      uniqueOnlyIn: "Only in {0} ({1})",
      tableComponent: "Ingredient",
      welcomeTitle: "Extension installed",
      welcomeLead:
        "Now ingredients will be highlighted automatically on every product page of supported sites",
      welcomeTlGreenDesc: "RCT evidence, dermatologist-recommended",
      welcomeTlYellowDesc: "Weak evidence base",
      welcomeTlRedDesc: "Doesn't penetrate or no proven effect",
      welcomeStep1Title: "Open any cosmetic product",
      welcomeStep1Desc:
        "On Sephora, Ulta, Boots, Lookfantastic, Cult Beauty, Beauty Bay, Notino, Douglas, dm, Rossmann, Druni, iHerb, Wildberries, Ozon or Goldapple",
      welcomeStep2Title: "Open the «Ingredients» section",
      welcomeStep2Desc:
        "On English-language sites expand the Ingredients accordion. On Russian-language sites open the «Состав» tab.",
      welcomeStep3Title: "Look at the colors",
      welcomeStep3Desc:
        "In a second every ingredient will be highlighted green, yellow or red. A summary panel appears at the bottom.",
      welcomeStoresTitle: "Works on these stores",
      welcomeCtaPrimary: "Try it on Sephora",
      welcomeCtaSecondary: "Ingredient database",
      welcomeCtaPrimaryHref: "https://www.sephora.com/shop/skincare",
      welcomeFooter:
        "The extension works anonymously – we don't collect browsing history or personal data. Only the ingredient list from the current page is sent to the server for matching against our database.",
      welcomeDocTitle: "Evigrade Skin – welcome",
      compareDocTitle: "Evigrade Skin – ingredient comparison",
      langMenuTitle: "Interface language",
      langRu: "Русский",
      langEn: "English",
      langEs: "Español",
      langSwitchAria: "Change language",
      welcomeLangPrompt: "Choose your interface language",
      healthFiltersTitle: "Health filters",
      healthFiltersHint: "Toggle to highlight ingredients to avoid",
      healthPregnancy: "Pregnancy",
      healthLactation: "Breastfeeding",
      healthAvoidPregnancy: "Avoid during pregnancy",
      healthAvoidLactation: "Avoid during breastfeeding",
      healthCautionPregnancy: "Use with caution during pregnancy",
      healthCautionLactation: "Use with caution during breastfeeding",
      welcomeHealthPrompt: "Any special state?",
      welcomeHealthNone: "None",
      welcomeHealthPregnant: "Pregnancy",
      welcomeHealthLactating: "Breastfeeding",
      // Telemetry opt-out
      telemetryLabel: "Anonymous usage stats",
      telemetryHint:
        "Helps us fix bugs and see which features people actually use. We only send event type, extension version and an anonymous ID — no browsing history, no personal data.",
      telemetryDisable: "Disable",
      telemetryEnable: "Enable",
      telemetryDisabled: "Stats are off",
      telemetryEnabled: "Thanks — this helps us improve the extension",
    },
    es: {
      scanning: "Analizando la página...",
      error: "Error de conexión con el servidor",
      pasteManually: "Pegar ingredientes manualmente",
      pastePlaceholder: "Pega la lista de ingredientes separados por comas...",
      analyze: "Analizar",
      green: "Funciona",
      yellow: "Dudoso",
      red: "No funciona",
      unknown: "No está en la base",
      tlGreen: "Funciona",
      tlYellow: "Dudoso",
      tlRed: "No funciona",
      tlGray: "No está en la base",
      tlNoData: "Sin datos",
      tlPrescription: "Medicamento con receta",
      tlGreenLong: "Funciona – con ensayos clínicos",
      tlYellowLong: "Dudoso – evidencia débil",
      countWorks: "{0} funciona",
      countUncertain: "{0} dudoso",
      countDoesntWork: "{0} no funciona",
      countFunctional: "{0} básicos",
      catAntiAging: "anti-edad",
      catBrightening: "ilumina",
      catBarrier: "barrera",
      catMoisturizing: "hidrata",
      catAcne: "anti-acné",
      catProtection: "protección",
      catSoothing: "calma",
      catFunctional: "básico",
      filterAll: "Ver todo",
      concEffective: "activa",
      concEffectiveTitle: "La posición en el INCI indica una concentración efectiva",
      concBorderline: "al límite",
      concBorderlineTitle: "Concentración cerca del límite inferior. Mínima efectiva: {0}",
      concDecorative: "decoración",
      concDecorativeTitle:
        "Posición en el INCI bajo la línea del 1%. Concentración mínima efectiva: {0}",
      concDisclaimer:
        "Estimamos la concentración por la posición en el INCI. La cifra exacta solo la conoce el fabricante.",
      panelClose: "Cerrar",
      panelAddCompare: "+ Comparar",
      panelAdded: "✓ Añadido",
      panelMaxCompare: "Máx. 5",
      panelOpenSite: "En la web",
      panelOpenSiteTitle: "Abrir la composición en el comprobador de evigrade.com",
      panelMedsExtCta: "¿Tomas medicamentos? Instala Evigrade Meds",
      panelMatchOf: "{0} de {1}",
      panelBlacklistTitle: "¡Contiene ingredientes que evitas!",
      panelUnknownHeader: "No están en la base ({0}):",
      badgeBlSuffix: "{0} a evitar",
      noProductName: "Sin título",
      compositeContains: "Contiene:",
      compositeTitlePilling: "Riesgo de pilling",
      compositeTitleSurfactantHarsh: "Base limpiadora agresiva – puede resecar la piel",
      compositeTitleSurfactantMixed: "Tensioactivo agresivo suavizado por co-tensioactivos suaves",
      compositeTitleSurfactantModerate: "Base limpiadora de dureza media",
      compositeTitleSurfactantGentle: "Base limpiadora suave",
      compositeTitleSurfactantGentleUltra: "Base limpiadora muy suave – apta para piel sensible",
      compositeTitleFormaldehydeMulti: "Varios liberadores de formaldehído en la fórmula",
      formaldehydeMultiHint:
        "El formaldehído de varios conservantes se suma. Relevante si hay alergia al formaldehído o la piel es muy sensible",
      compositeTitleNitrosamineRisk: "Riesgo de nitrosaminas: agente nitrosante y amina juntos",
      nitrosamineRiskHint:
        "Un conservante nitrosante (bronopol) junto a una amina DEA/TEA puede formar nitrosaminas cancerigenas. En la UE la combinacion esta restringida, pero aparece en cosmetica importada",
      pillingHint:
        "Puede dejar pequeños grumos blancos al aplicarse, sobre todo encima de otros productos con polímeros",
      surfactantHarshHint:
        "Los tensioactivos agresivos eliminan los lípidos y dañan la barrera cutánea. En piel sensible, seca o atópica busca productos con glucósidos suaves o tensioactivos de aminoácidos",
      surfactantMixedHint:
        "La fórmula suaviza el tensioactivo principal – se tolera mejor, pero en piel muy sensible conviene revisar la composición",
      surfactantModerateHint:
        "Tensioactivos de dureza media. Adecuados para piel normal, grasa y mixta; pueden resecar la piel sensible o seca",
      surfactantGentleHint:
        "Tensioactivos suaves – respetan la barrera cutánea, aptos para uso diario",
      surfUltraMild: "muy suave",
      surfMild: "suave",
      surfModerate: "medio",
      surfHarsh: "agresivo",
      surfTitlePrefix: "Tensioactivo",
      legendSurfTitle: "Tensioactivos:",
      spfModern: "moderno",
      spfClassic: "clásico",
      spfOutdated: "obsoleto",
      spfAvoid: "evitar",
      spfModernLong: "Filtro UV moderno – última generación (Tinosorb, DHHB, Mexoryl XL)",
      spfClassicLong: "Filtro UV clásico – con larga trayectoria, sin problemas relevantes",
      spfOutdatedLong: "Filtro UV obsoleto – existen mejores alternativas",
      spfAvoidLong: "No recomendado – problemas documentados (restricciones UE)",
      legendSpfTitle: "Filtros UV:",
      badgeAllergenLetter: "A",
      badgeAllergenTitle: "Alto potencial alergénico",
      badgeComedogenicLetter: "C",
      badgeComedogenicTitle: "Potencial comedogénico",
      badgePregnancyLetter: "E",
      badgePregnancyTitle: "No recomendado durante el embarazo",
      badgeIrritationLetter: "I",
      badgeIrritationTitle: "Alto potencial irritante",
      legendAllergen: "alérgeno",
      legendComedogenic: "comedogénico",
      legendPregnancy: "evitar en el embarazo",
      legendIrritation: "irritante",
      blAllergen: "alérgeno",
      blComedogenic: "comedogénico",
      blAvoid: "a evitar",
      blAllergenForYou: "Tu alérgeno",
      blComedogenicForYou: "Comedogénico para ti",
      blAvoidForYou: "A evitar",
      auxIngredient: "Ingrediente auxiliar",
      popupSubtitle: "Análisis de ingredientes cosméticos",
      tabAnalysis: "Análisis",
      tabBlacklist: "Mis alérgenos",
      tabCompare: "Comparar",
      accountSignIn: "Iniciar sesión",
      accountProfile: "Cuenta",
      tierFree: "Free",
      tierPro: "Pro",
      tierProfi: "Profi",
      statusOpenComposition:
        "Abre la sección «Ingredientes» en la página del producto – el análisis aparecerá automáticamente",
      statusAnalysisShown: "Análisis mostrado en la página",
      blAllergensTitle: "Alérgenos",
      blAllergensDesc: "Ingredientes a los que tienes alergia",
      blComedogenicTitle: "Comedogénicos",
      blComedogenicDesc: "Ingredientes que obstruyen tus poros",
      blAvoidTitle: "Otros que prefieres evitar",
      blAvoidDesc: "Cualquier ingrediente que quieras evitar",
      blInputPlaceholder: "Nombre del ingrediente...",
      paywallTitle: "Función Pro",
      paywallUpgrade: "Pasar a Pro",
      paywallClose: "Cerrar",
      paywallBlacklistLimit:
        "El plan gratuito permite hasta {0} ingredientes por categoría. Pro – sin límites.",
      paywallIntlPayNote:
        "Pagos con tarjeta internacional próximamente. Por ahora aceptamos solo tarjetas emitidas en Rusia, vía YooKassa.",
      compareEmptyText: "Aún no hay productos para comparar",
      compareEmptyHint:
        "Abre un producto en una tienda compatible y pulsa «+ Comparar» en el panel de Evigrade",
      compareSubmit: "Comparar",
      compareClear: "Vaciar",
      compareIngredientCount: "{0} ingredientes",
      compareUpsellMore: "+{0} – disponibles en Pro",
      compareRemoveTitle: "Quitar",
      comparePageTitle: "Comparación de ingredientes",
      compareEmpty2: "Añade al menos 2 productos para comparar",
      compareEmptyHint2:
        "Abre un producto en una tienda compatible y pulsa «+ Comparar» en el panel de Evigrade",
      compareSecCleanser: "Base limpiadora",
      compareSecCleanserDesc: "Dureza de los tensioactivos en limpiadores, geles y champús",
      compareSecCommon: "Activos en común",
      compareSecCommonDesc:
        "Ingredientes presentes en varios productos. La posición en el INCI = concentración aproximada.",
      compareSecUnique: "Únicos de cada producto",
      compareSecFull: "Tabla completa",
      compareSecFullDesc:
        "Todos los ingredientes de todos los productos con estimación de concentración",
      compareBlAlertTitle: "⚠ Hemos encontrado tus ingredientes a evitar",
      cleanserUltraMild: "Muy suave",
      cleanserMild: "Suave",
      cleanserModerate: "Media",
      cleanserHarsh: "Agresiva",
      cleanserUltraMildNote: "Apta para limpieza diaria, incluso en piel sensible o atópica",
      cleanserMildNote: "Apta para la mayoría de tipos de piel",
      cleanserModerateNote: "Puede resecar la piel seca o sensible",
      cleanserHarshNote:
        "Con uso continuado puede dañar la barrera – busca productos con co-tensioactivos suaves",
      cleanserNotApplicable: "No es un limpiador",
      cleanserNoSurfactants: "No hay tensioactivos en las primeras posiciones del INCI",
      summaryWorking: "Funcionan",
      summaryUncertain: "Dudosos",
      summaryNotWorking: "No funcionan",
      summaryEffectivePct: "% efectivos",
      uniqueOnlyIn: "Solo en {0} ({1})",
      tableComponent: "Ingrediente",
      welcomeTitle: "Extensión instalada",
      welcomeLead:
        "A partir de ahora, cuando abras un producto en las tiendas compatibles, los ingredientes se resaltarán automáticamente",
      welcomeTlGreenDesc: "Con ensayos clínicos, recomendado por dermatólogos",
      welcomeTlYellowDesc: "Evidencia débil",
      welcomeTlRedDesc: "No penetra en la piel o no se ha demostrado eficacia",
      welcomeStep1Title: "Abre cualquier producto cosmético",
      welcomeStep1Desc:
        "En Sephora, Douglas, Notino, Druni, dm, Rossmann, Boots, Lookfantastic, Cult Beauty, Beauty Bay, Ulta o iHerb",
      welcomeStep2Title: "Abre la sección «Ingredientes»",
      welcomeStep2Desc:
        "En las tiendas en español despliega el acordeón «Ingredientes» o «INCI». En sitios en inglés expande «Ingredients».",
      welcomeStep3Title: "Mira los colores",
      welcomeStep3Desc:
        "En un segundo cada ingrediente se marcará en verde, amarillo o rojo. Debajo aparece un panel con el resumen.",
      welcomeStoresTitle: "Funciona en estas tiendas",
      welcomeCtaPrimary: "Probar en Sephora",
      welcomeCtaSecondary: "Base de ingredientes",
      welcomeCtaPrimaryHref: "https://www.sephora.es/cuidado-de-la-piel-c301/",
      welcomeFooter:
        "La extensión funciona de forma anónima – no recopilamos historial de navegación ni datos personales. Al servidor solo se envía la lista de ingredientes de la página actual para cotejarla con la base.",
      welcomeDocTitle: "Evigrade Skin – te damos la bienvenida",
      compareDocTitle: "Evigrade Skin – comparación de ingredientes",
      langMenuTitle: "Idioma de la interfaz",
      langRu: "Русский",
      langEn: "English",
      langEs: "Español",
      langSwitchAria: "Cambiar idioma",
      welcomeLangPrompt: "Elige el idioma de la interfaz",
      healthFiltersTitle: "Filtros de salud",
      healthFiltersHint: "Marca para resaltar ingredientes a evitar",
      healthPregnancy: "Embarazo",
      healthLactation: "Lactancia",
      healthAvoidPregnancy: "Evitar durante el embarazo",
      healthAvoidLactation: "Evitar durante la lactancia",
      healthCautionPregnancy: "Usar con precaución en el embarazo",
      healthCautionLactation: "Usar con precaución en la lactancia",
      welcomeHealthPrompt: "¿Tienes algún estado especial?",
      welcomeHealthNone: "Ninguno",
      welcomeHealthPregnant: "Embarazo",
      welcomeHealthLactating: "Lactancia",
      // Telemetry opt-out
      telemetryLabel: "Estadísticas anónimas de uso",
      telemetryHint:
        "Nos ayuda a corregir errores y entender qué funciones se usan. Solo enviamos el tipo de evento, la versión de la extensión y un ID anónimo: nada de historial de navegación ni datos personales.",
      telemetryDisable: "Desactivar",
      telemetryEnable: "Activar",
      telemetryDisabled: "Estadísticas desactivadas",
      telemetryEnabled: "Gracias, nos ayuda a mejorar la extensión",
    },
  };

  function format(str, args) {
    let out = String(str || "");
    args.forEach((a, i) => {
      out = out.replace(new RegExp(`\\{${i}\\}`, "g"), String(a));
    });
    return out;
  }

  function storageAvailable() {
    try {
      return (
        typeof chrome !== "undefined" &&
        chrome.storage &&
        chrome.storage.sync &&
        typeof chrome.storage.sync.get === "function"
      );
    } catch {
      return false;
    }
  }

  function loadStored() {
    return new Promise((resolve) => {
      if (!storageAvailable()) return resolve(null);
      try {
        chrome.storage.sync.get([STORAGE_KEY], (res) => {
          if (chrome.runtime?.lastError) return resolve(null);
          resolve(normalize(res?.[STORAGE_KEY]));
        });
      } catch {
        resolve(null);
      }
    });
  }

  function saveStored(code) {
    return new Promise((resolve) => {
      if (!storageAvailable()) return resolve(false);
      const value = normalize(code);
      if (!value) return resolve(false);
      try {
        chrome.storage.sync.set({ [STORAGE_KEY]: value }, () => {
          resolve(!chrome.runtime?.lastError);
        });
      } catch {
        resolve(false);
      }
    });
  }

  const listeners = new Set();

  const evgI18n = {
    locale: "ru",
    STORAGE_KEY,
    SUPPORTED: SUPPORTED.slice(),
    init({ host = "", docLang = "", uiLang = "", stored = "" } = {}) {
      this.locale = pickLocale({ host, docLang, uiLang, stored });
      return this.locale;
    },
    async initAsync({ host = "", docLang = "", uiLang = "" } = {}) {
      const stored = await loadStored();
      this.locale = pickLocale({ host, docLang, uiLang, stored });
      return this.locale;
    },
    async setLocale(code, { persist = true } = {}) {
      const value = normalize(code);
      if (!value) return this.locale;
      this.locale = value;
      if (persist) await saveStored(value);
      for (const fn of listeners) {
        try {
          fn(value);
        } catch {}
      }
      return value;
    },
    onChange(fn) {
      if (typeof fn === "function") listeners.add(fn);
      return () => listeners.delete(fn);
    },
    watchStorage() {
      if (
        typeof chrome === "undefined" ||
        !chrome.storage ||
        !chrome.storage.onChanged ||
        this._watched
      ) {
        return;
      }
      this._watched = true;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") return;
        const next = changes?.[STORAGE_KEY]?.newValue;
        const norm = normalize(next);
        if (norm && norm !== this.locale) {
          this.locale = norm;
          for (const fn of listeners) {
            try {
              fn(norm);
            } catch {}
          }
        }
      });
    },
    t(key, ...args) {
      const dict = DICT[this.locale] || DICT.ru;
      const fallback = DICT.ru;
      const raw = dict[key] != null ? dict[key] : fallback[key] != null ? fallback[key] : key;
      return args.length > 0 ? format(raw, args) : raw;
    },
    apply(root) {
      const r = root || document;
      for (const el of r.querySelectorAll("[data-i18n]")) {
        el.textContent = this.t(el.dataset.i18n);
      }
      for (const el of r.querySelectorAll("[data-i18n-html]")) {
        el.innerHTML = this.t(el.dataset.i18nHtml);
      }
      for (const el of r.querySelectorAll("[data-i18n-placeholder]")) {
        el.placeholder = this.t(el.dataset.i18nPlaceholder);
      }
      for (const el of r.querySelectorAll("[data-i18n-title]")) {
        el.title = this.t(el.dataset.i18nTitle);
      }
      for (const el of r.querySelectorAll("[data-i18n-href]")) {
        el.href = this.t(el.dataset.i18nHref);
      }
    },
  };

  if (typeof globalThis !== "undefined") globalThis.evgI18n = evgI18n;
  if (typeof window !== "undefined") window.evgI18n = evgI18n;
})();
