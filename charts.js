/**
 * charts.js — thin Chart.js wrappers. Each function destroys the previous chart
 * on the same canvas id before drawing (views are re-rendered on navigation).
 */
window.Charts = (function () {
  var registry = {};

  function destroy(id) {
    if (registry[id]) { registry[id].destroy(); delete registry[id]; }
  }

  function ctx(id) {
    var el = document.getElementById(id);
    return el ? el.getContext('2d') : null;
  }

  var BRAND = '#2e4a62';
  var BRAND_FADE = 'rgba(46,74,98,.12)';

  /** Line chart for the overview trend (cost/conv over time). */
  function trendLine(id, trend) {
    destroy(id);
    var c = ctx(id); if (!c) return;
    var labels = trend.map(function (t) { return t.date.slice(5); }); // MM-DD
    registry[id] = new Chart(c, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Cost/tin nhắn (₫)',
          data: trend.map(function (t) { return t.cost_per_conv; }),
          borderColor: BRAND, backgroundColor: BRAND_FADE,
          fill: true, tension: .3, spanGaps: true, pointRadius: 2
        }]
      },
      options: baseOpts({ yMoney: true })
    });
  }

  /** Bar chart for a breakdown (cost/conv by key). */
  function breakdownBar(id, rows, labelKey) {
    destroy(id);
    var c = ctx(id); if (!c) return;
    registry[id] = new Chart(c, {
      type: 'bar',
      data: {
        labels: rows.map(function (r) { return r[labelKey] || r.key; }),
        datasets: [{
          label: 'Cost/tin nhắn (₫)',
          data: rows.map(function (r) { return r.cost_per_conv; }),
          backgroundColor: BRAND
        }]
      },
      options: baseOpts({ yMoney: true })
    });
  }

  /** Spend share doughnut. */
  function spendShare(id, rows, labelKey) {
    destroy(id);
    var c = ctx(id); if (!c) return;
    var palette = ['#2e4a62', '#3d6088', '#5b87b0', '#86a9c9', '#b3c9dc', '#d9a05b', '#c0392b', '#1a8f5a'];
    registry[id] = new Chart(c, {
      type: 'doughnut',
      data: {
        labels: rows.map(function (r) { return r[labelKey] || r.key; }),
        datasets: [{
          data: rows.map(function (r) { return r.spend; }),
          backgroundColor: rows.map(function (_, i) { return palette[i % palette.length]; })
        }]
      },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'right' } } }
    });
  }

  function baseOpts(o) {
    o = o || {};
    return {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: function (v) {
              return o.yMoney ? (Number(v) / 1000) + 'k' : v;
            }
          }
        }
      }
    };
  }

  return { trendLine: trendLine, breakdownBar: breakdownBar, spendShare: spendShare, destroy: destroy };
})();
