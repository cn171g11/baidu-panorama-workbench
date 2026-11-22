// Bounded, cancellable metadata transfers with real byte progress (never fake timers).
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

export async function nextPaint() {
  if (typeof requestAnimationFrame !== 'function') return new Promise(resolve => setTimeout(resolve, 0));
  // Yield through a paint before expensive JSON/record validation; hidden tabs use the fallback.
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  });
}

async function transfer(url, options, consume) {
  const { signal, timeoutMs = DEFAULT_TIMEOUT_MS, fetchOptions = {} } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid transfer timeout');
  signal?.throwIfAborted();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DOMException(`网络 ${Math.ceil(timeoutMs / 1000)} 秒没有响应，请检查连接后重试`, 'TimeoutError')), timeoutMs);
  };
  touch();
  try {
    const response = await fetch(url, { ...fetchOptions, signal: combined });
    combined.throwIfAborted();
    if (!response.ok) throw new Error(`数据请求失败 (${response.status})`);
    return await consume(response, combined, touch);
  } catch (error) {
    if (combined.aborted) throw combined.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readBytes(response, signal, touch, { onProgress, expectedBytes, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid transfer byte limit');
  const headerBytes = Number(response.headers?.get?.('content-length'));
  const totalBytes = Number.isSafeInteger(expectedBytes) && expectedBytes >= 0 ? expectedBytes : (Number.isSafeInteger(headerBytes) && headerBytes > 0 ? headerBytes : null);
  let receivedBytes = 0;
  const emit = () => { signal.throwIfAborted(); onProgress?.({ receivedBytes, totalBytes }); };
  emit();
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    signal.throwIfAborted();
    if (bytes.length > maxBytes) throw new Error('Metadata response exceeds byte limit');
    receivedBytes = bytes.length; touch(); emit();
    return bytes;
  }
  const reader = response.body.getReader(), chunks = [];
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      touch(); receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) throw new Error('Metadata response exceeds byte limit');
      chunks.push(value); emit();
    }
    const bytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export function fetchBytes(url, options = {}) {
  return transfer(url, options, (response, signal, touch) => readBytes(response, signal, touch, options));
}

export function fetchJson(url, options = {}) {
  return transfer(url, options, async (response, signal, touch) => {
    // Tiny metadata-only test adapters may supply json() without a real Response body.
    if (!response.body && !response.arrayBuffer) {
      const result = await response.json(); signal.throwIfAborted(); return result;
    }
    const bytes = await readBytes(response, signal, touch, { maxBytes: 16 * 1024 * 1024, ...options });
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  });
}
