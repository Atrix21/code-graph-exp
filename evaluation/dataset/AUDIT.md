# Independent audit of the 20 bug-localisation tasks (Agent B)

Scope: `targets/bench` (HEAD, 20 bugs applied) vs `targets/nestjs-boilerplate-upstream`; task JSONs in `evaluation/dataset/tasks`.
Method: source reading only (cat/grep/diff, TypeORM 0.3.28 source in `targets/node_modules` for one semantic check). `validate-gt` passes (0 errors), all `control_flow_conditions` line numbers match `targets/bench`, and `diff -r upstream/src bench/src` shows exactly the 20 intended hunks and nothing else. All 20 root-cause symbols are the symbols that contain the mutation, so check 2 passes everywhere. The problems are interference between bugs, labels and reports.

Terminology. **masked** means the described symptom cannot be observed in the combined snapshot because another injected bug intervenes first. **alias** means another injected bug produces the same (or a very similar) visible symptom.

---------------------------------------------------------------------------

## 1. Summary table

Verdicts are for the combined snapshot as it stands. If the lead moves to per-task single-bug snapshots (recommendation G1), every REJECT below becomes ACCEPT-WITH-CHANGES (low) and the "masked/alias" findings disappear.

| task_id | verdict | severity | one-line reason |
|---|---|---|---|
| auth_jwt_secret_01 | ACCEPT-WITH-CHANGES | medium | Clean, realistic bug, but it makes every `AuthGuard('jwt')` route return 401, which masks 12 other tasks. `JwtStrategy.validate` is not reached when the signature fails, and `AuthController.me` is an arbitrary endpoint. |
| auth_refresh_expiry_01 | ACCEPT-WITH-CHANGES | low | `READS ... AUTH_REFRESH_TOKEN_EXPIRES_IN` does not exist in the buggy code. Config symbol and `JwtRefreshStrategy.validate` are padding. |
| auth_reset_link_reuse_01 | REJECT (as-is) | high | The labelled fix does not resolve the report. `users_update_noop_01` means the password hash never changes, so links stay reusable regardless. An upstream comment in `getForgotSecret` states the fix verbatim. `lexical_overlap=low` is wrong. |
| auth_reset_sessions_01 | ACCEPT-WITH-CHANGES | low | Sound. The `CALLS` edge to `deleteByUserId` does not exist in the buggy snapshot. The overlap label is too low. |
| auth_social_link_01 | ACCEPT-WITH-CHANGES | high | The second half of the report (email login now says "via provider google") is masked or aliased by 3 other bugs. Rewrite the description to the observable symptom. |
| auth_uniform_login_01 | ACCEPT | low | Correct and unambiguous. It masks the error text of other login-related reports. |
| auth_update_email_dup_01 | ACCEPT-WITH-CHANGES | low | `AuthService.confirmNewEmail` is padding (wrong layer, name-clashes with the mail method). Relationship endpoints are not in `relevant_symbols`. |
| files_local_path_01 | ACCEPT | low | Correct. `download` is optional context. |
| files_photo_url_01 | ACCEPT-WITH-CHANGES | low | Four of the six relevant symbols are generic pass-through. The report states the fix (FRONTEND vs BACKEND domain). |
| files_presigned_size_01 | ACCEPT | low | Correct. The DTO symbol is marginal. |
| mail_new_email_link_01 | ACCEPT-WITH-CHANGES | low | The clause "never completes the email change" is aliased by `users_update_noop_01`. |
| roles_admin_guard_01 | ACCEPT-WITH-CHANGES | medium | Masked by `jwt_secret` (401 before the guard). The guard is attached at class level, so `UsersController.findAll` is the wrong anchor. The overlap label is too low. |
| session_password_change_01 | ACCEPT-WITH-CHANGES | low | Correct. `AuthService.refreshToken` is symptom-side padding. |
| session_refresh_replay_01 | ACCEPT-WITH-CHANGES | low | Correct. `JwtRefreshStrategy.validate` is padding. The overlap label should be low (0 token overlap). |
| users_create_provider_01 | ACCEPT-WITH-CHANGES | medium | The quoted error `needLoginViaProvider:google` is only emitted when uniform errors are ON. In the default config the inverted `invalidLoginException` returns the generic message. |
| users_list_page_01 | ACCEPT | low | Correct and unambiguous (only masked by the jwt bug). |
| users_mapper_lastname_01 | ACCEPT-WITH-CHANGES | low | The report explicitly covers profile edits, but `UsersRelationalRepository.update` is a distractor. The overlap label is arguable. |
| users_photo_cleared_01 | REJECT (as-is) | high | Unobservable in the snapshot. `users_update_noop_01` re-applies the existing photo over `null`. The data_flow sentence "merges the payload over the existing domain user" is false for the buggy repo. |
| users_update_noop_01 | ACCEPT-WITH-CHANGES | medium | A global masker (breaks every repository update). `UserMapper.toPersistence` is padding. The report ("exactly as before") is contradicted for `lastName` by `users_mapper_lastname_01`. |
| utils_has_next_page_01 | ACCEPT-WITH-CHANGES | low | `UsersService.findManyWithPagination` is not involved. `lexical_overlap=low` is wrong ("has next page" is `hasNextPage`). |

