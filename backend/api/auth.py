import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.config import get_config
from backend.models.database import get_db
from backend.models.tables import AppUser
from backend.services.auth_service import (
    create_session,
    delete_session,
    get_user_by_session,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

COOKIE_NAME = "illusion_session"


_MAX_FAILURES = 5
_WINDOW_SECONDS = 15 * 60
_failures: dict[str, deque] = defaultdict(deque)


def _recent_failures(key: str) -> deque:
    q = _failures[key]
    cutoff = time.monotonic() - _WINDOW_SECONDS
    while q and q[0] < cutoff:
        q.popleft()
    if not q:
        _failures.pop(key, None)
    return q


class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(payload: LoginRequest, response: Response, db: Session = Depends(get_db)):
    key = payload.username.strip().lower()
    if len(_recent_failures(key)) >= _MAX_FAILURES:
        response.status_code = 429
        return {"success": False, "message": "Too many failed attempts. Try again in 15 minutes."}
    user = db.query(AppUser).filter(AppUser.username == payload.username).first()
    if not user or not user.is_active or not verify_password(payload.password, user.password_hash):
        _failures[key].append(time.monotonic())
        return {"success": False, "message": "Invalid username or password"}
    _failures.pop(key, None)
    ttl_hours = max(1, int((get_config().get("auth") or {}).get("session_ttl_hours", 24)))
    sess = create_session(db, user.id)
    response.set_cookie(
        key=COOKIE_NAME,
        value=sess.token,
        httponly=True,
        samesite="lax",
        secure=False,
        max_age=ttl_hours * 3600,
    )
    return {
        "success": True,
        "user": {"username": user.username, "role": user.role},
    }


@router.get("/me")
def me(request: Request, db: Session = Depends(get_db)):
    token = request.cookies.get(COOKIE_NAME)
    user = get_user_by_session(db, token)
    if not user:
        return {"authenticated": False, "user": None}
    return {
        "authenticated": True,
        "user": {"username": user.username, "role": user.role},
    }


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    token = request.cookies.get(COOKIE_NAME)
    delete_session(db, token)
    response.delete_cookie(COOKIE_NAME)
    return {"success": True}
