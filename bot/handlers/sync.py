"""/sync handler — accepts a cycle sync code from the Lira app.

The code carries: last period start date, average cycle length, average
period length. We persist this on the user's Profile so the scheduler can
compute exactly when the next box should be assembled.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from aiogram import F, Router
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import Message

from bot.db import session_scope
from bot.services.cycle_code import decode_cycle_code, encode_cycle_code
from bot.services.users import get_or_create_profile, get_or_create_user

log = logging.getLogger(__name__)
router = Router(name="sync")


HELP = (
    "Чтобы я знал, когда отправлять тебе бокс, открой приложение <b>Lira</b> "
    "→ экран «Подписка» → «Код синхронизации цикла» → «Скопировать код».\n\n"
    "Затем пришли мне его сообщением:\n<code>/sync ABCD-EFGH</code>"
)


async def _apply_code(message: Message, code: str) -> None:
    payload = decode_cycle_code(code)
    if payload is None:
        await message.answer(
            "Не получилось разобрать код. Проверь, что скопировала его "
            "целиком из приложения. Формат — 8 символов, например "
            "<code>4FGA-9XPP</code>.",
            parse_mode="HTML",
        )
        return

    if message.from_user is None:
        return
    canonical = encode_cycle_code(payload)
    async with session_scope() as session:
        user = await get_or_create_user(session, message.from_user)
        profile = await get_or_create_profile(session, user)
        profile.last_period_start = payload.start_date
        profile.cycle_length_days = payload.cycle_length
        profile.period_length_days = payload.period_length
        profile.cycle_sync_code = canonical

    period_end = payload.start_date + timedelta(days=max(payload.period_length - 1, 0))
    await message.answer(
        "Готово, цикл синхронизирован 💫\n\n"
        f"• Месячные: <b>{payload.start_date:%d.%m.%Y}</b> → "
        f"<b>{period_end:%d.%m.%Y}</b> ({payload.period_length} дн.)\n"
        f"• Средняя длина цикла: <b>{payload.cycle_length} дн.</b>\n\n"
        "Я учту это при сборке твоего следующего бокса.",
        parse_mode="HTML",
    )


@router.message(Command("sync"))
async def on_sync(message: Message, command: CommandObject) -> None:
    raw = (command.args or "").strip()
    if not raw:
        await message.answer(HELP, parse_mode="HTML")
        return
    await _apply_code(message, raw)


@router.message(
    CommandStart(deep_link=True),
    F.text.lower().regexp(r"^/start\s+sync_"),
)
async def on_start_with_sync(message: Message, command: CommandObject) -> None:
    raw = (command.args or "").strip()
    await _apply_code(message, raw[len("sync_"):])
