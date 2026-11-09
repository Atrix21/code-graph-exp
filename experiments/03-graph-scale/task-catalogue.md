# Experiment 3: task catalogue (DRAFT — nothing here is frozen ground truth)

**Status.** Every task below is a *candidate*. None has passed the independent audit (protocol §3, implementation plan M2.6). Each has a ground-truth *strategy* and, where available, *draft* ground truth from the mining agent.
- **Draft ground truth is mechanical, not audited.** "Fixed functions" map each fix's diff hunks to their enclosing declarations at the parent commit.
- **Nothing was invented.** Bug reports are quoted from public issues; architectural tasks cite code locations in `notes/immich-analysis.md`.

## 1. Sources and pool sizes (measured)

| Repository | Pool | Count | Notes |
|---|---|---:|---|
| M Immich | commits titled `fix`/`revert` touching non-test `server/src`, merged after 2026-06-01 | 163 | 795 before the cutoff, not mined (contamination control) |
| | accepted as behavioural fixes with a changed test | **98** | 37 rejected as not behavioural (dependency bumps, features, docs, migrations only); 28 rejected for having no test |
| | report taken from a linked issue / from PR text / title only | 58 / 30 / 10 | title-only reports are excluded (no symptom) |
| | fixes touching ≥ 2 / ≥ 3 non-test files | 44 / 18 | multi-file defects exist, but the median fix is 1 file |
| | crossing a job/event/DI boundary | 44 | from the agent's boundary labels (unaudited) |
| L Twenty | sample: the 120 most recent merged PRs with "fix" in the title (Sep–Nov 2026) | 120 | `notes/twenty-fix-sample.json` |
| | server-only fixes / with tests / with a linked issue | 28 / 18 / 11 | the external research counted 462 issue-linked PRs since 2026-06-01, so the full pool is much larger than this sample |
| S nestjs-boilerplate | upstream commits titled `fix` touching `src/` (excluding deps, lint, docs, CI) | 34 | many are trivial (types, swagger); ≈ 10 expected to be behavioural (to screen) |

**Honest caveat from mining.** Real historical bugs are **not automatically hard**. The mining agent's BM25 screen (over the post-fix snapshot) put the fixed file in the top 10 for 78 of 97 Immich candidates, and the fixed function in the top 3 for 48. Many real reports describe behaviour in the same words the code uses. The benchmark will therefore contain easy tasks, and results must be reported by difficulty stratum.

## 2. Inclusion rules (method-independent; E3-D10)

A candidate is **excluded** only for reasons that do not depend on any compared method's output:
- the report is title-only;
- the report states the fix mechanism (auditor judgement, for PR-text reports);
- the reported symptom is caused outside the analysed code;
- the ground truth cannot be resolved at the parent commit.

**Never use a retriever's rank or grep result to include, exclude or tier a task.** Selecting tasks on which BM25 fails would bias the benchmark against BM25 and towards everything else. The mining agent's A/B/C tiers use BM25 rank, so they are **not** used for selection.

**Difficulty is computed from query and ground-truth properties only:**
- **easy**: lexical overlap is high (the report contains identifiers from the fixed code);
- **hard**: overlap is low **and** the fix spans ≥ 2 files or layers or crosses a job/event/DI boundary;
- **medium**: everything else.

**Final selection.** Seeded stratified sampling from the audited eligible pool, oversampling hard tasks so that the cross-module stratum has ≥ 50% (protocol §4.3). On all 98 Immich candidates the rule gives 42 hard, 37 medium and 19 easy. On the 58 issue-based ones it gives 29 hard, 16 medium and 13 easy.

## 3. Immich (M): target 40 tasks (10 dev / 30 test)

Composition target:
- **24 historical bug-localisation tasks (A):** about 12 hard, 8 medium, 4 easy.
- **16 understanding tasks (B–E):** drawn from T1–T15, plus one more data-flow task authored in M2.4.

### 3.1 Category A candidates: historical bugs with issue-written reports

