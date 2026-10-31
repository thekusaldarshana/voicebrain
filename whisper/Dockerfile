FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
# Models are downloaded on first start into /models (a volume), so a restart does not download again.
ENV WHISPER_CACHE=/models HF_HOME=/models/hf
VOLUME /models
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5).status == 200 else 1)"
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
