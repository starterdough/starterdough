import { fileURLToPath } from 'node:url';
import { compile } from '@inlang/paraglide-js';
import { paraglideOptions } from '../i18n.config';

// Keep relative project/output paths stable when this script is invoked from the workspace root.
process.chdir(fileURLToPath(new URL('..', import.meta.url)));

await compile({
	...paraglideOptions,
	// Development and checks favor fewer generated modules; production builds override this in Vite.
	outputStructure: 'locale-modules',
});
