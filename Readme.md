# Urumi - Kubernetes Store Orchestrator 🛒☁️

> **🔴 LIVE DEMO:** [http://34.136.142.32](http://34.136.142.32)  
> *(Note: This link creates real cloud resources. Please be gentle!)*


**Urumi** is a production-grade Platform Engineering tool that orchestrates full-stack WooCommerce stores on Google Kubernetes Engine (GKE). It automates provisioning, security hardening, scaling, and lifecycle management (upgrades/rollbacks) via a centralized "God Mode" dashboard.

---

## 🚀 Features
- **One-Click Provisioning:** Deploys WordPress + MySQL + WooCommerce via Helm in under 2 minutes.
- **Security Hardening:** - Auto-generates cryptographically secure admin passwords (injected via K8s Secrets).
  - Applies **Network Policies** to isolate stores.
  - Enforces **Resource Quotas** (Limit: 2 CPU / 2GB RAM per store).
- **Day 2 Operations:** Supports **Helm Upgrades**, **Rollbacks**, and **Custom Domain Linking** (simulated Ingress).
- **Abuse Prevention:** - **Concurrency Queue:** Limits active provisioning to 2 concurrent tasks.
  - **Blast Radius Control:** Global cap of 5 stores max per cluster.
- **Observability:** Real-time, centralized audit logs shared across the platform team.

---

## 🛠️ Setup Instructions

### 1. Prerequisites
- **Kubernetes Cluster:** GKE (Google Cloud), Minikube, or Kind.
- **Tools:** `kubectl`, `helm`, `node` (v16+), `docker`.
- **Google Cloud SDK:** (If deploying to GKE).

### 2. Local Development Setup
Run the dashboard locally while connected to your Kubernetes cluster.

1. **Clone the Repository:**
   ```bash
   git clone [https://github.com/your-username/urumi.git](https://github.com/your-username/urumi.git)
   cd urumi/backend
   ```
2. **Install Dependencies:**

```Bash
npm install
```
3. **Run the Server:** Note: The system automatically detects the Helm Chart path.

```Bash
node server.js
```
4. **Access Dashboard:** Open http://localhost:3000 in your browser.

### 3. Production Deployment (GKE)
Deploy the orchestrator as a Pod inside your Google Kubernetes Engine cluster.

1. **Build & Push Docker Image:**

```Bash
# Replace [PROJECT_ID] with your Google Cloud Project ID
gcloud builds submit --tag gcr.io/[PROJECT_ID]/urumi-orchestrator:v1 .
```
2. **Deploy to Cluster:** Update orchestrator.yaml with your image name, then run:

```Bash
kubectl apply -f orchestrator.yaml
```
3. **Access via Public IP:** Wait for the LoadBalancer to assign an IP:

```Bash
kubectl get svc orchestrator-svc --watch
```
Open the EXTERNAL-IP in your browser.

### 🛒 How to Use the Dashboard
1. **Create a Store:** - Enter a unique name (e.g., nike-drop) and click Deploy.

    - Watch the logs as it provisions the Namespace, Persistent Volumes, and Secrets.

2. **Access the Store:** - Once the status is RUNNING, click Open Store.

    - The store is now live on a public IP.

3. **Admin Login (Secure):**

    - Navigate to /wp-admin on your store's URL.

    - Username: admin

    - Password: Copy the secure random password from the Dashboard Logs (System Activity panel).

4. **Lifecycle Actions:**

    - Upgrade/Rollback: Click the buttons to trigger Helm revision changes.

    - Link Domain: Simulates mapping a custom domain (e.g., nike.com) to the store.

5. **Clean Up:** - Click the Trash Icon to trigger a cascading deletion.

    - This removes the Namespace and PVCs to ensure no billing leakage.

### 📂 Repository Structure
**server.js:** Node.js Backend & Operator logic.

**public/:** React Frontend (Single Page Application).

**urumi-platform/:** Contains the custom Helm Charts.

**values-gcp.yaml:** Production Helm overrides for GKE (LoadBalancer, StorageClass).

**orchestrator.yaml:** Deployment manifests for the Orchestrator itself.

**rbac.yaml:** Least-privilege ServiceAccount permissions.

### 🛡️ Security Note
This project uses Kubernetes Secrets for credential management. Admin passwords are never hardcoded; they are generated dynamically at runtime and injected into the container environment.