# Storage Register

> **In short:** the persistent storage Profile owns or causes. All of it is in the host's PostgreSQL database, in Profile's own schema; the layer sets no cookies and uses no browser storage.

| Store | Purpose | Contents | Essential | Retention | Controls |
|---|---|---|---|---|---|
| `subject_key` | Each person's data key | The key, wrapped by the host's `ProfileKeyWrapper`, and its wrapping-key version | Yes | Until erasure | Never stored unwrapped; re-wrapped on rotation; deleted on erasure |
| `record` | The person's attributes and disclosure settings | Values encrypted with the person's key, bound to identity and purpose; audiences; version | Yes | Until erasure (a legal hold defers it) | Per-person encryption; read by no function while a closed record is held |
| `departure`, `pseudonym_counter` | How a leaver is shown in a group | Encrypted kept name or pseudonym number, policy, dates | Yes | Until erasure or the group's disposal | Per-person encryption |
| `erased` | Never re-creating an erased person | Identifier, reason code, time | Yes | Indefinitely | Identifiers and codes only |
| `processed_event` | Idempotent event handling | Event identifiers | Yes | Indefinitely | Identifiers only |
| `outbox` | Events awaiting relay | Event type and payload: identifiers, attribute names, codes | Yes | Delivered events: `outboxDays` (default 30) | No values |
| `lookup_window` | Lookup rate limit | Viewer identifier, window, count | Yes | Current window | Identifiers only |
| `request`, `request_part`, `request_group` | Data-subject requests | Identifiers, types, codes, times; access archives sealed with the person's key | Yes | Completed: `requestDays` (default 730); archives 7 days | Deleted only by the owner's `apply_retention` |
| `legal_hold`, `closed_identity`, `held_closure` | Legal holds deferring erasure | Identifiers, parts, reason codes, dates | Yes | Ended holds: `endedHoldDays` (default 365) | Deleted only by the owner's `apply_retention` |
| `contact_verification` | Pending contact-detail verification | Keyed digest of the code bound to identity, attribute and value; attempts; expiry | Only for verification | 10 minutes | Code never stored; destroyed with the key |
| `schema_migration` | Applied migrations | Migration identifiers | Yes | Indefinitely | Owner role only |

The browser keeps looked-up display names in memory for at most a minute (`useProfileNames()`); nothing persists after the page is closed.
