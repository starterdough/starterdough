import { count } from 'drizzle-orm';
import { db } from './client';
import { user } from './schema/auth';

/** Headline numbers for the admin overview. */
export async function platformCounts(): Promise<{ users: number }> {
	const [users] = await db.select({ value: count() }).from(user);
	return { users: users?.value ?? 0 };
}
