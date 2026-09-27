"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { formatNumber, interpolate, translations, type Language, type TranslationKey } from "@/lib/i18n";

interface LanguageContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  formatNumber: (value: number) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

const STORAGE_KEY = "essaywriter:language";

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>("en");

  useEffect(() => {
    const restore = setTimeout(() => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY) as Language | null;
        if (saved === "en" || saved === "bs") {
          setLanguageState(saved);
          document.documentElement.lang = saved;
        } else {
          const browserLang = navigator.language.toLowerCase();
          if (browserLang.startsWith("bs") || browserLang.startsWith("hr") || browserLang.startsWith("sr")) {
            setLanguageState("bs");
            document.documentElement.lang = "bs";
          }
        }
      } catch {
        // LocalStorage unavailable
      }
    }, 0);
    return () => clearTimeout(restore);
  }, []);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    try {
      localStorage.setItem(STORAGE_KEY, lang);
      document.documentElement.lang = lang;
    } catch {
      // LocalStorage unavailable
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>): string => {
      const dict = translations[language] || translations.en;
      const template = dict[key] || translations.en[key] || key;
      return interpolate(template, params);
    },
    [language]
  );

  const formatNum = useCallback(
    (value: number): string => {
      return formatNumber(value, language);
    },
    [language]
  );

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t, formatNumber: formatNum }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return ctx;
}
