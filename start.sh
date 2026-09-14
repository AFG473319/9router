docker stop afrouter
docker rm afrouter
docker build -t afrouter .
docker run -d --name afrouter -p 20128:20128 --env-file .env -v afrouter-data:/app/data afrouter