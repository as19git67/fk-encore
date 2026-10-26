"""Multi-turn chat with tool calling — the request shape and its two backends.

``POST /chat`` (main.py) takes an OpenAI-shaped conversation: ``system``,
``user``, ``assistant`` (text, or ``tool_calls``) and ``tool`` messages, plus
the tool definitions. What happens to it depends on the backend:

* ``server`` — llama-server runs with ``--jinja``, so the GGUF's own chat
  template renders the tools and llama.cpp parses the model's tool calls back
  into ``tool_calls``. The request goes through nearly as is.
* ``inproc`` — llama-cpp-python has no tool protocol. The tools go into the
  system prompt instead, and a JSON grammar makes the model answer with either
  ``{"tool": name, "arguments": {...}}`` or ``{"answer": text}``, which is
  turned back into the same message shape the server path returns. One call
  per turn, no streaming — the trip-planner benchmark measured this route.

Either way the caller gets ``{"message": {...}, "finish_reason": ...}`` with a
well-formed ``tool_calls`` list (arguments as a JSON string, as OpenAI sends
them, already checked to parse into an object), so the agent loop in the app
never needs to know which backend answered.

Nothing here executes a tool. The service only says which one the model wants.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

TOOL_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# The emulation's own vocabulary. Kept short and in English like every other
# prompt here; the model answers the user in the user's language regardless.
EMULATION_INSTRUCTIONS = (
    "You can call tools. Reply with exactly one JSON object and nothing else:\n"
    '- to call a tool: {"tool": "<name>", "arguments": {...}}\n'
    '- to answer the user: {"answer": "<text>"}\n'
    "Call one tool at a time. After a tool call you will receive its result "
    "and can call another tool or answer. Use only the tools listed below and "
    "only the arguments their schemas allow."
)


class ChatModelError(Exception):
    """The model replied, but not with something a caller can act on."""


# ─── Request shape ─────────────────────────────────────────────────────────────


class ToolFunction(BaseModel):
    name: str
    description: str = ""
    parameters: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})


class ToolDef(BaseModel):
    type: Literal["function"] = "function"
    function: ToolFunction


class ToolCallFunction(BaseModel):
    name: str
    # OpenAI sends arguments as a JSON *string*. An object is accepted too and
    # serialised, so a caller replaying its own history cannot get this wrong.
    arguments: str | dict[str, Any] = "{}"

    @model_validator(mode="after")
    def _check_arguments(self) -> "ToolCallFunction":
        if isinstance(self.arguments, str) and self.arguments.strip():
            try:
                parsed = json.loads(self.arguments)
            except json.JSONDecodeError as exc:
                raise ValueError(f"arguments of {self.name!r} are not valid JSON") from exc
            if not isinstance(parsed, dict):
                raise ValueError(f"arguments of {self.name!r} are not a JSON object")
        return self


class ToolCall(BaseModel):
    id: str = Field(..., min_length=1)
    type: Literal["function"] = "function"
    function: ToolCallFunction


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = None
    tool_calls: list[ToolCall] | None = None
    tool_call_id: str | None = None
    name: str | None = None

    @model_validator(mode="after")
    def _check_role_fields(self) -> "ChatMessage":
        if self.tool_calls and self.role != "assistant":
            raise ValueError("only assistant messages carry tool_calls")
        if self.role == "tool":
            if not self.tool_call_id:
                raise ValueError("a tool message needs tool_call_id")
            if self.content is None:
                raise ValueError("a tool message needs content")
        elif self.tool_call_id is not None:
            raise ValueError("only tool messages carry tool_call_id")
        if self.role in ("system", "user") and not self.content:
            raise ValueError(f"a {self.role} message needs content")
        if self.role == "assistant" and not self.content and not self.tool_calls:
            raise ValueError("an assistant message needs content or tool_calls")
        return self


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(..., min_length=1)
    tools: list[ToolDef] | None = None
    # "auto" | "none" | "required" | {"type": "function", "function": {"name": ...}}
    tool_choice: str | dict[str, Any] | None = None
    max_tokens: int = Field(default=1024, gt=0, le=8192)
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    stream: bool = False
    # A grammar for a plain reply: {"type": "json_object", "schema": {...}} as
    # llama-server and llama-cpp-python read it. Only without tools — a bound
    # tool call is tool_choice with a named function.
    response_format: dict[str, Any] | None = None
    # Let the model think before it answers. Off by default: a reasoning block
    # costs context every round of an agent loop; a caller turns it on for one
    # call with a small max_tokens, e.g. the plan of a multi-step question.
    thinking: bool = False

    @model_validator(mode="after")
    def _check_conversation(self) -> "ChatRequest":
        names = [t.function.name for t in self.tools or []]
        for name in names:
            if not TOOL_NAME_RE.match(name):
                raise ValueError(f"invalid tool name {name!r}")
        if len(set(names)) != len(names):
            raise ValueError("tool names must be unique")

        forced = forced_tool_name(self.tool_choice)
        if isinstance(self.tool_choice, str) and self.tool_choice not in ("auto", "none", "required"):
            raise ValueError("tool_choice must be 'auto', 'none', 'required' or a function")
        if isinstance(self.tool_choice, dict) and forced is None:
            raise ValueError('tool_choice object must be {"type": "function", "function": {"name": ...}}')
        if forced is not None and forced not in names:
            raise ValueError(f"tool_choice names unknown tool {forced!r}")
        if self.tool_choice in ("required",) and not names:
            raise ValueError("tool_choice 'required' needs tools")
        if self.response_format is not None:
            if names:
                raise ValueError("response_format needs a request without tools; bind a call with tool_choice instead")
            if self.response_format.get("type") not in ("json_object", "json_schema"):
                raise ValueError("response_format.type must be 'json_object' or 'json_schema'")

        # Every tool result must answer a call the conversation actually made —
        # a stray id is a caller bug that the chat template would render as
        # nonsense rather than reject.
        open_calls: set[str] = set()
        for msg in self.messages:
            if msg.role == "assistant" and msg.tool_calls:
                open_calls.update(c.id for c in msg.tool_calls)
            if msg.role == "tool" and msg.tool_call_id not in open_calls:
                raise ValueError(f"tool message answers unknown call {msg.tool_call_id!r}")

        if self.messages[-1].role == "assistant":
            raise ValueError("the conversation must not end with an assistant message")
        return self

    def tool_names(self) -> list[str]:
        return [t.function.name for t in self.tools or []]


def forced_tool_name(tool_choice: str | dict[str, Any] | None) -> str | None:
    if not isinstance(tool_choice, dict):
        return None
    if tool_choice.get("type") != "function":
        return None
    fn = tool_choice.get("function")
    name = fn.get("name") if isinstance(fn, dict) else None
    return name if isinstance(name, str) else None


def _arguments_text(arguments: str | dict[str, Any]) -> str:
    return arguments if isinstance(arguments, str) else json.dumps(arguments, ensure_ascii=False)


def _wire_message(msg: ChatMessage) -> dict[str, Any]:
    out: dict[str, Any] = {"role": msg.role, "content": msg.content}
    if msg.tool_calls:
        out["tool_calls"] = [
            {
                "id": c.id,
                "type": "function",
                "function": {"name": c.function.name, "arguments": _arguments_text(c.function.arguments)},
            }
            for c in msg.tool_calls
        ]
    if msg.tool_call_id is not None:
        out["tool_call_id"] = msg.tool_call_id
    if msg.name is not None:
        out["name"] = msg.name
    return out


# ─── server backend ────────────────────────────────────────────────────────────


def server_payload(req: ChatRequest) -> dict[str, Any]:
    """The body for llama-server's ``/v1/chat/completions``.

    Thinking is switched off per request on top of the deployment's
    ``--reasoning`` flag unless the request asks for it: a reasoning block
    spends exactly the context the tool results need, and an agent loop of
    several rounds pays for it every round. Templates that know no
    ``enable_thinking`` ignore the variable. A ``response_format`` goes
    through as it is; llama-server turns its schema into a grammar.
    """

    payload: dict[str, Any] = {
        "messages": [_wire_message(m) for m in req.messages],
        "max_tokens": req.max_tokens,
        "temperature": req.temperature,
        "chat_template_kwargs": {"enable_thinking": req.thinking},
    }
    if req.response_format is not None:
        payload["response_format"] = req.response_format
    if req.tools:
        payload["tools"] = [t.model_dump() for t in req.tools]
        payload["parallel_tool_calls"] = True
        if req.tool_choice is not None:
            payload["tool_choice"] = req.tool_choice
    return payload


def normalize_reply(message: dict[str, Any], finish_reason: str | None, tool_names: list[str]) -> dict[str, Any]:
    """Check and tidy the assistant message from llama-server.

    Raises ``ChatModelError`` for a call the caller could not execute: an
    unknown tool, or arguments that are not a JSON object. llama.cpp parses
    the template's tool-call syntax itself, so this fires when the model
    wrote something call-shaped that was not a valid call.
    """

    calls_out: list[dict[str, Any]] = []
    for call in message.get("tool_calls") or []:
        fn = call.get("function") if isinstance(call, dict) else None
        if not isinstance(fn, dict) or not isinstance(fn.get("name"), str):
            raise ChatModelError("tool call without a function name")
        name = fn["name"]
        if name not in tool_names:
            raise ChatModelError(f"model called unknown tool {name!r}")
        args = fn.get("arguments", "{}")
        parsed = _parse_arguments(args, name)
        calls_out.append({
            "id": call.get("id") or _call_id(),
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(parsed, ensure_ascii=False)},
        })

    content = message.get("content")
    if isinstance(content, str):
        content = content.strip() or None
    else:
        content = None
    if not calls_out and content is None:
        raise ChatModelError("model returned neither text nor tool calls")

    reply: dict[str, Any] = {"role": "assistant", "content": content}
    if calls_out:
        reply["tool_calls"] = calls_out
        finish_reason = "tool_calls"
    return {"message": reply, "finish_reason": finish_reason or "stop"}


def _parse_arguments(args: Any, name: str) -> dict[str, Any]:
    if isinstance(args, dict):
        return args
    if not isinstance(args, str):
        raise ChatModelError(f"arguments of {name!r} are neither a string nor an object")
    if not args.strip():
        return {}
    try:
        parsed = json.loads(args)
    except json.JSONDecodeError as exc:
        raise ChatModelError(f"arguments of {name!r} are not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ChatModelError(f"arguments of {name!r} are not a JSON object")
    return parsed


def _call_id() -> str:
    return f"call_{uuid.uuid4().hex[:24]}"


# ─── inproc backend: tools emulated through a JSON grammar ─────────────────────


def emulation_messages(req: ChatRequest) -> list[dict[str, str]]:
    """Flatten the conversation into plain system/user/assistant turns.

    The CPU model's chat template knows neither ``tool`` messages nor
    ``tool_calls``, so a past call becomes the JSON the model would have
    written for it, and a tool result becomes a user turn that says which
    call it answers.
    """

    names_by_id: dict[str, str] = {}
    system_parts: list[str] = []
    turns: list[dict[str, str]] = []

    for msg in req.messages:
        if msg.role == "system":
            system_parts.append(msg.content or "")
        elif msg.role == "user":
            turns.append({"role": "user", "content": msg.content or ""})
        elif msg.role == "assistant":
            if msg.tool_calls:
                for call in msg.tool_calls:
                    names_by_id[call.id] = call.function.name
                    args = call.function.arguments
                    parsed = json.loads(args) if isinstance(args, str) and args.strip() else (args or {})
                    turns.append({
                        "role": "assistant",
                        "content": json.dumps({"tool": call.function.name, "arguments": parsed}, ensure_ascii=False),
                    })
            else:
                turns.append({
                    "role": "assistant",
                    "content": json.dumps({"answer": msg.content or ""}, ensure_ascii=False),
                })
        else:  # tool
            name = names_by_id.get(msg.tool_call_id or "", msg.name or "tool")
            turns.append({"role": "user", "content": f"Result of {name}:\n{msg.content}"})

    if req.tools:
        catalog = "\n".join(
            f"- {t.function.name}: {t.function.description}\n  parameters: "
            + json.dumps(t.function.parameters, ensure_ascii=False, separators=(",", ":"))
            for t in req.tools
        )
        system_parts.append(f"{EMULATION_INSTRUCTIONS}\n\nTools:\n{catalog}")
        forced = forced_tool_name(req.tool_choice)
        if req.tool_choice == "none":
            system_parts.append("Do not call a tool now; answer.")
        elif req.tool_choice == "required":
            system_parts.append("You must call a tool now.")
        elif forced:
            system_parts.append(f"You must call the tool {forced} now.")

    out: list[dict[str, str]] = []
    if system_parts:
        out.append({"role": "system", "content": "\n\n".join(p for p in system_parts if p)})
    return out + turns


def emulation_response_format(req: ChatRequest) -> dict[str, Any] | None:
    """JSON schema for one emulated turn, or None when there are no tools.

    ``tool_choice`` narrows the grammar rather than the prompt alone: "none"
    leaves only ``answer``, "required" or a named function only ``tool``.
    Without tools the request's own ``response_format`` is the grammar.
    """

    names = req.tool_names()
    if not names:
        return req.response_format
    forced = forced_tool_name(req.tool_choice)
    call_schema = {
        "type": "object",
        "properties": {
            "tool": {"type": "string", "enum": [forced] if forced else names},
            "arguments": {"type": "object"},
        },
        "required": ["tool", "arguments"],
    }
    answer_schema = {
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
    }
    if req.tool_choice == "none":
        schema: dict[str, Any] = answer_schema
    elif req.tool_choice == "required" or forced:
        schema = call_schema
    else:
        schema = {"anyOf": [call_schema, answer_schema]}
    return {"type": "json_object", "schema": schema}


def parse_emulated(raw: str, req: ChatRequest) -> dict[str, Any]:
    """Turn the emulation's JSON back into the server path's reply shape."""

    names = req.tool_names()
    if not names:
        text = raw.strip()
        if not text:
            raise ChatModelError("model returned an empty answer")
        return {"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ChatModelError(f"emulated tool turn is not JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ChatModelError("emulated tool turn is not a JSON object")

    if isinstance(data.get("tool"), str):
        name = data["tool"]
        if name not in names:
            raise ChatModelError(f"model called unknown tool {name!r}")
        args = data.get("arguments", {})
        if args is None:
            args = {}
        if not isinstance(args, dict):
            raise ChatModelError(f"arguments of {name!r} are not a JSON object")
        call = {
            "id": _call_id(),
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
        }
        return {
            "message": {"role": "assistant", "content": None, "tool_calls": [call]},
            "finish_reason": "tool_calls",
        }

    answer = data.get("answer")
    if isinstance(answer, str) and answer.strip():
        return {"message": {"role": "assistant", "content": answer.strip()}, "finish_reason": "stop"}
    raise ChatModelError("emulated tool turn has neither a tool nor an answer")


def reply_as_chunks(reply: dict[str, Any], model: str) -> list[dict[str, Any]]:
    """A finished reply in OpenAI's streaming chunk shape.

    Lets ``stream=true`` keep its wire format on the inproc backend, which
    cannot stream: one delta with everything, then the finish chunk.
    """

    message = reply["message"]
    delta: dict[str, Any] = {"role": "assistant"}
    if message.get("content") is not None:
        delta["content"] = message["content"]
    if message.get("tool_calls"):
        delta["tool_calls"] = [{"index": i, **c} for i, c in enumerate(message["tool_calls"])]
    base = {"object": "chat.completion.chunk", "model": model}
    return [
        {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": reply["finish_reason"]}]},
    ]


# ─── Context usage ─────────────────────────────────────────────────────────────
#
# The assistant shows how full the model's window was. llama-server says how
# many tokens a request took — in `usage` when asked for it
# (`stream_options.include_usage`), and in `timings` on its last chunk anyway,
# where the prompt is split into the part it computed and the part it found
# in its cache. After the stream, /chat adds one chunk of its own:
# `{"context": {"n_ctx", "prompt_tokens", "completion_tokens"}}`.


def stream_usage(body: str) -> dict[str, int] | None:
    """The token counts one streamed chunk carries, or None."""

    if '"usage"' not in body and '"timings"' not in body:
        return None
    try:
        chunk = json.loads(body)
    except ValueError:
        return None
    if not isinstance(chunk, dict):
        return None
    return usage_counts(chunk.get("usage"), chunk.get("timings"))


def usage_counts(usage: Any, timings: Any = None) -> dict[str, int] | None:
    """Prompt and completion tokens from an OpenAI `usage` or llama.cpp `timings`."""

    if isinstance(usage, dict) and isinstance(usage.get("prompt_tokens"), int):
        return {
            "prompt_tokens": usage["prompt_tokens"],
            "completion_tokens": int(usage.get("completion_tokens") or 0),
        }
    if isinstance(timings, dict) and isinstance(timings.get("prompt_n"), int):
        return {
            "prompt_tokens": timings["prompt_n"] + int(timings.get("cache_n") or 0),
            "completion_tokens": int(timings.get("predicted_n") or 0),
        }
    return None


def context_chunk(n_ctx: int | None, usage: dict[str, int] | None) -> dict[str, Any]:
    """The chunk /chat ends a stream with: the window and what this request took of it."""

    return {
        "context": {
            "n_ctx": n_ctx,
            "prompt_tokens": usage["prompt_tokens"] if usage else None,
            "completion_tokens": usage["completion_tokens"] if usage else None,
        }
    }
