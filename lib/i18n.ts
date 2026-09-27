export type Language = "en" | "bs";

export const translations = {
  en: {
    // App header
    appTitle: "EssayWriter Studio",
    untitledEssay: "Untitled essay",
    openRecent: "Open recent…",
    openRecentSr: "Open recent essay",
    historyUnavailable: "Recent essays are unavailable right now.",
    download: "Download",
    downloadDocx: "Download .docx",
    downloadTooltipDisabled: "Download appears after the first draft",
    themeToggleLight: "Switch to light mode",
    themeToggleDark: "Switch to dark mode",
    languageSelect: "Language",
    dismissError: "Dismiss error",
    somethingWentWrong: "Something went wrong",

    // Steps
    stepContext: "Context",
    stepOutline: "Outline",
    stepSources: "Sources",
    stepDraft: "Draft",

    // Workflow mode
    workflowMode: "Workflow mode",
    modeStaged: "Staged",
    modeOneShot: "One-shot",
    modeStagedHelp: "Approve each stage before the next begins.",
    modeOneShotHelp: "Run outline, sources, and draft in one pass.",

    // Inputs
    topicLabel: "Essay topic",
    topicPlaceholder: "e.g. The causes of the First World War",
    topicHelp: "One clear question or title. Keep it under 500 characters.",
    topicErrorRequired: "Add an essay topic first.",
    topicErrorButton: "Add a topic first.",

    wordTargetLabel: "Word target",
    wordTargetHelp: "Between 400 and 3,000 words.",
    wordTargetUnit: "words",
    words: "Words",

    minimumFootnotesLabel: "Minimum footnotes",
    minimumFootnotesHelp: "At least this many footnotes after consecutive same-source citations are grouped. A work can be cited in separate passages.",
    minimumSourcesLabel: "Minimum cited works",
    minimumSourcesHelp: "Different source works, not repeated footnotes to the same work. Every citation must support a real claim.",

    filesLabel: "Files and pictures",
    filesHelp: "Add briefs, sources, or photos of them (up to 5 at once). Pictures get transcribed into Context automatically.",
    readingFiles: "Reading your files… pictures take a little longer.",
    filesAddedNote: "{names} added to Context below. Review before generating.",
    skippedFiles: " Skipped: {errors}",
    fileKindPicture: "picture",
    fileKindFile: "file",
    removeFile: "Remove {name}",
    invalidFileType: "{name}: use .docx, .pdf, .txt, .md, or an image (.png, .jpg, .webp, .gif).",
    fileReadError: "Could not read those files.",

    contextLabel: "Context",
    contextOptional: "(optional)",
    contextPlaceholder: "Paste the marking criteria, required strands, and task wording here. Anything you upload above lands here too…",
    contextHelp: "{count} characters. Optional, but helps match marking criteria.",

    // Buttons & workflow
    generateOutline: "Generate outline",
    writingOutline: "Writing outline…",
    gatherSources: "Gather sources",
    gatheringSources: "Gathering sources…",
    draftEssay: "Draft essay",
    draftingEssay: "Drafting essay…",
    generateEssay: "Generate essay",
    writingEssay: "Writing essay…",
    approveOutlineFirst: "Approve the outline in the centre panel first.",
    approveSourcesFirst: "Approve the source list in the centre panel first.",
    oneShotHelp: "Runs outline, sources, and draft back to back.",

    // Pipeline - Outline
    outlineHeading: "Outline",
    approvedBadge: "Approved",
    needsApprovalBadge: "Needs approval",
    outlineModelWaiting: "Writing your outline… the model usually answers within a minute.",
    thesisLabel: "Thesis",
    editThesisAria: "Edit thesis",
    editSectionHeadingAria: "Edit heading for section {num}",
    editPointAria: "Edit point {pNum} in section {sNum}",
    criterionLabel: "Criterion",
    editCriterionAria: "Edit criterion for point {pNum} in section {sNum}",
    strandLabel: "Strand",
    editStrandAria: "Edit strand for point {pNum} in section {sNum}",
    checklistLabel: "Checklist",
    editOutline: "Edit outline",
    approveOutline: "Approve outline",
    outlineEditedNote: "Edited — approval uses your revised wording.",
    noOutlineTitle: "No outline yet",
    noOutlineHint: "Fill in the context on the left, then generate an outline to review here.",

    // Pipeline - Sources
    sourcesHeading: "Sources",
    liveSearchBadge: "Live search · {hits}",
    liveSearchTitle: "{hits} live result{suffix} informed this list",
    modelKnowledgeBadge: "Model knowledge",
    modelKnowledgeTitle: "No live results; the list draws on model knowledge. Verify URLs before submitting.",
    sourcesElapsed: "Gathering sources… {elapsed}s elapsed. No need to click again.",
    supportsLabel: "Supports:",
    noLinkProvided: "No link provided.",
    editSources: "Edit sources",
    approveSources: "Approve sources",
    noSourcesTitle: "No sources yet",
    noSourcesHint: "Approve the outline first, then gather a reading list for this essay.",

    // Pipeline - Criteria map
    criteriaMapHeading: "Criteria map",
    criteriaMapHelp: "Which criteria each outline section serves, and how many gathered sources back each one.",
    noCriteriaYet: "No criteria tagged yet — they appear here once the outline maps points to criteria.",
    sourceCountSingular: "1 source",
    sourceCountPlural: "{count} sources",
    strandsLabel: "Strands: {strands}",
    sectionsLabel: "Sections: {sections}",

    // Pipeline - Validation
    validationHeading: "Validation",
    nothingToCheckTitle: "Nothing to check",
    nothingToCheckHint: "Style and link checks appear here after the first draft.",
    noValidationIssues: "No reported style or citation-format issues.",
    coverageHeading: "Coverage",

    // Preview
    previewHeading: "Essay preview",
    versionLabel: "Version",
    versionOption: "v{version} · {words} words",
    statWords: "Words",
    statFootnotes: "Footnotes",
    statWorksCited: "Works cited",
    targetWords: "Target {target} words",
    progressAria: "Progress towards word target",
    previewBlankPlaceholder: "Stats, versions, and download appear here once a draft exists.",

    // DocxPaper
    pagePreviewHeading: "Page preview",
    previewFit: "Fit",
    previewActual: "100%",
    previewExpand: "Expand",
    draftingEssayPaper: "Drafting your essay…",
    blankPaperTitle: "A blank page, for now.",
    blankPaperHint: "Work through the context, outline, and sources. Your finished essay will be set here like a printed page.",
    previewErrorFallback: "Page preview failed ({error}), showing text instead. Download still works.",

    // Footnotes card
    footnotesHeading: "Footnotes",
    footnotesTapHint: "Tap a superscript number in the essay to jump to its citation.",
    accessedDate: "Accessed {date}.",

    // Refine chat
    keepPromptingHeading: "Keep prompting",
    refineDraftLabel: "Refine draft",
    refiningVersion: "(revising v{version})",
    refinePlaceholderDisabled: "Your draft will appear above — then ask for changes here…",
    refinePlaceholderActive: "e.g. Add a paragraph on X — new sources are fetched automatically…",
    refineHelp: "Each revision saves a new version. Ask for new content freely — fresh sources are gathered when needed.",
    sendButton: "Send",
    revisingButton: "Revising…",
    refineErrorEmpty: "Describe the change first.",
    refineErrorNoProject: "Draft an essay before refining it.",
    refineErrorMessage: "Could not apply that change: {message}",

    // Expanded dialog
    expandedPreviewTitle: "Expanded essay preview",
    closeExpanded: "✕ Close",

    // Errors & footer
    outlineFailed: "Outline failed.",
    sourcesFailed: "Sources failed.",
    draftFailed: "Draft failed.",
    oneShotFailed: "One-shot run failed.",
    footerText: "Outline, sources, and draft stay in sync — approve each stage to unlock the next.",
  },

  bs: {
    // App header
    appTitle: "EssayWriter Studio",
    untitledEssay: "Neimenovani esej",
    openRecent: "Otvori nedavni…",
    openRecentSr: "Otvori nedavni esej",
    historyUnavailable: "Nedavni eseji trenutno nisu dostupni.",
    download: "Preuzmi",
    downloadDocx: "Preuzmi .docx",
    downloadTooltipDisabled: "Preuzimanje je dostupno nakon prvog nacrta",
    themeToggleLight: "Prebaci na svijetlu temu",
    themeToggleDark: "Prebaci na tamnu temu",
    languageSelect: "Jezik",
    dismissError: "Zatvori grešku",
    somethingWentWrong: "Došlo je do greške",

    // Steps
    stepContext: "Kontekst",
    stepOutline: "Struktura",
    stepSources: "Izvori",
    stepDraft: "Nacrt",

    // Workflow mode
    workflowMode: "Način rada",
    modeStaged: "Po fazama",
    modeOneShot: "Odjednom",
    modeStagedHelp: "Odobrite svaku fazu prije početka sljedeće.",
    modeOneShotHelp: "Generišite strukturu, izvore i nacrt u jednom prolazu.",

    // Inputs
    topicLabel: "Tema eseja",
    topicPlaceholder: "npr. Uzroci Prvog svjetskog rata",
    topicHelp: "Jedno jasno pitanje ili naslov. Do 500 znakova.",
    topicErrorRequired: "Prvo unesite temu eseja.",
    topicErrorButton: "Prvo dodajte temu.",

    wordTargetLabel: "Ciljani broj riječi",
    wordTargetHelp: "Između 400 i 3.000 riječi.",
    wordTargetUnit: "riječi",
    words: "Riječi",

    minimumFootnotesLabel: "Minimalno fusnota",
    minimumFootnotesHelp: "Najmanje ovoliko fusnota nakon grupisanja uzastopnih citata iz istog izvora. Izvor se može citirati u više odlomaka.",
    minimumSourcesLabel: "Minimalno citiranih izvora",
    minimumSourcesHelp: "Različiti izvori, a ne ponovljene fusnote za isto djelo. Svaki citat mora potkrijepiti stvarnu tvrdnju.",

    filesLabel: "Datoteke i slike",
    filesHelp: "Dodajte uputstva, izvore ili njihove fotografije (do 5 odjednom). Slike se automatski prepisuju u kontekst.",
    readingFiles: "Čitanje datoteka… obrada slika traje malo duže.",
    filesAddedNote: "{names} dodano u kontekst ispod. Pregledajte prije generisanja.",
    skippedFiles: " Preskočeno: {errors}",
    fileKindPicture: "slika",
    fileKindFile: "datoteka",
    removeFile: "Ukloni {name}",
    invalidFileType: "{name}: koristite .docx, .pdf, .txt, .md ili sliku (.png, .jpg, .webp, .gif).",
    fileReadError: "Nije uspjelo čitanje datoteka.",

    contextLabel: "Kontekst",
    contextOptional: "(opcionalno)",
    contextPlaceholder: "Zalijepite kriterije ocjenjivanja, smjernice i tekst zadatka ovdje. Sve što učitate iznad također dolazi ovdje…",
    contextHelp: "{count} znakova. Opcionalno, ali pomaže u ispunjavanju kriterija ocjenjivanja.",

    // Buttons & workflow
    generateOutline: "Generiši strukturu",
    writingOutline: "Pisanje strukture…",
    gatherSources: "Prikupi izvore",
    gatheringSources: "Prikupljanje izvora…",
    draftEssay: "Napiši nacrt",
    draftingEssay: "Pisanje nacrta…",
    generateEssay: "Generiši esej",
    writingEssay: "Pisanje eseja…",
    approveOutlineFirst: "Prvo odobrite strukturu u srednjem panelu.",
    approveSourcesFirst: "Prvo odobrite listu izvora u srednjem panelu.",
    oneShotHelp: "Pokreće strukturu, izvore i nacrt u nizu.",

    // Pipeline - Outline
    outlineHeading: "Struktura",
    approvedBadge: "Odobreno",
    needsApprovalBadge: "Potrebno odobrenje",
    outlineModelWaiting: "Pisanje strukture… model obično odgovori unutar minute.",
    thesisLabel: "Teza",
    editThesisAria: "Uredi tezu",
    editSectionHeadingAria: "Uredi naslov sekcije {num}",
    editPointAria: "Uredi tačku {pNum} u sekciji {sNum}",
    criterionLabel: "Kriterij",
    editCriterionAria: "Uredi kriterij za tačku {pNum} u sekciji {sNum}",
    strandLabel: "Smjernica",
    editStrandAria: "Uredi smjernicu za tačku {pNum} u sekciji {sNum}",
    checklistLabel: "Kontrolna lista",
    editOutline: "Uredi strukturu",
    approveOutline: "Odobri strukturu",
    outlineEditedNote: "Izmijenjeno — odobrenje koristi vaše izmijenjene formulacije.",
    noOutlineTitle: "Još nema strukture",
    noOutlineHint: "Popunite kontekst na lijevoj strani, a zatim generišite strukturu za pregled ovdje.",

    // Pipeline - Sources
    sourcesHeading: "Izvori",
    liveSearchBadge: "Pretraga uživo · {hits}",
    liveSearchTitle: "{hits} rezultata uživo je doprinijelo ovoj listi",
    modelKnowledgeBadge: "Znanje modela",
    modelKnowledgeTitle: "Nema rezultata uživo; lista se oslanja na znanje modela. Provjerite linkove prije predaje.",
    sourcesElapsed: "Prikupljanje izvora… prošlo {elapsed}s. Nema potrebe ponovo klikati.",
    supportsLabel: "Podržava:",
    noLinkProvided: "Nema priloženog linka.",
    editSources: "Uredi izvore",
    approveSources: "Odobri izvore",
    noSourcesTitle: "Još nema izvora",
    noSourcesHint: "Prvo odobrite strukturu, a zatim prikupite literaturu za ovaj esej.",

    // Pipeline - Criteria map
    criteriaMapHeading: "Mapa kriterija",
    criteriaMapHelp: "Koji kriterij pokriva svaki dio strukture i koliko prikupljenih izvora podržava svaki od njih.",
    noCriteriaYet: "Kriteriji još nisu označeni — pojavit će se ovdje kada struktura poveže tačke s kriterijima.",
    sourceCountSingular: "1 izvor",
    sourceCountPlural: "{count} izvora",
    strandsLabel: "Smjernice: {strands}",
    sectionsLabel: "Sekcije: {sections}",

    // Pipeline - Validation
    validationHeading: "Validacija",
    nothingToCheckTitle: "Nema sadržaja za provjeru",
    nothingToCheckHint: "Provjera stila i referenci pojavit će se ovdje nakon prvog nacrta.",
    noValidationIssues: "Nema prijavljenih problema sa stilom ili formatom citiranja.",
    coverageHeading: "Pokrivenost",

    // Preview
    previewHeading: "Pregled eseja",
    versionLabel: "Verzija",
    versionOption: "v{version} · {words} riječi",
    statWords: "Riječi",
    statFootnotes: "Fusnote",
    statWorksCited: "Citirana djela",
    targetWords: "Cilj {target} riječi",
    progressAria: "Napredak prema ciljanom broju riječi",
    previewBlankPlaceholder: "Statistika, verzije i preuzimanje pojavit će se ovdje nakon kreiranja nacrta.",

    // DocxPaper
    pagePreviewHeading: "Pregled stranica",
    previewFit: "Uklopi",
    previewActual: "100%",
    previewExpand: "Proširi",
    draftingEssayPaper: "Pisanje vašeg eseja…",
    blankPaperTitle: "Za sada prazna stranica.",
    blankPaperHint: "Prođite kroz kontekst, strukturu i izvore. Vaš završeni esej bit će prikazan ovdje poput štampane stranice.",
    previewErrorFallback: "Pregled stranice nije uspio ({error}), prikazuje se tekstualni format. Preuzimanje i dalje radi.",

    // Footnotes card
    footnotesHeading: "Fusnote",
    footnotesTapHint: "Kliknite na broj fusnote u eseju da skočite na njen izvor.",
    accessedDate: "Pristupljeno {date}.",

    // Refine chat
    keepPromptingHeading: "Dalje prilagođavanje",
    refineDraftLabel: "Doradi nacrt",
    refiningVersion: "(izmjena v{version})",
    refinePlaceholderDisabled: "Vaš nacrt će se pojaviti iznad — zatim ovdje zatražite izmjene…",
    refinePlaceholderActive: "npr. Dodaj pasus o X — novi izvori se automatski preuzimaju…",
    refineHelp: "Svaka revizija kreira novu verziju. Slobodno tražite novi sadržaj — novi izvori se prikupljaju po potrebi.",
    sendButton: "Pošalji",
    revisingButton: "Prilagođavanje…",
    refineErrorEmpty: "Prvo opišite željenu izmjenu.",
    refineErrorNoProject: "Prvo napišite nacrt prije nego što ga doradite.",
    refineErrorMessage: "Nije uspjelo primijeniti izmjenu: {message}",

    // Expanded dialog
    expandedPreviewTitle: "Prošireni pregled eseja",
    closeExpanded: "✕ Zatvori",

    // Errors & footer
    outlineFailed: "Generisanje strukture nije uspjelo.",
    sourcesFailed: "Prikupljanje izvora nije uspjelo.",
    draftFailed: "Pisanje nacrta nije uspjelo.",
    oneShotFailed: "Generisanje eseja odjednom nije uspjelo.",
    footerText: "Struktura, izvori i nacrt ostaju usklađeni — odobrite svaku fazu da biste otključali sljedeću.",
  },
} as const;

export type TranslationKey = keyof typeof translations.en;

export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return key in params ? String(params[key]) : match;
  });
}

export function formatNumber(value: number, language: Language): string {
  return value.toLocaleString(language === "bs" ? "bs-BA" : "en-GB");
}
