/**
 * The layer's own message catalogue (en-GB). Hosts change wording or add
 * locales in `app.config.ts`: `profile: { messages: { 'en-GB': { ... }, 'cy-GB': { ... } } }`.
 * `{name}` placeholders are replaced from the parameters passed to `t()`.
 */
export const PROFILE_MESSAGES_EN_GB = {
  // Shared
  'profile.common.cancel': 'Cancel',
  'profile.common.save': 'Save',
  'profile.common.signIn': 'Sign in',
  'profile.common.signInAgain': 'Sign in again',
  'profile.common.signInRequired': 'Sign in to see this page.',
  'profile.common.notSet': 'Not set',
  'profile.common.backToProfile': 'Back to your profile',

  // How a person is named, by the display name's kind
  'profile.person.hidden': 'Member',
  'profile.person.formerMember': 'Former member',
  'profile.person.pseudonym': 'Former member {number}',

  // Errors, by contract code
  'profile.error.unauthenticated': 'Sign in to continue.',
  'profile.error.forbidden': 'This is not available to you.',
  'profile.error.insufficient-assurance': 'For your security, sign in again to confirm it is you, then try again.',
  'profile.error.validation-failed': 'Some of the details are not valid. Check them and try again.',
  'profile.error.conflict': 'Your profile changed somewhere else. It has been reloaded: check it and try again.',
  'profile.error.rate-limited': 'Too many requests. Wait a minute and try again.',
  'profile.error.unavailable': 'Something went wrong. Try again later.',

  // Errors, by the problem behind a validation failure or conflict
  'profile.reason.empty': 'Enter a value, or clear the field to remove it.',
  'profile.reason.too-long': 'This is too long.',
  'profile.reason.forbidden-character': 'This contains a character that is not allowed.',
  'profile.reason.mixed-script': 'Use one writing system.',
  'profile.reason.invalid-locale': 'Enter a language tag, such as en-GB.',
  'profile.reason.invalid-time-zone': 'Choose a time zone from the list.',
  'profile.reason.invalid-email': 'Enter an email address, such as name@example.com.',
  'profile.reason.invalid-phone-number': 'Enter a telephone number in international format, such as +447700900123.',
  'profile.reason.version-changed': 'Your profile changed somewhere else. It has been reloaded: check it and try again.',
  'profile.reason.no-changes': 'There is nothing to save.',
  'profile.reason.invalid-code': 'Enter the 6-digit code from the message.',
  'profile.reason.wrong-code': 'That code is not right. Check the message and try again.',
  'profile.reason.code-expired': 'That code has expired or been used too many times. Send a new one.',
  'profile.reason.nothing-to-verify': 'Save the detail first, then verify it.',
  'profile.reason.invalid-attribute': 'Only a contact email or telephone number can be verified.',
  'profile.reason.not-for-person': 'You cannot ask for that here.',
  'profile.reason.group-required': 'Choose the group this is for.',

  // Attributes
  'profile.attribute.name': 'Full name',
  'profile.attribute.given_name': 'Given name',
  'profile.attribute.family_name': 'Family name',
  'profile.attribute.preferred_username': 'Nickname',
  'profile.attribute.locale': 'Language',
  'profile.attribute.zoneinfo': 'Time zone',
  'profile.attribute.email': 'Contact email',
  'profile.attribute.phone_number': 'Contact telephone',
  'profile.hint.locale': 'A language tag, such as en-GB or cy-GB.',
  'profile.hint.zoneinfo': 'Used to show times as you expect them.',
  'profile.hint.email': 'Separate from the address you sign in with.',
  'profile.hint.phone_number': 'In international format, such as +447700900123.',
  'profile.zoneinfo.none': 'No time zone',

  // Audiences
  'profile.audience.nobody': 'Only you',
  'profile.audience.group': 'People in your groups',
  'profile.audience.tenant': 'Everyone in your organisation',

  // Own profile
  'profile.own.title': 'Your profile',
  'profile.own.intro': 'You decide what is held about you here, and who may see it.',
  'profile.details.title': 'Your details',
  'profile.details.explained': 'Every detail is optional. Clear a field to remove it.',
  'profile.details.contactNotice': 'Nothing is sent to your contact details except a code to verify them, when you ask for one. Changing or verifying one needs a recent sign-in, and a changed detail must be verified again.',
  'profile.details.saved': 'Your details have been saved.',
  'profile.disclosure.title': 'Who can see your details',
  'profile.disclosure.explained': 'Choose who can see each detail. Nobody sees a detail you have not filled in.',
  'profile.disclosure.audiencesLegend': 'Who can see each detail',
  'profile.disclosure.displayNameLegend': 'The name others see',
  'profile.disclosure.displayNameExplained': 'Others see this name only if they can see that detail. Otherwise they see "Member".',
  'profile.disclosure.displayNameSource.name': 'Full name',
  'profile.disclosure.displayNameSource.preferred_username': 'Nickname',
  'profile.disclosure.displayNameSource.given_name': 'Given name',
  'profile.disclosure.departureLegend': 'When you leave a group',
  'profile.disclosure.anonymiseOnDeparture': 'Show me as "Former member" in every group I leave',
  'profile.disclosure.anonymiseOnDepartureHint': 'Otherwise each group decides: your name as it was, "Former member" with a number, or "Former member".',
  'profile.disclosure.saved': 'Your choices have been saved.',
  'profile.disclosure.departuresLink': 'Choose this for a group you have already left',
  'profile.export.title': 'Download your data',
  'profile.export.explained': 'A copy of everything this service holds about you in your profile, as a JSON file. It needs a recent sign-in.',
  'profile.export.download': 'Download my profile data',
  'profile.export.ready': 'Your download has started.',
  'profile.export.fileName': 'profile-data.json',
  'profile.export.requestsExplained': 'For a copy of everything every part of this service holds about you, or to restrict who sees your details:',
  'profile.export.requestsLink': 'Your requests about your data',

  // Contact-detail verification
  'profile.verification.verified': 'Verified',
  'profile.verification.unverified': 'Not verified',
  'profile.verification.send': 'Send a code to verify it',
  'profile.verification.resend': 'Send a new code',
  'profile.verification.sent.email': 'We have sent a 6-digit code to this email address. It lasts 10 minutes.',
  'profile.verification.sent.phone_number': 'We have sent a 6-digit code to this telephone number by text message. It lasts 10 minutes.',
  'profile.verification.codeLabel': 'Code',
  'profile.verification.confirm': 'Verify',

  // Groups the person has left
  'profile.group.unnamed': 'A group you left',
  'profile.departures.title': 'Groups you have left',
  'profile.departures.explained': 'Choose, for any group you have left, to be shown there as "Former member" from now on, whatever the group decided. This cannot be undone.',
  'profile.departures.none': 'You have not left any groups.',
  'profile.departures.left': 'Left on {date}',
  'profile.departures.anonymised': 'Shown as "Former member"',
  'profile.departures.action': 'Show me as "Former member" here',
  'profile.departures.confirm': 'This cannot be undone. Continue?',
  'profile.departures.confirmLabel': 'Confirm your choice',
  'profile.departures.confirmAction': 'Yes, show me as "Former member"',
  'profile.departures.done': 'Done. You are shown there as "Former member" from now on.',

  // Requests about the person's data
  'profile.requests.title': 'Your requests about your data',
  'profile.requests.explained': 'You can ask for a copy of everything this service holds about you, or restrict who sees your details. Each request is answered within a month.',
  'profile.requests.newTitle': 'Make a request',
  'profile.requests.accessExplained': 'A copy of everything held about you, from every part of the service, to download within 7 days of it being ready. It needs a recent sign-in.',
  'profile.requests.access': 'Ask for a copy of my data',
  'profile.requests.restrictionExplained': 'Hide every detail of yours from everyone else at once. You can share them again later.',
  'profile.requests.restriction': 'Restrict who sees my details',
  'profile.requests.deletionExplained': 'To have your data deleted, close your account.',
  'profile.requests.closeAccount': 'Close your account',
  'profile.requests.opened.access': 'Your request has been made. Your copy appears below when it is ready.',
  'profile.requests.opened.restriction': 'Your details are now hidden from everyone else.',
  'profile.requests.listTitle': 'Your requests',
  'profile.requests.none': 'You have not made any requests.',
  'profile.requests.openedAt': 'Made on',
  'profile.requests.dueAt': 'Due by',
  'profile.requests.download': 'Download my data',
  'profile.requests.availableUntil': 'Available until {date}',
  'profile.requests.dateInZone': '{date} ({zone} time)',
  'profile.requests.fileName': 'my-data.json',
  'profile.requests.type.access': 'A copy of your data',
  'profile.requests.type.correction': 'A correction',
  'profile.requests.type.erasure': 'Deleting your data',
  'profile.requests.type.restriction': 'A restriction',
  'profile.requests.status.open': 'In progress',
  'profile.requests.status.completed': 'Completed',
  'profile.requests.part.profile': 'Your profile',
  // The host's parts are worded by the host (`profile.requests.part.<name>`); this is the fallback.
  'profile.requests.part.other': 'Another part of your account',
  'profile.requests.partStatus.pending': 'In progress',
  'profile.requests.partStatus.done': 'Done',
  'profile.requests.partStatus.exempt': 'Refused, with a legal reason',
  'profile.requests.partStatus.held': 'Kept for a legal reason',

  // Another person's profile
  'profile.person.title': 'Profile',
  'profile.person.notAvailable': 'This profile is not available to you.',
  'profile.person.detailsTitle': 'Details',
  'profile.person.noDetails': 'They have not shared any other details with you.',
  'profile.person.contactNotice': 'A contact detail is verified only where it says so.',
} as const

export type ProfileMessageKey = keyof typeof PROFILE_MESSAGES_EN_GB
/** A host's wording: any of Profile's keys, and a name for each request part it declares. */
export type ProfileMessages = Partial<Record<ProfileMessageKey | `profile.requests.part.${string}`, string>>

export function formatMessage(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

/** Resolves a message for a locale: host override, then the en-GB default, then the key itself. */
export function resolveMessage(
  key: string,
  locale: string,
  overrides: Record<string, ProfileMessages | undefined> | undefined,
  params?: Record<string, string | number>,
): string {
  const template = overrides?.[locale]?.[key as keyof ProfileMessages]
    ?? (PROFILE_MESSAGES_EN_GB as Record<string, string>)[key]
    ?? key
  return formatMessage(template, params)
}
