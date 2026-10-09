<script setup lang="ts">
/**
 * Scanner-Eingang: welcher Unterordner des Eingangsverzeichnisses zu
 * welchem Benutzer führt.
 *
 * Der Ordnername ist der Login-Slug des Benutzers (aus der E-Mail
 * abgeleitet) und steht nirgends sonst in der Oberfläche. Der Admin, der
 * die Scanner-Ziele einrichtet, liest ihn hier ab, zusammen mit der
 * Gruppe, in der die Importe des Benutzers landen.
 */
import { onMounted, ref } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import ScrollX from '../layout/ScrollX.vue'
import { listInboxFolders, type InboxFoldersResponse } from '../../api/documents'

const data = ref<InboxFoldersResponse | null>(null)
const loading = ref(false)
const error = ref('')

async function load() {
  error.value = ''
  loading.value = true
  try {
    data.value = await listInboxFolders()
  } catch (err: any) {
    error.value = err?.message || 'Eingangsordner konnten nicht geladen werden'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="data-management-group">
    <h3>Scanner-Eingang</h3>
    <p>
      Eine Datei im Eingangsverzeichnis gehört dem Benutzer, dessen Ordner sie
      liegt: <code>{{ data?.inbox_dir ?? '…' }}/&lt;Ordner&gt;/</code>. Seine
      Standard-Gruppe für neue Dokumente entscheidet, ob der Import privat
      bleibt oder in der Gruppe landet. Dateien ohne Benutzerordner gehen an
      den Fallback-Benutzer.
    </p>

    <Message v-if="error" severity="error" class="data-management-group__item" @close="error = ''">
      {{ error }}
    </Message>

    <div v-if="data" class="queue-table-wrapper data-management-group__item">
      <ScrollX>
        <table class="queue-table">
          <thead>
            <tr>
              <th>Ordner</th>
              <th>Benutzer</th>
              <th>Standard-Gruppe</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in data.entries" :key="e.user_id">
              <td><code>{{ e.folder }}/</code></td>
              <td>
                {{ e.name }}
                <span class="text-secondary inbox-email">{{ e.email }}</span>
              </td>
              <td>
                <span v-if="e.default_group_name">{{ e.default_group_name }}</span>
                <span v-else class="text-secondary">privat</span>
              </td>
              <td class="inbox-flags">
                <Tag v-if="e.is_fallback" value="Fallback" severity="info" />
                <Tag
                  v-if="e.shadowed"
                  value="Ordner vergeben"
                  severity="warn"
                  v-tooltip.bottom="'Ein Benutzer mit kleinerer ID hat denselben Ordnernamen und bekommt die Dateien.'"
                />
              </td>
            </tr>
            <tr v-if="data.entries.length === 0">
              <td colspan="4" class="text-secondary" style="text-align:center">Keine Benutzer</td>
            </tr>
          </tbody>
        </table>
      </ScrollX>
    </div>

    <div class="data-management-group__item">
      <Button
        icon="pi pi-refresh"
        outlined
        label="Neu laden"
        :loading="loading"
        @click="load"
      />
    </div>
  </div>
</template>

<style scoped src="./adminPanels.css"></style>

<style scoped>
.inbox-email {
  display: block;
  font-size: var(--text-sm);
}
.inbox-flags {
  display: flex;
  gap: var(--space-1);
  flex-wrap: wrap;
}
</style>