REJECTs are the two tasks whose labelled fix cannot, on its own, make the report's behaviour come true or visible (`auth_reset_link_reuse_01`, `users_photo_cleared_01`). Both depend on the same other bug (`users_update_noop_01`). Editing labels cannot repair that. It needs per-task snapshots, or narrowing the offending bugs (see G1/G2).

---------------------------------------------------------------------------

## 2. Cross-task interference (the main finding)

### 2.1 Four bugs that globally alter behaviour

1. **`auth_jwt_secret_01` (JwtStrategy secret).** Access tokens are signed with `auth.secret` but verified with `auth.refreshSecret`. The two env defaults differ (`secret` vs `secret_for_refresh`), so every `@UseGuards(AuthGuard('jwt'))` route returns 401. That is 8 distinct guarded declarations, covering `/auth/me` GET/PATCH/DELETE, logout, `/users/*`, and `/files/upload` for the local and presigned drivers. Reports for these tasks assume a working login.
   - Tasks masked: auth_update_email_dup, session_password_change, mail_new_email_link, files_photo_url, files_local_path, files_presigned_size, roles_admin_guard, users_list_page, utils_has_next_page, users_update_noop, users_photo_cleared, and the "editing the profile later" half of users_mapper_lastname.
   - roles_admin_guard is the worst case: its report says "403 ... their token is valid", but in the snapshot every user gets 401 and the guard is never reached.
2. **`users_update_noop_01` (spread order in `UsersRelationalRepository.update`).** `{...payload, ...UserMapper.toDomain(entity)}` makes the stored entity win for every field except `photo` when the stored photo is null. Every `UsersService.update` therefore persists nothing.
   - Affected flows: `confirmEmail` (status never becomes active), `confirmNewEmail` (email never changes), `resetPassword` (password never changes), `AuthService.update` (profile and password), the social-link `update`, and the photo-clear in `users_photo_cleared`.
   - The same mutation also makes `users_photo_cleared` invisible (`photo` is eager, so `toDomain(entity)` always restores it).
3. **`auth_uniform_login_01` (inverted `uniformErrors`).** With the default config (`AUTH_UNIFORM_ERRORS` unset), every `invalidLoginException` returns the generic `incorrectEmailOrPassword`. The specific messages (`needLoginViaProvider:<p>`, `notFound`, `incorrectPassword`) are only emitted when the flag is true. This makes the quoted error strings in `users_create_provider` and `auth_social_link` non-reproducible in the default config.
4. **`users_create_provider_01` (default provider google).** Every email-registered user (and every admin-created user without an explicit provider) has `provider='google'`. This changes the precondition of `auth_social_link`: "registered with email and password" already means provider=google.

Secondary interactions:
- `users_mapper_lastname_01` also rewrites `lastName = firstName` on every `UsersRelationalRepository.update`, so after a PATCH from `users_update_noop_01` the row is not "exactly as before".
- `files_photo_url_01` (frontend domain prefix) also affects the `path` returned by `POST /files/upload`, which is the link `files_local_path_01` says "gives 404". Low risk, since both are wrong URLs.

### 2.2 Concrete alias/masking list (labels at risk)

| task | problem in the combined snapshot |
|---|---|
| auth_reset_link_reuse_01 | Even with `getForgotSecret` fixed, `resetPassword` -> `UsersService.update` -> `UsersRelationalRepository.update` never writes the new hash, so the link still verifies. In the combined snapshot, `UsersRelationalRepository.update` equally explains the report. |
| auth_social_link_01 | (a) `confirmEmail` never activates a user (noop), so the "active, confirmed" precondition cannot arise from the register flow. It does hold for the seeded `john.doe@example.com`. (b) The relink `update` is a no-op, so the DB provider never changes, and the claim "email login now tells them to log in via provider google" cannot occur from this bug. (c) Under the default flag the text is generic anyway. (d) Alias: users_create_provider already makes email-registered users google. The only part truly observable is the in-memory `user.provider === 'google'` in the social-login response. |
| users_photo_cleared_01 | Unobservable. The payload's `photo: null` is overridden by `toDomain(entity).photo`. If the user has no photo there is nothing to clear. |
| mail_new_email_link_01 | "following it never completes the email change" is also explained by users_update_noop: `AuthService.confirmNewEmail` -> `usersService.update` never persists the new email, even with a correct link. |
| users_create_provider_01 | The quoted 422 body is masked by auth_uniform_login (generic text in the default config). `GET /auth/me` (group `me` exposes `provider`) would show `google` independent of the flag. |
| roles_admin_guard_01 | Masked by jwt_secret. |

