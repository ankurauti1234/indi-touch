# Indi Meter v2: Flow, Screens, and Functionality

## Product Goal

Make Indi Meter a reliable, remote-first Raspberry Pi appliance with two deliberately separate experiences: installer operations and household use. The server owns accepted state transitions; the Pi remains useful offline, persists every important state change locally, and synchronizes it safely when connectivity returns.

This document is the proposed v2 specification. It extends the current application, which already has local Flask APIs, SQLite data, a partial onboarding flow, member/guest D-Bus events, and a Qt WebEngine shell. It is not a description of features already implemented.

## Product Principles

1. Every accepted state change becomes a durable event. The server validates and applies the operation; the device is an offline-first client and event buffer.
2. Remote control is the default input. Focus, selection, feedback, and recovery must work without a mouse or touchscreen.
3. Installer tools and household screens are separate roles and navigation contexts. Household users do not see technician operations.
4. Fail loudly, recover quietly: each failure has a clear message plus retry or a supported fallback, without losing valid progress.
5. Never trade privacy or data integrity for telemetry. Do not record secrets; do not silently discard important events.

## Onboarding v2

Show a persistent named step indicator and a **Need help?** action on every setup step. Help shows a non-secret support code, device ID, and configurable support phone number. Localize all setup, help, legal, and error text in English, Armenian, and Russian.

### 1. Language and Welcome

Choose English, Armenian, or Russian before setup begins. Then show the product identity, device ID, and **Start Setup**. Save language immediately so all subsequent screens and consent text use it.

### 2. Self-check

Run checks automatically before asking the installer to configure Wi-Fi. Show individually labeled pass/fail/pending rows for storage/database writable state, clock quality, HDMI/input, USB audio, GSM, and Wi-Fi radio. Mark each check **Required** or **Optional** by device model/configuration. Block only on defined hard failures; every blocked row explains the issue and offers a retry or supported fallback.

Check clock/NTP capability at this stage, then perform actual time synchronization after Network connects. Do not declare NTP synchronized while offline. Record a separate `selfcheck.result` for each check.

### 3. Network

Scan and display SSID, security, signal strength, and saved status. Support refresh and a **Join hidden network** path. Password entry has show/hide and remains masked by default. Display connection progress, then verify both internet access and reachability of the Indi Meter service. Show signal and measured latency after success; link-up alone is not success.

If connection or service reachability fails, show the exact safe reason and offer retry, rescan, or change network. Keep setup session and entered non-secret choices. Never log or emit the password or an unredacted SSID unless an explicit reviewed operational requirement exists.

### 4. Household Link

Accept the full Household ID or scan a QR code from the installer app/phone. Validate the identifier on the server. On a valid link request, show the household name in masked form, such as **Ar*** family**, and ask the installer to confirm it is the intended household before sending or verifying an OTP.

QR payloads should be short-lived and signed or exchanged for a one-time server token; do not place reusable credentials in the QR code or event stream.

### 5. OTP

Use four large digit boxes with auto-advance, paste support, and accessible focus. Show the masked destination returned by the server. Offer resend after a server-enforced 60-second countdown. Enforce five verification attempts followed by a 10-minute lockout on the server, not only in the UI. Return remaining attempts and retry-after duration without revealing whether an unrelated household/phone exists.

Emit `otp.sent`, `otp.verified`, `otp.failed`, and `otp.locked` outcomes without the OTP value, full phone number, or full household ID. Do not automatically retry a verification request with the same code after an ambiguous timeout unless the server supports idempotent verification.

### 6. Members and Location

Sync the household member list and save it locally before allowing confirmation. Show member names and avatars with permitted name edits, then ask the installer to confirm the roster. Select **Auto** location by default; allow a city choice or override if detection is inaccurate. Report member count and sync status.

Offer an optional remote placement test: prompt **Press OK on the remote** and show success only after receiving the configured select key. A failed optional test should offer retry/skip according to deployment policy.

### 7. Finish and Consent

Show a summary with masked household name, member count, meter/device ID, network name only if policy permits, app/software versions, and readiness status. Present data collection and privacy terms in the selected language. Record explicit acceptance as `consent.accepted` with the consent document/version, timestamp, and required device/session identifiers; do not infer acceptance from continuing.

After required consent and successful local commit, emit `onboarding.completed`, show **Ready**, and offer an optional three-slide household tutorial. Tutorial topics: declaring who is watching, adding/removing a guest, and notifications/settings. It must be skippable and replayable from household help.

### Resume and state rules

