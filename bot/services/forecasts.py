"""Cycle-forecast persistence.

Replaces the legacy ``cycle_sync_code`` plumbing: instead of asking the
user to copy a base32 code from the app and paste ``/sync <code>`` into
the bot, the app now POSTs the next ``N`` cycles' dates through
``POST /v1/pair/<token>/forecast`` once it has paired Telegram. We wipe
the user's existing forecast on every push so there is at most one
"current truth" set on disk.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from bot.models import CycleForecast, User


@dataclass(slots=True)
class ForecastEntry:
    """Plain DTO for one projected cycle."""

    cycle_start: date
    period_end: date
    ovulation: date
    fertile_start: date
    fertile_end: date


async def replace_user_forecast(
    session: AsyncSession,
    user: User,
    entries: list[ForecastEntry],
) -> int:
    """Drop any existing forecast rows for ``user`` and insert ``entries``.

    Returns the number of rows inserted.
    """
    await session.execute(
        delete(CycleForecast).where(CycleForecast.user_id == user.id)
    )
    now = datetime.now(timezone.utc)
    for entry in entries:
        session.add(
            CycleForecast(
                user_id=user.id,
                cycle_start=entry.cycle_start,
                period_end=entry.period_end,
                ovulation=entry.ovulation,
                fertile_start=entry.fertile_start,
                fertile_end=entry.fertile_end,
                created_at=now,
            )
        )
    await session.flush()
    return len(entries)
