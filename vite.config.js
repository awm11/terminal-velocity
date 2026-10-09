import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves project sites from /<repo-name>/, so the build needs
// that prefix — but local dev should stay at '/' so `npm run dev` just works.
// `command` is 'serve' during `npm run dev` and 'build' during `npm run build`.
// If you're deploying to a user/org page repo named '<username>.github.io',
// change REPO_NAME below to '' (so base stays '/' even in production).
const REPO_NAME = 'terminal-velocity';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' && REPO_NAME ? `/${REPO_NAME}/` : '/',
}));
