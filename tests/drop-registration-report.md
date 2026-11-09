# Public Drop Registration: Local Handoff

Date: 2026-11-08. LOCAL ONLY. No commit, push, production SQL, production data writes, publish or dependency changes.

## Integration Contract

Public URL: `/cadastrar-drop`.
Authenticated review URL: `/cadastros/pre-cadastros`.
Server endpoint: `/api/drop-registration`.

Exports:

- `src/PublicDropRegistration.tsx`: default `PublicDropRegistration`; named `DropRegistrationFields`, `DROP_REGISTRATION_PATH`.
- `src/DropRegistrationReview.tsx`: default `DropRegistrationReview`; named `DropRegistrationLinkActions`, `DROP_REGISTRATION_REVIEW_PATH`.
- Review props: `onApproved?: (dropId: string) => void`, `onOpenDrop?: (dropId: string) => void`. Both optional. `onApproved` is for refreshing the list, not activation.
- Link actions props: `includeReviewLink?: boolean`, default `true`. Provides copy, public form, WhatsApp URL sharing and review navigation. Hidden for unauthorized/inactive profiles.
- Components import their own scoped CSS and DM Sans. No Leaflet dependency. The public form uses device-width and restores the previous viewport on unmount, falling back to `width=980`; authenticated review preserves the existing panel viewport. Review inline-size containment keeps table scrolling local.
- Server-only file validation lives in `src/dropRegistrationFiles.ts`. The API does not depend on the older `server/drop-registration-files.ts` file; that pre-existing out-of-scope file was left untouched.

Root imports, to be integrated by the main owner:

```tsx
const PublicDropRegistration = lazy(() => import('./PublicDropRegistration'))
const DropRegistrationReview = lazy(() => import('./DropRegistrationReview'))
```

Inside `App()`, after its hooks but BEFORE `if (checking)` and `if (!logged)`, alongside `/enviar-nf`:

```tsx
if (location.pathname.replace(/\/+$/, '') === '/cadastrar-drop') {
  return <Suspense fallback={<main>Carregando...</main>}>
    <PublicDropRegistration />
  </Suspense>
}
```

Inside authenticated `Routes` under the EXISTING `AccessProvider`:

```tsx
<Route path="/cadastros/pre-cadastros" element={
  <Suspense fallback={<main>Carregando...</main>}>
    <DropRegistrationReview />
  </Suspense>
} />
```

In the cadastro list toolbar:

```tsx
import { DropRegistrationLinkActions } from './DropRegistrationReview'

<DropRegistrationLinkActions />
```

The review component enforces its own permission gate; do NOT invent `cadastros_manage` or wrap it only with `cadastros_view`. Actual schema: active `user_profiles` with `role='admin'`, OR both `user_module_permissions.cadastros_create=true` AND `cadastros_edit=true`. The server verifies the bearer user with `auth.getUser(token)`, derives the actor ID itself, and the database rechecks that trusted actor with profile/permission row locks during approval. Public or authenticated callers cannot execute mutation RPCs, even if they supply a reviewer ID. No permission grants or new module permission were added.

`App.tsx`, `CadastrosLista.tsx`, package files, README, docs and finanças files were not edited by this implementation. Their integration and the final full build remain with the main owner.

## Data Lifecycle

