/*
 * Token contrast gate. Parses `src/theme.css`, resolves every `light-dark()` pair and asserts the
 * WCAG 2.1 ratios that the component set renders: focus rings and control borders at 3:1
 * (SC 1.4.11) and text at 4.5:1 (SC 1.4.3). axe-core has no focus-contrast rule, so this file is
 * the only thing that fails when a token drifts.
 *
 * No dependencies: oklch -> OKLab -> linear sRGB -> relative luminance is implemented here.
 * Out-of-gamut oklch values are clipped per channel rather than gamut-mapped the way a browser
 * would; the difference is well under the margins asserted below.
 *
 * Run: `bun run --cwd packages/ui test`
 */

type Rgb = { r: number; g: number; b: number };
/** Gamma-encoded sRGB in 0..1 plus alpha, the space the compositor blends in. */
type Color = Rgb & { a: number };

const themeCss = new URL('../src/theme.css', import.meta.url);

// ---- color ----------------------------------------------------------------------------------

const srgbFromLinear = (c: number): number =>
	c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

const linearFromSrgb = (c: number): number =>
	c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** `oklch(L C H)` / `oklch(L C H / A%)`, the only color function `theme.css` uses. */
function parseOklch(value: string): Color {
	const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)%\s*)?\)$/.exec(value);
	if (!match) throw new Error(`not an oklch() color: ${value}`);
	const [, lRaw, cRaw, hRaw, aRaw] = match as unknown as [string, string, string, string, string?];
	const l = Number(lRaw);
	const c = Number(cRaw);
	const h = (Number(hRaw) * Math.PI) / 180;
	const a = aRaw === undefined ? 1 : Number(aRaw) / 100;

	const okA = c * Math.cos(h);
	const okB = c * Math.sin(h);
	const lc = (l + 0.3963377774 * okA + 0.2158037573 * okB) ** 3;
	const mc = (l - 0.1055613458 * okA - 0.0638541728 * okB) ** 3;
	const sc = (l - 0.0894841775 * okA - 1.291485548 * okB) ** 3;

	return {
		r: srgbFromLinear(clamp01(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc)),
		g: srgbFromLinear(clamp01(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc)),
		b: srgbFromLinear(clamp01(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc)),
		a,
	};
}

/** Source-over composite of `top` onto an opaque `bottom`, in gamma-encoded sRGB. */
function over(top: Color, bottom: Color): Color {
	return {
		r: top.r * top.a + bottom.r * (1 - top.a),
		g: top.g * top.a + bottom.g * (1 - top.a),
		b: top.b * top.a + bottom.b * (1 - top.a),
		a: 1,
	};
}

/** Tailwind's `<color>/<pct>` mixes with `transparent`, i.e. it scales alpha. */
const alpha = (color: Color, pct: number): Color => ({ ...color, a: color.a * (pct / 100) });

function luminance(color: Color): number {
	const r = linearFromSrgb(color.r);
	const g = linearFromSrgb(color.g);
	const b = linearFromSrgb(color.b);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg: Color, bg: Color): number {
	const top = fg.a === 1 ? fg : over(fg, bg);
	const [lighter, darker] = [luminance(top), luminance(bg)].sort((x, y) => y - x) as [
		number,
		number,
	];
	return (lighter + 0.05) / (darker + 0.05);
}

// ---- theme.css ------------------------------------------------------------------------------

type Scheme = 'light' | 'dark';

/** `--token: light-dark(a, b);` and `--token: a;` declarations from the first `:root` block. */
async function readTokens(): Promise<Map<string, Record<Scheme, string>>> {
	const css = await Bun.file(themeCss).text();
	const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
	if (!root) throw new Error('no :root block in theme.css');
	const tokens = new Map<string, Record<Scheme, string>>();
	for (const line of (root[1] as string).split('\n')) {
		const decl = /^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/.exec(line);
		if (!decl) continue;
		const [, name, value] = decl as unknown as [string, string, string];
		const pair = /^light-dark\(\s*(.+?)\s*,\s*(.+?)\s*\)$/.exec(value);
		if (pair) tokens.set(name, { light: pair[1] as string, dark: pair[2] as string });
		else tokens.set(name, { light: value, dark: value });
	}
	return tokens;
}

const tokens = await readTokens();

function token(name: string, scheme: Scheme): Color {
	const pair = tokens.get(name);
	if (!pair) throw new Error(`theme.css defines no ${name}`);
	return parseOklch(pair[scheme]);
}

// ---- assertions -----------------------------------------------------------------------------

type Check = {
	what: string;
	/** Foreground, possibly translucent, composited onto `on` before measuring. */
	fg: (scheme: Scheme) => Color;
	on: (scheme: Scheme) => Color;
	min: number;
};