Ground-truth strategy:
- **Root cause:** the non-test functions changed by the fix, plus the files.
- **Relevant symbols:** the root cause plus the functions on the path from the entry point, written by the annotator.
- **Alternatives:** functions the fix could equally have changed, also from the annotator.
- **Distractors:** look-alike code chosen by the annotator.
- **Evidence:** the fix commit and the test it added (FAIL_TO_PASS checked at the parent commit where tests run).
- **Snapshot:** either a revert of the fix on the pinned snapshot (when it applies cleanly) or a checkout of the parent commit.

Confounders:
- Memorisation: the repository is public and popular.
- Reports whose symptom is far from the fix (#29303, #29267, #31479 were flagged by the agent).
- Module-level fixes (DTO schemas, `validation.ts`) need file-level scoring.

The 58 issue-based candidates, ordered by difficulty (columns from `notes/immich-bug-candidates.jsonl`):

| # | PR (issue) | Symptom (issue title, verbatim) | Fix files / layers | Fixed functions (mechanical, unaudited) | Boundary | Lexical overlap | Difficulty | Snapshot route |
|---:|---|---|---:|---|---|---|---|---|
| 1 | [#30692](https://github.com/immich-app/immich/pull/30692) (#30685) | Album isn't getting deleted when owner is deleted | 4 / 1 | module-level, module-level (+3) | db | low | hard | parent commit |
| 2 | [#29303](https://github.com/immich-app/immich/pull/29303) (#29217) | [v3.0.0-rc2] After cropping, OCR results are still positioned as in origina | 3 / 1 | (new file), (new file) (+2) | db | low | hard | parent commit |
| 3 | [#32164](https://github.com/immich-app/immich/pull/32164) (#32082) | Memories are released at midnight UTC instead of server local time | 2 / 2 | module-level, MemoryRepository.searchBuilder (+1) | db | low | hard | parent commit |
| 4 | [#32114](https://github.com/immich-app/immich/pull/32114) (#32024) | [v3.3.0-rc.1] People with no shared assets are shown to other users in 'Peo | 2 / 2 | module-level, PersonRepository.getAllForUser (+2) | db | low | hard | parent commit |
| 5 | [#29028](https://github.com/immich-app/immich/pull/29028) (#22261) | Partner can see a 'map marker' on their own map showing the location of my  | 2 / 2 | MapRepository.getMapMarkers, MapService.getMapMarkers | db | low | hard | revert on pinned snapshot (clean) |
| 6 | [#32609](https://github.com/immich-app/immich/pull/32609) (#27545) | "Assets cannot be added to the album" error when adding partner photos to a | 1 / 1 | checkOtherAccess | di | low | hard | revert on pinned snapshot (clean) |
| 7 | [#29757](https://github.com/immich-app/immich/pull/29757) (#29662) | Email notification (for Album updated) does not alert when photos added fro | 1 / 1 | AssetMediaService.addToSharedLink | event | low | hard | parent commit |
| 8 | [#32577](https://github.com/immich-app/immich/pull/32577) (#32484) | OCR lost from search when image is rotated | 2 / 2 | OcrRepository.updateOcrVisibilities, module-level (+1) | job | low | hard | revert on pinned snapshot (fuzzy(-C1)) |
| 9 | [#31970](https://github.com/immich-app/immich/pull/31970) (#23619) | External library exclusion patterns with multiple extensions not work | 2 / 2 | AssetRepository.detectOfflineExternalAssets, LibraryService.handleSyncAssets | job | low | hard | parent commit |
| 10 | [#31425](https://github.com/immich-app/immich/pull/31425) (#23792) | Bulk removal of tags does not update the XMP sidecar files. | 2 / 2 | TagRepository.upsertValue, TagService.update (+2) | job | low | hard | revert on pinned snapshot (clean) |
| 11 | [#31240](https://github.com/immich-app/immich/pull/31240) (#28966) | Immich does not detect faces in rotated photos with no rotation metadata | 2 / 2 | AssetJobRepository.getForDetectFacesJob, PersonService.handleDetectFaces | job | low | hard | parent commit |
| 12 | [#31074](https://github.com/immich-app/immich/pull/31074) (#30933) | Stale untracked integrity report can delete a now-tracked original file | 2 / 2 | IntegrityRepository.getAssetCount, IntegrityService.deleteIntegrityReport (+2) | job | low | hard | revert on pinned snapshot (clean) |
| 13 | [#29737](https://github.com/immich-app/immich/pull/29737) (#29728) | Scanning Missing Files Does Not Clear Outdated Reports After Asset Path Cha | 2 / 2 | IntegrityRepository.streamAssetPaths, IntegrityService.handleMissingFilesQueueAll | job | low | hard | revert on pinned snapshot (fuzzy(-C1)) |
| 14 | [#29516](https://github.com/immich-app/immich/pull/29516) (#29487) | checksum integrity job doesn't actually resume from checkpoint (processes 0 | 2 / 2 | IntegrityRepository.streamAssetChecksums, IntegrityService.handleChecksumFiles | job | low | hard | revert on pinned snapshot (clean) |
| 15 | [#29333](https://github.com/immich-app/immich/pull/29333) (#28991) | Some face regions imported from tags are failing because of NaN | 2 / 2 | module-level, MetadataService.orientRegionInfo (+1) | job | low | hard | revert on pinned snapshot (fuzzy(-C1)) |
| 16 | [#32474](https://github.com/immich-app/immich/pull/32474) (#27895) | AMD VAAPI encoding fails during software-decode fallback due to missing for | 1 / 1 | BaseConfig.getToneMapping, QsvSwDecodeConfig.getPresetOptions (+1) | job | low | hard | revert on pinned snapshot (clean) |
| 17 | [#32300](https://github.com/immich-app/immich/pull/32300) (#31332) | Edited assets are skipped by a full Smart Search re-index and never get an  | 1 / 1 | SmartInfoService.handleEncodeClip | job | low | hard | revert on pinned snapshot (clean) |
| 18 | [#32240](https://github.com/immich-app/immich/pull/32240) (#32083) | Workflow actions still run after a filter step halts the run (workflow_log  | 1 / 1 | WorkflowRepository.getForWorkflowRun | job | low | hard | revert on pinned snapshot (clean) |
| 19 | [#32182](https://github.com/immich-app/immich/pull/32182) (#32180) | Wrong ISO value being parsed from asset matadata | 1 / 1 | MetadataService.handleMetadataExtraction | job | low | hard | parent commit |
| 20 | [#31473](https://github.com/immich-app/immich/pull/31473) (#22294) | Incorrect video scaling for rotated videos during transcoding on QSV hardwa | 1 / 1 | module-level, isVideoVertical (+5) | job | low | hard | revert on pinned snapshot (clean) |
| 21 | [#31319](https://github.com/immich-app/immich/pull/31319) (#22985) | Job Transcode Videos doesn't transcode Live Photos | 1 / 1 | AssetJobRepository.streamForVideoConversion | job | low | hard | revert on pinned snapshot (clean) |
| 22 | [#29354](https://github.com/immich-app/immich/pull/29354) (#16151) | [BUG] Stacks not removed on Library deletion | 1 / 1 | AssetService.handleAssetDeletion | job | low | hard | revert on pinned snapshot (fuzzy(-C1)) |
| 23 | [#29248](https://github.com/immich-app/immich/pull/29248) (#29219) | [v3.0.0-rc2] Integrity report shows all external library assets as having a | 1 / 1 | IntegrityRepository.streamAssetChecksums | job | low | hard | parent commit |
| 24 | [#29240](https://github.com/immich-app/immich/pull/29240) (#29220) | Real Time Transcoding buffers outside LAN with QSV | 1 / 1 | QsvSwDecodeConfig.getBitrateOptions | job | low | hard | revert on pinned snapshot (fuzzy(-C1)) |
| 25 | [#30024](https://github.com/immich-app/immich/pull/30024) (#29514) | Immich fails to import a media with the empty filename (there is just an ex | 4 / 2 | AssetMediaService.getUploadFilename, StorageTemplateService.getTemplatePath (+5) | none | low | hard | parent commit |
| 26 | [#32219](https://github.com/immich-app/immich/pull/32219) (#32214) | People Sharing: "No people" | 2 / 1 | PersonService.getAll, PersonService.getStatistics (+1) | none | low | hard | revert on pinned snapshot (fuzzy(-C1)) |
| 27 | [#28810](https://github.com/immich-app/immich/pull/28810) (#28091) | Birth dates keep being changed to one day earlier | 9 / 4 | mapAlbum, mapAsset (+10) | other | low | hard | parent commit |
| 28 | [#31418](https://github.com/immich-app/immich/pull/31418) (#17790) | External library watching includes excluded folders | 2 / 2 | module-level, StorageRepository.watch (+1) | other | low | hard | parent commit |
| 29 | [#31461](https://github.com/immich-app/immich/pull/31461) (#31415) | Sync v2 leaks Postgres connections eventually starving the pool | 2 / 2 | module-level, send (+2) | other | low | hard | parent commit |
| 30 | [#31424](https://github.com/immich-app/immich/pull/31424) (#31414) | [Bug]: Resetting facial recognition triggers REINDEX TABLE asset_face locki | 4 / 2 | DatabaseRepository.reindexVectors, DatabaseRepository.runMigrations (+7) | db | medium | medium | parent commit |
| 31 | [#32612](https://github.com/immich-app/immich/pull/32612) (#29835) | Folder view on mobile shows assets from other folders | 1 / 1 | module-level, ViewRepository.getAssetsByOriginalPath | db | low | medium | parent commit |
| 32 | [#31479](https://github.com/immich-app/immich/pull/31479) (#31475) | iPhone Live Photo HEVC MOV files fail thumbnail generation despite valid HE | 1 / 1 | SearchRepository.searchLargeAssets | db | low | medium | revert on pinned snapshot (clean) |
| 33 | [#31533](https://github.com/immich-app/immich/pull/31533) (#31321) | Person thumbnail can't be updated after deleting and redrawing a face | 1 / 1 | PersonRepository.getForFeatureFaceUpdate | db | medium | medium | revert on pinned snapshot (clean) |
| 34 | [#29267](https://github.com/immich-app/immich/pull/29267) (#22522) | [iOS] SqliteException(2067): UNIQUE constraint failed in remote_asset_entit | 1 / 1 | BaseSync.backfillQuery | db | low | medium | revert on pinned snapshot (clean) |
| 35 | [#32938](https://github.com/immich-app/immich/pull/32938) (#32870) | ISO value becomes 0 after upgrading to v3.3.5 | 1 / 1 | MetadataService.handleMetadataExtraction | job | medium | medium | revert on pinned snapshot (clean) |
| 36 | [#29908](https://github.com/immich-app/immich/pull/29908) (#29817) | [v.3.0.x] Transcoded hevc with wrong codec tag [hev1], breaks playback on a | 1 / 1 | BaseConfig.getBaseOutputOptions | job | medium | medium | revert on pinned snapshot (fuzzy(-C1)) |
| 37 | [#30431](https://github.com/immich-app/immich/pull/30431) (#30413) | `CreatePartner` Restful API accepts soft-deleted users | 1 / 1 | PartnerService.create | none | medium | medium | revert on pinned snapshot (fuzzy(-C1)) |
| 38 | [#28884](https://github.com/immich-app/immich/pull/28884) (#28880) | `addUsersToAlbum` fails if any user is already a member | 1 / 1 | AlbumService.addUsers | none | low | medium | revert on pinned snapshot (fuzzy(-C1)) |
| 39 | [#29035](https://github.com/immich-app/immich/pull/29035) (#27687) | Wrong album association (and fav flag added not wanted) after using dedupli | 1 / 1 | DuplicateService.resolveGroup | none | low | medium | revert on pinned snapshot (clean) |
| 40 | [#31901](https://github.com/immich-app/immich/pull/31901) (#28091) | Birth dates keep being changed to one day earlier | 1 / 1 | module-level | other | low | medium | revert on pinned snapshot (clean) |
| 41 | [#31098](https://github.com/immich-app/immich/pull/31098) (#31050) | [Bug] iOS app: "Error while creating shared link" — server rejects `expires | 1 / 1 | module-level | other | low | medium | revert on pinned snapshot (clean) |
| 42 | [#29244](https://github.com/immich-app/immich/pull/29244) (#27966) | Portrait images are not rendered properly in some cases | 1 / 1 | MetadataRepository.exiftool [property] | other | low | medium | parent commit |
| 43 | [#30871](https://github.com/immich-app/immich/pull/30871) (#30862) | Validation failed: email: Invalid input: expected email, received string | 1 / 1 | module-level | other | low | medium | parent commit |
| 44 | [#29739](https://github.com/immich-app/immich/pull/29739) (#29717) | birth date value | 1 / 1 | module-level | other | low | medium | parent commit |
| 45 | [#29138](https://github.com/immich-app/immich/pull/29138) (#29107) | External library scan cron expression with slash in middle positions (e.g., | 1 / 1 | module-level | other | low | medium | parent commit |
| 46 | [#29385](https://github.com/immich-app/immich/pull/29385) (#29359) | Parameter "visibility" doesn't apply correctly to POST "/search/metadata" e | 3 / 3 | module-level, SearchService.searchMetadata (+4) | db | high | easy | parent commit |
| 47 | [#32009](https://github.com/immich-app/immich/pull/32009) (#31872) | Different users of `robot` and `ro.bot` conflict after code `sanitize(label | 3 / 2 | AuthService.formatStorageLabel, BaseService.createUser (+1) | di | high | easy | parent commit |
| 48 | [#31145](https://github.com/immich-app/immich/pull/31145) (#31117) | [v3.2.0-rc.1] people disappear from account when merged by another user in  | 2 / 2 | PersonRepository.reassignFaces, PersonService.handleQueueRecognizeFaces | job | high | easy | parent commit |
| 49 | [#30851](https://github.com/immich-app/immich/pull/30851) (#30824) | Failed database backup leaks its pg_dump connection, holding AccessShareLoc | 2 / 2 | ProcessRepository.spawnDuplexStream [insertion], DatabaseBackupService.createDatabaseBackup | job | high | easy | parent commit |
| 50 | [#30850](https://github.com/immich-app/immich/pull/30850) (#28178) | Library scan silently soft-deletes ALL assets when exclusionPatterns contai | 2 / 2 | AssetRepository.detectOfflineExternalAssets, module-level (+2) | job | high | easy | parent commit |
| 51 | [#30512](https://github.com/immich-app/immich/pull/30512) (#30492) | JPEG failed thumbnail generation and wrong aspect ratio | 2 / 2 | module-level, getLensModel | job | high | easy | revert on pinned snapshot (clean) |
| 52 | [#31102](https://github.com/immich-app/immich/pull/31102) (#30657) | Bug: Integrity check reports false positives for assets with non-ASCII file | 1 / 1 | IntegrityService.handleUntrackedFiles | job | high | easy | revert on pinned snapshot (clean) |
| 53 | [#30759](https://github.com/immich-app/immich/pull/30759) (#30331) | DB backup job cannot start if PostgreSQL is connected via DB_URL for Unix d | 1 / 1 | DatabaseBackupService.buildPostgresLaunchArguments | job | high | easy | revert on pinned snapshot (clean) |
| 54 | [#30837](https://github.com/immich-app/immich/pull/30837) (#30827) | LibrarySyncFiles crashes entire batch with PostgresError: syntax error at o | 1 / 1 | AssetRepository.createAll | job | high | easy | revert on pinned snapshot (clean) |
| 55 | [#32567](https://github.com/immich-app/immich/pull/32567) (#32469) | Creating a notification requires "all" permission | 1 / 1 | NotificationAdminController.createNotification, NotificationAdminController.sendTestEmailAdmin (+1) | none | high | easy | revert on pinned snapshot (clean) |
| 56 | [#29883](https://github.com/immich-app/immich/pull/29883) (#29857) | Album takeover / role-management privilege escalation by a shared Editor (b | 1 / 1 | AlbumService.updateUser | none | high | easy | parent commit |
| 57 | [#30908](https://github.com/immich-app/immich/pull/30908) (#30889) | OIDC: data: URI in the `picture` claim kills the API worker on every login  | 2 / 2 | OAuthRepository.getProfilePicture, AuthService.syncProfilePicture | other | high | easy | revert on pinned snapshot (fuzzy(-C1)) |
| 58 | [#30764](https://github.com/immich-app/immich/pull/30764) (#29925) | Sync v2 stream has no backpressure — `send()` ignores `response.write()`'s  | 1 / 1 | module-level, send (+25) | other | high | easy | parent commit |

A further 30 candidates have PR-text reports. They are eligible only if the auditor finds no fix mechanism stated in the report; the agent judged 27 of them to leak the mechanism.

### 3.2 Categories B–E candidates (architecture-grounded; details and draft ground truth in `notes/immich-analysis.md` §4)

| ID | Cat. | Task (as given to the agent; identifiers avoided) | Expected complexity | Ground-truth strategy and independent check | Main confounders |
|---|---|---|---|---|---|
| T1 | B | Which background stages run for an uploaded photo until it is searchable, assigned to people and checked for near-duplicates, and what triggers each stage? | ≥ 8 steps; HTTP → 2 events → job chain → ML service | ordered path with code locations; check: job-chain unit tests (`job.service.spec.ts`), the event payload types | partially documented in Immich docs; long answer and partial credit needed |
| T5 | B | When is a new face attached to a person, used to create a person, or postponed, and why can two recognition jobs not corrupt each other? | 1 service, DB lock, deferred re-queue | code reading; check: `person.service.spec.ts` recognition cases | answer concentrated in one method (could be easy) |
| T8 | B | What happens from an external-library scan until the files are searchable, including excluded paths? | job chain + SQL pattern + picomatch; shares the T1 tail | path; check: PRs #32081, #31970, #30850 and the medium library test | overlaps with T1 |
| T12 | B | How does the server decide whether and how to transcode a video, and what happens if hardware acceleration fails? | job → strategy classes per vendor → retry | path; check: `media.service.spec.ts` transcoding cases; PRs #32474, #29908 | vendor-class hierarchy is large; partial answers |
| T13 | B | What happens to a photo that has been in the trash longer than the retention period, including its files, stack and live-photo partner? | nightly job → per-asset jobs → event → file-delete jobs | path; check: asset deletion tests; PR #29354 | — |
| T2 | C | If the optional "origin" field of the post-metadata event were removed, what must change and which tests notice? | type + emitter + 3 listeners + job payloads | **executable oracle**: remove the field at the snapshot, run the type checker and unit tests | listeners that read it only indirectly |
| T6 | C | What must a developer change to add a new asynchronous task, and what protects against forgetting a step? | enum + union type + decorator + registry + startup validation | code reading; check: add a dummy job in a scratch copy, observe the startup-validation error and type errors | documented in contributor docs? (check) |
| T15 | C | If bulk asset insertion stopped returning the new ids, which flows break? | 1 repository method → callers | **executable oracle**: change the return type and run the type checker | small; kept as a compile-oracle control |
| T3 | D | Trace how a natural-language search sentence becomes an ordered list of photos, and where the heavy computation happens. | HTTP → service → ML HTTP → vector SQL; cache; ML failover | path; check: smart-search unit and medium tests | the "ML" wording hints at the ML repository |
| T7 | D | Why does each album member receive at most one "new media" email when photos are added over ten minutes, and where does the delay come from? | event → debounced delayed job (job id reuse) | path; check: `notification.service.spec.ts`; PRs #29757, #30120 | — |
| T11 | D | A visitor with a public share link requests a photo's original file: walk through every check that decides access. | guard → auth → service → access utilities → repository | path; check: access unit tests, and a runtime trace of the e2e/medium test | — |
| T4 | E | How does the job-running process learn about a concurrency change made through the admin UI, given that the request is served by another process? | event → websocket relay over Redis → re-emit in the worker → queue | path; check: `queue.service.spec.ts`; code reading | cross-process: genuinely hard for grep |
| T9 | E | With several server containers, how is nightly maintenance scheduled exactly once, and what is scheduled? | DB lock + cron + config events | code reading; check: `queue.service.spec.ts` nightly-jobs test | — |
| T10 | E | If every ML server became unreachable, which features keep working, which background work fails, and how does it surface? | 4 callers + job error path + cache | code reading; check: ML-repository failover tests | answer is a set with partial credit |
| T14 | E | Which process serves HTTP, which executes jobs, how do they find each other, and what is observable if the second is missing? | bootstrap + Redis + worker watch | code reading | partly in deployment docs |

## 4. Twenty (L): target 40 tasks (10 dev / 30 test); mining is milestone M2.4

Not yet mined task by task. The table below is the factual sample of recent server-only fix PRs. Ground truth comes from each PR's diff, and its tests serve as the FAIL_TO_PASS check. Most Twenty fixes are by the maintainers and fewer link a user issue (11 of 28), so many reports would come from PR text. Those need a leakage audit, and if no symptom-only text exists the task is dropped rather than rewritten.

| PR | Title (verbatim) | Merged | Non-test server files | Test files | Linked issue | Top-level areas touched |
|---|---|---|---:|---:|---|---|
| [#29395](https://github.com/twentyhq/twenty/pull/29395) | Fix sent Outlook drafts staying as drafts | 2026-11-07 | 11 | 1 | #28373 | database/commands; engine/metadata-modules; modules/messaging |
| [#29546](https://github.com/twentyhq/twenty/pull/29546) | fix(CommonAPI): cap GraphQL find-many page size at QUERY_MAX_RECORDS | 2026-11-04 | 9 | 3 | — | engine/api; engine/core-modules; modules/emailing |
| [#27977](https://github.com/twentyhq/twenty/pull/27977) | Fix date-sorted pagination skipping or duplicating records | 2026-10-16 | 7 | 5 | #27804 | engine/api; engine/twenty-orm |
| [#28435](https://github.com/twentyhq/twenty/pull/28435) | fix(billing): drop billingPrice.stripeMeterId before dropping billingMeter | 2026-10-20 | 4 | 3 | — | database/commands; engine/core-modules |
| [#27639](https://github.com/twentyhq/twenty/pull/27639) | Fix changing a workflow node into an Iterator | 2026-10-08 | 3 | 1 | — | engine/core-modules; modules/workflow |
| [#28683](https://github.com/twentyhq/twenty/pull/28683) | Fix logic functions staying on the old SDK after it is regenerated | 2026-10-23 | 3 | 0 | — | engine/core-modules |
| [#27767](https://github.com/twentyhq/twenty/pull/27767) | Fix cascade-before-update ordering in workspace migrations | 2026-10-11 | 2 | 4 | — | engine/workspace-manager |
| [#28084](https://github.com/twentyhq/twenty/pull/28084) | fix(billing): make direct subscription creation idempotent | 2026-10-15 | 2 | 0 | — | engine/core-modules |
| [#28494](https://github.com/twentyhq/twenty/pull/28494) | Fix app sync recreating search rows that already exist | 2026-10-27 | 2 | 2 | #28484 | engine/metadata-modules |
| [#28825](https://github.com/twentyhq/twenty/pull/28825) | fix(dashboard): keep the Not Set group when gap-filling select and da… | 2026-10-30 | 2 | 2 | #28812 | modules/dashboard |
| [#29185](https://github.com/twentyhq/twenty/pull/29185) | fix(permissions): validate row-level predicate operands against the field type | 2026-10-29 | 2 | 5 | — | engine/twenty-orm; engine/workspace-manager |
| [#29193](https://github.com/twentyhq/twenty/pull/29193) | fix(server): report unknown names in learn_tools under notFound | 2026-11-07 | 2 | 2 | #29258 | engine/core-modules |
| [#25882](https://github.com/twentyhq/twenty/pull/25882) | Phone number fix | 2026-09-16 | 1 | 0 | — | engine/core-modules |
| [#27764](https://github.com/twentyhq/twenty/pull/27764) | Fix ordering for view sort replacements | 2026-10-11 | 1 | 1 | — | engine/workspace-manager |
| [#27962](https://github.com/twentyhq/twenty/pull/27962) | MCP: fix soft-delete generated tools | 2026-10-14 | 1 | 1 | #26867 | engine/core-modules |
| [#28414](https://github.com/twentyhq/twenty/pull/28414) | fix(server): route view-derived filters through the filter processor | 2026-10-20 | 1 | 1 | — | engine/api |
| [#28738](https://github.com/twentyhq/twenty/pull/28738) | fix(server): honor Content-Type and preserve falsy HTTP bodies | 2026-10-27 | 1 | 0 | #28737 | engine/core-modules |
| [#28743](https://github.com/twentyhq/twenty/pull/28743) | fix(server): refresh stale workflow version maps before sync | 2026-10-27 | 1 | 0 | #28742 | engine/core-modules |
| [#28770](https://github.com/twentyhq/twenty/pull/28770) | Fix phone number validation (#28764) | 2026-10-28 | 1 | 7 | #28764 | engine/core-modules |
| [#28852](https://github.com/twentyhq/twenty/pull/28852) | Fix follow-redirects in the Workspace upgrade snapshot | 2026-10-26 | 1 | 0 | — | database/commands |
| [#29108](https://github.com/twentyhq/twenty/pull/29108) | fix(oauth): raise authorizeApp state max length to 4096 | 2026-10-28 | 1 | 0 | — | engine/core-modules |
| [#29126](https://github.com/twentyhq/twenty/pull/29126) | fix(currency-field): reject unknown currency codes on currency fields | 2026-10-28 | 1 | 1 | #28761 | engine/api |
| [#29183](https://github.com/twentyhq/twenty/pull/29183) | fix(merge): reject non-UUID ids and a missing conflict priority index | 2026-10-29 | 1 | 1 | — | engine/api |
| [#29244](https://github.com/twentyhq/twenty/pull/29244) | fix(server): rebuild ORM table shapes after a field rename | 2026-10-30 | 1 | 1 | — | engine/twenty-orm |
| [#29754](https://github.com/twentyhq/twenty/pull/29754) | Fix duplicated CalDAV events created from Twenty | 2026-11-05 | 1 | 2 | #29720 | modules/calendar |
| [#29846](https://github.com/twentyhq/twenty/pull/29846) | Fix undefined assistantParticipationInput in chat message sender | 2026-11-06 | 1 | 0 | — | engine/metadata-modules |
| [#29847](https://github.com/twentyhq/twenty/pull/29847) | Fix undefined assistantParticipationInput in member message sender | 2026-11-06 | 1 | 0 | — | engine/metadata-modules |
| [#29954](https://github.com/twentyhq/twenty/pull/29954) | Fix server typecheck on main for application grant field permissions | 2026-11-08 | 1 | 0 | — | engine/core-modules |

Understanding tasks (B–E) for Twenty will be grounded in the same way as Immich's, by an analysis pass in M2.4. The measured structure suggests the themes but supplies **no** ground truth yet:
- the workflow engine (381 files under `modules/workflow`);
- message-queue jobs (129 `@Processor` handlers);
- database-batch event listeners (55 `@OnDatabaseBatchEvent`);
- the GraphQL resolver → query runner → ORM → permission-check path (245 queries, 358 mutations);
- metadata changes propagating into ORM table shapes (fix #29244).

## 5. nestjs-boilerplate (S)

- **Experiment-1 tasks.** The 20 frozen experiment-1 tasks (injected, mostly lexically anchored) are kept as the anchor to experiments 1–2.
- **Historical tasks.** About 10 historical fixes from the upstream history, screened from 34 `fix` commits with the same rules, make S comparable to M and L on task type.
- **Understanding tasks.** S gets no B–E tasks: at 6k lines, experiment 2 showed an agent reads everything it needs.
