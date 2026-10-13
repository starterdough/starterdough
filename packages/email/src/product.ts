/**
 * Your product's email templates, sent with `templates.<name>(props, locale)` from `@repo/email`
 * next to the kit's. This file is yours; kit releases never change it.
 *
 * Build each one with `defineTemplate` from `./render`, never from `./index`: `./index` imports
 * this file, so importing it back would be a cycle. It takes the copy in every locale the app has
 * (`EMAIL_LOCALES`), so a missing translation fails `bun run check`. Interpolate only through the
 * `html` tag, which escapes every value. A name the kit already uses fails at start-up.
 *
 *   import { defineTemplate, html } from './render';
 *
 *   type Export = { name: string; url: string };
 *
 *   export const productTemplates = {
 *     exportReady: defineTemplate<Export>({
 *       en: ({ name, url }) => ({
 *         subject: 'Your export is ready',
 *         title: html`Your export is ready`,
 *         body: html`<p>Hi ${name},</p><p><a href="${url}">Download it</a>.</p>`,
 *         text: `Hi ${name},\n\nDownload your export: ${url}`,
 *       }),
 *       de: ({ name, url }) => ({
 *         subject: 'Dein Export ist fertig',
 *         title: html`Dein Export ist fertig`,
 *         body: html`<p>Hallo ${name},</p><p><a href="${url}">Lade ihn herunter</a>.</p>`,
 *         text: `Hallo ${name},\n\nLade deinen Export herunter: ${url}`,
 *       }),
 *     }),
 *   };
 *
 * Send it in the language of the request that caused it. `localeOf` reads a request's
 * `Accept-Language`, `localeOf(context.headers)` in a procedure; leave it out for the default.
 *
 *   await email.send({ to, ...templates.exportReady({ name, url }, localeOf(context.headers)) });
 */
export const productTemplates = {};
