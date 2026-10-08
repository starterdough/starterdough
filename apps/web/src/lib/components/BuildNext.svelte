<script lang="ts">
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import FileCodeIcon from '@lucide/svelte/icons/file-code';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import { m } from '#lib/paraglide/messages.js';

	/**
	 * Next steps for whoever is building on the kit, so `/app` is not a dead end on the first run.
	 * The page renders this in development builds only: your users never see it.
	 *
	 * The guides link to the kit's own repository, readable without running the docs site
	 * (`bun run dev:docs` serves the same pages on :4322). `bun run rename` leaves that path alone.
	 */
	const GUIDES =
		'https://github.com/starterdough/starterdough/blob/main/apps/docs/src/content/docs/guides';
	/** Tagged so the site's analytics can tell a visit that started here. */
	const FULL_EDITION =
		'https://starterdough.dev/?utm_source=app&utm_medium=home&utm_campaign=free-edition';
</script>

<section
	class="border-border rounded-lg border border-dashed p-6"
	aria-labelledby="build-next-heading"
>
	<h2 id="build-next-heading" class="text-lg font-semibold">{m.app_home_build_title()}</h2>
	<p class="text-muted-foreground mb-4 text-sm">{m.app_home_build_description()}</p>
	<ul class="flex flex-col gap-4">
		<li class="flex gap-3">
			<FileCodeIcon class="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden="true" />
			<div class="min-w-0">
				<p class="font-medium">{m.app_home_build_page_title()}</p>
				<p class="text-muted-foreground text-sm">
					{m.app_home_build_page_description()}
					<code class="text-xs break-all">apps/web/src/routes/(app)/app/+page.svelte</code>
				</p>
			</div>
		</li>
		<li class="flex gap-3">
			<BookOpenIcon class="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden="true" />
			<div class="min-w-0">
				<a class="font-medium underline" href="{GUIDES}/feature-example.md">
					{m.app_home_build_feature_title()}
				</a>
				<p class="text-muted-foreground text-sm">{m.app_home_build_feature_description()}</p>
			</div>
		</li>
		<li class="flex gap-3">
			<RocketIcon class="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden="true" />
			<div class="min-w-0">
				<a class="font-medium underline" href="{GUIDES}/serve-anywhere.md">
					{m.app_home_build_ship_title()}
				</a>
				<p class="text-muted-foreground text-sm">{m.app_home_build_ship_description()}</p>
			</div>
		</li>
		<li class="flex gap-3">
			<SparklesIcon class="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden="true" />
			<div class="min-w-0">
				<a class="font-medium underline" href={FULL_EDITION}>{m.app_home_build_full_title()}</a>
				<p class="text-muted-foreground text-sm">{m.app_home_build_full_description()}</p>
			</div>
		</li>
	</ul>
</section>
