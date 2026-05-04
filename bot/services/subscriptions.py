"""Subscription lifecycle helpers."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from bot.config import get_settings
from bot.models import Profile, Subscription, Tariff, User
from bot.services.cycle_code import decode_cycle_code, encode_cycle_code


async def create_subscription(
    session: AsyncSession,
    *,
    user: User,
    tariff: Tariff,
    payment_id: str | None = None,
    days: int | None = None,
) -> Subscription:
    settings = get_settings()
    duration = days or settings.subscription_days
    now = datetime.now(timezone.utc)
    sub = Subscription(
        user_id=user.id,
        tariff=tariff,
        started_at=now,
        expires_at=now + timedelta(days=duration),
        payment_id=payment_id,
        status="active",
    )
    session.add(sub)
    await session.flush()
    return sub


async def get_active_subscription(
    session: AsyncSession, user: User
) -> Subscription | None:
    stmt = (
        select(Subscription)
        .where(Subscription.user_id == user.id, Subscription.status == "active")
        .order_by(desc(Subscription.expires_at))
    )
    sub = (await session.execute(stmt)).scalars().first()
    if sub is None:
        return None
    expires = sub.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < datetime.now(timezone.utc):
        sub.status = "expired"
        return None
    return sub


def canonicalise_cycle_code(raw: str) -> str | None:
    """Return the canonical ``XXXX-XXXX`` form of *raw*, or None if invalid."""
    payload = decode_cycle_code(raw)
    if payload is None:
        return None
    return encode_cycle_code(payload)


async def find_active_subscription_by_cycle_code(
    session: AsyncSession, raw_code: str
) -> Subscription | None:
    """Look up the active subscription bound to a cycle-sync code.

    The mobile app generates a deterministic 8-char cycle-sync code
    (see ``src/cycleCode.ts`` / ``bot/services/cycle_code.py``) that the
    user has previously sent to the bot via ``/sync``. We match it
    against ``Profile.cycle_sync_code`` and walk the relationship to the
    user's active subscription.

    Returns ``None`` if the code is malformed, no profile matches, or no
    active subscription is on file.
    """
    canonical = canonicalise_cycle_code(raw_code)
    if canonical is None:
        return None
    stmt = select(Profile).where(Profile.cycle_sync_code == canonical)
    profile = (await session.execute(stmt)).scalar_one_or_none()
    if profile is None:
        return None
    user = await session.get(User, profile.user_id)
    if user is None:
        return None
    return await get_active_subscription(session, user)
