"""The 7-step questionnaire FSM."""
from __future__ import annotations

import logging
from datetime import datetime

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from bot.db import session_scope
from bot.keyboards.common import multi_choice, single_choice, yes_no, confirm_keyboard
from bot.services.admin_notify import notify_admin_full_profile
from bot.services.cycle_code import decode_cycle_code, encode_cycle_code
from bot.services.users import get_or_create_profile, get_or_create_user
from bot.states import Onboarding

log = logging.getLogger(__name__)
router = Router(name="onboarding")


# ---- Static option lists ------------------------------------------------ #

PADS = [
    ("pads-always-ultra-normal", "Always Ultra Normal"),
    ("pads-kotex-young-normal", "Kotex Young Normal"),
    ("pads-naturella-camomile", "Naturella Camomile"),
    ("pads-libresse-invisible", "Libresse Invisible"),
    ("pads-natracare-organic", "Natracare Organic"),
]
TAMPONS = [
    ("tampons-tampax-compak-normal", "Tampax Compak Normal"),
    ("tampons-ob-procomfort-mini", "o.b. ProComfort Mini"),
    ("tampons-kotex-click-super", "Kotex Click Super"),
]
OTHER_HYGIENE = [
    ("cup", "Менструальные чаши"),
    ("panties", "Менструальные трусы"),
]
FLOW_HEAVINESS = [
    ("light", "Скудные"),
    ("normal", "Средние"),
    ("heavy", "Обильные"),
    ("very_heavy", "Очень обильные"),
    ("variable", "По-разному"),
]
ALLERGIES = [
    ("chocolate", "Шоколад"),
    ("nuts", "Орехи"),
    ("gluten", "Глютен"),
    ("lactose", "Лактоза"),
    ("essential_oils", "Эфирные масла"),
    ("fragrance", "Ароматизаторы"),
    ("latex", "Латекс"),
]
DIETS = [
    ("normal", "Обычное"),
    ("healthy", "ПП"),
    ("vegetarian", "Вегетарианство"),
    ("vegan", "Веганство"),
    ("no_sugar", "Без сахара"),
]
GOALS = [
    ("lose", "Худею"),
    ("maintain", "Поддерживаю"),
    ("gain", "Набираю"),
    ("just_care", "Просто забочусь о себе"),
]
JOYS = [
    ("sweets", "Сладкое"),
    ("tea", "Чай"),
    ("face_care", "Уход за лицом"),
    ("body_care", "Уход за телом"),
    ("small_things", "Мелочи (свечи, носки)"),
    ("books", "Книги"),
]
NOVELTY = [
    ("1", "1 — люблю проверенное"),
    ("2", "2"),
    ("3", "3 — серединка"),
    ("4", "4"),
    ("5", "5 — обожаю новинки"),
]
SEASONS = [
    ("winter", "Зима"),
    ("spring", "Весна"),
    ("summer", "Лето"),
    ("autumn", "Осень"),
]
CALMING = [
    ("bath", "Ванна"),
    ("tea", "Чай"),
    ("silence", "Тишина"),
    ("hugs", "Объятия"),
    ("food", "Еда"),
    ("sport", "Спорт"),
]
OCCUPATIONS = [
    ("office", "Офис / удалёнка"),
    ("active", "Активная работа"),
    ("home", "Дома / декрет"),
    ("studying", "Учусь"),
]


# ---- Helpers ------------------------------------------------------------ #


async def _ensure_profile(message_or_callback):
    user_tg = message_or_callback.from_user
    async with session_scope() as session:
        user = await get_or_create_user(session, user_tg)
        profile = await get_or_create_profile(session, user)
        # detach: callers will re-open their own session to write fields
        return user.id, profile.id


def _q(text: str) -> str:
    return f"<b>{text}</b>"


# ---- Step 1: basic ------------------------------------------------------ #


