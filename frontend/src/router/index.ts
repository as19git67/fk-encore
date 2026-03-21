import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import LoginView from '../views/LoginView.vue'
import RegisterView from '../views/RegisterView.vue'
import UserListView from '../views/UserListView.vue'
import UserDetailView from '../views/UserDetailView.vue'
import RolesView from '../views/RolesView.vue'
import ProfileView from '../views/ProfileView.vue'
import PhotosView from '../views/PhotosView.vue'
import PersonsView from '../views/PersonsView.vue'
import PhotoGroupsView from '../views/PhotoGroupsView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/photos' },
    { path: '/login', name: 'login', component: LoginView },
    { path: '/register', name: 'register', component: RegisterView },
    { path: '/users', name: 'users', component: UserListView, meta: { permission: 'users.list' } },
    { path: '/users/:id', name: 'user-detail', component: UserDetailView, meta: { permission: 'users.read' } },
    { path: '/roles', name: 'roles', component: RolesView, meta: { permission: 'roles.list' } },
    { path: '/profile', name: 'profile', component: ProfileView },
    { path: '/photos', name: 'photos', component: PhotosView, meta: { permission: 'photos.view' } },
    { path: '/people', name: 'people', component: PersonsView, meta: { permission: 'people.view' } },
    { path: '/groups', name: 'groups', component: PhotoGroupsView, meta: { permission: 'people.view' } },
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
