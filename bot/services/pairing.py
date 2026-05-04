"""Pairing-token lifecycle.

The Lira app uses these tokens to link an installed copy of the app to a
Telegram user without typing an activation code: the app generates a
token, opens ``t.me/<bot>?start=link_<token>``, the bot claims the token
against the calling Telegram user, and the app polls until the claim is
visible.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bot.models import PairingToken, User

# Token validity. Long enough that a user can switch apps and slowly find
# /start in Telegram, short enough that abandoned tokens don't pile up.
TOKEN_TTL = timedelta(minutes=15)
# Length of the random body. 24 base32-ish chars ≈ 120 bits of entropy,
# more than enough for a single-use token.
TOKEN_LENGTH = 24
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # base32 minus 0/O/1/I


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _generate_token() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(TOKEN_LENGTH))


async def create_pair_token(session: AsyncSession) -> PairingToken:
    """Insert a fresh, unclaimed pairing token and return it."""
    for _ in range(10):
        candidate = _generate_token()
        existing = await session.execute(
            select(PairingToken).where(PairingToken.token == candidate)
        )
        if existing.scalar_one_or_none() is None:
            now = _now()
            tok = PairingToken(
                token=candidate,
                created_at=now,
                expires_at=now + TOKEN_TTL,
                claimed_user_id=None,
                claimed_at=None,
            )
            session.add(tok)
            await session.flush()
            return tok
    raise RuntimeError("Failed to generate a unique pairing token")


async def find_pair_token(session: AsyncSession, token: str) -> PairingToken | None:
    cleaned = token.strip().upper()
    if not cleaned:
        return None
    stmt = select(PairingToken).where(PairingToken.token == cleaned)
    return (await session.execute(stmt)).scalar_one_or_none()


def is_expired(token_row: PairingToken) -> bool:
    expires = token_row.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    return expires < _now()


async def claim_pair_token(
    session: AsyncSession, token: str, *, user: User
) -> PairingToken | None:
    """Bind ``token`` to ``user``. Returns the row on success, None otherwise.

    The token must exist, not be expired, and either be unclaimed or
    already claimed by the same user (idempotent re-issue).
    """
    row = await find_pair_token(session, token)
    if row is None:
        return None
    if is_expired(row):
        return None
    if row.claimed_user_id is not None and row.claimed_user_id != user.id:
        return None
    if row.claimed_user_id is None:
        row.claimed_user_id = user.id
        row.claimed_at = _now()
    return row
