"""FastAPI app exposing the Lira ↔ FlowCare integration endpoints.

Endpoints
---------

* ``POST /v1/activate`` — legacy activation-code redemption (kept as
  fallback for users who have not paired via Telegram).
* ``GET  /v1/subscription?cycle_code=...`` — auto-sync lookup by the
  cycle-sync code already stored on the user's profile.
* ``POST /v1/pair/init`` — issue a fresh pairing token. The Lira app
  opens ``t.me/<bot>?start=link_<token>`` in Telegram; the bot's
  ``/start link_<token>`` handler binds the token to the calling
  Telegram user. The app then polls ``GET /v1/pair/<token>`` to learn
  who claimed the token and what their active subscription is.
"""
from __future__ import annotations

import logging
import asyncio
from contextlib import asynccontextmanager
from datetime import timezone
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from bot.config import get_settings
from bot.db import engine, session_scope
from bot.models import Base, User
from bot.services.codes import redeem_code
from bot.services.pairing import (
    create_pair_token,
    find_pair_token,
    is_expired,
)
from bot.services.forecasts import ForecastEntry, replace_user_forecast
from bot.services.subscriptions import (
    canonicalise_cycle_code,
    find_active_subscription_by_cycle_code,
    get_active_subscription,
)

log = logging.getLogger("flowcare-api")
logging.basicConfig(level=logging.INFO)


# Shared aiogram Bot handle so the API can send notifications (e.g. the
# "Прогноз получен" confirmation after the app uploads the forecast)
# through the same Telegram session that the polling worker uses.
_shared_bot: object | None = None


async def _run_bot_polling() -> None:
    """Run the aiogram long-polling bot inside the FastAPI process.

    Co-locating the bot and the API in the same process means they share
    the SQLite database on the persistent volume — pairing tokens written
    by the bot's ``/start link_<token>`` handler are immediately visible
    to ``GET /v1/pair/<token>`` calls. Skipped when ``BOT_TOKEN`` is
    empty (e.g. local API dev or first Fly deploy before secrets are
    configured).
    """
    global _shared_bot
    settings = get_settings()
    if not settings.bot_token:
        log.info("BOT_TOKEN unset — bot polling not started")
        return
    from aiogram import Bot, Dispatcher
    from aiogram.client.default import DefaultBotProperties

    from bot.handlers import router as root_router

    bot = Bot(
        token=settings.bot_token,
        default=DefaultBotProperties(parse_mode=None),
    )
    _shared_bot = bot
    dp = Dispatcher()
    dp.include_router(root_router)
    log.info("Starting Telegram bot polling…")
    try:
        await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())
    finally:
        _shared_bot = None
        await bot.session.close()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    settings = get_settings()
    if settings.bot_token:
        # Catalog seeding is bot-only (used to assemble subscription
        # boxes); skip it for api-only deploys to keep memory low.
        from bot.services.catalog import seed_catalog

        async with session_scope() as session:
            await seed_catalog(session)
        bot_task: asyncio.Task[None] | None = asyncio.create_task(
            _run_bot_polling()
        )
    else:
        bot_task = None
    try:
        yield
    finally:
        if bot_task is not None:
            bot_task.cancel()
            try:
                await bot_task
            except (asyncio.CancelledError, Exception):
                pass


app = FastAPI(
    title="FlowCare Activation API",
    version="1.1.0",
    description=(
        "Validates activation codes issued by the FlowCare Telegram bot, "
        "auto-syncs subscriptions by cycle-code, and powers the "
        "Telegram-pairing flow that replaces the activation code with a "
        "single deep-link tap."
    ),
    lifespan=lifespan,
)


# ---------------------------------------------------------------------- #
# /v1/activate — activation-code fallback                                  #
# ---------------------------------------------------------------------- #


class ActivateIn(BaseModel):
    code: str = Field(..., min_length=4, max_length=16)
    device_id: str | None = Field(default=None, max_length=128)


class ActivateOut(BaseModel):
    valid: bool
    tariff: str | None = None
    expires: str | None = None
    redeemed_at: str | None = None


@app.post("/v1/activate", response_model=ActivateOut)
async def activate(body: ActivateIn) -> ActivateOut:
    async with session_scope() as session:
        result = await redeem_code(session, body.code, device_id=body.device_id)
    if result is None:
        return ActivateOut(valid=False)
    code, sub = result
    return ActivateOut(
        valid=True,
        tariff=sub.tariff.value,
        expires=sub.expires_at.date().isoformat(),
        redeemed_at=(code.redeemed_at.isoformat() if code.redeemed_at else None),
    )


# ---------------------------------------------------------------------- #
# /v1/subscription?cycle_code=... — auto-sync via cycle-code               #
# ---------------------------------------------------------------------- #


class SubscriptionOut(BaseModel):
    valid: bool
    tariff: str | None = None
    expires: str | None = None


@app.get("/v1/subscription", response_model=SubscriptionOut)
async def subscription_by_cycle_code(
    cycle_code: str = Query(..., min_length=4, max_length=16),
) -> SubscriptionOut:
    canonical = canonicalise_cycle_code(cycle_code)
    if canonical is None:
        return SubscriptionOut(valid=False)
    async with session_scope() as session:
        sub = await find_active_subscription_by_cycle_code(session, canonical)
    if sub is None:
        return SubscriptionOut(valid=False)
    return SubscriptionOut(
        valid=True,
        tariff=sub.tariff.value,
        expires=sub.expires_at.date().isoformat(),
    )


