# OAuth renewal implementation plan

Goal: apply the user's approved 24-hour access lifetime and make renewable connections work when a client omits offline_access.

Approach: keep the existing Cloudflare provider and fixed 35-day grant. Add offline_access to the browser-bound authorization request before rendering consent; show the renewal duration explicitly. The owner approves it with the other scopes. Do not grant any additional Agendor capability. Direct grants without offline consent still receive no refresh token.

## Task 1: renewable browser consent and access lifetime

- [x] Add a browser-flow regression that requests only crm:read, verifies explicit renewal consent, exchanges the code, and receives a refresh token and expires_in=86400.
- [x] Verify expired access is rejected, refresh succeeds without another upstream login, replacement refresh tokens work, and cross-client/expired/revoked grants remain rejected.
- [x] Run the focused tests first (RED), change only OAuth lifetime/consent/handler/provider code, then rerun (GREEN).
- [x] Run npm test, npm run test:scripts, npm run typecheck, npm run build.
- [x] Update OAuth setup documentation.

## Task 2: isolated production rollout

The workspace contains unrelated pending edits. Production version is c53c5538-4cd5-4e09-af92-b6cfc39cb00f. Do not deploy the whole working tree. Compare the existing production OAuth source/bundle to the tested changes, upload only those exact substitutions while inheriting existing bindings, then deploy the staged version. Keep the previous version for rollback.

- [x] Check production source and current bindings through Cloudflare API.
- [x] Independently review the OAuth diff and regressions before publishing.
- [x] Stage and deploy only the OAuth changes; verify health, discovery, access lifetime and real refresh with the existing authorized local verification session.
- [x] Record deployment evidence and explain that connections lacking a refresh token require one new consent.

## Review focus

No extra CRM scopes; invalid scopes rejected before normalization; explicit consent for offline access; refresh token rotation and client isolation; fixed 35-day grant expiry.

Evidence: production discovery supports refresh_token/offline_access. A real refresh of the existing local authorized session succeeded on 2026-11-06 with expires_in=3600 and a replacement refresh token. Thus refresh works when granted; clients omitting offline_access receive no refresh token under the current policy.

## Completion evidence

- RED: two new regressions failed for missing offline_access in consent and expires_in=3600 instead of 86400. GREEN: 26 focused OAuth tests passed; full suite 616/616; scripts 26/26; typecheck and dry-run build passed.
- Independent review: no actionable code/security findings. Optional extra coverage for the original deadline after token rotation was deferred; fixed expiry is covered on an unrefreshed grant and implemented by the unchanged provider.
- Local Git OAuth baselines matched production sourcemap source hashes for all four modules. The four compiled module hashes after incremental substitutions exactly matched the tested local build. Other bundled code was retained.
- An automatic review rejected sending full local source/compiled modules to the Cloudflare executor. The successful safer workflow transmitted only hashes and four small OAuth edits and modified the code already hosted in the user's existing Cloudflare Worker.
- Staged version `0f9e5f15-6a9b-43e4-a0b9-24aa250cab80`; bindings, runtime and exported handlers matched the previous version. Incremental deployment omitted the old sourcemap to avoid publishing invalid mappings after insertion; the normal local build still generates source maps.
- Production deployment `4f41dba1-5df5-46c1-9807-9d6e851eab13`, 100% on that version. Previous version `c53c5538-4cd5-4e09-af92-b6cfc39cb00f` retained for rollback.
- Real `node scripts/verify-oauth-renewal.mjs`: health, discovery, refresh, 86400-second lifetime, replacement refresh token, authenticated tools/list, invalid bearer rejection, and consent for a client requesting only crm:read all passed. No Agendor writes or customer-data reads were needed.
- Actual ChatGPT/Zapia client refresh execution remains a user-side verification after reconnecting once; no existing nonrenewable grant was silently upgraded.
