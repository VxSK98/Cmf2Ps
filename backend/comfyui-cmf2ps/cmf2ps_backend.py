# custom_nodes/comfyui-cmf2ps/cmf2ps_backend.py

from __future__ import annotations

import os
import time
import json
import base64
import asyncio
import struct
from typing import Optional, Dict, Any, Tuple, List

from aiohttp import web

from server import PromptServer
import folder_paths


_ROUTE_PREFIX = "/cmf2ps"

_INBOX_DIR = os.path.join(folder_paths.get_input_directory(), "_cmf2ps")
os.makedirs(_INBOX_DIR, exist_ok=True)

# активные килиенты смотреть тут http://127.0.0.1:8188/cmf2ps/clients

# client_id -> filepath (последний снапшот, если нужен)
_last_image_path: Dict[str, str] = {}
_last_ref_path: Dict[str, str] = {}
_last_mask_path: Dict[str, str] = {}

# client_id -> {"ws": WebSocketResponse, "platform": "ps|ui|...", "ts": float}
_clients: Dict[str, Dict[str, Any]] = {}
_clients_lock = asyncio.Lock()

# "активный" PS-клиент (последний подключившийся platform=ps)
_active_ps_client_id: Optional[str] = None


def _temp_file_path(filename: str) -> str:
    """ComfyUI temp dir + защита от ../ path traversal."""
    safe_name = os.path.basename(filename)
    return os.path.join(folder_paths.get_temp_directory(), safe_name)


def _png_size(raw: bytes) -> Optional[Tuple[int, int]]:
    if len(raw) < 24 or raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
        return None

    return struct.unpack(">II", raw[16:24])


async def _clients_snapshot() -> List[Tuple[str, Dict[str, Any]]]:
    async with _clients_lock:
        return list(_clients.items())


async def broadcast(payload: dict, *, platform: Optional[str] = None) -> int:
    """
    Шлёт JSON всем подключенным WS-клиентам.
    Если задан platform (например "ps" или "ui") — только клиентам этой платформы.
    Возвращает число успешно доставленных.
    """
    msg = json.dumps(payload, ensure_ascii=False)
    delivered = 0

    items = await _clients_snapshot()
    to_remove: List[str] = []

    for client_id, rec in items:
        ws = rec.get("ws")
        if platform and rec.get("platform") != platform:
            continue
        if ws is None:
            to_remove.append(client_id)
            continue

        try:
            await ws.send_str(msg)
            delivered += 1
        except Exception:
            to_remove.append(client_id)

    if to_remove:
        async with _clients_lock:
            for cid in to_remove:
                _clients.pop(cid, None)

    return delivered


async def send_to_client(client_id: str, payload: dict) -> bool:
    """Отправка JSON конкретному клиенту по client_id."""
    msg = json.dumps(payload, ensure_ascii=False)

    async with _clients_lock:
        rec = _clients.get(client_id)

    if not rec:
        return False

    ws = rec.get("ws")
    if ws is None:
        async with _clients_lock:
            _clients.pop(client_id, None)
        return False

    try:
        await ws.send_str(msg)
        return True
    except Exception:
        async with _clients_lock:
            _clients.pop(client_id, None)
        return False


async def _get_active_ps_client_id() -> Optional[str]:
    async with _clients_lock:
        cid = _active_ps_client_id
        if cid and cid in _clients and _clients[cid].get("platform") == "ps":
            return cid
        return None


def _client_image_path(client_id: str) -> str:
    safe_client = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in client_id)
    return os.path.join(_INBOX_DIR, f"{safe_client}.png")

