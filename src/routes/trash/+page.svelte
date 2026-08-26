<script lang="ts">
	import MailboxView from '$lib/components/MailboxView.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>ゴミ箱 — QuickMail-ja</title>
</svelte:head>

<MailboxView
	view={data.view}
	folders={data.folders}
	mailbox={data.mailbox}
	filters={data.filters}
/>
