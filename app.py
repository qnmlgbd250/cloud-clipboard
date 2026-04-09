"""
Cloud Clipboard

A lightweight cross-device clipboard sharing service.
"""

from __future__ import annotations

import io
import json
import os
import re
import secrets
import tempfile
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from queue import Empty, Full, Queue
from threading import Lock, Thread

import qrcode
from flask import (
    Flask,
    Response,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    stream_with_context,
    url_for,
)

app = Flask(__name__)

# ─── Configuration ───────────────────────────────────────────────────
DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_DIR.mkdir(exist_ok=True)

CONTENT_TTL_HOURS = int(os.environ.get("CONTENT_TTL_HOURS", "480"))
ROOM_TTL_HOURS = int(os.environ.get("ROOM_TTL_HOURS", "480"))
EMPTY_ROOM_TTL_HOURS = int(os.environ.get("EMPTY_ROOM_TTL_HOURS", "24"))
MAX_CONTENT_LENGTH = int(os.environ.get("MAX_CONTENT_LENGTH", "50000"))
MAX_ITEMS_PER_ROOM = int(os.environ.get("MAX_ITEMS_PER_ROOM", "500"))
MAX_ITEMS_PAGE_SIZE = int(os.environ.get("MAX_ITEMS_PAGE_SIZE", "100"))
MAX_ROOMS = int(os.environ.get("MAX_ROOMS", "2000"))
WRITE_RATE_LIMIT = int(os.environ.get("WRITE_RATE_LIMIT", "40"))
WRITE_RATE_WINDOW_SECONDS = int(os.environ.get("WRITE_RATE_WINDOW_SECONDS", "60"))
ROOM_ACTIVITY_TOUCH_INTERVAL_SECONDS = int(
    os.environ.get("ROOM_ACTIVITY_TOUCH_INTERVAL_SECONDS", "300")
)
STORAGE_CLEANUP_INTERVAL_SECONDS = int(
    os.environ.get("STORAGE_CLEANUP_INTERVAL_SECONDS", "300")
)
MAX_SUBSCRIBERS_PER_ROOM = int(os.environ.get("MAX_SUBSCRIBERS_PER_ROOM", "100"))

# ─── In-memory room cache ────────────────────────────────────────────
ROOM_CACHE: dict[str, dict] = {}
ROOM_CACHE_LOCK = Lock()

ROOM_SUBSCRIBERS: dict[str, set[Queue]] = defaultdict(set)
ROOM_SUBSCRIBERS_LOCK = Lock()
ROOM_STATE_LOCKS: dict[str, Lock] = {}
ROOM_STATE_LOCKS_LOCK = Lock()
RATE_LIMIT_BUCKETS: dict[str, deque[float]] = defaultdict(deque)
RATE_LIMIT_LOCK = Lock()
STORAGE_CLEANUP_LOCK = Lock()
LAST_STORAGE_CLEANUP_AT = 0.0

ROOM_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"
ROOM_NAME_LENGTH = 8
ROOM_ID_PATTERN = re.compile(r"^[a-zA-Z0-9\-_]{1,64}$")


class RateLimitError(Exception):
    """Raised when a client exceeds the write rate limit."""


class RoomCapacityError(Exception):
    """Raised when the room storage limit is reached."""


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _isoformat(value: datetime | None = None) -> str:
    return (value or _now_utc()).isoformat()


def _parse_datetime(value: str | None) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None

    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _safe_room_name(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9\-_]", "", name)[:64]


def _data_path(room: str) -> Path:
    return DATA_DIR / f"{_safe_room_name(room)}.json"


def _is_valid_room_name(room: str) -> bool:
    return bool(ROOM_ID_PATTERN.fullmatch(room))


def _get_request_room() -> str | None:
    raw_room = request.args.get("room", "")
    room = _safe_room_name(raw_room)
    if not room or room != raw_room or not _is_valid_room_name(room):
        return None
    return room


