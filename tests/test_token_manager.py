"""Single token service: validate-before-renew, cooldown, lock, persistence, client pickup."""

import asyncio
import os
from datetime import datetime, timedelta

import pytest

import backend.services.dhan_client as dc
from backend.services import token_manager as tm
from backend.services.settings_manager import settings_manager


class FakeTokenDhan:
    profile = None
    renew_ok = True
    totp_ok = True
    calls: list = []

    def __init__(self, *a, **k):
        self.access_token = os.environ.get("DHAN_ACCESS_TOKEN", "")

    async def close(self):
        pass

    async def get_profile(self):
        FakeTokenDhan.calls.append("profile")
        return FakeTokenDhan.profile

    async def renew_token(self):
        FakeTokenDhan.calls.append("renew")
        return {"success": True, "new_token": "TOK-RENEWED"} if FakeTokenDhan.renew_ok else {"success": False}

    async def generate_access_token_with_totp(self, pin, secret):
        FakeTokenDhan.calls.append("totp")
        return {"success": True, "new_token": "TOK-TOTP"} if FakeTokenDhan.totp_ok else {"success": False}


def validity(hours):
    return {"tokenValidity": (datetime.now(tm.IST) + timedelta(hours=hours)).strftime("%d/%m/%Y %H:%M")}


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setattr(dc, "DhanClient", FakeTokenDhan)
    monkeypatch.setenv("DHAN_ACCESS_TOKEN", "TOK-OLD")
    FakeTokenDhan.calls = []
    FakeTokenDhan.profile = None
    FakeTokenDhan.renew_ok = True
    FakeTokenDhan.totp_ok = True
    return FakeTokenDhan


def test_valid_token_is_not_renewed(fake):
    fake.profile = validity(10)
    r = asyncio.run(tm.ensure_valid_token())
    assert r["action"] == "valid" and "renew" not in fake.calls


def test_expiring_token_renewed_persisted_and_not_returned(fake):
    fake.profile = validity(0.5)
    r = asyncio.run(tm.ensure_valid_token())
    assert r["action"] == "renewed"
    assert os.environ["DHAN_ACCESS_TOKEN"] == "TOK-RENEWED"
    assert "TOK" not in str(r)
    assert settings_manager.load_access_token()["access_token"] == "TOK-RENEWED"
    assert b"TOK-RENEWED" not in settings_manager.token_file.read_bytes()


def test_auto_attempts_respect_cooldown_but_force_does_not(fake):
    asyncio.run(tm.ensure_valid_token())  # invalid -> renews
    fake.calls = []
    assert asyncio.run(tm.ensure_valid_token())["action"] == "cooldown"
    assert "renew" not in fake.calls
    assert asyncio.run(tm.renew_token(force=True))["action"] == "renewed"


def test_renew_failure_falls_back_to_saved_totp_credentials(fake):
    fake.renew_ok = False
    settings_manager.save_credentials({"client_id": "1", "api_key": "k", "api_secret": "s", "pin": "123456",
                                       "totp_secret": "JBSWY3DPEHPK3PXPJBSWY3DP"})
    r = asyncio.run(tm.renew_token(force=True))
    assert r["method"] == "totp_ui" and os.environ["DHAN_ACCESS_TOKEN"] == "TOK-TOTP"


def test_all_methods_failing_reports_failure(fake):
    fake.renew_ok = False
    r = asyncio.run(tm.renew_token(force=True))
    assert r["success"] is False and r["action"] == "failed"


def test_concurrent_checks_renew_once(fake):
    async def many():
        return await asyncio.gather(*[tm.ensure_valid_token() for _ in range(5)])

    asyncio.run(many())
    assert fake.calls.count("renew") == 1


def test_startup_loads_persisted_token(monkeypatch):
    settings_manager.save_access_token("TOK-SAVED", "now")
    monkeypatch.delenv("DHAN_ACCESS_TOKEN", raising=False)
    assert tm.load_persisted_token() is True
    assert os.environ["DHAN_ACCESS_TOKEN"] == "TOK-SAVED"


def test_startup_keeps_env_token_over_persisted(monkeypatch):
    settings_manager.save_access_token("TOK-SAVED", "now")
    monkeypatch.setenv("DHAN_ACCESS_TOKEN", "TOK-ENV")
    assert tm.load_persisted_token() is False
    assert os.environ["DHAN_ACCESS_TOKEN"] == "TOK-ENV"


def test_long_lived_client_picks_up_renewed_token(monkeypatch):
    monkeypatch.setattr(dc, "get_dhan_credentials",
                        lambda: {"client_id": "1", "api_key": "k", "api_secret": "s", "access_token": "A1"})
    monkeypatch.setenv("DHAN_ACCESS_TOKEN", "A1")

    async def run():
        c = dc.DhanClient()
        before = (await c._get_client()).headers["access-token"]
        os.environ["DHAN_ACCESS_TOKEN"] = "A2"
        after = (await c._get_client()).headers["access-token"]
        await c.close()
        return before, after

    assert asyncio.run(run()) == ("A1", "A2")
