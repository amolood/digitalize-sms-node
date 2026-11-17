import { asObject, toMessage, type Message } from './models.js';

/** Base class of every error this package throws for a failed request. */
export class DigitalizeSmsError extends Error {
    override readonly name: string = 'DigitalizeSmsError';
}

/** The API could not be reached, or did not answer in time. Safe to retry: sends carry an idempotency key. */
export class ConnectionError extends DigitalizeSmsError {
    override readonly name: string = 'ConnectionError';
    readonly timedOut: boolean;

    constructor(message: string, options: { cause?: unknown; timedOut?: boolean } = {}) {
        super(message, { cause: options.cause });
        this.timedOut = options.timedOut ?? false;
    }
}

export interface ApiErrorInit {
    message: string;
    code: string;
    status: number;
    details?: Record<string, unknown> | null;
    data?: Record<string, unknown> | null;
    headers?: Headers;
}

/**
 * The API answered with an error. `code` is the stable value to branch on
 * (https://digitalize.sd/developers/sms#errors); `message` is human-readable Arabic text.
 */
export class ApiError extends DigitalizeSmsError {
    override readonly name: string = 'ApiError';
    /** Stable machine-readable code, e.g. "insufficient_points" or "invalid_phone". */
    readonly code: string;
    /** HTTP status code. */
    readonly status: number;
    /** Extra information, e.g. per-field errors for validation_failed. */
    readonly details: Record<string, unknown> | null;
    /** The `data` the API sent along with the error, if any. */
    readonly data: Record<string, unknown> | null;
    readonly headers: Headers;

    constructor(init: ApiErrorInit) {
        super(init.message);
        this.code = init.code;
        this.status = init.status;
        this.details = init.details ?? null;
        this.data = init.data ?? null;
        this.headers = init.headers ?? new Headers();
    }
}

/** 401: the API key is missing, wrong or revoked. */
export class AuthenticationError extends ApiError {
    override readonly name: string = 'AuthenticationError';
}

/** 402: not enough points for this message. Top up, then send again. */
export class InsufficientPointsError extends ApiError {
    override readonly name: string = 'InsufficientPointsError';
}

/** 403: SMS sending is suspended on this account. */
export class AccountSuspendedError extends ApiError {
    override readonly name: string = 'AccountSuspendedError';
}

/** 404: the template or message doesn't exist, or belongs to another account. */
export class NotFoundError extends ApiError {
    override readonly name: string = 'NotFoundError';
}

/** 409: the idempotency key was used for a different request, or that request is still running. */
export class ConflictError extends ApiError {
    override readonly name: string = 'ConflictError';
}

/** 400 / 422: something in the request is wrong (phone, variables, template state…). */
export class ValidationError extends ApiError {
    override readonly name: string = 'ValidationError';

    /** Per-field messages when code is "validation_failed", e.g. { phone: ["…"] }. */
    get errors(): Record<string, string[]> {
        const errors: Record<string, string[]> = {};
        for (const [field, messages] of Object.entries(this.details ?? {})) {
            errors[field] = Array.isArray(messages) ? messages.map(String) : [String(messages)];
        }
        return errors;
    }
}

/** 429: too many requests. `retryAfter` is how many seconds to wait. */
export class RateLimitError extends ApiError {
    override readonly name: string = 'RateLimitError';

    get retryAfter(): number | null {
        const value = this.headers.get('retry-after');
        if (value === null || value.trim() === '') {
            return null;
        }
        const seconds = Number(value);
        return Number.isFinite(seconds) ? seconds : null;
    }
}

/** 502: the SMS provider refused the message. The points were refunded; `smsMessage` is the failed send. */
export class ProviderError extends ApiError {
    override readonly name: string = 'ProviderError';

    get smsMessage(): Message | null {
        return this.data === null ? null : toMessage(this.data);
    }
}

/** 5xx: a server error. Retried automatically before it reaches you. */
export class ServerError extends ApiError {
    override readonly name: string = 'ServerError';
}

/** @internal */
export function errorFromResponse(status: number, headers: Headers, body: unknown): ApiError {
    const root = asObject(body);
    const error = asObject(root['error']);

    const code = typeof error['code'] === 'string' ? error['code'] : 'invalid_response';
    const message = typeof error['message'] === 'string'
        ? error['message']
        : `Unexpected response from the Digitalize SMS API (HTTP ${status}).`;
    const details = error['details'] !== null && typeof error['details'] === 'object' ? asObject(error['details']) : null;
    const data = root['data'] !== null && typeof root['data'] === 'object' ? asObject(root['data']) : null;
    const init: ApiErrorInit = { message, code, status, details, data, headers };

    if (status === 401) return new AuthenticationError(init);
    if (status === 402) return new InsufficientPointsError(init);
    if (status === 403) return new AccountSuspendedError(init);
    if (status === 404) return new NotFoundError(init);
    if (status === 409) return new ConflictError(init);
    if (status === 400 || status === 422) return new ValidationError(init);
    if (status === 429) return new RateLimitError(init);
    if (code === 'provider_error') return new ProviderError(init);
    if (status >= 500) return new ServerError(init);
    return new ApiError(init);
}
