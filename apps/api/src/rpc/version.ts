import pkg from '../../../../package.json';

/**
 * The product's version: `version` in the root `package.json`, which the product owns (the kit
 * ships 0.1.0 and never changes it again). Reported by `/health`, `/admin/system`, the OpenAPI
 * document and the telemetry resource, so all four name the same release of the product. Not
 * `apps/api/package.json`: workspace packages are unversioned.
 */
export const version: string = pkg.version;

/**
 * The kit release this build is on: `kitVersion` in the root `package.json`, which only kit releases
 * change. Shown on `/admin/system` only, never on the public `/health`, where it would tell anyone
 * which kit release, and so which of its known issues, a deployment runs.
 */
export const kitVersion: string = pkg.kitVersion;

/** When this process started; `uptimeSeconds` on the system page derives from it. */
export const startedAt = new Date();
