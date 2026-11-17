import type { DigitalizeSms, RequestOptions } from '../client.js';
import { asObject, toTemplate, type Template, type TemplateType } from '../models.js';
import { assertId } from './shared.js';

export interface ListTemplatesParams {
    type?: TemplateType | undefined;
    /** e.g. "active" */
    status?: string | undefined;
}

export class TemplatesResource {
    /** @internal */
    constructor(private readonly client: DigitalizeSms) {}

    /** Your templates, with their variables and approval state. */
    async list(params: ListTemplatesParams = {}, options: RequestOptions = {}): Promise<Template[]> {
        const response = await this.client.request('GET', 'templates', {
            query: { type: params.type, status: params.status },
            signal: options.signal,
        });
        const data = asObject(response.body)['data'];
        return Array.isArray(data) ? data.map((item) => toTemplate(item)) : [];
    }

    async get(id: number, options: RequestOptions = {}): Promise<Template> {
        assertId(id, 'id');
        const response = await this.client.request('GET', `templates/${id}`, { signal: options.signal });
        return toTemplate(asObject(response.body)['data']);
    }
}