@router.callback_query(F.data == "onboarding:start")
async def begin(cb: CallbackQuery, state: FSMContext) -> None:
    await _ensure_profile(cb)
    await state.set_state(Onboarding.name)
    await cb.message.answer(_q("Шаг 1/7. Как тебя зовут?"), parse_mode="HTML")
    await cb.answer()


@router.message(Command("setup"))
async def begin_via_command(message: Message, state: FSMContext) -> None:
    await _ensure_profile(message)
    await state.set_state(Onboarding.name)
    await message.answer(_q("Шаг 1/7. Как тебя зовут?"), parse_mode="HTML")


@router.message(Onboarding.name)
async def step_name(message: Message, state: FSMContext) -> None:
    name = (message.text or "").strip()
    if not name:
        await message.answer("Напиши, пожалуйста, имя текстом.")
        return
    await _save_field(message, name=name)
    await state.set_state(Onboarding.birth_year)
    await message.answer(_q("Какой у тебя год рождения? (например, 1998)"), parse_mode="HTML")


@router.message(Onboarding.birth_year)
async def step_birth_year(message: Message, state: FSMContext) -> None:
    text = (message.text or "").strip()
    try:
        year = int(text)
    except ValueError:
        await message.answer("Нужно число — год рождения, например 1998.")
        return
    if not 1940 <= year <= datetime.now().year - 8:
        await message.answer("Год выглядит странно, попробуй ещё раз.")
        return
    await _save_field(message, birth_year=year)
    await state.set_state(Onboarding.city)
    await message.answer(_q("Из какого ты города?"), parse_mode="HTML")


@router.message(Onboarding.city)
async def step_city(message: Message, state: FSMContext) -> None:
    city = (message.text or "").strip()
    if not city:
        await message.answer("Город текстом, пожалуйста.")
        return
    await _save_field(message, city=city)
    await state.set_state(Onboarding.flow_code_choice)
    await message.answer(
        _q("У тебя уже есть код синхронизации цикла из приложения Lira?"),
        parse_mode="HTML",
        reply_markup=yes_no(skip=True),
    )


@router.callback_query(Onboarding.flow_code_choice, F.data.in_({"yes", "no", "nav:skip"}))
async def step_flow_choice(cb: CallbackQuery, state: FSMContext) -> None:
    if cb.data == "yes":
        await state.set_state(Onboarding.flow_code_input)
        await cb.message.answer(
            "Пришли код из приложения (8 символов, например <code>4FGA-9XPP</code>).",
            parse_mode="HTML",
        )
    else:
        await state.set_state(Onboarding.cycle_length)
        await cb.message.answer(
            _q("Ок, тогда уточню. Какая средняя длина цикла? (число дней, например 28)"),
            parse_mode="HTML",
        )
    await cb.answer()


@router.message(Onboarding.flow_code_input)
async def step_flow_code(message: Message, state: FSMContext) -> None:
    raw = (message.text or "").strip()
    payload = decode_cycle_code(raw)
    if payload is not None:
        # Valid sync code → skip cycle/period questions and jump to step 2.
        canonical = encode_cycle_code(payload)
        await _save_field(
            message,
            flow_app_code=canonical,
            cycle_sync_code=canonical,
            last_period_start=payload.start_date,
            cycle_length_days=payload.cycle_length,
            period_length_days=payload.period_length,
        )
        await message.answer(
            "Отлично, цикл синхронизирован 💫\n"
            f"• Последние месячные: <b>{payload.start_date:%d.%m.%Y}</b>\n"
            f"• Длина цикла: <b>{payload.cycle_length} дн.</b>\n"
            f"• Длина месячных: <b>{payload.period_length} дн.</b>",
            parse_mode="HTML",
        )
        await _start_step2(message, state)
        return
    # Не код синхронизации — старое поведение (просто сохраним как app code и
    # уточним длины вручную).
    await _save_field(message, flow_app_code=raw.upper())
    await state.set_state(Onboarding.cycle_length)
    await message.answer(
        _q("Спасибо! Ещё уточни — какая средняя длина цикла? (число дней, например 28)"),
        parse_mode="HTML",
    )


