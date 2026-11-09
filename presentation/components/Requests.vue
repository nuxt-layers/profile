<script setup lang="ts">
import type { RequestView } from '../../contracts'

/**
 * PUBLIC. The person's requests about their data: a copy of everything the
 * service holds about them (from every part of it), or a restriction of who
 * sees their details; and the progress of each, including those an
 * operator opened for them. Having their data deleted is closing the
 * account, which this links to when the host names its page. Every request
 * is decided again on the server.
 */
const profile = useProfile()
const action = useProfileAction()
const { t, locale } = useProfileText()

/** A part's name: the host's wording for a part it declared, or the general fallback. */
function partName(part: string): string {
  const key = `profile.requests.part.${part}`
  const named = t(key)
  return named === key ? t('profile.requests.part.other') : named
}
const routes = useProfileRoutes()
const notice = ref<string | null>(null)

const { data, error, refresh } = await useAsyncData('profile-requests', () => profile.requests())
const failure = computed(() => (error.value ? profileErrorOf(error.value)?.code ?? 'unavailable' : null))
const requests = computed<RequestView[]>(() => data.value?.requests ?? [])
// Dates through Clock (Layer Standard §5), in the pages' locale and Clock's configured time zone, so SSR and hydration agree.
const clock = useClock({ locale })
const dateOf = (instant: string) => clock.format(clock.parse('instant', instant), { dateStyle: 'long' })

async function open(type: 'access' | 'restriction') {
  notice.value = null
  const opened = await action.run(() => profile.openRequest(type))
  if (opened) {
    notice.value = t(`profile.requests.opened.${type}`)
    await refresh()
  }
}

async function download(request: RequestView) {
  notice.value = null
  const archive = await action.run(() => profile.requestArchive(request.requestId))
  if (archive === null) return
  const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = t('profile.requests.fileName')
  anchor.click()
  URL.revokeObjectURL(url)
  notice.value = t('profile.export.ready')
}
</script>

<template>
  <div :class="profileClasses.stack">
    <p :class="profileClasses.text">{{ t('profile.requests.explained') }}</p>
    <ProfileAlert v-if="action.error.value" tone="error">
      <p>{{ action.error.value }}</p>
      <p v-if="action.code.value === 'insufficient-assurance'" class="mt-2"><ProfileSignInLink again /></p>
    </ProfileAlert>
    <ProfileAlert v-if="notice" tone="success" :focus-on-mount="false">{{ notice }}</ProfileAlert>

    <section :class="profileClasses.section" aria-labelledby="profile-requests-new">
      <h2 id="profile-requests-new" :class="profileClasses.sectionTitle">{{ t('profile.requests.newTitle') }}</h2>
      <div :class="profileClasses.stack">
        <div>
          <p :class="profileClasses.text">{{ t('profile.requests.accessExplained') }}</p>
          <div :class="profileClasses.row" class="mt-2">
            <button type="button" :class="profileClasses.primaryButton" :disabled="action.disabled.value" @click="open('access')">{{ t('profile.requests.access') }}</button>
          </div>
        </div>
        <div>
          <p :class="profileClasses.text">{{ t('profile.requests.restrictionExplained') }}</p>
          <div :class="profileClasses.row" class="mt-2">
            <button type="button" :class="profileClasses.secondaryButton" :disabled="action.disabled.value" @click="open('restriction')">{{ t('profile.requests.restriction') }}</button>
          </div>
        </div>
        <p :class="profileClasses.muted">
          {{ t('profile.requests.deletionExplained') }}
          <NuxtLink v-if="routes.closeAccount()" :to="routes.closeAccount()!" :class="profileClasses.link">{{ t('profile.requests.closeAccount') }}</NuxtLink>
        </p>
      </div>
    </section>

    <section :class="profileClasses.section" aria-labelledby="profile-requests-list">
      <h2 id="profile-requests-list" :class="profileClasses.sectionTitle">{{ t('profile.requests.listTitle') }}</h2>
      <ProfileUnavailable v-if="failure" :code="failure" />
      <p v-else-if="requests.length === 0" :class="profileClasses.muted">{{ t('profile.requests.none') }}</p>
      <ul v-else :class="profileClasses.list">
        <li v-for="request in requests" :key="request.requestId" class="py-3">
          <div :class="profileClasses.row">
            <h3 :class="profileClasses.legend">{{ t(`profile.requests.type.${request.type}`) }}</h3>
            <span :class="profileClasses.badge">{{ t(`profile.requests.status.${request.status}`) }}</span>
          </div>
          <dl :class="profileClasses.definitions" class="mt-2">
            <dt :class="profileClasses.term">{{ t('profile.requests.openedAt') }}</dt>
            <dd :class="profileClasses.definition">{{ dateOf(request.openedAt) }}</dd>
            <dt :class="profileClasses.term">{{ t('profile.requests.dueAt') }}</dt>
            <dd :class="profileClasses.definition">{{ dateOf(request.dueAt) }}</dd>
            <template v-for="part in request.parts" :key="part.part">
              <dt :class="profileClasses.term">{{ partName(part.part) }}</dt>
              <dd :class="profileClasses.definition">{{ t(`profile.requests.partStatus.${part.status}`) }}</dd>
            </template>
          </dl>
          <div v-if="request.archiveUntil" :class="profileClasses.row" class="mt-2">
            <button type="button" :class="profileClasses.secondaryButton" :disabled="action.disabled.value" @click="download(request)">{{ t('profile.requests.download') }}</button>
            <span :class="profileClasses.muted">{{ t('profile.requests.availableUntil', { date: dateOf(request.archiveUntil) }) }}</span>
          </div>
        </li>
      </ul>
    </section>
    <p v-if="routes.profile()"><NuxtLink :to="routes.profile()!" :class="profileClasses.actionLink">{{ t('profile.common.backToProfile') }}</NuxtLink></p>
  </div>
</template>
