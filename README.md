# Digitalize SMS — Node.js

حزمة Node.js للربط مع [API الرسائل القصيرة من ديجيتالايز لاب](https://digitalize.sd/developers/sms): أرسل رموز التحقق (OTP) ورسائل التنبيه لعملائك من قوالب معتمدة، بسطر واحد.

```js
import { DigitalizeSms } from 'digitalize-sms';

const sms = new DigitalizeSms();   // يقرأ المفتاح من DIGITALIZE_SMS_KEY

await sms.messages.sendOtp({ templateId: 12, phone: '0912345678', code: '482913' });
```

- تعمل مع Node.js 20.3 أو أحدث، ولا تحتاج أي مكتبة خارجية.
- مكتوبة بـ TypeScript، وتعمل بـ `import` و `require` معاً.
- تعيد المحاولة تلقائياً عند انقطاع الاتصال أو ضغط الخادم، **بدون أن تُرسل الرسالة مرتين أبداً**.
- لكل خطأ نوع خاص به، فتتعامل مع "الرصيد لا يكفي" بشكل مختلف عن "الرقم غير صحيح".

## المحتويات

- [التثبيت](#التثبيت)
- [قبل أن تبدأ](#قبل-أن-تبدأ)
- [الإرسال](#الإرسال)
- [منع تكرار الإرسال](#منع-تكرار-الإرسال)
- [التعامل مع الأخطاء](#التعامل-مع-الأخطاء)
- [سجل الرسائل والقوالب والرصيد](#سجل-الرسائل-والقوالب-والرصيد)
- [الإعدادات](#الإعدادات)

## التثبيت

```bash
npm install digitalize-sms
```

أو `pnpm add digitalize-sms` أو `yarn add digitalize-sms`.

## قبل أن تبدأ

من [لوحة التحكم](https://digitalize.sd/dashboard):

1. **اشترِ باقة نقاط** من صفحة الباقات.
2. **سجّل اسم مرسل** إن كنت سترسل تنبيهات باسم جهتك. رسائل رمز التحقق لا تحتاج اسم مرسل.
3. **أنشئ قالباً** واكتب المتغيّرات بين قوسين، مثل `رمز التحقق الخاص بك هو {code}`. يصبح صالحاً بعد اعتماده، وستحتاج رقمه (`templateId`).
4. **أنشئ مفتاح API** من صفحة [مفاتيح API](https://digitalize.sd/sms/api-keys)، وضعه في متغيّرات البيئة:

```dotenv
DIGITALIZE_SMS_KEY=sms_...
```

> المفتاح يسحب من رصيدك. استخدم الحزمة على الخادم فقط: لا تضع المفتاح في كود المتصفح ولا في تطبيق جوال. إن تسرّب، ألغِه من لوحة التحكم وأنشئ غيره.

## الإرسال

```js
import { DigitalizeSms } from 'digitalize-sms';
// أو: const { DigitalizeSms } = require('digitalize-sms');

const sms = new DigitalizeSms({ apiKey: process.env.DIGITALIZE_SMS_KEY });
```

أنشئ الـ client مرة واحدة واستخدمه في كل التطبيق.

### إرسال رمز تحقق

```js
import { randomInt } from 'node:crypto';

const code = String(randomInt(100000, 1000000));

const message = await sms.messages.sendOtp({
    templateId: 12,
    phone: user.phone,   // أي صيغة: 0912345678 أو +249912345678 أو 00249912345678 أو ٠٩١٢٣٤٥٦٧٨
    code,
});

message.id;              // 5821
message.status;          // 'submitted'
message.pointsCharged;   // 3.5
```

### إرسال تنبيه

```js
await sms.messages.send({
    templateId: 15,                          // "طلبك رقم {order} جاهز للاستلام"
    phone: '0912345678',
    variables: { order: 'A-1017' },
    idempotencyKey: 'order-A-1017-ready',    // اختياري، انظر "منع تكرار الإرسال"
});
```

يجب أن ترسل قيمة لكل متغيّر في القالب، بنفس أسمائها، بلا زيادة ولا نقصان.

### مثال: Express

```js
import express from 'express';
import { randomInt } from 'node:crypto';
import { DigitalizeSms, ValidationError, RateLimitError } from 'digitalize-sms';

const app = express();
const sms = new DigitalizeSms();

app.post('/login/code', express.json(), async (req, res, next) => {
    const code = String(randomInt(100000, 1000000));
    try {
        await sms.messages.sendOtp({ templateId: 12, phone: req.body.phone, code });
        // احفظ الرمز (مشفّراً) مع مدة صلاحية…
        res.json({ sent: true });
    } catch (error) {
        if (error instanceof ValidationError) return res.status(422).json({ error: error.message });
        if (error instanceof RateLimitError) return res.status(429).json({ retryAfter: error.retryAfter });
        next(error);
    }
});
```

## منع تكرار الإرسال

إذا انقطع الاتصال بعد إرسال الطلب، لا تعرف هل خرجت الرسالة أم لا. لذلك كل طلب إرسال يحمل "مفتاح منع تكرار" (Idempotency-Key)، والخادم لا يرسل الرسالة نفسها مرتين.

- **دون أن تفعل شيئاً:** الحزمة تولّد مفتاحاً لكل استدعاء، فإعاداتها التلقائية آمنة.
- **إن كان كودك نفسه قد يعيد الاستدعاء** (Job في Queue مثل BullMQ يُعاد، أو المستخدم يضغط الزر مرتين): مرّر مفتاحاً ثابتاً مرتبطاً بالحدث، مثل رقم الطلب:

```js
const message = await sms.messages.send({
    templateId: 15,
    phone,
    variables: { order: order.number },
    idempotencyKey: `order-${order.id}-ready`,
});

if (message.replayed) {
    // أُرسلت من قبل؛ هذه نفس الرسالة، ولم تُخصم نقاط مرة ثانية
}
```

المفتاح من 8 إلى 100 حرف من `A-Z a-z 0-9 _ . : -`، وأي صيغة غيرها ترمي `TypeError` قبل الإرسال.

استخدام نفس المفتاح لرسالة مختلفة (رقم أو قيم مختلفة) يرمي `ConflictError`.

## التعامل مع الأخطاء

كل أخطاء الطلبات ترث من `DigitalizeSmsError`. أخطاء الـ API ترث من `ApiError`، وفيها:

- `code`: رمز ثابت تعتمد عليه، مثل `'insufficient_points'`.
- `message`: نص عربي جاهز للعرض.
- `status`: حالة HTTP للرد.

```js
import {
    ValidationError,
    InsufficientPointsError,
    RateLimitError,
    DigitalizeSmsError,
} from 'digitalize-sms';

try {
    await sms.messages.sendOtp({ templateId: 12, phone, code });
} catch (error) {
    if (error instanceof ValidationError) {
        // invalid_phone, variables_missing, template_inactive…
        // error.errors للأخطاء لكل حقل، مثل { phone: ['…'] }
    } else if (error instanceof InsufficientPointsError) {
        // نبّه فريقك لشحن الرصيد
    } else if (error instanceof RateLimitError) {
        // حاول بعد error.retryAfter ثانية
    } else if (error instanceof DigitalizeSmsError) {
        // أي خطأ آخر من الخدمة
    }
    throw error;
}
```

| الخطأ | HTTP | متى |
|---|---|---|
| `AuthenticationError` | 401 | المفتاح غير صحيح أو أُلغي |
| `InsufficientPointsError` | 402 | الرصيد لا يكفي. بعد الشحن يمكنك إعادة نفس المفتاح |
| `AccountSuspendedError` | 403 | خدمة الرسائل موقوفة للحساب |
| `NotFoundError` | 404 | القالب أو الرسالة غير موجودة في حسابك |
| `ConflictError` | 409 | مفتاح منع التكرار استُخدم لطلب مختلف |
| `ValidationError` | 400, 422 | رقم أو متغيّرات غير صحيحة، أو قالب غير مفعّل. `errors` للأخطاء لكل حقل |
| `RateLimitError` | 429 | تجاوزت الحدود. `retryAfter` بالثواني |
| `ProviderError` | 502 | رفض المزوّد الرسالة ولم تُخصم نقاط. `smsMessage` للرسالة الفاشلة |
| `ServerError` | 5xx | خطأ في الخادم بعد استنفاد المحاولات |
| `ConnectionError` | — | لم يصل رد (اتصال أو مهلة) بعد استنفاد المحاولات. `timedOut` يوضح أيهما |

القائمة الكاملة لرموز `code` في [التوثيق](https://digitalize.sd/developers/sms#errors). المدخلات الخاطئة في الكود نفسه (مثل `templateId` ليس رقماً) ترمي `TypeError` قبل أي طلب.

### الإعادة التلقائية

تعيد الحزمة المحاولة مرتين (افتراضياً) عند: انقطاع الاتصال أو انتهاء المهلة، أو `429` بانتظار قصير، أو `500` و`503` و`504`. تنتظر ما يطلبه الخادم في `Retry-After` إن كان 10 ثوانٍ أو أقل، وإلا ترمي `RateLimitError` فوراً بدل أن تعطّل طلبك. لا تعيد المحاولة في الأخطاء النهائية مثل الرقم غير الصحيح أو الرصيد غير الكافي.

### إلغاء الطلب

كل دالة تقبل `signal` لإلغاء الطلب وأي انتظار قبل إعادة المحاولة:

```js
await sms.messages.send({ templateId: 15, phone, variables, signal: AbortSignal.timeout(5000) });
await sms.account.get({ signal: controller.signal });
```

## سجل الرسائل والقوالب والرصيد

```js
// الرصيد
const account = await sms.account.get();
account.pointsBalance;       // 350
account.messagesAvailable;   // 100

// رسالة واحدة
const message = await sms.messages.get(5821);

// صفحة من السجل مع تصفية
const page = await sms.messages.list({
    status: 'failed',
    from: new Date(Date.now() - 7 * 24 * 3600 * 1000),
    perPage: 50,
});
page.items;  page.total;  page.hasMore;

// كل النتائج، والصفحات تُجلب تلقائياً
for await (const message of sms.messages.all({ templateId: 12 })) {
    // ...
}

// القوالب
for (const template of await sms.templates.list({ status: 'active' })) {
    console.log(template.id, template.name, template.variables);
}
```

فلاتر `messages.list`: `status`، `templateId`، `phone` (بأي صيغة)، `from` و `to` (كائن `Date` أو نص مثل `'2026-11-30'`، والتاريخ دون وقت في `to` يشمل اليوم كله)، `perPage` (حتى 100)، `page`.

### كائن الرسالة `Message`

| الخاصية | النوع | |
|---|---|---|
| `id` | `number` | رقم الرسالة عندنا |
| `templateId` | `number` | |
| `phone` | `string` | بالصيغة الدولية `249912345678` |
| `status` | `MessageStatus` | `pending`، `submitted`، `delivered`، `undelivered`، `failed`، `unknown` |
| `parts` | `number` | عدد أجزاء الرسالة |
| `pointsCharged` | `number` | صفر إذا فشل الإرسال |
| `error` | `string \| null` | سبب الفشل |
| `idempotencyKey` | `string \| null` | |
| `createdAt`، `sentAt` | `Date \| null` | |
| `replayed` | `boolean` | `true` إذا أعاد الخادم رسالة سابقة بنفس المفتاح |

ودوال مساعدة: `isSent(message)`، `isDelivered(message)`، `isFailed(message)`.

## الإعدادات

```js
const sms = new DigitalizeSms({
    apiKey: process.env.DIGITALIZE_SMS_KEY,
    timeout: 15_000,       // مللي ثانية لكل محاولة
    maxRetries: 2,         // 0 لإيقاف الإعادة التلقائية
    maxRetryWait: 10_000,  // أطول انتظار لـ Retry-After (مللي ثانية) قبل رمي RateLimitError
});
```

المفتاح لا يظهر في `console.log(sms)` ولا في `JSON.stringify(sms)`، والحزمة لا تتبع أي إعادة توجيه (redirect) حتى لا يُرسل المفتاح لجهة أخرى.

### الاختبار في مشروعك

لا ترسل رسائل حقيقية من اختباراتك. مرّر `fetch` خاصاً بك يعيد ردوداً جاهزة:

```js
const sms = new DigitalizeSms({
    apiKey: 'sms_test',
    fetch: async () => Response.json({ success: true, data: { id: 1, status: 'submitted' } }, { status: 201 }),
});
```

## سياسة الاستخدام

الخدمة لرموز التحقق والتنبيهات فقط. **الرسائل الإعلانية والتسويقية ممنوعة**، وكل قالب يُراجع قبل اعتماده.

## الدعم

- التوثيق الكامل: https://digitalize.sd/developers/sms
- مواصفة OpenAPI: https://digitalize.sd/developers/sms/openapi.json
- الدعم الفني: https://digitalize.sd/contact

## الترخيص

MIT. انظر [LICENSE](LICENSE).
