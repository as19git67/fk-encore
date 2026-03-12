import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import LoginView from '../views/LoginView.vue'
import RegisterView from '../views/RegisterView.vue'
import UserListView from '../views/UserListView.vue'
import UserDetailView from '../views/UserDetailView.vue'
import RolesView from '../views/RolesView.vue'
import ProfileView from '../views/ProfileView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/profile' },
    { path: '/login', name: 'login', component: LoginView },
    { path: '/register', name: 'register', component: RegisterView },
    { path: '/users', name: 'users', component: UserListView, meta: { permission: 'users.list' } },
    { path: '/users/:id', name: 'user-detail', component: UserDetailView, meta: { permission: 'users.read' } },
    { path: '/roles', name: 'roles', component: RolesView, meta: { permission: 'roles.list' } },
    { path: '/profile', name: 'profile', component: ProfileView },
  ],
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  auth.loadFromStorage()

  const publicRoutes = ['login', 'register']
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
