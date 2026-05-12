# Feature Comparison: Immich vs. FK-Encore

Status: April 2026 (updated)

## Legend

- ✅ Available
- ⚡ Available and superior
- 🔶 Partial / implemented differently
- ❌ Not available

---

## 1. Photo Management

| Feature | Immich | FK-Encore |
|---|---|---|
| Upload (Web) | ✅ | ✅ |
| Upload (Mobile App) | ✅ | ❌ |
| Upload (CLI) | ✅ Bulk upload, glob filter, watch mode | ❌ |
| Formats: JPEG, PNG, GIF, WebP | ✅ | ✅ |
| HEIC/HEIF support | ✅ Native | ✅ With auto-conversion to JPEG |
| RAW formats (RW2, PSD, TIFF, etc.) | ✅ 15+ formats | ❌ |
| AVIF, JPEG XL, JPEG 2000, SVG | ✅ | ❌ |
| Duplicate detection (hash-based) | ✅ | ✅ |
| Duplicate detection (ML-visual) | ✅ With review interface | ✅ DINOv2-based with review workflow |
| Non-destructive image editing | ✅ Crop, rotate, mirror | ❌ |
| Photo stacks (burst, bracketing) | ✅ | ❌ |
| 360° images | ✅ (Web) | ❌ |
| LivePhotos / MotionPhotos | ✅ | ❌ |
| Thumbnail generation | ✅ Standard | ⚡ Intelligent focus point (face / landmark) |
| On-the-fly image resizing | 🔶 Predefined sizes | ✅ Freely selectable via query parameter |
| Photo quality scoring (AI) | ❌ | ⚡ AI score (0-1) with detailed metrics |

## 2. Video Management

| Feature | Immich | FK-Encore |
|---|---|---|
| Video upload & playback | ✅ 12+ formats | ❌ |
| Hardware transcoding | ✅ NVENC, Quick Sync, VAAPI, RKMPP | ❌ |
| Video streaming | ✅ | ❌ |

> **FK-Encore is purely photo-based – video support is missing entirely.**

## 3. Albums & Sharing

| Feature | Immich | FK-Encore |
|---|---|---|
| Create & manage albums | ✅ | ✅ |
| Share albums with users | ✅ Editor/Viewer roles | ✅ Read/Write access |
| Public links (no account) | ✅ With expiry date, password | 🔶 With expiry date (no password) |
| Upload by recipients | ✅ Configurable | ❌ |
| Album sync from phone | ✅ Auto-sync of device albums | ❌ |
| Album cover photo | ✅ | ✅ |
| Collaborative curation | ❌ | ⚡ Favorites, hide, consensus view |
| Anonymous voting in albums | ❌ | ⚡ "3/5 favorites" display |
| AI as album participant | ❌ | ⚡ Quality-based AI voting |
| Multiple view modes per album | ❌ | ⚡ All / Favorites / Consensus / Custom |
| Partner sharing (entire library) | ✅ | ❌ |

## 4. Search

| Feature | Immich | FK-Encore |
|---|---|---|
| Semantic search (CLIP) | ✅ OpenCLIP | ✅ OpenCLIP |
| Visual similarity search | 🔶 For duplicates | ⚡ DINOv2 + hybrid mode (CLIP+DINOv2) |
| Natural language search | ✅ English-focused | ⚡ German with intelligent query parsing |
| Query decomposition (location+date+semantic) | ❌ | ⚡ Automatic decomposition of complex queries |
| OCR search (text in images) | ✅ | ❌ |
| Filename search | ✅ | ❌ |
| Camera search (make/model/lens) | ✅ | ❌ |
| Location search (city/country) | ✅ | ✅ |
| GPS radius search | ❌ | ⚡ Search within km radius |
| Date / time range search | ✅ | ✅ |
| Landmark search | ❌ | ⚡ Search by detected points of interest |
| Tag search | ✅ | ❌ |
| Description search | ✅ | ❌ |
| Combined filters | ✅ | ✅ (via query parsing) |

## 5. AI / Machine Learning

| Feature | Immich | FK-Encore |
|---|---|---|
| Face recognition | ✅ DBSCAN clustering | ✅ InsightFace + embeddings |
| Face clustering | ✅ Incremental + nightly jobs | ✅ Distance-based |
| Name & manage people | ✅ | ✅ |
| Merge people | ✅ | ✅ |
| Birthday & age at time of photo | ✅ | ❌ |
| Hide people | ✅ | ✅ (ignore faces) |
| Object / scene detection | ✅ Auto-tagging | ❌ |
| Landmark detection | ❌ | ⚡ Grounding DINO (churches, bridges, etc.) |
| Photo quality scoring | ❌ | ⚡ AI score for every photo |
| Intelligent focus point | ❌ | ⚡ Face / landmark-based |
| GPU acceleration | ✅ CUDA, OpenVINO, VAAPI, ARM-NN, ROCm | ❌ |
| Multi-GPU support | ✅ | ❌ |
| FP16 precision | ✅ | ❌ |
| Configurable ML models | ✅ | ✅ |

