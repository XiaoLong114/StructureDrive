/* Shared UI behaviour: theme, navigation, menus, dialogs, snackbar, API. */
(function () {
  'use strict';

  const MC = (window.MC = window.MC || {});
  const root = document.documentElement;
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  MC.$ = $;
  MC.$$ = $$;

  MC.icon = function (name, cls = '') {
    return '<svg class="icon ' + cls + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  };

  MC.escape = function (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  };

  MC.formatSize = function (bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = n / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return value.toFixed(value >= 10 ? 0 : 1) + ' ' + units[i];
  };

  /* ---------------------------------------------------------------- theme */
  function syncThemeMeta() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', root.dataset.theme === 'dark' ? '#141218' : '#FEF7FF');
    }
  }

  MC.toggleTheme = function () {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('mccloud-theme', next); } catch (e) { /* ignore */ }
    syncThemeMeta();
    window.dispatchEvent(new CustomEvent('mccloud:themechange', { detail: { theme: next } }));
  };

  /* -------------------------------------------------------------- snackbar */
  let snackTimer = null;
  MC.snack = function (message, type, duration) {
    const el = $('#snackbar');
    if (!el) return;
    const text = $('.snackbar-text', el);
    if (text) text.textContent = message;
    el.classList.remove('error', 'success');
    if (type) el.classList.add(type);
    el.classList.add('show');
    clearTimeout(snackTimer);
    snackTimer = setTimeout(() => el.classList.remove('show'), duration || 4200);
  };

  function wireSnackbar() {
    const el = $('#snackbar');
    if (!el) return;
    $('.snackbar-close', el)?.addEventListener('click', () => el.classList.remove('show'));
    const flash = $('#flash-data');
    if (flash) {
      try {
        JSON.parse(flash.textContent || '[]').forEach(([category, message]) => {
          MC.snack(message, category === 'error' ? 'error' : category);
        });
      } catch (e) { /* ignore */ }
    }
  }

  /* ------------------------------------------------------------------ api */
  MC.api = async function (url, options) {
    options = options || {};
    const headers = Object.assign({}, options.headers || {});
    let body = options.body;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    }
    const method = options.method || 'GET';
    if (!/^(GET|HEAD|OPTIONS)$/i.test(method)) {
      const meta = document.querySelector('meta[name="csrf-token"]');
      if (meta) headers['X-CSRF-Token'] = meta.getAttribute('content');
    }
    const response = await fetch(url, {
      method: method,
      headers: headers,
      body: body,
      credentials: 'same-origin'
    });
    let data = null;
    try { data = await response.json(); } catch (e) { /* not json */ }
    if (!response.ok || (data && data.ok === false)) {
      const err = new Error((data && data.error) || ('请求失败（HTTP ' + response.status + '）'));
      err.status = response.status;
      err.data = data;
      throw err;
    }
    return data || { ok: true };
  };

  MC.upload = function (files, folderId, onProgress) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      if (folderId) form.append('folder_id', folderId);
      Array.from(files).forEach((file) => form.append('files', file, file.name));
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      const meta = document.querySelector('meta[name="csrf-token"]');
      if (meta) xhr.setRequestHeader('X-CSRF-Token', meta.getAttribute('content'));
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
      });
      xhr.addEventListener('load', () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText || '{}'); } catch (e) { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
          resolve(data);
        } else {
          const error = new Error((data && data.error) || (data && data.errors && data.errors[0]) || ('上传失败（HTTP ' + xhr.status + '）'));
          error.data = data;
          error.status = xhr.status;
          reject(error);
        }
      });
      xhr.addEventListener('error', () => reject(new Error('网络错误，上传失败。')));
      xhr.addEventListener('abort', () => reject(new Error('已取消上传。')));
      xhr.send(form);
    });
  };

  /* ---------------------------------------------------------------- dialogs */
  MC.openDialog = function (id) {
    const dialog = typeof id === 'string' ? document.getElementById(id) : id;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const field = dialog.querySelector('input[type="text"], input:not([type])');
    if (field) setTimeout(() => { field.focus(); field.select(); }, 30);
  };

  MC.closeDialog = function (id) {
    const dialog = typeof id === 'string' ? document.getElementById(id) : id;
    if (dialog && dialog.open) dialog.close();
  };

  function wireDialogs() {
    $$('[data-dialog-open]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        if (btn.tagName === 'A') event.preventDefault();
        MC.openDialog(btn.getAttribute('data-dialog-open'));
      });
    });
    $$('[data-dialog-close]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dialog = btn.closest('dialog');
        if (dialog) dialog.close();
      });
    });
    $$('dialog.md-dialog').forEach((dialog) => {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
    });
  }

  /* ----------------------------------------------------------------- menus */
  function closeMenus(except) {
    $$('.menu-popover.open').forEach((menu) => {
      if (menu === except) return;
      menu.classList.remove('open');
      const trigger = document.querySelector('[data-menu-target="' + menu.id + '"]');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
  }

  MC.closeMenus = closeMenus;

  function wireMenus() {
    $$('[data-menu-target]').forEach((trigger) => {
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const menu = document.getElementById(trigger.getAttribute('data-menu-target'));
        if (!menu) return;
        const willOpen = !menu.classList.contains('open');
        closeMenus(willOpen ? menu : null);
        menu.classList.toggle('open', willOpen);
        trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      });
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.menu-popover') && !event.target.closest('[data-menu-target]')) {
        closeMenus();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenus();
    });
    $$('.menu-item').forEach((item) => {
      item.addEventListener('click', () => closeMenus());
    });
  }

  /* ------------------------------------------------------------ navigation */
  function wireNav() {
    $$('[data-action="toggle-nav"]').forEach((btn) => {
      btn.addEventListener('click', () => document.body.classList.toggle('nav-open'));
    });
    $$('[data-action="close-nav"]').forEach((el) => {
      el.addEventListener('click', () => document.body.classList.remove('nav-open'));
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') document.body.classList.remove('nav-open');
    });
  }

  function wireSearch() {
    $$('.search-pill').forEach((pill) => {
      const input = $('input[type="search"]', pill);
      const clear = $('.search-clear', pill);
      if (!input) return;
      const sync = () => pill.classList.toggle('has-value', input.value.length > 0);
      input.addEventListener('input', sync);
      sync();
      if (clear) {
        clear.addEventListener('click', () => {
          input.value = '';
          sync();
          if (input.form) input.form.submit();
          else {
            const url = new URL(location.href);
            url.searchParams.delete('q');
            location.assign(url);
          }
        });
      }
    });
    $$('.search-pill form').forEach((form) => {
      form.addEventListener('submit', () => {
        const input = form.querySelector('input[type="search"]');
        if (input && input.value.trim() === '') input.disabled = true;
      });
    });
  }

  function wireTheme() {
    $$('[data-action="toggle-theme"]').forEach((btn) => {
      btn.addEventListener('click', MC.toggleTheme);
    });
    syncThemeMeta();
  }

  function wireMisc() {
    $$('[data-action="back"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (history.length > 1) history.back();
        else location.assign('/drive');
      });
    });
  }

  function init() {
    wireTheme();
    wireNav();
    wireSearch();
    wireMenus();
    wireDialogs();
    wireSnackbar();
    wireMisc();
    document.documentElement.classList.add('js-ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
