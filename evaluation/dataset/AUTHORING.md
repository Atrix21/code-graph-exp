# Ground-truth authoring notes (Agent A)

## Method
- Codebase: brocoders/nestjs-boilerplate @ 9620f159 (private copy: `targets/gt-workspace`, branch `gt-base`).
- Truth was established only by reading source (cat/grep for navigation, tsc). No graph, embedding or retrieval tooling was used, and no evaluation results were read.
- For each task one minimal mutation (1-4 lines, no comments, no new identifiers, no new files, `src/` only) was applied. Each is saved as a `git diff` against the pristine commit in `evaluation/dataset/bugs/<task_id>.patch`.
- Verified: every patch passes `git apply --check` alone on a pristine worktree; all 20 apply sequentially to the same tree and produce a diff identical to the final workspace; `tsc --noEmit -p tsconfig.json` exits 0 with all 20 applied. Hunks are at least ~15 lines apart, including the 6 in `auth.service.ts`.
- Bugs are in 20 different functions/properties. All persistence bugs are in the relational (TypeORM) implementation, and the Mongoose twins are listed as distractors.
- Reports were written from the observable symptom only. `validate-gt` reports 0 errors and 0 warnings.
- Relevant symbols were derived by tracing entry point -> callees -> root cause by hand. `call_distance` counts hops from the most natural service-level method touched by the symptom to the root cause.

## Tasks
| task_id | root cause | category | overlap | difficulty | dist |
|---|---|---|---|---|---|
| auth_uniform_login_01 | AuthService.invalidLoginException | wrong-condition | high | medium | 1 |
| auth_reset_sessions_01 | AuthService.resetPassword | missing-call | low | medium | 0 |
| auth_refresh_expiry_01 | AuthService.getTokensData | wrong-config | high | medium | 1 |
| auth_social_link_01 | AuthService.validateSocialLogin | wrong-condition | medium | medium | 0 |
| auth_reset_link_reuse_01 | AuthService.getForgotSecret | wrong-field | low | hard | 1 |
| auth_update_email_dup_01 | AuthService.update | wrong-comparison | high | easy | 0 |
| session_password_change_01 | SessionRelationalRepository.deleteByUserIdWithExclude | wrong-field | medium | hard | 2 |
| session_refresh_replay_01 | SessionRelationalRepository.updateByHash | missing-check | medium | hard | 2 |
| users_list_page_01 | UsersRelationalRepository.findManyWithPagination | off-by-one | medium | medium | 1 |
| utils_has_next_page_01 | infinityPagination | wrong-comparison | low | easy | 1 |
| users_mapper_lastname_01 | UserMapper.toPersistence (relational) | wrong-field | low | hard | 3 |
| users_photo_cleared_01 | UsersService.update | wrong-condition | medium | medium | 1 |
| users_update_noop_01 | UsersRelationalRepository.update | wrong-argument-order | low | medium | 1 |
| roles_admin_guard_01 | RolesGuard.canActivate | wrong-field | low | medium | 1 |
| auth_jwt_secret_01 | JwtStrategy.constructor | wrong-config | low | medium | 1 |
| files_local_path_01 | FilesLocalService.create | wrong-field | medium | easy | 0 |
| files_presigned_size_01 | FilesS3PresignedService.create | wrong-comparison | high | easy | 0 |
| files_photo_url_01 | FileType.path (transform) | wrong-config | high | medium | 2 |
| mail_new_email_link_01 | MailService.confirmNewEmail | wrong-constant | medium | easy | 1 |
| users_create_provider_01 | UsersService.create | wrong-enum-constant | high | easy | 1 |

## Distributions
- Overlap: high 6, medium 7, low 7.
- Difficulty: easy 6, medium 10, hard 4.
- call_distance: 0 -> 5 tasks; >=1 -> 15 tasks (1 hop: 10, 2 hops: 4, 3 hops: 1).
- Area: auth.service 6 (the maximum), session repo 2, users service 2, users repo 2, users mapper 1, utils 1, roles guard 1, jwt strategy 1, files/uploaders 3 (local, s3-presigned, FileType transform), mail 1.
- Bug type: wrong-condition/comparison 7, wrong-field 5, wrong-config 3, missing-call/check 2, off-by-one 1, wrong-argument-order 1, wrong constant/enum 2.
- Not covered: Facebook, Apple, Google provider services, the S3 multer uploader, and config files (the config bugs are config-key misuse at call sites).

## Borderline / caveats
- users_update_noop_01 (swapped spread order) breaks every repository update (profile, password, status), not just admin PATCH. The report anchors on admin PATCH /users/:id, but a retriever reading other update flows may also be "right" about the symptom.
- auth_jwt_secret_01 is one config-key line in a constructor. Its symptom (all protected routes 401) is generic, and the distractors (getTokensData, the refresh strategy) are the intended confusers.
- files_photo_url_01: the root cause is an anonymous @Transform callback on `FileType.path`. It is labelled with the enclosing property symbol and is only reached implicitly via serialization, so call_distance=2 is approximate.
- session_password_change_01: the buggy `Not(userId)` makes some other session survive only when ids collide. The report says "sometimes".
- roles_admin_guard_01 hides behind the coincidence admin role id == seeded admin user id == 1. The report describes this symptom without ids.
- utils_has_next_page_01 and users_list_page_01 share the users-list flow, but they are in different functions and the symptoms are distinct (flag vs offset).
- mail_new_email_link_01: the wrong constant duplicates the one in userSignUp. The distinguishing signal is the new-email flow.
- auth_uniform_login_01 and forgotPassword both read the same uniformErrors flag. forgotPassword is correct and is listed as a distractor.
- Unused imports: none introduced (the session repository `Not` import is still used).
