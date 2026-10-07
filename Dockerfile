FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /srv

# Zero runtime dependencies: no npm install step required.
COPY app/ app/
COPY verify/ verify/
# Build-check stage of the verifier asserts these artifacts exist.
COPY Dockerfile docker-compose.yml ./

EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app/server.js"]