## 6. Map & Geolocation

| Feature | Immich | FK-Encore |
|---|---|---|
| Interactive world map | ✅ Web & mobile | ❌ |
| Reverse geocoding | ✅ Local (GeoNames) | ✅ City/country extraction |
| GPS coordinates from EXIF | ✅ | ✅ |
| GPS rescan / bulk rescan | 🔶 Via jobs | ✅ Individual or bulk |

## 7. Timeline & Memories

| Feature | Immich | FK-Encore |
|---|---|---|
| Chronological timeline | ✅ With virtual scroll | ✅ Photo grid with navigation |
| Folder view | ✅ | ❌ |
| Memories ("On this day") | ✅ Web & mobile | ❌ |
| Scrubbable scrollbar | ✅ | ❌ |

## 8. Mobile Apps

| Feature | Immich | FK-Encore |
|---|---|---|
| iOS app | ✅ Native | 🔶 SwiftUI app in development (read-only, no auto-backup) |
| Android app | ✅ Native | ❌ |
| Auto-backup on app start | ✅ | ❌ |
| Background backup | ✅ iOS & Android | ❌ |
| Selective album backup | ✅ | ❌ |
| Wi-Fi-only upload | ✅ | ❌ |
| "Free up space" | ✅ | ❌ |
| Offline mode | ✅ | ❌ |
| Read-only mode | ✅ | ❌ |

> **FK-Encore has no native Android app. The iOS app is under active development (SwiftUI, read-only so far) – no auto-backup yet.**

## 9. Authentication & User Management

| Feature | Immich | FK-Encore |
|---|---|---|
| Password login | ✅ | ✅ (bcrypt) |
| OAuth / OIDC | ✅ Authentik, Keycloak, Google, etc. | ❌ |
| Passkeys (WebAuthn/FIDO2) | ❌ | ⚡ Registration, login, multi-passkey |
| API keys | ✅ | ❌ |
| Password reset via email | 🔶 Only via admin CLI | ✅ Token-based via email |
| Session management | ✅ Device overview | ✅ Token-based |
| Role system | 🔶 Admin/User | ⚡ Granular RBAC with custom roles |
| Fine-grained permissions | ❌ | ⚡ 19+ permissions per role, incl. opt-in `photos.purge` |
| Storage quotas per user | ✅ | ❌ |
| Auto-registration via OAuth | ✅ | ❌ |
| Rate limiting (login) | ❌ | ✅ |

## 10. External Libraries & Storage

| Feature | Immich | FK-Encore |
|---|---|---|
| Mount external folders | ✅ Read-only | ❌ |
| Filesystem watching | ✅ (experimental) | ❌ |
| Scheduled scans | ✅ | ❌ |
| Configurable storage layout | ✅ Templates | 🔶 Automatic YYYY/YYYY-MM folders with dated filenames |
| S3-compatible backends | ✅ | ❌ |
| Object storage | ❌ | ✅ Encore Buckets |
| XMP sidecar support | ✅ Read & write | 🔶 Read (merged with embedded, sidecar wins; live re-sync on `.xmp` change). Write-back to sidecar files not yet implemented |

## 11. Metadata

| Feature | Immich | FK-Encore |
|---|---|---|
| EXIF display | ✅ Extensive | ✅ |
| EXIF extraction | ✅ 9 prioritized DateTime fields | ✅ |
| Edit date manually | ✅ | ✅ |
| XMP sidecar read/write | ✅ | 🔶 Sidecar read implemented (`PHOTO_XMP_WRITE_BACK` toggle for embedded write-back); sidecar write-back still on the roadmap |
| Tag import (XMP/IPTC) | ✅ | 🔶 IPTC extraction at upload (keywords, description, dates, location, copyright) + XMP rating → `Rating-N` keyword |
| Ratings | ✅ | 🔶 XMP rating imported as `Rating-1`…`Rating-5` tag; per-library threshold auto-favourites rated photos |
| Descriptions | ✅ | ✅ |
| Metadata refresh / reindex | ✅ Via jobs | ✅ Individual and bulk |

## 12. Admin & Monitoring