async def send_preview_image(filename: str, width: Optional[int] = None, height: Optional[int] = None) -> dict:
    """
    Читает PNG из temp ComfyUI, кодирует в base64 и отправляет.
    По умолчанию — только активному Photoshop-клиенту (platform=ps).
    Если PS-клиента нет — fallback: broadcast всем (чтобы не "молчало").
    """      
    path = _temp_file_path(filename)
    base_name = os.path.basename(filename)

    if not os.path.exists(path):
        payload = {"type": "error", "source": "cmf2ps", "message": f"File not found: {base_name}"}
        await broadcast(payload, platform="ps")
        return {"ok": False, "error": "file_not_found", "filename": base_name}

    try:
        with open(path, "rb") as f:
            raw = f.read()

        if width is None or height is None:
            size = _png_size(raw)
            if size:
                width, height = size

        b64 = base64.b64encode(raw).decode("utf-8")
        payload = {"type": "preview_item", "source": "cmf2ps", "filename": base_name, "data": b64}
        if width is not None and height is not None:
            payload["width"] = int(width)
            payload["height"] = int(height)

        target = await wait_for_active_ps_client(timeout=5.0)
        if target:
            ok = await send_to_client(target, payload)
            return {"ok": ok, "target": target, "filename": base_name, "width": width, "height": height}

        delivered = await broadcast(payload, platform="ps")
        return {"ok": delivered > 0, "delivered": delivered, "filename": base_name, "width": width, "height": height}

    except Exception as e:
        payload = {
            "type": "error",
            "source": "cmf2ps",
            "message": f"Failed to read/encode/send: {e}",
            "filename": base_name,
        }
        await broadcast(payload, platform="ps")
        return {"ok": False, "error": "send_failed", "details": str(e), "filename": base_name}

async def wait_for_active_ps_client(timeout: float = 5.0, interval: float = 0.2) -> Optional[str]:
    started = time.time()
    while time.time() - started < timeout:
        cid = await _get_active_ps_client_id()
        if cid:
            return cid
        await asyncio.sleep(interval)
    return None

async def send_preview_done() -> dict:
    payload = {
        "type": "preview_done",
        "source": "cmf2ps"
    }

    target = await _get_active_ps_client_id()
    if target:
        ok = await send_to_client(target, payload)
        return {"ok": ok, "target": target}

    delivered = await broadcast(payload, platform="ps")
    return {"ok": delivered > 0, "delivered": delivered}
# -------------------------
# HTTP/WS routes
# -------------------------

@PromptServer.instance.routes.get(f"{_ROUTE_PREFIX}/ping")
async def cmf2ps_ping(request):
    async with _clients_lock:
        n = len(_clients)
        active = _active_ps_client_id
    return web.json_response({"ok": True, "source": "cmf2ps", "clients": n, "active_ps": active})


@PromptServer.instance.routes.get(f"{_ROUTE_PREFIX}/clients")
async def cmf2ps_clients(request):
    """Debug: посмотреть кто подключен (без объектов ws)."""
    items = await _clients_snapshot()
    out = []
    for client_id, rec in items:
        out.append({
            "client_id": client_id,
            "platform": rec.get("platform"),
            "ts": rec.get("ts"),
        })
    return web.json_response({"ok": True, "clients": out, "active_ps": await _get_active_ps_client_id()})


@PromptServer.instance.routes.get(f"{_ROUTE_PREFIX}/ws")
async def cmf2ps_ws(request):
    """
    WebSocket:
      ws://127.0.0.1:8188/cmf2ps/ws?platform=ui&client_id=...
    """
    global _active_ps_client_id

    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)

    platform = request.rel_url.query.get("platform", "unknown")
    client_id = request.rel_url.query.get("client_id") or f"{platform}_{id(ws)}"

    async with _clients_lock:
        _clients[client_id] = {"ws": ws, "platform": platform, "ts": time.time()}

        # последний подключившийся PS становится "активным"
        if platform == "ps":
            _active_ps_client_id = client_id

    await ws.send_str(json.dumps({
        "type": "init",
        "source": "cmf2ps",
        "platform": platform,
        "client_id": client_id,
    }, ensure_ascii=False))

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                # можно расширить протокол при желании
                try:
                    data = json.loads(msg.data)
                except Exception:
                    data = {"raw": msg.data}

                if isinstance(data, dict) and data.get("type") == "ping":
                    await ws.send_str(json.dumps({"type": "pong", "source": "cmf2ps"}, ensure_ascii=False))

                # пример: клиент может сообщить, что он "готов"
                if isinstance(data, dict) and data.get("type") == "hello" and platform == "ps":
                    async with _clients_lock:
                        _active_ps_client_id = client_id

            elif msg.type == web.WSMsgType.ERROR:
                break
    finally:
        async with _clients_lock:
            _clients.pop(client_id, None)
            if _active_ps_client_id == client_id:
                _active_ps_client_id = None

    return ws


