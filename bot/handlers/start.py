from __future__ import annotations

import logging

from aiogram import F, Router
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    CallbackQuery,
)

from bot.db import session_scope
from bot.services.users import get_or_create_user
from bot.states import Onboarding

log = logging.getLogger(__name__)
router = Router(name="start")


WELCOME = (
    "Привет, я <b>Flow</b> 🌸\n\n"
    "Я помогу собрать персональный <b>бокс заботы</b> — каждый месяц "
    "к датам М тебе будет приезжать коробка со средствами гигиены, "
    "уходом и приятностями. Подобрано лично под тебя: твои "
    "предпочтения, аллергии, образ жизни и фаза цикла.\n\n"
    "Также есть <b>Lira Premium</b> — цифровой тариф 199 ₽/мес: "
    "расширенная аналитика, прогноз овуляции, экспорт PDF/CSV, гайды. "
    "Без бокса и без опросника — оплатил, получил код активации, "
    "ввёл в приложении.\n\n"
    "Для бокса сначала зададу несколько вопросов (можно прерваться и "
    "вернуться позже — твои ответы сохраняются), потом покажу тарифы и "
    "оформим подписку через Telegram-оплату. После оплаты дам код для "
    "приложения."
)


def _welcome_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="✨ Lira Premium — 199₽/мес",
                    callback_data="premium:buy",
                )
            ],
            [
                InlineKeyboardButton(
                    text="📦 Твой ритм — 999₽/мес",
                    callback_data="box:basic",
                )
            ],
            [
                InlineKeyboardButton(
                    text="📦 Полная симфония — 1999₽/мес",
                    callback_data="box:vip",
                )
            ],
            [
                InlineKeyboardButton(
                    text="📦 Мой бокс", callback_data="cabinet:status"
                )
            ],
        ]
    )


@router.message(CommandStart(deep_link=True), F.text.regexp(r"^/start\s+premium\b"))
async def on_start_premium(message: Message, state: FSMContext) -> None:
    """Deep link from the app: tariff is preselected as Premium → straight to invoice."""
    await state.clear()
    if message.from_user is not None:
        async with session_scope() as session:
            await get_or_create_user(session, message.from_user)
    await _send_premium_invoice(message, state)


@router.message(
    CommandStart(deep_link=True),
    F.text.regexp(r"^/start\s+box(_basic|_vip)?\b"),
)
async def on_start_box(message: Message, state: FSMContext) -> None:
    """Deep link from the app: jump straight into the box-tariff survey.

    ``?start=box`` — survey, pick tariff at the end.
    ``?start=box_basic`` / ``?start=box_vip`` — survey, pre-pick the tariff.
    """
    await state.clear()
    raw = (message.text or "").strip()
    suffix = raw.split(maxsplit=1)[-1] if " " in raw else ""
    preselect: str | None = None
    if suffix == "box_basic":
        preselect = "basic"
    elif suffix == "box_vip":
        preselect = "vip"
    if message.from_user is not None:
        async with session_scope() as session:
            await get_or_create_user(session, message.from_user)
    if preselect is not None:
        await state.update_data(_preselected_tariff=preselect)
    await state.set_state(Onboarding.name)
    await message.answer(
        "Соберём бокс заботы. Я задам 7 вопросов — это займёт пару минут.\n"
        "Можно прерваться в любой момент: ответы сохраняются.\n\n"
        "<b>Шаг 1/7. Как тебя зовут?</b>",
        parse_mode="HTML",
    )


@router.callback_query(F.data == "premium:buy")
async def on_premium_buy(cb: CallbackQuery, state: FSMContext) -> None:
    if cb.message is None:
        await cb.answer()
        return
    await state.clear()
    if cb.from_user is not None:
        async with session_scope() as session:
            await get_or_create_user(session, cb.from_user)
    try:
        await cb.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass
    await _send_premium_invoice(cb.message, state)
    await cb.answer()


@router.callback_query(F.data.in_({"box:basic", "box:vip"}))
async def on_box_buy(cb: CallbackQuery, state: FSMContext) -> None:
    if cb.message is None:
        await cb.answer()
        return
    preselect = "basic" if cb.data == "box:basic" else "vip"
    await state.clear()
    if cb.from_user is not None:
        async with session_scope() as session:
            await get_or_create_user(session, cb.from_user)
    try:
        await cb.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass
    await state.update_data(_preselected_tariff=preselect)
    await state.set_state(Onboarding.name)
    await cb.message.answer(
        "Соберём бокс заботы. Я задам 7 вопросов — это займёт пару минут.\n"
        "Можно прерваться в любой момент: ответы сохраняются.\n\n"
        "<b>Шаг 1/7. Как тебя зовут?</b>",
        parse_mode="HTML",
    )
    await cb.answer()


async def _send_premium_invoice(message: Message, state: FSMContext) -> None:
    """Push the user straight into invoicing for the Premium tariff."""
    from bot.models import Tariff
    from bot.services.payments import TARIFF_META, send_invoice

    tariff = Tariff.PREMIUM
    await state.set_state(Onboarding.waiting_payment)
    await state.update_data(_tariff=tariff.value)
    await message.answer(
        "<b>Lira Premium</b>\n"
        "Цифровой тариф — 199 ₽/мес. Без бокса и без опросника.\n\n"
        "После оплаты пришлю код активации — введи его в приложении "
        "Lira на экране «Подписка».",
        parse_mode="HTML",
    )
    sent = await send_invoice(message.bot, message.chat.id, tariff)
    if not sent:
        await message.answer(
            "Платёжный провайдер пока не настроен. Можешь оформить "
            "Premium в тестовом режиме — нажми кнопку ниже, и я пришлю "
            "код активации.",
            reply_markup=InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        InlineKeyboardButton(
                            text=f"✅ Оформить за {TARIFF_META[tariff]['price']} ₽ (тест)",
                            callback_data=f"manualpay:{tariff.value}",
                        )
                    ]
                ]
            ),
        )


@router.message(CommandStart())
async def on_start(message: Message, state: FSMContext) -> None:
    await state.clear()
    if message.from_user is not None:
        async with session_scope() as session:
            await get_or_create_user(session, message.from_user)

    await message.answer(
        WELCOME,
        parse_mode="HTML",
        reply_markup=_welcome_keyboard(),
    )


@router.message(Command("help"))
async def on_help(message: Message) -> None:
    await message.answer(
        "Команды:\n"
        "/start — приветствие\n"
        "/setup — пройти / продолжить настройку бокса\n"
        "/mybox — личный кабинет (статус подписки, дата ближайшего бокса)\n"
        "/cancel — отменить текущий ввод"
    )


@router.message(Command("cancel"))
async def on_cancel(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer("Окей, отменила. Чтобы начать заново — /start.")
