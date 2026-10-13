/**
 * Your query helpers and tables, exported from `@repo/db` next to the kit's. This file is yours;
 * kit releases never change it.
 *
 * A helper here imports `./client` and `./schema` (or a kit helper's own file), never `./index`:
 * `./index` re-exports this file, so importing it back would be a cycle.
 */
export * from './schema/product';
