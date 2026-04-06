# Feature-Vergleich: Immich vs. FK-Encore

Stand: April 2026

## Legende

- ✅ Vorhanden
- ⚡ Vorhanden und überlegen
- 🔶 Teilweise / anders umgesetzt
- ❌ Nicht vorhanden

---

## 1. Foto-Verwaltung

| Feature | Immich | FK-Encore |
|---|---|---|
| Upload (Web) | ✅ | ✅ |
| Upload (Mobile App) | ✅ | ❌ |
| Upload (CLI) | ✅ Bulk-Upload, Glob-Filter, Watch-Mode | ❌ |
| Formate: JPEG, PNG, GIF, WebP | ✅ | ✅ |
| HEIC/HEIF-Support | ✅ Nativ | ✅ Mit Auto-Konvertierung zu JPEG |
| RAW-Formate (RW2, PSD, TIFF, etc.) | ✅ 15+ Formate | ❌ |
| AVIF, JPEG XL, JPEG 2000, SVG | ✅ | ❌ |
| Duplikaterkennung (Hash-basiert) | ✅ | ✅ |
| Duplikaterkennung (ML-visuell) | ✅ Mit Review-Interface | ✅ DINOv2-basiert mit Review-Workflow |
| Nicht-destruktive Bildbearbeitung | ✅ Crop, Rotate, Mirror | ❌ |
| Foto-Stacks (Burst, Bracketing) | ✅ | ❌ |
| 360°-Bilder | ✅ (Web) | ❌ |
| LivePhotos / MotionPhotos | ✅ | ❌ |
| Thumbnail-Generierung | ✅ Standard | ⚡ Intelligenter Fokuspunkt (Gesicht/Landmark) |
| Bild-Resizing on-the-fly | 🔶 Vordefinierte Größen | ✅ Per Query-Parameter frei wählbar |
| Foto-Qualitätsbewertung (AI) | ❌ | ⚡ AI-Score (0-1) mit Detailmetriken |

## 2. Video-Verwaltung

| Feature | Immich | FK-Encore |
|---|---|---|
| Video-Upload & Wiedergabe | ✅ 12+ Formate | ❌ |
| Hardware-Transkodierung | ✅ NVENC, Quick Sync, VAAPI, RKMPP | ❌ |
| Video-Streaming | ✅ | ❌ |

> **FK-Encore ist rein foto-basiert – Video-Support fehlt komplett.**

## 3. Alben & Teilen

| Feature | Immich | FK-Encore |
|---|---|---|
| Alben erstellen & verwalten | ✅ | ✅ |
| Alben mit Nutzern teilen | ✅ Editor/Viewer-Rollen | ✅ Read/Write-Zugriff |
| Öffentliche Links (ohne Account) | ✅ Mit Ablaufdatum, Passwort | ❌ |
| Upload durch Empfänger | ✅ Konfigurierbar | ❌ |
| Album-Sync vom Handy | ✅ Auto-Sync von Geräte-Alben | ❌ |
| Album-Cover-Foto | ✅ | ✅ |
| Kollaborative Kuratierung | ❌ | ⚡ Favoriten, Verstecken, Konsens-Ansicht |
| Anonyme Abstimmung in Alben | ❌ | ⚡ "3/5 Favoriten"-Anzeige |
| AI als Album-Teilnehmer | ❌ | ⚡ Qualitäts-basiertes AI-Voting |
| Mehrere Ansichtsmodi pro Album | ❌ | ⚡ Alle / Favoriten / Konsens / Custom |
| Partner-Sharing (ganze Bibliothek) | ✅ | ❌ |

## 4. Suche

| Feature | Immich | FK-Encore |
|---|---|---|
| Semantische Suche (CLIP) | ✅ OpenCLIP | ✅ OpenCLIP |
| Visuelle Ähnlichkeitssuche | 🔶 Für Duplikate | ⚡ DINOv2 + Hybrid-Modus (CLIP+DINOv2) |
| Natürliche Sprachsuche | ✅ Englisch-fokussiert | ⚡ Deutsch mit intelligentem Query-Parsing |
| Query-Dekomposition (Ort+Datum+Semantic) | ❌ | ⚡ Automatische Zerlegung komplexer Queries |
| OCR-Suche (Text in Bildern) | ✅ | ❌ |
| Dateiname-Suche | ✅ | ❌ |
| Kamera-Suche (Make/Model/Lens) | ✅ | ❌ |
| Orts-Suche (Stadt/Land) | ✅ | ✅ |
| GPS-Radius-Suche | ❌ | ⚡ Suche im km-Radius |
| Datum-/Zeitraum-Suche | ✅ | ✅ |
| Landmark-Suche | ❌ | ⚡ Suche nach erkannten Sehenswürdigkeiten |
| Tag-Suche | ✅ | ❌ |
| Beschreibungs-Suche | ✅ | ❌ |
| Kombinierte Filter | ✅ | ✅ (über Query-Parsing) |

## 5. KI / Machine Learning

