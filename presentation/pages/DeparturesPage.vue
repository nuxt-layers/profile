<script setup lang="ts">
/** Default page provided by @nuxt-layers/profile. Disable with profile.pages.enabled = false. */

const { t, locale } = useProfileText()
useHead({ title: t('profile.departures.title'), htmlAttrs: { lang: locale } })
</script>

<template>
  <div :class="profileClasses.page">
    <main :class="profileClasses.card" aria-labelledby="profile-page-title">
      <h1 id="profile-page-title" :class="profileClasses.title">{{ t('profile.departures.title') }}</h1>
      <ProfileDepartures />
    </main>
  </div>
</template>
