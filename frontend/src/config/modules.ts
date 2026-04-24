import type { RouteRecordRaw } from 'vue-router'

export interface ModuleMenuItem {
  label: string
  icon: string
  routeName: string
  permission?: string
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
        path: '',
        name: 'fotos-gallery',
        component: () => import('../views/PhotosView.vue'),
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
    ],
    menuItems: [
      { label: 'Galerie', icon: 'pi pi-images', routeName: 'fotos-gallery', permission: 'photos.view' },
      { label: 'Alben', icon: 'pi pi-folder-open', routeName: 'fotos-albums', permission: 'photos.view' },
      { label: 'Feed', icon: 'pi pi-bell', routeName: 'fotos-feed', permission: 'photos.view' },
      { label: 'Rückblicke', icon: 'pi pi-history', routeName: 'fotos-recaps', permission: 'photos.view' },
      { label: 'Personen', icon: 'pi pi-users', routeName: 'fotos-people', permission: 'people.view' },
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
        path: 'hilfe',
        name: 'dokumente-hilfe',
        component: () => import('../views/DocumentsHelpView.vue'),
        meta: { permission: 'documents.view' },
      },
      {
        path: ':id',
        name: 'dokumente-detail',
        component: () => import('../views/DocumentDetailView.vue'),
        meta: { permission: 'documents.view' },
      },
    ],
    menuItems: [
      { label: 'Alle Dokumente', icon: 'pi pi-file', routeName: 'dokumente-list', permission: 'documents.view' },
      { label: 'Steuer', icon: 'pi pi-receipt', routeName: 'dokumente-steuer', permission: 'documents.view' },
      { label: 'Steuer-Hints', icon: 'pi pi-sparkles', routeName: 'dokumente-steuer-hints', permission: 'documents.manage_taxonomy' },
      { label: 'Hochladen', icon: 'pi pi-upload', routeName: 'dokumente-upload', permission: 'documents.upload' },
      {
        label: 'Kategorie-Vorschläge',
        icon: 'pi pi-folder-open',
        routeName: 'dokumente-kategorie-vorschlaege',
        permission: 'documents.manage_taxonomy',
      },
      { label: 'Hilfe', icon: 'pi pi-question-circle', routeName: 'dokumente-hilfe', permission: 'documents.view' },
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
        name: 'finance-accounts',
        component: () => import('../views/finance/AccountsView.vue'),
        meta: { permission: 'finance.view' },
      },
      {
        path: 'konten/:id',
        name: 'finance-account-detail',
        component: () => import('../views/finance/AccountDetailView.vue'),
        meta: { permission: 'finance.view' },
      },
      {
        path: 'umsaetze',
        name: 'finance-transactions',
        component: () => import('../views/finance/TransactionsView.vue'),
        meta: { permission: 'finance.view' },
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
        path: 'admin/zugriff',
        name: 'finance-admin-access',
        component: () => import('../views/finance/AccountAssignmentView.vue'),
        meta: { permission: 'finance.admin' },
      },
      {
        path: 'admin/import',
        name: 'finance-admin-import',
        component: () => import('../views/finance/AdminImportView.vue'),
        meta: { permission: 'finance.admin' },
      },
    ],
    menuItems: [
      { label: 'Konten', icon: 'pi pi-wallet', routeName: 'finance-accounts', permission: 'finance.view' },
      { label: 'Umsätze', icon: 'pi pi-list', routeName: 'finance-transactions', permission: 'finance.view' },
      { label: 'Bankkontakte', icon: 'pi pi-building', routeName: 'finance-bankcontacts', permission: 'finance.accounts.manage' },
      { label: 'Analyse', icon: 'pi pi-chart-bar', routeName: 'finance-analysis', permission: 'finance.view' },
      { label: 'Konto-Zugriff', icon: 'pi pi-key', routeName: 'finance-admin-access', permission: 'finance.admin' },
      { label: 'Import', icon: 'pi pi-cloud-upload', routeName: 'finance-admin-import', permission: 'finance.admin' },
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
        path: 'daten',
        name: 'admin-data',
        component: () => import('../views/DataManagementView.vue'),
        meta: { permission: 'data.manage' },
      },
      {
        path: 'bibliotheken',
        name: 'admin-libraries',
        component: () => import('../views/LibrariesView.vue'),
        meta: { permission: 'photos.libraries.manage' },
      },
    ],
    menuItems: [
      { label: 'Benutzer', icon: 'pi pi-users', routeName: 'admin-users', permission: 'users.list' },
      { label: 'Rollen', icon: 'pi pi-shield', routeName: 'admin-roles', permission: 'roles.list' },
      { label: 'Datenverwaltung', icon: 'pi pi-database', routeName: 'admin-data', permission: 'data.manage' },
      { label: 'Externe Bibliotheken', icon: 'pi pi-folder', routeName: 'admin-libraries', permission: 'photos.libraries.manage' },
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

/**
 * Get the default route name for a module.
 */
export function getModuleDefaultRoute(mod: ModuleConfig): string {
  return mod.routes[0]?.name as string
}
