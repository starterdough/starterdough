import pkg from '../../../../package.json';

/**
 * The release version, from the root `package.json`, the one place a version is written down.
 * Reported by `/health`, `/admin/system`, the OpenAPI document and the telemetry resource, so all
 * four agree with the changelog. Not `apps/api/package.json`: workspace packages are unversioned.
 */
export const version: string = pkg.version;

/** When this process started; `uptimeSeconds` on the system page derives from it. */
export const startedAt = new Date();
