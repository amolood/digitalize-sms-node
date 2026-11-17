import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';
import {
    DigitalizeSms,
    AuthenticationError,
    ConflictError,
    ConnectionError,
    InsufficientPointsError,
    NotFoundError,
    ProviderError,
    RateLimitError,
    ServerError,
    ValidationError,
    ApiError,
    isSent,
} from '../dist/esm/index.js';

const KEY = 'sms_testkey1234567890';

const MESSAGE = {
    id: 51,
    template_id: 12,
    phone: '249912345678',
    status: 'submitted',
    parts: 1,
    points_charged: 3.5,
    error: null,
    idempotency_key: 'order-1001',
    created_at: '2026-11-16T08:24:07+00:00',
    sent_at: '2026-11-16T08:24:08+00:00',
};

function json(status, body, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fetch that answers from a queue and records every call. */
function fakeFetch(...responses) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url: String(url), init });
        const next = responses.shift();
        if (next === undefined) {
            throw new Error('unexpected extra request');
        }
        if (next instanceof Error) {
            throw next;
        }
        return typeof next === 'function' ? next(url, init) : next;
    };
    fn.calls = calls;
    return fn;
}

function client(fetch, options = {}) {
    const waits = [];
    const sms = new DigitalizeSms({
        apiKey: KEY,
        fetch,
        sleep: async (ms) => { waits.push(ms); },
        ...options,
    });
    sms.waits = waits;
    return sms;
}

describe('construction', () => {
    it('rejects a key that is not sms_…', () => {
        assert.throws(() => new DigitalizeSms({ apiKey: 'abc' }), TypeError);
        assert.throws(() => new DigitalizeSms({ apiKey: 'sms_abc\r\nX-Evil: 1' }), TypeError);
    });

    it('reads the key from DIGITALIZE_SMS_KEY', () => {
        process.env.DIGITALIZE_SMS_KEY = KEY;
        try {
            assert.doesNotThrow(() => new DigitalizeSms({ fetch: fakeFetch() }));
        } finally {
            delete process.env.DIGITALIZE_SMS_KEY;
        }
    });

    it('refuses plain http except for localhost', () => {
        assert.throws(() => new DigitalizeSms({ apiKey: KEY, baseUrl: 'http://digitalize.sd/api/v1/sms' }), /https/);
        assert.throws(() => new DigitalizeSms({ apiKey: KEY, baseUrl: 'https://user:pw@digitalize.sd/api' }), TypeError);
        assert.doesNotThrow(() => new DigitalizeSms({ apiKey: KEY, baseUrl: 'http://localhost:8000/api/v1/sms' }));
    });

    it('never shows the key in console.log or JSON', () => {
        const sms = new DigitalizeSms({ apiKey: KEY, fetch: fakeFetch() });
        assert.ok(!inspect(sms, { depth: 5 }).includes(KEY));
        assert.ok(!JSON.stringify(sms).includes(KEY));
    });
});

