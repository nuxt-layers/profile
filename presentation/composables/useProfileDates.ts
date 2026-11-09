/**
 * PUBLIC. Dates for the signed-in person, shown in their own time zone.
 *
 * A person's display time zone is their Profile `zoneinfo` (iam-integration
 * improvement register D4): Profile owns it, so its pages read it here. It is
 * read with the person's own record, through `useAsyncData` under the same
 * key as the profile page, so the server render and the browser use the same
 * zone and a page makes no second request. Without a zone (none set, one
 * Clock does not accept, or the record unavailable) dates use Clock's
 * configured `timeZone`. The zone changes only when the person changes it,
 * never from the device's. It is for display only: deadlines are shown in
 * the zone they were counted in (`deadlineOf`), named.
 */
export async function useProfileDates() {
  const profile = useProfile()
  const { locale, t } = useProfileText()
  const clock = useClock({ locale })
  const { data: me } = await useAsyncData('profile-me', () => profile.me())
  const timeZone = computed(() => {
    const zone = me.value?.attributes.zoneinfo
    return zone && clock.isValidTimeZone(zone) ? zone : undefined
  })
  const format = (instant: string, zone: string | undefined) =>
    clock.format(clock.parse('instant', instant), zone ? { dateStyle: 'long', timeZone: zone } : { dateStyle: 'long' })

  return {
    /** The person's zone, or undefined for Clock's configured one. */
    timeZone,
    /** A date in the person's zone. */
    dateOf: (instant: string) => format(instant, timeZone.value),
    /** A deadline on the day it falls in the zone it was counted in, naming that zone; in the person's zone if the name is not one Clock accepts. */
    deadlineOf: (instant: string, zone: string) => clock.isValidTimeZone(zone)
      ? t('profile.requests.dateInZone', { date: format(instant, zone), zone })
      : format(instant, timeZone.value),
  }
}
