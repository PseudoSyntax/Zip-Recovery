FROM python:3.12-slim

# p7zip-full gives the `7z` binary, which handles both .7z and .zip (incl. AES)
RUN apt-get update \
 && apt-get install -y --no-install-recommends p7zip-full \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY . .

# Inside the container we bind all interfaces; publish the port deliberately
# and set ZR_TOKEN so the service is not open to everyone who can reach it.
ENV ZR_HOST=0.0.0.0 ZR_PORT=8000
EXPOSE 8000

# gunicorn with a few threads so status polling works during a job.
CMD ["gunicorn", "-b", "0.0.0.0:8000", "--threads", "8", "--timeout", "0", "app:app"]