@PromptServer.instance.routes.post(f"{_ROUTE_PREFIX}/generate")
async def cmf2ps_generate(request):
    """
    Адресная команда generate (для UI-клиента Comfy внутри PS webview):
      POST /cmf2ps/generate  {"target_client_id":"..."}
    """
    body = await request.json() if request.can_read_body else {}
    target = body.get("target_client_id")
    if not target:
        return web.json_response({"ok": False, "error": "missing_target_client_id"}, status=400)

    ok = await send_to_client(target, {"type": "generate", "source": "cmf2ps"})
    return web.json_response({"ok": ok, "target": target})


@PromptServer.instance.routes.post(f"{_ROUTE_PREFIX}/push_image")
async def cmf2ps_push_image(request):
    """
    Photoshop -> Comfy: положить снапшот в input/_cmf2ps
      POST /cmf2ps/push_image
      {
        "client_id": "psui_...",
        "filename": "snapshot.png",
        "png_base64": "...."  (можно с data:image/png;base64,)
      }
    """
    data = await request.json() if request.can_read_body else {}
    client_id = data.get("client_id", "ps")
    b64 = data.get("png_base64")
    filename = data.get("filename", "snapshot.png")

    if not b64:
        return web.json_response({"ok": False, "error": "missing_png_base64"}, status=400)

    if isinstance(b64, str) and b64.startswith("data:") and "," in b64:
        b64 = b64.split(",", 1)[1]

    try:
        raw = base64.b64decode(b64)
    except Exception as e:
        return web.json_response({"ok": False, "error": "bad_base64", "details": str(e)}, status=400)

    safe_name = os.path.basename(filename)
    path = os.path.join(_INBOX_DIR, safe_name)
    client_path = _client_image_path("snapshot")

    with open(path, "wb") as f:
        f.write(raw)

    with open(client_path, "wb") as f:
        f.write(raw)

    _last_image_path[client_id] = client_path

    return web.json_response({
        "ok": True,
        "client_id": client_id,
        "path": client_path,
        "bytes": len(raw)
    })


@PromptServer.instance.routes.post(f"{_ROUTE_PREFIX}/push_mask")
async def cmf2ps_push_mask(request):
    data = await request.json() if request.can_read_body else {}
    client_id = data.get("client_id", "ps")
    b64 = data.get("png_base64")
    filename = data.get("filename", "mask.png")

    if not b64:
        return web.json_response({"ok": False, "error": "missing_png_base64"}, status=400)

    if isinstance(b64, str) and b64.startswith("data:") and "," in b64:
        b64 = b64.split(",", 1)[1]

    try:
        raw = base64.b64decode(b64)
    except Exception as e:
        return web.json_response({"ok": False, "error": "bad_base64", "details": str(e)}, status=400)

    safe_name = os.path.basename(filename)
    path = os.path.join(_INBOX_DIR, safe_name)
    client_path = _client_image_path("mask")

    with open(path, "wb") as f:
        f.write(raw)

    with open(client_path, "wb") as f:
        f.write(raw)

    _last_mask_path[client_id] = client_path

    return web.json_response({
        "ok": True,
        "client_id": client_id,
        "path": client_path,
        "bytes": len(raw)
    })

""" Дубликат для отправки рефа """
@PromptServer.instance.routes.post(f"{_ROUTE_PREFIX}/push_ref")
async def cmf2ps_push_image(request):
    """
    Photoshop -> Comfy: положить реф в input/_cmf2ps
      POST /cmf2ps/push_image
      {
        "client_id": "psui_...",
        "filename": "ref.png",
        "png_base64": "...."  (можно с data:image/png;base64,)
      }
    """
    data = await request.json() if request.can_read_body else {}
    client_id = data.get("client_id", "ps")
    b64 = data.get("png_base64")
    filename = data.get("filename", "ref.png")

    if not b64:
        return web.json_response({"ok": False, "error": "missing_png_base64"}, status=400)

    if isinstance(b64, str) and b64.startswith("data:") and "," in b64:
        b64 = b64.split(",", 1)[1]

    try:
        raw = base64.b64decode(b64)
    except Exception as e:
        return web.json_response({"ok": False, "error": "bad_base64", "details": str(e)}, status=400)

    safe_name = os.path.basename(filename)
    path = os.path.join(_INBOX_DIR, safe_name)
    client_path = _client_image_path("ref")

    with open(path, "wb") as f:
        f.write(raw)

    with open(client_path, "wb") as f:
        f.write(raw)

    _last_ref_path[client_id] = client_path

    return web.json_response({
        "ok": True,
        "client_id": client_id,
        "path": client_path,
        "bytes": len(raw)
    })
