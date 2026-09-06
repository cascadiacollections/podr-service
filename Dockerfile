FROM python:3.14-slim
COPY --from=ghcr.io/astral-sh/uv:0.10.9 /uv /usr/local/bin/uv
WORKDIR /app
# Build on the base image's interpreter only. Without this, a uv.lock that excludes
# the image's Python silently downloads a managed interpreter instead of failing.
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON_PREFERENCE=only-system
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-default-groups --group proxy --no-install-project
COPY container_src/main.py ./main.py
# Fail the build, not the deploy, when the interpreter and the locked
# dependencies are installable but mutually incompatible at import time.
RUN python -c "import main; assert main.app"
USER 65532:65532
EXPOSE 8080
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
