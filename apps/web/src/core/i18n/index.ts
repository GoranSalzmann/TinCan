// SPDX-License-Identifier: AGPL-3.0-or-later
import { IntlMessageFormat } from "intl-messageformat";
import { create } from "zustand";
import en from "./en.json";
import { pseudoLocalize } from "./pseudo.js";

/**
 * i18n scaffold (style guide §12): every string has a key `module.area.name`, messages are ICU
 * MessageFormat, English is the source locale. Pseudo-locales exist in development builds to catch
 * hard-coded strings, clipping and mirroring bugs.
 */

export type Locale = "en" | "en-XA" | "ar-XB";
export type MessageKey = keyof typeof en;
export type Values = Record<string, string | number>;

const catalogs: Record<string, Record<string, string>> = { en };
const cache = new Map<string, IntlMessageFormat>();

export const PSEUDO_LOCALES: Locale[] = import.meta.env.DEV ? ["en-XA", "ar-XB"] : [];

export function directionOf(locale: Locale): "ltr" | "rtl" {
  return locale === "ar-XB" ? "rtl" : "ltr";
}

export function format(locale: Locale, key: string, values?: Values): string {
  const source = catalogs.en?.[key];
  if (source === undefined) return key; // a missing key shows itself, which a test catches
  const base = locale === "en-XA" || locale === "ar-XB" ? "en" : locale;
  const cacheKey = `${base}\u0000${key}`;
  let fmt = cache.get(cacheKey);
  if (!fmt) {
    fmt = new IntlMessageFormat(catalogs[base]?.[key] ?? source, base);
    cache.set(cacheKey, fmt);
  }
  const text = String(fmt.format(values));
  return locale === "en" ? text : pseudoLocalize(text, locale);
}

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useLocale = create<LocaleState>((set) => ({
  locale: "en",
  setLocale(locale) {
    set({ locale });
    document.documentElement.lang = locale === "ar-XB" ? "ar" : "en";
    document.documentElement.dir = directionOf(locale);
  },
}));

/** `const t = useT(); t("login.submit")`. Re-renders when the locale changes. */
export function useT(): (key: MessageKey, values?: Values) => string {
  const locale = useLocale((s) => s.locale);
  return (key, values) => format(locale, key, values);
}

export function formatList(locale: Locale, items: string[]): string {
  return new Intl.ListFormat(locale === "ar-XB" ? "ar" : "en", { style: "long", type: "conjunction" }).format(
    items,
  );
}
