/**
 * recommend.js — rule engine. Pure functions over aggregated entities.
 *
 * Rules (thresholds come from `settings`, never hardcoded here):
 *   SCALE     cost/conv <= target AND enough volume     -> scale budget / clone winner
 *   CUT/FIX   cost/conv > target * cut_factor AND spent  -> turn off / change creative
 *   FIX_CONV  many started but reply_rate < benchmark    -> check greeting / reply speed
 *   FIX_CLOSE many replied but few orders                -> check closing/price (or attribution)
 *   DATA      mapped=FALSE                               -> fix the ad name
 *
 * "Enough volume" guards against calling winners/losers on tiny samples.
 */
window.Recommend = (function () {

  function num(v, d) { var n = Number(v); return isNaN(n) ? (d || 0) : n; }

  function thresholds(settings) {
    settings = settings || {};
    return {
      target: num(settings.cost_per_message_target, 80000),
      minSpend: num(settings.min_spend_floor, 300000),
      cutFactor: num(settings.cut_factor, 1.5),
      replyBench: num(settings.reply_rate_benchmark, 0.4),
      minConv: 3 // minimum conversations to trust a verdict
    };
  }

  /** Returns { tag, level, reason } or null. tag ∈ SCALE|CUT|FIX_CONV|FIX_CLOSE. */
  function classify(entity, settings) {
    var t = thresholds(settings);
    var spend = num(entity.spend);
    var started = num(entity.conv_started);
    var replied = num(entity.conv_replied);
    var purchases = num(entity.purchases);
    var cpc = entity.cost_per_conv;
    var enoughVolume = spend >= t.minSpend || started >= t.minConv;

    if (!enoughVolume) {
      return { tag: 'WATCH', level: 'warn', reason: 'Chưa đủ lượng để kết luận (spend/tin nhắn còn thấp).' };
    }

    var replyRate = started > 0 ? replied / started : 0;

    // CUT first (most urgent waste).
    if (cpc !== null && cpc !== undefined && cpc !== '' && started > 0 && cpc > t.target * t.cutFactor) {
      return {
        tag: 'CUT', level: 'cut',
        reason: 'Cost/tin nhắn ' + fmtVnd(cpc) + ' > ' + fmtVnd(t.target * t.cutFactor) +
          ' (target × ' + t.cutFactor + '). Cân nhắc tắt hoặc đổi creative.'
      };
    }
    // FIX conversation quality — many started but poor reply rate.
    if (started >= t.minConv && replyRate < t.replyBench) {
      return {
        tag: 'FIX_CONV', level: 'fix',
        reason: 'Reply rate ' + (replyRate * 100).toFixed(0) + '% < benchmark ' +
          (t.replyBench * 100).toFixed(0) + '%. Soi lời chào / tốc độ rep / chất lượng traffic.'
      };
    }
    // SCALE — a cheap winner is a winner regardless of Meta's (usually missing) order data.
    if (cpc !== null && cpc !== undefined && cpc !== '' && started >= t.minConv && cpc <= t.target) {
      return {
        tag: 'SCALE', level: 'scale',
        reason: 'Cost/tin nhắn ' + fmtVnd(cpc) + ' ≤ target ' + fmtVnd(t.target) +
          '. Tăng budget / nhân bản creative thắng.'
      };
    }
    // FIX closing — conversations work (healthy reply rate) but no orders show. Likely a
    // closing/price issue OR missing attribution. Only after SCALE so winners aren't flagged.
    if (replied >= t.minConv && replyRate >= t.replyBench && purchases === 0) {
      return {
        tag: 'FIX_CLOSE', level: 'fix',
        reason: 'Có ' + replied + ' khách nhắn lại (reply rate ok) nhưng 0 đơn Meta ghi nhận. ' +
          'Soi khâu chốt/giá — hoặc thiếu attribution (cần nguồn đơn thật, Phase 5).'
      };
    }
    return { tag: 'OK', level: 'warn', reason: 'Trong ngưỡng, chưa cần hành động.' };
  }

  function fmtVnd(v) {
    if (v === null || v === undefined || v === '') return 'N/A';
    return Math.round(Number(v)).toLocaleString('vi-VN') + '₫';
  }

  /** Build a list of headline recommendations for the overview/breakdown screens. */
  function summarize(entities, settings, labelKey) {
    var recs = [];
    (entities || []).forEach(function (e) {
      var c = classify(e, settings);
      if (!c || c.tag === 'OK' || c.tag === 'WATCH') return;
      recs.push({
        tag: c.tag, level: c.level,
        label: e[labelKey] || e.ad_name || e.key || '(?)',
        reason: c.reason
      });
    });
    // Order: CUT, FIX_*, SCALE
    var order = { CUT: 0, FIX_CONV: 1, FIX_CLOSE: 2, SCALE: 3 };
    recs.sort(function (a, b) { return (order[a.tag] || 9) - (order[b.tag] || 9); });
    return recs;
  }

  return { classify: classify, summarize: summarize, thresholds: thresholds };
})();
