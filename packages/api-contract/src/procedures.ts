import { oc } from '@orpc/contract';

/**
 * The builders and text rules every contract file shares. `index.ts` builds the kit's procedures
 * from them, and a feature can do the same in a file of its own next to it: import from here,
 * export an object of procedures and spread it into `contract` in `index.ts`. The feature's
 * procedures then stay out of the file every kit release changes.
 */

// ── Base builders ──────────────────────────────────────────────────────────────

export const publicProcedure = oc;

export const protectedProcedure = oc.errors({
	UNAUTHORIZED: { message: 'You must be signed in.' },
	FORBIDDEN: { message: 'You do not have access to this resource.' },
});

/** Same errors; `FORBIDDEN` additionally covers "signed in but not a platform admin". */
export const adminProcedure = protectedProcedure;

// ── Text rules ─────────────────────────────────────────────────────────────────

/**
 * Control characters in stored free text are refused here, at the edge every caller passes: a
 * newline in a name becomes a second email header, and a stray code point in a
 * `content-disposition` filename throws where the header is built.
 *
 * `allowWhitespace` keeps tab, LF and CR, for the one field where paragraphs are legitimate.
 */
export function hasControlCharacter(value: string, allowWhitespace: boolean): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (allowWhitespace && (code === 9 || code === 10 || code === 13)) continue;
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

export const controlCharacterRule = {
	error: 'Remove line breaks and control characters',
	// `params` lets UIs recognise the rule and phrase it in the user's language.
	params: { reason: 'control_characters' },
} as const;

/** A name, title or label: `.refine(isSingleLine, controlCharacterRule)`. */
export const isSingleLine = (value: string) => !hasControlCharacter(value, false);
/** Text with paragraphs: tab, LF and CR pass, every other control character is refused. */
export const isPlainText = (value: string) => !hasControlCharacter(value, true);
