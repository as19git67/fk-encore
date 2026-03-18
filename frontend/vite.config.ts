import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('/primevue/')) {
            const primevuePath = id.split('/primevue/')[1]
            const segment = primevuePath?.split('/')[0]
            return segment ? `vendor-primevue-${segment}` : 'vendor-primevue'
          }
          if (id.includes('/@primeuix/')) {
            const primeuixPath = id.split('/@primeuix/')[1]
            const segment = primeuixPath?.split('/')[0]
            return segment ? `vendor-primeuix-${segment}` : 'vendor-primeuix'
          }
          if (id.includes('/vue/') || id.includes('/vue-router/') || id.includes('/pinia/')) return 'vendor-vue'
          if (id.includes('/primeicons/')) return 'vendor-primeicons'
          if (id.includes('/@simplewebauthn/browser/')) return 'vendor-webauthn'
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
