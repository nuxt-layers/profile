<script setup lang="ts">
import type { ProfileAttribute, ProfileChanges, ProfileOwnView } from '../../contracts'
import { attributeSchemas, PROFILE_ATTRIBUTES, STEP_UP_ATTRIBUTES, VERIFIABLE_ATTRIBUTES } from '../../contracts'

/**
 * PUBLIC. The person's own details, as a form. Each field is checked with
 * the contract's own rules before sending, and the server checks again.
 * Only changed fields are sent, against the version shown, so another tab's
 * edit is never silently undone. Emits `updated` with the new view, and
 * `reload` when the record changed elsewhere.
 */
const props = defineProps<{ me: ProfileOwnView }>()
const emit = defineEmits<{ updated: [view: ProfileOwnView], reload: [] }>()

const profile = useProfile()
const action = useProfileAction()
const { t } = action
const notice = ref<string | null>(null)
const problems = ref<Partial<Record<ProfileAttribute, string>>>({})
const fields: Partial<Record<ProfileAttribute, HTMLElement>> = {}
const bind = (key: ProfileAttribute) => (element: unknown) => {
  if (element instanceof HTMLElement) fields[key] = element
}

const draft = ref<Record<ProfileAttribute, string>>(blank())
function blank(): Record<ProfileAttribute, string> {
  return Object.fromEntries(PROFILE_ATTRIBUTES.map(key => [key, props.me.attributes[key] ?? ''])) as Record<ProfileAttribute, string>
}
watch(() => props.me, () => { draft.value = blank() })

// Zones through Clock (Layer Standard §5): a fixed list, the same on the server and in every browser, so it renders during SSR.
const clock = useClock()
const timeZones = clock.timeZones()
// A stored zone the list leaves out (a link such as Europe/Kiev, or one stored before Clock checked spelling) stays selectable, so it is never silently changed.
const zoneOptions = computed(() => {
  const current = props.me.attributes.zoneinfo
  return current && !timeZones.includes(current) ? [current, ...timeZones] : timeZones
})

const autocomplete: Record<ProfileAttribute, string> = {
  name: 'name',
  given_name: 'given-name',
  family_name: 'family-name',
  preferred_username: 'nickname',
  locale: 'language',
  zoneinfo: 'off',
  email: 'email',
  phone_number: 'tel',
}
const inputType: Partial<Record<ProfileAttribute, string>> = { email: 'email', phone_number: 'tel' }
const hasHint = (key: ProfileAttribute) => ['locale', 'zoneinfo', 'email', 'phone_number'].includes(key)
const describedBy = (key: ProfileAttribute) => [hasHint(key) ? `profile-hint-${key}` : '', problems.value[key] ? `profile-problem-${key}` : ''].filter(Boolean).join(' ') || undefined

const messageOf = (code: string | undefined) => {
  const text = code ? t(`profile.reason.${code}`) : ''
  return text && !text.startsWith('profile.reason.') ? text : t('profile.error.validation-failed')
}

/** The changed fields, checked with the contract's rules; null when a field is invalid. */
function changes(): ProfileChanges | null {
  const found: Record<string, string | null> = {}
  const invalid: Partial<Record<ProfileAttribute, string>> = {}
  for (const key of PROFILE_ATTRIBUTES) {
    const value = draft.value[key].trim()
    const stored = props.me.attributes[key]
    if (value === '') {
      if (stored !== undefined) found[key] = null
      continue
    }
    const parsed = attributeSchemas[key].safeParse(value)
    if (!parsed.success) {
      invalid[key] = messageOf(parsed.error.issues[0]?.message)
      continue
    }
    if (parsed.data === stored) continue
    // The contract checks a zone's shape only; Clock decides whether it exists, spelt exactly.
    if (key === 'zoneinfo' && !clock.isValidTimeZone(parsed.data)) {
      invalid[key] = messageOf('invalid-time-zone')
      continue
    }
    found[key] = parsed.data
  }
  problems.value = invalid
  return Object.keys(invalid).length > 0 ? null : found as ProfileChanges
}

