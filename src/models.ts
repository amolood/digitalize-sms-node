/** See https://digitalize.sd/developers/sms#statuses */
export type MessageStatus = 'pending' | 'submitted' | 'delivered' | 'undelivered' | 'failed' | 'unknown';

export type TemplateType = 'otp' | 'alert';

/** A message sent through the API. The text and variables are never returned. */
export interface Message {
    id: number;
    templateId: number;
    /** The number in international form, e.g. "249912345678". */
    phone: string;
    status: MessageStatus;
    parts: number;
    pointsCharged: number;
    /** Why the send failed, when it did. */
    error: string | null;
    idempotencyKey: string | null;
    createdAt: Date | null;
    sentAt: Date | null;
    /** True when the API returned an earlier send for the same idempotency key instead of sending again. */
    replayed: boolean;
}

export interface Template {
    id: number;
    name: string;
    type: TemplateType;
    status: string;
    /** True when the template is approved and can be sent from. */
    usable: boolean;
    body: string;
    variables: string[];
    /** The sender name the message shows. */
    sender: string | null;
    approvedAt: Date | null;
    createdAt: Date | null;
}

export interface Account {
    pointsBalance: number;
    pointsPerMessage: number;
    messagesAvailable: number;
    smsSuspended: boolean;
}

/** One page of a list. */
export interface Page<T> {
    items: T[];
    currentPage: number;
    perPage: number;
    total: number;
    lastPage: number;
    hasMore: boolean;
}

/** Accepted by the provider (or delivered). */
export function isSent(message: Pick<Message, 'status'>): boolean {
    return message.status === 'submitted' || message.status === 'delivered';
}

export function isDelivered(message: Pick<Message, 'status'>): boolean {
    return message.status === 'delivered';
}

export function isFailed(message: Pick<Message, 'status'>): boolean {
    return message.status === 'failed' || message.status === 'undelivered';
}

type Raw = Record<string, unknown>;

export function asObject(value: unknown): Raw {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
}

function num(value: unknown): number {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function nullableStr(value: unknown): string | null {
    return value === null || value === undefined ? null : str(value);
}

function date(value: unknown): Date | null {
    if (typeof value !== 'string' || value === '') {
        return null;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** @internal */
export function toMessage(value: unknown, replayed = false): Message {
    const data = asObject(value);
    return {
        id: num(data['id']),
        templateId: num(data['template_id']),
        phone: str(data['phone']),
        status: (str(data['status']) || 'unknown') as MessageStatus,
        parts: num(data['parts']),
        pointsCharged: num(data['points_charged']),
        error: nullableStr(data['error']),
        idempotencyKey: nullableStr(data['idempotency_key']),
        createdAt: date(data['created_at']),
        sentAt: date(data['sent_at']),
        replayed,
    };
}

/** @internal */
export function toTemplate(value: unknown): Template {
    const data = asObject(value);
    const variables = Array.isArray(data['variables']) ? data['variables'].map(str) : [];
    return {
        id: num(data['id']),
        name: str(data['name']),
        type: str(data['type']) as TemplateType,
        status: str(data['status']),
        usable: data['usable'] === true,
        body: str(data['body']),
        variables,
        sender: nullableStr(data['sender']),
        approvedAt: date(data['approved_at']),
        createdAt: date(data['created_at']),
    };
}

/** @internal */
export function toAccount(value: unknown): Account {
    const data = asObject(value);
    return {
        pointsBalance: num(data['points_balance']),
        pointsPerMessage: num(data['points_per_message']),
        messagesAvailable: num(data['messages_available']),
        smsSuspended: data['sms_suspended'] === true,
    };
}

/** @internal */
export function toPage<T>(body: unknown, map: (item: unknown) => T): Page<T> {
    const root = asObject(body);
    const meta = asObject(root['meta']);
    const items = Array.isArray(root['data']) ? root['data'].map(map) : [];
    const currentPage = num(meta['current_page']) || 1;
    const lastPage = num(meta['last_page']) || 1;
    return {
        items,
        currentPage,
        perPage: num(meta['per_page']),
        total: num(meta['total']),
        lastPage,
        hasMore: currentPage < lastPage,
    };
}
