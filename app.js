/**
 * app.js — single-page interactive dashboard.
 *
 * One page: Overview (KPIs + overall funnel + trend) always on top, then an
 * "Explore" section with a Group-by toggle (Product / Pillar / TA). Clicking a row
 * drills into a detail view (that group's funnel + sub-breakdown + content list).
 *
 * Everything below the trend is computed CLIENT-SIDE from the `ads` endpoint
 * (one row per ad with all metrics + identity). The daily trend comes from `overview`.
 */
(function () {
  'use strict';

  var API = (window.APP_CONFIG && window.APP_CONFIG.APPS_SCRIPT_URL) || '';
  var PWD_KEY = 'mcals_pwd';
  var state = { range: '30d', groupBy: 'product_slug', detail: null, settings: {} };
  var cache = {}; // range -> { ads: res, overview: res }

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
  function numv(v) { var x = Number(v); return isNaN(x) ? 0 : x; }

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
    if (typeof err === 'string' && err) { e.textContent = err; e.hidden = false; }
    else { e.hidden = !err; }
  }
  function showApp() { $('#gate').hidden = true; $('#app').hidden = false; }

  function tryLogin(p) {
    setPwd(p);
    return api('ads', state.range).then(function (res) {
      if (res && res.ok) { showApp(); load(); return true; }
      clearPwd();
      showGate(res && res.error === 'unauthorized'
        ? 'Sai mật khẩu.'
        : 'Lỗi máy chủ: ' + ((res && res.error) || 'không rõ') + '. Kiểm tra deployment.');
      return false;
    }).catch(function (e) {
      clearPwd();
      console.error('Login fetch failed:', e);
      showGate('Không gọi được API (mạng/URL/CORS). Mở Console (F12) xem chi tiết.');
      return false;
    });
  }

  // ---- data load --------------------------------------------------------
  function setStatus(msg) {
    var s = $('#status');
    if (!msg) { s.hidden = true; s.textContent = ''; return; }
    s.hidden = false; s.textContent = msg;
  }

  function load() {
    var host = $('#view');
    var c = cache[state.range];
    if (c && c.ads) { renderPage(); setStatus('Đang cập nhật…'); }
    else { host.innerHTML = '<div class="loading">Đang tải…</div>'; setStatus(''); }

    Promise.all([api('ads', state.range), api('overview', state.range)])
      .then(function (r) {
        var ads = r[0], ov = r[1];
        if (!ads || !ads.ok) {
          if (!c) showGate(ads && ads.error === 'unauthorized' ? 'Sai mật khẩu.' : true);
          setStatus(''); return;
        }
        state.settings = ads.settings || state.settings;
        cache[state.range] = { ads: ads, overview: (ov && ov.ok) ? ov : null };
        renderPage();
        setStatus('');
      })
      .catch(function (e) {
        setStatus('');
        if (!c) host.innerHTML = '<div class="loading error">Lỗi tải dữ liệu: ' + e + '</div>';
      });
  }

  // ---- client aggregation ----------------------------------------------
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
  function groupByField(rows, field) {
    var map = {};
    (rows || []).forEach(function (r) {
      var k = String(r[field] || '(không rõ)');
      (map[k] = map[k] || []).push(r);
    });
    return Object.keys(map).map(function (k) {
      var t = sumRows(map[k]);
      t.key = k;
      t.name = field === 'product_slug' ? (map[k][0].product_name || k) : k;
      t._rows = map[k];
      return t;
    }).sort(function (a, b) { return b.spend - a.spend; });
  }

  var GROUPS = [
    { field: 'product_slug', label: 'Sản phẩm' },
    { field: 'pillar', label: 'Pillar' },
    { field: 'ta', label: 'TA' }
  ];
  function groupLabel(field) {
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].field === field) return GROUPS[i].label;
    return field;
  }

  // ---- page render ------------------------------------------------------
  function adsRows() { return (cache[state.range] && cache[state.range].ads.data) || []; }
  function overviewData() { var c = cache[state.range]; return (c && c.overview && c.overview.data) || null; }

  function renderPage() {
    var host = $('#view');
    host.innerHTML = '';
    $('#genAt').textContent = 'Cập nhật: ' + new Date().toLocaleString('vi-VN');
    $('#kpiTarget').textContent = fmtVnd(state.settings.cost_per_message_target || 80000);

    var rows = adsRows();
    var t = sumRows(rows);
    var target = Number(state.settings.cost_per_message_target || 80000);

    // KPI cards
    var cards = el('div', 'cards');
    cards.appendChild(card('Tổng chi', fmtVnd(t.spend)));
    cards.appendChild(card('Tin nhắn', fmtNum(t.conv_started), 'reply ' + fmtPct(t.reply_rate)));
    cards.appendChild(card('Cost / tin nhắn', fmtVnd(t.cost_per_conv),
      'mục tiêu ' + fmtVnd(target), (t.cost_per_conv != null && t.cost_per_conv <= target) ? 'good' : 'bad'));
    cards.appendChild(card('Đơn (Meta)', t.purchases ? fmtNum(t.purchases) : 'N/A',
      t.roas != null ? 'ROAS ' + t.roas : 'ROAS N/A'));
    host.appendChild(cards);

    // Overall funnel + diagnosis
    host.appendChild(funnelPanel('Phễu Messenger (toàn bộ)', t));

    // Trend
    var ov = overviewData();
    if (ov && ov.trend && ov.trend.length) {
      var p = el('div', 'panel');
      p.appendChild(el('h2', null, 'Xu hướng cost/tin nhắn theo ngày'));
      var w = el('div', 'chart-wrap'); w.appendChild(el('canvas')).id = 'trendChart';
      p.appendChild(w); host.appendChild(p);
      Charts.trendLine('trendChart', ov.trend);
    }

    // Data hygiene
    var unmapped = rows.filter(function (r) { return !r.mapped; });
    if (unmapped.length) {
      var hw = el('div', 'panel warn-block');
      hw.appendChild(el('h2', null, '⚠ ' + unmapped.length + ' ad sai tên (chưa map được sản phẩm) — sửa tên để vào đúng nhóm'));
      hw.appendChild(tableFrom(unmapped, [
        { k: 'ad_name', t: 'Ad name', fmt: id, left: true },
        { k: 'campaign_name', t: 'Campaign', fmt: id, left: true },
        { k: 'spend', t: 'Chi', fmt: fmtVnd }
      ]));
      host.appendChild(hw);
    }

    // Explore section (swappable: list <-> detail)
    var explore = el('div'); explore.id = 'explore';
    host.appendChild(explore);
    renderExplore();
  }

  function renderExplore() {
    var box = $('#explore');
    if (!box) return;
    box.innerHTML = '';
    if (state.detail) { renderDetail(box, state.detail.by, state.detail.key); return; }

    // Group-by toggle
    var bar = el('div', 'segbar');
    bar.appendChild(el('span', 'seglabel', 'Xem theo:'));
    GROUPS.forEach(function (g) {
      var b = el('button', 'seg' + (g.field === state.groupBy ? ' active' : ''), g.label);
      b.addEventListener('click', function () { state.groupBy = g.field; renderExplore(); });
      bar.appendChild(b);
    });
    box.appendChild(bar);

    var groups = groupByField(adsRows(), state.groupBy);

    var chartP = el('div', 'panel');
    chartP.appendChild(el('h2', null, 'Cost/tin nhắn theo ' + groupLabel(state.groupBy)));
    var w = el('div', 'chart-wrap'); w.appendChild(el('canvas')).id = 'exploreChart';
    chartP.appendChild(w); box.appendChild(chartP);

    box.appendChild(el('p', 'muted hint', '👆 Bấm một dòng để xem phễu, pillar & content chi tiết.'));
    box.appendChild(tableFrom(groups, [
      { k: 'name', t: groupLabel(state.groupBy), fmt: id, left: true },
      { k: 'spend', t: 'Chi', fmt: fmtVnd },
      { k: 'conv_started', t: 'Tin nhắn', fmt: fmtNum },
      { k: 'cost_per_conv', t: 'Cost/tin', fmt: fmtVnd },
      { k: 'reply_rate', t: 'Reply', fmt: fmtPct },
      { k: 'verdict', t: 'Đề xuất', fmt: verdictPill, html: true }
    ], function (row) { state.detail = { by: state.groupBy, key: row.key }; renderExplore(); }));

    Charts.breakdownBar('exploreChart', groups, 'name');

    var recs = Recommend.summarize(groups, state.settings, 'name');
    if (recs.length) box.appendChild(recsPanel(recs));
  }

  function renderDetail(box, by, key) {
    var rows = adsRows().filter(function (r) { return String(r[by]) === String(key); });

    var back = el('button', 'backlink', '← Quay lại ' + groupLabel(by));
    back.addEventListener('click', function () { state.detail = null; renderExplore(); });
    box.appendChild(back);

    var name = by === 'product_slug' ? ((rows[0] && rows[0].product_name) || key) : key;
    box.appendChild(el('h2', 'detail-title', groupLabel(by) + ': ' + name));

    if (!rows.length) {
      box.appendChild(el('p', 'muted', 'Không có ad nào trong khoảng thời gian đã chọn.'));
      return;
    }

    var t = sumRows(rows);
    var target = Number(state.settings.cost_per_message_target || 80000);
    var cards = el('div', 'cards');
    cards.appendChild(card('Tổng chi', fmtVnd(t.spend)));
    cards.appendChild(card('Tin nhắn', fmtNum(t.conv_started)));
    cards.appendChild(card('Cost / tin nhắn', fmtVnd(t.cost_per_conv),
      'mục tiêu ' + fmtVnd(target), (t.cost_per_conv != null && t.cost_per_conv <= target) ? 'good' : 'bad'));
    cards.appendChild(card('Đơn (Meta)', t.purchases ? fmtNum(t.purchases) : 'N/A',
      t.roas != null ? 'ROAS ' + t.roas : 'ROAS N/A'));
    box.appendChild(cards);

    box.appendChild(funnelPanel('Phễu của ' + groupLabel(by).toLowerCase() + ' này', t));

    // Secondary breakdown: product -> by pillar; pillar/ta -> by product
    var subField = by === 'product_slug' ? 'pillar' : 'product_slug';
    var subs = groupByField(rows, subField);
    var sp = el('div', 'panel');
    sp.appendChild(el('h2', null, 'Theo ' + groupLabel(subField) + ' (trong nhóm này)'));
    box.appendChild(sp);
    box.appendChild(tableFrom(subs, [
      { k: 'name', t: groupLabel(subField), fmt: id, left: true },
      { k: 'spend', t: 'Chi', fmt: fmtVnd },
      { k: 'conv_started', t: 'Tin nhắn', fmt: fmtNum },
      { k: 'cost_per_conv', t: 'Cost/tin', fmt: fmtVnd },
      { k: 'reply_rate', t: 'Reply', fmt: fmtPct },
      { k: 'verdict', t: 'Đề xuất', fmt: verdictPill, html: true }
    ]));

    // Content / ad list
    var cp = el('div', 'panel');
    cp.appendChild(el('h2', null, 'Content / Ad (' + rows.length + ')'));
    box.appendChild(cp);
    box.appendChild(tableFrom(rows, [
      { k: 'ad_name', t: 'Ad', fmt: id, left: true },
      { k: 'format', t: 'Format', fmt: dash, left: true },
      { k: 'pillar', t: 'Pillar', fmt: dash, left: true },
      { k: 'spend', t: 'Chi', fmt: fmtVnd },
      { k: 'conv_started', t: 'Tin nhắn', fmt: fmtNum },
      { k: 'cost_per_conv', t: 'Cost/tin', fmt: fmtVnd },
      { k: 'reply_rate', t: 'Reply', fmt: fmtPct },
      { k: 'verdict', t: 'Đề xuất', fmt: verdictPill, html: true }
    ]));
  }

  // ---- funnel -----------------------------------------------------------
  function funnelPanel(title, t) {
    var p = el('div', 'panel');
    p.appendChild(el('h2', null, title));
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
    p.appendChild(fn);
    var dg = funnelDiagnosis(t);
    var diag = el('div', 'rec'); diag.style.marginTop = '12px';
    diag.appendChild(el('span', 'pill ' + (dg.level === 'scale' ? 'scale' : dg.level === 'fix' ? 'fix' : 'warn'), 'Phễu'));
    diag.appendChild(el('div', 'body', dg.text));
    p.appendChild(diag);
    return p;
  }

  function funnelDiagnosis(t) {
    var target = Number(state.settings.cost_per_message_target || 80000);
    var bench = Number(state.settings.reply_rate_benchmark || 0.4);
    if (t.conv_started === 0) return { level: 'warn', text: 'Chưa có tin nhắn — chưa đủ dữ liệu để chẩn đoán phễu.' };
    if (t.reply_rate < bench) return { level: 'fix', text: 'Rớt mạnh ở KHÁCH NHẮN LẠI: reply rate ' + fmtPct(t.reply_rate) + ' < benchmark ' + fmtPct(bench) + '. Soi lời chào / tốc độ rep / chất lượng traffic.' };
    if (t.cost_per_conv != null && t.cost_per_conv > target) return { level: 'fix', text: 'Tin nhắn đắt: ' + fmtVnd(t.cost_per_conv) + ' > mục tiêu ' + fmtVnd(target) + '. Khâu Click→Tin nhắn chưa hiệu quả (creative/đối tượng).' };
    if (t.purchases === 0 && t.conv_replied >= 3) return { level: 'fix', text: 'Hội thoại tốt nhưng 0 đơn (Meta ghi nhận). Soi khâu CHỐT/giá — hoặc thiếu attribution.' };
    return { level: 'scale', text: 'Phễu khỏe: tin nhắn rẻ, reply rate tốt. Cân nhắc tăng ngân sách / nhân bản.' };
  }

  // ---- small render utils ----------------------------------------------
  function id(v) { return v; }
  function dash(v) { return v || '—'; }
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
    var boxx = el('div', 'recs');
    recs.forEach(function (r) {
      var cls = { CUT: 'cut', FIX_CONV: 'fix', FIX_CLOSE: 'fix', SCALE: 'scale' }[r.tag] || 'warn';
      var row = el('div', 'rec');
      row.appendChild(el('span', 'pill ' + cls, r.tag));
      row.appendChild(el('div', 'body', '<b>' + r.label + '</b>' + r.reason));
      boxx.appendChild(row);
    });
    p.appendChild(boxx);
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
      if (onRowClick) { tr.className = 'clickable'; tr.addEventListener('click', function () { onRowClick(row); }); }
      cols.forEach(function (c) {
        var val = c.fmt ? c.fmt(row[c.k], row) : row[c.k];
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
      var btn = this.querySelector('button[type="submit"]');
      btn.disabled = true; btn.textContent = 'Đang mở…';
      tryLogin(p).then(function (ok) {
        if (!ok) { btn.disabled = false; btn.textContent = 'Mở dashboard'; }
      });
    });
    $('#range').addEventListener('change', function (e) { state.range = e.target.value; load(); });
    $('#refresh').addEventListener('click', load);
    $('#logout').addEventListener('click', function () { clearPwd(); showGate(false); });

    if (pwd()) tryLogin(pwd()); else showGate(false);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
