import { sql } from 'drizzle-orm';
import { customType } from 'drizzle-orm/pg-core';

/**
 * A string as jsonb can hold it. Postgres refuses the whole value over one U+0000, or over half of
 * a surrogate pair (`\ud83d` alone, which `.slice()` leaves when it cuts an emoji in two). Both
 * become U+FFFD, the replacement character, as `toWellFormed()` does for the second.
 */
function storable(text: string): string {
	return text.replaceAll('\u0000', '\uFFFD').toWellFormed();
}

/**
 * `JSON.stringify`'s replacer: every string, key or value, at any depth, made `storable`. It sees
 * each value after its `toJSON` (a `Date` is already its ISO string), so it cleans what is written.
 * Two keys that differ only in what is replaced become one, and the last one wins.
 */
function storableJson(_key: string, value: unknown): unknown {
	if (typeof value === 'string') return storable(value);
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
	if (Object.keys(value).every((key) => storable(key) === key)) return value;
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [storable(key), entry]));
}

/**
 * A `jsonb` column for Bun's Postgres client. Use it instead of drizzle-orm's own `jsonb()` (and
 * `json()`), which hand the driver `JSON.stringify(value)`: Bun prepares statements by default,
 * learns the parameter is jsonb and encodes that string as JSON a second time, so an object is
 * stored as a jsonb *string*. Drizzle's reads parse it back, which hides it, but `metadata->>'name'`
 * and every other JSON operator in SQL find nothing.
 *
 * Here the JSON text is bound as `text` and cast in SQL (`$1::text::jsonb`), so Postgres parses it
 * exactly once, whatever Bun knows about the parameter and with or without prepared statements.
 * Every string in the value is written as jsonb can hold it (`storable`), so no value fails the
 * write: one carrying U+0000 or a cut emoji is stored with U+FFFD in their place.
 * `sql.placeholder()` cannot fill such a column: a placeholder is encoded after the cast is built.
 *
 * Reads return what Bun returns for jsonb, the parsed value, untouched: a jsonb string reads as
 * that string, even one such as `'42'` or `'{"a":1}'`. A row written by drizzle-orm's `jsonb()` is
 * such a string and reads as the JSON text it holds until a migration converts it, so a column
 * moved onto this type needs that migration in the same deploy (UPGRADING.md shows one).
 */
export const jsonb = customType<{ data: unknown; driverData: unknown }>({
	dataType: () => 'jsonb',
	toDriver: (value) => sql`${JSON.stringify(value, storableJson)}::text::jsonb`,
});
