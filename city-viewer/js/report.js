import { loadCatalog } from './data-store.js';

const text = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
try {
  const catalog = await loadCatalog();
  const rows = document.getElementById('report-rows');
  rows.replaceChildren(...catalog.collections.map((item) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${text(item.province)}</td><td>${text(item.name)}</td><td>${text(item.adcode)}</td><td>${text(item.count)}</td>`;
    return tr;
  }));
  document.getElementById('report-empty').hidden = catalog.collections.length > 0;
  const total = document.getElementById('report-total');
  total.textContent = `${Number(catalog.total).toLocaleString()} 条 · ${catalog.collections.length} 个城市`;
  total.dataset.ready = 'true';
  document.querySelector('#report-source .state-dot').style.background = catalog.collections.length ? '#5cc49d' : '#d4a850';
  document.querySelector('#report-source span:last-child').textContent = `百度元数据源：${catalog.total} 条，${catalog.collections.length} 个城市`;
  window.__BAIDU_WORKBENCH__ = Object.freeze({ provider: 'baidu', ready: true, total: catalog.total, collections: catalog.collections.length, source: 'published-catalog' });
} catch (error) {
  document.getElementById('report-total').textContent = '目录暂不可用';
  document.getElementById('report-error').textContent = error.message;
  window.__BAIDU_WORKBENCH__ = Object.freeze({ provider: 'baidu', ready: false, error: error.message });
}