### 2.3 Other cross-task notes
- 6 of 20 root causes live in `auth.service.ts` (six hunks in one 640-line file), and it appears in the relevant files of about a dozen further tasks. File-level hit-rate metrics will be inflated by a method that simply returns `auth.service.ts`. Consider reporting symbol-level results as the primary metric.
- Shared flows produce partial credit across tasks. `AuthService.update` is a relevant symbol in 4 tasks (update_email_dup root, mail, photo_cleared, session_password), `UsersService.update` in 2, and `UserMapper.toPersistence` is a root cause in one task and a relevant or distractor symbol elsewhere. This is legitimate but should be understood when scoring.
- Duplicate root causes: none (20 distinct symbols).
- `targets/bench/test/**` still contains the upstream e2e specs. `test/user/auth.e2e-spec.ts` line 171 reads "The link is single-use: the reset token is bound to the previous password hash, so replaying it must fail". If `test/` is in the retrieval corpus (`bench.manifest.json` says 170 corpus files, but `git ls-files src` has 188 files, so I could not tell which files are included), it leaks the answer to `auth_reset_link_reuse_01`. Confirm `test/` is excluded.

### 2.4 Recommendations (global)
- **G1 (preferred).** Evaluate each task against its own single-bug snapshot (pristine + that one patch). The patches are independent and 1-hunk each. This removes all masking and alias issues, and every report is then literally true. If the combined snapshot is kept (cheaper), apply G2.
- **G2 (if combined snapshot is kept).** Narrow the four global bugs so that they do not collide:
  - Narrow `users_update_noop_01` to one field, or to a path no other task uses.
  - Change `auth_jwt_secret_01` to a less global config (or document that all protected-route tasks are "pre-401").
  - Rewrite descriptions as in the per-task sections so they only claim behaviour that is observable.
- **G3.** `lexical_overlap` has no operational definition in AUTHORING.md. A crude token overlap (camelCase-split, stop-words removed) between the description and the root-cause symbol body gives these ratios. High-labelled tasks are in the 0.17 to 0.57 range, and several low-labelled ones are above them.
  - **reset_link_reuse** 6/15=0.40 (label low), driven by the comment ("single-use", "reset links", "password").
  - **utils_has_next_page** 3/23, but "has next page" is wholly in the body (label low).
  - **mapper_lastname** 4/19 ("first/last name" appears in dozens of files) (label low).
  - **reset_sessions**: the root-cause symbol name `resetPassword` is literally "reset password" (label low).
  - **refresh_replay** 0/19 (label medium).
  - Define overlap operationally and compute it, or relabel as proposed below. Currently 7 low / 7 medium / 6 high, but after relabelling it would be about 4 low / 9 medium / 7 high.
- **G4.** `expected_relationships` mix edges that exist in the buggy snapshot with edges that only exist in the fixed code. Examples: `getTokensData READS AUTH_REFRESH_TOKEN_EXPIRES_IN` (refresh_expiry) and `resetPassword CALLS SessionService.deleteByUserId` (reset_sessions). Graph-based scorers cannot find the latter. Mark these as "expected-missing" or drop them.
- **G5.** `relevant_files` is mechanically equal to the file set of `relevant_symbols` in all 20 tasks. That is consistent, but it adds no independent signal.

---------------------------------------------------------------------------

## 3. Per-task findings

Checks: (1) bug reality, (2) root cause, (3) relevant symbols, (4) relevant files, (5) report quality / leakage / overlap, (6) distractors, (7) relationships/conditions.

### auth_jwt_secret_01 — ACCEPT-WITH-CHANGES (medium)
1. Real. `JwtStrategy` verifies with `auth.refreshSecret` while `getTokensData` signs the access token with `auth.secret` (distinct values by default), so every `AuthGuard('jwt')` route gives 401. The mutation is realistic (the refresh strategy just below legitimately uses `refreshSecret`) and has no hint. "Login and token refresh work fine" is true in the snapshot (refresh uses the `jwt-refresh` strategy). Ambiguity: low locally, but the global masking effect (section 2.1) is large.
2. Root cause correct (`JwtStrategy.constructor`, line 14).
3. `JwtStrategy.validate` is not reached when signature verification fails, so remove it. `AuthController.me` is one of ~15 equivalent guarded endpoints, so it is not discriminative (remove, or keep only if a route anchor is wanted). `AuthService.getTokensData` (signing counterpart) is fine. Resulting set of 2 to 3 is acceptable.
   - relevant_symbols: remove `src/auth/strategies/jwt.strategy.ts::JwtStrategy.validate`; remove `src/auth/auth.controller.ts::AuthController.me`.
   - expected_relationships: the only edge `AuthController.me CHECKS JwtStrategy.constructor` is framework-implicit (resolved by the string `'jwt'`). Keep only if the scorer can represent it.
4. relevant_files: drop `src/auth/auth.controller.ts` if `me` is removed.
5. No leakage ("secret", "strategy" not mentioned). Overlap low is correct.
6. Distractors fine (`JwtRefreshStrategy.*`, `AUTH_JWT_SECRET`).
7. Line 14 correct.

