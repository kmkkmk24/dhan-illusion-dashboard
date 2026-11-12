"""Login, roles, credential routes and seed-user behaviour through the real app middleware."""

import pytest
from fastapi.testclient import TestClient

import backend.app as appmod
import backend.models.tables as T
from backend.api import auth as auth_api
from backend.models.database import get_db
from backend.services import auth_service
from backend.services import token_manager as tm
from backend.services.auth_service import ensure_seed_users, hash_password, verify_password


@pytest.fixture
def app_db(SessionLocal, monkeypatch):
    s = SessionLocal()
    s.add_all([
        T.AppUser(username="adm", password_hash=hash_password("pw-a"), role="admin", is_active=True),
        T.AppUser(username="ro", password_hash=hash_password("pw-r"), role="readonly", is_active=True),
    ])
    s.commit()
    s.close()

    def override():
        d = SessionLocal()
        try:
            yield d
        finally:
            d.close()

    monkeypatch.setattr(appmod, "get_session_factory", lambda: SessionLocal)
    appmod.app.dependency_overrides[get_db] = override
    auth_api._failures.clear()

    async def fake_renew(force=False):
        return {"success": True, "action": "renewed", "method": "renew"}

    monkeypatch.setattr(tm, "renew_token", fake_renew)
    yield SessionLocal
    appmod.app.dependency_overrides.clear()


def login(user, pw):
    c = TestClient(appmod.app)
    r = c.post("/api/auth/login", json={"username": user, "password": pw})
    assert r.json()["success"], r.text
    return c


def test_unauthenticated_api_is_401(app_db):
    assert TestClient(appmod.app).get("/api/settings/credentials/status").status_code == 401


@pytest.mark.parametrize("method,path", [
    ("get", "/api/settings/credentials/status"),
    ("get", "/api/settings/credentials/export"),
    ("post", "/api/settings/token/refresh"),
    ("post", "/api/settings/credentials/generate-token"),
    ("post", "/api/settings/backup/now"),
])
def test_readonly_blocked_from_sensitive_routes(app_db, method, path):
    ro = login("ro", "pw-r")
    assert getattr(ro, method)(path).status_code == 403


def test_debug_credentials_endpoint_removed(app_db):
    assert login("adm", "pw-a").get("/api/settings/debug/credentials").status_code == 404


def test_admin_credential_status_is_masked(app_db):
    from backend.services.settings_manager import settings_manager

    settings_manager.save_credentials({"client_id": "1", "api_key": "KEY-123456789", "api_secret": "SEC-987654321",
                                       "pin": "123456", "totp_secret": "JBSWY3DPEHPK3PXPJBSWY3DP"})
    r = login("adm", "pw-a").get("/api/settings/credentials/status")
    assert r.status_code == 200 and r.json()["configured"] is True
    for secret in ("123456", "KEY-123456789", "SEC-987654321", "JBSWY3DPEHPK3PXPJBSWY3DP"):
        assert secret not in r.text


def test_admin_token_routes_return_no_token(app_db):
    adm = login("adm", "pw-a")
    for path in ("/api/settings/token/refresh", "/api/settings/credentials/generate-token"):
        r = adm.post(path)
        assert r.status_code == 200 and r.json()["success"]
        assert "token_preview" not in r.json() and "new_token" not in r.json()


def test_token_status_reports_state_without_token(app_db, monkeypatch):
    monkeypatch.setenv("DHAN_ACCESS_TOKEN", "TOK-SECRET-VALUE")
    monkeypatch.setattr(tm, "_last_result", {"success": True, "action": "renewed", "method": "renew",
                                              "at": "2026-11-08T06:00:00+05:30", "message": "x"})
    async def fake_health(*a, **k):  # offline: don't ask Dhan about a fake token
        return {"valid": True, "reason": None, "hours_left": 20.0}

    monkeypatch.setattr(tm, "token_health", fake_health)
    r = login("adm", "pw-a").get("/api/settings/token/status")
    assert r.status_code == 200
    body = r.json()
    assert body["has_token"] is True and body["last"]["method"] == "renew"
    assert body["valid"] is True and body["hours_left"] == 20.0
    assert "TOK-SECRET-VALUE" not in r.text and "message" not in body["last"]


def test_login_throttled_after_repeated_failures(app_db):
    c = TestClient(appmod.app)
    for _ in range(5):
        assert c.post("/api/auth/login", json={"username": "adm", "password": "x"}).json()["success"] is False
    r = c.post("/api/auth/login", json={"username": "adm", "password": "pw-a"})
    assert r.status_code == 429


def test_plaintext_stored_password_not_accepted():
    assert verify_password("admin123", "admin123") is False


def test_seed_does_not_reset_existing_passwords(db):
    db.add(T.AppUser(username="admin", password_hash=hash_password("changed"), role="admin", is_active=True))
    db.commit()
    ensure_seed_users(db)
    u = db.query(T.AppUser).filter_by(username="admin").one()
    assert verify_password("changed", u.password_hash)
    assert not verify_password("admin123", u.password_hash)


def test_seed_creates_users_on_empty_db(db):
    ensure_seed_users(db)
    assert db.query(T.AppUser).count() >= 1


def test_token_status_shows_rejection_reasons_without_secrets(app_db, monkeypatch):
    monkeypatch.setenv("DHAN_ACCESS_TOKEN", "TOK-SECRET-VALUE")
    monkeypatch.setattr(tm, "_last_result", {"success": False, "action": "failed", "message": "free text",
                                              "reasons": ["RenewToken → HTTP 400: DH-906 Invalid Token"]})

    async def rejected(*a, **k):
        return {"valid": False, "reason": "DH-906 Invalid Token", "hours_left": None}

    monkeypatch.setattr(tm, "token_health", rejected)
    body = login("adm", "pw-a").get("/api/settings/token/status").json()
    assert body["valid"] is False and body["reason"] == "DH-906 Invalid Token"
    assert body["last"]["reasons"] == ["RenewToken → HTTP 400: DH-906 Invalid Token"]
    assert "message" not in body["last"] and "TOK-SECRET-VALUE" not in str(body)


def test_dhan_error_text_redacts_pin_and_tokens():
    from backend.services.dhan_client import _dhan_error_text, _extract_token

    jwt = "eyJhbGciOiJIUzUxMiJ9." + "a" * 40 + "." + "b" * 40
    assert "123456" not in _dhan_error_text("bad request for url ...?pin=123456&totp=000111")
    assert jwt not in _dhan_error_text({"errorCode": "DH-906", "errorMessage": "Invalid Token " + jwt})
    assert _dhan_error_text({"errorCode": "DH-906", "errorMessage": "Invalid Token"}) == "DH-906 Invalid Token"
    assert _extract_token({"data": {"access_token": jwt}}) == jwt
    assert _extract_token({"accessToken": jwt}) == jwt and _extract_token({"status": "error"}) is None