def _get_optional_int_arg(
    name: str,
    *,
    minimum: int = 0,
    maximum: int | None = None,
) -> int | None:
    raw_value = request.args.get(name)
    if raw_value in {None, ""}:
        return None

    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        raise ValueError(name) from None

    if value < minimum:
        raise ValueError(name)
    if maximum is not None and value > maximum:
        raise ValueError(name)
    return value


def _get_client_ip() -> str:
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    if forwarded_for:
        client_ip = forwarded_for.split(",")[0].strip()
        if client_ip:
            return client_ip
    real_ip = request.headers.get("X-Real-IP", "").strip()
    if real_ip:
        return real_ip
    return request.remote_addr or "unknown"


def _default_room_state(now: datetime | None = None) -> dict:
    ts = _isoformat(now)
    return {
        "room": {
            "created_at": ts,
            "last_activity_at": ts,
            "last_write_at": ts,
        },
        "items": [],
    }


def _normalize_item(raw_item: object) -> tuple[dict | None, datetime | None, bool]:
    if not isinstance(raw_item, dict):
        return None, None, True

    content = str(raw_item.get("content") or "").strip()
    created_at = _parse_datetime(raw_item.get("created_at"))
    if not content or created_at is None:
        return None, None, True

    item_id = str(raw_item.get("id") or uuid.uuid4().hex[:8])[:64]
    normalized = {
        "id": item_id,
        "content": content,
        "created_at": created_at.isoformat(),
    }
    changed = (
        raw_item.get("id") != normalized["id"]
        or raw_item.get("content") != normalized["content"]
        or raw_item.get("created_at") != normalized["created_at"]
    )
    return normalized, created_at, changed


def _clean_expired_items(
    items_with_datetimes: list[tuple[datetime, dict]],
    now: datetime | None = None,
) -> list[tuple[datetime, dict]]:
    if CONTENT_TTL_HOURS <= 0:
        return items_with_datetimes

    cutoff = (now or _now_utc()) - timedelta(hours=CONTENT_TTL_HOURS)
    return [
        (created_at, item)
        for created_at, item in items_with_datetimes
        if created_at > cutoff
    ]


def _normalize_room_state(raw_data: object) -> tuple[dict, bool]:
    now = _now_utc()
    changed = not isinstance(raw_data, dict)

    raw_meta: dict = {}
    raw_items: list = []

    if isinstance(raw_data, list):
        raw_items = raw_data
        changed = True
    elif isinstance(raw_data, dict):
        if isinstance(raw_data.get("room"), dict):
            raw_meta = raw_data["room"]
        else:
            changed = True
        if isinstance(raw_data.get("items"), list):
            raw_items = raw_data["items"]
        else:
            changed = True
    else:
        changed = True

    items_with_datetimes: list[tuple[datetime, dict]] = []
    for raw_item in raw_items:
        normalized_item, created_at, item_changed = _normalize_item(raw_item)
        changed = changed or item_changed
        if normalized_item is not None and created_at is not None:
            items_with_datetimes.append((created_at, normalized_item))

    cleaned_items = _clean_expired_items(items_with_datetimes, now)
    if len(cleaned_items) != len(items_with_datetimes):
        changed = True
    items_with_datetimes = cleaned_items

    if len(items_with_datetimes) > 1:
        sorted_items = sorted(items_with_datetimes, key=lambda entry: entry[0], reverse=True)
        if sorted_items != items_with_datetimes:
            changed = True
        items_with_datetimes = sorted_items

    items = [item for _, item in items_with_datetimes]
    item_datetimes = [created_at for created_at, _ in items_with_datetimes]
    earliest_item = min(item_datetimes) if item_datetimes else None
    latest_item = max(item_datetimes) if item_datetimes else None

    created_at = _parse_datetime(raw_meta.get("created_at")) or earliest_item or now
    last_write_at = _parse_datetime(raw_meta.get("last_write_at")) or latest_item or created_at
    last_activity_at = _parse_datetime(raw_meta.get("last_activity_at")) or last_write_at

    if last_write_at < created_at:
        last_write_at = created_at
        changed = True
    if last_activity_at < last_write_at:
        last_activity_at = last_write_at
        changed = True

    normalized = {
        "room": {
            "created_at": created_at.isoformat(),
            "last_activity_at": last_activity_at.isoformat(),
            "last_write_at": last_write_at.isoformat(),
        },
        "items": items,
    }

    changed = changed or raw_meta.get("created_at") != normalized["room"]["created_at"]
    changed = changed or raw_meta.get("last_activity_at") != normalized["room"]["last_activity_at"]
    changed = changed or raw_meta.get("last_write_at") != normalized["room"]["last_write_at"]
    return normalized, changed


