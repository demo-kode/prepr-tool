FROM python:3.12-slim
WORKDIR /app
COPY server.py /app/server.py
COPY static /app/static
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PREPR_DATA=/data
USER 1001:1001
EXPOSE 8080
CMD ["python", "server.py"]