| Feature | Immich | FK-Encore |
|---|---|---|
| Admin dashboard | ✅ | ✅ (Data Management View) |
| Job management | ✅ Trigger & monitor | ✅ Scan queue with status tracking |
| Service health monitoring | 🔶 | ✅ For all ML services |
| Prometheus metrics | ✅ | ❌ |
| Grafana integration | ✅ | ❌ |
| Structured JSON logging | ✅ | ❌ |
| Maintenance mode | ✅ | ❌ |
| Admin CLI | ✅ immich-admin | ❌ |
| Retry failed scans | 🔶 | ✅ With error logging |
| Full reset of all photo data | 🔶 Admin CLI / DB reset | ✅ UI action with dedicated permission, typed confirmation & FK-safe delete order |
| Application-consistent backup | ❌ | ⚡ ZFS snapshots + pg_dump with backup start/stop API |

## 13. Archive / Favorites / Trash

| Feature | Immich | FK-Encore |
|---|---|---|
| Archive (hide from timeline) | ✅ | 🔶 Visible/hidden system |
| Favorites | ✅ Global | 🔶 Per album and user |
| Trash (soft delete, 30 days) | ✅ | ❌ |
| Ratings (1-5 stars) | ✅ | 🔶 Imported from XMP as `Rating-N` tag; auto-favourite via per-library threshold |
| Hierarchical tags | ✅ | ❌ |

## 14. Miscellaneous

| Feature | Immich | FK-Encore |
|---|---|---|
| Google Cast / Chromecast | ✅ (experimental) | ❌ |
| Internationalization (18+ languages) | ✅ | ❌ |
| OpenAPI specification | ✅ | ✅ (generated by Encore.ts) |
| Microservice architecture | 🔶 ML as separate container | ⚡ 3 specialized ML services |
| PWA (installable web app) | ❌ | 🔶 Installable, no offline/auto-backup |
| Backend tech stack | Go + TypeScript + Python | Encore.ts (TypeScript) + Python |

---

## Summary

### Immich is superior at:

- **Video support** – entirely missing in FK-Encore
- **Mobile apps** with auto-backup (iOS & Android)
- **Interactive world map**
- **Memories** ("On this day")
- **External libraries** – mount existing photo folders
- **Partner sharing** – share an entire library
- **Public links with password protection** – FK-Encore has public links but no password
- **OAuth/OIDC** – enterprise SSO integration
- **GPU acceleration** – CUDA, OpenVINO, etc.
- **Video transcoding** with hardware acceleration
- **XMP sidecars** – metadata interoperability
- **Object / scene detection** and auto-tagging
- **OCR** – text recognition in images
- **Monitoring** – Prometheus, Grafana
- **Broader format support** (RAW, AVIF, JPEG XL, etc.)
- **Community size** and project maturity

### FK-Encore is superior at:

- **Collaborative album curation** – consensus view, anonymous voting, multiple view modes
- **AI as album participant** – quality-based voting
- **Landmark detection** – Grounding DINO for points of interest
- **AI quality scoring** – score for every photo
- **Intelligent auto-crop** – focus point based on faces / landmarks
- **Hybrid search** – CLIP + DINOv2 fusion
- **German language search** – with intelligent query parsing and decomposition
- **GPS radius search** – search within a kilometer radius
- **Passkey authentication** – WebAuthn/FIDO2
- **Granular RBAC** – 19+ permissions, custom roles, secured purge action with a dedicated role
- **Modular ML architecture** – 3 specialized microservices
- **Rate limiting** on auth endpoints
- **Password reset via email** (self-service)
- **Public album links** – with expiry date (no account required)
- **Application-consistent backup** – ZFS snapshots + pg_dump with automated retention
- **IPTC metadata extraction** – keywords, description, dates, location, copyright at upload

### Conclusion

**Immich** is the more comprehensive, more mature solution – especially as a
full Google Photos replacement with video support, mobile apps, and a broad
community. It covers the entire lifecycle of photo/video management.

**FK-Encore** stands out with innovative AI features and a unique collaborative
curation concept. Album curation (consensus view, AI voting, anonymous voting)
goes significantly beyond Immich. Landmark detection, photo quality scoring,
and hybrid search are additional unique selling points.

For the further development of FK-Encore, the following Immich features would
be the most impactful:
1. **Video support** – biggest functional gap
2. **iOS auto-backup** – app exists but upload/sync still missing
3. **Android app**
4. **OAuth/OIDC** for enterprise use
5. **Interactive map view**
6. **XMP sidecar write-back** – sidecar read landed in Track K (#146);
   writing user edits into a `.xmp` instead of the image file itself is
   still pending
