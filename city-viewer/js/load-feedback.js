// One visible load panel for independent street-view, blue-dot and catalog work.
// Progress only advances from real transfers/validated shards; elapsed time is not a percentage.
export function createLoadFeedback(doc, { onChange = () => {} } = {}) {
  const byId = id => doc.getElementById(id), jobs = new Map();
  const priority = { street: 3, catalog: 2, blue: 1 };
  let failure = null, timer = null, serial = 0;
  function snapshot() {
    return { pending: [...jobs.values()].map(job => ({ key: job.key, label: job.label, phase: job.phase, verifiedRows: job.verifiedRows || 0, filesDone: job.filesDone || 0, filesTotal: job.filesTotal || 0 })), error: failure?.message || null };
  }
  function render() {
    const panel = byId('loading-overlay');
    const active = [...jobs.values()].sort((a, b) => (priority[b.key] || 0) - (priority[a.key] || 0))[0];
    const shown = active || failure;
    panel.hidden = !shown;
    panel.dataset.state = active ? 'loading' : failure ? 'error' : 'idle';
    byId('loading-cancel').hidden = !active;
    byId('loading-retry').hidden = active || !failure?.retry;
    byId('loading-close').hidden = active || !failure;
    if (shown) {
      byId('loading-title').textContent = active ? shown.label : `${shown.label} · 加载失败`;
      byId('loading-progress').textContent = active ? shown.message || '准备读取目录…' : shown.message;
      const elapsed = active ? Math.floor((Date.now() - shown.startedAt) / 1000) : 0;
      const other = [...jobs.values()].filter(job => job !== active).map(job => job.label);
      const slow = active && elapsed >= 10 ? ' · 网络较慢，可取消后重试；街景与蓝点独立加载' : '';
      byId('loading-detail').textContent = active ? `已等待 ${elapsed} 秒${other.length ? ' · 同时：' + other.join('、') : ''}${slow}` : '先前成功加载的数据未被此次失败覆盖。请重试，或关闭此提示。';
      const bar = byId('loading-bar');
      if (active && Number.isFinite(shown.fraction)) bar.value = Math.max(0, Math.min(0.99, shown.fraction));
      else bar.removeAttribute('value');
      bar.hidden = !active;
    }
    byId('map').setAttribute('aria-busy', String(jobs.size > 0));
    if (jobs.size && !timer) timer = setInterval(render, 1000);
    if (!jobs.size && timer) { clearInterval(timer); timer = null; }
    onChange(snapshot());
  }
  function isCurrent(token) { return jobs.get(token.key)?.serial === token.serial; }
  return {
    start(key, label, { cancel, retry } = {}) {
      const token = { key, serial: ++serial };
      failure = null;
      jobs.set(key, { ...token, label, phase: 'preparing', message: '准备读取目录…', startedAt: Date.now(), cancel, retry });
      render(); return token;
    },
    update(token, detail) { if (isCurrent(token)) { Object.assign(jobs.get(token.key), detail); render(); } },
    finish(token) { if (isCurrent(token)) { jobs.delete(token.key); render(); } },
    fail(token, error) {
      if (!isCurrent(token)) return;
      const job = jobs.get(token.key); jobs.delete(token.key);
      failure = { label: job.label, message: error.message || String(error), retry: job.retry };
      render();
    },
    cancel(key) {
      const selected = key ? [jobs.get(key)].filter(Boolean) : [...jobs.values()];
      for (const job of selected) { jobs.delete(job.key); job.cancel?.(); }
      failure = null; render();
    },
    retry() { const callback = failure?.retry; failure = null; render(); callback?.(); },
    close() { failure = null; render(); },
    getState: snapshot,
  };
}