@router.message(Onboarding.cycle_length)
async def step_cycle_length(message: Message, state: FSMContext) -> None:
    try:
        days = int((message.text or "").strip())
    except ValueError:
        await message.answer("Введи число дней, например 28.")
        return
    if not 18 <= days <= 60:
        await message.answer("Цикл обычно 21–35 дней. Уточни, пожалуйста.")
        return
    await _save_field(message, cycle_length_days=days)
    await state.set_state(Onboarding.period_length)
    await message.answer(
        _q("Сколько дней обычно длятся месячные? (например, 5)"), parse_mode="HTML"
    )


@router.message(Onboarding.period_length)
async def step_period_length(message: Message, state: FSMContext) -> None:
    try:
        days = int((message.text or "").strip())
    except ValueError:
        await message.answer("Число, например 5.")
        return
    if not 1 <= days <= 14:
        await message.answer("Обычно 3–7 дней. Уточни.")
        return
    await _save_field(message, period_length_days=days)
    # Step 2 begins
    await _start_step2(message, state)


# ---- Step 2: hygiene ---------------------------------------------------- #


async def _start_step2(message: Message, state: FSMContext) -> None:
    await state.update_data(_buf=[])
    await state.set_state(Onboarding.pads)
    await message.answer(
        _q("Шаг 2/7. Прокладки. Какие бренды тебе подходят? (можно несколько)"),
        parse_mode="HTML",
        reply_markup=multi_choice(PADS, set(), columns=1, skip=True),
    )


@router.callback_query(Onboarding.pads, F.data.startswith("toggle:"))
async def pads_toggle(cb: CallbackQuery, state: FSMContext) -> None:
    await _toggle(cb, state, options=PADS)


@router.callback_query(Onboarding.pads, F.data == "multi:done")
async def pads_done(cb: CallbackQuery, state: FSMContext) -> None:
    data = await state.get_data()
    selected = list(data.get("_buf", []))
    await _save_field(cb, hygiene_pads=selected)
    await state.update_data(_buf=[])
    await state.set_state(Onboarding.tampons)
    await cb.message.edit_reply_markup(reply_markup=None)
    await cb.message.answer(
        _q("Тампоны? (можно несколько или пропустить)"),
        parse_mode="HTML",
        reply_markup=multi_choice(TAMPONS, set(), columns=1, skip=True),
    )
    await cb.answer()


@router.callback_query(Onboarding.pads, F.data == "nav:skip")
async def pads_skip(cb: CallbackQuery, state: FSMContext) -> None:
    await _save_field(cb, hygiene_pads=[])
    await state.update_data(_buf=[])
    await state.set_state(Onboarding.tampons)
    await cb.message.edit_reply_markup(reply_markup=None)
    await cb.message.answer(
        _q("Тампоны? (можно несколько или пропустить)"),
        parse_mode="HTML",
        reply_markup=multi_choice(TAMPONS, set(), columns=1, skip=True),
    )
    await cb.answer()


@router.callback_query(Onboarding.tampons, F.data.startswith("toggle:"))
async def tampons_toggle(cb: CallbackQuery, state: FSMContext) -> None:
    await _toggle(cb, state, options=TAMPONS)


@router.callback_query(Onboarding.tampons, F.data.in_({"multi:done", "nav:skip"}))
async def tampons_done(cb: CallbackQuery, state: FSMContext) -> None:
    data = await state.get_data()
    selected = list(data.get("_buf", []))
    await _save_field(cb, hygiene_tampons=selected if cb.data == "multi:done" else [])
    await state.update_data(_buf=[])
    await state.set_state(Onboarding.other_hygiene)
    await cb.message.edit_reply_markup(reply_markup=None)
    await cb.message.answer(
        _q("Чаши и менструальные трусы — интересно?"),
        parse_mode="HTML",
        reply_markup=multi_choice(OTHER_HYGIENE, set(), columns=1, skip=True),
    )
    await cb.answer()


