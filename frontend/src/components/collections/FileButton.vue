<script setup lang="ts">
/**
 * "Ablegen" (#1548): the one button that puts an item into the basket or a
 * collection, at the same place on every detail page. It opens the shared
 * dialog; the folder icon turns into a filled check while the item lies in
 * the basket.
 */
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import AddToCollectionDialog from './AddToCollectionDialog.vue'
import type { CollectionRuleInput, MemberRef } from '../../api/collections'
import { useBasketStore } from '../../stores/basket'

const props = withDefaults(
  defineProps<{
    members: MemberRef[]
    title?: string
    basket?: { add: () => void; remove: () => void }
    dossierSeed?: CollectionRuleInput | null
    /** Show the word next to the icon. */
    showLabel?: boolean
    size?: 'small' | 'large'
  }>(),
  { title: undefined, basket: undefined, dossierSeed: null, showLabel: false, size: undefined },
)
const emit = defineEmits<{ (e: 'changed'): void }>()

const basketStore = useBasketStore()
const open = ref(false)
const inBasket = computed(() => props.members.length === 1 && basketStore.has(props.members[0]!))
</script>

<template>
  <Button
    :icon="inBasket ? 'pi pi-bookmark-fill' : 'pi pi-bookmark'"
    :label="showLabel ? 'Ablegen' : undefined"
    text
    rounded
    :size="size"
    severity="secondary"
    :aria-label="inBasket ? 'Ablegen (liegt im Basket)' : 'Ablegen: Basket oder Sammelmappe'"
    v-tooltip.bottom="inBasket ? 'Ablegen – liegt im Basket' : 'Ablegen: Basket oder Sammelmappe'"
    aria-haspopup="dialog"
    data-testid="file-button"
    @click="open = true"
  />
  <AddToCollectionDialog
    v-model:visible="open"
    :members="members"
    :title="title"
    :basket="basket"
    :dossier-seed="dossierSeed"
    @changed="emit('changed')"
  />
</template>
