import os


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw in {None, ""}:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


bind = os.environ.get("GUNICORN_BIND", "0.0.0.0:5000")
worker_class = "gthread"
workers = _int_env("WEB_CONCURRENCY", 1)
threads = _int_env("GUNICORN_THREADS", 24)
timeout = _int_env("GUNICORN_TIMEOUT", 120)
graceful_timeout = _int_env("GUNICORN_GRACEFUL_TIMEOUT", 30)
keepalive = _int_env("GUNICORN_KEEPALIVE", 15)
max_requests = _int_env("GUNICORN_MAX_REQUESTS", 1000)
max_requests_jitter = _int_env("GUNICORN_MAX_REQUESTS_JITTER", 100)
accesslog = "-"
errorlog = "-"
capture_output = True
