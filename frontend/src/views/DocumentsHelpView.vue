<script setup lang="ts">
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const auth = useAuthStore()

function goBack() {
  if (window.history.state?.back) {
    router.back()
  } else {
    router.push({ name: 'dokumente-list' })
  }
}
</script>

<template>
  <div class="help-view">
    <div class="header">
      <Button icon="pi pi-arrow-left" label="Zurück" text @click="goBack" />
      <h1 class="title"><i class="pi pi-question-circle" /> Dokumente – Hilfe</h1>
    </div>

    <p class="intro">
      Das Dokumente-Modul verwaltet PDFs deiner Gruppen. Nach dem Upload
      werden Text extrahiert und Inhalte von einer lokalen KI klassifiziert:
      Kategorie, Titel, Absender, Datum, Tags, Zusammenfassung und – falls
      zutreffend – Steuerrelevanz samt Jahr und Sektionen. Du kannst alle
      Vorschläge prüfen, anpassen und bei Bedarf eine Neuanalyse anstoßen.
    </p>

    <section class="help-section">
      <h2><i class="pi pi-upload" /> 1. Hochladen</h2>
      <p>
        Über <strong>Hochladen</strong> (Schaltfläche oben rechts in der
        Dokumentenliste) öffnet sich der Upload-Dialog. Dort kannst du:
      </p>
      <ul>
        <li>PDFs per <em>Drag &amp; Drop</em> in die Ablage ziehen, oder</li>
        <li>durch Klick auf die Ablage den Dateiauswahl-Dialog öffnen.</li>
      </ul>
      <p>
        Mehrere Dateien dürfen gleichzeitig ausgewählt werden. Nicht-PDF-Dateien
        werden direkt abgelehnt. Die Warteschlange zeigt für jede Datei den
        Status an:
      </p>
      <ul class="status-list">
        <li><Tag severity="secondary" value="Wartet" /> noch nicht hochgeladen</li>
        <li><Tag severity="info" value="Wird hochgeladen" /> Übertragung läuft</li>
        <li><Tag severity="success" value="Hochgeladen" /> Upload fertig, Klassifikation läuft im Hintergrund</li>
        <li><Tag severity="warn" value="Bereits vorhanden" /> identisches Dokument ist schon gespeichert</li>
        <li><Tag severity="danger" value="Fehler" /> Upload fehlgeschlagen (Meldung wird eingeblendet)</li>
      </ul>
      <p>
        Die eigentliche Verarbeitung (Text, KI) passiert asynchron – du kannst
        sofort zur Liste zurückkehren und den Fortschritt dort verfolgen.
      </p>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-cog" /> 2. Verarbeitungs-Pipeline</h2>
      <p>Jedes Dokument durchläuft automatisch diese Stufen:</p>
      <ol class="pipeline">
        <li>
          <Tag severity="secondary" value="Warteschlange" />
          Eingangs-Status direkt nach dem Upload.
        </li>
        <li>
          <Tag severity="info" value="Text-Extraktion" />
          Text wird aus der PDF gelesen; bei Scans greift automatisch OCR.
        </li>
        <li>
          <Tag severity="info" value="KI-Analyse" />
          Die lokale KI bestimmt Kategorie, Metadaten und Steuerzuordnung.
        </li>
        <li>
          <Tag severity="success" value="Fertig" />
          Klassifikation abgeschlossen – Dokument ist durchsuchbar.
        </li>
        <li>
          <Tag severity="danger" value="Fehler" />
          Etwas ist schiefgelaufen. Die Fehlermeldung wird inline angezeigt
          und ein Neuversuch ist jederzeit möglich.
        </li>
      </ol>
      <p class="hint">
        Status-Änderungen erscheinen live über Realtime-Events – du musst die
        Seite nicht neu laden.
      </p>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-list" /> 3. Dokumentenliste</h2>
      <p>Die Startseite <strong>Alle Dokumente</strong> bietet:</p>
      <ul>
        <li>
          <strong>Suche</strong>: Freitextfeld oben. Drei Suchmodi (per
          Umschalter wählbar, die Auswahl wird lokal gespeichert):
          <ul>
            <li><strong>Text</strong> – exakte Wörter / Volltextsuche.</li>
            <li><strong>Bedeutung</strong> – semantisch über Embeddings (findet Paraphrasen).</li>
            <li><strong>Hybrid</strong> (Standard) – kombiniert beide Verfahren.</li>
          </ul>
        </li>
        <li>
          <strong>Kategorie-Filter</strong>: zeigt nur Dokumente der gewählten
          Kategorie (Unterkategorien sind eingerückt).
        </li>
        <li>
          <strong>Status-Filter</strong>: z.&nbsp;B. nur <em>Fertig</em>,
          <em>In&nbsp;Arbeit</em> oder <em>Fehler</em>.
        </li>
        <li>
          <strong>„Nur zu prüfen"</strong>: bündelt fehlgeschlagene Dokumente
          sowie ready-Dokumente mit niedriger KI-Konfidenz (&lt;&nbsp;60&nbsp;%)
          in einer Ansicht – ideal als To-Do-Liste.
        </li>
      </ul>
      <p>
        Jede Karte zeigt Titel, Kategorie, Absender, Datum, Dateigröße, Tags
        sowie Warn-Badges (niedrige Konfidenz, Fehlermeldung). Ein Klick
        (oder <kbd>Enter</kbd>) öffnet die Detailansicht.
      </p>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-file" /> 4. Detailansicht &amp; Bearbeitung</h2>
      <p>
        Links wird das PDF gerendert, rechts findest du alle Metadaten. Mit
        der Berechtigung <code>documents.edit</code> sind folgende Felder
        editierbar:
      </p>
      <ul>
        <li><strong>Titel</strong>, <strong>Datum</strong> (YYYY-MM-DD), <strong>Absender</strong>.</li>
        <li><strong>Kategorie</strong> – Auswahl aus dem gemeinsamen Kategoriebaum.</li>
        <li><strong>Tags</strong> – kommagetrennte Liste.</li>
        <li><strong>Zusammenfassung</strong> – mehrzeiliger Freitext.</li>
      </ul>
      <p>
        <strong>Speichern</strong> übernimmt die Änderungen, <strong>Zurücksetzen</strong>
        verwirft sie. Nach dem Speichern gilt das Dokument als manuell
        bestätigt – künftige KI-Neuanalysen überschreiben deine Werte nicht.
      </p>

      <h3>Aktionen in der Kopfzeile</h3>
      <ul>
        <li>
          <strong>Neu klassifizieren</strong> – startet die KI-Analyse erneut
          (z.&nbsp;B. nach einem Modell-Update oder wenn eine neue Kategorie
          angelegt wurde).
        </li>
        <li>
          <strong>OCR erzwingen</strong> – ignoriert den vorhandenen
          Text-Layer der PDF und liest sie komplett per OCR neu ein. Hilft
          bei Scans mit fehlenden Leerzeichen oder schlechter Text-Qualität.
        </li>
        <li>
          <strong>Löschen</strong> – entfernt das Dokument endgültig
          (nach Rückfrage). Nur mit <code>documents.delete</code>.
        </li>
      </ul>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-receipt" /> 5. Steuer-Zuordnung</h2>
      <p>
        Unter den Metadaten gibt es den Bereich <strong>Steuer</strong>.
        Die KI markiert relevante Dokumente automatisch und schlägt Steuerjahr
        und Sektionen vor:
      </p>
      <ul>
        <li>
          <Tag severity="success" value="Steuerrelevant" /> bzw.
          <Tag severity="secondary" value="Nicht steuerrelevant" />
          zeigen die aktuelle Einstufung.
        </li>
        <li>
          <Tag severity="info" value="Manuell bestätigt" /> erscheint, sobald
          du die Werte abgespeichert hast – KI-Neuanalysen ändern sie danach
          nicht mehr.
        </li>
        <li>
          Sektionen sind nach <em>Einkünfte</em>, <em>Abzüge</em>,
          <em>Bescheide</em> und <em>Stammdaten</em> gruppiert. Ein
          <i class="pi pi-sparkles" />-Icon markiert KI-Vorschläge, ein
          <i class="pi pi-user-edit" />-Icon manuell gesetzte Zuordnungen.
        </li>
      </ul>
      <p>
        Mit <strong>Bearbeiten</strong> öffnest du den Editier-Modus, in dem
        du „steuerrelevant" umschalten, Jahr setzen und Sektionen per
        Checkbox (de-)aktivieren kannst. Beim Speichern muss ein
        steuerrelevantes Dokument ein Jahr <em>und</em> mindestens eine
        Sektion haben.
      </p>
      <p class="hint">
        Der Menüpunkt <strong>Steuer</strong> in der Seitennavigation zeigt
        alle steuerrelevanten Dokumente gruppiert pro Jahr – ideal für die
        Abgabe.
      </p>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-exclamation-triangle" /> 6. Review-Workflow</h2>
      <p>So erkennst du Dokumente, die deine Aufmerksamkeit brauchen:</p>
      <ul>
        <li>
          <strong>Rotes Banner</strong> in Liste und Detail, wenn die
          Verarbeitung fehlgeschlagen ist – der Backend-Fehler wird im
          Klartext angezeigt.
        </li>
        <li>
          <strong>Orange „Prüfen"-Badge</strong> bei Ready-Dokumenten mit
          KI-Konfidenz unter&nbsp;60&nbsp;%.
        </li>
        <li>
          <strong>Filter „Nur zu prüfen"</strong> in der Liste bündelt
          beide Fälle.
        </li>
        <li>
          <strong>Push-Benachrichtigungen</strong>: wird ein Dokument als
          „zu prüfen" markiert oder schlägt die Pipeline fehl, informiert
          das Gerät alle Benutzer mit Leseberechtigung.
        </li>
      </ul>
      <p>
        Typische Reaktion: Dokument öffnen → Felder anpassen → Speichern,
        oder bei Fehlern <strong>Neu klassifizieren</strong> bzw.
        <strong>OCR erzwingen</strong>.
      </p>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-folder" /> 7. Sammelmappen</h2>
      <p>
        Eine Sammelmappe fasst mehrere Dokumente unter einem Titel zusammen und
        gibt sie als <strong>ein einziges PDF</strong> weiter – etwa an
        Steuerberatung, Versicherung oder Vermieter. Ein Dokument darf in
        beliebig vielen Mappen liegen; was in der Mappe über es gilt
        (Reihenfolge, ab-/angewählte Seiten), gehört zur Mappe, nicht zum
        Dokument.
      </p>
      <ul>
        <li>
          <strong>Befüllen</strong> – über „In Sammelmappe" in der
          Dokumentenliste, im Arbeitskorb oder in der Detailansicht.
        </li>
        <li>
          <strong>Reihenfolge</strong> – bestimmt die Reihenfolge im PDF und
          wird in der Mappe mit den Pfeiltasten gesetzt.
        </li>
        <li>
          <strong>Abwählen</strong> – einzelne Dokumente per Häkchen, einzelne
          Seiten über die Seitenvorschau. Beides bleibt erhalten, wenn das
          Dokument nur vorübergehend aus dem PDF fliegt.
        </li>
        <li>
          <strong>Zusammenfassung</strong> – wird nach jeder Änderung
          automatisch von der lokalen KI über alle enthaltenen Dokumente
          erzeugt und kann von Hand überschrieben werden.
        </li>
        <li>
          <strong>PDF</strong> – wird beim Klick frisch gebaut (Deckblatt,
          Zusammenfassung und Inhaltsverzeichnis sind einzeln abschaltbar) und
          nie gespeichert. Auf iOS öffnet „PDF teilen" das native Share-Sheet.
        </li>
        <li>
          <strong>In der Dokumentenliste</strong> – Sammelmappen erscheinen als
          eigene Zeilen über den Dokumenten; die Suche findet sie über Titel,
          Notiz und Zusammenfassung. <strong>Standardmäßig</strong> werden
          Dokumente, die in einer Mappe liegen, nicht zusätzlich einzeln
          aufgeführt – die Mappen-Zeile steht für sie. Ein Hinweis über der
          Liste sagt das und schaltet es mit einem Klick wieder ab.
        </li>
        <li>
          <strong>Filter „Sammelmappe"</strong> – „Auch in Sammelmappen" zeigt
          wieder alle Dokumente einzeln, „Nur in Sammelmappen" die Umkehrung
          des Standards, und eine benannte Mappe genau deren Dokumente (dann
          steht nur diese eine Mappen-Zeile darüber). Bei aktivem
          Dokumentfilter – Kategorie, Absender, Steuer, Dokumentart … – treten
          die Mappen-Zeilen zurück, weil ein Filter nach Eigenschaften fragt,
          die ein Dokument hat und eine Mappe nicht.
        </li>
        <li>
          <strong>Chip an der Dokumentzeile</strong> – jedes Dokument zeigt
          seine Mappen an; ein Klick filtert die Liste auf genau diese Mappe.
          Ein Dokument darf in mehreren Mappen liegen, deshalb sind es
          mehrere Chips.
        </li>
        <li>
          <strong>Sichtbarkeit</strong> – privat oder für eine Gruppe. Eine
          Gruppenmappe darf nur Dokumente enthalten, die mit derselben Gruppe
          geteilt sind; sonst stünden Titel und Zusammenfassung für Unterlagen,
          die die Gruppe gar nicht öffnen kann.
        </li>
      </ul>
    </section>

    <section v-if="auth.hasPermission('documents.manage_taxonomy')" class="help-section">
      <h2><i class="pi pi-folder-open" /> 8. Admin: Kategorien &amp; Steuer-Hints</h2>
      <p>Mit der Rolle <code>documents.manage_taxonomy</code> hast du Zugriff auf:</p>
      <ul>
        <li>
          <strong>Kategorie-Vorschläge</strong> – von der KI generierte neue
          Kategorie-Ideen mit Tabs <em>Offen</em>, <em>Akzeptiert</em>,
          <em>Abgelehnt</em>. Beim Akzeptieren kannst du Slug und Namen
          überschreiben; Kollisionen werden angezeigt, Beispieldokumente
          sind direkt verlinkt.
        </li>
        <li>
          <strong>Steuer-Hints</strong> – Freitext-Hinweise pro Steuersektion,
          mit denen die KI geschult wird. Änderungen können bestehende
          Dokumente neu klassifizieren lassen.
        </li>
      </ul>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-shield" /> Berechtigungen auf einen Blick</h2>
      <ul class="perm-list">
        <li><code>documents.view</code> – Liste, Detail, Suche.</li>
        <li><code>documents.upload</code> – Dokumente hochladen.</li>
        <li><code>documents.edit</code> – Metadaten &amp; Steuer-Felder bearbeiten, Neu klassifizieren, OCR erzwingen.</li>
        <li><code>documents.delete</code> – Dokument endgültig löschen.</li>
        <li><code>documents.manage_taxonomy</code> – Kategorie-Vorschläge und Steuer-Hints verwalten.</li>
      </ul>
    </section>

    <div class="footer-nav">
      <Button
        icon="pi pi-arrow-left"
        label="Zurück zur Dokumentenliste"
        @click="router.push({ name: 'dokumente-list' })"
      />
    </div>
  </div>