def _load_room_state(room: str) -> tuple[dict, bool, bool]:
    """Load room state from cache first, then disk.

    Returns (state, exists, changed).
    """
    with ROOM_CACHE_LOCK:
        cached = ROOM_CACHE.get(room)
    if cached is not None:
        return cached, True, False

    path = _data_path(room)
    if not path.exists():
        return _default_room_state(), False, False

    try:
        with path.open("r", encoding="utf-8") as file:
            raw_data = json.load(file)
    except (OSError, json.JSONDecodeError):
        try:
            path.unlink()
        except OSError:
            pass
        return _default_room_state(), False, True

    state, changed = _normalize_room_state(raw_data)
    if not changed:
        with ROOM_CACHE_LOCK:
            ROOM_CACHE[room] = state
    return state, True, changed


def _room_should_expire(state: dict, now: datetime | None = None) -> bool:
    now = now or _now_utc()
    last_activity_at = _parse_datetime(state.get("room", {}).get("last_activity_at")) or now
    room_cutoff = now - timedelta(hours=ROOM_TTL_HOURS)
    empty_room_cutoff = now - timedelta(hours=EMPTY_ROOM_TTL_HOURS)

    if last_activity_at <= room_cutoff:
        return True
    if not state.get("items") and last_activity_at <= empty_room_cutoff:
        return True
    return False


def _delete_room_file(room: str) -> None:
    try:
        _data_path(room).unlink()
    except OSError:
        pass
    with ROOM_STATE_LOCKS_LOCK:
        ROOM_STATE_LOCKS.pop(room, None)


def _touch_room_activity(state: dict, now: datetime | None = None, *, force: bool = False) -> bool:
    now = now or _now_utc()
    current = _parse_datetime(state.get("room", {}).get("last_activity_at"))
    if not force and current is not None:
        elapsed = (now - current).total_seconds()
        if elapsed < ROOM_ACTIVITY_TOUCH_INTERVAL_SECONDS:
            return False

    state.setdefault("room", {})["last_activity_at"] = now.isoformat()
    return True


def _touch_room_write(state: dict, now: datetime | None = None) -> None:
    now = now or _now_utc()
    room_meta = state.setdefault("room", {})
    ts = now.isoformat()
    room_meta.setdefault("created_at", ts)
    room_meta["last_activity_at"] = ts
    room_meta["last_write_at"] = ts


def _save_room_state(room: str, state: dict, *, normalized: bool = False) -> bool:
    normalized_state = state if normalized else _normalize_room_state(state)[0]
    now = _now_utc()

    if _room_should_expire(normalized_state, now):
        _delete_room_file(room)
        with ROOM_CACHE_LOCK:
            ROOM_CACHE.pop(room, None)
        return False

    fd, tmp_path = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(normalized_state, file, ensure_ascii=False, indent=2)
        os.replace(tmp_path, _data_path(room))
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise

    with ROOM_CACHE_LOCK:
        ROOM_CACHE[room] = normalized_state
    return True


