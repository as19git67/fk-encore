# Scanner-Pi → fk-encore

Skripte für einen Raspberry Pi mit angeschlossenem ScanSnap, der
gescannte PDFs ausschließlich an fk-encore übergibt. Kein OCR, kein
Dropbox, kein SMB — das gesamte Processing passiert im Server
(`documents`-Service).

## Architektur

```
  ┌─ Pi (scanbd) ──────────────────────────────┐        ┌─ fk-encore ─────────────┐
  │                                            │        │                         │
  │  Button → doscan.sh                        │        │                         │
  │    ├─ Spool leer?  nein → log + exit       │        │                         │
  │    └─ Spool leer?  ja   → scan → spool     │        │                         │
  │                          → fk-upload.sh ───┼── POST /auth/refresh ──────────► │
  │                                            │ ◄── access_token + new refresh ─┤
  │                                            │                                 │
  │  fk-upload.timer (alle 2 min) ─────────────┼── POST /documents ─────────────► │
  │    drain spool                             │   (application/pdf)             │
  │                                            │                                 │
  └────────────────────────────────────────────┘        └─────────────────────────┘
```

Kernprinzip: **Solange ein PDF im Spool liegt, löst der Scan-Button
keinen neuen Scan aus.** Der Pi probiert es in der Zwischenzeit alle
zwei Minuten erneut (systemd-Timer). Sobald der Upload gelingt, ist der
Button wieder aktiv.

## Voraussetzungen

- Raspberry Pi OS **Bookworm** (Buster ist seit Juni 2024 EOL).
- Pakete: `sane-utils scanbd curl jq coreutils util-linux bash`.
- `sane-scan-pdf` (das bestehende `/home/anton/sane-scan-pdf/scan`-Wrapper-Setup
  kann unverändert weiterverwendet werden).
- Netzwerk-Erreichbarkeit zum fk-encore-Server (lokales LAN reicht).

## Dateien in diesem Verzeichnis

| Datei                  | Ziel auf dem Pi                        | Rolle |
|------------------------|----------------------------------------|------|
| `doscan.sh`            | `/usr/local/bin/doscan.sh`             | scanbd-Action-Skript. Ersetzt das alte `~/doscan.sh`. |
| `fk-upload.sh`         | `/usr/local/bin/fk-upload.sh`          | Upload-Worker. Lädt alle PDFs aus dem Spool nach fk-encore. |
| `fk-upload.service`    | `/etc/systemd/system/fk-upload.service`| Oneshot-Unit, die `fk-upload.sh` als `saned:scanner` aufruft. |
| `fk-upload.timer`      | `/etc/systemd/system/fk-upload.timer`  | Startet die Service-Unit alle 2 Minuten (plus Boot-Catch-up). |
| `config.example`       | `/etc/fk-scan/config` (angepasst)      | Shell-Config, wird von beiden Skripten gesourced. |
| `scanbd.conf.snippet`  | Auszug für `/etc/scanbd/scanbd.conf`   | Minimaler `action scan { … }`-Block, der `doscan.sh` ruft. |

## Installation Schritt für Schritt

### 1. fk-encore: dedizierten Scanner-User anlegen

Auf dem fk-encore-Server (Admin-UI oder direkt per API):

1. Neue Rolle `scanner-upload` mit genau einer Permission: `documents.upload`.
2. Neuer User, z. B. `scanner@<dein-haushalt>.lan`, Passwort zufällig
   generieren (24+ Zeichen) und der Rolle `scanner-upload` zuweisen.
3. Einmalig einloggen, um **Access-Token + Refresh-Token** zu bekommen.
   Am schnellsten von einem beliebigen Rechner aus:

   ```bash
   curl -s -H 'Content-Type: application/json' \
        -X POST http://fk-encore.lan:4000/auth/login \
        -d '{"email":"scanner@…","password":"…"}' | jq
   ```

   Merke dir das Feld `refreshToken` — das ist der einzige dauerhafte
   Schlüssel, den der Pi braucht. Der `token` läuft schnell ab und wird
   vom Pi bei Bedarf automatisch nachgeholt.

### 2. Auf dem Pi: Verzeichnisse & Ownership

```bash
sudo mkdir -p /etc/fk-scan /var/spool/fk-scan/pending
sudo chown -R saned:scanner /var/spool/fk-scan
sudo chmod 0750 /var/spool/fk-scan /var/spool/fk-scan/pending
sudo chown root:scanner /etc/fk-scan
sudo chmod 0750 /etc/fk-scan
```

### 3. Refresh-Token hinterlegen

```bash
sudo install -o saned -g scanner -m 0600 /dev/null /etc/fk-scan/refresh_token
sudo tee /etc/fk-scan/refresh_token >/dev/null <<< '<REFRESH_TOKEN_AUS_SCHRITT_1>'
sudo chown saned:scanner /etc/fk-scan/refresh_token
sudo chmod 0600 /etc/fk-scan/refresh_token
```

