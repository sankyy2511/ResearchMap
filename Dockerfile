# Backend (Go) and AI service (Python) in one container, for free hosting with one always-on service.
# The AI service listens only on 127.0.0.1:8000; the backend listens on $PORT (set by the container host, for example Cloud Run).

FROM golang:1.26 AS go-build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 APP_ENV=production AGENT_URL=http://127.0.0.1:8000 HF_HOME=/models
WORKDIR /app
COPY agent/pyproject.toml ./agent/
RUN pip install --no-cache-dir "fastapi>=0.115" "uvicorn>=0.30" "httpx>=0.27" "pydantic>=2.7" "fastembed>=0.5" \
    "numpy>=1.26" "scikit-learn>=1.5" "trafilatura>=1.12" "python-dotenv>=1.0" "pypdf>=6.19.0"
# Download the embedding model at build time, so the first request is not slow.
RUN python -c "from fastembed import TextEmbedding; TextEmbedding(model_name='BAAI/bge-small-en-v1.5')"
COPY agent/app ./agent/app
COPY --from=go-build /out/server ./server
COPY scripts/start.sh ./start.sh
# Strip Windows line endings in case the script was checked out on Windows.
RUN sed -i 's/\r$//' ./start.sh && chmod +x ./start.sh && useradd -r -u 10001 app && chown -R app /app /models
USER app
EXPOSE 8080
CMD ["./start.sh"]