### auth_refresh_expiry_01 — ACCEPT-WITH-CHANGES (low)
1. Real. The second `signAsync` uses `auth.expires`, so the refresh token expires with the access token. The symptom (401 on `/auth/refresh` after the access lifetime; `exp` minutes after `iat`) follows. The report pretty much states the mechanism but uses no code identifiers. No competing cause.
2. Correct (`getTokensData`, line 628).
3. Padding:
   - Remove `src/auth/strategies/jwt-refresh.strategy.ts::JwtRefreshStrategy.validate`: expiry is enforced by passport-jwt before `validate`, and `validate` only checks `sessionId`.
   - Remove `src/auth/config/auth.config.ts::EnvironmentVariablesValidator.AUTH_REFRESH_TOKEN_EXPIRES_IN`: the code reads the config key `auth.refreshExpires`, which is mapped in the anonymous `registerAs` callback, not in this validator property. Also, the wrong key the buggy code actually reads (`AUTH_JWT_TOKEN_EXPIRES_IN`) is listed as a distractor. Treating one config symbol as relevant and the other as a distractor is inconsistent. Treat both the same (neither relevant).
   - Keep `getTokensData`, `AuthController.refresh`, `AuthService.refreshToken` (or only `getTokensData` plus one entry).
4. Drop `jwt-refresh.strategy.ts` and `auth.config.ts` from relevant_files accordingly.
5. Overlap high is fine (description contains `AUTH_REFRESH_TOKEN_EXPIRES_IN`, "refresh", "expires").
6. `AuthService.forgotPassword` is a weak distractor (irrelevant to refresh) and harmless.
7. Line 628 correct. `getTokensData READS ...AUTH_REFRESH_TOKEN_EXPIRES_IN` is false in the buggy snapshot (the function reads `auth.expires`). Remove the edge or mark it as a fixed-code edge. Keep `validateLogin CALLS getTokensData`.

### auth_reset_link_reuse_01 — REJECT as-is (high)
1. Local logic is real: `getForgotSecret` returns `forgotSecret + user.email`, which is constant, so links stay valid after a reset. But in the combined snapshot:
   - `users_update_noop_01` prevents the new password hash from being stored (`toDomain(entity).password` overrides the payload), so the secret (using the correct password field) would also remain constant. Fixing only the labelled root cause does not make "the same link no longer works" true. `UsersRelationalRepository.update` is an equally valid explanation of the report.
   - The report says "after I successfully set a new password"; in the snapshot the password never changes.
   - The pristine comment inside `getForgotSecret` (lines 585-587, "The secret embeds the current password hash, so every outstanding reset link stops verifying as soon as the password changes — this is what makes reset links single-use...") now contradicts the code and states the fix. It also lexically matches the report ("single use", "reset", "link", "password"), which is the main reason the overlap is not low. It is a hint embedded in the very symbol under test.
2. Root cause symbol is correct as a location.
3. Relevant set (getForgotSecret, controller.resetPassword, service.resetPassword, forgotPassword) is fine. Under a combined snapshot, add `src/users/infrastructure/persistence/relational/repositories/user.repository.ts::UsersRelationalRepository.update` (the password write) or, preferably, do G1.
4. Consistent.
5. Overlap: change `low` to `high`. Difficulty `hard` is not justified given the comment: change to `medium` or remove the comment from the bench source (a legitimate part of the mutation, since a refactor would plausibly drop the comment, but this changes code).
6. Distractors fine.
7. Line 592 correct; relationships correct.
- Required before use: (a) remove the 3-line comment from `getForgotSecret` in the bench snapshot, or relabel overlap/difficulty. (b) Resolve interference with `users_update_noop_01` (G1/G2). Neither can be done by editing the other label fields alone.

### auth_reset_sessions_01 — ACCEPT-WITH-CHANGES (low)
1. Real. Removing `sessionService.deleteByUserId` leaves session rows alive, so `updateByHash` still succeeds and refresh keeps working. The soft-delete semantics were verified: `Repository.update` has no soft-delete filter, but the following `findOne` does, so a deleted session gives 401. Realistic (a removed line). No alias.
2. Correct (`resetPassword`; line 413 is the preceding statement, fine for a missing call).
3. For a missing-call bug the callee symbols are inherently "expected, but not called". Keep `SessionService.deleteByUserId`; `SessionRelationalRepository.deleteByUserId` is padding (correct code, two hops away from anything executed). Optional: add `src/auth/auth.service.ts::AuthService.refreshToken` (where the symptom "could still renew" appears).
4. Consistent.
5. Overlap: change `low` to `medium`: "reset my password" is literally `resetPassword`, whose name matches the report. The report is otherwise fine. No leakage.
6. Distractors fine.
7. `resetPassword CALLS SessionService.deleteByUserId` does not exist in the buggy snapshot (G4). Same for the next hop edge. Keep `resetPassword CALLS UsersService.update` (exists).