describe('messages.send', () => {
    it('posts the message with auth, JSON and a generated idempotency key', async () => {
        const fetch = fakeFetch(json(201, { success: true, data: MESSAGE }));
        const sms = client(fetch);

        const message = await sms.messages.send({ templateId: 12, phone: '0912345678', variables: { code: '482913' } });

        const { url, init } = fetch.calls[0];
        assert.equal(url, 'https://digitalize.sd/api/v1/sms/messages');
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'manual');
        assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
        assert.equal(init.headers['Content-Type'], 'application/json');
        assert.match(init.headers['Idempotency-Key'], /^sdk_[0-9a-f]{32}$/);
        assert.deepEqual(JSON.parse(init.body), { template_id: 12, phone: '0912345678', variables: { code: '482913' } });

        assert.equal(message.id, 51);
        assert.equal(message.templateId, 12);
        assert.equal(message.pointsCharged, 3.5);
        assert.equal(message.replayed, false);
        assert.ok(message.createdAt instanceof Date);
        assert.equal(message.createdAt.toISOString(), '2026-11-16T08:24:07.000Z');
        assert.ok(isSent(message));
    });

    it('marks a replayed send', async () => {
        const fetch = fakeFetch(json(200, { success: true, data: MESSAGE }, { 'Idempotent-Replayed': 'true' }));
        const message = await client(fetch).messages.send({ templateId: 12, phone: '0912345678', idempotencyKey: 'order-1001' });

        assert.equal(fetch.calls[0].init.headers['Idempotency-Key'], 'order-1001');
        assert.equal(message.replayed, true);
    });

    it('sendOtp sends the code variable', async () => {
        const fetch = fakeFetch(json(201, { success: true, data: MESSAGE }));
        await client(fetch).messages.sendOtp({ templateId: 3, phone: '+249912345678', code: '1234' });

        assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { template_id: 3, phone: '+249912345678', variables: { code: '1234' } });
    });

    it('validates input before any request', async () => {
        const fetch = fakeFetch();
        const sms = client(fetch);

        await assert.rejects(sms.messages.send({ templateId: 0, phone: '0912345678' }), TypeError);
        await assert.rejects(sms.messages.send({ templateId: 12, phone: '' }), TypeError);
        await assert.rejects(sms.messages.send({ templateId: 12, phone: '0912345678', idempotencyKey: 'short' }), TypeError);
        await assert.rejects(sms.messages.send({ templateId: 12, phone: '0912345678', idempotencyKey: 'bad key\r\nX: 1' }), TypeError);
        assert.equal(fetch.calls.length, 0);
    });

    it('retries a 503 with the same idempotency key, then succeeds', async () => {
        const fetch = fakeFetch(
            json(503, { success: false, error: { code: 'http_error', message: 'x' } }),
            json(201, { success: true, data: MESSAGE }),
        );
        const sms = client(fetch);

        await sms.messages.send({ templateId: 12, phone: '0912345678' });

        assert.equal(fetch.calls.length, 2);
        assert.equal(fetch.calls[0].init.headers['Idempotency-Key'], fetch.calls[1].init.headers['Idempotency-Key']);
        assert.equal(sms.waits.length, 1);
    });

    it('retries a connection failure', async () => {
        const fetch = fakeFetch(new TypeError('fetch failed'), json(201, { success: true, data: MESSAGE }));
        await client(fetch).messages.send({ templateId: 12, phone: '0912345678' });
        assert.equal(fetch.calls.length, 2);
    });

    it('gives up after maxRetries with a ConnectionError', async () => {
        const fetch = fakeFetch(new TypeError('a'), new TypeError('b'), new TypeError('c'));
        await assert.rejects(client(fetch).messages.send({ templateId: 12, phone: '0912345678' }), ConnectionError);
        assert.equal(fetch.calls.length, 3);
    });

    it('waits out Retry-After on 429, but not when it is too long', async () => {
        const limited = (seconds) => json(429, { success: false, error: { code: 'rate_limited', message: 'x' } }, { 'Retry-After': String(seconds) });

        const fetch = fakeFetch(limited(2), json(201, { success: true, data: MESSAGE }));
        const sms = client(fetch);
        await sms.messages.send({ templateId: 12, phone: '0912345678' });
        assert.deepEqual(sms.waits, [2000]);

        const tooLong = client(fakeFetch(limited(60)));
        const error = await tooLong.messages.send({ templateId: 12, phone: '0912345678' }).catch((e) => e);
        assert.ok(error instanceof RateLimitError);
        assert.equal(error.retryAfter, 60);
        assert.deepEqual(tooLong.waits, []);
    });

    it('retries idempotency_request_in_progress', async () => {
        const fetch = fakeFetch(
            json(409, { success: false, error: { code: 'idempotency_request_in_progress', message: 'x' } }),
            json(200, { success: true, data: MESSAGE }, { 'Idempotent-Replayed': 'true' }),
        );
        const message = await client(fetch).messages.send({ templateId: 12, phone: '0912345678' });
        assert.equal(message.replayed, true);
    });

    it('does not retry errors that will not change', async () => {
        const fetch = fakeFetch(json(402, { success: false, error: { code: 'insufficient_points', message: 'رصيد النقاط غير كافٍ' } }));
        const error = await client(fetch).messages.send({ templateId: 12, phone: '0912345678' }).catch((e) => e);

        assert.ok(error instanceof InsufficientPointsError);
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'insufficient_points');
        assert.equal(error.status, 402);
        assert.equal(error.message, 'رصيد النقاط غير كافٍ');
        assert.equal(fetch.calls.length, 1);
    });

    it('turns a provider refusal into ProviderError with the failed message', async () => {
        const fetch = fakeFetch(json(502, {
            success: false,
            error: { code: 'provider_error', message: 'x' },
            data: { ...MESSAGE, status: 'failed', error: 'تعذّر الإرسال' },
        }));
        const error = await client(fetch).messages.send({ templateId: 12, phone: '0912345678' }).catch((e) => e);

        assert.ok(error instanceof ProviderError);
        assert.equal(error.smsMessage.status, 'failed');
        assert.equal(fetch.calls.length, 1);
    });

    it('stops when the caller aborts', async () => {
        const controller = new AbortController();
        controller.abort(new Error('stop'));
        const fetch = fakeFetch();
        await assert.rejects(client(fetch).messages.send({ templateId: 12, phone: '0912345678', signal: controller.signal }), /stop/);
        assert.equal(fetch.calls.length, 0);
    });

    it('times out a slow request', async () => {
        const hang = (_url, init) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
        });
        const sms = client(fakeFetch(hang), { timeout: 20, maxRetries: 0 });
        const error = await sms.messages.send({ templateId: 12, phone: '0912345678' }).catch((e) => e);

        assert.ok(error instanceof ConnectionError);
        assert.equal(error.timedOut, true);
    });

    it('does not follow redirects', async () => {
        const fetch = fakeFetch(new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
        const error = await client(fetch).messages.send({ templateId: 12, phone: '0912345678' }).catch((e) => e);

        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'invalid_response');
        assert.equal(fetch.calls.length, 1);
    });
});