# ---------------------------------------------------------------------- #
# /v1/pair/* — Telegram deep-link pairing                                  #
# ---------------------------------------------------------------------- #


class PairInitOut(BaseModel):
    token: str
    expires_at: str
    deep_link: str


class PairStatusOut(BaseModel):
    paired: bool
    expired: bool = False
    tariff: str | None = None
    expires: str | None = None
    telegram_username: str | None = None


def _bot_deep_link(token: str) -> str:
    """Build the Telegram deep-link the app should open."""
    settings = get_settings()
    username = (getattr(settings, "bot_username", None) or "").lstrip("@")
    if not username:
        # Fall back to a hard-coded slot the app overrides in app.json.
        username = "lowerBsk24_bot"
    return f"https://t.me/{username}?start=link_{token}"


@app.post("/v1/pair/init", response_model=PairInitOut)
async def pair_init() -> PairInitOut:
    async with session_scope() as session:
        tok = await create_pair_token(session)
        expires = tok.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    return PairInitOut(
        token=tok.token,
        expires_at=expires.isoformat(),
        deep_link=_bot_deep_link(tok.token),
    )


@app.get("/v1/pair/{token}", response_model=PairStatusOut)
async def pair_status(token: str) -> PairStatusOut:
    if len(token) > 64:
        raise HTTPException(status_code=400, detail="token too long")
    async with session_scope() as session:
        row = await find_pair_token(session, token)
        if row is None:
            return PairStatusOut(paired=False, expired=False)
        if is_expired(row) and row.claimed_user_id is None:
            return PairStatusOut(paired=False, expired=True)
        if row.claimed_user_id is None:
            return PairStatusOut(paired=False, expired=False)
        user = await session.get(User, row.claimed_user_id)
        sub = await get_active_subscription(session, user) if user else None
    out = PairStatusOut(
        paired=True,
        expired=False,
        telegram_username=user.username if user else None,
    )
    if sub is not None:
        out.tariff = sub.tariff.value
        out.expires = sub.expires_at.date().isoformat()
    return out


# ---------------------------------------------------------------------- #
# /v1/pair/{token}/forecast — push 3-month cycle forecast to the bot      #
# ---------------------------------------------------------------------- #


class ForecastEntryIn(BaseModel):
    """One projected cycle. All dates are ``YYYY-MM-DD`` strings."""

    cycle_start: str
    period_end: str
    ovulation: str
    fertile_start: str
    fertile_end: str


class ForecastIn(BaseModel):
    entries: list[ForecastEntryIn] = Field(default_factory=list, max_length=12)


class ForecastOut(BaseModel):
    ok: bool
    stored: int = 0


def _parse_date(value: str):
    from datetime import date as _date

    try:
        return _date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(
            status_code=422, detail=f"invalid date: {value}"
        ) from exc


@app.post("/v1/pair/{token}/forecast", response_model=ForecastOut)
async def pair_forecast(token: str, body: ForecastIn) -> ForecastOut:
    if len(token) > 64:
        raise HTTPException(status_code=400, detail="token too long")
    if not body.entries:
        raise HTTPException(status_code=422, detail="forecast is empty")
    parsed: list[ForecastEntry] = []
    for raw in body.entries:
        parsed.append(
            ForecastEntry(
                cycle_start=_parse_date(raw.cycle_start),
                period_end=_parse_date(raw.period_end),
                ovulation=_parse_date(raw.ovulation),
                fertile_start=_parse_date(raw.fertile_start),
                fertile_end=_parse_date(raw.fertile_end),
            )
        )
    async with session_scope() as session:
        row = await find_pair_token(session, token)
        if row is None or row.claimed_user_id is None:
            raise HTTPException(status_code=404, detail="pair token not claimed")
        if is_expired(row):
            # Expired-but-claimed is fine: the user already linked, the
            # token just can't be re-claimed by anyone else.
            pass
        user = await session.get(User, row.claimed_user_id)
        if user is None:
            raise HTTPException(status_code=404, detail="user missing")
        stored = await replace_user_forecast(session, user, parsed)
        chat_id = user.telegram_id
    if _shared_bot is not None and chat_id is not None and parsed:
        first = parsed[0]
        try:
            await _shared_bot.send_message(  # type: ignore[attr-defined]
                chat_id=chat_id,
                text=(
                    "Получил твой прогноз цикла на 3 месяца 🌸\n\n"
                    f"Ближайшие месячные: <b>{first.cycle_start:%d.%m.%Y}</b>\n"
                    f"Овуляция: <b>{first.ovulation:%d.%m.%Y}</b>\n\n"
                    "Бокс приедет к началу следующих месячных. "
                    "Прогноз обновится автоматически каждый раз, когда "
                    "ты заново привязываешь Telegram в приложении."
                ),
                parse_mode="HTML",
            )
        except Exception:  # pragma: no cover — best-effort notification
            log.exception("forecast confirmation send failed")
    return ForecastOut(ok=True, stored=stored)


# ---------------------------------------------------------------------- #
# Health                                                                   #
# ---------------------------------------------------------------------- #


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def run() -> None:  # pragma: no cover
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "api.main:app", host=settings.api_host, port=settings.api_port, reload=False
    )