def _load_active_room_state(
    room: str,
    *,
    now: datetime | None = None,
    touch_activity: bool = False,
) -> tuple[dict, bool]:
    room_lock = _get_room_lock(room)
    current_time = now or _now_utc()

    with room_lock:
        state, exists, changed = _load_room_state(room)

        if exists and _room_should_expire(state, current_time):
            _delete_room_file(room)
            return _default_room_state(current_time), False

        if exists and touch_activity:
            changed = _touch_room_activity(state, current_time) or changed

        if exists and changed:
            _save_room_state(room, state, normalized=True)

        return state, exists


def _get_room_lock(room: str) -> Lock:
    with ROOM_STATE_LOCKS_LOCK:
        lock = ROOM_STATE_LOCKS.get(room)
        if lock is None:
            lock = Lock()
            ROOM_STATE_LOCKS[room] = lock
    return lock


def _enforce_write_rate_limit() -> None:
    client_ip = _get_client_ip()
    bucket_key = f"write:{client_ip}"
    now = time.monotonic()

    with RATE_LIMIT_LOCK:
        bucket = RATE_LIMIT_BUCKETS[bucket_key]
        cutoff = now - WRITE_RATE_WINDOW_SECONDS
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()

        if len(bucket) >= WRITE_RATE_LIMIT:
            raise RateLimitError("操作过于频繁，请稍后再试")

        bucket.append(now)


def _cleanup_storage(*, force: bool = False) -> None:
    global LAST_STORAGE_CLEANUP_AT

    now_monotonic = time.monotonic()
    if not force and now_monotonic - LAST_STORAGE_CLEANUP_AT < STORAGE_CLEANUP_INTERVAL_SECONDS:
        return

    with STORAGE_CLEANUP_LOCK:
        now_monotonic = time.monotonic()
        if not force and now_monotonic - LAST_STORAGE_CLEANUP_AT < STORAGE_CLEANUP_INTERVAL_SECONDS:
            return

        for path in DATA_DIR.glob("*.json"):
            room = path.stem
            if not _is_valid_room_name(room):
                try:
                    path.unlink()
                except OSError:
                    pass
                continue

            room_lock = _get_room_lock(room)
            with room_lock:
                state, exists, changed = _load_room_state(room)
                if not exists:
                    continue

                now = _now_utc()
                if _room_should_expire(state, now):
                    _delete_room_file(room)
                    continue

                if changed:
                    _save_room_state(room, state, normalized=True)

        # Reap orphaned locks and cache entries
        with ROOM_STATE_LOCKS_LOCK:
            for r in list(ROOM_STATE_LOCKS.keys()):
                if not _data_path(r).exists():
                    ROOM_STATE_LOCKS.pop(r, None)

        with ROOM_CACHE_LOCK:
            for r in list(ROOM_CACHE.keys()):
                if not _data_path(r).exists():
                    ROOM_CACHE.pop(r, None)

        LAST_STORAGE_CLEANUP_AT = now_monotonic


def _room_count() -> int:
    with ROOM_CACHE_LOCK:
        cache_count = len(ROOM_CACHE)
    if cache_count > 0:
        return cache_count
    return sum(1 for path in DATA_DIR.glob("*.json") if _is_valid_room_name(path.stem))


def _ensure_room_capacity() -> None:
    _cleanup_storage(force=True)
    if _room_count() >= MAX_ROOMS:
        raise RoomCapacityError("可用房间数量已达上限，请稍后再试")


def _generate_room_name(length: int = ROOM_NAME_LENGTH) -> str:
    for _ in range(10):
        room = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(length))
        if not _data_path(room).exists():
            return room

    return uuid.uuid4().hex[:length]


def _json_error(message: str, status_code: int) -> Response:
    response = jsonify({"error": message})
    response.status_code = status_code
    return _add_no_store_headers(response)


def _add_no_store_headers(response: Response) -> Response:
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


