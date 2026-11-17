/** Ids go into the URL path, so only positive integers are accepted. */
export function assertId(id: unknown, name: string): asserts id is number {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
        throw new TypeError(`${name} must be a positive integer.`);
    }
}
