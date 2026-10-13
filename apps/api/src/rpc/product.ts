/**
 * Your product's handlers, one entry for each key of `productContract` in
 * `packages/api-contract/src/product.ts`. This file is yours; kit releases never change it.
 *
 * `router.ts` spreads `productRouter` into the router after every kit handler, and
 * `bun run check` fails while a procedure in your contract has no handler here. Build handlers on
 * `authed`, `adminOnly` or `os` from `./base`, as the kit's routers do. A feature can live in a file
 * of its own next to this one (`./notes.ts`): add its router here as `notes: notesRouter`.
 */
export const productRouter = {};
