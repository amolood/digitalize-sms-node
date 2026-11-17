import { ApiError, ConnectionError, errorFromResponse } from './errors.js';
import { AccountResource } from './resources/account.js';
import { MessagesResource } from './resources/messages.js';
import { TemplatesResource } from './resources/templates.js';

export const VERSION = '1.0.0';
export const DEFAULT_BASE_URL = 'https://digitalize.sd/api/v1/sms';

export interface ClientOptions {
    /** Your key from the client area ("sms_…"). Defaults to the DIGITALIZE_SMS_KEY environment variable. */
    apiKey?: string | undefined;
    /** Defaults to https://digitalize.sd/api/v1/sms. Must be https (http is allowed only for localhost). */
    baseUrl?: string | undefined;
    /** Milliseconds allowed for one attempt, including reading the response. Default 15000. */
    timeout?: number | undefined;
    /** Extra attempts after a timeout, a 429 or a 5xx. Default 2; 0 disables retries. */
    maxRetries?: number | undefined;
    /** The longest Retry-After, in milliseconds, the client will wait out itself. Default 10000. */
    maxRetryWait?: number | undefined;
    /** A fetch implementation, for tests or proxies. Defaults to the global fetch. */
    fetch?: typeof fetch | undefined;
    /** @internal waits between retries; replaced in tests */
    sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

/** Per-call options. */
export interface RequestOptions {
    /** Cancels the call (and any retry it is waiting on). */
    signal?: AbortSignal | undefined;
}

/** @internal */
export interface RequestInit {
    query?: Record<string, string | number | undefined | null>;
    json?: Record<string, unknown>;
    headers?: Record<string, string>;
    signal?: AbortSignal | undefined;
}

/** @internal */
export interface ApiResponse {
    status: number;
    headers: Headers;
    body: unknown;
}

const KEY_PATTERN = /^sms_[A-Za-z0-9]+$/;
const RETRYABLE_STATUSES = new Set([429, 500, 503, 504]);

/**
 * Client for the Digitalize Lab SMS API (https://digitalize.sd/developers/sms).
 *
 *     const sms = new DigitalizeSms({ apiKey: process.env.DIGITALIZE_SMS_KEY });
 *     const message = await sms.messages.send({ templateId: 12, phone: '0912345678', variables: { code: '482913' } });
 *
 * Every send carries an idempotency key (generated when you don't give one), so the client retries
 * timeouts, 429s and 5xx errors on its own without ever sending a message twice.
 */
export class DigitalizeSms {
    readonly messages: MessagesResource;
    readonly templates: TemplatesResource;
    readonly account: AccountResource;

    readonly #apiKey: string;
    readonly #baseUrl: string;
    readonly #timeout: number;
    readonly #maxRetries: number;
    readonly #maxRetryWait: number;
    readonly #fetch: typeof fetch;
    readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

    constructor(options: ClientOptions = {}) {
        const apiKey = options.apiKey ?? process.env['DIGITALIZE_SMS_KEY'];
        if (typeof apiKey !== 'string' || !KEY_PATTERN.test(apiKey)) {
            throw new TypeError(
                'The Digitalize SMS API key must start with "sms_". Pass { apiKey } or set DIGITALIZE_SMS_KEY. '
                + 'Create one at https://digitalize.sd/sms/api-keys',
            );
        }
        this.#apiKey = apiKey;
        this.#baseUrl = parseBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
        this.#timeout = positive(options.timeout, 15_000, 'timeout');
        this.#maxRetries = Math.floor(positive(options.maxRetries, 2, 'maxRetries', true));
        this.#maxRetryWait = positive(options.maxRetryWait, 10_000, 'maxRetryWait', true);

        const fetchImpl = options.fetch ?? globalThis.fetch;
        if (typeof fetchImpl !== 'function') {
            throw new TypeError('No fetch implementation found. Use Node.js 20 or newer, or pass { fetch }.');
        }
        this.#fetch = fetchImpl;
        this.#sleep = options.sleep ?? sleep;

        this.messages = new MessagesResource(this);
        this.templates = new TemplatesResource(this);
        this.account = new AccountResource(this);
    }

