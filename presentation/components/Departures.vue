<script setup lang="ts">
import type { ProfileDepartureView } from '../../contracts'

/**
 * PUBLIC. The groups the person has left, and the choice, for each, to be
 * shown there as "Former member" from now on. The group's name comes from
 * `ProfileGroupName`, which the host backs with its directory's
 * names. The choice
 * cannot be undone, so it asks for confirmation first.
 */
const profile = useProfile()
const action = useProfileAction()
const { t, locale } = useProfileText()
const routes = useProfileRoutes()
const notice = ref<string | null>(null)
const confirming = ref<string | null>(null)

const { data, error, refresh } = await useAsyncData('profile-departures', () => profile.departures())
const failure = computed(() => (error.value ? profileErrorOf(error.value)?.code ?? 'unavailable' : null))
const departures = computed<ProfileDepartureView[]>(() => data.value?.departures ?? [])
const dateOf = (instant: string) => new Date(instant).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })

async function anonymise(groupId: string) {
  notice.value = null
  const done = await action.run(() => profile.anonymiseDeparture(groupId))
  confirming.value = null
  if (done) {
    notice.value = t('profile.departures.done')
    await refresh()
  }
}
</script>

<template>
  <div :class="profileClasses.stack">
    <p :class="profileClasses.text">{{ t('profile.departures.explained') }}</p>
    <ProfileUnavailable v-if="failure" :code="failure" />
    <template v-else>
      <ProfileAlert v-if="action.error.value" tone="error">{{ action.error.value }}</ProfileAlert>
      <ProfileAlert v-if="notice" tone="success" :focus-on-mount="false">{{ notice }}</ProfileAlert>
      <p v-if="departures.length === 0" :class="profileClasses.muted">{{ t('profile.departures.none') }}</p>
      <ul v-else :class="profileClasses.list">
        <li v-for="departure in departures" :key="departure.groupId" :class="profileClasses.listItem">
          <div>
            <p :class="profileClasses.text"><ProfileGroupName :group-id="departure.groupId" /></p>
            <p :class="profileClasses.muted">{{ t('profile.departures.left', { date: dateOf(departure.endedAt) }) }}</p>
          </div>
          <span v-if="departure.anonymised" :class="profileClasses.badge">{{ t('profile.departures.anonymised') }}</span>
          <div v-else-if="confirming === departure.groupId" :class="profileClasses.row" role="group" :aria-label="t('profile.departures.confirmLabel')">
            <p :class="profileClasses.hint">{{ t('profile.departures.confirm') }}</p>
            <button type="button" :class="profileClasses.primaryButton" :disabled="action.disabled.value" @click="anonymise(departure.groupId)">{{ t('profile.departures.confirmAction') }}</button>
            <button type="button" :class="profileClasses.secondaryButton" :disabled="action.disabled.value" @click="confirming = null">{{ t('profile.common.cancel') }}</button>
          </div>
          <button v-else type="button" :class="profileClasses.secondaryButton" :disabled="action.disabled.value" @click="confirming = departure.groupId">{{ t('profile.departures.action') }}</button>
        </li>
      </ul>
    </template>
    <p v-if="routes.profile()"><NuxtLink :to="routes.profile()!" :class="profileClasses.actionLink">{{ t('profile.common.backToProfile') }}</NuxtLink></p>
  </div>
</template>
