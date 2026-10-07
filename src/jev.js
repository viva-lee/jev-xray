import { sleep } from './util.js';

export const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const JEV_PRICE_PER_MTOK = 0.042; // input only; output tokens are free

export class JevError extends Error {
  constructor(message, { status, body, fatal = false } = {}) {
    super(message);
    this.name = 'JevError';
    this.status = status;
    this.body = body;
    this.fatal = fatal;
  }
}

// Spaces requests evenly at `rps` and caps how many are in flight. The API
// allows 1,200 requests per minute, so the default stays just under it.
export class Limiter {
  constructor({ rps = 18, concurrency = 24 } = {}) {
    this.interval = 1000 / rps;
    this.max = concurrency;
    this.active = 0;
    this.nextAt = 0;
    this.waiters = [];
  }

  async acquire() {
    while (this.active >= this.max) await new Promise((r) => this.waiters.push(r));
    this.active++;
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.interval;
    if (at > now) await sleep(at - now);
  }

  release() {
    this.active--;
    this.waiters.shift()?.();
  }

  // Back off the whole pipeline when the server says so, not just one request.
  pause(ms) {
    this.nextAt = Math.max(this.nextAt, Date.now() + ms);
  }
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export class JevClient {
  constructor({
    apiKey = process.env.TYPESAFE_API_KEY,
    baseURL = process.env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL,
    model = 'jev-latest',
    rps,
    concurrency,
    timeoutMs = 30_000,
    maxRetries = 5,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new JevError('TYPESAFE_API_KEY is not set.', { fatal: true });
    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.fetch = fetchImpl;
    this.limiter = new Limiter({ rps, concurrency });
    this.label = model;
  }

  async systemOne({ state, questions }) {
    const body = JSON.stringify({ model: this.model, state, questions });
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire();
      const started = performance.now();
      let res;
      try {
        res = await this.fetch(`${this.baseURL}/v1/systemone`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        this.limiter.release();
        if (attempt >= this.maxRetries) throw new JevError(`Network error: ${err.message}`);
        await sleep(backoff(attempt));
        continue;
      }
      const latencyMs = performance.now() - started;
      this.limiter.release();

      if (res.ok) {
        const data = await res.json();
        return { ...data, latencyMs };
      }

      const text = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new JevError(`Jev rejected the API key (${res.status}). Check TYPESAFE_API_KEY.`, {
          status: res.status, body: text, fatal: true,
        });
      }
      if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
        this.limiter.pause(wait);
        continue;
      }
      throw new JevError(`Jev returned ${res.status}: ${text.slice(0, 300)}`, { status: res.status, body: text });
    }
  }
}

function backoff(attempt) {
  return Math.min(30_000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
}
