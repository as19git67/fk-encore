<script setup lang="ts">
/**
 * Icon button "Link teilen" for detail pages whose `#actions` slot holds
 * plain buttons (the toolbar-based pages use `shareLinkItem` instead). Shares
 * the internal URL of the given route — see `useShareLink` for what the link
 * means and how share vs. clipboard is decided.
 */
import Button from 'primevue/button'
import type { RouteLocationRaw } from 'vue-router'
import { useShareLink } from '../composables/useShareLink'

const props = defineProps<{
  /** The detail route the link points at. */
  to: RouteLocationRaw
  /** Title handed to the native share sheet (the entity's name). */
  title?: string
}>()

const { copied, shareLink } = useShareLink()
</script>

<template>
  <Button
    :icon="copied ? 'pi pi-check' : 'pi pi-link'"
    text
    rounded
    severity="secondary"
    :aria-label="copied ? 'Link kopiert' : 'Link teilen'"
    v-tooltip.top="copied ? 'Link kopiert' : 'Link teilen'"
    @click="shareLink(props.to, props.title)"
  />
</template>
