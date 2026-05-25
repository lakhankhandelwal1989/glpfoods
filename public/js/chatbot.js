/**
 * GLP — Chatbot widget
 * Floating chat bubble that collects {name, phone, location} and POSTs to /api/leads.
 * Bilingual: pulls strings from window.GLP_I18N. Re-renders on language change.
 */
(function () {
  const STORAGE_KEY = 'glp-lead-submitted';

  class GLPChatbot {
    constructor() {
      this.state = {
        step: 'name',                       // name → phone → location → done
        data: { name: '', phone: '', location: '' },
        submitted: localStorage.getItem(STORAGE_KEY) === 'true',
        greeted: false
      };
      this.render();
      this.bindEvents();
      this.bindI18n();
    }

    t(key, vars) {
      return window.GLP_I18N ? window.GLP_I18N.t(key, vars) : key;
    }

    render() {
      const root = document.createElement('div');
      root.className = 'chatbot';
      root.innerHTML = `
        <button class="chatbot-toggle" type="button" data-i18n-aria="chat.open" aria-label="Open chat">
          <span class="chatbot-toggle-icon" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
            </svg>
          </span>
          <span class="chatbot-toggle-pulse" aria-hidden="true"></span>
        </button>

        <div class="chatbot-panel" role="dialog" aria-modal="true" aria-labelledby="chat-title">
          <header class="chatbot-header">
            <div class="chatbot-mark"><img src="/GLP_Logo.png" alt=""/></div>
            <div class="chatbot-title-wrap">
              <h4 id="chat-title" data-i18n="chat.title">Ganga Lehari</h4>
              <div class="chatbot-sub" data-i18n="chat.subtitle">Family Concierge</div>
            </div>
            <button class="chatbot-close" type="button" data-i18n-aria="chat.close" aria-label="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
            </button>
          </header>

          <div class="chatbot-messages" data-chatbot-messages></div>

          <form class="chatbot-input" data-chatbot-form>
            <input
              type="text"
              autocomplete="off"
              data-chatbot-input
              data-i18n-placeholder="chat.placeholder"
              placeholder="Type your reply…"
            />
            <button type="submit" data-i18n="chat.send">Send</button>
          </form>
        </div>
      `;
      document.body.appendChild(root);

      this.el = {
        root,
        toggle: root.querySelector('.chatbot-toggle'),
        panel: root.querySelector('.chatbot-panel'),
        close: root.querySelector('.chatbot-close'),
        messages: root.querySelector('[data-chatbot-messages]'),
        form: root.querySelector('[data-chatbot-form]'),
        input: root.querySelector('[data-chatbot-input]'),
      };
    }

    bindEvents() {
      this.el.toggle.addEventListener('click', () => this.open());
      this.el.close.addEventListener('click', () => this.close());
      this.el.form.addEventListener('submit', e => {
        e.preventDefault();
        this.handleSubmit();
      });

      // close on Escape
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && this.el.panel.classList.contains('open')) this.close();
      });
    }

    bindI18n() {
      // When language changes, re-greet (only if no conversation yet) and reset any error labels.
      document.addEventListener('glp:lang-change', () => {
        // Re-apply translations to inputs/labels already done by i18n.js.
        // If the user hasn't started, swap the greeting message to the new language.
        if (!this.state.greeted) return;
        if (this.state.submitted) return;
        if (this.state.step === 'name' && this.el.messages.children.length <= 1) {
          this.el.messages.innerHTML = '';
          this.state.greeted = false;
          if (this.el.panel.classList.contains('open')) this.greet();
        }
      });
    }

    open() {
      this.el.panel.classList.add('open');
      this.el.root.classList.add('open');
      if (!this.state.greeted) this.greet();
      setTimeout(() => this.el.input.focus(), 200);
    }

    close() {
      this.el.panel.classList.remove('open');
      this.el.root.classList.remove('open');
    }

    greet() {
      if (this.state.submitted) {
        this.bot(this.t('chat.already'));
      } else {
        this.bot(this.t('chat.greet'));
      }
      this.state.greeted = true;
    }

    bot(text) {
      const div = document.createElement('div');
      div.className = 'chatbot-msg bot';
      div.innerHTML = `<span>${text}</span>`;
      this.el.messages.appendChild(div);
      this.scrollToBottom();
    }

    user(text) {
      const div = document.createElement('div');
      div.className = 'chatbot-msg user';
      div.textContent = text;
      this.el.messages.appendChild(div);
      this.scrollToBottom();
    }

    scrollToBottom() {
      requestAnimationFrame(() => {
        this.el.messages.scrollTop = this.el.messages.scrollHeight;
      });
    }

    async handleSubmit() {
      const text = this.el.input.value.trim();
      if (!text) return;

      if (this.state.submitted) {
        this.user(text);
        this.el.input.value = '';
        setTimeout(() => this.bot(this.t('chat.already')), 350);
        return;
      }

      this.user(text);
      this.el.input.value = '';

      if (this.state.step === 'name') {
        if (text.length < 2 || text.length > 200) {
          setTimeout(() => this.bot(this.t('chat.invalidName')), 350);
          return;
        }
        this.state.data.name = text;
        this.state.step = 'phone';
        setTimeout(() => this.bot(this.t('chat.askPhone', { name: text })), 450);
        return;
      }

      if (this.state.step === 'phone') {
        const cleaned = text.replace(/[^0-9]/g, '');
        if (cleaned.length < 10 || cleaned.length > 13) {
          setTimeout(() => this.bot(this.t('chat.invalidPhone')), 350);
          return;
        }
        this.state.data.phone = cleaned;
        this.state.step = 'location';
        setTimeout(() => this.bot(this.t('chat.askLocation')), 450);
        return;
      }

      if (this.state.step === 'location') {
        if (text.length > 200) {
          this.state.data.location = text.slice(0, 200);
        } else {
          this.state.data.location = text;
        }

        const lang = window.GLP_I18N?.lang || 'en';
        try {
          const res = await fetch('/api/leads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...this.state.data, language: lang })
          });
          if (res.ok) {
            this.state.submitted = true;
            this.state.step = 'done';
            localStorage.setItem(STORAGE_KEY, 'true');
            setTimeout(() => this.bot(this.t('chat.thanks', { name: this.state.data.name })), 500);
          } else {
            setTimeout(() => this.bot(this.t('chat.error')), 350);
          }
        } catch (err) {
          console.error('[GLP] Lead submit error:', err);
          setTimeout(() => this.bot(this.t('chat.error')), 350);
        }
      }
    }
  }

  function start() {
    if (window.__glp_chatbot_started) return;
    window.__glp_chatbot_started = true;
    new GLPChatbot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
