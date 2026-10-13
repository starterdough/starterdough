/**
 * Your product's entries in the app's navigation: the sidebar, the mobile menu and the command
 * palette (Ctrl/⌘+K), each shown before Settings. This file is yours; kit releases never change it.
 *
 * A label is a function the shell calls as it renders, so it follows the user's language: pass the
 * message itself, `label: m.product_nav_reports`, not its result. Your messages go in
 * `apps/web/messages/{en,de}/product.json`, keyed `product_<page>_<element>`.
 *
 *   import FileTextIcon from '@lucide/svelte/icons/file-text';
 *   import { m } from '#lib/paraglide/messages.js';
 *
 *   export const productNavLinks: ProductLink[] = [
 *     { href: '/app/reports', label: m.product_nav_reports, icon: FileTextIcon, keywords: ['pdf'] },
 *   ];
 */
import type { Component } from 'svelte';

export interface ProductLink {
	href: string;
	label: () => string;
	/** An icon component, such as one from `@lucide/svelte/icons/`. */
	icon: Component;
	/** Extra English search terms for the command palette. */
	keywords?: string[];
}

export const productNavLinks: ProductLink[] = [];
