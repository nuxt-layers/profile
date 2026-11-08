<script setup lang="ts">
/**
 * Default page provided by @nuxt-layers/profile. Disable with
 * profile.pages.enabled = false. The document title stays generic: a
 * person's name never reaches the browser's history or tab list from here.
 */

const { t, locale } = useProfileText()
const route = useRoute()
useHead({ title: t('profile.person.title'), htmlAttrs: { lang: locale } })
const subjectId = computed(() => String(route.params.subjectId ?? ''))
const groupId = computed(() => (typeof route.query.groupId === 'string' ? route.query.groupId : null))
</script>

<template>
  <div :class="profileClasses.page">
    <main :class="profileClasses.card" aria-labelledby="profile-page-title">
      <ProfilePerson :key="`${subjectId}|${groupId ?? ''}`" :subject-id="subjectId" :group-id="groupId" />
    </main>
  </div>
</template>