### auth_social_link_01 — ACCEPT-WITH-CHANGES (high)
1. The code bug is real (`!==` inverts the inactive check, so an active account gets provider/socialId rewritten). The report overstates what is observable (section 2.2). In the snapshot: noop means the DB provider is not rewritten, so "regular email login now tells them to log in via provider google" is not reproducible. Under default flags the text is the generic message. The register->confirm precondition fails (confirm never activates). The in-memory `user.provider` in the Google login response is observable.
2. Correct (`validateSocialLogin`).
3. `AuthService.validateLogin` is where the second-step symptom appears, not on the path of the root cause (padding). `UsersService.update` is on the path, though in the buggy snapshot it persists nothing. Keep `findByEmail`, `UsersService.update`, `AuthGoogleController.login`.
   - relevant_symbols: remove `src/auth/auth.service.ts::AuthService.validateLogin`.
4. Drop nothing (validateLogin is in the same file as the root cause).
5. Rewrite the description to the observable symptom, e.g.: "A customer with an active email+password account (seeded john.doe@example.com) uses 'Sign in with Google' with the same email. The login response for that user now reports `provider: \"google\"` and carries a `socialId`; a password account must not be re-linked to a social provider unless it is still unconfirmed." Overlap medium fine.
6. Distractors fine (Facebook controller is identical logic: that is a deliberate confuser).
7. Line 135 correct. Edge `validateSocialLogin CALLS UsersService.update` exists (but inert under noop).

### auth_uniform_login_01 — ACCEPT (low)
1. Real, unambiguous, realistic (negation of a flag). Report reproduces exactly (specific errors with flag true, generic with it unset). `forgotPassword` correctly reads the flag the right way round (a good confuser).
2. Correct (`invalidLoginException`).
3. relevant_symbols are the entry, the caller, and the root cause. OK. Nothing to add.
4. Consistent.
5. No identifier leakage (env var name and error strings are user-visible). Overlap high is correct (8 tokens). Difficulty could be `easy` but is arguable.
6. `forgotPassword` is a fair confuser. `EnvironmentVariablesValidator.AUTH_UNIFORM_ERRORS` is fine.
7. Line 575 correct.

### auth_update_email_dup_01 — ACCEPT-WITH-CHANGES (low)
1. Real and realistic (`!==` to `===`). Report symptom is exactly produced: the duplicate check never fires (outer guard ensures the email differs from the current one) and the mail is sent. Not aliased. (`UsersService.update` has its own `emailAlreadyExists` check, but `delete userDto.email` precedes the call, as the data_flow says.)
2. Correct (`AuthService.update`).
3. `AuthService.confirmNewEmail` is the consumer of the link, not on the path of this symptom, and it name-collides with the mail method. Remove. `expected_relationships` refers to `MailService.confirmNewEmail`, which is not in `relevant_symbols`. That is the callee that sends the confirmation mail, so add it (or drop the relationship for consistency).
   - relevant_symbols: remove `src/auth/auth.service.ts::AuthService.confirmNewEmail`; add `src/mail/mail.service.ts::MailService.confirmNewEmail` (the mail the report mentions; note it is also the root cause of mail_new_email_link, so alternatively drop the relationship instead).
4. Update relevant_files to match.
5. Fine. Overlap high is correct (route, `emailExists`).
6. `UsersService.update` is on the path (called at line 514), though not responsible; fine as a distractor. `UsersService.create`/`register` are weak but harmless.
7. Line 479 correct.

### files_local_path_01 — ACCEPT (low)
1. Real. Multer `diskStorage` sets `file.path = 'files/<name>'`, so the pristine URL is `/api/v1/files/<name>`, which matches the `files/:path` download route; the mutation gives `/api/v1/<name>`, which 404s. Matches the report. Minor alias: the returned file object also passes through the `FileType.path` transform (files_photo_url), so the response URL also has the wrong host. Low risk.
2. Correct.
3. `FilesLocalController.download` is optional context (shows the route contract). Keep or drop; the core is `create` and `uploadFile`.
4. Consistent.
5. No leakage. Overlap medium is fine.
6. `FileType.path` as a distractor is reasonable, though it is on the response path.
7. Line 33 correct. `uploadFile CALLS create` exists.

### files_photo_url_01 — ACCEPT-WITH-CHANGES (low)
1. Real. `FILE_DRIVER=local` (default) gives the transformed URL `frontendDomain + path`. Masked only by the jwt bug (`/auth/me`).
2. Correct (anonymous `@Transform` callback mapped to `FileType.path`).
3. `UsersService.findById`, `AuthService.me` and `UserMapper.toDomain` are generic pass-through. The mechanism (class-transformer serialization of a `FileType` instance) is what matters, so keep `FileMapper.toDomain` (it creates the `FileType` instance that makes the decorator apply). Propose a set of three.
   - relevant_symbols: remove `src/users/users.service.ts::UsersService.findById`; remove `src/auth/auth.service.ts::AuthService.me`; remove `src/users/infrastructure/persistence/relational/mappers/user.mapper.ts::UserMapper.toDomain`. Keep `FileType.path`, `AuthController.me`, `FileMapper.toDomain`.
   - Optional: add `src/utils/serializer.interceptor.ts::ResolvePromisesInterceptor` is NOT needed for the local driver; do not add.
