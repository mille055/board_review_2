FROM python:3.12-slim

# Install nginx & supervisor & curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
    nginx supervisor ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Workdir
WORKDIR /app

# Copy backend requirements and install (add uvicorn)
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt \
    && pip install --no-cache-dir uvicorn[standard]

# Copy backend code
COPY backend/ /app/backend/

# Copy frontend to nginx web root
COPY frontend/index.html /usr/share/nginx/html/
COPY frontend/admin.html /usr/share/nginx/html/
COPY frontend/login.html /usr/share/nginx/html/
COPY frontend/css/ /usr/share/nginx/html/css/
COPY frontend/js/ /usr/share/nginx/html/js/
COPY frontend/data/ /usr/share/nginx/html/data/

# Nginx config + Supervisor config
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Nginx runs on 8080 per our config
EXPOSE 8080

# Healthcheck hits nginx
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://localhost:8080/healthz || exit 1

# Start both processes
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
