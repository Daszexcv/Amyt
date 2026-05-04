"""Tariff selection + Telegram Payments + activation code issuing."""
from __future__ import annotations

import logging

from aiogram import F, Router
from aiogram.fsm.context import FSMContext
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    PreCheckoutQuery,
)

from bot.config import get_settings
from bot.db import session_scope
from bot.models import Tariff
from bot.services.payments import TARIFF_META, finalize_payment, send_invoice
from bot.services.users import get_or_create_user
from bot.states import Onboarding

log = logging.getLogger(__name__)
router = Router(name="payment")


def _tariff_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text=f"Premium — {TARIFF_META[Tariff.PREMIUM]['price']}₽/мес",
                    callback_data="tariff:premium",
                )
            ],
            [
                InlineKeyboardButton(
                    text=f"Базовый — {TARIFF_META[Tariff.BASIC]['price']}₽/мес",
                    callback_data="tariff:basic",
                )
            ],
            [
                InlineKeyboardButton(
                    text=f"VIP — {TARIFF_META[Tariff.VIP]['price']}₽/мес",
                    callback_data="tariff:vip",
                )
            ],
        ]
    )


async def show_tariffs(message: Message) -> None:
    text = (
        "<b>Шаг 7/7. Выбери тариф</b>\n\n"
        "✨ <b>Lira Premium — 199₽/мес</b>\n"
        "Цифровой тариф: расширенная аналитика цикла, прогноз овуляции, "
        "экспорт в PDF/CSV, гайды. Без бокса.\n\n"
        "🌸 <b>Базовый — 999₽/мес</b>\n"
        "До 5 предметов: средства гигиены, шоколадка, 1 средство ухода.\n\n"
        "💎 <b>VIP — 1999₽/мес</b>\n"
        "До 8 предметов + сюрприз: органика, шоколад ручной работы, "
        "3 средства ухода, чай, гайды по фазам цикла."
    )
    await message.answer(text, parse_mode="HTML", reply_markup=_tariff_keyboard())


@router.callback_query(Onboarding.tariff, F.data.startswith("tariff:"))
async def pick_tariff(cb: CallbackQuery, state: FSMContext) -> None:
    raw = (cb.data or "").split(":", 1)[1]
    try:
        tariff = Tariff(raw)
    except ValueError:
        await cb.answer("Неизвестный тариф", show_alert=True)
        return
    settings = get_settings()
    await state.update_data(_tariff=tariff.value)
    await state.set_state(Onboarding.waiting_payment)
    await cb.message.edit_reply_markup(reply_markup=None)

    sent = await send_invoice(cb.message.bot, cb.message.chat.id, tariff)
    if not sent:
        # No provider token — fall back to manual confirmation
        await cb.message.answer(
            f"Платёжный провайдер не настроен. Напиши администратору и пришли подтверждение оплаты, "
            f"либо нажми «Я оплатила» для тестового подтверждения.",
            reply_markup=InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        InlineKeyboardButton(
                            text="✅ Я оплатила (тест)",
                            callback_data=f"manualpay:{tariff.value}",
                        )
                    ]
                ]
            ),
        )
    await cb.answer()


@router.callback_query(Onboarding.waiting_payment, F.data.startswith("manualpay:"))
async def manual_pay(cb: CallbackQuery, state: FSMContext) -> None:
    raw = (cb.data or "").split(":", 1)[1]
    try:
        tariff = Tariff(raw)
    except ValueError:
        await cb.answer()
        return
    await cb.message.edit_reply_markup(reply_markup=None)
    await _complete_payment(
        cb,
        state,
        tariff=tariff,
        payment_id="manual-test",
        amount_rub=TARIFF_META[tariff]["price"],
    )


@router.pre_checkout_query()
async def on_pre_checkout(pre_checkout: PreCheckoutQuery) -> None:
    await pre_checkout.answer(ok=True)


@router.message(F.successful_payment)
async def on_successful_payment(message: Message, state: FSMContext) -> None:
    sp = message.successful_payment
    if sp is None:
        return
    payload = sp.invoice_payload or ""
    if not payload.startswith("flowcare:"):
        return
    raw = payload.split(":", 1)[1]
    try:
        tariff = Tariff(raw)
    except ValueError:
        return
    await _complete_payment(
        message,
        state,
        tariff=tariff,
        payment_id=sp.provider_payment_charge_id or sp.telegram_payment_charge_id,
        amount_rub=sp.total_amount // 100,
    )


async def _complete_payment(
    event,
    state: FSMContext,
    *,
    tariff: Tariff,
    payment_id: str,
    amount_rub: int,
) -> None:
    settings = get_settings()
    user_tg = event.from_user
    async with session_scope() as session:
        user = await get_or_create_user(session, user_tg)
        order, code_value = await finalize_payment(
            session,
            user=user,
            tariff=tariff,
            payment_id=payment_id,
            amount_rub=amount_rub,
        )

    if tariff == Tariff.PREMIUM:
        unlock_tail = (
            "Сразу разблокируются: расширенная аналитика, история циклов, "
            "детальный прогноз овуляции, экспорт PDF/CSV и гайды."
        )
    else:
        unlock_tail = (
            "Я начну собирать твой первый бокс к ближайшим месячным."
        )
    text = (
        "✨ Готово! Подписка оформлена.\n\n"
        f"<b>Тариф:</b> {TARIFF_META[tariff]['title']}\n"
        f"<b>Срок:</b> 30 дней\n\n"
        "Открой приложение <b>Lira</b> → вкладка «Подписка». Подписка "
        "подтянется автоматически, как только приложение синхронизируется "
        "с ботом. Если ты ещё не отправляла мне свой код синхронизации цикла, "
        "пришли его командой <code>/sync XXXX-XXXX</code> — код виден в "
        "приложении на экране «Подписка».\n\n"
        f"{unlock_tail}\n\n"
        "Если auto-sync не сработает — есть запасной вариант. Запасной код "
        f"активации:\n<code>{code_value}</code>\n"
        "В приложении нажми «Подписка не подтянулась? Ввести код вручную» и вставь его.\n\n"
        "Команда /mybox — посмотреть статус подписки."
    )
    await _send(event, text)

    bot = event.bot if hasattr(event, "bot") else event.message.bot
    if settings.admin_chat_id:
        try:
            await bot.send_message(
                settings.admin_chat_id,
                f"💰 Новая оплата от <a href='tg://user?id={user_tg.id}'>"
                f"{user_tg.first_name or user_tg.username or user_tg.id}</a>\n"
                f"Тариф: {tariff.value} • {amount_rub}₽\n"
                f"Код: <code>{code_value}</code>",
                parse_mode="HTML",
            )
        except Exception:  # noqa: BLE001
            log.exception("Failed to notify admin chat")

    await state.clear()


async def _send(event, text: str) -> None:
    if isinstance(event, CallbackQuery):
        await event.message.answer(text, parse_mode="HTML")
        await event.answer()
    else:
        await event.answer(text, parse_mode="HTML")
