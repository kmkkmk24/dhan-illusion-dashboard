"""
Single owner of the Dhan access token lifecycle.

Everything that needs a fresh token calls `ensure_valid_token()` (validate,
renew only if needed) or `renew_token(force=True)` (manual button). Renewals
are serialized by a lock, rate-limited by a cooldown, and the resulting token
is persisted (encrypted) so restarts and dev reloads reuse it instead of
renewing again.

Source of truth at runtime is os.environ["DHAN_ACCESS_TOKEN"]; DhanClient
re-reads it before each request, so long-lived clients pick up new tokens.
Scheduling (startup check + 06:00 IST daily) lives in services/scheduler.py.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
ENV_KEY = "DHAN_ACCESS_TOKEN"
RENEW_IF_HOURS_LEFT = 2.0
AUTO_RENEW_COOLDOWN_SEC = 300  # non-forced attempts at most every 5 minutes

_lock = asyncio.Lock()
_last_attempt_monotonic: float = 0.0
_last_result: dict = {}


def current_token() -> str:
    return os.environ.get(ENV_KEY, "") or ""


def _apply_token(token: str, method: str) -> None:
    from backend.services.settings_manager import settings_manager

    os.environ[ENV_KEY] = token
    settings_manager.save_access_token(token, datetime.now(IST).isoformat())
    logger.info("Dhan access token updated via %s", method)


def load_persisted_token() -> bool:
    """At startup: if no token in the environment, reuse the last saved one."""
    if current_token():
        return False
    from backend.services.settings_manager import settings_manager

    saved = settings_manager.load_access_token()
    if saved and saved.get("access_token"):
        os.environ[ENV_KEY] = saved["access_token"]
        logger.info("Loaded persisted Dhan access token (saved %s)", saved.get("saved_at"))
        return True
    return False


def _hours_left(token_validity: str) -> Optional[float]:
    # Dhan format: "05/03/2026 15:37" (IST)
    try:
        expiry = datetime.strptime(token_validity, "%d/%m/%Y %H:%M").replace(tzinfo=IST)
    except (TypeError, ValueError):
        return None
    return (expiry - datetime.now(IST)).total_seconds() / 3600


async def _token_hours_left(client) -> Optional[float]:
    """Hours of validity left, or None if the token is missing/invalid/unknown."""
    if not client.access_token:
        return None
    profile = await client.get_profile()
    if not profile:
        return None
    return _hours_left(profile.get("tokenValidity", ""))


async def _generate(client) -> dict:
    """Try RenewToken, then TOTP with UI credentials, then TOTP with env vars."""
    from backend.services.settings_manager import settings_manager

    if client.access_token:
        res = await client.renew_token()
        if res and res.get("success") and res.get("new_token"):
            return {"success": True, "method": "renew", "token": res["new_token"]}
        logger.warning("RenewToken failed; trying TOTP")

    creds = settings_manager.load_credentials()
    if creds and creds.get("pin") and creds.get("totp_secret"):
        res = await client.generate_access_token_with_totp(creds["pin"], creds["totp_secret"])
        if res and res.get("success") and res.get("new_token"):
            return {"success": True, "method": "totp_ui", "token": res["new_token"]}
        logger.warning("TOTP with UI credentials failed")

    pin, secret = os.environ.get("DHAN_PIN"), os.environ.get("DHAN_TOTP_SECRET")
    if pin and secret:
        res = await client.generate_access_token_with_totp(pin, secret)
        if res and res.get("success") and res.get("new_token"):
            return {"success": True, "method": "totp_env", "token": res["new_token"]}

    return {
        "success": False,
        "message": "Token renewal failed. Save PIN + TOTP secret in Settings, "
        "or generate a token at https://web.dhan.co/ and set DHAN_ACCESS_TOKEN.",
    }


async def renew_token(*, force: bool = False) -> dict:
    """
    Make sure a valid token is in place.

    force=False: validate first; renew only if missing/invalid/expiring within
    RENEW_IF_HOURS_LEFT, and no more often than AUTO_RENEW_COOLDOWN_SEC.
    force=True: renew now (manual action), still serialized by the lock.

    Returns {"success": bool, "action": "valid"|"renewed"|"cooldown"|"failed", ...}
    (never contains the token itself).
    """
    global _last_attempt_monotonic, _last_result
    from backend.services.dhan_client import DhanClient

    async with _lock:
        client = None
        try:
            client = DhanClient()
            if not force:
                hours = await _token_hours_left(client)
                if hours is not None and hours >= RENEW_IF_HOURS_LEFT:
                    return {"success": True, "action": "valid", "hours_left": round(hours, 1)}
                since = time.monotonic() - _last_attempt_monotonic
                if _last_attempt_monotonic and since < AUTO_RENEW_COOLDOWN_SEC:
                    return {"success": bool(_last_result.get("success")), "action": "cooldown",
                            "retry_in_sec": int(AUTO_RENEW_COOLDOWN_SEC - since)}

            _last_attempt_monotonic = time.monotonic()
            res = await _generate(client)
            if res.get("success"):
                _apply_token(res["token"], res["method"])
                _last_result = {"success": True, "action": "renewed", "method": res["method"],
                                "at": datetime.now(IST).isoformat()}
            else:
                logger.warning("❌ %s", res.get("message"))
                _last_result = {"success": False, "action": "failed", "message": res.get("message"),
                                "at": datetime.now(IST).isoformat()}
            return dict(_last_result)
        except Exception as e:
            logger.error("Token renewal error: %s", e, exc_info=True)
            _last_result = {"success": False, "action": "failed", "message": str(e)}
            return dict(_last_result)
        finally:
            if client:
                await client.close()


async def ensure_valid_token() -> dict:
    return await renew_token(force=False)


def last_result() -> dict:
    return dict(_last_result)