@router.callback_query(Onboarding.other_hygiene, F.data.startswith("toggle:"))
async def other_hygiene_toggle(cb: CallbackQuery, state: FSMContext) -> None:
    await _toggle(cb, state, options=OTHER_HYGIENE)


@router.callback_query(
    Onboarding.other_hygiene, F.data.in_({"multi:done", "nav:skip"})
)
async def other_hygiene_done(cb: CallbackQuery, state: FSMContext) -> None:
    data = await state.get_data()
    selected = list(data.get("_buf", []))
    await _save_field(cb, hygiene_other=selected if cb.data == "multi:done" else [])
    await state.update_data(_buf=[])
    await state.set_state(Onboarding.flow_heaviness)
    await cb.message.edit_reply_markup(reply_markup=None)
    await cb.message.answer(
        _q("Какие месячные по обильности?"),
        parse_mode="HTML",
        reply_markup=single_choice(FLOW_HEAVINESS),
    )
    await cb.answer()


@router.callback_query(Onboarding.flow_heaviness)
async def flow_heaviness_pick(cb: CallbackQuery, state: FSMContext) -> None:
    if cb.data is None or ":" in cb.data:
        await cb.answer()
        return
    await _save_field(cb, flow_heaviness=cb.data)
    await _start_step3(cb, state)


# ---- Step 3: allergies -------------------------------------------------- #


async def _start_step3(cb_or_msg, state: FSMContext) -> None:
    await state.update_data(_buf=[])
    await state.set_state(Onboarding.allergies)
    await _send(
        cb_or_msg,
        _q("Шаг 3/7. Аллергии и непереносимости. Что отметим? (можно несколько или пропустить)"),
        reply_markup=multi_choice(ALLERGIES, set(), columns=2, skip=True),
    )


@router.callback_query(Onboarding.allergies, F.data.startswith("toggle:"))
async def allergies_toggle(cb: CallbackQuery, state: FSMContext) -> None:
    await _toggle(cb, state, options=ALLERGIES)


@router.callback_query(Onboarding.allergies, F.data.in_({"multi:done", "nav:skip"}))
async def allergies_done(cb: CallbackQuery, state: FSMContext) -> None:
    data = await state.get_data()
    selected = list(data.get("_buf", []))
    await _save_field(cb, allergies=selected if cb.data == "multi:done" else [])
    await state.update_data(_buf=[])
    await state.set_state(Onboarding.sensitive_skin)
    await cb.message.edit_reply_markup(reply_markup=None)
    await cb.message.answer(
        _q("Кожа чувствительная?"), parse_mode="HTML", reply_markup=yes_no()
    )
    await cb.answer()


@router.callback_query(Onboarding.sensitive_skin, F.data.in_({"yes", "no"}))
async def sensitive_skin_pick(cb: CallbackQuery, state: FSMContext) -> None:
    await _save_field(cb, sensitive_skin=(cb.data == "yes"))
    await state.set_state(Onboarding.allergy_notes)
    await cb.message.edit_reply_markup(reply_markup=None)
    await cb.message.answer(
        "Дополнительно что-то важное про реакции? (можно написать «нет»)"
    )
    await cb.answer()


@router.message(Onboarding.allergy_notes)
async def allergy_notes(message: Message, state: FSMContext) -> None:
    text = (message.text or "").strip()
    if text.lower() in {"нет", "no", "-"}:
        text = ""
    await _save_field(message, allergy_notes=text)
    # Step 4
    await state.set_state(Onboarding.diet)
    await message.answer(
        _q("Шаг 4/7. Тип питания?"),
        parse_mode="HTML",
        reply_markup=single_choice(DIETS),
    )