4. Update relevant_files accordingly.
5. The report essentially gives the fix ("prefixed with FRONTEND_DOMAIN rather than BACKEND_DOMAIN"). The env var names are user-visible config, so it is acceptable, but note that this makes the task nearly lexical. Optionally say "prefixed with the web-app host instead of the API host". Overlap high is correct.
6. `AppModule` is an odd distractor but harmless.
7. Line 27 correct. Edges are correct (`AuthService.me CALLS UsersService.findById` exists, etc.), though if the relevant set is trimmed, drop the edges whose endpoints are removed.

### files_presigned_size_01 — ACCEPT (low)
1. Real. `<` instead of `>` yields 413 for a 200 KB file (`< 5242880`) and allows 20 MB. Matches. Masked only by jwt.
2. Correct.
3. `FileUploadDto.fileSize` is marginal (correct code that supplies the value). Optional remove; the set would then be 2. Fine either way.
4. Consistent.
5. The report quotes the user-visible 413 body. Fine. Overlap high correct.
6. `FILE_DRIVER` and `FilesLocalModule` distractors are weak but harmless.
7. Line 60 correct.

### mail_new_email_link_01 — ACCEPT-WITH-CHANGES (low)
1. Real. The mail link is `/confirm-email` instead of `/confirm-new-email`; verified against the unchanged `userSignUp`. The clause "following it never completes the email change" is aliased by users_update_noop (the new email would never persist) and the report's first clause alone identifies the bug.
2. Correct.
3. Set (confirmNewEmail in mail, AuthController.update, AuthService.update) is fine. `AuthService.confirmNewEmail` is a correct distractor.
4. Consistent.
5. Edit the description: replace "and following it never completes the email change" with "and the page it opens does not offer to confirm a new address". Overlap medium OK.
6. Distractors fine.
7. Line 141 correct.

### roles_admin_guard_01 — ACCEPT-WITH-CHANGES (medium)
1. Real. `RolesGuard` compares required roles to `request.user.id` rather than `role.id`; only the seeded admin (id 1 = `RoleEnum.admin`) passes. Matches. Masked by jwt_secret (401 before the guard). Realistic.
2. Correct.
3. `@Roles(RoleEnum.admin)` and `@UseGuards(AuthGuard('jwt'), RolesGuard)` are class-level decorators on `UsersController`, so by the key convention they belong to `UsersController`, not to `UsersController.findAll`. `findAll` is arbitrary (any handler qualifies).
   - relevant_symbols: replace `src/users/users.controller.ts::UsersController.findAll` with `src/users/users.controller.ts::UsersController`.
   - expected_relationships: change the first edge's source to `src/users/users.controller.ts::UsersController`.
   - Optional: `src/roles/roles.decorator.ts::Roles` produces the `roles` metadata the guard reads; it is on the path, but also a legitimate distractor. Pick one; I suggest leaving it as a distractor.
4. Unchanged files.
5. Overlap `low` is too low: "admin", "role", "403 Forbidden" match `RolesGuard`/`RoleEnum.admin`. Set `medium`. The report is fine, and "seeded super admin" is a helpful but not leaking hint.
6. `getTokensData` as a distractor is borderline (it builds the `role` that ends up in `request.user`), but acceptable.
7. Line 21 correct. `JwtStrategy.validate RETURNS_VALUE_TO canActivate` is framework-mediated (via `request.user`); fine.

### session_password_change_01 — ACCEPT-WITH-CHANGES (low)
1. Real. `Not(userId)` instead of `Not(excludeSessionId)` kills the current session (so refresh returns 401: verified `update` then `findOne` excludes soft-deleted rows) and spares only the session whose id equals the user id ("sometimes survives" is accurate). Realistic; the unused `excludeSessionId` is natural. Masked by jwt (PATCH /auth/me).
2. Correct (relational repository method).
3. `AuthService.refreshToken` is where the symptom surfaces, not on the cause path: remove. Others (controller, `AuthService.update`, `SessionService.deleteByUserIdWithExclude`) are the route.
   - relevant_symbols: remove `src/auth/auth.service.ts::AuthService.refreshToken`.
4. Files unchanged (auth.service.ts still included via `AuthService.update`).
5. No leakage. Overlap medium is arguable (token overlap with the body is very low: 2/28), so `low` or `medium` are both defensible.
6. Distractors fine.
7. Line 107 correct. `QUERIES_DATABASE SessionEntity` valid.

