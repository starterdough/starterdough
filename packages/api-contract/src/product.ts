/**
 * Your product's procedures, and the schemas and types its clients share. This file is yours; kit
 * releases never change it.
 *
 * `index.ts` spreads `productContract` into the contract after every kit procedure, and
 * `@repo/api-client` re-exports everything this file exports. Build procedures from what
 * `./procedures` exports, never from anything in `./index`: that file imports this one, so
 * importing it back is a cycle that fails at start-up. Give each procedure a `route`, so that it
 * is also REST under `/api/v1` and in the OpenAPI document. A feature can live in a file of its
 * own next to this one (`./notes.ts`): spread its procedures in here and add
 * `export * from './notes';`.
 */
export const productContract = {};
