FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN useradd --create-home --shell /usr/sbin/nologin appuser

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY app.py ./app.py
COPY gunicorn.conf.py ./gunicorn.conf.py
COPY static ./static
COPY templates ./templates

RUN mkdir -p /app/data && chown -R appuser:appuser /app

USER appuser

EXPOSE 5000

CMD ["gunicorn", "-c", "gunicorn.conf.py", "app:app"]