### session_refresh_replay_01 — ACCEPT-WITH-CHANGES (low)
1. Real. Dropping `hash` from the `update` where-clause lets any old refresh JWT for the session id rotate again (`affected=1`). Matches. No competing cause (JWT still verifies, session exists).
2. Correct.
3. `JwtRefreshStrategy.validate` is not involved in the hash check: remove. `SessionService.updateByHash` is a pass-through but on the path (OK).
   - relevant_symbols: remove `src/auth/strategies/jwt-refresh.strategy.ts::JwtRefreshStrategy.validate`.
4. Drop `jwt-refresh.strategy.ts` from relevant_files.
5. Overlap: `medium` should be `low` (0 shared content tokens with the root-cause body). No leakage.
6. Distractors fine.
7. Line 70 correct.

### users_create_provider_01 — ACCEPT-WITH-CHANGES (medium)
1. Real. `AuthService.register` supplies no provider, so `create` defaults to google. The report's observable (`needLoginViaProvider:google` in a 422) is only emitted when `AUTH_UNIFORM_ERRORS=true`, because of auth_uniform_login; with the default config the response is `incorrectEmailOrPassword`. Rewrite using an observable that is flag-independent.
2. Correct (`UsersService.create`, line 126).
3. Fine. Optionally add `src/auth/auth.service.ts::AuthService.invalidLoginException`, which the expected relationship `validateLogin THROWS invalidLoginException` references but which is not listed; but that symbol is auth_uniform_login's root cause, so I would rather drop the `THROWS` relationship or leave it as is.
4. Consistent.
5. Description rewrite: "After registering via POST /api/v1/auth/email/register and confirming the email, `GET /api/v1/auth/me` for the new user shows `provider: \"google\"` and the user cannot log in with their password." Overlap high is fine.
6. Distractors fine (`UserMapper.toPersistence` and `UsersRelationalRepository.create` are on the persistence path; harmless).
7. Line 126 correct.

### users_list_page_01 — ACCEPT (low)
1. Real. `page * limit` skips the first page; page 1 limit 10 starts at the 11th and the two seeded users give an empty list; page 2 begins at the 21st. Matches (default page 1, limit 10). Masked by jwt only. Different symptom from utils_has_next_page; `hasNextPage` is unaffected here.
2. Correct.
3. Controller, service pass-through and repository are the route. Fine.
4. Consistent.
5. No leakage. Overlap medium is fine.
6. Distractors fine; `infinityPagination` is another task's root cause (good confuser).
7. Line 45 correct.

### users_mapper_lastname_01 — ACCEPT-WITH-CHANGES (low)
1. Real. `lastName = firstName` in `toPersistence` affects create and update. Register -> create is what the report starts from. Matches. Note: `AuthController.register` returns 204, so "returned as Jane Jane" can only be seen via `/auth/me` (masked by jwt) or the admin list. Mildly imprecise.
2. Correct.
3. The report explicitly includes "Editing the profile later also overwrites the surname", so the repository update path calls the buggy mapper in the same way: add it, and remove it from distractors.
   - relevant_symbols: add `src/users/infrastructure/persistence/relational/repositories/user.repository.ts::UsersRelationalRepository.update` (second caller of `toPersistence` described in the report).
   - distractor_symbols: remove `...UsersRelationalRepository.update`.
4. No new files.
5. Overlap `low` is arguable: "first name"/"last name" tokens are in the mutated line (`lastName`, `firstName`) but also in dozens of other files. Set `medium`.
6. Others fine.
7. Line 63 correct.

### users_photo_cleared_01 — REJECT as-is (high)
1. The code bug is real in isolation. In the snapshot it cannot be observed: `UsersRelationalRepository.update` (users_update_noop) spreads `UserMapper.toDomain(entity)` last, which restores the stored `photo` (eager relation) over the `photo: null` produced by the bug. If the user has no photo there is nothing to clear. The labelled fix alone would therefore not change any visible behaviour either. Also minor: a cleared photo comes back as an omitted key rather than `null` (`toDomain` only sets `photo` when present).
2. Root cause location is correct.
3. Relevant set is fine. In isolation, `UsersRelationalRepository.update` is a pass-through; note it is also users_update_noop's root cause.
4. Consistent.
5. "photo comes back null": the key would actually be absent. Reword to "their avatar disappears".
6. Distractors fine.
7. `data_flow` says "UsersRelationalRepository.update merges the payload over the existing domain user, so photo=null removes the stored avatar": false for the buggy repository (the reverse is true). Line 226 correct.
- Cannot be repaired by label edits: the report describes a state that the combined snapshot cannot reach. Use G1 or narrow users_update_noop_01.