</template>

<style scoped>
.help-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  padding-inline: 0.5em;
}

@media (min-width: 800px) {
  .help-view { padding-inline: 1em; }
}

.header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-block: 0.25rem 0.5rem;
  flex-wrap: wrap;
}
.title {
  font-size: 1.5em;
  font-weight: 600;
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.intro {
  font-size: 1rem;
  line-height: 1.5;
  color: var(--p-text-color);
  padding: 0.75rem 1rem;
  background: color-mix(in srgb, var(--p-primary-color) 6%, transparent);
  border-radius: 8px;
  border-left: 3px solid var(--p-primary-color);
}

.help-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.85rem 1rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
}

.help-section h2 {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0 0 0.25rem;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.help-section h2 i { color: var(--p-primary-color); }

.help-section h3 {
  font-size: 0.95rem;
  font-weight: 600;
  margin: 0.5rem 0 0.25rem;
}

.help-section p {
  margin: 0.25rem 0;
  line-height: 1.5;
}

.help-section ul,
.help-section ol {
  margin: 0.25rem 0 0.25rem 1.25rem;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.help-section li { line-height: 1.45; }

.status-list,
.pipeline {
  list-style: none;
  margin-left: 0;
}
.status-list li,
.pipeline li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.perm-list code,
.help-section code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.85em;
  padding: 0.05rem 0.35rem;
  background: color-mix(in srgb, var(--p-primary-color) 10%, transparent);
  border-radius: 4px;
}

.hint {
  font-size: 0.9rem;
  color: var(--p-text-muted-color);
  font-style: italic;
}

kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8em;
  padding: 0.05rem 0.4rem;
  border: 1px solid var(--p-content-border-color);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--p-surface-card);
}

.footer-nav {
  display: flex;
  justify-content: center;
  margin-block: 1rem 2rem;
}
</style>
