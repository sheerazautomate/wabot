# WhatsApp bot — container image for Hugging Face Spaces (Docker SDK)
FROM node:22-slim

WORKDIR /app

# Install exact dependency versions from the lockfile (reproducible builds)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the app
COPY index.js ./

# Hugging Face Spaces routes external traffic to port 7860 by default
ENV PORT=7860
EXPOSE 7860

# Run as the non-root user provided by the node image (HF requirement-friendly)
USER node

CMD ["node", "index.js"]
