import type { Session } from '@repo/auth/server';

/** Initial context handed to every procedure. Auth is resolved lazily by `requireAuth`. */
export interface Context {
	headers: Headers;
}

/** Context available inside procedures that use `requireAuth`. */
export interface AuthedContext extends Context {
	session: Session;
}

export function createContext(request: Request): Context {
	return { headers: request.headers };
}
