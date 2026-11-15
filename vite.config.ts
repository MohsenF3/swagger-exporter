import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: { popup: 'popup.html', workspace: 'workspace.html' },
    },
  },
});
