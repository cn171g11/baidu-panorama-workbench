import { loadCatalog } from './data-store.js';

const text = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';
const summaryFor = (item) => item.summary || item.importSummary || {};

try {
  const catalog = await loadCatalog();
  const reportRows = document.getElementById('report-rows');
  const search = document.getElementById('report-search');
  let sortKey = 'province';
  let descending = false;
  const render = () => {
    const needle = search.value.trim().toLocaleLowerCase();
    const filtered = catalog.collections.filter((item) => !needle || `${item.province} ${item.name} ${item.adcode}`.toLocaleLowerCase().includes(needle));
    const sorted = [...filtered].sort((a, b) => {
      const av = sortKey === 'province' || sortKey === 'name' ? String(a[sortKey] || '') : Number(summaryFor(a)[sortKey] ?? a.count ?? 0);
      const bv = sortKey === 'province' || sortKey === 'name' ? String(b[sortKey] || '') : Number(summaryFor(b)[sortKey] ?? b.count ?? 0);
      const result = typeof av === 'string' ? av.localeCompare(bv, 'zh-CN') : av - bv;
      return descending ? -result : result;
    });
    reportRows.replaceChildren(...sorted.map((item) => {
      const summary = summaryFor(item);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${text(item.province)}</td><td>${text(item.name)}</td><td>${text(item.adcode)}</td><td>${number(summary.rawRecords ?? item.count)}</td><td>${number(summary.uniquePanoids ?? item.count)}</td><td>${number(summary.exactDuplicates)}</td>`;
      return tr;
    }));
    document.getElementById('report-empty').hidden = sorted.length > 0;
  };
  search.addEventListener('input', render);
  document.querySelectorAll('.report-sort').forEach((button) => button.addEventListener('click', () => {
    if (sortKey === button.dataset.sort) descending = !descending;
    else { sortKey = button.dataset.sort; descending = false; }
    render();
  }));
  render();
  const total = document.getElementById('report-total');
  const summary = catalog.importSummary || {};
  total.textContent = `${number(summary.rawRecords ?? catalog.total)} 原始 · ${number(summary.uniquePanoids ?? catalog.total)} 唯一 · ${catalog.collections.length} 城市`;
  total.dataset.ready = 'true';
  document.querySelector('#report-source .state-dot').style.background = catalog.collections.length ? '#5cc49d' : '#d4a850';
  document.querySelector('#report-source span:last-child').textContent = `百度目录统计：${catalog.collections.length} 个城市`;
  window.__BAIDU_WORKBENCH__ = Object.freeze({ provider: 'baidu', ready: true, total: catalog.total, collections: catalog.collections.length, source: 'published-catalog-summary' });
} catch (error) {
  document.getElementById('report-total').textContent = '目录暂不可用';
  document.getElementById('report-error').textContent = error.message;
  window.__BAIDU_WORKBENCH__ = Object.freeze({ provider: 'baidu', ready: false, error: error.message });
}