# ---- Step 4: lifestyle -------------------------------------------------- #


@router.callback_query(Onboarding.diet)
async def diet_pick(cb: CallbackQuery, state: FSMContext) -> None:
    if cb.data is None or ":" in cb.data:
        await cb.answer()
        return
    await _save_field(cb, diet=cb.data)
    await state.set_state(Onboarding.goal)
    await cb.message.edit_reply_markup(reply_markup=None)
    await cb.message.answer(
        _q("Какая сейчас цель?"),
        parse_mode="HTML",
        reply_markup=single_choice(GOALS),
    )
    await cb.answer()


@router.callback_query(Onboarding.goal)
async def goal_pick(cb: CallbackQuery, state: FSMContext) -> None:
    if cb.data is None or ":" in cb.data:
        await cb.answer()
        return
    await _save_field(cb, goal=cb.data)
    await state.update_data(_buf=[])
    await state.set_state(Onboarding.joys)
    await cb.message.edit_reply_markup(reply_markup=None)
    await cb.message.answer(
        _q("Что радует больше всего? (можно несколько)"),
        parse_mode="HTML",
        reply_markup=multi_choice(JOYS, set(), columns=2),
    )
    await cb.answer()


@router.callback_query(Onboarding.joys, F.data.startswith("toggle:"))
async def joys_toggle(cb: CallbackQuery, state: FSMContext) -> None:
    await _toggle(cb, state, options=JOYS)


@router.callback_query(Onboarding.joys, F.data == "multi:done")
async def joys_done(cb: CallbackQuery, state: FSMContext) -> None:
    data = await state.get_data()
    selected = list(data.get("_buf", []))
    await _save_field(cb, joys=selected)
    await state.update_data(_buf=[])
    await state.set_state(Onboarding.novelty)
    await cb.message.edit_reply_markup(reply_markup=None)
    await cb.message.answer(
        _q("На сколько ты любишь новинки? (1 — люблю проверенное, 5 — обожаю новое)"),
        parse_mode="HTML",
        reply_markup=single_choice(NOVELTY, columns=5),
    )
    await cb.answer()


@router.callback_query(Onboarding.novelty)
async def novelty_pick(cb: CallbackQuery, state: FSMContext) -> None:
    if cb.data is None or ":" in cb.data:
        await cb.answer()
        return
    try:
        score = int(cb.data)
    except ValueError:
        await cb.answer()
        return
    await _save_field(cb, novelty_score=score)
    await state.set_state(Onboarding.dislikes)
    await cb.message.edit_reply_markup(reply_markup=None)
    await cb.message.answer(
        "Какие запахи или вкусы точно не любишь? (текст или «нет»)"
    )
    await cb.answer()


@router.message(Onboarding.dislikes)
async def dislikes_text(message: Message, state: FSMContext) -> None:
    text = (message.text or "").strip()
    if text.lower() in {"нет", "no", "-"}:
        text = ""
    await _save_field(message, dislikes=text)
    # Step 5
    await state.set_state(Onboarding.favorite_season)
    await message.answer(
        _q("Шаг 5/7. Любимое время года?"),
        parse_mode="HTML",
        reply_markup=single_choice(SEASONS, columns=2),
    )


# ---- Step 5: deep preferences ------------------------------------------ #


@router.callback_query(Onboarding.favorite_season)
async def season_pick(cb: CallbackQuery, state: FSMContext) -> None:
    if cb.data is None or ":" in cb.data:
        await cb.answer()
        return
    await _save_field(cb, favorite_season=cb.data)
    await state.update_data(_buf=[])
    await state.set_state(Onboarding.calming)
    await cb.message.edit_reply_markup(reply_markup=None)
    await cb.message.answer(
        _q("Что тебя успокаивает? (можно несколько)"),
        parse_mode="HTML",
        reply_markup=multi_choice(CALMING, set(), columns=2),
    )
    await cb.answer()


