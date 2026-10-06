/* =============================================================================
 * searchable-select.js — Kontrol dropdown yang bisa DICARI (filter + ketik sendiri)
 * -----------------------------------------------------------------------------
 * Dipakai pada Heatmap SOS (filter baris per kompartemen) & Heatmap VHMS
 * (filter kolom per grup/kompartemen parameter).
 *
 * API:
 *   var sel = SEARCHABLE_SELECT.create(inputEl, {
 *     placeholder: 'Cari kompartemen...',
 *     onChange: function (value) { ... }   // value = '' bila "Semua"
 *   });
 *   sel.setOptions([{ value: 'x', label: 'XXX', group: 'Engine' }, ...]);
 *   sel.setValue('x');   // set pilihan ('' = Semua)
 *   sel.getValue();
 *   sel.clear();
 *
 * Perilaku:
 *   - Klik input  -> buka daftar semua opsi.
 *   - Ketik       -> saring daftar (substring, case-insensitive).
 *   - Pilih opsi  -> isi input & panggil onChange.
 *   - Enter       -> pilih opsi pertama yang tersorot / cocok persis.
 *   - Esc / klik luar -> tutup daftar.
 *   - Opsi "Semua" selalu tersedia di paling atas untuk menampilkan semua.
 * ===========================================================================*/
(function (global) {
  'use strict';

  var ALL_VALUE = '';   // nilai khusus untuk "Semua"
  var _instances = [];

  function create(inputEl, opts) {
    if (!inputEl) return null;
    opts = opts || {};

    var wrap = inputEl.closest('.ssel') || (function () {
      // Bila input belum dibungkus .ssel, bungkus otomatis.
      var w = document.createElement('div');
      w.className = 'ssel';
      inputEl.parentNode.insertBefore(w, inputEl);
      w.appendChild(inputEl);
      return w;
    })();

    inputEl.setAttribute('autocomplete', 'off');
    inputEl.setAttribute('role', 'combobox');
    inputEl.setAttribute('aria-expanded', 'false');

    var list = document.createElement('div');
    list.className = 'ssel-list hidden';
    list.setAttribute('role', 'listbox');
    wrap.appendChild(list);

    var state = {
      options: [],       // [{ value, label, group }]
      value: '',
      open: false,
      activeIdx: -1
    };

    function close() {
      if (!state.open) return;
      state.open = false;
      list.classList.add('hidden');
      inputEl.setAttribute('aria-expanded', 'false');
    }

    function open() {
      state.open = true;
      list.classList.remove('hidden');
      inputEl.setAttribute('aria-expanded', 'true');
    }

    /** Opsi "Semua" selalu di atas. */
    function allOption() {
      return { value: ALL_VALUE, label: opts.allLabel || 'Semua', group: '' };
    }

    function matches(o, q) {
      if (!q) return true;
      return (o.label || '').toLowerCase().indexOf(q) !== -1 ||
             (o.group || '').toLowerCase().indexOf(q) !== -1;
    }

    function renderList() {
      var q = (inputEl.value || '').trim().toLowerCase();
      // Saat belum mengetik (atau input berisi label terpilih), tampilkan semua.
      var byLabel = state.selectedLabel || '';
      if (byLabel && inputEl.value === byLabel) q = '';

      var items = [allOption()].concat(state.options);
      var shown = items.filter(function (o) { return matches(o, q); });

      if (!shown.length) {
        list.innerHTML = '<div class="ssel-empty">Tidak ada hasil untuk “' +
          escapeHtml(inputEl.value) + '”.</div>';
        state._shown = [];
        state.activeIdx = -1;
        return;
      }

      var html = '';
      var lastGroup = '\u0000';
      shown.forEach(function (o, i) {
        if (o.group && o.group !== lastGroup) {
          html += '<div class="ssel-group">' + escapeHtml(o.group) + '</div>';
          lastGroup = o.group;
        }
        var active = (i === state.activeIdx) ? ' is-active' : '';
        var sel = (o.value === state.value) ? ' is-selected' : '';
        html += '<div class="ssel-opt' + active + sel + '" role="option" ' +
          'data-val="' + escapeAttr(o.value) + '" data-idx="' + i + '">' +
          escapeHtml(o.label) + '</div>';
      });
      list.innerHTML = html;
      state._shown = shown;
    }

    function commit(value) {
      state.value = value;
      var o = state.options.concat([allOption()]).filter(function (x) { return x.value === value; })[0];
      if (value === ALL_VALUE || !o) {
        inputEl.value = '';
        state.selectedLabel = '';
      } else {
        inputEl.value = o.label;
        state.selectedLabel = o.label;
      }
      close();
      if (typeof opts.onChange === 'function') opts.onChange(state.value);
    }

    function highlightIdx(i) {
      if (!state._shown || !state._shown.length) return;
      if (i < 0) i = 0;
      if (i >= state._shown.length) i = state._shown.length - 1;
      state.activeIdx = i;
      renderList();
      var node = list.querySelector('.ssel-opt.is-active');
      if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    }

    inputEl.addEventListener('focus', function () {
      open();
      state.activeIdx = -1;
      renderList();
    });

    inputEl.addEventListener('click', function () {
      open();
      renderList();
    });

    inputEl.addEventListener('input', function () {
      open();
      state.activeIdx = -1;
      renderList();
    });

    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault(); open(); highlightIdx(state.activeIdx + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); open(); highlightIdx(state.activeIdx - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!state.open) { open(); renderList(); return; }
        if (state.activeIdx >= 0 && state._shown && state._shown[state.activeIdx]) {
          commit(state._shown[state.activeIdx].value);
        } else {
          // Pilih opsi pertama yang cocok saat Enter tanpa navigasi.
          var q = (inputEl.value || '').trim().toLowerCase();
          var first = (state._shown || []).filter(function (o) {
            return o.value !== ALL_VALUE && (!q || (o.label || '').toLowerCase().indexOf(q) !== -1);
          })[0];
          if (first) commit(first.value);
          else if (!q) commit(ALL_VALUE);
        }
      } else if (e.key === 'Escape') {
        close();
      }
    });

    list.addEventListener('mousedown', function (e) {
      // mousedown (bukan click) agar tidak kehilangan fokus sebelum commit.
      var opt = e.target.closest ? e.target.closest('.ssel-opt') : null;
      if (!opt) return;
      e.preventDefault();
      commit(opt.getAttribute('data-val'));
    });

    // Tutup daftar saat klik di luar.
    document.addEventListener('mousedown', function (e) {
      if (!wrap.contains(e.target)) close();
    });

    var api = {
      setOptions: function (options) {
        state.options = (options || []).slice();
        renderList();
      },
      setValue: function (v) { commit(v); },
      getValue: function () { return state.value; },
      clear: function () { commit(ALL_VALUE); },
      close: close
    };
    _instances.push(api);
    return api;
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  // Tutup semua instance (dipakai saat ganti view).
  function closeAll() { _instances.forEach(function (i) { i.close(); }); }

  global.SEARCHABLE_SELECT = { create: create, closeAll: closeAll };
})(typeof window !== 'undefined' ? window : this);
