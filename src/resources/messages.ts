import { randomBytes } from 'node:crypto';
import type { DigitalizeSms, RequestOptions } from '../client.js';
import { asObject, toMessage, toPage, type Message, type MessageStatus, type Page } from '../models.js';
import { assertId } from './shared.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,100}$/;

export interface SendMessageParams extends RequestOptions {
    /** The template's id (client area, or templates.list()). */
    templateId: number;
    /** A Sudanese mobile number in any format: 0912345678, +249 912 345 678, 00249… */
    phone: string;
    /** One value per template variable, e.g. { code: '482913' }. */
    variables?: Record<string, string | number> | undefined;
    /**
     * A unique id for this message (your order id, a UUID…). Give one when your own code may repeat the
     * call, e.g. a queued job that retries; the message then goes out once. Without one a random key is
     * generated, which still makes this client's own retries safe.
     */
    idempotencyKey?: string | undefined;
}

export interface SendOtpParams extends RequestOptions {
    templateId: number;
    phone: string;
    code: string;
    idempotencyKey?: string | undefined;
}

export interface ListMessagesParams {
    status?: MessageStatus | undefined;
    templateId?: number | undefined;
    phone?: string | undefined;
    /** From this moment. A Date, or a string such as "2026-11-01". */
    from?: Date | string | undefined;
    /** Until this moment. A date-only string ("2026-11-30") covers that whole day. */
    to?: Date | string | undefined;
    /** 1 to 100, default 25. */
    perPage?: number | undefined;
    page?: number | undefined;
}

export class MessagesResource {
    /** @internal */
    constructor(private readonly client: DigitalizeSms) {}

    /**
     * Sends one message from an approved template.
     *
     * @throws InsufficientPointsError, ValidationError, ProviderError, RateLimitError… (all ApiError)
     * @throws ConnectionError when the API can't be reached after the retries
     */
    async send(params: SendMessageParams): Promise<Message> {
        assertId(params.templateId, 'templateId');
        if (typeof params.phone !== 'string' || params.phone.trim() === '') {
            throw new TypeError('phone must be a non-empty string.');
        }

        const idempotencyKey = params.idempotencyKey ?? `sdk_${randomBytes(16).toString('hex')}`;
        if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
            throw new TypeError('idempotencyKey must be 8 to 100 characters of A-Z, a-z, 0-9, _ . : -');
        }

        const payload: Record<string, unknown> = { template_id: params.templateId, phone: params.phone };
        if (params.variables !== undefined && Object.keys(params.variables).length > 0) {
            payload['variables'] = params.variables;
        }

        const response = await this.client.request('POST', 'messages', {
            json: payload,
            headers: { 'Idempotency-Key': idempotencyKey },
            signal: params.signal,
        });

        const replayed = response.headers.get('idempotent-replayed')?.toLowerCase() === 'true';
        return toMessage(asObject(response.body)['data'], replayed);
    }

    /** Shortcut for an OTP template, whose only variable is {code}. */
    sendOtp(params: SendOtpParams): Promise<Message> {
        const { code, ...rest } = params;
        return this.send({ ...rest, variables: { code } });
    }

    async get(id: number, options: RequestOptions = {}): Promise<Message> {
        assertId(id, 'id');
        const response = await this.client.request('GET', `messages/${id}`, { signal: options.signal });
        return toMessage(asObject(response.body)['data']);
    }

    /** One page of sent messages, newest first. */
    async list(params: ListMessagesParams = {}, options: RequestOptions = {}): Promise<Page<Message>> {
        const response = await this.client.request('GET', 'messages', {
            query: {
                status: params.status,
                template_id: params.templateId,
                phone: params.phone,
                from: formatDate(params.from),
                to: formatDate(params.to),
                per_page: params.perPage,
                page: params.page,
            },
            signal: options.signal,
        });
        return toPage(response.body, (item) => toMessage(item));
    }

    /**
     * Every message matching the filters, fetching pages of 100 as you iterate.
     *
     *     for await (const message of sms.messages.all({ status: 'failed' })) { … }
     */
    async *all(params: Omit<ListMessagesParams, 'page' | 'perPage'> = {}, options: RequestOptions = {}): AsyncGenerator<Message, void, undefined> {
        for (let page = 1; ; page++) {
            const result = await this.list({ ...params, perPage: 100, page }, options);
            yield* result.items;
            if (!result.hasMore) {
                return;
            }
        }
    }
}

function formatDate(value: Date | string | undefined): string | undefined {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            throw new TypeError('Invalid Date.');
        }
        return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
    return value;
}
