"""``/start link_<token>`` deep-link handler.

When the Lira app initiates a pairing it generates a token via
``POST /v1/pair/init`` and opens ``t.me/<bot>?start=link_<token>`` in
Telegram. That deep link routes here. We claim the token against the
sender's Telegram user (creating the User row if it doesn't exist yet)
so the app's subsequent poll to ``GET /v1/pair/<token>`` can resolve to
their active subscription.
"""
from __future__ import annotations

import logging

from aiogram import F, Router
from aiogram.filters import CommandObject, CommandStart
from aiogram.types import Message

from bot.db import session_scope
from bot.services.pairing import claim_pair_token
from bot.services.subscriptions import get_active_subscription
from bot.services.users import get_or_create_user

log = logging.getLogger(__name__)
router = Router(name="pairing")


@router.message(
    CommandStart(deep_link=True),
    F.text.regexp(r"^/start\s+link_"),
)
async def on_start_with_pair(message: Message, command: CommandObject) -> None:
    raw = (command.args or "").strip()
    if not raw.lower().startswith("link_"):
        return
    token = raw[len("link_"):].strip()
    if not token or message.from_user is None:
        return

    async with session_scope() as session:
        user = await get_or_create_user(session, message.from_user)
        claimed = await claim_pair_token(session, token, user=user)
        sub = await get_active_subscription(session, user) if claimed else None

    if claimed is None:
        await message.answer(
            "Ссылка для привязки устарела или недействительна. "
            "Открой приложение Lira ещё раз и нажми «Привязать Telegram» — "
            "появится свежая ссылка."
        )
        return

    if sub is None:
        await message.answer(
            "Готово, аккаунт привязан 💫\n\n"
            "Активной подписки на тебе пока нет. "
            "Когда оформишь её — приложение подтянет её автоматически."
        )
        return

    await message.answer(
        "Готово, аккаунт привязан и подписка активирована 💫\n\n"
        f"Тариф: <b>{sub.tariff.value.title()}</b>\n"
        f"Действует до: <b>{sub.expires_at:%d.%m.%Y}</b>\n\n"
        "Можешь возвращаться в приложение — всё подтянулось.",
        parse_mode="HTML",
    )
