"""
Shared fixtures. Tests never touch the real data/ folder, config.yaml or Dhan:
  * config comes from config.yaml.example copied to a temp dir
  * settings_manager (credentials/token files) writes to a temp dir
  * DHAN_* env vars are cleared
  * the DB is an in-memory SQLite engine
  * Dhan calls go to FakeDhan
"""

import asyncio
import shutil
from datetime import date
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import backend.config as config_mod
from backend.models.database import Base, get_db
import backend.models.tables as T

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def isolated_env(tmp_path, monkeypatch):
    cfg = tmp_path / "config.yaml"
    shutil.copy(ROOT / "config.yaml.example", cfg)
    monkeypatch.setattr(config_mod, "CONFIG_PATH", cfg)
    real_get_config = config_mod.get_config  # a test may monkeypatch it with a plain function
    real_get_config.cache_clear()

    from backend.services.settings_manager import settings_manager

    sdir = tmp_path / "settings"
    sdir.mkdir()
    monkeypatch.setattr(settings_manager, "settings_dir", sdir)
    monkeypatch.setattr(settings_manager, "settings_file", sdir / "credentials.enc")
    monkeypatch.setattr(settings_manager, "key_file", sdir / ".key")

    for k in ("DHAN_ACCESS_TOKEN", "DHAN_PIN", "DHAN_TOTP_SECRET", "DHAN_CLIENT_ID",
              "DHAN_API_KEY", "DHAN_API_SECRET"):
        monkeypatch.delenv(k, raising=False)

    # Module-level asyncio locks must not leak across event loops between tests.
    from backend.services import order_safety, token_manager
    from backend.api import index_trading

    monkeypatch.setattr(order_safety, "_in_flight_lock", asyncio.Lock())
    order_safety._in_flight.clear()
    monkeypatch.setattr(token_manager, "_lock", asyncio.Lock())
    monkeypatch.setattr(token_manager, "_last_attempt_monotonic", 0.0)
    monkeypatch.setattr(index_trading, "_manual_monitor_lock", asyncio.Lock())
    yield
    real_get_config.cache_clear()


@pytest.fixture
def SessionLocal():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False)


@pytest.fixture
def db(SessionLocal):
    s = SessionLocal()
    yield s
    s.close()


def make_app(SessionLocal, *routers):
    app = FastAPI()
    for r in routers:
        app.include_router(r)

    def override():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = override
    return TestClient(app)


@pytest.fixture
def signal(db):
    sig = T.Signal(security_id="1", symbol="RELIANCE", section="fno", signal_type="CE", occurrence_number=1,
                   first_detected_date=date.today(), last_updated_date=date.today(), status="active")
    db.add(sig)
    db.commit()
    return sig


class FakeDhan:
    """Records every broker call; behaviour is set per test via class attributes."""

    calls: list = []
    buy_status = "TRADED"
    fail_forever = False
    fail_cancel = False
    forever_book: list = []

    def __init__(self, *a, **k):
        pass

    async def close(self):
        pass

    async def place_order(self, **kw):
        FakeDhan.calls.append(("place_order", kw))
        return {"orderId": f"O{len(FakeDhan.calls)}", "orderStatus": "TRANSIT"}

    async def get_order_by_id(self, oid):
        return [{"orderStatus": FakeDhan.buy_status, "filledQty": 50, "quantity": 50}]

    async def create_forever_order(self, **kw):
        FakeDhan.calls.append(("forever", kw))
        if FakeDhan.fail_forever:
            return {"error": True, "detail": "boom"}
        oid = f"G{len(FakeDhan.calls)}"
        FakeDhan.forever_book.append({"orderId": oid, "orderStatus": "PENDING"})
        return {"orderId": oid}

    async def cancel_forever_order(self, oid):
        FakeDhan.calls.append(("cancel_forever", oid))
        if FakeDhan.fail_cancel:
            return {"error": True, "detail": "nope"}
        return {"orderId": oid, "orderStatus": "CANCELLED"}

    async def get_forever_orders(self):
        return FakeDhan.forever_book

    async def cancel_order(self, oid):
        FakeDhan.calls.append(("cancel_order", oid))
        return {"orderId": oid}

    @staticmethod
    def kinds():
        return [c[0] for c in FakeDhan.calls]


@pytest.fixture
def fake_dhan():
    FakeDhan.calls = []
    FakeDhan.buy_status = "TRADED"
    FakeDhan.fail_forever = False
    FakeDhan.fail_cancel = False
    FakeDhan.forever_book = []
    return FakeDhan
