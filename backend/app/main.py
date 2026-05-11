"""Lira chat backend.

Exposes the contract that the existing Lira web bundle already speaks:

    GET  /v1/lira/status  -> {"enabled": bool}
    POST /v1/lira/chat    -> {"reply": str}

Behind the scenes we call Pollinations.ai's free OpenAI-compatible chat
endpoint (no API key required) and wrap it with a "warm cycle confidante"
system prompt that knows about the user's cycle day / phase, so Лира stays
in character.

Why Pollinations.ai:
- Free, no API key, no signup.
- Reachable from Russia without proxies.
- OpenAI-compatible /openai endpoint.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

import httpx

# Load any .env file shipped alongside this package (used to thread Fly.io
# secrets into the running container without having to call `fly secrets set`).
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
if _ENV_FILE.is_file():
    for _line in _ENV_FILE.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if not _line or _line.startswith("#") or "=" not in _line:
            continue
        _k, _, _v = _line.partition("=")
        _k, _v = _k.strip(), _v.strip().strip('"').strip("'")
        os.environ.setdefault(_k, _v)
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

LOGGER = logging.getLogger("lira")
logging.basicConfig(level=logging.INFO)

POLLINATIONS_URL = os.environ.get(
    "POLLINATIONS_URL", "https://text.pollinations.ai/openai"
).strip()
POLLINATIONS_MODEL = os.environ.get("POLLINATIONS_MODEL", "openai").strip()
# Pollinations' free anonymous tier really only has one model (openai-fast aka
# `openai`). The other names we used to try (mistral, llama) 404, so on a 5xx
# we retry the same model with a short jittered backoff instead of swapping.
POLLINATIONS_RETRIES = int(os.environ.get("POLLINATIONS_RETRIES", "3"))

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
TELEGRAM_API = "https://api.telegram.org"

PHASE_RU: dict[str, str] = {
    "menstrual": "Менструация (может быть усталость, боль, низкая энергия).",
    "follicular": "Фолликулярная фаза (энергия растёт, настроение хорошее).",
    "ovulation": "Овуляция (пик энергии, иногда лёгкая боль в боку).",
    "luteal": "Лютеиновая фаза (ПМС, эмоции ярче, тянет на сладкое).",
}


def build_system_prompt(cycle_day: int | None, phase: str | None) -> str:
    lines = [
        "Ты — Лира, тёплая подруга-собеседница в приложении для отслеживания женского цикла.",
        "Отвечай ВСЕГДА по-русски, коротко (3–6 предложений), мягко и без медицинских диагнозов.",
        "Ты не врач: при жалобах на боль или тревожные симптомы мягко предложи обратиться к врачу.",
        "Избегай лекарственных советов и дозировок. Можешь предложить бытовые практики заботы (вода, тепло, отдых, прогулка, дыхание).",
        "Фокус на эмоциях, поддержке, хорошем настроении и бытовых лайфхаках для жизни с циклом.",
        "Используй мягкие эмодзи изредка (🌿, 💫, ✨, 🥰). Не спамь ими и не пиши их в каждом предложении.",
        "Не выдумывай факты о пользователе — если чего-то не знаешь, мягко уточни.",
    ]
    if isinstance(cycle_day, int) and cycle_day > 0:
        lines.append(f"Сейчас у пользователя {cycle_day}-й день цикла.")
    if isinstance(phase, str) and phase in PHASE_RU:
        lines.append(f"Фаза: {PHASE_RU[phase]}")
    return " ".join(lines)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str
    ts: int | None = None
    id: str | None = None


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list)
    cycle_day: int | None = None
    phase: str | None = None


class ChatResponse(BaseModel):
    reply: str


class StatusResponse(BaseModel):
    enabled: bool
    model: str | None = None


class OnboardingProfile(BaseModel):
    name: str | None = None
    birthdate: str | None = None


class OnboardingSettings(BaseModel):
    averageCycleLength: int | None = None
    averagePeriodLength: int | None = None
    lutealPhaseLength: int | None = None
    language: str | None = None


class OnboardingShipping(BaseModel):
    country: str | None = None
    city: str | None = None
    street: str | None = None
    building: str | None = None
    apartment: str | None = None
    postalCode: str | None = None
    phone: str | None = None


class OnboardingRequest(BaseModel):
    device_id: str | None = None
    user_agent: str | None = None
    locale: str | None = None
    timezone: str | None = None
    profile: OnboardingProfile | None = None
    settings: OnboardingSettings | None = None
    shippingAddress: OnboardingShipping | None = None
    logs: dict[str, dict[str, Any]] = Field(default_factory=dict)
    boxProfile: dict[str, Any] | None = None
    subscription: dict[str, Any] | None = None
    subSurvey: dict[str, Any] | None = None
    cycle_day: int | None = None
    phase: str | None = None


class OnboardingResponse(BaseModel):
    delivered: bool
    detail: str | None = None


app = FastAPI(
    title="Lira chat backend",
    version="0.1.0",
    docs_url="/docs",
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    allow_credentials=False,
    max_age=86400,
)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/lira/status", response_model=StatusResponse)
async def lira_status() -> StatusResponse:
    return StatusResponse(enabled=True, model=POLLINATIONS_MODEL)


@app.post("/v1/lira/onboarding", response_model=OnboardingResponse)
async def lira_onboarding(req: OnboardingRequest) -> OnboardingResponse:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        LOGGER.warning("telegram notify skipped: bot token or chat id not configured")
        return OnboardingResponse(delivered=False, detail="telegram_not_configured")

    text = build_telegram_message(req)
    url = f"{TELEGRAM_API}/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=8.0)) as client:
            resp = await client.post(url, json=payload)
    except httpx.HTTPError as exc:
        LOGGER.error("telegram network error: %s", exc)
        return OnboardingResponse(delivered=False, detail="network")

    if resp.status_code >= 400:
        LOGGER.error("telegram http %s: %s", resp.status_code, resp.text[:300])
        return OnboardingResponse(
            delivered=False, detail=f"http_{resp.status_code}"
        )
    return OnboardingResponse(delivered=True)


@app.post("/v1/lira/chat", response_model=ChatResponse)
async def lira_chat(req: ChatRequest) -> ChatResponse:
    system_prompt = build_system_prompt(req.cycle_day, req.phase)
    history: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    for m in req.messages[-12:]:
        text = (m.content or "").strip()
        if not text:
            continue
        if m.role == "assistant":
            history.append({"role": "assistant", "content": text})
        else:
            history.append({"role": "user", "content": text})

    if not any(m["role"] == "user" for m in history):
        return ChatResponse(reply="Расскажи, что у тебя сейчас на сердце? 🌿")

    payload: dict[str, Any] = {
        "model": POLLINATIONS_MODEL,
        "messages": history,
        "temperature": 0.85,
        "top_p": 0.9,
        "max_tokens": 320,
    }
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    last_error: str | None = None
    async with httpx.AsyncClient(timeout=httpx.Timeout(40.0, connect=8.0)) as client:
        for attempt in range(1, max(POLLINATIONS_RETRIES, 1) + 1):
            try:
                resp = await client.post(POLLINATIONS_URL, json=payload, headers=headers)
            except httpx.TimeoutException as exc:
                LOGGER.warning("pollinations timeout attempt=%d: %s", attempt, exc)
                last_error = "timeout"
            except httpx.HTTPError as exc:
                LOGGER.warning("pollinations network error attempt=%d: %s", attempt, exc)
                last_error = "network"
            else:
                if resp.status_code < 400:
                    try:
                        data = resp.json()
                    except ValueError:
                        LOGGER.warning(
                            "pollinations non-json attempt=%d: %r", attempt, resp.text[:300]
                        )
                        last_error = "non_json"
                    else:
                        reply = _extract_reply(data)
                        if reply:
                            return ChatResponse(reply=reply)
                        last_error = "empty"
                        LOGGER.warning(
                            "pollinations empty reply attempt=%d: %s",
                            attempt,
                            str(data)[:300],
                        )
                else:
                    LOGGER.warning(
                        "pollinations http %s attempt=%d: %s",
                        resp.status_code,
                        attempt,
                        resp.text[:300],
                    )
                    last_error = f"http_{resp.status_code}"
                    if resp.status_code in (400, 401, 403, 404):
                        # Hard failure unrelated to load; no point in retrying.
                        break

            if attempt < POLLINATIONS_RETRIES:
                await asyncio.sleep(1.0 + random.random() * 1.5)

    LOGGER.error("all pollinations attempts failed: %s", last_error)
    return ChatResponse(reply=_canned_fallback(req.phase))


def _fmt_date(value: str | None) -> str | None:
    if not value:
        return None
    try:
        d = date.fromisoformat(value[:10])
    except (TypeError, ValueError):
        return value
    return d.strftime("%d.%m.%Y")


def _extract_all_period_runs(
    logs: dict[str, dict[str, Any]] | None,
) -> list[tuple[date, date]]:
    """Find every contiguous run of dates with non-empty/non-'none' flow.

    Returns runs as (start_date, end_date) tuples sorted ascending by start.
    """

    if not logs:
        return []
    period_days: list[date] = []
    for key, entry in logs.items():
        if not isinstance(entry, dict):
            continue
        flow = entry.get("flow")
        if not flow or flow == "none":
            continue
        try:
            period_days.append(date.fromisoformat(key[:10]))
        except ValueError:
            continue
    if not period_days:
        return []
    period_days.sort()
    runs: list[tuple[date, date]] = []
    run_start = period_days[0]
    prev = period_days[0]
    for d in period_days[1:]:
        if (d - prev).days <= 1:
            prev = d
            continue
        runs.append((run_start, prev))
        run_start = d
        prev = d
    runs.append((run_start, prev))
    return runs


def _extract_period_ranges(
    logs: dict[str, dict[str, Any]] | None, limit: int = 3
) -> list[tuple[date, date]]:
    """Most-recent N period runs (newest first)."""

    runs = _extract_all_period_runs(logs)
    runs.sort(key=lambda pair: pair[0], reverse=True)
    return runs[:limit]


def _effective_cycle_period(
    runs: list[tuple[date, date]], settings: OnboardingSettings
) -> tuple[int, int]:
    """Pick the effective cycle/period length the same way the app does.

    For cycle length we use the rolling average of the last 3–6 inter-start
    gaps (in [15, 60] days). For period length we average run sizes. Fall
    back to the manual onboarding settings when there is not enough history.
    """

    # runs is newest-first; sort ascending for delta math.
    asc = sorted(runs, key=lambda pair: pair[0])
    gaps: list[int] = []
    for i in range(1, len(asc)):
        delta = (asc[i][0] - asc[i - 1][0]).days
        if 15 <= delta <= 60:
            gaps.append(delta)
    recent = gaps[-6:]
    cycle_len = (
        round(sum(recent) / len(recent))
        if len(recent) >= 3
        else (settings.averageCycleLength or 28)
    )

    period_lengths = [(end - start).days + 1 for start, end in asc]
    period_len = (
        round(sum(period_lengths) / len(period_lengths))
        if period_lengths
        else (settings.averagePeriodLength or 5)
    )
    # Guard against pathological 0/negative values.
    cycle_len = max(15, min(60, int(cycle_len)))
    period_len = max(1, min(14, int(period_len)))
    return cycle_len, period_len


def _build_forecast(
    logs: dict[str, dict[str, Any]] | None,
    settings: OnboardingSettings,
    today: date | None = None,
    horizon: int = 4,
) -> tuple[list[tuple[date, date]], date | None, tuple[date, date] | None]:
    """Forecast the next ``horizon`` cycles + the nearest ovulation/fertile window.

    Returns ``(future_periods, next_ovulation, fertile_window)``. Future periods
    are listed in chronological order; the first item is the next predicted
    period after ``today``. Returns empty list if there is no period history.
    """

    if today is None:
        today = datetime.now(timezone.utc).date()
    runs_asc = sorted(_extract_all_period_runs(logs), key=lambda pair: pair[0])
    if not runs_asc:
        return [], None, None
    cycle_len, period_len = _effective_cycle_period(runs_asc, settings)
    luteal = settings.lutealPhaseLength or 14
    luteal = max(8, min(20, int(luteal)))

    last_start = runs_asc[-1][0]
    next_start = last_start + timedelta(days=cycle_len)
    while (next_start - today).days < 0:
        next_start = next_start + timedelta(days=cycle_len)

    future: list[tuple[date, date]] = []
    for i in range(horizon):
        start = next_start + timedelta(days=cycle_len * i)
        end = start + timedelta(days=max(0, period_len - 1))
        future.append((start, end))

    ovulation = next_start - timedelta(days=luteal)
    fertile = (ovulation - timedelta(days=5), ovulation + timedelta(days=1))
    return future, ovulation, fertile


PHASE_LABEL_RU = {
    "menstrual": "Менструация",
    "follicular": "Фолликулярная",
    "ovulation": "Овуляция",
    "luteal": "Лютеиновая",
}

HYGIENE_LABEL_RU = {
    "pads_regular": "Прокладки обычные",
    "pads_organic": "Прокладки органические",
    "tampons": "Тампоны",
    "cup": "Менструальная чаша",
    "period_underwear": "Менструальные трусы",
    "none": "Ничего не нужно",
}
FLOW_LABEL_RU = {
    "light": "Лёгкие",
    "medium": "Средние",
    "heavy": "Обильные",
}
ALLERGY_LABEL_RU = {
    "chocolate": "Шоколад",
    "nuts": "Орехи",
    "gluten": "Глютен",
    "lactose": "Лактоза",
    "essential_oils": "Эфирные масла",
    "fragrance": "Ароматизаторы",
    "latex": "Латекс",
}
DIET_LABEL_RU = {
    "regular": "Обычное",
    "healthy": "ПП",
    "vegetarian": "Вегетарианство",
    "vegan": "Веганство",
    "sugar_free": "Без сахара",
}
GOAL_LABEL_RU = {
    "weight_loss": "Худею",
    "weight_gain": "Набор массы",
    "self_care": "Просто забота",
}
FLAVOR_LABEL_RU = {
    "chocolate": "Шоколад",
    "fruits": "Фрукты",
    "citrus": "Цитрус",
    "mint": "Мята",
}
CARE_LABEL_RU = {
    "face_masks": "Маски",
    "eye_patches": "Патчи",
    "candles": "Свечи",
    "tea": "Чай",
    "cream": "Крем",
    "balm": "Бальзам",
    "scrub": "Скраб",
}
TARIFF_LABEL_RU = {
    "premium": "Премиум",
    "basic": "Твой ритм",
    "vip": "Полная симфония",
    "free": "Без подписки",
}


def _translate(values: Any, table: dict[str, str]) -> list[str]:
    """Convert a list/single code value into Russian labels (falling back to the
    raw code if it isn't in ``table``)."""

    if values is None:
        return []
    if isinstance(values, str):
        items = [values]
    elif isinstance(values, (list, tuple)):
        items = [str(v) for v in values if v is not None and v != ""]
    else:
        items = [str(values)]
    return [table.get(item, item) for item in items]


def _escape_html(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _fmt_run(start: date, end: date) -> str:
    if start == end:
        return f"{start.strftime('%d.%m.%Y')} (1 день)"
    length = (end - start).days + 1
    return (
        f"{start.strftime('%d.%m.%Y')} — {end.strftime('%d.%m.%Y')} "
        f"({length} дн.)"
    )


def build_telegram_message(req: OnboardingRequest) -> str:
    profile = req.profile or OnboardingProfile()
    settings = req.settings or OnboardingSettings()
    shipping = req.shippingAddress or OnboardingShipping()

    name = (profile.name or "").strip() or "—"
    birthdate = _fmt_date(profile.birthdate) or "—"

    lines: list[str] = [
        "🌿 <b>Новый онбординг в Lira</b>",
        "",
        f"👤 <b>Имя:</b> {_escape_html(name)}",
        f"🎂 <b>Дата рождения:</b> {_escape_html(birthdate)}",
    ]

    if settings.averageCycleLength:
        lines.append(f"🔁 <b>Длина цикла:</b> {settings.averageCycleLength} дн.")
    if settings.averagePeriodLength:
        lines.append(
            f"🩸 <b>Длина месячных:</b> {settings.averagePeriodLength} дн."
        )
    if req.cycle_day:
        phase_human = PHASE_LABEL_RU.get(req.phase or "", req.phase or "—")
        lines.append(
            f"📆 <b>Сегодня:</b> день {req.cycle_day}, фаза — {_escape_html(phase_human)}"
        )

    runs = _extract_period_ranges(req.logs, limit=3)
    if runs:
        lines.append("")
        lines.append("🩸 <b>Месячные (последние):</b>")
        for start, end in runs:
            lines.append(f"• {_fmt_run(start, end)}")

    future, ovulation, fertile = _build_forecast(
        req.logs, settings, horizon=4
    )
    if future:
        today = datetime.now(timezone.utc).date()
        lines.append("")
        lines.append("🔮 <b>Прогноз следующих циклов:</b>")
        for idx, (start, end) in enumerate(future):
            extra = ""
            if idx == 0:
                days_until = (start - today).days
                if days_until == 0:
                    extra = " — сегодня"
                elif days_until == 1:
                    extra = " — завтра"
                elif days_until > 1:
                    extra = f" — через {days_until} дн."
            lines.append(f"• {_fmt_run(start, end)}{extra}")
        if ovulation:
            lines.append(
                f"⚡️ <b>Ближайшая овуляция:</b> {ovulation.strftime('%d.%m.%Y')}"
            )
        if fertile:
            fs, fe = fertile
            lines.append(
                f"💞 <b>Фертильное окно:</b> {fs.strftime('%d.%m.%Y')} — "
                f"{fe.strftime('%d.%m.%Y')}"
            )

    has_address = any(
        getattr(shipping, f, None)
        for f in ("country", "city", "street", "building", "postalCode", "phone")
    )
    if has_address:
        addr_parts = [
            shipping.postalCode,
            shipping.country,
            shipping.city,
            shipping.street,
            shipping.building,
            shipping.apartment,
        ]
        addr = ", ".join(p for p in addr_parts if p)
        lines.append("")
        lines.append("📦 <b>Адрес доставки:</b>")
        if addr:
            lines.append(f"  {_escape_html(addr)}")
        if shipping.phone:
            lines.append(f"  ☎ {_escape_html(shipping.phone)}")

    if req.subscription:
        sub = req.subscription
        tier_code = (sub.get("tier") or "").strip()
        tier_human = (
            sub.get("tierTitle")
            or TARIFF_LABEL_RU.get(tier_code, tier_code or "—")
        )
        sub_bits = [_escape_html(str(tier_human))]
        if sub.get("price"):
            sub_bits.append(f"{_escape_html(str(sub['price']))} ₽/мес")
        if sub.get("orderId"):
            sub_bits.append(f"заказ {_escape_html(str(sub['orderId']))}")
        if sub.get("paidAt"):
            sub_bits.append(
                f"оплачено {_escape_html(_fmt_date(str(sub['paidAt'])) or '')}"
            )
        if sub.get("cardLast4"):
            sub_bits.append(f"карта •• {_escape_html(str(sub['cardLast4']))}")
        if sub.get("stub"):
            sub_bits.append("<i>(тестовая оплата)</i>")
        lines.append("")
        lines.append("💎 <b>Подписка:</b> " + " · ".join(sub_bits))

    if req.subSurvey and isinstance(req.subSurvey, dict):
        answers = req.subSurvey.get("answers")
        tariff = req.subSurvey.get("tariff") or {}
        if isinstance(answers, dict) and answers:
            lines.append("")
            tariff_title = tariff.get("title") or TARIFF_LABEL_RU.get(
                tariff.get("slug", ""), tariff.get("slug", "")
            )
            header = "📝 <b>Опросник подписки</b>"
            if tariff_title:
                header += f" — {_escape_html(str(tariff_title))}"
            lines.append(header)
            survey_labels = {
                "hygiene": "Гигиена",
                "hygiene_brands": "Бренды гигиены",
                "allergies": "Аллергии и ограничения",
                "sweet": "Сладкое",
                "care": "Уход",
                "skin": "Тип кожи",
                "tea": "Чай",
                "address": "Адрес",
                "promo": "Промокод",
            }
            for key, value in answers.items():
                label = survey_labels.get(key, key)
                if value is None or value == "":
                    continue
                if isinstance(value, list):
                    if not value:
                        continue
                    rendered = ", ".join(str(v) for v in value)
                elif isinstance(value, dict):
                    parts = [
                        f"{k}: {v}" for k, v in value.items() if v not in (None, "")
                    ]
                    if not parts:
                        continue
                    rendered = "; ".join(parts)
                else:
                    rendered = str(value)
                lines.append(f"  • {_escape_html(label)}: {_escape_html(rendered)}")

    if req.boxProfile and isinstance(req.boxProfile, dict):
        bp = req.boxProfile
        bp_lines: list[str] = []
        hygiene = _translate(bp.get("hygieneTypes"), HYGIENE_LABEL_RU)
        if hygiene:
            bp_lines.append("  Гигиена: " + _escape_html(", ".join(hygiene)))
        if bp.get("flowIntensity"):
            flow_human = FLOW_LABEL_RU.get(
                str(bp["flowIntensity"]), str(bp["flowIntensity"])
            )
            bp_lines.append(f"  Интенсивность: {_escape_html(flow_human)}")
        allergies = _translate(bp.get("allergies"), ALLERGY_LABEL_RU)
        if allergies:
            bp_lines.append("  Аллергии: " + _escape_html(", ".join(allergies)))
        if bp.get("sensitiveSkin"):
            bp_lines.append("  Чувствительная кожа: да")
        if bp.get("allergyNotes"):
            bp_lines.append(
                f"  Заметки по аллергиям: {_escape_html(str(bp['allergyNotes']))}"
            )
        if bp.get("diet"):
            diet_human = DIET_LABEL_RU.get(str(bp["diet"]), str(bp["diet"]))
            bp_lines.append(f"  Питание: {_escape_html(diet_human)}")
        if bp.get("goal"):
            goal_human = GOAL_LABEL_RU.get(str(bp["goal"]), str(bp["goal"]))
            bp_lines.append(f"  Цель: {_escape_html(goal_human)}")
        flavors = _translate(bp.get("favoriteFlavors"), FLAVOR_LABEL_RU)
        if flavors:
            bp_lines.append("  Любимые вкусы: " + _escape_html(", ".join(flavors)))
        care = _translate(bp.get("careItems"), CARE_LABEL_RU)
        if care:
            bp_lines.append("  Уход: " + _escape_html(", ".join(care)))
        if bp.get("brandPreferences"):
            bp_lines.append(
                f"  Бренды: {_escape_html(str(bp['brandPreferences']))}"
            )
        if "surpriseGift" in bp:
            bp_lines.append(
                f"  Сюрприз-подарок: {'да' if bp.get('surpriseGift') else 'нет'}"
            )
        if "wantsSamples" in bp:
            bp_lines.append(
                f"  Пробники: {'да' if bp.get('wantsSamples') else 'нет'}"
            )
        if bp.get("notes"):
            bp_lines.append(f"  Заметки: {_escape_html(str(bp['notes']))}")
        if bp_lines:
            lines.append("")
            lines.append("🎁 <b>Box-профиль (онбординг):</b>")
            lines.extend(bp_lines)

    lines.append("")
    meta_bits: list[str] = []
    if req.device_id:
        meta_bits.append(f"device <code>{_escape_html(req.device_id)}</code>")
    if req.locale:
        meta_bits.append(f"locale {_escape_html(req.locale)}")
    if req.timezone:
        meta_bits.append(f"tz {_escape_html(req.timezone)}")
    if meta_bits:
        lines.append(" · ".join(meta_bits))
    if req.user_agent:
        ua = req.user_agent[:120]
        lines.append(f"<i>{_escape_html(ua)}</i>")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines.append(f"<i>{now}</i>")

    return "\n".join(lines)


def _canned_fallback(phase: str | None) -> str:
    """Return a warm, generic reply when the upstream model is overloaded.

    We never want the chat to surface a raw 502 to the user, since this is the
    main feature of the app. A canned message keeps the conversation alive.
    """

    extras = {
        "menstrual": " Сейчас время быть к себе особенно мягкой: тёплый чай, плед, тихий вечер. 🌿",
        "follicular": " Сейчас энергия на подъёме — хорошее время начать какое-нибудь маленькое дело. ✨",
        "ovulation": " Это фаза яркости — будь в контакте с теми, кто тебе важен. 💫",
        "luteal": " До месячных эмоции ярче — береги себя, питайся регулярно и спи вовремя. 🥰",
    }
    base = (
        "Я немножко потерялась в облаках и не успела сформулировать ответ — расскажи ещё раз, как ты? Я рядом."
    )
    return base + extras.get(phase or "", "")


def _extract_reply(data: Any) -> str:
    """Pull the assistant's text from an OpenAI-style chat completion response."""

    if not isinstance(data, dict):
        return ""
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            msg = first.get("message")
            if isinstance(msg, dict):
                content = msg.get("content")
                if isinstance(content, str) and content.strip():
                    return content.strip()
            text = first.get("text")
            if isinstance(text, str) and text.strip():
                return text.strip()
    direct = data.get("response")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    return ""
