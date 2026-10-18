# Cameo API on Cloud Run. Build context: agents/
#   docker build -t cameo-api agents
#   gcloud run deploy cameo-api --source agents --region <region> ...
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY cameo_agents/ cameo_agents/
# Ready-made samples (scripts/pack_samples.py): read-only episodes served from out/. Uploads are written next to them.
COPY samples/ out/

# Vertex AI and Cloud Vision authenticate as the Cloud Run service account; set GOOGLE_CLOUD_PROJECT and
# CAMEO_CORS_ORIGINS at deploy time.
ENV GOOGLE_GENAI_USE_VERTEXAI=true GOOGLE_CLOUD_LOCATION=global CAMEO_API_LLM=gemini CAMEO_VISION=cloud PORT=8080

CMD ["sh", "-c", "exec uvicorn cameo_agents.api:app --host 0.0.0.0 --port ${PORT:-8080} --timeout-graceful-shutdown 5"]
