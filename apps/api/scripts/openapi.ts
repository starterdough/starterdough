/**
 * Write the OpenAPI document to apps/api/openapi.json.
 * Use it to generate clients for non-TypeScript consumers, e.g. the Python service:
 *   uvx openapi-python-client generate --path apps/api/openapi.json
 */
import { generateSpec } from '../src/rpc/handler';

const spec = await generateSpec();
const target = new URL('../openapi.json', import.meta.url);
await Bun.write(target, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`✓ wrote ${target.pathname}`);
