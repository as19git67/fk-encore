import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { modules } from '../config/modules'
import LoginView from '../views/LoginView.vue'
import RegisterView from '../views/RegisterView.vue'
import ForgotPasswordView from '../views/ForgotPasswordView.vue'
import ProfileView from '../views/ProfileView.vue'
import SharedAlbumView from '../views/SharedAlbumView.vue'

// Build module routes from config
const moduleRoutes: RouteRecordRaw[] = modules.map((mod) => ({
  path: mod.basePath,
  children: mod.routes,
}))

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    // Default: redirect to first module
    { path: '/', redirect: modules[0]?.basePath ?? '/fotos' },

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

  const publicRoutes = ['login', 'register', 'forgot-password', 'shared-album']
  if (!auth.isAuthenticated && !publicRoutes.includes(to.name as string)) {
    return { name: 'login' }
  }

  // Check route-level permission
  const requiredPermission = to.meta.permission as string | undefined
  if (requiredPermission && !auth.hasPermission(requiredPermission)) {
    return { name: 'profile' }
  }
})

export default router
