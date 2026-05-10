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
from typing import Any, Literal

import httpx
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
