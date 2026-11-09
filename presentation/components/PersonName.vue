<script setup lang="ts">
import type { DisplayName, LookupPurpose } from '../../contracts'

/**
 * PUBLIC. A person's name as Profile discloses it to the signed-in viewer,
 * for any page that names people by the directory's identifier. A host
 * backs its own person-name component with it, passing the identifier
 * through as `identityId` and the group in view as `groupId`.
 *
 * - `groupId`: the group the name is shown in, so a leaver is named under
 *   that group's departure data policy;
 * - `purpose`: `listing` (who is here now; a paused person is left out) or
 *   `attribution` (who did something; a paused person stays named);
 * - `link`: links a disclosed name to the person's profile page, when the
 *   page is on. Fallbacks ("Member", "Former member") never link.
 *
 * Until the name arrives, and when Profile shows nothing, it reads "Member",
 * the same whether or not the person exists.
 */
const props = withDefaults(defineProps<{
  identityId: string
  groupId?: string | null
  purpose?: LookupPurpose
  link?: boolean
}>(), { groupId: null, purpose: 'listing', link: false })

const { nameOf } = useProfileText()
const routes = useProfileRoutes()
const { displayName } = useProfileNames()
const name = ref<DisplayName>({ kind: 'hidden' })

onMounted(() => {
  watch(() => [props.identityId, props.groupId, props.purpose] as const, async ([identityId, groupId, purpose]) => {
    name.value = { kind: 'hidden' }
    const answer = await displayName(identityId, groupId, purpose)
    if (identityId === props.identityId && groupId === props.groupId && purpose === props.purpose) name.value = answer
  }, { immediate: true })
})

const label = computed(() => nameOf(name.value))
const href = computed(() => (props.link && name.value.kind === 'name' ? routes.person(props.identityId, props.groupId) : null))
</script>

<template>
  <NuxtLink v-if="href" :to="href" :class="profileClasses.link" :data-identity-id="identityId">{{ label }}</NuxtLink>
  <span v-else :data-identity-id="identityId">{{ label }}</span>
</template>