| Feature | Immich | FK-Encore |
|---|---|---|
| Gesichtserkennung | ✅ DBSCAN-Clustering | ✅ InsightFace + Embeddings |
| Gesichts-Clustering | ✅ Inkrementell + Nightly-Jobs | ✅ Distanz-basiert |
| Personen benennen & verwalten | ✅ | ✅ |
| Personen mergen | ✅ | ✅ |
| Geburtstag & Alter bei Foto | ✅ | ❌ |
| Personen verstecken | ✅ | ✅ (Gesichter ignorieren) |
| Objekt-/Szenen-Erkennung | ✅ Auto-Tagging | ❌ |
| Landmark-Erkennung | ❌ | ⚡ Grounding DINO (Kirchen, Brücken, etc.) |
| Foto-Qualitätsbewertung | ❌ | ⚡ AI-Score für jedes Foto |
| Intelligenter Fokuspunkt | ❌ | ⚡ Gesichts-/Landmark-basiert |
| GPU-Beschleunigung | ✅ CUDA, OpenVINO, VAAPI, ARM-NN, ROCm | ❌ |
| Multi-GPU-Support | ✅ | ❌ |
| FP16-Precision | ✅ | ❌ |
| Konfigurierbare ML-Modelle | ✅ | ✅ |

## 6. Karte & Geolocation

| Feature | Immich | FK-Encore |
|---|---|---|
| Interaktive Weltkarte | ✅ Web & Mobile | ❌ |
| Reverse Geocoding | ✅ Lokal (GeoNames) | ✅ Stadt/Land-Extraktion |
| GPS-Koordinaten aus EXIF | ✅ | ✅ |
| GPS-Rescan / Bulk-Rescan | 🔶 Über Jobs | ✅ Einzeln oder Bulk |

## 7. Zeitleiste & Erinnerungen

| Feature | Immich | FK-Encore |
|---|---|---|
| Chronologische Timeline | ✅ Mit Virtual Scroll | ✅ Foto-Grid mit Navigation |
| Ordner-Ansicht | ✅ | ❌ |
| Memories ("An diesem Tag") | ✅ Web & Mobile | ❌ |
| Scrubbable Scrollbar | ✅ | ❌ |

## 8. Mobile Apps

| Feature | Immich | FK-Encore |
|---|---|---|
| iOS App | ✅ Nativ | ❌ |
| Android App | ✅ Nativ | ❌ |
| Auto-Backup bei App-Start | ✅ | ❌ |
| Hintergrund-Backup | ✅ iOS & Android | ❌ |
| Selektiver Album-Backup | ✅ | ❌ |
| Nur-WLAN-Upload | ✅ | ❌ |
| "Free Up Space" | ✅ | ❌ |
| Offline-Modus | ✅ | ❌ |
| Read-Only-Modus | ✅ | ❌ |

> **FK-Encore hat keine nativen Mobile-Apps – nur eine Web-App.**

## 9. Authentifizierung & Nutzerverwaltung

| Feature | Immich | FK-Encore |
|---|---|---|
| Passwort-Login | ✅ | ✅ (bcrypt) |
| OAuth / OIDC | ✅ Authentik, Keycloak, Google, etc. | ❌ |
| Passkeys (WebAuthn/FIDO2) | ❌ | ⚡ Registrierung, Login, Multi-Passkey |
| API-Keys | ✅ | ❌ |
| Passwort-Reset per E-Mail | 🔶 Nur via Admin-CLI | ✅ Token-basiert per E-Mail |
| Session-Verwaltung | ✅ Geräte-Übersicht | ✅ Token-basiert |
| Rollen-System | 🔶 Admin/User | ⚡ Granulares RBAC mit Custom-Roles |
| Feingranulare Berechtigungen | ❌ | ⚡ 18+ Permissions pro Rolle |
| Speicher-Quotas pro Nutzer | ✅ | ❌ |
| Auto-Registrierung via OAuth | ✅ | ❌ |
| Rate Limiting (Login) | ❌ | ✅ |

## 10. Externe Bibliotheken & Storage

| Feature | Immich | FK-Encore |
|---|---|---|
| Externe Ordner einbinden | ✅ Read-Only | ❌ |
| Filesystem-Watching | ✅ (experimentell) | ❌ |
| Geplante Scans | ✅ | ❌ |
| Konfigurierbares Speicher-Layout | ✅ Templates | ❌ |
| S3-kompatible Backends | ✅ | ❌ |
| Object Storage | ❌ | ✅ Encore Buckets |
| XMP-Sidecar-Support | ✅ Lesen & Schreiben | ❌ |

## 11. Metadaten

| Feature | Immich | FK-Encore |
|---|---|---|
| EXIF-Anzeige | ✅ Umfangreich | ✅ |
| EXIF-Extraktion | ✅ 9 priorisierte DateTime-Felder | ✅ |
| Datum manuell bearbeiten | ✅ | ✅ |
| XMP-Sidecar Lesen/Schreiben | ✅ | ❌ |
| Tag-Import (XMP/IPTC) | ✅ | ❌ |
| Bewertungen (Ratings) | ✅ | ❌ |
| Beschreibungen | ✅ | ❌ |
| Metadata-Refresh / Reindex | ✅ Über Jobs | ✅ Einzeln und Bulk |