Wichtig: Der Pi **rotiert** diesen Token bei jedem Upload-Durchlauf
automatisch — `/auth/refresh` gibt immer einen neuen Refresh-Token
zurück, den `fk-upload.sh` atomar über die Datei schreibt. Falls die
Datei einmal verloren geht, neu aus `/auth/login` beschaffen.

### 4. Config-Datei anlegen

```bash
sudo cp config.example /etc/fk-scan/config
sudo chown root:scanner /etc/fk-scan/config
sudo chmod 0640 /etc/fk-scan/config
sudoedit /etc/fk-scan/config   # FK_ENCORE_URL eintragen
```

### 5. Skripte installieren

```bash
sudo install -m 0755 doscan.sh     /usr/local/bin/doscan.sh
sudo install -m 0755 fk-upload.sh  /usr/local/bin/fk-upload.sh
sudo install -m 0644 fk-upload.service /etc/systemd/system/fk-upload.service
sudo install -m 0644 fk-upload.timer   /etc/systemd/system/fk-upload.timer
```

### 6. Systemd-Timer aktivieren

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now fk-upload.timer
systemctl list-timers fk-upload.timer     # sollte den nächsten Trigger zeigen
```

### 7. scanbd umstellen

```bash
sudoedit /etc/scanbd/scanbd.conf
```

Im `action scan { … }`-Block den `script`-Pfad auf `/usr/local/bin/doscan.sh`
setzen (siehe `scanbd.conf.snippet`). Anschließend:

```bash
sudo systemctl restart dbus-de.kmux.scanbd.server.service
```

### 8. Alt-Skripte abräumen (optional)

Das alte `~/doscan.sh`, `Dropbox_Uploader`, `rclone`-Konfigs für
Dropbox/OneDrive und der `smbclient`-Aufruf werden nicht mehr gebraucht.
Behalte sie ein paar Tage als Fallback, dann löschen.

## Test

```bash
# 1. Smoke-Test auth + upload leer:
sudo -u saned /usr/local/bin/fk-upload.sh
# Erwartung: silent exit 0 (Spool ist leer).

# 2. Dummy-PDF in den Spool legen und Upload forcieren:
echo '%PDF-1.4 test' | sudo -u saned tee /var/spool/fk-scan/pending/test.pdf >/dev/null
sudo systemctl start fk-upload.service
journalctl -u fk-upload.service -n 40
# fk-encore sollte eine 201 zurückgeben und die Datei ist aus dem Spool weg.

# 3. Ganzer Flow: Knopf drücken.
journalctl -t fk-scan/doscan -t fk-scan/upload -f
```

### Block-Verhalten prüfen

```bash
# Spool-Datei künstlich anlegen und Button "drücken":
echo dummy | sudo -u saned tee /var/spool/fk-scan/pending/stuck.pdf >/dev/null
sudo -u saned /usr/local/bin/doscan.sh
# Erwartung im Log: "refusing scan: 1 file(s) still pending upload"
sudo -u saned rm /var/spool/fk-scan/pending/stuck.pdf
```

## Feedback bei blockierten Scans

Eine zuverlässige LED- oder Ton-Rückmeldung am ScanSnap ist
software-seitig **nicht** steuerbar (die Scanner-Firmware entscheidet
über die LED-Zustände). Deshalb:

- **Default:** Jeder blockierte Button-Druck landet als Log-Eintrag in
  `journalctl -t fk-scan/doscan`. `journalctl -t fk-scan/upload -f` in
  einem `tmux`-Fenster ist der einfachste „ist-mein-Scanner-ok"-Check.
- **Optional später:** Ein Piezo-Buzzer am GPIO (~2 €) wäre an klar
  markierter Stelle in `doscan.sh` mit zwei Zeilen `gpioset` nachrüstbar,
  falls das Log-only-Feedback nicht reicht.

## Monitoring

```bash
# Läuft der Timer?
systemctl status fk-upload.timer

# Was hat der letzte Lauf gemacht?
journalctl -u fk-upload.service -n 80

# Wie viele Scans hängen fest?
ls /var/spool/fk-scan/pending/
```

Wenn der Spool über Stunden dieselbe Datei enthält, ist der Server
unerreichbar oder der Token abgelaufen. Neues Refresh-Token aus
Schritt 1 holen und in `/etc/fk-scan/refresh_token` ablegen.

## Sicherheit

- Der Refresh-Token gibt nur Upload-Rechte (`documents.upload`) — keine
  Lese-Rechte, keine Admin-Rechte. Wird er kompromittiert, reicht es,
  den Scanner-User im fk-encore-UI kurz zu deaktivieren/löschen; das
  invalidiert den Refresh-Token serverseitig.
- `/etc/fk-scan/refresh_token` ist `0600 saned:scanner`. Nur der
  scanbd-Prozess und der Upload-Service kommen dran.
- `fk-upload.service` läuft mit `ProtectSystem=strict`, `ProtectHome=true`
  und einer expliziten `ReadWritePaths`-Liste.
- Der Pi spricht fk-encore im lokalen Netz an. Wenn du das über
  öffentliches Netz führst, bitte HTTPS + festen FQDN + evtl. zusätzlich
  eine Firewall-Regel.