- Persist current step and validated progress locally in SQLite and on the server. On boot, reconcile both and resume at the last safe step with a visible **Setup resumed** state.
- State transitions are server-validated and versioned. Example states: `welcome`, `selfcheck`, `network_pending`, `network_ready`, `household_link_pending`, `otp_pending`, `otp_locked`, `members_pending`, `consent_pending`, `complete`, `retryable_error`, `needs_operator`.
- Re-check volatile conditions on resume (network, clock, hardware). Do not make an expired OTP or stale network check appear valid.
- Setup calls carry an idempotency key. Retried requests must not duplicate household association, member rows, consent, or completion events.
- `onboarding.completed` is emitted only after required checks pass, members are validated and committed, required consent is stored, and server/device state agree.
- Abandonment after more than 10 minutes of inactivity emits `onboarding.abandoned` once per session. Resume starts a new activity interval without duplicating the abandonment event.
- An offline device can preserve progress and show recovery state, but steps requiring server validation (household link, OTP, consent confirmation if remote-backed) cannot falsely succeed offline.

## Event and Sync Pipeline

### Source of truth and delivery

All UI actions call the local authenticated device API. The server validates the request, applies state, and writes the corresponding event to the SQLite outbox in the same database transaction. A background sender delivers batches to the event ingestion service; the UI reports **Saved on device / Sync pending** until acknowledged. The cloud is the system of record for centrally visible events after acceptance; the Pi remains the durable local state owner for operation during outages.

Use D-Bus only as a downstream transport/adapter where required by the existing collector. Do not treat a best-effort D-Bus signal as the durable event copy. The receiver deduplicates by `event_id` and acknowledges accepted batches. Record attempts, last error, next retry, and server acknowledgement. Preserve ordering per device/session where state order matters.

### Envelope

Use a documented, versioned envelope. Generate UUIDv7 `event_id` values when supported; retain a UUID-compatible fallback if the installed Python runtime does not provide UUIDv7. Server deduplication is mandatory.

```json
{
  "schema_version": 1,
  "event_id": "018f...",
  "meter_id": "IM-000123",
  "session_id": "onb-9c2e",
  "sequence": 12,
  "type": "onboarding.step_failed",
  "occurred_at": "2026-10-01T09:14:02.331Z",
  "sent_at": "2026-10-01T09:14:03.012Z",
  "monotonic_ms": 481223,
  "clock_quality": "synced",
  "app_version": "2.0.0",
  "payload": {
    "step": "wifi_password",
    "reason": "auth_failed",
    "attempt": 2,
    "duration_ms": 8120
  }
}
```

`occurred_at` is device wall-clock time; `sent_at` is sender time. Include monotonic time and clock quality so the server can order events and estimate clock drift. Store server `received_at` on ingestion. If wall clock is invalid, still capture the event with monotonic time and `clock_quality: "unsynced"`; flag it for correction rather than blocking event capture. Use UTC, bounded payload sizes, stable names, and explicit schema versions.

### Batching, retry, and storage limits

- Flush at 20 events or 10 seconds, whichever comes first; flush immediately for high-priority security, consent, and critical state transitions where practical.
- Retry transient failures with exponential backoff plus jitter. Persist the next retry time across reboot. Do not retry permanent validation/authentication failures indefinitely; flag them for operator action while retaining the event.
- Use a fixed database/storage budget with reserved capacity for critical events. Drop or coalesce only explicitly low-priority replaceable telemetry (for example, superseded UI-focus telemetry), never silently discard consent, onboarding, audience-state, security, or power events.
- When capacity is pressured, coalesce replaceable heartbeat samples, prune only acknowledged events according to retention policy, alert diagnostics, and apply backpressure before accepting non-critical events. Surface a critical storage-full failure if durable recording is impossible.
- Ensure payload encryption/permissions and bounded retention are appropriate for the data classification. Do not place secrets in the outbox.

### Event catalog

Emit events from server-side accepted state changes, not solely from client button presses. Use result events for outcomes and include safe reason codes, attempt number, duration, and retryability where relevant.

**Onboarding:** `onboarding.started`, `onboarding.step_entered`, `onboarding.step_completed`, `onboarding.step_failed`, `onboarding.abandoned`, `onboarding.completed`, `selfcheck.result`, `wifi.scan`, `wifi.connect_attempt`, `wifi.connect_result`, `household.link_attempt`, `otp.sent`, `otp.verified`, `otp.failed`, `otp.locked`, `members.synced`, `consent.accepted`.

**Operations:** `tv.state_changed`, `member.declared`, `member.undeclared`, `guest.added`, `guest.removed`, `prompt.shown`, `prompt.answered`, `prompt.timed_out`, `survey.shown`, `survey.answered`, `survey.skipped`, `settings.changed`, `power.reboot_requested`, `power.shutdown_requested`, `app.crashed`, `app.started`, `connectivity.lost`, `connectivity.restored`, and `heartbeat`.