### users_update_noop_01 — ACCEPT-WITH-CHANGES (medium)
1. Real. `{...payload, ...toDomain(entity)}` makes existing values win; PATCH returns 200 with unchanged data. But the mapper bug also sets `lastName = firstName` on save, so the row is not "exactly as before" (if `lastName != firstName`). Masked by jwt. As the AUTHORING notes concede, the bug affects every update in the app, which is the largest blast radius of any injected bug.
2. Correct.
3. `UserMapper.toPersistence` is a callee that is correct for this symptom (padding, and it is another task's root cause). The buggy expression itself calls `UserMapper.toDomain`.
   - relevant_symbols: remove `src/users/infrastructure/persistence/relational/mappers/user.mapper.ts::UserMapper.toPersistence`; add `src/users/infrastructure/persistence/relational/mappers/user.mapper.ts::UserMapper.toDomain` (the spread operand that wins).
   - expected_relationships: replace the `CALLS ... toPersistence` edge with `CALLS ... toDomain` (both edges exist, so alternatively keep both edges, but only list `toDomain` as relevant).
4. Update relevant_files (same file as before, no change).
5. Overlap low is fine. The description is good; optionally say "name and role" (already) and drop "the database is unchanged" if the lead keeps the combined snapshot, because lastName gets rewritten.
6. `SessionRelationalRepository.update` is a good "similarly shaped" distractor.
7. Line 114/115 correct (`...payload` is at 114).

### utils_has_next_page_01 — ACCEPT-WITH-CHANGES (low)
1. Real. `>` makes `hasNextPage` always false (`data.length <= limit`). Matches. Masked by jwt only.
2. Correct.
3. `UsersService.findManyWithPagination` has nothing to do with the flag: remove. Keep `infinityPagination` and `UsersController.findAll` (the caller).
   - relevant_symbols: remove `src/users/users.service.ts::UsersService.findManyWithPagination`.
4. Drop `src/users/users.service.ts` from relevant_files.
5. Overlap `low` is wrong: "has next page" = `hasNextPage`, "infinite scroll" ~ `infinityPagination`. Set `high` (or `medium`).
6. `UsersRelationalRepository.findManyWithPagination` is a good distractor (another root cause).
7. Line 10 correct.

---------------------------------------------------------------------------

## 4. Exact edit list (for the lead)

Bug-reality and interference
- G1: build per-task single-bug snapshots from `evaluation/dataset/bugs/*.patch` (preferred). If not, apply G2.
- auth_reset_link_reuse_01: delete lines 585-587 (the comment) from `targets/bench/src/auth/auth.service.ts::getForgotSecret` (and from the patch), set `lexical_overlap: high`, `difficulty: medium`. Resolve the noop interference (G1/G2) or REJECT.
- users_photo_cleared_01: resolve the noop interference (G1/G2) or REJECT. Reword "photo comes back null" to "avatar disappears". Fix `data_flow[1]` to say that the repository applies the payload over the stored user (in fixed code).
- auth_social_link_01: rewrite description (see above). Remove `AuthService.validateLogin` from `relevant_symbols`.
- users_create_provider_01: rewrite description (see above).
- mail_new_email_link_01: drop the last clause of the description.

relevant_symbols
- auth_jwt_secret_01: remove `JwtStrategy.validate`, `AuthController.me`.
- auth_refresh_expiry_01: remove `JwtRefreshStrategy.validate`, `EnvironmentVariablesValidator.AUTH_REFRESH_TOKEN_EXPIRES_IN`.
- auth_reset_sessions_01: remove `SessionRelationalRepository.deleteByUserId`; optional add `AuthService.refreshToken`.
- auth_update_email_dup_01: remove `AuthService.confirmNewEmail`; add `MailService.confirmNewEmail` (or drop the relationship).
- files_photo_url_01: remove `UsersService.findById`, `AuthService.me`, `UserMapper.toDomain`.
- roles_admin_guard_01: replace `UsersController.findAll` with `UsersController`.
- session_password_change_01: remove `AuthService.refreshToken`.
- session_refresh_replay_01: remove `JwtRefreshStrategy.validate`.
- users_mapper_lastname_01: add `UsersRelationalRepository.update`; remove it from distractors.
- users_update_noop_01: remove `UserMapper.toPersistence`; add `UserMapper.toDomain` (relational).
- utils_has_next_page_01: remove `UsersService.findManyWithPagination`.
- Recompute `relevant_files` from the final symbol sets.

lexical_overlap
- auth_reset_link_reuse_01 low -> high; auth_reset_sessions_01 low -> medium; roles_admin_guard_01 low -> medium; utils_has_next_page_01 low -> high; users_mapper_lastname_01 low -> medium; session_refresh_replay_01 medium -> low.

expected_relationships
- auth_refresh_expiry_01: drop `getTokensData READS AUTH_REFRESH_TOKEN_EXPIRES_IN`.
- auth_reset_sessions_01: mark the `resetPassword CALLS SessionService.deleteByUserId` edge and its follow-on as missing-in-buggy-code (or drop).
- roles_admin_guard_01: re-source the first edge from `UsersController`.
- Remove any edge whose endpoints are removed from `relevant_symbols` (auth_jwt_secret_01, files_photo_url_01, users_update_noop_01).

Corpus hygiene
- Confirm `targets/bench/test/**` is excluded from the retrieval corpus (the e2e spec states the fix of auth_reset_link_reuse_01).
