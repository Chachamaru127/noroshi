<script lang="ts">
	import MailboxView from '$lib/components/MailboxView.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.folder.name} — Noroshi</title>
</svelte:head>

<MailboxView
	view="folder"
	folderName={data.folder.name}
	currentFolderId={data.folder.id}
	folders={data.folders}
	mailbox={data.mailbox}
	filters={data.filters}
/>
