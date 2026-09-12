<script setup lang="ts">
/**
 * Online help for degree days and the weather-adjusted heating report
 * (Issue #792, §5.2.6). Reached from the heating panel in the meter
 * overview — the one place the terms "Gradtag" and "Kd" appear.
 *
 * Pattern follows `finance/BankcontactsHelpView.vue`: a feature-level help
 * page linked from the feature, not a module manual.
 */
import Button from 'primevue/button'
import { useModuleBack } from '../composables/useModuleBack'

const { goBack } = useModuleBack('/zaehler', 'zaehler-list')

/** Worked examples for the daily contribution. */
const examples = [
  { day: 'Tagesmittel 0 °C', calc: '20 − 0', result: '20 Kd' },
  { day: 'Tagesmittel 12 °C', calc: '20 − 12', result: '8 Kd' },
  { day: 'Tagesmittel 17 °C', calc: 'über der Heizgrenze', result: '0 Kd' },
  { day: 'Januar, durchgehend 0 °C', calc: '31 × 20', result: '620 Kd' },
]
</script>

<template>
  <div class="help-view">
    <div class="header">
      <Button icon="pi pi-arrow-left" label="Zurück" text @click="goBack" />
      <h1 class="title"><i class="pi pi-question-circle" /> Gradtage und Witterungsbereinigung</h1>
    </div>

    <p class="intro">
      „Wir haben mehr geheizt als letztes Jahr“ heißt meistens nur: es war
      kälter. Um beides auseinanderzuhalten, teilt der Report den Heizverbrauch
      durch die <strong>Gradtagzahl</strong> des Monats. Diese Seite erklärt,
      was dahintersteckt, woher die Zahlen kommen und wie die Werte im Report
      zu lesen sind.
    </p>

    <section class="help-section">
      <h2><i class="pi pi-sun" /> 1. Was eine Gradtagzahl misst</h2>
      <p>
        Die Gradtagzahl misst, <em>wie kalt</em> eine Periode war und
        <em>wie lange</em> sie kalt war. Sie wird Tag für Tag gebildet und über
        den Monat summiert:
      </p>
      <ul>
        <li>
          <strong>Heizgrenze 15 °C:</strong> Liegt das Tagesmittel darunter,
          zählt der Tag als Heiztag. Darüber heizt niemand, die Abwärme von
          Menschen, Geräten und Sonne deckt den Verlust.
        </li>
        <li>
          <strong>Raumtemperatur 20 °C:</strong> Der Beitrag eines Heiztags ist
          die Differenz zwischen dieser angenommenen Innentemperatur und dem
          Tagesmittel draußen.
        </li>
      </ul>
      <div class="table-scroll">
        <table class="help-table">
          <thead>
            <tr>
              <th>Beispiel</th>
              <th>Rechnung</th>
              <th>Ergebnis</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in examples" :key="row.day">
              <td>{{ row.day }}</td>
              <td>{{ row.calc }}</td>
              <td class="numeric">{{ row.result }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="hint">
        Zur Einordnung: Ein deutscher Januar liegt meist zwischen 500 und
        650 Kd, der Juli nahe null, ein ganzes Jahr etwa zwischen 3000 und
        3800 Kd.
      </p>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-calculator" /> 2. Die Einheit Kd</h2>
      <p>
        <code>Kd</code> steht für <strong>Kelvin mal Tag</strong>. Kelvin, weil
        es sich um eine Temperatur<em>differenz</em> handelt, und eine Differenz
        von 1 °C ist exakt 1 K. Der Tag ist die Dauer, über die diese Differenz
        anlag.
      </p>
      <p>
        Ein Gradtag ist also ein Tag mit einem Kelvin Differenz — oder ein
        Zehntel Tag mit zehn Kelvin. Deshalb lassen sich Tage einfach
        aufsummieren: ein kurzer strenger Frost und eine lange milde Phase
        können dieselbe Gradtagzahl ergeben, und für den Heizbedarf sind sie
        tatsächlich ähnlich teuer.
      </p>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-chart-line" /> 3. Warum das die Witterung herausrechnet</h2>
      <p>
        Der Wärmeverlust eines Hauses ist in guter Näherung proportional zur
        Temperaturdifferenz innen zu außen und zur Dauer. Genau das ist die
        Gradtagzahl. Der Heizbedarf folgt ihr deshalb ungefähr linear.
      </p>
      <p>
        Teilt man den gemessenen Verbrauch durch die Gradtagzahl, beschreibt das
        Ergebnis <strong>das Haus und die Heizung</strong> statt des Winters.
        Steigt dieser Wert über die Jahre, wurde wirklich mehr Energie für
        dieselbe Kälte gebraucht: schlechtere Dämmung, eine nachlassende
        Wärmepumpe oder schlicht höhere Wunschtemperatur.
      </p>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-map-marker" /> 4. Woher die Zahlen kommen</h2>
      <p>Der Report nutzt die erste verfügbare dieser drei Quellen:</p>
      <ol>
        <li>
          <strong>Automatischer Abruf.</strong> Ist unter dem Report ein
          <strong>Wohnort</strong> hinterlegt, holt ein täglicher Job die
          Tagesmitteltemperaturen aus dem Open-Meteo-Archiv und rechnet daraus
          die Monatssummen. Der Wohnort wird über eine Ortssuche gewählt;
          gespeichert wird nur eine auf etwa fünf Kilometer gerundete
          Koordinate.
        </li>
        <li>
          <strong>Eigene Reihe.</strong> Unter „Tarife &amp; Annahmen“ lässt
          sich eine Gradtagzahl-Reihe als Art
          <em>Gradtagzahl (Monat)</em> eintragen oder als Datei importieren,
          etwa die Werte einer Wetterstation in der Nähe. Solche Zeilen
          überschreibt der automatische Abruf nie.
        </li>
        <li>
          <strong>Schätzung ohne Gradtage.</strong> Fehlt beides, vergleicht
          der Report jeden Monat mit dem Durchschnitt desselben Kalendermonats
          aus den eigenen Vorjahren. Das zeigt die Abweichung vom hauseigenen
          Normalwert, kann einen kälteren Winter aber nicht herausrechnen. Der
          Report benennt diesen Modus.
        </li>
      </ol>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-table" /> 5. Die Werte im Report lesen</h2>
      <ul>
        <li>
          <strong>je Gradtag</strong> (<code>kWh/Kd</code>) ist die
          witterungsbereinigte Kennzahl. Für ein Jahr wird sie aus der Summe des
          Verbrauchs geteilt durch die Summe der Gradtage gebildet, nicht als
          Mittel der Monatswerte. Sonst würden Sommermonate mit einer Handvoll
          Gradtagen das Ergebnis dominieren.
        </li>
        <li>
          <strong>Normalmonat</strong> und <strong>Normaljahr</strong> rechnen
          den Verbrauch auf durchschnittliches Wetter um: kWh je Gradtag mal die
          langjährig übliche Gradtagzahl dieses Zeitraums. Das ist die Zahl, die
          sich fair mit anderen Jahren vergleichen lässt.
        </li>
        <li>
          <strong>Typisch</strong> ist der Durchschnitt desselben
          Kalendermonats über alle gemessenen Jahre,
          <strong>Abweichung</strong> der Abstand dazu in Prozent.
        </li>
        <li>
          Nur <strong>vollständig gemessene</strong> Monate zählen mit. Eine
          Lücke in den Ablesungen würde sonst wie ein milder Monat aussehen.
        </li>
      </ul>
    </section>

    <section class="help-section">
      <h2><i class="pi pi-info-circle" /> 6. Grenzen und Konventionen</h2>
      <p>
        Es gibt verschiedene Definitionen. Hier gilt die deutsche Konvention
        <strong>G20/15</strong> nach VDI 2067 und VDI 3807, also Heizgrenze
        15 °C und Raumtemperatur 20 °C. Im angelsächsischen Raum rechnen
        <em>Heating Degree Days</em> oft mit einer Basis von 18 °C ohne getrennte
        Heizgrenze. Zahlen verschiedener Konventionen lassen sich nicht
        vergleichen.
      </p>
      <div class="callout">
        <i class="pi pi-exclamation-triangle" />
        <div>
          Die automatisch abgerufenen Temperaturen stammen aus einer
          Wettermodell-Rückrechnung im Kilometerraster, nicht von einer
          Messstation vor der Haustür. Für Monatssummen ist das genau genug, für
          einen einzelnen Tag nicht. Das Archiv hinkt der Gegenwart außerdem
          einige Tage hinterher, deshalb erscheint ein abgeschlossener Monat
          erst mit ein paar Tagen Verzögerung.
        </div>
      </div>
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
  background: var(--p-content-background);
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

.table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  margin: 0.4rem 0;
}

.help-table {
  border-collapse: collapse;
  width: 100%;
  min-width: 22rem;
  font-size: 0.9rem;
}

.help-table th,
.help-table td {
  text-align: left;
  padding: 0.35rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color);
}

.help-table th {
  font-weight: 600;
  color: var(--p-text-muted-color);
}

.help-table .numeric {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
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
