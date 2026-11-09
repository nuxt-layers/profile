<script setup lang="ts">
/**
 * PUBLIC. A group's name on the person's own pages. Group names belong to
 * the host's directory: Profile holds none, so this reads "A group you
 * left". A host backs it with a component of the same name that shows the
 * name its directory gives the group, so Profile imports nothing of the
 * host's.
 */
defineProps<{ groupId: string }>()
const { t } = useProfileText()
</script>

<template>
  <span :data-group-id="groupId">{{ t('profile.group.unnamed') }}</span>
</template>
