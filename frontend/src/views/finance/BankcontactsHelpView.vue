<script setup lang="ts">
import Button from 'primevue/button'
import { useModuleBack } from '../../composables/useModuleBack'

const { goBack } = useModuleBack('/finanzen', 'finance-bankcontacts')
</script>

<template>
  <div class="help-view">
    <div class="header">
      <Button icon="pi pi-arrow-left" label="Zurück" text @click="goBack" />
      <h1 class="title"><i class="pi pi-question-circle" /> Bankkontakte – Hilfe</h1>
    </div>

    <p class="intro">
      Ein <strong>Bankkontakt</strong> ist die Verbindung von fk-encore zur
      FinTS-Schnittstelle einer Bank. Über diesen Kontakt werden alle Konten
      bei dieser Bank geladen, Salden aktualisiert und Buchungen abgerufen.
      Diese Seite erklärt, wie die einzelnen Schritte funktionieren — vom
      Anlegen über den TAN-Flow bis hin zu der Frage, <em>welche</em> und
      <em>wie viele</em> Buchungen ein Sync tatsächlich holt.
    </p>

    <section class="help-section">
      <h2><i class="pi pi-plus" /> 1. Bankkontakt anlegen</h2>
      <p>
        „Neu anlegen" auf der Bankkontakt-Liste öffnet das Formular. Du
        brauchst:
      </p>
      <ul>
        <li><strong>Name</strong> – frei wählbar, nur für deine Übersicht.</li>
        <li><strong>BLZ</strong> – die 8-stellige Bankleitzahl deiner Bank.</li>
        <li><strong>Login</strong> – dein Online-Banking-Benutzername (z. B. VR-Net-Key, comdirect-Zugangsnummer).</li>
        <li><strong>Server-URL</strong> – die FinTS-Endpoint-URL deiner Bank
          (steht auf der Bank-Webseite oder in deren FinTS-Dokumentation).</li>
      </ul>
      <p>
        Die <strong>PIN/das Online-Banking-Passwort</strong> setzt du
        anschließend im Detail-Screen separat. Sie wird AES-256-GCM-verschlüsselt
        in der Datenbank abgelegt und nie über die Liste-/Detail-API
        zurückgeliefert.
      </p>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-shield" /> 2. TAN-Verfahren wählen</h2>
      <p>
        Welche TAN-Verfahren deine Bank dir anbietet (pushTAN, photoTAN,
        chipTAN-QR …), ist nutzerspezifisch. Der Button
        <strong>„TAN-Verfahren abrufen"</strong> im Detail-Screen führt einen
        kurzen FinTS-Dialog aus und cached die Liste am Bankkontakt. Danach
        wählst du das gewünschte Verfahren im Dropdown.
      </p>
      <p>
        <strong>Decoupled-Verfahren</strong> (pushTAN, App-basiert): die TAN
        gibst du nicht im Browser ein, sondern bestätigst sie in der
        Banking-App auf deinem Zweitgerät. fk-encore zeigt dann nur „Warte
        auf Freigabe …" an, der Browser-Dialog hat ein leeres TAN-Feld.
      </p>
      <p>
        <strong>Coupled-Verfahren</strong> (photoTAN, chipTAN-QR): die Bank
        liefert eine Bildmatrix, die im TAN-Dialog angezeigt wird. Du scannst
        sie mit deiner TAN-App, die App zeigt dir den TAN-Code, den du im
        Dialog eingibst.
      </p>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-link" /> 3. Konten verlinken</h2>
      <p>
        Beim ersten erfolgreichen Sync meldet die Bank dir alle Konten, die
        zu deinem Login gehören. fk-encore zeigt sie als „Noch nicht
        zugeordnete Bank-Konten" an. Du verknüpfst dort jedes Bank-Konto mit
        einem fk-encore-Konto (oder legst eines neu an). Erst <em>verlinkte</em>
        Konten bekommen Buchungen geladen.
      </p>
      <p class="hint">
        Konten, die du nicht verlinken willst (z. B. ein Geschäftskonto, das
        bewusst außerhalb von fk-encore bleibt), bleiben einfach in der
        Pending-Liste — sie verursachen keinen weiteren TAN-Aufruf.
      </p>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-refresh" /> 4. Sync auslösen — was passiert?</h2>
      <ol>
        <li>fk-encore baut einen FinTS-Dialog mit deinen Credentials auf.</li>
        <li>
          Falls die Bank eine starke Authentifizierung (SCA) verlangt,
          öffnet sich der TAN-Dialog. Du gibst die TAN ein bzw.
          bestätigst die Freigabe in der App.
        </li>
        <li>
          Die Liste der Bank-Konten wird abgerufen und mit deinen
          fk-encore-Konten abgeglichen.
        </li>
        <li>
          Pro <strong>verlinktem</strong> Konto werden Salden und Buchungen
          ab einem berechneten Stichtag (siehe nächster Abschnitt)
          geladen und in die DB übernommen.
        </li>
        <li>
          Status (<code>ok</code>, <code>tan-required</code>,
          <code>error:…</code>) und Zeitstempel werden auf dem
          Bankkontakt gespeichert.
        </li>
      </ol>
      <p>
        Die FinTS-Sitzung bleibt nach erfolgreichem Login bis zu 30 Minuten
        im Speicher offen, damit Folge-Operationen (z. B. Statement-Abruf
        nach einem TAN-Schritt) keine zweite TAN auslösen. Außerdem wird
        die <code>banking_information</code> persistiert, sodass Banken nach
        einem App-Neustart wieder den selben Client erkennen — die
        90-Tage-PSD2-Regel greift damit voll und du musst nicht bei jedem
        Sync neu freigeben.
      </p>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-clock" /> 5. Welche Buchungen werden geladen?</h2>
      <p>
        FinTS lässt die Bank ab einem Stichtag (<code>from</code>) bis heute
        liefern. fk-encore wählt diesen Stichtag <strong>pro Konto</strong>:
      </p>
      <ul>
        <li>
          <strong>Konten mit bereits gespeicherten Buchungen:</strong>
          <code>from = letzte gespeicherte Buchung − 14 Tage</code>.
          Die zwei Wochen Überlappung fängt Spät- und
          Korrektur-Buchungen auf. Duplikate werden über einen
          Hash-Index serverseitig stillschweigend ignoriert.
        </li>
        <li>
          <strong>Frisch verlinkte Konten ohne Historie:</strong>
          <code>from = heute − 90 Tage</code>. Diese 90 Tage liegen
          innerhalb des PSD2-Read-Only-Fensters und lösen deshalb
          <em>keine</em> zusätzliche TAN-Aufforderung aus.
        </li>
      </ul>
      <p>
        Ein <code>to</code> wird nicht gesetzt — die Bank liefert immer bis
        zum aktuellen Tag.
      </p>
      <p class="callout">
        <i class="pi pi-info-circle" />
        <span>
          <strong>Du brauchst mehr als 90 Tage Historie auf einem neuen Konto?</strong>
          Dazu kannst du den Default-Wert in
          <code>statements.ts</code> temporär hochsetzen. Letzteres bittet
          die Bank einmal um eine zusätzliche TAN, danach läuft alles
          wieder im normalen Inkrement-Modus.
        </span>
      </p>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-calendar" /> 6. Sync-Zeitplan</h2>
      <p>
        Im Detail-Screen findest du <strong>„Sync-Zeitplan"</strong>. Dort
        konfigurierst du Wochentag-/Uhrzeit-Slots in deiner Zeitzone, zu
        denen der Cron diesen Bankkontakt automatisch syncen soll.
        DST-Umstellungen behandelt das System automatisch — du musst die
        Slots nicht zweimal im Jahr anpassen.
      </p>
      <p>
        Wenn ein automatischer Sync eine TAN benötigt, schickt das System
        eine Push-Benachrichtigung an den User, dem der Bankkontakt
        gehört, damit er den TAN-Dialog im Browser öffnen kann.
      </p>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-eye" /> 7. Übersicht oben auf der Liste</h2>
      <p>
        Über der Bankkontakt-Tabelle siehst du zwei Karten:
      </p>
      <ul>
        <li>
          <strong>TAN offen:</strong> Anzahl der Bankkontakte, die gerade
          auf eine TAN warten. Wenn größer 0, ist die Karte gelb
          unterlegt und klickbar — sie führt direkt zum betroffenen
          Bankkontakt.
        </li>
        <li>
          <strong>Nächster Sync:</strong> der zeitlich nächste geplante
          Slot über alle Bankkontakte hinweg, mit „in HH:MM"-Anzeige.
          Aktualisiert sich automatisch alle 30 Sekunden.
        </li>
      </ul>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-exclamation-triangle" /> 8. Wenn etwas schief geht</h2>
      <ul>
        <li>
          <code>error:9910</code> – Falsche PIN. Setze die Credentials im
          Detail-Screen neu. fk-encore wiederholt nicht automatisch, um
          dich nicht aus dem Online-Banking auszusperren.
        </li>
        <li>
          <code>error:live-client-evicted</code> – Die FinTS-Sitzung
          wurde geschlossen, bevor du die TAN bestätigt hast (z. B.
          weil der Server neu gestartet ist). Sync neu auslösen.
        </li>
        <li>
          <code>tan-required</code> ohne dass jemand zu Hause war – das
          Modul drückt diesen Status fest, bis du den Sync wiederholst
          oder die TAN-Session abläuft (10 Minuten).
        </li>
      </ul>
    </section>
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

.callout {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  padding: 0.6rem 0.85rem;
  background: color-mix(in srgb, var(--p-yellow-500, #facc15) 10%, transparent);
  border-left: 3px solid var(--p-yellow-500, #facc15);
  border-radius: 6px;
  margin-top: 0.5rem;
}
.callout > i {
  font-size: 1.1rem;
  color: var(--p-yellow-700, #a16207);
  margin-top: 0.15rem;
}
</style>