Never include Wi-Fi passwords, OTPs, access tokens, PINs, full household IDs, full phone numbers, raw backend responses, or member birth dates in event payloads. Minimize names and study/audience details. Obtain consent for declared collection and review each event schema for purpose and retention.

Preserve compatibility with existing member/guest collector event types during rollout. Version the adapter mapping and validate old/new payloads before changing downstream contracts.

### Heartbeat and operator visibility

Send a heartbeat every 60 seconds with uptime, CPU temperature, memory/disk usage, Wi-Fi RSSI when available, app version, clock quality, and outbox depth. Alert centrally when no heartbeat arrives for five minutes, accounting for known offline periods and deployment policy.

Provide an onboarding operations dashboard with starts/completions, drop-off by step, median setup duration, retry/failure reason rates, OTP lockouts, and device health. Report installer success rates only when installers have authenticated, pseudonymous IDs; do not fingerprint installers or infer identities from household/device data. Support filtering by app version and deployment cohort.

Add a technician diagnostics view/API showing setup state, last successful step, health checks, connectivity, last sync, pending outbox count/age, latest safe error, app version, uptime, storage, and clock quality. Support a redacted diagnostic export and support code. Crash bundles must redact secrets and personal data before upload.

## Main Screens v2

### Home: Who's Watching

- Use large avatar tiles, a persistent remote focus ring, and unmistakable active/inactive text/icon state. Pressing OK toggles the focused member.
- Header status chip shows TV on/off, online/offline, last successful sync, and stale-data state.
- Bottom navigation: Guests, Notifications with unread badge, and Household Settings. Technician tools are never in household navigation.
- When TV is off, dim the member area, show clock and **Meter ready**, and keep declarations locked with a clear explanation.
- Support Red = Add Guest. Before Green/Yellow bulk actions ship, define exact semantics: the current model represents active members as watching, so **Everyone home** and **Nobody watching** are not interchangeable labels. Use a confirmation/undo pattern for bulk changes and emit per-state or documented bulk events.
- Provide clearly named **Everyone watching** and **Nobody watching** actions only if these match study semantics. Avoid relying on color alone; show labels/icons and handle remotes without colored keys.
- All state updates are saved locally and queued for sync. Show a discreet pending/offline banner when needed.

### Guests

- Replace exact-age entry as the primary remote flow with age brackets (kid, teen, adult, senior) and gender. Provide optional exact age only if the study requires it and privacy policy covers it.
- Set guest expiry to the end of the 2 AM cycle or manual end; display remaining time and expiry on each tile.
- Remove the arbitrary hard-coded nine-guest cap. Define the maximum in server/remote configuration based on study design; when reached, explain the limit and next action.
- Allow editing supported guest properties and manual end/removal, with validation on server and an undo opportunity for accidental removal.
- Use stable guest IDs and idempotent add/edit/remove requests; update event and UI only from the canonical server response (or local transaction when offline).

### Notifications and Surveys

- Group notifications into **Unread** and **Earlier** with loading, empty, offline, and retry states.
- Survey cards show reward/deadline only when supplied by authoritative survey data, plus expiry and completion state.
- Support single choice, multiple choice, rating, and free text according to the survey schema. Save an in-progress draft locally so a TV state change or view interruption does not erase it.
- Submit through the local API and durable outbox with an idempotency key. Queue `survey.answered` or `survey.skipped`; show pending/sent status and prevent duplicate submissions. Define encryption and retention for free-text answers.

### Prompts and Overlays

Use one reusable remote-first prompt with large focus targets, a countdown bar, one primary and one secondary action, spoken/visible state text, and accessible timeout feedback.

- **Who's watching?** can trigger on TV-on and after the configured gap since the last declaration. Enforce a configurable maximum prompts per hour and an acknowledgement cooldown.
- **Still watching?** uses the same component. Define a product-approved grace period. On timeout, auto-end only if that policy is enabled; make the consequence clear, save locally first, queue the state changes, and emit `prompt.timed_out` with `auto_ended: true`.
- Record shown, answered, dismissed, and timed-out outcomes without recording unnecessary personal content.

### Screensaver

Keep clock, weather, and watching-now content; add a compact online/sync state and freshness time. Support a configurable night dim level. Slowly drift the clock/content position to reduce burn-in, with bounds that keep all content readable and focus behavior unaffected. Test drift and dimming on the actual RPi display, since panel behavior varies.

## Settings v2 and Access Control

### Household Settings

Accessible to household users: Members (name/avatar), Avatar Style, Language, Display (theme, brightness, reduced animation), and Screen Timeout. Remote navigation is always enabled and is not a setting. Keep changes local-first, apply hardware settings, and report failure/rollback clearly.

