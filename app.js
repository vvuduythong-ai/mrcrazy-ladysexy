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
  var state = { range: '30d', from: '', to: '', groupBy: 'product_slug', detail: null, settings: {} };
  var cache = {}; // rangeKey -> { ads: res, overview: res, prev: [adsRows] }

  // A custom range's window depends on from/to, so the cache key must include them.
  function rangeKey() {
    return state.range === 'custom' ? 'custom:' + state.from + ':' + state.to : state.range;
  }

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
  // Orders/revenue: show N/A (not "0") when Meta recorded nothing — never style 0 as a result.
  function fmtOrders(v) { return numv(v) > 0 ? fmtNum(v) : 'N/A'; }
  function fmtRev(v) { return numv(v) > 0 ? fmtVnd(v) : 'N/A'; }

  // ---- API --------------------------------------------------------------
  function api(view, compare) {
    var url = API + '?pwd=' + encodeURIComponent(pwd()) +
      '&view=' + encodeURIComponent(view) + '&range=' + encodeURIComponent(state.range);
    if (state.range === 'custom' && state.from && state.to) {
      url += '&from=' + encodeURIComponent(state.from) + '&to=' + encodeURIComponent(state.to);
    }
    if (compare) url += '&compare=1';
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
    return api('ads').then(function (res) {
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
    var key = rangeKey();
    var c = cache[key];
    if (c && c.ads) { renderPage(); setStatus('Đang cập nhật…'); }
    else { host.innerHTML = '<div class="loading">Đang tải…</div>'; setStatus(''); }

    Promise.all([api('ads', true), api('overview'), api('activity')])
      .then(function (r) {
        var ads = r[0], ov = r[1], act = r[2];
        if (!ads || !ads.ok) {
          if (!c) showGate(ads && ads.error === 'unauthorized' ? 'Sai mật khẩu.' : true);
          setStatus(''); return;
        }
        state.settings = ads.settings || state.settings;
        cache[rangeKey()] = {
          ads: ads,
          overview: (ov && ov.ok) ? ov : null,
          activity: (act && act.ok) ? act : null,
          prev: ads.prev || null,
          window: ads.window || null,
          prevWindow: ads.prevWindow || null
        };
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
      t.name = displayName(field, k, map[k][0]);
      t._rows = map[k];
      return t;
    }).sort(function (a, b) { return b.spend - a.spend; });
  }

  var GROUPS = [
    { field: 'product_slug', label: 'Sản phẩm' },
    { field: 'pillar', label: 'Pillar' },
    { field: 'ta', label: 'TA' }
  ];
  // TA codes -> full display names (codes stay the grouping key; only the label changes).
  var TA_LABELS = { BW: 'Business Women', SD: 'Summer Dawn', BJ: 'Bejeweled' };
  function taLabel(code) { return TA_LABELS[String(code).toUpperCase()] || code; }
  // Display name for a grouped row: product name, TA full name, or the key as-is.
  function displayName(field, key, row) {
    if (field === 'product_slug') return (row && row.product_name) || key;
    if (field === 'ta') return taLabel(key);
    return key;
  }
  function groupLabel(field) {
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].field === field) return GROUPS[i].label;
    return field;
  }

  // ---- page render ------------------------------------------------------
  function adsRows() { var c = cache[rangeKey()]; return (c && c.ads && c.ads.data) || []; }
  function prevRows() { var c = cache[rangeKey()]; return (c && c.prev) || null; }
  function overviewData() { var c = cache[rangeKey()]; return (c && c.overview && c.overview.data) || null; }
  function activityData() { var c = cache[rangeKey()]; return (c && c.activity && c.activity.data) || []; }

  function renderPage() {
    var host = $('#view');
    host.innerHTML = '';
    $('#genAt').textContent = 'Cập nhật: ' + new Date().toLocaleString('vi-VN');
    $('#kpiTarget').textContent = fmtVnd(state.settings.cost_per_message_target || 80000);

    var rows = adsRows();
    var t = sumRows(rows);
    var pr = prevRows();
    var pt = pr ? sumRows(pr) : null;
    var target = Number(state.settings.cost_per_message_target || 80000);

    // KPI cards (with period-over-period delta when previous data is available)
    var cards = el('div', 'cards');
    cards.appendChild(card('Tổng chi', fmtVnd(t.spend), null, null,
      pt && deltaInfo(t.spend, pt.spend, false)));
    cards.appendChild(card('Tin nhắn', fmtNum(t.conv_started), 'reply ' + fmtPct(t.reply_rate), null,
      pt && deltaInfo(t.conv_started, pt.conv_started, false)));
    cards.appendChild(card('Cost / tin nhắn', fmtVnd(t.cost_per_conv),
      'mục tiêu ' + fmtVnd(target), (t.cost_per_conv != null && t.cost_per_conv <= target) ? 'good' : 'bad',
      pt && deltaInfo(t.cost_per_conv, pt.cost_per_conv, true)));
    cards.appendChild(card('Đơn (Meta)', t.purchases ? fmtNum(t.purchases) : 'N/A',
      t.roas != null ? 'ROAS ' + t.roas : 'ROAS N/A',
      null, pt && deltaInfo(t.purchases, pt.purchases, false)));
    host.appendChild(cards);

    // Overall funnel + diagnosis (with period-over-period comparison when available)
    host.appendChild(funnelPanel('Phễu Messenger (toàn bộ)', t, pt));

    // Trend
    var ov = overviewData();
    if (ov && ov.trend && ov.trend.length) {
      var p = el('div', 'panel');
      p.appendChild(el('h2', null, 'Xu hướng cost/tin nhắn theo ngày'));
      var w = el('div', 'chart-wrap'); w.appendChild(el('canvas')).id = 'trendChart';
      p.appendChild(w); host.appendChild(p);
      Charts.trendLine('trendChart', ov.trend);
    }

    // Explore section (swappable: list <-> detail)
    var explore = el('div'); explore.id = 'explore';
    host.appendChild(explore);
    renderExplore();

    // Activity Log — pinned to the very bottom (occasional-check reference).
    host.appendChild(activityPanel());
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
      { k: 'purchases', t: 'Đơn', fmt: fmtOrders },
      { k: 'purchase_value', t: 'Doanh thu', fmt: fmtRev },
      { k: 'verdict', t: 'Đề xuất', fmt: verdictPill, html: true, sortable: false }
    ], function (row) { state.detail = { by: state.groupBy, key: row.key }; renderExplore(); }));

    // Clicking a bar drills into that group's detail view, same as clicking its table row.
    Charts.breakdownBar('exploreChart', groups, 'name', function (i) {
      var g = groups[i];
      if (g) { state.detail = { by: state.groupBy, key: g.key }; renderExplore(); }
    });

    var recs = Recommend.summarize(groups, state.settings, 'name');
    if (recs.length) box.appendChild(recsPanel(recs));
  }

  function renderDetail(box, by, key) {
    var rows = adsRows().filter(function (r) { return String(r[by]) === String(key); });

    // Tinted container so the drill-down reads as a distinct "detailed analysis"
    // section, with the back button given its own header row (no longer cramped).
    var view = el('div', 'detail-view');
    box.appendChild(view);

    var head = el('div', 'detail-head');
    var back = el('button', 'backlink', '← Quay lại ' + groupLabel(by));
    back.addEventListener('click', function () { state.detail = null; renderExplore(); });
    head.appendChild(back);
    head.appendChild(el('span', 'detail-badge', 'Phân tích chi tiết'));
    view.appendChild(head);

    var name = displayName(by, key, rows[0]);
    view.appendChild(el('h2', 'detail-title', groupLabel(by) + ': ' + name));

    if (!rows.length) {
      view.appendChild(el('p', 'muted', 'Không có ad nào trong khoảng thời gian đã chọn.'));
      return;
    }

    var t = sumRows(rows);
    var pr = prevRows();
    var pt = pr ? sumRows(pr.filter(function (r) { return String(r[by]) === String(key); })) : null;
    var target = Number(state.settings.cost_per_message_target || 80000);
    var cards = el('div', 'cards');
    cards.appendChild(card('Tổng chi', fmtVnd(t.spend), null, null,
      pt && deltaInfo(t.spend, pt.spend, false)));
    cards.appendChild(card('Tin nhắn', fmtNum(t.conv_started), null, null,
      pt && deltaInfo(t.conv_started, pt.conv_started, false)));
    cards.appendChild(card('Cost / tin nhắn', fmtVnd(t.cost_per_conv),
      'mục tiêu ' + fmtVnd(target), (t.cost_per_conv != null && t.cost_per_conv <= target) ? 'good' : 'bad',
      pt && deltaInfo(t.cost_per_conv, pt.cost_per_conv, true)));
    cards.appendChild(card('Đơn (Meta)', t.purchases ? fmtNum(t.purchases) : 'N/A',
      t.roas != null ? 'ROAS ' + t.roas : 'ROAS N/A',
      null, pt && deltaInfo(t.purchases, pt.purchases, false)));
    view.appendChild(cards);

    view.appendChild(funnelPanel('Phễu của ' + groupLabel(by).toLowerCase() + ' này', t, pt));

    // Secondary breakdowns: show this group split by each of the OTHER two dimensions
    // (e.g. a TA detail shows both which Sản phẩm and which Pillar are running under it).
    var DIMS = ['product_slug', 'pillar', 'ta'];
    DIMS.filter(function (f) { return f !== by; }).forEach(function (subField) {
      var subs = groupByField(rows, subField);
      view.appendChild(tableFrom(subs, [
        { k: 'name', t: groupLabel(subField), fmt: id, left: true },
        { k: 'spend', t: 'Chi', fmt: fmtVnd },
        { k: 'conv_started', t: 'Tin nhắn', fmt: fmtNum },
        { k: 'cost_per_conv', t: 'Cost/tin', fmt: fmtVnd },
        { k: 'reply_rate', t: 'Reply', fmt: fmtPct },
        { k: 'purchases', t: 'Đơn', fmt: fmtOrders },
        { k: 'purchase_value', t: 'Doanh thu', fmt: fmtRev },
        { k: 'verdict', t: 'Đề xuất', fmt: verdictPill, html: true, sortable: false }
      ], null, 'Theo ' + groupLabel(subField) + ' (trong nhóm này)'));
    });

    // Content / ad list
    view.appendChild(tableFrom(rows, [
      { k: 'ad_name', t: 'Ad', fmt: adLink, left: true, html: true },
      { k: 'format', t: 'Format', fmt: dash, left: true },
      { k: 'pillar', t: 'Pillar', fmt: dash, left: true },
      { k: 'spend', t: 'Chi', fmt: fmtVnd },
      { k: 'conv_started', t: 'Tin nhắn', fmt: fmtNum },
      { k: 'cost_per_conv', t: 'Cost/tin', fmt: fmtVnd },
      { k: 'reply_rate', t: 'Reply', fmt: fmtPct },
      { k: 'purchases', t: 'Đơn', fmt: fmtOrders },
      { k: 'purchase_value', t: 'Doanh thu', fmt: fmtRev },
      { k: 'verdict', t: 'Đề xuất', fmt: verdictPill, html: true, sortable: false }
    ], null, 'Content / Ad (' + rows.length + ')'));
  }

  // ---- funnel -----------------------------------------------------------
  // Compact delta chip for the funnel (vs the previous period). Shown under each stage
  // value and next to cost/tin nhắn. Returns null when there's no comparable prior value.
  function stageDeltaEl(d) {
    if (!d) return null;
    if (d.isNew) return el('span', 'fdelta good', '★ mới vs kỳ trước');
    var arrow = d.pct > 0 ? '▲' : d.pct < 0 ? '▼' : '–';
    var cls = d.good === null ? 'flat' : d.good ? 'good' : 'bad';
    return el('span', 'fdelta ' + cls, arrow + ' ' + Math.abs(d.pct).toFixed(0) + '% vs kỳ trước');
  }

  // funnelPanel(title, t, pt): pt = previous-period totals (nullable) for the comparison.
  function funnelPanel(title, t, pt) {
    var p = el('div', 'panel');
    p.appendChild(el('h2', null, title));
    var stages = [
      { stage: 'Impressions', value: t.impressions, prev: pt ? pt.impressions : null },
      { stage: 'Clicks', value: t.clicks, prev: pt ? pt.clicks : null },
      { stage: 'Tin nhắn bắt đầu', value: t.conv_started, prev: pt ? pt.conv_started : null },
      { stage: 'Khách nhắn lại', value: t.conv_replied, prev: pt ? pt.conv_replied : null },
      { stage: 'Đơn (Meta)', value: t.purchases, prev: pt ? pt.purchases : null }
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
      var meta = el('div', 'funnel-meta');
      meta.appendChild(el('div', null, fmtNum(s.value) + drop));
      // More volume at each stage is better -> lowerIsBetter = false.
      var de = stageDeltaEl(pt ? deltaInfo(s.value, s.prev, false) : null);
      if (de) meta.appendChild(de);
      row.appendChild(meta);
      fn.appendChild(row); prev = s.value;
    });
    p.appendChild(fn);

    // Cost/tin nhắn summary line with its own period-over-period delta (lower = better).
    if (t.cost_per_conv != null) {
      var cost = el('div', 'funnel-cost');
      cost.appendChild(el('span', 'funnel-cost-label', 'Cost / tin nhắn'));
      cost.appendChild(el('span', 'funnel-cost-val', fmtVnd(t.cost_per_conv)));
      var cde = stageDeltaEl(pt ? deltaInfo(t.cost_per_conv, pt.cost_per_conv, true) : null);
      if (cde) cost.appendChild(cde);
      p.appendChild(cost);
    }

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
    if (t.purchases === 0 && t.conv_replied >= 3) return { level: 'fix', text: 'Hội thoại tốt nhưng 0 đơn (Meta ghi nhận). Soi khâu CHỐT/giá.' };
    return { level: 'scale', text: 'Phễu khỏe: tin nhắn rẻ, reply rate tốt. Cân nhắc tăng ngân sách / nhân bản.' };
  }

  // ---- small render utils ----------------------------------------------
  function id(v) { return v; }
  function dash(v) { return v || '—'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  // Ad name as a clickable preview link when Meta gave us a shareable link; plain
  // (escaped) text otherwise. Used with html:true columns.
  function adLink(v, row) {
    var name = esc(v);
    if (row && row.preview_url) {
      return '<a class="adlink" href="' + esc(row.preview_url) + '" target="_blank" rel="noopener"' +
        ' title="Mở bản xem trước quảng cáo">' + name + '</a>';
    }
    return name;
  }
  function card(label, value, sub, cls, delta) {
    var c = el('div', 'card');
    c.appendChild(el('div', 'label', label));
    c.appendChild(el('div', 'value' + (cls ? ' ' + cls : ''), value));
    if (sub) c.appendChild(el('div', 'sub', sub));
    if (delta) c.appendChild(deltaEl(delta));
    return c;
  }
  // Percentage change vs the previous period. lowerIsBetter flips the good/bad
  // coloring for cost-type metrics (a drop is an improvement). Returns null when
  // there's no comparable previous value.
  function deltaInfo(cur, prev, lowerIsBetter) {
    if (prev == null || cur == null || isNaN(prev) || isNaN(cur)) return null;
    // No baseline last period: flag as "new" if there's activity now, else nothing.
    if (prev === 0) return cur > 0 ? { isNew: true } : null;
    var pct = (cur - prev) / Math.abs(prev) * 100;
    var good = pct === 0 ? null : (lowerIsBetter ? pct < 0 : pct > 0);
    return { pct: pct, good: good };
  }
  function deltaEl(d) {
    if (d.isNew) return el('div', 'delta good', '★ mới <span class="delta-cap">vs kỳ trước</span>');
    var arrow = d.pct > 0 ? '▲' : d.pct < 0 ? '▼' : '–';
    var cls = d.good === null ? 'flat' : d.good ? 'good' : 'bad';
    return el('div', 'delta ' + cls,
      arrow + ' ' + Math.abs(d.pct).toFixed(0) + '% <span class="delta-cap">vs kỳ trước</span>');
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
  // ---- activity log -----------------------------------------------------
  // Category -> pill color (same pill classes the rest of the dashboard uses).
  var ACT_PILL = { 'Tạo': 'scale', 'Xoá': 'cut', 'Ngân sách': 'warn', 'Trạng thái': 'fix', 'Khác': 'warn' };

  // event_time is an ISO-ish string ("2026-06-12T10:30:00+0700"); split into a day
  // heading + a HH:mm stamp. Falls back to the raw date slice if it won't parse.
  function actTimeParts(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return { day: String(iso).slice(0, 10), time: '' };
    return {
      day: d.toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }),
      time: d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    };
  }

  // Activity Log panel — auto-collected Meta change history, pinned to the page bottom.
  function activityPanel() {
    var acts = activityData();
    var p = el('div', 'panel activity-panel');
    var head = el('div', 'activity-head');
    head.appendChild(el('h2', null, '🗒 Nhật ký thay đổi Meta Ads'));
    head.appendChild(el('span', 'muted activity-count', acts.length + ' thay đổi trong kỳ'));
    p.appendChild(head);

    if (!acts.length) {
      p.appendChild(el('p', 'muted', 'Chưa ghi nhận thay đổi nào trong khoảng thời gian này.'));
      return p;
    }

    // Rows arrive newest-first from the API; insert a heading each time the day changes.
    var lastDay = null;
    var list = el('div', 'activity-list');
    acts.forEach(function (a) {
      var tp = actTimeParts(a.event_time);
      if (tp.day !== lastDay) { list.appendChild(el('div', 'activity-day', tp.day)); lastDay = tp.day; }

      var item = el('div', 'activity-item');
      var cat = a.category || 'Khác';
      var title = el('div', 'activity-title');
      title.appendChild(el('span', 'pill ' + (ACT_PILL[cat] || 'warn'), esc(cat)));
      title.appendChild(el('span', 'activity-label', esc(a.event_label || cat)));
      item.appendChild(title);

      if (a.object_name) item.appendChild(el('div', 'activity-obj', esc(a.object_name)));
      var meta = [a.object_type, a.actor_name].filter(Boolean).join(' · ');
      item.appendChild(el('div', 'activity-meta muted', esc(meta) + (tp.time ? ' · ' + tp.time : '')));
      list.appendChild(item);
    });
    p.appendChild(list);
    return p;
  }

  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isNaN(v) ? null : v;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }
  // Click a header to sort by that column. Numeric columns sort by value (N/A last);
  // text columns sort alphabetically (vi locale). Columns can opt out with sortable:false.
  function tableFrom(rows, cols, onRowClick, heading) {
    rows = rows || [];
    var wrap = el('div', 'panel');
    if (heading) wrap.appendChild(el('h2', null, heading));
    var scroll = el('div', 'table-scroll');
    var table = el('table');
    var thead = el('thead'), trh = el('tr');
    var sort = { idx: -1, dir: 1 };

    cols.forEach(function (c, ci) {
      var th = el('th', c.left ? 'l' : null, c.t);
      if (c.sortable !== false) {
        th.classList.add('sortable');
        th.addEventListener('click', function () {
          if (sort.idx === ci) sort.dir = -sort.dir;
          else { sort.idx = ci; sort.dir = c.left ? 1 : -1; } // text asc, numbers desc first
          render();
        });
      }
      trh.appendChild(th);
    });
    thead.appendChild(trh); table.appendChild(thead);
    var tbody = el('tbody'); table.appendChild(tbody);

    function sorted() {
      if (sort.idx < 0) return rows.slice();
      var key = cols[sort.idx].k;
      return rows.slice().sort(function (a, b) {
        var an = toNum(a[key]), bn = toNum(b[key]);
        if (an === null && bn === null) {
          return String(a[key] == null ? '' : a[key])
            .localeCompare(String(b[key] == null ? '' : b[key]), 'vi') * sort.dir;
        }
        if (an === null) return 1;   // missing numeric value sinks to the bottom
        if (bn === null) return -1;
        return (an - bn) * sort.dir;
      });
    }

    function render() {
      var ths = trh.children;
      for (var i = 0; i < ths.length; i++) {
        ths[i].classList.remove('sort-asc', 'sort-desc');
        if (i === sort.idx) ths[i].classList.add(sort.dir > 0 ? 'sort-asc' : 'sort-desc');
      }
      tbody.innerHTML = '';
      sorted().forEach(function (row) {
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
    }

    render();
    scroll.appendChild(table); wrap.appendChild(scroll);
    return wrap;
  }

  // ---- wiring -----------------------------------------------------------
  // Show the date pickers only for the custom range; seed a sensible 7-day window.
  function syncCustomUI() {
    var on = state.range === 'custom';
    var box = $('#customRange');
    if (box) box.hidden = !on;
    if (on && (!state.from || !state.to)) {
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      var iso = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
      var today = new Date();
      state.to = iso(today);
      state.from = iso(new Date(today.getTime() - 6 * 86400000));
      $('#from').value = state.from;
      $('#to').value = state.to;
    }
  }

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
    $('#range').addEventListener('change', function (e) {
      state.range = e.target.value;
      syncCustomUI();
      // Wait for both dates before fetching a custom range.
      if (state.range !== 'custom' || (state.from && state.to)) load();
    });
    $('#from').addEventListener('change', function (e) { state.from = e.target.value; if (state.to) load(); });
    $('#to').addEventListener('change', function (e) { state.to = e.target.value; if (state.from) load(); });
    $('#refresh').addEventListener('click', load);
    $('#logout').addEventListener('click', function () { clearPwd(); showGate(false); });

    if (pwd()) tryLogin(pwd()); else showGate(false);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
