import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { modules, detectModule, MODULE_ROUTE_KEY_PREFIX } from '../config/modules'
import LoginView from '../views/LoginView.vue'
import RegisterView from '../views/RegisterView.vue'
import ForgotPasswordView from '../views/ForgotPasswordView.vue'
import ProfileView from '../views/ProfileView.vue'
import SharedAlbumView from '../views/SharedAlbumView.vue'
import { isStaleChunkLoadError } from '../utils/appUpdate'

// ── Last-view persistence ────────────────────────────────────────────────────
// We save the most recent authenticated route path to localStorage so that
// opening the app fresh (bookmark / logo / explicit "/" navigation) restores
// the view the user had open. A route is only persisted after it navigated
// successfully (afterEach), so failed / redirected navigations don't pollute
// the entry. Public auth routes are excluded so logging out and back in
// doesn't snap the user back to /login.
export const LAST_ROUTE_KEY = 'app_last_route'
const PUBLIC_ROUTE_NAMES = new Set(['login', 'register', 'forgot-password', 'shared-album'])

function readLastRoute(): string | null {
  const raw = localStorage.getItem(LAST_ROUTE_KEY)
  if (!raw) return null
  // Minimal sanity checks: must be an in-app path, not the root itself
  // (would loop), not a public auth route.
  if (!raw.startsWith('/') || raw === '/' || raw.startsWith('/login') ||
      raw.startsWith('/register') || raw.startsWith('/forgot-password')) {
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
  routes: [
    // Default: restore the most recently open view, falling back to the
    // content feed (the app "home") for first-time visitors. Older accounts
    // already have a saved last-route in localStorage so they keep landing
    // on whatever they had open before this default flipped.
    {
      path: '/',
      redirect: () => readLastRoute() ?? '/fotos/stream',
    },

    // Public routes
    { path: '/login', name: 'login', component: LoginView },
    { path: '/register', name: 'register', component: RegisterView },
    { path: '/forgot-password', name: 'forgot-password', component: ForgotPasswordView },

    // Shared authenticated routes
    { path: '/profile', name: 'profile', component: ProfileView },

    // Public shared album (no auth required)
    { path: '/albums/shared/:token', name: 'shared-album', component: SharedAlbumView },

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
    { path: '/data-management', redirect: '/admin/daten' },
  ],
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  auth.loadFromStorage()

  if (!auth.isAuthenticated && !PUBLIC_ROUTE_NAMES.has(to.name as string)) {
    return { name: 'login' }
  }

  // Check route-level permission
  const requiredPermission = to.meta.permission as string | undefined
  if (requiredPermission && !auth.hasPermission(requiredPermission)) {
    return { name: 'profile' }
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
