FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

COPY resume-renderer-v2/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY fonts/ /app/fonts/
COPY resume-renderer-v2/assets/ /app/assets/
COPY resume-renderer-v2/app.py /app/app.py

USER 65532:65532
EXPOSE 8080
CMD ["python", "/app/app.py"]