@router.callback_query(Onboarding.calming, F.data.startswith("toggle:"))
async def calming_toggle(cb: CallbackQuery, state: FSMContext) -> None:
    await _toggle(cb, state, options=CALMING)


@router.callback_query(Onboarding.calming, F.data == "multi:done")
async def calming_done(cb: CallbackQuery, state: FSMContext) -> None:
    data = await state.get_data()
    selected = list(data.get("_buf", []))
    await _save_field(cb, calming=selected)
    await state.set_state(Onboarding.occupation)
    await cb.message.edit_reply_markup(reply_markup=None)
    await cb.message.answer(
        _q("Чем занимаешься?"),
        parse_mode="HTML",
        reply_markup=single_choice(OCCUPATIONS),
    )
    await cb.answer()


@router.callback_query(Onboarding.occupation)
async def occupation_pick(cb: CallbackQuery, state: FSMContext) -> None:
    if cb.data is None or ":" in cb.data:
        await cb.answer()
        return
    await _save_field(cb, occupation=cb.data)
    await state.set_state(Onboarding.hobbies)
    await cb.message.edit_reply_markup(reply_markup=None)
    await cb.message.answer(
        "Хобби? Можно «нет», если не хочешь рассказывать."
    )
    await cb.answer()


@router.message(Onboarding.hobbies)
async def hobbies_text(message: Message, state: FSMContext) -> None:
    text = (message.text or "").strip()
    if text.lower() in {"нет", "no", "-"}:
        text = ""
    await _save_field(message, hobbies=text)
    # Step 6: address
    await state.set_state(Onboarding.address_country)
    await message.answer(
        _q("Шаг 6/7. Адрес доставки. Страна?"), parse_mode="HTML"
    )


# ---- Step 6: address ---------------------------------------------------- #

ADDRESS_CHAIN: list[tuple[str, str, str]] = [
    ("address_country", "Страна?", "address_city"),
    ("address_city", "Город?", "address_street"),
    ("address_street", "Улица?", "address_building"),
    ("address_building", "Дом / корпус?", "address_apartment"),
    ("address_apartment", "Квартира / офис? (или «-»)", "address_postal"),
    ("address_postal", "Индекс? (или «-»)", "address_phone"),
    ("address_phone", "Телефон для курьера?", None),
]


def _next_address_state(current: Onboarding) -> Onboarding | None:
    name = current.state.split(":")[-1] if isinstance(current, type(Onboarding.address_country)) else None
    name = current.state.split(":")[-1]
    for field, _q, nxt in ADDRESS_CHAIN:
        if field == name:
            if nxt is None:
                return None
            return getattr(Onboarding, nxt)
    return None


@router.message(Onboarding.address_country)
async def addr_country(message: Message, state: FSMContext) -> None:
    await _save_address(message, state, "address_country")


@router.message(Onboarding.address_city)
async def addr_city(message: Message, state: FSMContext) -> None:
    await _save_address(message, state, "address_city")


@router.message(Onboarding.address_street)
async def addr_street(message: Message, state: FSMContext) -> None:
    await _save_address(message, state, "address_street")


@router.message(Onboarding.address_building)
async def addr_building(message: Message, state: FSMContext) -> None:
    await _save_address(message, state, "address_building")


@router.message(Onboarding.address_apartment)
async def addr_apartment(message: Message, state: FSMContext) -> None:
    await _save_address(message, state, "address_apartment")


@router.message(Onboarding.address_postal)
async def addr_postal(message: Message, state: FSMContext) -> None:
    await _save_address(message, state, "address_postal")


@router.message(Onboarding.address_phone)
async def addr_phone(message: Message, state: FSMContext) -> None:
    await _save_address(message, state, "address_phone")