    /**
     * Sends a request and returns the successful response, retrying transient failures.
     * Only for requests that are safe to repeat: GETs, and POSTs carrying an Idempotency-Key.
     *
     * @internal used by the resource classes
     */
    async request(method: 'GET' | 'POST', path: string, init: RequestInit = {}): Promise<ApiResponse> {
        const url = new URL(`${this.#baseUrl}/${path}`);
        for (const [name, value] of Object.entries(init.query ?? {})) {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.append(name, String(value));
            }
        }

        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.#apiKey}`,
            Accept: 'application/json',
            'User-Agent': `digitalize-sms-node/${VERSION} Node/${process.version}`,
            ...init.headers,
        };

        let body: string | undefined;
        if (init.json !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(init.json);
        }

        for (let attempt = 0; ; attempt++) {
            let response: ApiResponse;
            try {
                response = await this.#send(method, url, headers, body, init.signal);
            } catch (error) {
                if (!(error instanceof ConnectionError) || attempt >= this.#maxRetries) {
                    throw error;
                }
                await this.#sleep(backoff(attempt), init.signal);
                continue;
            }

            if (response.status >= 200 && response.status < 300) {
                return response;
            }

            const error = errorFromResponse(response.status, response.headers, response.body);
            const wait = this.#retryWait(error, attempt);
            if (wait === null) {
                throw error;
            }
            await this.#sleep(wait, init.signal);
        }
    }

    async #send(method: string, url: URL, headers: Record<string, string>, body: string | undefined, signal: AbortSignal | undefined): Promise<ApiResponse> {
        signal?.throwIfAborted();
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), this.#timeout);

        try {
            const response = await this.#fetch(url, {
                method,
                headers,
                body: body ?? null,
                signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
                // A redirect would carry the key somewhere else; the API never redirects.
                redirect: 'manual',
            });
            const text = await response.text();
            return { status: response.status, headers: response.headers, body: parseJson(text) };
        } catch (error) {
            if (signal?.aborted) {
                throw signal.reason;
            }
            if (timeout.signal.aborted) {
                throw new ConnectionError(`The Digitalize SMS API did not answer within ${this.#timeout} ms.`, { cause: error, timedOut: true });
            }
            const reason = error instanceof Error ? error.message : String(error);
            throw new ConnectionError(`Could not reach the Digitalize SMS API: ${reason}`, { cause: error });
        } finally {
            clearTimeout(timer);
        }
    }

    /** Milliseconds to wait before retrying, or null when this error must not (or can no longer) be retried. */
    #retryWait(error: ApiError, attempt: number): number | null {
        if (attempt >= this.#maxRetries) {
            return null;
        }
        if (!RETRYABLE_STATUSES.has(error.status) && error.code !== 'idempotency_request_in_progress') {
            return null;
        }

        const retryAfter = Number(error.headers.get('retry-after') ?? NaN);
        const wait = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : backoff(attempt);

        return wait <= this.#maxRetryWait ? wait : null;
    }

    /** Keeps the key out of console.log() and error trackers. */
    [Symbol.for('nodejs.util.inspect.custom')](): object {
        return this.toJSON();
    }

    toJSON(): object {
        return { baseUrl: this.#baseUrl, apiKey: `${this.#apiKey.slice(0, 8)}…` };
    }
}

function parseBaseUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new TypeError('baseUrl must be a valid URL.');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
        throw new TypeError('baseUrl must use https (http is allowed only for localhost), so the API key is never sent in the clear.');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new TypeError('baseUrl must not contain credentials, a query string or a fragment.');
    }
    return url.href.replace(/\/+$/, '');
}

function positive(value: number | undefined, fallback: number, name: string, allowZero = false): number {
    if (value === undefined) {
        return fallback;
    }
    if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
        throw new TypeError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} number.`);
    }
    return value;
}

function parseJson(text: string): unknown {
    if (text === '') {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** 500 ms, 1 s, 2 s… with jitter so many clients don't retry in lockstep. */
function backoff(attempt: number): number {
    return Math.min(500 * 2 ** attempt, 8_000) * (0.75 + Math.random() * 0.5);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
