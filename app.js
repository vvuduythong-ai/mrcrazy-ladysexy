/**
 * app.js — state, password gate, view routing, rendering.
 *
 * Data flow: user types password (kept in sessionStorage) -> fetch the Apps Script
 * Web App per view -> render. Derived metrics are computed server-side (Aggregate)
 * and lightly re-formatted here. Recommendations come from recommend.js.
 */
(function () {
  'use strict';

  var API = (window.APP_CONFIG && window.APP_CONFIG.APPS_SCRIPT_URL) || '';
  var PWD_KEY = 'mcals_pwd';
  var state = { view: 'overview', range: '30d', settings: {}, detail: null };

  // ---- helpers ----------------------------------------------------------
  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function pwd() { return sessionStorage.getItem(PWD_KEY) || ''; }
  function setPwd(v) { sessionStorage.setItem(PWD_KEY, v); }
  function clearPwd() { sessionStorage.removeItem(PWD_KEY); }

  function fmtVnd(v) {
    if (v === null || v === undefined || v === '' || isNaN(Number(v))) return 'N/A';
    return Math.round(Number(v)).toLocaleString('vi-VN') + '₫';
  }
  function fmtNum(v) {
    if (v === null || v === undefined || v === '') return '0';
    return Math.round(Number(v)).toLocaleString('vi-VN');
  }
  function fmtPct(v) {
    if (v === null || v === undefined || v === '') return 'N/A';
    return (Number(v) * 100).toFixed(0) + '%';
  }

  // ---- API --------------------------------------------------------------
  function api(view, range) {
    var url = API + '?pwd=' + encodeURIComponent(pwd()) +
      '&view=' + encodeURIComponent(view) + '&range=' + encodeURIComponent(range);
    return fetch(url).then(function (r) { return r.json(); });
  }

  // ---- gate -------------------------------------------------------------
  function showGate(err) {
    $('#app').hidden = true;
    $('#gate').hidden = false;
    var e = $('#gateErr');
    // err can be a boolean (legacy) or a custom message string.
    if (typeof err === 'string' && err) { e.textContent = err; e.hidden = false; }
    else { e.hidden = !err; }
  }
  function showApp() {
    $('#gate').hidden = true;
    $('#app').hidden = false;
  }

  function tryLogin(p) {
    setPwd(p);
    return api('overview', state.range).then(function (res) {
      if (res && res.ok) {
        state.settings = res.settings || {};
        showApp();
        render(); // re-fetch current view
        return true;
      }
      clearPwd();
      // Distinguish a real wrong-password from a server/data error.
      var msg = (res && res.error === 'unauthorized')
        ? 'Sai mật khẩu.'
        : 'Lỗi máy chủ: ' + ((res && res.error) || 'không rõ') + '. Kiểm tra deployment.';
      showGate(msg);
      return false;
    }).catch(function (e) {
      clearPwd();
      console.error('Login fetch failed:', e);
      showGate('Không gọi được API (mạng/URL/CORS). Mở Console (F12) xem chi tiết.');
      return false;
    });
  }

  // ---- rendering --------------------------------------------------------
  function setStatus(msg) {
    var s = $('#status');
    if (!msg) { s.hidden = true; s.textContent = ''; return; }
    s.hidden = false; s.textContent = msg;
  }

  // In-memory cache of the last good response per view+range, so switching tabs is
  // instant: paint the cached view immediately, then refresh silently in the background.
  var viewCache = {};

  function paint(host, res) {
    state.settings = res.settings || state.settings;
    $('#genAt').textContent = 'Cập nhật: ' + new Date(res.generatedAt).toLocaleString('vi-VN');
    $('#kpiTarget').textContent = fmtVnd(state.settings.cost_per_message_target || 80000);
    host.innerHTML = '';
    var r = { overview: renderOverview, funnel: renderFunnel, pillar: renderBreakdown,
      product: renderBreakdown, ta: renderBreakdown, ads: renderAds }[state.view];
    r(host, res.data);
  }

  function render() {
    var host = $('#view');
    // Product drill-down takes over the Product tab when a product is selected.
    if (state.view === 'product' && state.detail) { return openProductDetail(state.detail.slug); }
    var key = state.view + '|' + state.range;
    var cached = viewCache[key];
    if (cached) { paint(host, cached); setStatus('Đang cập nhật…'); }
    else { host.innerHTML = '<div class="loading">Đang tải…</div>'; setStatus(''); }

    api(state.view, state.range).then(function (res) {
      if (!res || !res.ok) { if (!cached) showGate(true); setStatus(''); return; }
      viewCache[key] = res;
      paint(host, res);
      setStatus('');
    }).catch(function (e) {
      setStatus('');
      if (!cached) host.innerHTML = '<div class="loading error">Lỗi tải dữ liệu: ' + e + '</div>';
    });
  }

  function renderOverview(host, data) {
    var t = data.totals || {};
    var target = Number(state.settings.cost_per_message_target || 80000);
    var cpcClass = (t.cost_per_conv != null && t.cost_per_conv <= target) ? 'good' : 'bad';

    var cards = el('div', 'cards');
    cards.appendChild(card('Tổng chi', fmtVnd(t.spend)));
    cards.appendChild(card('Tin nhắn (mới/cũ)', fmtNum(t.conv_started),
      fmtNum(t.new_contacts) + ' mới · ' + fmtNum(t.returning_contacts) + ' cũ'));
    cards.appendChild(card('Cost / tin nhắn', fmtVnd(t.cost_per_conv),
      'mục tiêu ' + fmtVnd(target), cpcClass));
    cards.appendChild(card('Đơn (Meta)', t.purchases ? fmtNum(t.purchases) : 'N/A',
      t.roas != null ? 'ROAS ' + t.roas : 'ROAS N/A'));
    host.appendChild(cards);

    var p = el('div', 'panel');
    p.appendChild(el('h2', null, 'Xu hướng cost/tin nhắn theo ngày'));
    var wrap = el('div', 'chart-wrap'); wrap.appendChild(el('canvas')).id = 'trendChart';
    p.appendChild(wrap);
    host.appendChild(p);
    Charts.trendLine('trendChart', data.trend || []);
  }

  function renderFunnel(host, data) {
    var f = data.messenger || [];
    var max = Math.max.apply(null, f.map(function (s) { return s.value; }).concat([1]));
    var p = el('div', 'panel');
    p.appendChild(el('h2', null, 'Phễu Messenger'));
    var fn = el('div', 'funnel');
    var prev = null;
    f.forEach(function (s) {
      var row = el('div', 'funnel-row');
      row.appendChild(el('div', null, s.stage));
      var barWrap = el('div');
      var bar = el('div', 'funnel-bar');
      bar.style.width = Math.max(2, (s.value / max) * 100) + '%';
      barWrap.appendChild(bar);
      row.appendChild(barWrap);
      var drop = prev && prev > 0 ? ' · ' + Math.round((1 - s.value / prev) * 100) + '% rớt' : '';
      row.appendChild(el('div', 'funnel-meta', fmtNum(s.value) + drop));
      fn.appendChild(row);
      prev = s.value;
    });
    p.appendChild(fn);
    p.appendChild(el('p', 'muted', 'Reply rate: ' + fmtPct(data.reply_rate) +
      ' · Đơn = Meta ghi nhận (thường thiếu).'));
    host.appendChild(p);
  }

  function renderBreakdown(host, rows) {
    var labelKey = 'key';
    // charts
    var p = el('div', 'panel');
    p.appendChild(el('h2', null, 'Cost/tin nhắn theo ' + viewLabel()));
    var wrap = el('div', 'chart-wrap'); wrap.appendChild(el('canvas')).id = 'bdChart';
    p.appendChild(wrap);
    host.appendChild(p);

    var p2 = el('div', 'panel');
    p2.appendChild(el('h2', null, 'Chia chi tiêu'));
    var wrap2 = el('div', 'chart-wrap'); wrap2.appendChild(el('canvas')).id = 'shareChart';
    p2.appendChild(wrap2);
    host.appendChild(p2);

    // table — on the Product tab, rows are clickable to drill into detail.
    var isProduct = state.view === 'product';
    if (isProduct) host.appendChild(el('p', 'muted hint', '👆 Bấm vào một sản phẩm để xem pillar / content / phễu chi tiết.'));
    var onClick = isProduct ? function (row) { openProductDetail(row.key); } : null;
    host.appendChild(tableFrom(rows, [
      { k: labelKey, t: viewLabel(), fmt: function (v) { return v || '(không rõ)'; }, left: true },
      { k: 'spend', t: 'Chi', fmt: fmtVnd },
      { k: 'conv_started', t: 'Tin nhắn', fmt: fmtNum },
      { k: 'cost_per_conv', t: 'Cost/tin', fmt: fmtVnd },
      { k: 'reply_rate', t: 'Reply', fmt: fmtPct },
      { k: 'verdict', t: 'Đề xuất', fmt: verdictPill, html: true }
    ], onClick));

    Charts.breakdownBar('bdChart', rows, labelKey);
    Charts.spendShare('shareChart', rows, labelKey);

    var recs = Recommend.summarize(rows, state.settings, labelKey);
    if (recs.length) host.appendChild(recsPanel(recs));
  }

  // ---- product drill-down ----------------------------------------------
  function openProductDetail(slug) {
    state.detail = { slug: slug };
    var host = $('#view');
    var key = 'ads|' + state.range;
    var cached = viewCache[key];
    if (cached) renderProductDetail(host, slug, cached.data);
    else { host.innerHTML = '<div class="loading">Đang tải…</div>'; setStatus(''); }
    api('ads', state.range).then(function (res) {
      if (!res || !res.ok) { if (!cached) showGate(true); return; }
      viewCache[key] = res;
      if (state.detail && state.detail.slug === slug) renderProductDetail(host, slug, res.data);
    }).catch(function (e) {
      if (!cached) host.innerHTML = '<div class="loading error">Lỗi tải dữ liệu: ' + e + '</div>';
    });
  }

  function funnelDiagnosis(t) {
    // Identify where the messenger funnel leaks worst and phrase it.
    var target = Number(state.settings.cost_per_message_target || 80000);
    var bench = Number(state.settings.reply_rate_benchmark || 0.4);
    if (t.conv_started === 0) return { level: 'warn', text: 'Chưa có tin nhắn nào — chưa đủ dữ liệu để chẩn đoán phễu.' };
    if (t.reply_rate < bench) return { level: 'fix', text: 'Rớt mạnh ở khâu KHÁCH NHẮN LẠI: reply rate ' + fmtPct(t.reply_rate) + ' < benchmark ' + fmtPct(bench) + '. Soi lời chào / tốc độ rep / chất lượng traffic.' };
    if (t.cost_per_conv != null && t.cost_per_conv > target) return { level: 'fix', text: 'Tin nhắn đắt: ' + fmtVnd(t.cost_per_conv) + ' > mục tiêu ' + fmtVnd(target) + '. Khâu Click→Tin nhắn chưa hiệu quả (creative/đối tượng).' };
    if (t.purchases === 0 && t.conv_replied >= 3) return { level: 'fix', text: 'Hội thoại tốt nhưng 0 đơn (Meta ghi nhận). Soi khâu CHỐT/giá — hoặc thiếu attribution.' };
    return { level: 'scale', text: 'Phễu khỏe: tin nhắn rẻ, reply rate tốt. Cân nhắc tăng ngân sách / nhân bản.' };
  }

  function renderProductDetail(host, slug, adsRows) {
    var rows = (adsRows || []).filter(function (r) { return String(r.product_slug) === String(slug); });
    host.innerHTML = '';

    // Back link
    var back = el('button', 'backlink', '← Quay lại Sản phẩm');
    back.addEventListener('click', function () { state.detail = null; render(); });
    host.appendChild(back);

    var name = (rows[0] && rows[0].product_name) || slug || '(không rõ)';
    var t = sumRows(rows);
    host.appendChild(el('h2', 'detail-title', name + '  ·  ' + slug));

    if (!rows.length) {
      host.appendChild(el('p', 'muted', 'Không có ad nào cho sản phẩm này trong khoảng thời gian đã chọn.'));
      return;
    }

    // KPI cards
    var target = Number(state.settings.cost_per_message_target || 80000);
    var cards = el('div', 'cards');
    cards.appendChild(card('Tổng chi', fmtVnd(t.spend)));
    cards.appendChild(card('Tin nhắn', fmtNum(t.conv_started)));
    cards.appendChild(card('Cost / tin nhắn', fmtVnd(t.cost_per_conv),
      'mục tiêu ' + fmtVnd(target), (t.cost_per_conv != null && t.cost_per_conv <= target) ? 'good' : 'bad'));
    cards.appendChild(card('Đơn (Meta)', t.purchases ? fmtNum(t.purchases) : 'N/A',
      t.roas != null ? 'ROAS ' + t.roas : 'ROAS N/A'));
    host.appendChild(cards);

    // Funnel for this product + diagnosis
    var fp = el('div', 'panel');
    fp.appendChild(el('h2', null, 'Phễu của sản phẩm này'));
    var stages = [
      { stage: 'Impressions', value: t.impressions },
      { stage: 'Clicks', value: t.clicks },
      { stage: 'Tin nhắn bắt đầu', value: t.conv_started },
      { stage: 'Khách nhắn lại', value: t.conv_replied },
      { stage: 'Đơn (Meta)', value: t.purchases }
    ];
    var max = Math.max.apply(null, stages.map(function (s) { return s.value; }).concat([1]));
    var fn = el('div', 'funnel');
    var prev = null;
    stages.forEach(function (s) {
      var row = el('div', 'funnel-row');
      row.appendChild(el('div', null, s.stage));
      var bw = el('div'); var bar = el('div', 'funnel-bar');
      bar.style.width = Math.max(2, (s.value / max) * 100) + '%'; bw.appendChild(bar);
      row.appendChild(bw);
      var drop = prev && prev > 0 ? ' · ' + Math.round((1 - s.value / prev) * 100) + '% rớt' : '';
      row.appendChild(el('div', 'funnel-meta', fmtNum(s.value) + drop));
      fn.appendChild(row); prev = s.value;
    });
    fp.appendChild(fn);
    var dg = funnelDiagnosis(t);
    var diag = el('div', 'rec'); diag.style.marginTop = '12px';
    diag.appendChild(el('span', 'pill ' + (dg.level === 'scale' ? 'scale' : dg.level === 'fix' ? 'fix' : 'warn'), 'Phễu'));
    diag.appendChild(el('div', 'body', dg.text));
    fp.appendChild(diag);
    host.appendChild(fp);

    // Breakdown by Pillar (for this product)
    var pillars = groupBy(rows, 'pillar');
    var pp = el('div', 'panel');
    pp.appendChild(el('h2', null, 'Theo Pillar (sản phẩm này)'));
    pp.appendChild(el('p', 'muted', 'Pillar nào ra tin nhắn rẻ nhất cho sản phẩm này.'));
    host.appendChild(pp);
    host.appendChild(tableFrom(pillars, [
      { k: 'key', t: 'Pillar', fmt: function (v) { return v || '—'; }, left: true },
      { k: 'spend', t: 'Chi', fmt: fmtVnd },
      { k: 'conv_started', t: 'Tin nhắn', fmt: fmtNum },
      { k: 'cost_per_conv', t: 'Cost/tin', fmt: fmtVnd },
      { k: 'reply_rate', t: 'Reply', fmt: fmtPct },
      { k: 'verdict', t: 'Đề xuất', fmt: verdictPill, html: true }
    ]));

    // Content list (every ad under this product)
    var cp = el('div', 'panel');
    cp.appendChild(el('h2', null, 'Content / Ad (' + rows.length + ')'));
    host.appendChild(cp);
    host.appendChild(tableFrom(rows, [
      { k: 'ad_name', t: 'Ad', fmt: function (v) { return v; }, left: true },
      { k: 'format', t: 'Format', fmt: function (v) { return v || '—'; }, left: true },
      { k: 'pillar', t: 'Pillar', fmt: function (v) { return v || '—'; }, left: true },
      { k: 'spend', t: 'Chi', fmt: fmtVnd },
      { k: 'conv_started', t: 'Tin nhắn', fmt: fmtNum },
      { k: 'cost_per_conv', t: 'Cost/tin', fmt: fmtVnd },
      { k: 'reply_rate', t: 'Reply', fmt: fmtPct },
      { k: 'verdict', t: 'Đề xuất', fmt: verdictPill, html: true }
    ]));
  }

  function renderAds(host, rows) {
    var unmapped = rows.filter(function (r) { return !r.mapped; });
    if (unmapped.length) {
      var w = el('div', 'panel warn-block');
      w.appendChild(el('h2', null, '⚠ Data hygiene — ' + unmapped.length + ' ad cần sửa tên (mapped=FALSE)'));
      w.appendChild(tableFrom(unmapped, [
        { k: 'ad_name', t: 'Ad name', fmt: function (v) { return v; }, left: true },
        { k: 'campaign_name', t: 'Campaign', fmt: function (v) { return v; }, left: true },
        { k: 'spend', t: 'Chi', fmt: fmtVnd }
      ]));
      host.appendChild(w);
    }
    host.appendChild(tableFrom(rows, [
      { k: 'ad_name', t: 'Ad', fmt: function (v) { return v; }, left: true },
      { k: 'format', t: 'Format', fmt: function (v) { return v || '—'; }, left: true },
      { k: 'pillar', t: 'Pillar', fmt: function (v) { return v || '—'; }, left: true },
      { k: 'ta', t: 'TA', fmt: function (v) { return v || '—'; }, left: true },
      { k: 'spend', t: 'Chi', fmt: fmtVnd },
      { k: 'conv_started', t: 'Tin nhắn', fmt: fmtNum },
      { k: 'cost_per_conv', t: 'Cost/tin', fmt: fmtVnd },
      { k: 'reply_rate', t: 'Reply', fmt: fmtPct },
      { k: 'verdict', t: 'Đề xuất', fmt: verdictPill, html: true }
    ]));
  }

  // ---- small render utils ----------------------------------------------
  function viewLabel() {
    return { pillar: 'Pillar', product: 'Sản phẩm', ta: 'TA' }[state.view] || state.view;
  }
  function card(label, value, sub, cls) {
    var c = el('div', 'card');
    c.appendChild(el('div', 'label', label));
    c.appendChild(el('div', 'value' + (cls ? ' ' + cls : ''), value));
    if (sub) c.appendChild(el('div', 'sub', sub));
    return c;
  }
  function verdictPill(_, row) {
    var c = Recommend.classify(row, state.settings);
    if (!c) return '';
    var cls = { SCALE: 'scale', CUT: 'cut', FIX_CONV: 'fix', FIX_CLOSE: 'fix', WATCH: 'warn', OK: 'warn' }[c.tag] || 'warn';
    return '<span class="pill ' + cls + '" title="' + c.reason.replace(/"/g, '') + '">' + c.tag + '</span>';
  }
  function recsPanel(recs) {
    var p = el('div', 'panel');
    p.appendChild(el('h2', null, 'Đề xuất tối ưu'));
    var box = el('div', 'recs');
    recs.forEach(function (r) {
      var cls = { CUT: 'cut', FIX_CONV: 'fix', FIX_CLOSE: 'fix', SCALE: 'scale' }[r.tag] || 'warn';
      var row = el('div', 'rec');
      row.appendChild(el('span', 'pill ' + cls, r.tag));
      row.appendChild(el('div', 'body', '<b>' + r.label + '</b>' + r.reason));
      box.appendChild(row);
    });
    p.appendChild(box);
    return p;
  }
  function tableFrom(rows, cols, onRowClick) {
    var wrap = el('div', 'panel');
    var scroll = el('div', 'table-scroll');
    var table = el('table');
    var thead = el('thead'), trh = el('tr');
    cols.forEach(function (c) { trh.appendChild(el('th', c.left ? 'l' : null, c.t)); });
    thead.appendChild(trh); table.appendChild(thead);
    var tbody = el('tbody');
    (rows || []).forEach(function (row) {
      var tr = el('tr');
      if (onRowClick) {
        tr.className = 'clickable';
        tr.addEventListener('click', function () { onRowClick(row); });
      }
      cols.forEach(function (c) {
        var raw = row[c.k];
        var val = c.fmt ? c.fmt(raw, row) : raw;
        var td = el('td');
        if (c.html) td.innerHTML = val; else td.textContent = val;
        if (c.left) td.style.textAlign = 'left';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody); scroll.appendChild(table); wrap.appendChild(scroll);
    return wrap;
  }

  // ---- client-side aggregation helpers (for drill-down) -----------------
  function numv(v) { var x = Number(v); return isNaN(x) ? 0 : x; }
  function sumRows(rows) {
    var t = { spend: 0, impressions: 0, clicks: 0, link_clicks: 0, conv_started: 0,
      conv_replied: 0, welcome_views: 0, new_contacts: 0, returning_contacts: 0,
      total_contacts: 0, purchases: 0, purchase_value: 0 };
    (rows || []).forEach(function (r) {
      Object.keys(t).forEach(function (k) { t[k] += numv(r[k]); });
    });
    t.ctr = t.impressions > 0 ? +(t.clicks / t.impressions * 100).toFixed(2) : 0;
    t.reply_rate = t.conv_started > 0 ? +(t.conv_replied / t.conv_started).toFixed(3) : 0;
    t.cost_per_conv = t.conv_started > 0 ? Math.round(t.spend / t.conv_started) : null;
    t.roas = (t.purchase_value > 0 && t.spend > 0) ? +(t.purchase_value / t.spend).toFixed(2) : null;
    return t;
  }
  function groupBy(rows, key) {
    var map = {};
    (rows || []).forEach(function (r) {
      var k = String(r[key] || '(none)');
      (map[k] = map[k] || []).push(r);
    });
    return Object.keys(map).map(function (k) {
      var t = sumRows(map[k]); t.key = k; t._rows = map[k]; return t;
    }).sort(function (a, b) { return b.spend - a.spend; });
  }

  // ---- wiring -----------------------------------------------------------
  function init() {
    if (!API || API.indexOf('XXXX') !== -1) {
      showGate(false);
      setTimeout(function () {
        $('#gateErr').hidden = false;
        $('#gateErr').textContent = 'Chưa cấu hình APPS_SCRIPT_URL trong config.js.';
      }, 0);
    }

    $('#gateForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var p = $('#pwd').value.trim();
      if (!p) return;
      // Apps Script can take 3-5s — show progress so the button doesn't feel dead.
      var btn = this.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Đang mở…';
      tryLogin(p).then(function (ok) {
        if (!ok) { btn.disabled = false; btn.textContent = 'Mở dashboard'; }
      });
    });
    $('#tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-view]');
      if (!b) return;
      $('#tabs').querySelectorAll('button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      state.view = b.getAttribute('data-view');
      state.detail = null; // leaving/returning to a tab resets any drill-down
      render();
    });
    $('#range').addEventListener('change', function (e) { state.range = e.target.value; render(); });
    $('#refresh').addEventListener('click', render);
    $('#logout').addEventListener('click', function () { clearPwd(); showGate(false); });

    // Auto-login if a session password exists.
    if (pwd()) tryLogin(pwd()); else showGate(false);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
