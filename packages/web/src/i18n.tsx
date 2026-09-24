import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Two languages, English and Italian, and nothing more elaborate than that.
 *
 * Copy is written inline as pairs, `t('Search', 'Cerca')`, next to where it is
 * used, so a sentence and its translation are read and changed together. A
 * key-based catalogue would move every string away from its component for a
 * site that has exactly two languages and no translators.
 *
 * The corpus stays English. So do the quotes an answer cites, because
 * verification checks them character for character against the English
 * source; only the answer's own sentences follow the chosen language.
 */

export type Lang = 'en' | 'it';

type Ctx = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  /** Pick the copy for the current language. */
  t: <T extends ReactNode>(en: T, it: T) => T;
  /** Number formatting for the current language: 1,592 or 1.592. */
  num: (value: number, digits?: number) => string;
  locale: string;
};

const LangContext = createContext<Ctx | null>(null);

const STORE = 'lang';

function initial(): Lang {
  try {
    const param = new URLSearchParams(location.search).get('lang');
    if (param === 'it' || param === 'en') return param;
    const saved = localStorage.getItem(STORE);
    if (saved === 'it' || saved === 'en') return saved;
  } catch {
    // Storage can be blocked; the browser language is the fallback.
  }
  return navigator.language.toLowerCase().startsWith('it') ? 'it' : 'en';
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial);

  useEffect(() => {
    // 3.1.1 Language of Page: a screen reader pronounces by this attribute.
    document.documentElement.lang = lang;
    document.title =
      lang === 'it' ? 'Retrieval ibrido con citazioni verificate' : 'Hybrid retrieval with verified citations';
  }, [lang]);

  const value = useMemo<Ctx>(() => {
    const locale = lang === 'it' ? 'it-IT' : 'en-GB';
    return {
      lang,
      locale,
      setLang: (next) => {
        setLangState(next);
        try {
          localStorage.setItem(STORE, next);
        } catch {
          // A preference that cannot be saved still applies for this visit.
        }
      },
      t: (en, it) => (lang === 'it' ? it : en),
      num: (value, digits) =>
        value.toLocaleString(locale, digits === undefined ? undefined : { minimumFractionDigits: digits, maximumFractionDigits: digits }),
    };
  }, [lang]);

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): Ctx {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('useLang outside LangProvider');
  return ctx;
}

/** The switch: two buttons, the current one pressed, each named in its own language. */
export function LangSwitch() {
  const { lang, setLang, t } = useLang();
  const option = (value: Lang, label: string, name: string) => (
    <button
      type="button"
      lang={value}
      aria-pressed={lang === value}
      aria-label={name}
      onClick={() => setLang(value)}
      className={`rounded-full px-2.5 py-1 font-mono text-xs transition-colors ${
        lang === value ? 'bg-ink text-paper' : 'text-ink-2 hover:text-ink'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label={t('Language', 'Lingua')} className="flex gap-0.5 rounded-full border border-line p-0.5">
      {option('en', 'EN', 'English')}
      {option('it', 'IT', 'Italiano')}
    </div>
  );
}
