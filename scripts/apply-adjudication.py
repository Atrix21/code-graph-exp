"""Apply the lead's adjudication of evaluation/dataset/AUDIT.md (see ADJUDICATION.md). Idempotent.
Run once, before the dataset freeze and before any comparative evaluation."""
import json, pathlib
D = pathlib.Path(__file__).resolve().parent.parent / "evaluation/dataset/tasks"
A = "src/auth/auth.service.ts::AuthService."
UR = "src/users/infrastructure/persistence/relational/repositories/user.repository.ts::UsersRelationalRepository."
UM = "src/users/infrastructure/persistence/relational/mappers/user.mapper.ts::UserMapper."

def edit(tid, fn):
    p = D / f"{tid}.json"
    t = json.loads(p.read_text())
    fn(t)
    rel = t["relevant_symbols"]
    t["relevant_files"] = sorted({k.split("::")[0] for k in rel})
    t["distractor_symbols"] = [k for k in t.get("distractor_symbols", []) if k not in rel]
    # ROUTES_TO is reserved for route -> handler; controller -> service is a CALLS edge.
    t["expected_relationships"] = [[a, "CALLS" if r == "ROUTES_TO" else r, b] for a, r, b in t.get("expected_relationships", [])]
    t.setdefault("adjudication", [])
    p.write_text(json.dumps(t, indent=2) + "\n")

def rm(t, *keys):
    for k in keys:
        assert k in t["relevant_symbols"], (t["task_id"], k)
        t["relevant_symbols"].remove(k)
    t["expected_relationships"] = [e for e in t.get("expected_relationships", []) if e[0] not in keys and e[2] not in keys]

def add(t, *keys):
    for k in keys:
        if k not in t["relevant_symbols"]:
            t["relevant_symbols"].append(k)

def note(t, s):
    t.setdefault("adjudication", [])
    if s not in t["adjudication"]:
        t["adjudication"].append(s)

def jwt(t):
    rm(t, "src/auth/strategies/jwt.strategy.ts::JwtStrategy.validate", "src/auth/auth.controller.ts::AuthController.me")
    note(t, "removed JwtStrategy.validate (not reached on signature failure) and AuthController.me (one of ~15 equivalent guarded routes)")
edit("auth_jwt_secret_01", jwt)

def refresh_expiry(t):
    rm(t, "src/auth/strategies/jwt-refresh.strategy.ts::JwtRefreshStrategy.validate", "src/auth/config/auth.config.ts::EnvironmentVariablesValidator.AUTH_REFRESH_TOKEN_EXPIRES_IN")
    note(t, "removed JwtRefreshStrategy.validate and the config validator property (not on the cause path; READS edge absent in buggy code)")
edit("auth_refresh_expiry_01", refresh_expiry)

def reset_link(t):
    t["lexical_overlap"] = "high"; t["difficulty"] = "medium"
    note(t, "overlap low->high, difficulty hard->medium: the unchanged upstream comment in getForgotSecret matches the report wording (kept: it is genuine upstream code)")
edit("auth_reset_link_reuse_01", reset_link)

def reset_sessions(t):
    rm(t, "src/session/infrastructure/persistence/relational/repositories/session.repository.ts::SessionRelationalRepository.deleteByUserId")
    t["expected_relationships"] = [e for e in t["expected_relationships"] if not (e[0].endswith("AuthService.resetPassword") and e[2].endswith("SessionService.deleteByUserId"))]
    t["missing_in_buggy_code"] = [[A + "resetPassword", "CALLS", "src/session/session.service.ts::SessionService.deleteByUserId"]]
    t["lexical_overlap"] = "medium"
    note(t, "removed SessionRelationalRepository.deleteByUserId (padding); the resetPassword->deleteByUserId call is the removed call, recorded under missing_in_buggy_code; overlap low->medium")
edit("auth_reset_sessions_01", reset_sessions)

def social(t):
    rm(t, A + "validateLogin")
    note(t, "removed validateLogin (symptom surface, not on cause path); description kept: with single-bug snapshots every clause is reproducible")
edit("auth_social_link_01", social)

def email_dup(t):
    rm(t, A + "confirmNewEmail")
    add(t, "src/mail/mail.service.ts::MailService.confirmNewEmail")
    note(t, "replaced AuthService.confirmNewEmail (link consumer, not on path) with MailService.confirmNewEmail (sends the mail in the report)")
edit("auth_update_email_dup_01", email_dup)

def photo_url(t):
    rm(t, "src/users/users.service.ts::UsersService.findById", A + "me", UM + "toDomain")
    note(t, "removed generic pass-through symbols")
edit("files_photo_url_01", photo_url)

def roles(t):
    rm(t, "src/users/users.controller.ts::UsersController.findAll")
    add(t, "src/users/users.controller.ts::UsersController")
    t["expected_relationships"] = [["src/users/users.controller.ts::UsersController", "CHECKS", "src/roles/roles.guard.ts::RolesGuard.canActivate"]] + t["expected_relationships"]
    t["lexical_overlap"] = "medium"
    note(t, "guard/roles decorators are class-level -> anchor is UsersController, not findAll; overlap low->medium")
edit("roles_admin_guard_01", roles)

def pw_change(t):
    rm(t, A + "refreshToken"); note(t, "removed refreshToken (symptom surface)")
edit("session_password_change_01", pw_change)

def replay(t):
    rm(t, "src/auth/strategies/jwt-refresh.strategy.ts::JwtRefreshStrategy.validate")
    t["lexical_overlap"] = "low"
    note(t, "removed JwtRefreshStrategy.validate (not involved in hash check); overlap medium->low")
edit("session_refresh_replay_01", replay)

def mapper(t):
    add(t, UR + "update"); note(t, "added UsersRelationalRepository.update (second caller of toPersistence described in the report); overlap low->medium")
    t["lexical_overlap"] = "medium"
edit("users_mapper_lastname_01", mapper)

def noop(t):
    rm(t, UM + "toPersistence"); add(t, UM + "toDomain")
    t["expected_relationships"].append([UR + "update", "CALLS", UM + "toDomain"])
    note(t, "replaced UserMapper.toPersistence with UserMapper.toDomain (the spread operand that wins)")
edit("users_update_noop_01", noop)

def has_next(t):
    rm(t, "src/users/users.service.ts::UsersService.findManyWithPagination")
    t["lexical_overlap"] = "high"
    note(t, "removed UsersService.findManyWithPagination (unrelated to the flag); overlap low->high")
edit("utils_has_next_page_01", has_next)

def photo_cleared(t):
    t["description"] = t["description"].replace("their avatar picture disappears (photo comes back null)", "their avatar picture disappears")
    t["data_flow"] = [t["data_flow"][0], "UsersRelationalRepository.update applies the payload over the stored user, so photo=null removes the stored avatar"]
    note(t, "description: dropped 'photo comes back null' (the key is omitted, not null); data_flow[1] corrected; valid under single-bug snapshots")
edit("users_photo_cleared_01", photo_cleared)

for tid in ["auth_uniform_login_01", "files_local_path_01", "files_presigned_size_01", "users_list_page_01", "users_create_provider_01", "mail_new_email_link_01"]:
    edit(tid, lambda t: note(t, "accepted (description valid under single-bug snapshots)" if t["task_id"] in ("users_create_provider_01", "mail_new_email_link_01") else "accepted as-is"))
print("adjudication applied")
