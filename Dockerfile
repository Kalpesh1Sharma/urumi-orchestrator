# Use Node 18 (Lightweight)
FROM node:18-bullseye-slim

# 1. Install System Tools (curl, git, etc.)
RUN apt-get update && apt-get install -y curl git bash openssl && rm -rf /var/lib/apt/lists/*

# 2. Install kubectl
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    && chmod +x kubectl \
    && mv kubectl /usr/local/bin/

# 3. Install Helm
RUN curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# 4. Install WP-CLI (For self-healing features)
RUN curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
    && chmod +x wp-cli.phar \
    && mv wp-cli.phar /usr/local/bin/wp

# 5. Set Work Directory
WORKDIR /app

# 6. Copy App Dependencies
COPY package*.json ./
RUN npm install

# 7. Copy Your Source Code
COPY . .

# 8. COPY THE HELM CHART (Important!)
# We copy the 'urumi-platform' folder from your computer into the Docker image at /app/charts
# Make sure your folder structure matches this!
COPY urumi-platform ./charts/urumi-platform

# 9. Expose Port
EXPOSE 3000

# 10. Start Server
CMD ["node", "server.js"]