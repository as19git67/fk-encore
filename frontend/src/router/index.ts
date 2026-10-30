import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { modules, detectModule, landingPath, refusedRouteFallback, MODULE_ROUTE_KEY_PREFIX } from '../config/modules'
import LoginView from '../views/LoginView.vue'
import RegisterView from '../views/RegisterView.vue'
import ForgotPasswordView from '../views/ForgotPasswordView.vue'
import ProfileView from '../views/ProfileView.vue'
import SharedAlbumView from '../views/SharedAlbumView.vue'
import { isStaleChunkLoadError } from '../utils/appUpdate'
import { markNavigation, saveScrollOffset } from '../utils/scrollMemory'
import { safeLoginRedirect } from '../utils/loginRedirect'

// ── Last-view persistence ────────────────────────────────────────────────────
// We save the most recent authenticated route path to localStorage so that
// opening the app fresh (bookmark / logo / explicit "/" navigation) restores
// the view the user had open. A route is only persisted after it navigated
// successfully (afterEach), so failed / redirected navigations don't pollute
// the entry. Public auth routes are excluded so logging out and back in
// doesn't snap the user back to /login.
export const LAST_ROUTE_KEY = 'app_last_route'
const PUBLIC_ROUTE_NAMES = new Set(['login', 'register', 'forgot-password', 'shared-album', 'shared-collection'])

function readLastRoute(): string | null {
  const raw = localStorage.getItem(LAST_ROUTE_KEY)
  if (!raw) return null
  // Minimal sanity checks: must be an in-app path, not the root itself
  // (would loop), not a public auth route.
  // The profile is never a place to come back to: it is where a user without
  // any module landed, and remembering it kept them there after they got one.
  if (!raw.startsWith('/') || raw === '/' || raw.startsWith('/login') ||
      raw.startsWith('/register') || raw.startsWith('/forgot-password') ||
      raw.startsWith('/profile')) {
    return null
  }
  return raw
}

// Build module routes from config
const moduleRoutes: RouteRecordRaw[] = modules.map((mod) => ({
  path: mod.basePath,
  children: mod.routes,
}))

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  /**
   * Scrolling is decided in one place (issue #1272, stage 4). The offset of
   * the page being left is saved below; putting it back is `PageLayout`'s
   * job, because only the view knows when its list is tall enough to hold
   * that offset. Here we only record how we got here — a saved position means
   * back or forward, anything else is a fresh start at the top.
   */
  scrollBehavior(_to, _from, savedPosition) {
    markNavigation(savedPosition !== null)
    return savedPosition ?? { top: 0 }
  },
  routes: [
    // Default: restore the most recently open view, falling back to the
    // first module the user may use (Fotos for most). The permission check
    // below still runs on whatever this resolves to.
    {
      path: '/',
      redirect: () => {
        const auth = useAuthStore()
        auth.loadFromStorage()
        return readLastRoute() ?? landingPath((p) => auth.hasPermission(p))
      },
    },

    // Public routes
    { path: '/login', name: 'login', component: LoginView },
    { path: '/register', name: 'register', component: RegisterView },
    { path: '/forgot-password', name: 'forgot-password', component: ForgotPasswordView },

    // Shared authenticated routes
    { path: '/profile', name: 'profile', component: ProfileView },

    // Collections of every type (#1548): the list, and the page of a mixed one.
    { path: '/sammelmappen', name: 'sammelmappen', component: () => import('../views/CollectionsView.vue') },
    {
      path: '/sammelmappen/:id',
      name: 'sammelmappe-detail',
      component: () => import('../views/CollectionDetailView.vue'),
    },

    // Public shared album (no auth required)
    { path: '/albums/shared/:token', name: 'shared-album', component: SharedAlbumView },
    // A collection behind an anonymous share link (#1548, stage 8).
    {
      path: '/geteilt/:token',
      name: 'shared-collection',
      component: () => import('../views/SharedCollectionView.vue'),
    },

    // Module routes
    ...moduleRoutes,

    // Legacy redirects (keep old URLs working)
    { path: '/photos', redirect: '/fotos' },
    { path: '/fotos/galerie-alt', redirect: '/fotos/galerie' },
    { path: '/albums', redirect: '/fotos/alben' },
    { path: '/albums/:id', redirect: (to) => `/fotos/alben/${to.params.id}` },
    { path: '/people', redirect: '/fotos/personen' },
    { path: '/users', redirect: '/admin' },
    { path: '/users/:id', redirect: (to) => `/admin/benutzer/${to.params.id}` },
    { path: '/roles', redirect: '/admin/rollen' },
    { path: '/data-management', redirect: '/admin/status' },
  ],
})

// Remember where the page being left was scrolled to, before the new one
// takes the stage. Keyed by the full path, so the same list under a different
// filter keeps its own position.
router.beforeEach((to, from) => {
  if (from.name && from.fullPath !== to.fullPath) saveScrollOffset(from.fullPath)
})

let userRefreshedThisLoad = false

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  auth.loadFromStorage()

  if (!auth.isAuthenticated && !PUBLIC_ROUTE_NAMES.has(to.name as string)) {
    // Keep the target: a shared link to a detail page must survive the login
    // wall. The login page navigates to `?redirect=` after signing in
    // (validated there — see `utils/loginRedirect.ts`).
    const redirect = safeLoginRedirect(to.fullPath)
    return { name: 'login', query: redirect ? { redirect } : {} }
  }

  // The stored user is a copy from login. Fetch the current roles once per
  // page load, so a role granted since then shows up after a reload.
  if (auth.isAuthenticated && !userRefreshedThisLoad && !PUBLIC_ROUTE_NAMES.has(to.name as string)) {
    userRefreshedThisLoad = true
    await auth.refreshUser()
  }

  // Check route-level permission. Before turning the user away, ask the
  // server once more — the role may have been granted a moment ago.
  const requiredPermission = to.meta.permission as string | string[] | undefined
  if (requiredPermission && !auth.hasPermission(requiredPermission)) {
    await auth.refreshUser()
    if (!auth.hasPermission(requiredPermission)) {
      return refusedRouteFallback(to.fullPath, (p) => auth.hasPermission(p))
    }
  }
})

// After a deployment Vite chunk hashes change. If a stale tab tries to
// lazy-load a route whose chunk no longer exists on the server, vue-router
// emits a navigation error. Catch it and do a full reload so the browser
// picks up the new index.html with current chunk references.
router.onError((err, to) => {
  if (isStaleChunkLoadError(err)) {
    const target = router.resolve(to).href
    const reloadKey = 'stale_chunk_reload_target'
    if (sessionStorage.getItem(reloadKey) !== target) {
      sessionStorage.setItem(reloadKey, target)
      // resolve().href retains Vite's /app/ base. Assigning to.fullPath here
      // used to navigate to /fotos/... outside the SPA mount point.
      window.location.assign(target)
    }
  }
})

// Persist the last successfully-visited authenticated route so it can be
// restored by the `/` redirect above. Runs after the navigation is
// committed, so redirected / aborted navigations never end up stored.
router.afterEach((to) => {
  sessionStorage.removeItem('stale_chunk_reload_target')
  if (PUBLIC_ROUTE_NAMES.has(to.name as string)) return
  if (to.path === '/') return
  localStorage.setItem(LAST_ROUTE_KEY, to.fullPath)
  // Remember the last route per module so the main menu can restore it.
  const mod = detectModule(to.path)
  if (mod) {
    localStorage.setItem(MODULE_ROUTE_KEY_PREFIX + mod.id, to.fullPath)
  }
})

export default router