1. Public self-entered contact, address, legal identity, PIX holder, explicit location and 1-3 photos are validated into a fixed whitelist. Unknown fields are rejected, not injected into a Drop. CPF/CNPJ/email/PIX and neighborhood are optional; documents are checksum-validated and PIX accepts a valid document, telephone, email or UUID v4 when supplied. Required: Drop name, responsible person, phone, street, number, municipality, Brazilian UF, CEP and latitude/longitude.
2. No public lookup, directory, GET receipt query, photo download or direct `drops` write exists. Public success returns ONLY `{status:'pending', protocol:clientUUID}`. Approved/rejected receipt retries still return the same generic public result, not review information.
3. UUID v4 is stable during retries. The browser stores only that UUID in session storage, never form data/photos. Once a request starts, the current payload is frozen for retry. A new protocol requires explicit confirmation after an uncertain submission. Reopening the browser does not restore personal data; the same original values/photos/captions must be re-entered for an unfinished protocol.
4. `drop_registration_reserve` serializes daily UTC quotas in its own `drop_registration_limits`: 20 attempts per HMAC IP/day and 500 global/day, including retries. Raw IP is never stored. Platform forwarded IP is hashed with server service key and a feature/day namespace. Limits are not shared with invoice intake.
5. Intake starts `uploading`. Immutable random UUID paths in `drop-registration-private` are uploaded without overwrite. EVERY file is downloaded and its size, SHA-256, type and dimensions rechecked before finalization. SQL also checks private storage metadata. Upload/confirmation failures return HTTP 202 `uploading` with an explicit error and preserved protocol, never a false success. Authenticated reviewers can reconcile complete stored files.
6. Public consent is mandatory and stored as `consent_version='drop-registration-v1'` plus `consented_at` server timestamp. Original snapshot/photos remain unchanged; reviewer edits go into `review_snapshot` with revision, reviewer and timestamp.
7. Review supports editing/saving, duplicate inspection, explicit duplicate acknowledgment, approval, rejection with reason, private photo preview and incomplete-file reconciliation. Stale revision rejects a write; refresh before retrying uncertain edits. Saved review does not create a Drop.
8. Duplicate candidates match normalized CPF/CNPJ OR normalized name+municipality+street+number. No global document uniqueness is imposed: different people/addresses remain possible. Acknowledgment is bound to the current matching records and their timestamps; edits or changed candidates require a fresh check. Approval recomputes under a short table lock. Existing drop duplicate triggers remain unchanged.
9. Approval uses the server service client only, with an `actor_id` derived from the verified bearer token, never from request data. `drop_registration_authorize`, `drop_registration_duplicates`, `drop_registration_review`, reserve and finalize are service-only RPCs; PUBLIC/anon/authenticated execution grants are revoked. A transaction locks the submission, validates the whitelist, creates ONE Drop, links `approved_drop_id` uniquely and inserts an audit. Approval retry returns the saved Drop ID even with the original revision; it does not create another Drop. A now-inactive or unauthorized reviewer is rejected before that idempotent response.
10. Resulting Drop: `registration_type='drop_off'`, actual allowed `status='INTERESSADO'`, `is_active=true` (non-soft-deleted, NOT operational activation), operation start/end NULL, signed/terminated dates NULL, monthly value NULL. Deactivation metadata remains NULL. `start_period`/`end_period` retain their existing NULL defaults. No financial tables, contracts, `drop_documents`, existing rows, permissions or guards are changed. There is NO `visited` field in the current repository schema, and none was invented.

IMPORTANT: the new Drop exists in the real `drops` list only AFTER approval. It remains visible to queries requiring `is_active=true`; choose the existing INTERESSADO/all-status filter because the default ATIVO filter excludes it by status. Do not automatically open/save the legacy cadastro editor or use `onApproved` for activation. This task did not change that editor or the meaning of operational statuses.

## Images And Privacy

- JPEG, PNG and static WebP only; SVG, URL input, malformed/truncated headers/chunks, missing image payloads, duplicate photo content and animated PNG/WebP are rejected.
- Max three photos, each <= 2 MiB, total decoded bytes <= 2 MiB. Entire JSON body <= 4,500,000 bytes (4.5 MB); the decoded photo limit remains independently enforced. Text/legend lengths are bounded.
- Server checks raster signatures and actual header dimensions: 1-8192 per side and <=16 megapixels. This is structural validation, NOT a full codec decode, antivirus or identity verification.
- The normal browser path fully decodes with `createImageBitmap`, downsizes to 1600 px longest side, and re-encodes JPEG through canvas. It does not read EXIF coordinates and strips source metadata during re-encoding. Manual latitude/longitude is always available when geolocation is unavailable or denied. No default/fake coordinates are supplied. Accepted geographic bounds are the existing map convention: latitude -35..6, longitude -75..-32, not a sovereign-border polygon/geocoding proof.
- Private bucket is isolated with a restrictive storage policy for BOTH anon and authenticated roles, defeating old permissive storage policies for this bucket while preserving other buckets. Anon has no intake/quota grants. Authenticated users get SELECT on intake only through an RLS predicate requiring the exact active reviewer permissions; no direct writes or quota access. Only server service code handles storage. The only authenticated helper grant is the read-only, no-argument RLS predicate `drop_registration_can_read()`.
- Authenticated manager photo URLs expire in 60 seconds. They are bearer access URLs for the specifically requested photo, not storage credentials. Already downloaded image bytes cannot be revoked from a client.