### Technician Settings

Provide a clearly labeled technician entry point protected by a six-digit PIN/credential issued and rotated by the server. Replace triple-tap discovery. Apply server-side rate limits, lockout, role checks, audit logging, and short-lived credentials. For offline operation, define a secure, time-limited cached authorization policy; do not store a plaintext PIN or make sensitive access permanently available offline.

Technician-only actions: System Info, Connectivity Diagnostics, Re-run Self-check, Location Override, Screensaver Wallpaper, Reboot, Shutdown, Factory Reset, Unlink Household, and Export Logs. Audit successful and denied attempts with an authenticated pseudonymous `technician_id`; never log the PIN. Require explicit confirmation for destructive actions, and wipe household data on unlink/factory reset according to a documented retention policy.

Reboot and shutdown use a confirmation dialog and visible countdown with a Cancel action that remains available until execution begins. Emit `power.reboot_requested` or `power.shutdown_requested` only after the authorized action is accepted, with outcome events for completion/failure where measurable.

## Offline, Security, and Device Operations

### Offline-first behavior

- Show a persistent but unobtrusive **Offline, data saved; will sync** banner when connectivity is lost.
- After setup, household actions (member state, guest changes, survey draft/submission where policy allows, supported settings) continue locally and queue events. Do not present queued changes as server-acknowledged.
- Detect connectivity loss/restoration and emit `connectivity.lost` / `connectivity.restored` with outage duration, avoiding noisy duplicate transitions.
- On reconnect, drain the outbox in order where required, reconcile authoritative state, and clearly surface conflicts that cannot be merged automatically.

### Watchdog and crash recovery

Run the app under a systemd service with restart policy and health checks. On next start, emit `app.crashed` when a prior unclean exit is detected and include only redacted, bounded diagnostic references, not raw secrets or unrestricted log tails. Emit `app.started` with version and boot/session identifiers.

### OTA updates

Use a server-signed version manifest and verify signatures before install. Download in the background, apply during an approved quiet window (for example 4 AM while TV is off), and use an A/B or otherwise recoverable update mechanism. Roll back if the app fails health/heartbeat checks within five minutes after activation. Show an **Updated to vX** notification only after health checks pass.

### Remote configuration and diagnostics

Allow server configuration of prompt intervals, idle timeout, and feature flags through signed, versioned, expiring configuration with safe local defaults. Never execute arbitrary remote commands. Remote diagnostics may request a redacted log bundle or a self-check rerun; require authorization, audit the request/result, and avoid disrupting active household use.

### Time and security

Require NTP synchronization for cloud workflows that depend on trustworthy time. If clock drift is excessive, clearly flag it and block only actions whose security policy requires trusted wall time; continue recording events using monotonic timestamps. Do not block event capture.

Authenticate device API calls with a per-device certificate or signed, rotatable token; require TLS for remote endpoints. Keep local loopback UI/API boundaries explicit and protect any LAN-exposed routes. Rate-limit OTP/assignment attempts server-side. Rotate credentials and support revocation. CORS is not authentication.

### Privacy and accessibility

Show the data collection notice in the household's chosen language before completion and record versioned `consent.accepted`. Minimize event data and retention, especially household identifiers, member attributes, location, and survey free text.

Use at least 24 CSS px for essential TV-distance content where layout permits, high contrast, visible focus, plain language, and text/icon state in addition to color. Test with the actual screen size/distance and remote. Support keyboard and touch as secondary inputs without making either required.

## Server and Data Requirements

1. Add SQLite schema migrations for onboarding sessions/state, event outbox, delivery attempts/acks, consent records, survey responses/drafts as appropriate, and sync status.
2. Add authenticated APIs for state transitions/progress, event batch ingestion, survey submission, diagnostics, technician authorization/actions, remote configuration, and OTA metadata.
3. Atomically commit each local state change and its outbox event. Use constraints and transactions to prevent duplicate state transitions and duplicate submissions.
4. Add server-side idempotency/deduplication keyed by `event_id`; return per-event acknowledgement/rejection and retry guidance.
5. Validate cloud responses before local commit. In particular, failed, empty-when-not-allowed, or malformed member sync must never mark onboarding complete.
6. Remove secret-bearing logs (the current OTP logging must be eliminated). Use structured logs with request IDs, safe error codes, durations, and redaction tests.
7. Make cloud calls time-bounded and classify transient, permanent, authorization, validation, and malformed-response errors. Retry transient operations safely; never blindly retry OTP verification or destructive actions.
8. Add health/readiness endpoints, schema migration backup/rollback, database/disk alarms, and startup reconciliation for incomplete onboarding and pending events.
9. Keep the existing member/guest collector contract compatible through a tested adapter until downstream services migrate.
