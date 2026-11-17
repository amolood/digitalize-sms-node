const assert = require('node:assert/strict');
const { it } = require('node:test');

it('works from require()', async () => {
    const { DigitalizeSms, InsufficientPointsError, VERSION } = require('digitalize-sms');
    assert.equal(typeof DigitalizeSms, 'function');
    assert.equal(VERSION, require('../package.json').version);

    const fetch = async () => new Response(JSON.stringify({ success: false, error: { code: 'insufficient_points', message: 'x' } }), { status: 402 });
    const sms = new DigitalizeSms({ apiKey: 'sms_abc12345', fetch });
    await assert.rejects(sms.messages.send({ templateId: 1, phone: '0912345678' }), InsufficientPointsError);
});
