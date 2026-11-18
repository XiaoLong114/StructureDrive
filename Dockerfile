FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt gunicorn==23.0.0

COPY app.py ./
COPY templates ./templates
COPY static ./static
COPY README.md ./

EXPOSE 25560

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:25560/health', timeout=3)"

CMD ["gunicorn", "-w", "2", "--threads", "4", "-b", "0.0.0.0:25560", "--timeout", "1800", "--graceful-timeout", "60", "--access-logfile", "-", "--error-logfile", "-", "app:app"]
