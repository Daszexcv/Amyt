"""Cycle forecast rows pushed by the Lira app after Telegram pairing.

When the user taps "Привязать Telegram" in the app and grants the
"передать прогноз" permission, the app POSTs the next 3 cycles' worth
of bleeding / ovulation / fertile-window dates to
``POST /v1/pair/<token>/forecast``. The endpoint resolves the token to
the claimed user and writes one row per cycle here.

Replaces the older ``cycle_sync_code`` flow: the bot no longer needs the
encoded base32 code to schedule box deliveries — it has the dates
directly. The user can revoke by un-linking; we wipe rows on revoke.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Date, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from bot.models.base import Base

if TYPE_CHECKING:
    from bot.models.user import User


class CycleForecast(Base):
    __tablename__ = "cycle_forecasts"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    cycle_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    ovulation: Mapped[date] = mapped_column(Date)
    fertile_start: Mapped[date] = mapped_column(Date)
    fertile_end: Mapped[date] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    user: Mapped["User"] = relationship("User", foreign_keys=[user_id])

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<CycleForecast user_id={self.user_id} "
            f"cycle_start={self.cycle_start.isoformat()}>"
        )