def _register_subscriber(room: str) -> Queue:
    subscriber: Queue = Queue(maxsize=1)
    with ROOM_SUBSCRIBERS_LOCK:
        if len(ROOM_SUBSCRIBERS.get(room, ())) >= MAX_SUBSCRIBERS_PER_ROOM:
            raise RateLimitError("连接数过多，请稍后再试")
        ROOM_SUBSCRIBERS[room].add(subscriber)
    return subscriber


def _unregister_subscriber(room: str, subscriber: Queue) -> None:
    with ROOM_SUBSCRIBERS_LOCK:
        subscribers = ROOM_SUBSCRIBERS.get(room)
        if not subscribers:
            return
        subscribers.discard(subscriber)
        if not subscribers:
            ROOM_SUBSCRIBERS.pop(room, None)


def _broadcast_room_update(room: str) -> None:
    safe_room = _safe_room_name(room)
    payload = {
        "room": safe_room,
        "updated_at": _isoformat(),
    }

    with ROOM_SUBSCRIBERS_LOCK:
        subscribers = list(ROOM_SUBSCRIBERS.get(safe_room, ()))

    for subscriber in subscribers:
        try:
            subscriber.put_nowait(("items_changed", payload))
        except Full:
            try:
                subscriber.get_nowait()
            except Empty:
                pass
            try:
                subscriber.put_nowait(("items_changed", payload))
            except Full:
                pass


