import type { StorybookConfig } from '@storybook/vue3-vite'

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: [
    '@storybook/addon-essentials',
    'msw-storybook-addon',
  ],
  framework: {
    name: '@storybook/vue3-vite',
    options: {},
  },
  viteFinal: async (config) => {
    // Use root-relative base in Storybook dev server
    config.base = '/'
    // Remove the backend proxy – MSW handles /api/* in Storybook
    if (config.server) {
      delete config.server.proxy
    }
    return config
  },
}

export default config