## 12. Admin & Monitoring

| Feature | Immich | FK-Encore |
|---|---|---|
| Admin-Dashboard | ✅ | ✅ (Data Management View) |
| Job-Verwaltung | ✅ Trigger & Monitor | ✅ Scan-Queue mit Status-Tracking |
| Service-Health-Monitoring | 🔶 | ✅ Für alle ML-Services |
| Prometheus-Metriken | ✅ | ❌ |
| Grafana-Integration | ✅ | ❌ |
| Strukturiertes JSON-Logging | ✅ | ❌ |
| Maintenance-Mode | ✅ | ❌ |
| Admin-CLI | ✅ immich-admin | ❌ |
| Fehlgeschlagene Scans wiederholen | 🔶 | ✅ Mit Fehler-Logging |

## 13. Archiv / Favoriten / Papierkorb

| Feature | Immich | FK-Encore |
|---|---|---|
| Archiv (aus Timeline verstecken) | ✅ | 🔶 Sichtbar/Versteckt-System |
| Favoriten | ✅ Global | 🔶 Pro Album und Nutzer |
| Papierkorb (Soft-Delete, 30 Tage) | ✅ | ❌ |
| Bewertungen (1-5 Sterne) | ✅ | ❌ |
| Hierarchische Tags | ✅ | ❌ |

## 14. Sonstiges

| Feature | Immich | FK-Encore |
|---|---|---|
| Google Cast / Chromecast | ✅ (experimentell) | ❌ |
| Internationalisierung (18+ Sprachen) | ✅ | ❌ |
| OpenAPI-Spezifikation | ✅ | ✅ (Encore.ts generiert) |
| Microservice-Architektur | 🔶 ML als separater Container | ⚡ 3 spezialisierte ML-Services |
| Tech-Stack Backend | Go + TypeScript + Python | Encore.ts (TypeScript) + Python |

---

## Zusammenfassung

### Immich ist überlegen bei:

- **Video-Unterstützung** – komplett fehlend in FK-Encore
- **Mobile Apps** mit Auto-Backup (iOS & Android)
- **Interaktive Weltkarte**
- **Memories / Erinnerungen** ("An diesem Tag")
- **Externe Bibliotheken** – bestehende Foto-Ordner einbinden
- **Partner-Sharing** – ganze Bibliothek teilen
- **Öffentliche Links** – Teilen ohne Account
- **OAuth/OIDC** – Enterprise-SSO-Integration
- **GPU-Beschleunigung** – CUDA, OpenVINO, etc.
- **Video-Transkodierung** mit Hardware-Beschleunigung
- **XMP-Sidecar** – Metadaten-Interoperabilität
- **Objekt-/Szenen-Erkennung** und Auto-Tagging
- **OCR** – Texterkennung in Bildern
- **Monitoring** – Prometheus, Grafana
- **Breitere Format-Unterstützung** (RAW, AVIF, JPEG XL, etc.)
- **Community-Größe** und Reife des Projekts

### FK-Encore ist überlegen bei:

- **Kollaborative Album-Kuratierung** – Konsens-Ansicht, anonyme Abstimmung, Multiple Ansichtsmodi
- **AI als Album-Teilnehmer** – Qualitäts-basiertes Voting
- **Landmark-Erkennung** – Grounding DINO für Sehenswürdigkeiten
- **AI-Qualitätsbewertung** – Score für jedes Foto
- **Intelligenter Auto-Crop** – Fokuspunkt basierend auf Gesichtern/Landmarks
- **Hybride Suche** – CLIP + DINOv2 Fusion
- **Deutsche Sprachsuche** – mit intelligentem Query-Parsing und Dekomposition
- **GPS-Radius-Suche** – Umkreissuche in Kilometern
- **Passkey-Authentifizierung** – WebAuthn/FIDO2
- **Granulares RBAC** – 18+ Permissions, Custom Roles
- **Modulare ML-Architektur** – 3 spezialisierte Microservices
- **Rate Limiting** auf Auth-Endpunkte
- **Passwort-Reset per E-Mail** (Self-Service)

### Fazit

**Immich** ist die umfassendere, ausgereiftere Lösung – insbesondere als vollständiger Google-Photos-Ersatz mit Video-Support, Mobile-Apps und breiter Community. Es deckt den gesamten Lifecycle einer Foto-/Video-Verwaltung ab.

**FK-Encore** punktet mit innovativen AI-Features und einem einzigartigen kollaborativen Kuratierungskonzept. Die Album-Kuratierung (Konsens-Ansicht, AI-Voting, anonyme Abstimmung) geht deutlich über Immich hinaus. Ebenso sind Landmark-Erkennung, Foto-Qualitätsbewertung und die hybride Suche Alleinstellungsmerkmale.

Für eine Weiterentwicklung von FK-Encore wären folgende Immich-Features am wirkungsvollsten:
1. **Video-Support** – größte Funktionslücke
2. **Mobile App / PWA** mit Auto-Backup
3. **Öffentliche Sharing-Links**
4. **OAuth/OIDC** für Enterprise-Einsatz
5. **Interaktive Kartenansicht**
