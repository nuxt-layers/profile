import type {
  ClosureCommand,
  DepartureCommand,
  DisplayName,
  GroupDisposalCommand,
  GroupRenamedCommand,
  LegalHoldView,
  LookupPurpose,
  OpenRequestInput,
  PauseCommand,
  ProfileAttributes,
  ProfileCommandResult,
  ProfileDepartureView,
  ProfileEventPublisher,
  ProfileSubject,
  ProvisionCommand,
  RequestPart,
  RequestView,
  VerifiableAttribute,
} from '../../contracts'
import { ProfileFailure } from '../../contracts'
import type { DepartureExport, OwnProfile } from '../internal/service'
import { createService } from '../internal/service'
import {
  profileMigrationsDone,
  useProfileAccessDecision,
  useProfileClock,
  useProfileDatabase,
  useProfileDisclosureContext,
  useProfileKeyWrapper,
  useProfileNotifier,
  useProfileRetention,
  useProfileRequestCoordinator,
  useProfileRequestParts,
} from '../internal/composition'

/**
 * PUBLIC server functions (auto-imported for the host's server code). Each
 * takes the person (`subjectId`) or the viewer (`viewerId`) from the caller,
 * which must take it from the signed-in principal, never from a request
 * body. Every one fails closed with `ProfileFailure`. Every time they keep
 * or judge comes from the host's clock (`composeProfile`'s `clock`), or Clock's
 * system clock when none is supplied.
 */

async function service() {
  await profileMigrationsDone()
  const database = useProfileDatabase()
  return createService({
    pool: database.pool,
    schema: database.schema,
    keys: useProfileKeyWrapper(),
    disclosure: useProfileDisclosureContext,
    coordinator: useProfileRequestCoordinator,
    accessDecision: useProfileAccessDecision,
    notifier: useProfileNotifier,
    retention: useProfileRetention,
    requestParts: useProfileRequestParts,
    // Read at each use, so every time comes from the host's clock (or Clock's system clock).
    clock: useProfileClock,
  })
}

/** The person's own record and disclosure settings; null once erased. */
export async function getOwnProfile(input: { subjectId: string }): Promise<OwnProfile | null> {
  return (await service()).own(input)
}

/** The person changes their own attributes (a value sets, `null` removes). With `expectedVersion`, refuses (`conflict`) if the record changed since. */
export async function updateProfile(input: { subjectId: string, changes: unknown, correlationId: string, expectedVersion?: number }): Promise<OwnProfile> {
  return (await service()).update(input)
}

/** The person sets each attribute's audience, the name others see, and their departure choice. */
export async function setProfileDisclosure(input: { subjectId: string, settings: unknown, correlationId: string, expectedVersion?: number }): Promise<OwnProfile> {
  return (await service()).setDisclosure(input)
}

/** The person chooses to be shown as "Former member" in a group they left. */
export async function anonymiseProfileDeparture(input: { subjectId: string, groupId: string, correlationId: string }): Promise<void> {
  return (await service()).anonymiseDeparture(input)
}

/** Counts one lookup by the viewer against the rate limit; `rate-limited` once it is spent. */
export async function consumeProfileLookup(input: { viewerId: string }): Promise<void> {
  return (await service()).consumeLookup(input)
}

/**
 * Display names for up to 200 people as the viewer may see them, for
 * attribution, a listing, or a group's administration listing. The last
 * needs the group and the signed-in `subject` (the viewer), for the host's
 * access decision on naming suspended members.
 */
export async function lookupProfileDisplayNames(input: { viewerId: string, subjectIds: string[], groupId?: string | null, purpose: LookupPurpose, subject?: ProfileSubject }): Promise<{ subjectId: string, displayName: DisplayName }[]> {
  return (await service()).displayNames(input)
}

/** One person's profile as the viewer may see it now. */
export async function viewProfile(input: { viewerId: string, subjectId: string, groupId?: string | null }): Promise<{ subjectId: string, displayName: DisplayName, attributes: ProfileAttributes }> {
  return (await service()).view(input)
}

/** Profile's part of a data-subject export; null once erased. */
export async function exportProfileData(input: { subjectId: string }): Promise<{ attributes: ProfileAttributes, settings: OwnProfile['settings'], departures: DepartureExport[] } | null> {
  return (await service()).exportData(input)
}

// ---------------------------------------------------------------------------
// Commands (docs/contracts.md §9): the host maps its directory's events onto
// them. Each is idempotent by `commandId` (pass the event's own identifier)
// and answers `applied` or `duplicate`.
// ---------------------------------------------------------------------------

/** A person now exists: Profile creates their empty record and key. Call it for people only; never recreates an erased record. */
export async function provisionProfileRecord(input: ProvisionCommand): Promise<ProfileCommandResult> {
  return (await service()).provisionRecord(input)
}

/** The person's membership of a group ended at `endedAt`: Profile keeps how they are shown there. */
export async function recordProfileDeparture(input: DepartureCommand): Promise<ProfileCommandResult> {
  return (await service()).recordDeparture(input)
}

/** The person's account is closed: Profile erases the record, or keeps it unread while a legal hold covers Profile's part. */
export async function closeProfileSubject(input: ClosureCommand): Promise<ProfileCommandResult> {
  return (await service()).closeSubject(input)
}

/** The person paused their whole account: completes the directory part of their open restriction requests. */
export async function recordProfilePause(input: PauseCommand): Promise<ProfileCommandResult> {
  return (await service()).recordPause(input)
}

