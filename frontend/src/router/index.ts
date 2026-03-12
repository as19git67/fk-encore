import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import LoginView from '../views/LoginView.vue'
import RegisterView from '../views/RegisterView.vue'
import UserListView from '../views/UserListView.vue'
import UserDetailView from '../views/UserDetailView.vue'
import RolesView from '../views/RolesView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/users' },
    { path: '/login', name: 'login', component: LoginView },
    { path: '/register', name: 'register', component: RegisterView },
    { path: '/users', name: 'users', component: UserListView },
    { path: '/users/:id', name: 'user-detail', component: UserDetailView },
    { path: '/roles', name: 'roles', component: RolesView },
  ],
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  auth.loadFromStorage()

  const publicRoutes = ['login', 'register']
  if (!auth.isAuthenticated && !publicRoutes.includes(to.name as string)) {
    return { name: 'login' }
  }
})

export default router

