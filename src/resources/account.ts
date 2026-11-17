import type { DigitalizeSms, RequestOptions } from '../client.js';
import { asObject, toAccount, type Account } from '../models.js';

export class AccountResource {
    /** @internal */
    constructor(private readonly client: DigitalizeSms) {}

    /** Points balance, the cost of one message, and how many messages that buys. */
    async get(options: RequestOptions = {}): Promise<Account> {
        const response = await this.client.request('GET', 'account', { signal: options.signal });
        return toAccount(asObject(response.body)['data']);
    }
}
