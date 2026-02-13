# System Design & Tradeoffs 🏗️

## 1. Architecture Choice: Why a Node.js "Operator"?
Instead of writing a native Kubernetes Operator in Go (using Kubebuilder), I chose a **Node.js Wrapper Architecture** that invokes `helm` and `kubectl` as child processes.

* **Decision:** React Frontend + Node.js REST API.
* **Reasoning:**
    * **Speed of Delivery:** Allows rapid prototyping of complex logic (simulating Ingress updates, queue management) without the steep learning curve of the Kubernetes Controller runtime.
    * **Flexibility:** Easier to integrate with external systems (like billing APIs or Slack alerts) in standard JavaScript.
* **Tradeoff:** Less "Kubernetes-native" than a CRD (Custom Resource Definition) controller. In a large enterprise, I would migrate this logic to a Go Operator to benefit from the controller reconciliation loop.

## 2. Reliability & Failure Handling
Kubernetes is eventually consistent, meaning resources aren't ready immediately.
* **Idempotency:** The backend uses retry loops with exponential backoff for critical steps (MySQL connection, Pod readiness). If a step fails, it retries rather than crashing.
* **Concurrency Control:** An in-memory queue limits active provisioning to **2 concurrent tasks** to prevent overwhelming the Kubernetes API server.
* **Cleanup:** The deletion logic is aggressive. It performs a `helm uninstall` followed by an explicit `kubectl delete namespace` to ensure no "Orphaned Resources" (like expensive PVCs or LoadBalancers) are left behind billing the account.

## 3. Production vs. Local Strategy
Moving from Local (Minikube) to Production (GKE) required specific infrastructure changes managed via Helm Value overrides (`values-gcp.yaml`).

| Feature | Local (Minikube/Docker) | Production (GKE/VPS) |
| :--- | :--- | :--- |
| **Ingress** | `NodePort` (localhost access) | `LoadBalancer` (Real Public IP) |
| **Storage** | `hostPath` (Ephemeral) | `standard-rwo` (Google Persistent Disk) |
| **Secrets** | `Opaque` (Base64 encoded) | *Future:* Integration with HashiCorp Vault or Google Secret Manager. |
| **DNS** | `/etc/hosts` hacking | ExternalDNS + CertManager (Simulated in Demo via Labeling) |

## 4. Security Posture
* **Least Privilege:** The Orchestrator runs with a specific `ServiceAccount` bound to a Role that allows managing Namespaces but restricts access to cluster-wide nodes/volumes.
* **Isolation:** Every store gets a dedicated **Namespace**.
* **Network Policies:** Default `deny-all` ingress rules are applied to prevent cross-store communication (e.g., Store A cannot talk to Store B's database).
* **Secret Injection:** Admin passwords are cryptographically generated, stored in K8s Secrets, and mounted as environment variables—never hardcoded.