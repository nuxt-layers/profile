/**
 * Public contract for the `@nuxt-layers/profile` capability.
 *
 * The only supported cross-layer import path for Profile's types and pure
 * helpers. It imports nothing but `zod`: no Nuxt, Vue, h3, server code,
 * driver, key service or other `@nuxt-layers/*` package.
 */

// Identifiers and safe names
export {
  correlationIdSchema,
  identifierSchema,
  instantSchema,
  reasonCodeSchema,
  REASON_CODE_PATTERN,
  UUID_PATTERN,
  UUID_V7_PATTERN,
} from '../shared/identifiers'
export type { SafeNameProblem, SafeNameResult } from '../shared/safe-names'
export { checkSafeName, SAFE_NAME_MAX_LENGTH, SAFE_NAME_PROBLEMS, safeNameSchema, scriptsOf } from '../shared/safe-names'

// The record
export type { ProfileAttribute, ProfileAttributes, ProfileChanges } from '../shared/attributes'
export {
  attributeSchemas,
  LOCALE_PATTERN,
  PHONE_NUMBER_PATTERN,
  PROFILE_ATTRIBUTES,
  profileAttributesSchema,
  profileChangesSchema,
  VERIFICATION_CLAIMS,
} from '../shared/attributes'

// Disclosure
export type {
  DepartureAttribution,
  DepartureFacts,
  DisclosureAudience,
  DisclosureContext,
  DisclosureInput,
  DisclosureSettings,
  DisplayName,
  DisplayNameSource,
  LookupPurpose,
  MembershipState,
  Relationship,
  SubjectStanding,
} from '../shared/disclosure'
export {
  chosenDisplayName,
  DEFAULT_DISCLOSURE_SETTINGS,
  DEPARTURE_ATTRIBUTIONS,
  disclosureContextSchema,
  disclosureSettingsSchema,
  MEMBERSHIP_STATES,
  standingInGroup,
  discloseAttributes,
  discloseDisplayName,
  DISCLOSURE_AUDIENCES,
  DISCLOSURE_MAX_SUBJECTS,
  DISPLAY_NAME_SOURCES,
  LOOKUP_PURPOSES,
  RELATIONSHIPS,
  SUBJECT_STANDINGS,
} from '../shared/disclosure'

// Events
export type { ProfileEvent, ProfileEventType } from '../shared/events'
export { IDENTITY_EVENTS_HANDLED, PROFILE_EVENT_PAYLOADS, PROFILE_EVENT_TYPES, profileEventSchema } from '../shared/events'

// HTTP API
export type { ProfileDepartureView, ProfileOwnView, ProfilePersonView, ProfileSubject } from '../shared/api'
export {
  disclosureRequestSchema,
  displayNamesRequestSchema,
  PROFILE_API_PREFIX,
  PROFILE_CORRELATION_HEADER,
  PROFILE_LOOKUP_RATE_LIMIT,
  PROFILE_STEP_UP_SECONDS,
  profileSubjectSchema,
  STEP_UP_ATTRIBUTES,
  updateProfileRequestSchema,
} from '../shared/api'

// Data-subject requests and legal holds
export type {
  CoordinatedPart,
  LegalHoldPart,
  LegalHoldView,
  OpenRequestInput,
  PartStatus,
  RequestOrigin,
  RequestPart,
  RequestPartView,
  RequestStatus,
  RequestType,
  RequestView,
  ProfileRetention,
  ProfileRetentionInput,
  ProfileRetentionSetting,
} from '../shared/requests'
export {
  COORDINATED_PARTS,
  DEFAULT_REQUEST_PARTS,
  LEGAL_HOLD_PARTS,
  legalHoldViewSchema,
  openRequestSchema,
  PART_STATUSES,
  PERSON_REQUEST_TYPES,
  personRequestSchema,
  placeHoldSchema,
  PROFILE_REQUEST_POLICY,
  PROFILE_RETENTION_BOUNDS,
  profileRetentionInputSchema,
  resolveProfileRetention,
  REQUEST_ORIGINS,
  REQUEST_PARTS,
  REQUEST_STATUSES,
  REQUEST_TYPES,
  requestDueAt,
  requestPartViewSchema,
  requestViewSchema,
  settlePartSchema,
} from '../shared/requests'

// Contact-detail verification
export type { VerifiableAttribute } from '../shared/verification'
export {
  confirmVerificationRequestSchema,
  PROFILE_VERIFICATION_POLICY,
  VERIFIABLE_ATTRIBUTES,
  VERIFICATION_CHANNELS,
  verificationCodeSchema,
} from '../shared/verification'

// Permissions (Authorisation's catalogue)
export type { ProfilePermissionDefinition } from '../shared/permissions'
export { PROFILE_PERMISSIONS, PROFILE_SUSPENDED_PEOPLE_PERMISSION } from '../shared/permissions'

// Errors
export type { ProfileErrorBody, ProfileErrorCode } from '../shared/errors'
export { isProfileErrorCode, PROFILE_ERROR_CODES, PROFILE_ERROR_STATUS, ProfileCompositionError, ProfileFailure } from '../shared/errors'

// Ports
export type {
  DirectoryReadOptions,
  IdentityEventLike,
  PostgresPoolLike,
  ProfileAccessDecision,
  ProfileClock,
  ProfileComposition,
  ProfileDatabase,
  ProfileDisclosureContextPort,
  ProfileEventPublisher,
  ProfileKeyWrapper,
  ProfileNotifier,
  ProfileRequestCoordinator,
  ProfileSubjectResolver,
  WrappedProfileKey,
} from '../shared/ports'
