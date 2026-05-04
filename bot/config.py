"""Runtime configuration loaded from environment variables / .env."""
from __future__ import annotations

import os
from functools import lru_cache

from pydantic import BeforeValidator, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Annotated


# When deployed on Fly.io a persistent volume is mounted at /data; default
# the SQLite file to that path so it survives restarts. Locally fall back
# to a project-relative file so dev works with no env vars set.
_DEFAULT_DATABASE_URL = (
    "sqlite+aiosqlite:////data/app.db"
    if os.path.isdir("/data")
    else "sqlite+aiosqlite:///./flowcare.db"
)


def _empty_str_to_none(v):
    if isinstance(v, str) and v.strip() == "":
        return None
    return v


OptionalInt = Annotated[int | None, BeforeValidator(_empty_str_to_none)]
OptionalStr = Annotated[str | None, BeforeValidator(_empty_str_to_none)]


class Settings(BaseSettings):
    """Single source of truth for env-derived configuration."""

    model_config = SettingsConfigDict(
        env_file=("bot/.env", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Telegram. ``bot_token`` is required for ``bot/main.py`` (long-polling
    # entrypoint) but the FastAPI ``api/`` package can boot without it —
    # default to empty string so api-only Fly deploys don't crash on import.
    bot_token: str = Field(default="", alias="BOT_TOKEN")
    bot_username: OptionalStr = Field(default=None, alias="BOT_USERNAME")
    admin_chat_id: OptionalInt = Field(default=None, alias="ADMIN_CHAT_ID")
    assembly_chat_id: OptionalInt = Field(default=None, alias="ASSEMBLY_CHAT_ID")
    payment_provider_token: OptionalStr = Field(
        default=None, alias="PAYMENT_PROVIDER_TOKEN"
    )

    # Database (default: local SQLite for dev / Fly volume in prod; Postgres
    # URL in docker-compose).
    database_url: str = Field(
        default=_DEFAULT_DATABASE_URL,
        alias="DATABASE_URL",
    )

    # FastAPI
    api_host: str = Field(default="0.0.0.0", alias="API_HOST")
    api_port: int = Field(default=8000, alias="API_PORT")

    # Subscription
    basic_price_rub: int = Field(default=999, alias="BASIC_PRICE_RUB")
    vip_price_rub: int = Field(default=1999, alias="VIP_PRICE_RUB")
    subscription_days: int = Field(default=30, alias="SUBSCRIPTION_DAYS")

    # Scheduling
    box_lead_days: int = Field(
        default=5,
        alias="BOX_LEAD_DAYS",
        description="How many days before predicted period to ship the box.",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
