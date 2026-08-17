// ── Kinda CM Agent — Retry con backoff exponencial ───────────────────────
// Envuelve llamadas a APIs externas (Gemini, Meta, Serper) para tolerar
// fallos transitorios (503, timeout, rate limit) sin matar el ciclo completo.

'use strict';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Errores que NO vale la pena reintentar (config mala, auth, input inválido)
function isRetryable(err) {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('invalid api key'))      return false;
  if (msg.includes('permission denied'))    return false;
  if (msg.includes('unauthorized'))         return false;
  if (msg.includes('invalid_grant'))        return false;
  return true;
}

/**
 * Reintenta `fn` hasta `retries` veces con backoff exponencial + jitter.
 * @param {() => Promise<any>} fn
 * @param {{retries?: number, baseDelayMs?: number, label?: string}} opts
 */
async function withRetry(fn, opts = {}) {
  const { retries = 3, baseDelayMs = 2000, label = 'operación' } = opts;
  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (!isRetryable(err) || attempt === retries) {
        console.warn(`[retry] ${label} falló definitivamente (intento ${attempt}/${retries}): ${err.message}`);
        throw err;
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
      console.warn(`[retry] ${label} falló (intento ${attempt}/${retries}): ${err.message} — reintentando en ${delay}ms`);
      await sleep(delay);
    }
  }

  throw lastErr;
}

module.exports = { withRetry };