async function save() {
  notice.value = null
  action.error.value = null
  const changed = changes()
  if (changed === null) {
    const first = PROFILE_ATTRIBUTES.find(key => problems.value[key])
    if (first) fields[first]?.focus()
    return
  }
  if (Object.keys(changed).length === 0) {
    notice.value = t('profile.reason.no-changes')
    return
  }
  const view = await action.run(() => profile.update(props.me.version, changed))
  if (view) {
    notice.value = t('profile.details.saved')
    emit('updated', view)
  }
  else if (action.code.value === 'conflict') {
    emit('reload')
  }
}

/** A saved contact detail, unchanged in the form, can be verified. */
const verifiable = (key: ProfileAttribute) => (VERIFIABLE_ATTRIBUTES as readonly string[]).includes(key)
  && props.me.attributes[key] !== undefined && draft.value[key].trim() === props.me.attributes[key]

const touchesContact = computed(() => STEP_UP_ATTRIBUTES.some(key => draft.value[key].trim() !== (props.me.attributes[key] ?? '')))
</script>

<template>
  <section aria-labelledby="profile-details-title">
    <h2 id="profile-details-title" :class="profileClasses.sectionTitle">{{ t('profile.details.title') }}</h2>
    <p :class="profileClasses.text">{{ t('profile.details.explained') }}</p>
    <form :class="profileClasses.stack" class="mt-4" novalidate @submit.prevent="save">
      <ProfileAlert v-if="action.error.value" tone="error">
        <p>{{ action.error.value }}</p>
        <p v-if="action.code.value === 'insufficient-assurance'" class="mt-2"><ProfileSignInLink again /></p>
      </ProfileAlert>
      <ProfileAlert v-if="notice" tone="success" :focus-on-mount="false">{{ notice }}</ProfileAlert>

      <div v-for="key in PROFILE_ATTRIBUTES" :key="key">
        <label :for="`profile-field-${key}`" :class="profileClasses.label">{{ t(`profile.attribute.${key}`) }}</label>
        <select
          v-if="key === 'zoneinfo'"
          :id="`profile-field-${key}`"
          :ref="bind(key)"
          v-model="draft[key]"
          :class="profileClasses.select"
          :aria-invalid="problems[key] ? 'true' : undefined"
          :aria-describedby="describedBy(key)"
        >
          <option value="">{{ t('profile.zoneinfo.none') }}</option>
          <option v-for="zone in zoneOptions" :key="zone" :value="zone">{{ zone }}</option>
        </select>
        <input
          v-else
          :id="`profile-field-${key}`"
          :ref="bind(key)"
          v-model="draft[key]"
          :type="inputType[key] ?? 'text'"
          :autocomplete="autocomplete[key]"
          :class="profileClasses.input"
          :aria-invalid="problems[key] ? 'true' : undefined"
          :aria-describedby="describedBy(key)"
        >
        <p v-if="hasHint(key)" :id="`profile-hint-${key}`" :class="profileClasses.hint">{{ t(`profile.hint.${key}`) }}</p>
        <p v-if="problems[key]" :id="`profile-problem-${key}`" :class="profileClasses.fieldError">{{ problems[key] }}</p>
        <ProfileContactVerification v-if="verifiable(key)" :me="me" :attribute="key as 'email' | 'phone_number'" @updated="view => emit('updated', view)" />
      </div>

      <ProfileAlert :tone="touchesContact ? 'warning' : 'info'" :focus-on-mount="false">
        <p>{{ t('profile.details.contactNotice') }}</p>
      </ProfileAlert>
      <div :class="profileClasses.row">
        <button type="submit" :class="profileClasses.primaryButton" :disabled="action.disabled.value">{{ t('profile.common.save') }}</button>
      </div>
    </form>
  </section>
</template>
