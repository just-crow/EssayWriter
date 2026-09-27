"use client";

import { useLanguage } from "./LanguageContext";

export default function LanguageSwitch() {
  const { language, setLanguage, t } = useLanguage();

  return (
    <div
      role="group"
      aria-label={t("languageSelect")}
      className="inline-flex items-center rounded-lg border border-stone-300 bg-stone-100 p-0.5 text-xs font-semibold shadow-sm dark:border-stone-700 dark:bg-stone-800"
    >
      <button
        type="button"
        onClick={() => setLanguage("en")}
        aria-pressed={language === "en"}
        title="English"
        className={`rounded-md px-2.5 py-1 transition active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 ${
          language === "en"
            ? "bg-white font-bold text-emerald-900 shadow-sm dark:bg-stone-900 dark:text-emerald-400"
            : "text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-200"
        }`}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => setLanguage("bs")}
        aria-pressed={language === "bs"}
        title="Bosanski"
        className={`rounded-md px-2.5 py-1 transition active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 ${
          language === "bs"
            ? "bg-white font-bold text-emerald-900 shadow-sm dark:bg-stone-900 dark:text-emerald-400"
            : "text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-200"
        }`}
      >
        BS
      </button>
    </div>
  );
}
