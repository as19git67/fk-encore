import type { RouteRecordRaw } from 'vue-router'

export interface ModuleMenuItem {
  label: string
  icon: string
  /** Omitted for group headers that only open a submenu (see `children`). */
  routeName?: string
  permission?: string
  /** When set, this item renders as a submenu (e.g. a "settings" group). */
  children?: ModuleMenuItem[]
}

export interface ModuleConfig {
  id: string
  label: string
  icon: string
  basePath: string
  permission?: string
  routes: RouteRecordRaw[]
  menuItems: ModuleMenuItem[]
}

export const modules: ModuleConfig[] = [
  {
    id: 'fotos',
    label: 'Fotos',
    icon: 'pi pi-images',
    basePath: '/fotos',
    permission: 'photos.view',
    routes: [
      {
        // The bare module path lands on the content feed (the app "home").
        path: '',
        redirect: { name: 'fotos-stream' },
      },
      {
        path: 'galerie',
        name: 'fotos-gallery',
        component: () => import('../views/GalleryView.vue'),
        meta: { permission: 'photos.view' },
      },
      {
        path: 'alben',
        name: 'fotos-albums',
        component: () => import('../views/AlbumsView.vue'),
        meta: { permission: 'photos.view' },
      },
      {
        path: 'alben/:id',
        name: 'fotos-album-detail',
        component: () => import('../views/AlbumDetailView.vue'),
        meta: { permission: 'photos.view' },
      },
      {
        path: 'personen',
        name: 'fotos-people',
        component: () => import('../views/PersonsView.vue'),
        meta: { permission: 'people.view' },
      },
      {
        path: 'rueckblicke',
        name: 'fotos-recaps',
        component: () => import('../views/RecapsView.vue'),
        meta: { permission: 'photos.view' },
      },
      {
        path: 'feed',
        name: 'fotos-feed',
        component: () => import('../views/FeedView.vue'),
        meta: { permission: 'photos.view' },
      },
      {
        path: 'stream',
        name: 'fotos-stream',
        component: () => import('../views/PhotoFeedView.vue'),
        meta: { permission: 'photos.view' },
      },
      {
        path: 'review-queue',
        name: 'fotos-review-queue',
        component: () => import('../views/ReviewQueueView.vue'),
        meta: { permission: 'photos.view' },
      },
      {
        path: 'einstellungen/scan-queue',
        name: 'fotos-settings-scan-queue',
        component: () => import('../views/PhotoScanQueueView.vue'),
        meta: { permission: 'data.manage' },
      },
      {
        path: 'einstellungen/wartung',
        name: 'fotos-settings-maintenance',
        component: () => import('../views/PhotoMaintenanceView.vue'),
        meta: { permission: 'data.manage' },
      },
      {
        path: 'einstellungen/bibliotheken',
        name: 'fotos-settings-libraries',
        component: () => import('../views/LibrariesView.vue'),
        meta: { permission: 'photos.libraries.manage' },
      },
      {
        path: 'einstellungen/osm',
        name: 'fotos-settings-osm',
        component: () => import('../views/OsmRegionsView.vue'),
        meta: { permission: 'osm.admin' },
      },
      {
        path: 'einstellungen/gefahrenzone',
        name: 'fotos-settings-purge',
        component: () => import('../views/PhotoPurgeView.vue'),
        meta: { permission: 'photos.purge' },
      },
    ],
    menuItems: [
      { label: 'Feed', icon: 'pi pi-home', routeName: 'fotos-stream', permission: 'photos.view' },
      { label: 'Galerie', icon: 'pi pi-images', routeName: 'fotos-gallery', permission: 'photos.view' },
      { label: 'Alben', icon: 'pi pi-folder-open', routeName: 'fotos-albums', permission: 'photos.view' },
      { label: 'Aktivität', icon: 'pi pi-bell', routeName: 'fotos-feed', permission: 'photos.view' },
      { label: 'Rückblicke', icon: 'pi pi-history', routeName: 'fotos-recaps', permission: 'photos.view' },
      { label: 'Personen', icon: 'pi pi-users', routeName: 'fotos-people', permission: 'people.view' },
      { label: 'Gruppen-Review', icon: 'pi pi-bolt', routeName: 'fotos-review-queue', permission: 'photos.view' },
      {
        label: 'Einstellungen',
        icon: 'pi pi-cog',
        children: [
          { label: 'Scan-Queue', icon: 'pi pi-spinner', routeName: 'fotos-settings-scan-queue', permission: 'data.manage' },
          { label: 'Wartung', icon: 'pi pi-wrench', routeName: 'fotos-settings-maintenance', permission: 'data.manage' },
          { label: 'Externe Bibliotheken', icon: 'pi pi-folder', routeName: 'fotos-settings-libraries', permission: 'photos.libraries.manage' },
          { label: 'OSM-Regionen', icon: 'pi pi-map', routeName: 'fotos-settings-osm', permission: 'osm.admin' },
          { label: 'Gefahrenzone', icon: 'pi pi-exclamation-triangle', routeName: 'fotos-settings-purge', permission: 'photos.purge' },
        ],
      },
    ],
  },
  {
    id: 'dokumente',
    label: 'Dokumente',
    icon: 'pi pi-file-pdf',
    basePath: '/dokumente',
    permission: 'documents.view',
    routes: [
      {
        path: '',
        name: 'dokumente-list',
        component: () => import('../views/DocumentsView.vue'),
        meta: { permission: 'documents.view' },
      },
      {
        path: 'korb',
        name: 'dokumente-korb',
        component: () => import('../views/DocumentsBasketView.vue'),
        meta: { permission: 'documents.view' },
      },
      {
        path: 'mappen',
        name: 'dokumente-mappen',
        component: () => import('../views/DocumentCollectionsView.vue'),
        meta: { permission: 'documents.view' },
      },
      {
        path: 'mappen/:id',
        name: 'dokumente-mappe',
        component: () => import('../views/DocumentCollectionDetailView.vue'),
        meta: { permission: 'documents.view' },
      },
      {
        path: 'spaeter',
        name: 'dokumente-spaeter',
        component: () => import('../views/DocumentsLaterView.vue'),
        meta: { permission: 'documents.view' },
      },
      {
        path: 'upload',
        name: 'dokumente-upload',
        component: () => import('../views/DocumentUploadView.vue'),
        meta: { permission: 'documents.upload' },
      },
      {
        path: 'steuer',
        name: 'dokumente-steuer',
        component: () => import('../views/DocumentsSteuerView.vue'),
        meta: { permission: 'documents.view' },
      },
      {
        path: 'steuer/hints',
        name: 'dokumente-steuer-hints',
        component: () => import('../views/TaxSectionHintsView.vue'),
        meta: { permission: 'documents.manage_taxonomy' },
      },
      {
        path: 'kategorien/vorschlaege',
        name: 'dokumente-kategorie-vorschlaege',
        component: () => import('../views/DocumentCategorySuggestionsView.vue'),
        meta: { permission: 'documents.manage_taxonomy' },
      },
      {
        path: 'hint-vorschlaege',
        name: 'dokumente-hint-vorschlaege',
        component: () => import('../views/DocumentHintSuggestionsView.vue'),
        meta: { permission: 'documents.manage_taxonomy' },
      },
      {
        path: 'bezugspersonen',
        name: 'dokumente-bezugspersonen',
        component: () => import('../views/SubjectPersonsView.vue'),
        meta: { permission: 'documents.view' },
      },
      {
        path: 'hilfe',
        name: 'dokumente-hilfe',
        component: () => import('../views/DocumentsHelpView.vue'),
        meta: { permission: 'documents.view' },
      },
      {
        path: 'gruppen',
        name: 'dokumente-gruppen',
        component: () => import('../views/GroupsView.vue'),
        meta: { permission: 'groups.view' },
      },
      {
        path: 'verarbeitung',
        name: 'dokumente-verarbeitung',
        component: () => import('../views/DocumentProcessingView.vue'),
        meta: { permission: 'data.manage' },
      },
      {
        path: 'korrespondenten',
        name: 'dokumente-korrespondenten',
        component: () => import('../views/CorrespondentOverridesView.vue'),
        meta: { permission: 'documents.manage_taxonomy' },
      },
      {
        path: 'taxonomie-cockpit',
        name: 'dokumente-taxonomie-cockpit',
        component: () => import('../views/TaxonomyCockpitView.vue'),
        meta: { permission: 'data.manage' },
      },
      {
        path: 'taxonomie-tools',
        name: 'dokumente-taxonomie-tools',
        component: () => import('../views/TaxonomyToolsView.vue'),
        meta: { permission: 'data.manage' },
      },
      {
        path: 'ki-modell',
        name: 'dokumente-ki-modell',
        component: () => import('../views/LlmModelsView.vue'),
        meta: { permission: 'data.manage' },
      },
      {
        // Must stay last — this route would otherwise swallow every
        // sibling path above it.
        path: ':id',
        name: 'dokumente-detail',
        component: () => import('../views/DocumentDetailView.vue'),
        meta: { permission: 'documents.view' },
      },
    ],
    menuItems: [
      { label: 'Alle Dokumente', icon: 'pi pi-copy', routeName: 'dokumente-list', permission: 'documents.view' },
      { label: 'Arbeitskorb', icon: 'pi pi-inbox', routeName: 'dokumente-korb', permission: 'documents.view' },
      { label: 'Später', icon: 'pi pi-clock', routeName: 'dokumente-spaeter', permission: 'documents.view' },
      { label: 'Sammelmappen', icon: 'pi pi-folder', routeName: 'dokumente-mappen', permission: 'documents.view' },
      { label: 'Steuer', icon: 'pi pi-receipt', routeName: 'dokumente-steuer', permission: 'documents.view' },
      {
        label: 'Einstellungen',
        icon: 'pi pi-cog',
        children: [
          { label: 'Kategorie-Vorschläge', icon: 'pi pi-folder-open', routeName: 'dokumente-kategorie-vorschlaege', permission: 'documents.manage_taxonomy' },
          { label: 'Steuer-Hints', icon: 'pi pi-sparkles', routeName: 'dokumente-steuer-hints', permission: 'documents.manage_taxonomy' },
          { label: 'Hint-Vorschläge', icon: 'pi pi-lightbulb', routeName: 'dokumente-hint-vorschlaege', permission: 'documents.manage_taxonomy' },
          { label: 'Korrespondenten', icon: 'pi pi-at', routeName: 'dokumente-korrespondenten', permission: 'documents.manage_taxonomy' },
          { label: 'Bezugspersonen', icon: 'pi pi-id-card', routeName: 'dokumente-bezugspersonen', permission: 'documents.view' },
          { label: 'Gruppen', icon: 'pi pi-users', routeName: 'dokumente-gruppen', permission: 'groups.view' },
          { label: 'Verarbeitung', icon: 'pi pi-file', routeName: 'dokumente-verarbeitung', permission: 'data.manage' },
          { label: 'Taxonomie-Cockpit', icon: 'pi pi-chart-line', routeName: 'dokumente-taxonomie-cockpit', permission: 'data.manage' },
          { label: 'Taxonomie-Tools', icon: 'pi pi-wrench', routeName: 'dokumente-taxonomie-tools', permission: 'data.manage' },
          { label: 'KI-Modell', icon: 'pi pi-microchip-ai', routeName: 'dokumente-ki-modell', permission: 'data.manage' },
          { label: 'Hilfe', icon: 'pi pi-question-circle', routeName: 'dokumente-hilfe', permission: 'documents.view' },
        ],
      },
    ],
  },
  {
    id: 'finanzen',
    label: 'Finanzen',
    icon: 'pi pi-euro',
    basePath: '/finanzen',
    permission: 'module.finance',
    routes: [
      {
        path: '',
        name: 'finance-overview',
        component: () => import('../views/finance/OverviewView.vue'),
        meta: { permission: 'finance.view' },
      },
      {
        path: 'konten',
        name: 'finance-accounts',
        component: () => import('../views/finance/AccountsView.vue'),
        meta: { permission: 'finance.view' },
      },
      {
        path: 'uebersicht/konto/:id',
        name: 'finance-account-transactions',
        component: () => import('../views/finance/AccountTransactionsView.vue'),
        meta: { permission: 'finance.view' },
      },
      {
        path: 'uebersicht/sektion/:name',
        name: 'finance-section-transactions',
        component: () => import('../views/finance/AccountTransactionsView.vue'),
        meta: { permission: 'finance.view' },
      },
      {
        path: 'umsaetze',
        name: 'finance-transactions',
        redirect: { name: 'finance-overview' },
      },
      {
        path: 'umsaetze/neu',
        name: 'finance-transaction-new',
        component: () => import('../views/finance/TransactionNewView.vue'),
        meta: { permission: 'finance.view' },
      },
      {
        path: 'umsaetze/:id',
        name: 'finance-transaction-detail',
        component: () => import('../views/finance/TransactionDetailView.vue'),
        meta: { permission: 'finance.view' },
      },
      {
        path: 'bankkontakte',
        name: 'finance-bankcontacts',
        component: () => import('../views/finance/BankcontactsView.vue'),
        meta: { permission: 'finance.accounts.manage' },
      },
      {
        path: 'bankkontakte/neu',
        name: 'finance-bankcontact-new',
        component: () => import('../views/finance/BankcontactDetailView.vue'),
        meta: { permission: 'finance.accounts.manage' },
      },
      {
        path: 'bankkontakte/:id',
        name: 'finance-bankcontact-detail',
        component: () => import('../views/finance/BankcontactDetailView.vue'),
        meta: { permission: 'finance.accounts.manage' },
      },
      {
        path: 'bankkontakte/:id/zeiten',
        name: 'finance-bankcontact-schedule',
        component: () => import('../views/finance/SyncScheduleView.vue'),
        meta: { permission: 'finance.accounts.manage' },
      },
      {
        path: 'analyse',
        name: 'finance-analysis',
        component: () => import('../views/finance/AnalysisView.vue'),
        meta: { permission: 'finance.view' },
      },
      {
        path: 'anomalien',
        name: 'finance-anomalies',
        component: () => import('../views/finance/AnomaliesView.vue'),
        meta: { permission: 'finance.view' },
      },
      {
        path: 'belegabgleich',
        name: 'finance-receipt-enrichment',
        component: () => import('../views/finance/ReceiptEnrichmentView.vue'),
        meta: { permission: 'finance.view' },
      },
      {
        path: 'admin/zugriff',
        name: 'finance-admin-access',
        component: () => import('../views/finance/AccountAssignmentView.vue'),
        meta: { permission: 'finance.admin' },
      },
      {
        path: 'bankkontakte/hilfe',
        name: 'finance-bankcontacts-help',
        component: () => import('../views/finance/BankcontactsHelpView.vue'),
        meta: { permission: 'finance.accounts.manage' },
      },
      {
        path: 'ki-tagging',
        name: 'finance-tag-queue',
        component: () => import('../views/finance/TagQueueView.vue'),
        meta: { permission: 'data.manage' },
      },
    ],
    menuItems: [
      { label: 'Übersicht', icon: 'pi pi-th-large', routeName: 'finance-overview', permission: 'finance.view' },
      { label: 'Konten', icon: 'pi pi-wallet', routeName: 'finance-accounts', permission: 'finance.view' },
      { label: 'Bankkontakte', icon: 'pi pi-building', routeName: 'finance-bankcontacts', permission: 'finance.accounts.manage' },
      { label: 'Analyse', icon: 'pi pi-chart-bar', routeName: 'finance-analysis', permission: 'finance.view' },
      { label: 'Anomalien', icon: 'pi pi-exclamation-triangle', routeName: 'finance-anomalies', permission: 'finance.view' },
      { label: 'Belegabgleich', icon: 'pi pi-receipt', routeName: 'finance-receipt-enrichment', permission: 'finance.view' },
      {
        label: 'Einstellungen',
        icon: 'pi pi-cog',
        children: [
          { label: 'Konto-Zugriff', icon: 'pi pi-key', routeName: 'finance-admin-access', permission: 'finance.admin' },
          { label: 'KI-Tagging', icon: 'pi pi-tags', routeName: 'finance-tag-queue', permission: 'data.manage' },
        ],
      },
    ],
  },
  {
    id: 'label',
    label: 'Label',
    icon: 'pi pi-tag',
    basePath: '/label',
    permission: 'module.label',
    routes: [
      {
        path: '',
        name: 'label-print',
        component: () => import('../views/LabelView.vue'),
        meta: { permission: 'label.view' },
      },
    ],
    menuItems: [
      { label: 'Drucken', icon: 'pi pi-print', routeName: 'label-print', permission: 'label.view' },
    ],
  },
  {
    id: 'zaehler',
    label: 'Zähler',
    icon: 'pi pi-gauge',
    basePath: '/zaehler',
    permission: 'module.meters',
    routes: [
      {
        path: '',
        name: 'zaehler-list',
        component: () => import('../views/MetersView.vue'),
        meta: { permission: 'meters.view' },
      },
      {
        path: 'schnellerfassung',
        name: 'zaehler-schnellerfassung',
        component: () => import('../views/MeterQuickEntryView.vue'),
        meta: { permission: 'meters.read_entry' },
      },
      {
        path: 'schnellerfassung/konfiguration',
        name: 'zaehler-schnellerfassung-config',
        component: () => import('../views/MeterQuickEntryConfigView.vue'),
        meta: { permission: 'meters.read_entry' },
      },
      {
        path: 'auffaelligkeiten',
        name: 'zaehler-anomalien',
        component: () => import('../views/MeterAnomaliesView.vue'),
        meta: { permission: 'meters.view' },
      },
      {
        // Must stay above ':id' — that route would otherwise swallow it.
        path: 'hilfe/gradtage',
        name: 'zaehler-hilfe-gradtage',
        component: () => import('../views/MeterDegreeDaysHelpView.vue'),
        meta: { permission: 'meters.view' },
      },
      {
        path: ':id',
        name: 'zaehler-detail',
        component: () => import('../views/MeterDetailView.vue'),
        meta: { permission: 'meters.view' },
      },
    ],
    menuItems: [
      { label: 'Zähler', icon: 'pi pi-gauge', routeName: 'zaehler-list', permission: 'meters.view' },
      { label: 'Schnellerfassung', icon: 'pi pi-list-check', routeName: 'zaehler-schnellerfassung', permission: 'meters.read_entry' },
      { label: 'Auffälligkeiten', icon: 'pi pi-exclamation-triangle', routeName: 'zaehler-anomalien', permission: 'meters.view' },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    icon: 'pi pi-cog',
    basePath: '/admin',
    permission: 'users.list',
    routes: [
      {
        path: '',
        name: 'admin-users',
        component: () => import('../views/UserListView.vue'),
        meta: { permission: 'users.list' },
      },
      {
        path: 'benutzer/:id',
        name: 'admin-user-detail',
        component: () => import('../views/UserDetailView.vue'),
        meta: { permission: 'users.read' },
      },
      {
        path: 'rollen',
        name: 'admin-roles',
        component: () => import('../views/RolesView.vue'),
        meta: { permission: 'roles.list' },
      },
      {
        path: 'jobs',
        name: 'admin-scheduled-jobs',
        component: () => import('../views/ScheduledJobsView.vue'),
        meta: { permission: 'data.manage' },
      },
      {
        path: 'status',
        name: 'admin-status',
        component: () => import('../views/SystemStatusView.vue'),
        meta: { permission: 'data.manage' },
      },

      // Everything module-specific moved into the module it belongs to.
      // These redirects keep old bookmarks and deep links working.
      { path: 'daten', redirect: { name: 'admin-status' } },
      { path: 'bibliotheken', redirect: { name: 'fotos-settings-libraries' } },
      { path: 'tools', redirect: { name: 'dokumente-taxonomie-tools' } },
      { path: 'taxonomie-cockpit', redirect: { name: 'dokumente-taxonomie-cockpit' } },
      { path: 'ki-modell', redirect: { name: 'dokumente-ki-modell' } },
    ],
    menuItems: [
      { label: 'Benutzer', icon: 'pi pi-users', routeName: 'admin-users', permission: 'users.list' },
      { label: 'Rollen', icon: 'pi pi-shield', routeName: 'admin-roles', permission: 'roles.list' },
      { label: 'Eingeplante Jobs', icon: 'pi pi-clock', routeName: 'admin-scheduled-jobs', permission: 'data.manage' },
      { label: 'Systemstatus', icon: 'pi pi-gauge', routeName: 'admin-status', permission: 'data.manage' },
    ],
  },
]

/**
 * Detect active module from the current path.
 * Returns the module ID if path starts with a known module basePath, otherwise null (= all modules).
 */
export function detectModule(path: string): ModuleConfig | null {
  return modules.find((m) => path === m.basePath || path.startsWith(m.basePath + '/')) ?? null
}

// Per-module last-route persistence. Switching modules via the main menu
// should return to whichever sub-menu item (or detail page) the user last
// had open in that module, not snap back to the module default. One entry
// per module is stored under this prefix, keyed by module id. The router's
// `afterEach` writes the entries; `moduleEntryPath` reads them.
export const MODULE_ROUTE_KEY_PREFIX = 'app_module_last_route:'

function isRestorableAppPath(raw: string | null): raw is string {
  if (!raw) return false
  // Must be an in-app path, not the root (would loop) or a public auth route.
  if (
    !raw.startsWith('/') ||
    raw === '/' ||
    raw.startsWith('/login') ||
    raw.startsWith('/register') ||
    raw.startsWith('/forgot-password')
  ) {
    return false
  }
  return true
}

/**
 * The path to navigate to when the user picks a module from the main menu:
 * the last route they had open in that module, falling back to the module's
 * base path the first time around. Guards against stale entries that point
 * at a different module or a public route.
 */
export function moduleEntryPath(mod: ModuleConfig): string {
  const raw = localStorage.getItem(MODULE_ROUTE_KEY_PREFIX + mod.id)
  if (isRestorableAppPath(raw) && detectModule(raw)?.id === mod.id) {
    return raw
  }
  return mod.basePath
}

/**
 * Get the default route name for a module.
 */
export function getModuleDefaultRoute(mod: ModuleConfig): string {
  return mod.routes[0]?.name as string
}
