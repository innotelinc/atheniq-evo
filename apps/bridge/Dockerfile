# The bridge has no runtime dependencies: Node runs its TypeScript directly.
# That keeps the image small and removes an install step from every deploy.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY apps/bridge ./apps/bridge
COPY packages/contracts ./packages/contracts

# Run unprivileged; the ledger volume is the only writable path it needs.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV BRIDGE_DATA_DIR=/data
EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "apps/bridge/src/main.ts"]
