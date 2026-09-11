import { type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * Keyset pagination for the lists that page: the sort column and `id` compared as a tuple.
 *
 * Both halves are needed. `id` breaks the tie when two rows share an instant — one statement
 * inserting several, a bulk update — which a timestamp alone cannot. And the instant travels as
 * text rather than as the `Date` the driver hands back: `timestamptz` keeps microseconds, a
 * JavaScript `Date` only milliseconds, so a cursor built from that value asks for rows before a
 * truncated instant and silently drops every row inside it (`now()` = `…11.10459+00` reaches the
 * process as `…11.104Z`, and page two starts 590 µs too early).
 *
 * The text is written and parsed with an explicit UTC format, so neither the server's `DateStyle`
 * nor its `TimeZone` can change what a cursor means. It is opaque to clients: the API base64-encodes
 * it (`apps/api/src/rpc/cursor.ts`) so nobody builds one by hand.
 */
export interface ListCursor {
	/** `YYYY-MM-DD HH:MM:SS.ffffff` in UTC, exactly as `cursorAt` produced it. */
	at: string;
	id: string;
}

const CURSOR_INSTANT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

/** Guard for the instant half of a cursor that came from a client, before it reaches the cast. */
export function isCursorInstant(value: string): boolean {
	return CURSOR_INSTANT.test(value);
}

/** Select the sort column as the text half of a cursor. */
export function cursorAt(column: PgColumn): SQL<string> {
	return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;
}

const instantOf = (at: string) => sql`(${at} || '+00')::timestamptz`;

/** `(column, id) < cursor` — the next page of a newest-first list. */
export function beforeCursor(column: PgColumn, id: PgColumn, cursor: ListCursor): SQL {
	return sql`(${column}, ${id}) < (${instantOf(cursor.at)}, ${cursor.id})`;
}

/** `(column, id) > cursor` — the next slice of an oldest-first feed. */
export function afterCursor(column: PgColumn, id: PgColumn, cursor: ListCursor): SQL {
	return sql`(${column}, ${id}) > (${instantOf(cursor.at)}, ${cursor.id})`;
}