/** A group was renamed: completes the directory part of requests that named it, once all they name are renamed. */
export async function recordProfileGroupRenamed(input: GroupRenamedCommand): Promise<ProfileCommandResult> {
  return (await service()).recordGroupRenamed(input)
}

/** A deleted group's disposal is due (call it only then): Profile deletes what it keeps for the group, except held departures. */
export async function disposeProfileGroup(input: GroupDisposalCommand): Promise<ProfileCommandResult> {
  return (await service()).disposeGroup(input)
}

/** Erases a person's record and destroys their key, with a reason code. */
export async function eraseProfile(input: { identityId: string, reasonCode: string, correlationId: string }): Promise<boolean> {
  return (await service()).erase(input)
}

/** Maintenance: re-wraps keys still under an older wrapping-key version. */
export async function rewrapProfileKeys(input: { limit?: number } = {}): Promise<number> {
  return (await service()).rewrapKeys(input)
}

/** How many live keys each wrapping-key version still protects. */
export async function profileKeyVersionsInUse(): Promise<{ version: string, keys: number }[]> {
  return (await service()).keyVersionsInUse()
}

/** Publishes pending outbox events in order, through the host's publisher. */
export async function relayProfileOutbox(input: { publish: ProfileEventPublisher, limit?: number }): Promise<number> {
  return (await service()).relayOutbox(input)
}

/** The groups the person has left (identifiers, dates, whether they chose anonymity there). */
export async function listProfileDepartures(input: { subjectId: string }): Promise<ProfileDepartureView[]> {
  return (await service()).departures(input)
}

// ---------------------------------------------------------------------------
// Data-subject requests and legal holds (docs/contracts.md §14). Operators'
// functions are server-only: never expose them over HTTP.
// ---------------------------------------------------------------------------

/** Opens a data-subject request: the person's (access, restriction) or an operator's (any type, with a reason code). */
export async function openProfileRequest(input: OpenRequestInput): Promise<RequestView> {
  return (await service()).openRequest(input)
}

/** The person's requests, newest first. */
export async function listProfileRequests(input: { subjectId: string }): Promise<RequestView[]> {
  return (await service()).listRequests(input)
}

/** One request, for an operator; null when unknown. */
export async function getProfileRequest(input: { requestId: string }): Promise<RequestView | null> {
  return (await service()).getRequest(input)
}

/** The archive of the person's completed access request, while it lasts. */
export async function getProfileRequestArchive(input: { subjectId: string, requestId: string }) {
  return (await service()).archive(input)
}

/** An operator settles a part by hand: `done`, or `exempt` with a reason code. */
export async function settleProfileRequestPart(input: { requestId: string, part: RequestPart, outcome: 'done' | 'exempt', reasonCode?: string | null, correlationId: string }): Promise<RequestView> {
  return (await service()).settlePart(input)
}

/** The host's erasure of one of its declared parts (not the directory part) is done. */
export async function recordProfileRequestPart(input: { identityId: string, part: RequestPart, correlationId: string }): Promise<void> {
  return (await service()).recordRequestPart(input)
}

/** An operator places a legal hold on parts of a person's data. */
export async function placeProfileLegalHold(input: { identityId: string, parts: RequestPart[], reasonCode: string, endsAt: string, correlationId: string }): Promise<LegalHoldView> {
  return (await service()).placeHold(input)
}

/** An operator releases a legal hold before its end date. */
export async function releaseProfileLegalHold(input: { holdId: string, reasonCode: string, correlationId: string }): Promise<void> {
  return (await service()).releaseHold(input)
}

/** The parts under legal hold now, for the host's closure handling. */
export async function profileLegalHoldParts(identityId: string): Promise<RequestPart[]> {
  return (await service()).heldParts({ identityId })
}

/** A person's legal holds, current and past, for operators. */
export async function listProfileLegalHolds(input: { identityId: string }): Promise<LegalHoldView[]> {
  return (await service()).listHolds(input)
}

/** Maintenance for requests, holds and verification codes. Schedule it every few minutes. */
export async function runProfileMaintenance() {
  return (await service()).maintain()
}

/** One unit of scheduled work, in ADR-0012's shared shape. `every` is in seconds. */
export interface ProfileTask {
  name: string
  every: number
  run: () => Promise<unknown>
}

/**
 * PUBLIC. Profile's scheduled work (ADR-0012 §2), for the host's one
 * scheduler: maintenance every 300 seconds (ends holds, deletes expired
 * archives and codes, escalates and retries requests, applies retention).
 * `every` is the interval in seconds; a run that rejects should be retried
 * at the next interval. Key rotation (`rewrapProfileKeys`) is not periodic:
 * the host runs it after changing its wrapping-key version.
 */
export function profileTasks(): ProfileTask[] {
  return [{ name: 'profile.maintenance', every: 300, run: () => runProfileMaintenance() }]
}

// ---------------------------------------------------------------------------
// Contact-detail verification (docs/contracts.md §15)
// ---------------------------------------------------------------------------

/** Sends a verification code to the person's contact detail through the host's notifier. */
export async function startProfileContactVerification(input: { subjectId: string, attribute: VerifiableAttribute, correlationId: string }) {
  return (await service()).startVerification(input)
}

/** The person types back the code; the detail is verified until it changes. */
export async function confirmProfileContactVerification(input: { subjectId: string, attribute: VerifiableAttribute, code: string, correlationId: string }): Promise<OwnProfile> {
  return (await service()).confirmVerification(input)
}
