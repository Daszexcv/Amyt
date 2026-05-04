"""Pairing tokens used to link the Lira app to a Telegram user.

Lifecycle:

1. The mobile/web app calls ``POST /v1/pair/init`` and receives a fresh
   token. A row is inserted with ``claimed_user_id = NULL``.
2. The user opens ``https://t.me/<bot>?start=link_<token>`` in Telegram.
   The bot's ``/start link_<token>`` handler (see
   ``bot/handlers/pairing.py``) sets ``claimed_user_id`` on the matching
   row.
3. The app polls ``GET /v1/pair/<token>``; once ``claimed_user_id`` is
   populated the endpoint returns the active subscription for that user
   (or ``paired=true`` with no tariff if the user has no active
   subscription yet).
4. Tokens are single-use. After the app reads the active subscription it
   never needs to fetch the same token again; expired tokens are cleaned
   lazily on read.
"""
from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from bot.models.base import Base

if TYPE_CHECKING:
    from bot.models.user import User


class PairingToken(Base):
    __tablename__ = "pairing_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    token: Mapped[str] = mapped_column(String(48), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    claimed_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE")
    )
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    claimed_user: Mapped["User | None"] = relationship("User", foreign_keys=[claimed_user_id])

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<PairingToken token={self.token!r} "
            f"claimed_user_id={self.claimed_user_id}>"
        )