async def _save_address(message: Message, state: FSMContext, field: str) -> None:
    text = (message.text or "").strip()
    if text in {"-", "—"}:
        text = ""
    if field in {"address_country", "address_city", "address_street", "address_phone"} and not text:
        await message.answer("Это поле обязательно. Напиши, пожалуйста.")
        return
    await _save_field(message, **{field: text})

    # advance
    chain = [c[0] for c in ADDRESS_CHAIN]
    idx = chain.index(field)
    if idx + 1 < len(chain):
        next_field = chain[idx + 1]
        next_state = getattr(Onboarding, next_field)
        await state.set_state(next_state)
        prompt = next(q for f, q, _ in ADDRESS_CHAIN if f == next_field)
        await message.answer(prompt)
    else:
        # Questionnaire fully completed — send the full digest to admin in
        # one message right before the client picks a tariff.
        async with session_scope() as session:
            user = await get_or_create_user(session, message.from_user)
            profile = await get_or_create_profile(session, user)
            await notify_admin_full_profile(
                message.bot, message.from_user, profile
            )
        # Step 7
        await state.set_state(Onboarding.tariff)
        data = await state.get_data()
        preselect = data.get("_preselected_tariff")
        if isinstance(preselect, str) and preselect in {"basic", "vip"}:
            await _send_box_invoice(message, state, preselect)
        else:
            await _show_tariffs(message)


# ---- Step 7: tariff selection — defers to payment.py ------------------- #


async def _show_tariffs(message: Message) -> None:
    from bot.handlers.payment import show_tariffs  # local import to avoid cycle
    await show_tariffs(message)


async def _send_box_invoice(
    message: Message, state: FSMContext, tariff_value: str
) -> None:
    """Skip the manual tariff picker and go straight to invoicing."""
    from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

    from bot.models import Tariff
    from bot.services.payments import TARIFF_META, send_invoice

    try:
        tariff = Tariff(tariff_value)
    except ValueError:
        await _show_tariffs(message)
        return
    await state.update_data(_tariff=tariff.value)
    await state.set_state(Onboarding.waiting_payment)
    sent = await send_invoice(message.bot, message.chat.id, tariff)
    if not sent:
        await message.answer(
            "Платёжный провайдер пока не настроен. Можешь оформить в "
            "тестовом режиме — нажми кнопку ниже.",
            reply_markup=InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        InlineKeyboardButton(
                            text=(
                                f"✅ Оформить за {TARIFF_META[tariff]['price']} ₽ (тест)"
                            ),
                            callback_data=f"manualpay:{tariff.value}",
                        )
                    ]
                ]
            ),
        )


# ---- Helpers ------------------------------------------------------------ #


async def _save_field(event, **fields) -> None:
    """Persist the given Profile field(s) for the user behind `event`."""
    user_tg = event.from_user
    async with session_scope() as session:
        user = await get_or_create_user(session, user_tg)
        profile = await get_or_create_profile(session, user)
        for k, v in fields.items():
            setattr(profile, k, v)


async def _toggle(cb: CallbackQuery, state: FSMContext, *, options: list[tuple[str, str]]) -> None:
    if cb.data is None or not cb.data.startswith("toggle:"):
        await cb.answer()
        return
    value = cb.data.split(":", 1)[1]
    data = await state.get_data()
    buf: list[str] = list(data.get("_buf", []))
    if value in buf:
        buf.remove(value)
    else:
        buf.append(value)
    await state.update_data(_buf=buf)
    await cb.message.edit_reply_markup(
        reply_markup=multi_choice(options, set(buf), columns=2 if len(options) > 4 else 1, skip=True)
    )
    await cb.answer()


async def _send(event, text: str, **kw):
    if isinstance(event, CallbackQuery):
        await event.message.edit_reply_markup(reply_markup=None)
        await event.message.answer(text, parse_mode="HTML", **kw)
        await event.answer()
    else:
        await event.answer(text, parse_mode="HTML", **kw)
