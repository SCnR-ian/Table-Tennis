import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(async () => {
  let cloudflarePlugin = () => null
  try {
    const m = await import('@cloudflare/vite-plugin')
    cloudflarePlugin = m.cloudflare
  } catch {}

  return {
    plugins: [react(), cloudflarePlugin(), VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png'],
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
      },
      manifest: {
        name: 'Epping Table Tennis Club',
        short_name: 'ETTC',
        description: 'Book courts, join coaching, and manage your membership.',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#000000',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    })],
    resolve: {
      alias: {
        '@': '/src',
      },
    },
    server: {
      allowedHosts: 'all',
      host: true,
    },
  }
})
