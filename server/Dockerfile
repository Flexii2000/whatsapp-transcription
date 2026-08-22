FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/models \
    OMP_NUM_THREADS=4

WORKDIR /srv

# faster-whisper bringt seinen Decoder ueber PyAV mit — kein System-ffmpeg noetig.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000
# Ein Worker: das Whisper-Modell liegt einmal im Speicher, Parallelitaet
# regelt MAX_CONCURRENCY in der App.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
