// The smallest host that composes Profile and nothing else (ADR-0012 §4).
// A real host names the package instead: extends: ['@nuxt-layers/profile'].
export default defineNuxtConfig({
  extends: ['../..'],
  compatibilityDate: '2026-06-30',
})