def _sse_message(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.before_request
def before_request_housekeeping() -> None:
    if request.endpoint in {"add_item", "delete_item", "clear_items"}:
        _enforce_write_rate_limit()


def _start_background_cleanup() -> None:
    """Run storage cleanup periodically in a background thread."""
    def _loop():
        while True:
            time.sleep(STORAGE_CLEANUP_INTERVAL_SECONDS)
            try:
                _cleanup_storage(force=True)
            except Exception:
                pass

    Thread(target=_loop, daemon=True).start()


@app.errorhandler(RateLimitError)
def handle_rate_limit(error: RateLimitError) -> Response:
    return _json_error(str(error), 429)


@app.errorhandler(RoomCapacityError)
def handle_room_capacity(error: RoomCapacityError) -> Response:
    return _json_error(str(error), 503)


@app.route("/")
def index():
    response = redirect(url_for("room", room_id=_generate_room_name()))
    return _add_no_store_headers(response)


@app.route("/r/<room_id>")
def room(room_id: str):
    safe_room = _safe_room_name(room_id)
    if not safe_room or safe_room != room_id or not _is_valid_room_name(safe_room):
        response = redirect(url_for("index"))
        return _add_no_store_headers(response)

    response = app.make_response(render_template("index.html", room_id=safe_room))
    return _add_no_store_headers(response)


@app.route("/api/items", methods=["GET"])
def get_items():
    room = _get_request_room()
    if room is None:
        return _json_error("invalid room", 400)

    try:
        offset = _get_optional_int_arg("offset", minimum=0)
        limit = _get_optional_int_arg("limit", minimum=1, maximum=MAX_ITEMS_PAGE_SIZE)
    except ValueError as error:
        if str(error) == "limit":
            return _json_error(
                f"limit 必须在 1 到 {MAX_ITEMS_PAGE_SIZE} 之间",
                400,
            )
        return _json_error(f"{error} 参数无效", 400)

    state, _ = _load_active_room_state(room, touch_activity=True)
    items = list(state.get("items", []))

    if offset is None and limit is None:
        response = jsonify(items)
        return _add_no_store_headers(response)

    safe_offset = offset or 0
    total = len(items)
    paged_items = items[safe_offset : safe_offset + (limit or total)]
    response = jsonify(
        {
            "items": paged_items,
            "total": total,
            "offset": safe_offset,
            "limit": limit or total,
            "has_more": safe_offset + len(paged_items) < total,
        }
    )
    return _add_no_store_headers(response)


@app.route("/api/items", methods=["POST"])
def add_item():
    room = _get_request_room()
    if room is None:
        return _json_error("invalid room", 400)

    data = request.get_json(silent=True) or {}
    content = str(data.get("content") or "").strip()

    if not content:
        return _json_error("内容不能为空", 400)

    if len(content) > MAX_CONTENT_LENGTH:
        return _json_error(f"内容过长，最多 {MAX_CONTENT_LENGTH} 个字符", 400)

    if not _data_path(room).exists():
        _ensure_room_capacity()

    room_lock = _get_room_lock(room)
    with room_lock:
        state, exists, _ = _load_room_state(room)
        now = _now_utc()

        if exists and _room_should_expire(state, now):
            _delete_room_file(room)
            state = _default_room_state(now)
            exists = False

        items = list(state.get("items", []))
        if len(items) >= MAX_ITEMS_PER_ROOM:
            return _json_error(f"房间已满，最多 {MAX_ITEMS_PER_ROOM} 条记录", 400)

        item = {
            "id": uuid.uuid4().hex[:8],
            "content": content,
            "created_at": now.isoformat(),
        }
        items.insert(0, item)
        state["items"] = items
        _touch_room_write(state, now)
        _save_room_state(room, state, normalized=True)

    _broadcast_room_update(room)
    response = jsonify(item)
    response.status_code = 201
    return _add_no_store_headers(response)


@app.route("/api/items/<item_id>", methods=["DELETE"])
def delete_item(item_id: str):
    room = _get_request_room()
    if room is None:
        return _json_error("invalid room", 400)

    changed = False
    room_lock = _get_room_lock(room)
    with room_lock:
        state, exists, _ = _load_room_state(room)
        if not exists:
            response = jsonify({"ok": True})
            return _add_no_store_headers(response)

        items = [item for item in state.get("items", []) if item.get("id") != item_id]
        if len(items) != len(state.get("items", [])):
            changed = True
            state["items"] = items
            _touch_room_write(state)
            _save_room_state(room, state, normalized=True)

    if changed:
        _broadcast_room_update(room)
    response = jsonify({"ok": True})
    return _add_no_store_headers(response)


@app.route("/api/items/clear", methods=["POST"])
def clear_items():
    room = _get_request_room()
    if room is None:
        return _json_error("invalid room", 400)

    changed = False
    room_lock = _get_room_lock(room)
    with room_lock:
        state, exists, _ = _load_room_state(room)
        if exists and state.get("items"):
            changed = True
            state["items"] = []
            _touch_room_write(state)
            _save_room_state(room, state, normalized=True)

    if changed:
        _broadcast_room_update(room)
    response = jsonify({"ok": True})
    return _add_no_store_headers(response)


@app.route("/api/stream")
def stream_items():
    room = _get_request_room()
    if room is None:
        return _json_error("invalid room", 400)

    _load_active_room_state(room, touch_activity=True)

    subscriber = _register_subscriber(room)

    def generate():
        try:
            yield _sse_message(
                "ready",
                {
                    "room": room,
                    "connected_at": _isoformat(),
                },
            )

            while True:
                try:
                    event_name, payload = subscriber.get(timeout=15)
                    yield _sse_message(event_name, payload)
                except Empty:
                    yield _sse_message(
                        "ping",
                        {
                            "room": room,
                            "ts": _isoformat(),
                        },
                    )
        finally:
            _unregister_subscriber(room, subscriber)

    response = Response(stream_with_context(generate()), mimetype="text/event-stream")
    response.headers["X-Accel-Buffering"] = "no"
    return _add_no_store_headers(response)


@app.route("/api/qr")
def qr_code():
    text = request.args.get("text", "")
    if not text:
        return _json_error("缺少 text 参数", 400)

    image = qrcode.make(text, box_size=8, border=2)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    buffer.seek(0)

    response = send_file(buffer, mimetype="image/png")
    response.headers["Cache-Control"] = "public, max-age=3600"
    return response


if __name__ == "__main__":
    _start_background_cleanup()
    app.run(host="0.0.0.0", port=5000, debug=True, threaded=True)
