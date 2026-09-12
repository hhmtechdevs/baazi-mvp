import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind every interface rather than localhost only. Two reasons, both about the shared table:
    // it lets a phone on the same wifi reach the dev server, and it makes 127.0.0.1 a genuinely
    // separate origin from localhost — separate localStorage, so two browser windows can hold two
    // different player identities without one signing the other out.
    host: true
  }
});
