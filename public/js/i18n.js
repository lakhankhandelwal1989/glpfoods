/**
 * GLP — i18n switcher
 * Applies translations to elements with [data-i18n] attributes.
 * Persists choice in localStorage. Emits 'glp:lang-change' on switch.
 */
(function () {
  const STORAGE_KEY = 'glp-lang';
  const DEFAULT_LANG = 'en';
  const SUPPORTED = ['en', 'hi'];

  const I18N = {
    lang: SUPPORTED.includes(localStorage.getItem(STORAGE_KEY)) ? localStorage.getItem(STORAGE_KEY) : DEFAULT_LANG,

    t(key, vars) {
      const dict = window.GLP_TRANSLATIONS?.[this.lang] || {};
      let s = dict[key] ?? key;
      if (vars && typeof s === 'string') {
        s = s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
      }
      return s;
    },

    apply() {
      const dict = window.GLP_TRANSLATIONS?.[this.lang] || {};

      document.documentElement.lang = this.lang;
      document.documentElement.dataset.lang = this.lang;

      // text/html content
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (dict[key] !== undefined) el.innerHTML = dict[key];
      });

      // input placeholders
      document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.dataset.i18nPlaceholder;
        if (dict[key] !== undefined) el.setAttribute('placeholder', dict[key]);
      });

      // aria labels
      document.querySelectorAll('[data-i18n-aria]').forEach(el => {
        const key = el.dataset.i18nAria;
        if (dict[key] !== undefined) el.setAttribute('aria-label', dict[key]);
      });

      // toggle button active state
      document.querySelectorAll('[data-lang-btn]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.langBtn === this.lang);
        btn.setAttribute('aria-pressed', String(btn.dataset.langBtn === this.lang));
      });

      // notify other modules
      document.dispatchEvent(new CustomEvent('glp:lang-change', { detail: { lang: this.lang } }));
    },

    set(lang) {
      if (!SUPPORTED.includes(lang)) return;
      this.lang = lang;
      localStorage.setItem(STORAGE_KEY, lang);
      this.apply();
    },

    init() {
      this.apply();
      document.querySelectorAll('[data-lang-btn]').forEach(btn => {
        btn.addEventListener('click', () => this.set(btn.dataset.langBtn));
      });
    }
  };

  window.GLP_I18N = I18N;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => I18N.init());
  } else {
    I18N.init();
  }
})();