## Manual SQL And Server Configuration

Apply ONLY `supabase/migrations/20261108140000_public_drop_registration.sql` manually after the existing cadastro schema, module permissions and current operation guards are present. It preflights every inserted Drop column and the existing duplicate trigger, and aborts rather than modifying missing legacy schema. It is repeatable and transactional. Do NOT reapply unrelated old backfill migrations.

Required server environment: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, matching the existing financial API. No new environment variable or anon-key requirement. The service client verifies the incoming user token, then supplies only the resulting user ID to protected RPCs. Never add a service/secret key to a `VITE_*` variable. No environment values are returned by the endpoint.

No SQL was executed outside PGlite. Actual Supabase policies, hosted Storage behavior and Vercel deployment remain unverified until authorized staging acceptance. Vite does not execute this serverless endpoint by itself.

Rollback: first remove/disable the newly integrated routes and link actions in the main integration, then manually execute `tests/drop-registration-rollback.sql`. It revokes the new public-intake and review mutation service RPCs. It deliberately keeps intake/photos, linked Drops, audit, authorized read-only access and restrictive private policies. It does not delete or reactivate any business record. Reapplying the new migration restores its RPC grants. No destructive down migration is provided.

## Local Verification

```powershell
node --test --test-concurrency=1 tests/drop-registration-shared.test.mjs tests/drop-registration-api.test.mjs tests/drop-registration-database.test.mjs tests/drop-registration-browser.test.mjs
```

Result: 5 tests PASS. SQL uses PGlite with actual base schema, actual permission columns and the existing operation guard. API calls use synthetic Supabase transport only. Browser runs actual components and the actual new API over that transport with external network blocked.

Covered: unauthorized/anon reads and direct client write/storage denial despite a broad legacy storage policy; authorized authenticated reads; inactive/delegated permissions and forged actor rejection; quota exhaustion; optional/invalid PIX, documents and coordinates; extra guard-field rejection; malformed/oversized photos and 4.5 MB body; pending vs incomplete; stored-byte/hash confirmation including tampering; response lost AFTER server confirmation; same UUID retry with case normalization and changed filename rejection; stale review; changed duplicate acknowledgment; repeated approval without a second Drop; INTERESSADO + is_active=true without operation dates or finance/document creation; conservative rollback preserving data; geolocation only on click; denied-geolocation manual coordinates; photo decoding/re-encoding; real signed-photo display; real WebP payload; mobile 360/390 and desktop 1440; viewport restored to 980; no page JavaScript errors.

Focused TypeScript command (no full build):

```powershell
node_modules/.bin/tsc --noEmit --skipLibCheck --strict --target ES2022 --lib ES2022,DOM,DOM.Iterable --module ESNext --moduleResolution Bundler --jsx react-jsx --esModuleInterop src/PublicDropRegistration.tsx src/DropRegistrationReview.tsx src/dropRegistrationFiles.ts api/drop-registration.ts
```

Screenshots in ignored `tmp/drop-registration/screenshots/`: public-form-360, public-photo-mobile, public-receipt-mobile, review-mobile, review-desktop. Actual form/photo/mobile review screenshots were visually inspected. Editor diagnostics: no errors in the new TS/TSX modules.

Synthetic local preview, without accessing any production service:

```powershell
node tests/drop-registration-harness.mjs --preview
```

It prints loopback URLs for `/cadastrar-drop` and `/review` on an available port. `/review` is a TEST HARNESS URL, not the integration route. Data is synthetic and in-memory only; the preview is not a production backend or database migration verification.

Remaining acceptance: main route/list integration and full build; manual migration; real hosted Supabase/Storage and Vercel acceptance; real mobile camera/Safari and actual concurrent users. PGlite verifies lock/revision/idempotency logic by serialized adversarial cases, not a live multi-connection load test. Abuse protection is quota-based, not CAPTCHA/WAF. No automatic retention/deletion job was introduced for personal data or incomplete uploads; agree a retention policy before public deployment. Consent text is operational acknowledgment, not a claim of legal compliance.