describe('errors', () => {
    const cases = [
        [401, 'invalid_api_key', AuthenticationError],
        [404, 'template_not_found', NotFoundError],
        [409, 'idempotency_key_reused', ConflictError],
        [422, 'invalid_phone', ValidationError],
        [400, 'invalid_idempotency_key', ValidationError],
        [500, 'server_error', ServerError],
    ];

    for (const [status, code, type] of cases) {
        it(`${status} ${code} → ${type.name}`, async () => {
            const responses = Array.from({ length: 3 }, () => json(status, { success: false, error: { code, message: 'x' } }));
            const error = await client(fakeFetch(...responses)).account.get().catch((e) => e);
            assert.ok(error instanceof type);
            assert.equal(error.name, type.name);
            assert.equal(error.code, code);
        });
    }

    it('exposes per-field validation errors', async () => {
        const fetch = fakeFetch(json(422, {
            success: false,
            error: { code: 'validation_failed', message: 'x', details: { phone: ['رقم غير صحيح'] } },
        }));
        const error = await client(fetch).messages.send({ templateId: 12, phone: '123' }).catch((e) => e);
        assert.deepEqual(error.errors, { phone: ['رقم غير صحيح'] });
    });

    it('handles a body that is not JSON', async () => {
        const fetch = fakeFetch(new Response('<html>Bad gateway</html>', { status: 400 }));
        const error = await client(fetch).account.get().catch((e) => e);
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'invalid_response');
    });

    it('never puts the key in an error', async () => {
        const fetch = fakeFetch(new TypeError('a'), new TypeError('b'), new TypeError('c'));
        const error = await client(fetch).account.get().catch((e) => e);
        assert.ok(!inspect(error, { depth: 10 }).includes(KEY));
    });
});

describe('reading', () => {
    it('account.get', async () => {
        const fetch = fakeFetch(json(200, { success: true, data: { points_balance: 350, points_per_message: 3.5, messages_available: 100, sms_suspended: false } }));
        const account = await client(fetch).account.get();

        assert.equal(fetch.calls[0].url, 'https://digitalize.sd/api/v1/sms/account');
        assert.equal(fetch.calls[0].init.method, 'GET');
        assert.equal(fetch.calls[0].init.body, null);
        assert.deepEqual(account, { pointsBalance: 350, pointsPerMessage: 3.5, messagesAvailable: 100, smsSuspended: false });
    });

    it('templates.list with filters, and get', async () => {
        const template = { id: 3, name: 'OTP', type: 'otp', status: 'active', usable: true, body: 'رمزك {code}', variables: ['code'], sender: 'Authy', approved_at: null, created_at: '2026-11-01T00:00:00+00:00' };
        const fetch = fakeFetch(json(200, { success: true, data: [template] }), json(200, { success: true, data: template }));
        const sms = client(fetch);

        const templates = await sms.templates.list({ type: 'otp' });
        const one = await sms.templates.get(3);

        assert.equal(fetch.calls[0].url, 'https://digitalize.sd/api/v1/sms/templates?type=otp');
        assert.equal(fetch.calls[1].url, 'https://digitalize.sd/api/v1/sms/templates/3');
        assert.equal(templates[0].sender, 'Authy');
        assert.deepEqual(one.variables, ['code']);
        assert.equal(one.approvedAt, null);
    });

    it('rejects ids that are not positive integers', async () => {
        const fetch = fakeFetch();
        const sms = client(fetch);
        await assert.rejects(sms.messages.get('1/../../x'), TypeError);
        await assert.rejects(sms.templates.get(1.5), TypeError);
        assert.equal(fetch.calls.length, 0);
    });

    it('messages.list maps filters and the page', async () => {
        const fetch = fakeFetch(json(200, { success: true, data: [MESSAGE], meta: { current_page: 1, per_page: 25, total: 30, last_page: 2 } }));
        const page = await client(fetch).messages.list({ status: 'failed', templateId: 12, from: new Date('2026-11-01T00:00:00Z'), to: '2026-11-30' });

        const url = new URL(fetch.calls[0].url);
        assert.equal(url.searchParams.get('status'), 'failed');
        assert.equal(url.searchParams.get('template_id'), '12');
        assert.equal(url.searchParams.get('from'), '2026-11-01T00:00:00Z');
        assert.equal(url.searchParams.get('to'), '2026-11-30');
        assert.equal(page.items.length, 1);
        assert.equal(page.total, 30);
        assert.equal(page.hasMore, true);
    });

    it('messages.all walks every page', async () => {
        const fetch = fakeFetch(
            json(200, { success: true, data: [MESSAGE, MESSAGE], meta: { current_page: 1, per_page: 100, total: 3, last_page: 2 } }),
            json(200, { success: true, data: [MESSAGE], meta: { current_page: 2, per_page: 100, total: 3, last_page: 2 } }),
        );
        const seen = [];
        for await (const message of client(fetch).messages.all({ status: 'submitted' })) {
            seen.push(message.id);
        }

        assert.equal(seen.length, 3);
        assert.equal(new URL(fetch.calls[1].url).searchParams.get('page'), '2');
        assert.equal(new URL(fetch.calls[1].url).searchParams.get('per_page'), '100');
    });
});
