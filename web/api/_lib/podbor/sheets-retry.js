// Exponential backoff retry для Google Sheets API.
//
// Sheets имеет лимиты:
//   - 60 Read requests per minute per user
//   - 60 Write requests per minute per user (на сервис-аккаунт)
// При превышении возвращается HTTP 429 с message "Quota exceeded for quota metric
// 'Read requests' and limit 'Read requests per minute per user'".
//
// Без retry любой такой ответ → throw → клиент видит "Сервер не отвечает".
// С retry — ждём 1s/2s/4s/8s, в 99% случаев успешно повторяем.
//
// Применяется к ВСЕМ Sheets-вызовам в finish-pipeline (НАЧ, БД, ОТГ, КОРОБЫ).
//
// Ретраим только rate-limit / временные ошибки. 4xx (auth, not_found,
// invalid_argument) — ошибка на нашей стороне, повтор не поможет, бросаем сразу.

const DEFAULT_OPTS = {
  maxAttempts: 5,        // 1 + 4 retry
  initialDelayMs: 1000,
  maxDelayMs: 16000,
  factor: 2,
};

function isRetryable(err) {
  if (!err) return false;
  // googleapis errors: err.code = HTTP status, err.errors[].reason
  const status = err.code || err.status || (err.response && err.response.status);
  if (status === 429) return true;        // Too Many Requests / Quota
  if (status === 503) return true;        // Service Unavailable
  if (status === 500) return true;        // Internal (часто транзиентная)
  // Network-level: ECONNRESET, ETIMEDOUT, EAI_AGAIN
  const code = err.code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN') return true;
  // Sheets иногда отдаёт 200 с message "Quota exceeded" внутри (rare).
  const msg = String(err.message || '').toLowerCase();
  if (msg.includes('quota exceeded') || msg.includes('rate limit')) return true;
  return false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// withRetry(fn, { maxAttempts, initialDelayMs, label })
// fn — async () => result. label — для логов (имя операции).
export async function withRetry(fn, opts = {}) {
  const { maxAttempts, initialDelayMs, maxDelayMs, factor } = { ...DEFAULT_OPTS, ...opts };
  const label = opts.label || 'sheets';
  let delay = initialDelayMs;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt === maxAttempts) throw e;
      const jitter = Math.floor(Math.random() * 250);
      const wait = Math.min(delay + jitter, maxDelayMs);
      console.warn(`[sheets-retry] ${label} attempt ${attempt}/${maxAttempts} failed (${e.code || '?'}: ${(e.message || '').slice(0, 100)}). Retry in ${wait}ms.`);
      await sleep(wait);
      delay = Math.min(delay * factor, maxDelayMs);
    }
  }
  throw lastErr;
}