/** SC 1.4.11 for focus rings and control boundaries; SC 1.4.3 for text. */
const checks: Check[] = [
	{
		what: '--ring on --background (focus ring, SC 1.4.11)',
		fg: (s) => token('--ring', s),
		on: (s) => token('--background', s),
		min: 3,
	},
	{
		what: '--ring on --card (focus ring inside a card)',
		fg: (s) => token('--ring', s),
		on: (s) => token('--card', s),
		min: 3,
	},
	{
		what: '--ring on --popover (focus ring inside a dialog or menu)',
		fg: (s) => token('--ring', s),
		on: (s) => token('--popover', s),
		min: 3,
	},
	{
		what: '--sidebar-ring on --sidebar (focus ring, SC 1.4.11)',
		fg: (s) => token('--sidebar-ring', s),
		on: (s) => token('--sidebar', s),
		min: 3,
	},
	{
		what: '--input on --background (control border, SC 1.4.11)',
		fg: (s) => token('--input', s),
		on: (s) => token('--background', s),
		min: 3,
	},
	{
		what: '--foreground on --background (body text)',
		fg: (s) => token('--foreground', s),
		on: (s) => token('--background', s),
		min: 4.5,
	},
	{
		what: '--muted-foreground on --background (hints, table headers)',
		fg: (s) => token('--muted-foreground', s),
		on: (s) => token('--background', s),
		min: 4.5,
	},
	{
		what: '--muted-foreground on --muted (avatar initials, badges)',
		fg: (s) => token('--muted-foreground', s),
		on: (s) => token('--muted', s),
		min: 4.5,
	},
	{
		what: '--primary-foreground on --primary (filled button label)',
		fg: (s) => token('--primary-foreground', s),
		on: (s) => token('--primary', s),
		min: 4.5,
	},
	{
		what: '--secondary-foreground on --secondary (button label)',
		fg: (s) => token('--secondary-foreground', s),
		on: (s) => token('--secondary', s),
		min: 4.5,
	},
	{
		what: '--accent-foreground on --accent (menu item label)',
		fg: (s) => token('--accent-foreground', s),
		on: (s) => token('--accent', s),
		min: 4.5,
	},
	{
		what: '--popover-foreground on --popover (dialog and menu text)',
		fg: (s) => token('--popover-foreground', s),
		on: (s) => token('--popover', s),
		min: 4.5,
	},
	{
		what: '--destructive-foreground on --destructive (filled danger button)',
		fg: (s) => token('--destructive-foreground', s),
		on: (s) => token('--destructive', s),
		min: 4.5,
	},
	{
		// The shadcn `destructive` button variant is `bg-destructive/10 text-destructive`.
		what: '--destructive on --destructive/10 over --background (tinted danger button)',
		fg: (s) => token('--destructive', s),
		on: (s) => over(alpha(token('--destructive', s), 10), token('--background', s)),
		min: 4.5,
	},
	{
		// Alert `success`: `border-success/40 bg-success/10 text-success-foreground`.
		what: '--success-foreground on --success/10 over --background (success alert text)',
		fg: (s) => token('--success-foreground', s),
		on: (s) => over(alpha(token('--success', s), 10), token('--background', s)),
		min: 4.5,
	},
	{
		what: '--warning-foreground on --warning/10 over --background (warning alert text)',
		fg: (s) => token('--warning-foreground', s),
		on: (s) => over(alpha(token('--warning', s), 10), token('--background', s)),
		min: 4.5,
	},
	// `--success` itself is only a tint and an `aria-hidden` status dot beside its own text label,
	// so it is decoration under SC 1.4.11 and is deliberately not asserted at 3:1 (it is 2.46:1
	// against the light background).
];

const schemes: Scheme[] = ['light', 'dark'];
let failures = 0;

for (const check of checks) {
	for (const scheme of schemes) {
		const measured = ratio(check.fg(scheme), check.on(scheme));
		const ok = measured >= check.min;
		if (!ok) failures += 1;
		console.log(
			`${ok ? 'ok  ' : 'FAIL'} ${scheme.padEnd(5)} ${measured.toFixed(2)}:1 (>= ${check.min}) ${check.what}`,
		);
	}
}

// Reported only: a black scrim over a near-black page cannot reach 3:1, so what makes
// the dialog readable in dark mode is how far the scrim dims the content behind it.
for (const scheme of schemes) {
	const background = token('--background', scheme);
	const scrim = token('--overlay', scheme);
	const plain = luminance(over(token('--foreground', scheme), background));
	const dimmed = luminance(over(scrim, over(token('--foreground', scheme), background)));
	console.log(
		`note ${scheme.padEnd(5)} --overlay dims content behind the dialog ${(plain / dimmed).toFixed(1)}x ` +
			`(scrim vs --background ${ratio(scrim, background).toFixed(2)}:1)`,
	);
}

if (failures > 0) {
	console.error(`\n${failures} token contrast check(s) failed.`);
	process.exit(1);
}
console.log(`\n${checks.length * schemes.length} token contrast checks passed.`);
