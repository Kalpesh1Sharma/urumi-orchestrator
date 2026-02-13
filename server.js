const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(cors());
app.use(express.json());

// --- SERVE DASHBOARD UI ---
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURATION ---
const PORT = 3000;
const AUDIT_FILE = path.join(__dirname, 'audit.log');
const MAX_STORES_TOTAL = 5; 

// --- SMART PATH SELECTION ---
const CHART_PATH = process.env.CHART_PATH || path.join(__dirname, 'urumi-platform', 'woocommerce-store');
const VALUES_PATH = process.env.VALUES_PATH || path.join(__dirname, 'values-gcp.yaml');

console.log(`[INIT] Resolved Chart Path: ${CHART_PATH}`);

// --- STATE ---
let systemLogs = []; 
let activeProvisioningTasks = 0;
const provisioningQueue = []; 

// --- HELPERS ---
const logSystemEvent = (type, message, storeId = null) => {
    const entry = { id: Date.now(), timestamp: new Date().toISOString(), type, message, storeId };
    systemLogs.unshift(entry);
    if (systemLogs.length > 50) systemLogs.pop();
    
    try {
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
    } catch (err) {
        console.error("Audit Write Failed:", err);
    }
    console.log(`[${type}] ${message}`);
};

const runCommand = (command) => {
    return new Promise((resolve, reject) => {
        exec(command, { cwd: __dirname }, (error, stdout, stderr) => {
            if (error) { reject(error.message); return; }
            resolve(stdout || "");
        });
    });
};

// --- NEW SECURITY HELPERS (BETTER SECRET HANDLING) 🔐 ---
const generatePassword = () => {
    return Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8);
};

const createStoreSecret = async (storeId, password) => {
    const secretYaml = `
apiVersion: v1
kind: Secret
metadata:
  name: ${storeId}-admin-creds
  namespace: ${storeId}
type: Opaque
stringData:
  username: admin
  password: ${password}
`;
    const tempFile = path.join(__dirname, `secret_${storeId}.yaml`);
    fs.writeFileSync(tempFile, secretYaml);
    try {
        await runCommand(`kubectl apply -f "${tempFile}"`);
        fs.unlinkSync(tempFile);
        logSystemEvent('SUCCESS', `🔐 Secure Admin Secret created: ${storeId}-admin-creds`, storeId);
    } catch (err) {
        logSystemEvent('ERROR', `Secret creation failed: ${err}`, storeId);
    }
};

// --- SECURITY GUARDRAILS ---
const applyHardening = async (storeId) => {
    logSystemEvent('INFO', `🔒 Applying Security Forcefields...`, storeId);
    
    const quotaYaml = `
apiVersion: v1
kind: ResourceQuota
metadata:
  name: store-quota
  namespace: ${storeId}
spec:
  hard:
    pods: "10"
    requests.cpu: "1"
    requests.memory: "1Gi"
    limits.cpu: "2"
    limits.memory: "2Gi"
`;

    const netPolYaml = `
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: isolate-store
  namespace: ${storeId}
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  ingress:
  - from:
    - ipBlock:
        cidr: 0.0.0.0/0
`;

    const tempQuota = path.join(__dirname, `temp_quota_${storeId}.yaml`);
    const tempNetPol = path.join(__dirname, `temp_netpol_${storeId}.yaml`);

    try {
        fs.writeFileSync(tempQuota, quotaYaml);
        fs.writeFileSync(tempNetPol, netPolYaml);
        
        await runCommand(`kubectl apply -f "${tempQuota}"`);
        await runCommand(`kubectl apply -f "${tempNetPol}"`);
        
        fs.unlinkSync(tempQuota);
        fs.unlinkSync(tempNetPol);
        
        logSystemEvent('SUCCESS', `🛡️ Namespace Shielded (Quota + Firewall)`, storeId);
    } catch (err) {
        logSystemEvent('WARNING', `Hardening Warning: ${err}`, storeId);
    }
};

// --- THE CLOUD AUTOMATOR (UPDATED FOR SECRETS) ☁️ ---
const configureWordPress = async (storeId) => {
    logSystemEvent('INFO', `⏳ Waiting for Google Cloud resources...`, storeId);
    
    // 1. Wait for Pods
    try {
        await runCommand(`kubectl wait --for=condition=ready pod --all -n ${storeId} --timeout=300s`);
    } catch (e) { throw new Error("Pod timeout"); }

    const podNameRaw = await runCommand(`kubectl get pods -n ${storeId} --no-headers -o custom-columns=":metadata.name"`);
    const podName = podNameRaw.trim().split('\n')[0].trim(); 

    // 2. Wait for Public IP
    let publicUrl = "";
    let retries = 100; 
    while (retries > 0) {
        try {
            const json = await runCommand(`kubectl get svc -n ${storeId} gcp-shop-svc -o json`);
            const data = JSON.parse(json);
            const ip = data.status?.loadBalancer?.ingress?.[0]?.ip; 
            if (ip) {
                publicUrl = ip;
                break;
            }
        } catch (e) {}
        if (retries % 5 === 0) logSystemEvent('INFO', `⏳ Waiting for Public IP...`, storeId);
        await new Promise(r => setTimeout(r, 5000));
        retries--;
    }

    if (!publicUrl) throw new Error("GCP never gave us an IP.");
    logSystemEvent('SUCCESS', `🌍 Found Public IP: ${publicUrl}`, storeId);

    // 3. GENERATE SECURE PASSWORD & CREATE SECRET
    const adminPassword = generatePassword();
    await createStoreSecret(storeId, adminPassword);

    // 4. ACTIVE INSTALLATION
    logSystemEvent('INFO', `⚙️ Initializing Store Content...`, storeId);

    // Install WP-CLI
    try {
        await runCommand(`kubectl exec -n ${storeId} ${podName} -c wordpress -- /bin/bash -c "curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar && chmod +x wp-cli.phar && mv wp-cli.phar /usr/local/bin/wp"`);
    } catch (e) {}

    // Configure DB
    logSystemEvent('INFO', `🔌 Configuring Database (Waiting for MySQL)...`, storeId);
    await runCommand(`kubectl exec -n ${storeId} ${podName} -c wordpress -- /bin/bash -c "sleep 20"`);
    
    let dbSuccess = false;
    let dbRetries = 10;
    while (dbRetries > 0) {
        try {
            await runCommand(`kubectl exec -n ${storeId} ${podName} -c wordpress -- wp config create --dbname=wordpress --dbuser=wp_user --dbpass=wp_password --dbhost=127.0.0.1 --allow-root --force`);
            dbSuccess = true;
            break; 
        } catch (e) {
            logSystemEvent('WARNING', `MySQL not ready yet. Retrying in 5s...`, storeId);
            await new Promise(r => setTimeout(r, 5000)); 
            dbRetries--;
        }
    }

    if (!dbSuccess) throw new Error("Database never woke up.");

    let isInstalled = false;
    try {
        await runCommand(`kubectl exec -n ${storeId} ${podName} -c wordpress -- wp core is-installed --allow-root`);
        isInstalled = true;
    } catch(e) { isInstalled = false; }

    if (!isInstalled) {
        logSystemEvent('INFO', `🚀 Installing WooCommerce & Theme...`, storeId);
        // HERE IS THE CHANGE: We use ${adminPassword} instead of "password"
        await runCommand(`kubectl exec -n ${storeId} ${podName} -c wordpress -- wp core install --url="http://${publicUrl}" --title="${storeId}" --admin_user=admin --admin_password="${adminPassword}" --admin_email=admin@example.com --skip-email --allow-root`);
        await runCommand(`kubectl exec -n ${storeId} ${podName} -c wordpress -- wp plugin install woocommerce --activate --allow-root`);
        
        await runCommand(`kubectl exec -n ${storeId} ${podName} -c wordpress -- wp option update woocommerce_coming_soon no --allow-root`);
        await runCommand(`kubectl exec -n ${storeId} ${podName} -c wordpress -- wp wc tool run install_pages --user=admin --allow-root`);

        await runCommand(`kubectl exec -n ${storeId} ${podName} -c wordpress -- wp theme install storefront --activate --allow-root`);
        await runCommand(`kubectl exec -n ${storeId} ${podName} -c wordpress -- wp wc product create --name="Cloud Sneakers" --type=simple --regular_price=99 --user=admin --allow-root`);
    }

    // Final Polish
    try {
        logSystemEvent('INFO', `✨ Setting Homepage...`, storeId);
        await runCommand(`kubectl exec -n ${storeId} ${podName} -c wordpress -- wp option update show_on_front page --allow-root`);
        
        let shopId = "";
        let pageRetries = 10; 
        while (pageRetries > 0) {
            const shopIdRaw = await runCommand(`kubectl exec -n ${storeId} ${podName} -c wordpress -- wp post list --post_type=page --name=shop --field=ID --allow-root`);
            shopId = shopIdRaw.trim();
            if (shopId && shopId.length > 0) break; 
            await new Promise(r => setTimeout(r, 5000));
            pageRetries--;
        }

        if (shopId) {
            await runCommand(`kubectl exec -n ${storeId} ${podName} -c wordpress -- wp option update page_on_front ${shopId} --allow-root`);
            logSystemEvent('SUCCESS', `✅ Cloud Store Ready at http://${publicUrl}`, storeId);
            // LOG THE PASSWORD FOR DEMO VISIBILITY
            logSystemEvent('WARNING', `🔑 Admin Password: ${adminPassword}`, storeId);
        } else {
            logSystemEvent('WARNING', `Could not find Shop Page ID.`, storeId);
            logSystemEvent('SUCCESS', `✅ Cloud Store Ready at http://${publicUrl}`, storeId);
        }
    } catch (err) {
        logSystemEvent('WARNING', `Homepage config skipped: ${err}`, storeId);
        logSystemEvent('SUCCESS', `✅ Cloud Store Ready at http://${publicUrl}`, storeId);
    }
};

const processQueue = async () => {
    if (activeProvisioningTasks >= 2 || provisioningQueue.length === 0) return; 
    
    try {
        const currentStoresRaw = await runCommand('helm list -A -o json');
        const currentStores = JSON.parse(currentStoresRaw).length;
        if (currentStores >= MAX_STORES_TOTAL) {
             const failedTask = provisioningQueue.shift();
             logSystemEvent('ERROR', `⛔ Quota Exceeded. Max ${MAX_STORES_TOTAL} stores allowed.`, failedTask.storeId);
             processQueue();
             return;
        }
    } catch (e) {}

    const task = provisioningQueue.shift();
    activeProvisioningTasks++;
    const { storeId } = task;

    logSystemEvent('INFO', `⚡ Provisioning to Cloud: ${storeId}`, storeId);
    try {
        await runCommand(`helm install ${storeId} "${CHART_PATH}" -f "${VALUES_PATH}" --create-namespace --namespace ${storeId}`);
        await applyHardening(storeId);
        await configureWordPress(storeId);
    } catch (err) {
        logSystemEvent('ERROR', `Failed: ${err}`, storeId);
    } finally {
        activeProvisioningTasks--;
        processQueue(); 
    }
};

// --- ENDPOINTS ---

app.get('/api/logs', (req, res) => res.json(systemLogs));

app.get('/api/stores', async (req, res) => {
    try {
        const output = await runCommand('helm list -A -o json');
        const stores = JSON.parse(output);
        const enriched = await Promise.all(stores.map(async (store) => {
            try {
                const svcJson = await runCommand(`kubectl get svc -n ${store.name} gcp-shop-svc -o json`);
                const ip = JSON.parse(svcJson).status?.loadBalancer?.ingress?.[0]?.ip;
                return { ...store, accessUrl: ip ? `http://${ip}` : null };
            } catch (e) { return { ...store, accessUrl: null }; }
        }));
        res.json(enriched);
    } catch (err) { res.json([]); }
});

app.post('/api/stores', (req, res) => {
    const { storeName } = req.body;
    const storeId = storeName.toLowerCase().replace(/[^a-z0-9-]/g, '-'); 
    provisioningQueue.push({ storeId });
    res.json({ status: 'queued', storeId });
    processQueue();
});

app.delete('/api/stores/:id', async (req, res) => {
    const storeId = req.params.id;
    try {
        await runCommand(`helm uninstall ${storeId} --namespace ${storeId}`);
        await runCommand(`kubectl delete namespace ${storeId}`);
        await runCommand(`kubectl delete pvc --all -n ${storeId}`);
        logSystemEvent('SUCCESS', `Deleted ${storeId}`, storeId);
        res.json({ status: 'success' });
    } catch (err) { res.status(500).json({ message: err }); }
});

app.put('/api/stores/:id/upgrade', async (req, res) => {
    const storeId = req.params.id;
    logSystemEvent('INFO', `⬆️ Upgrading Store: ${storeId}...`, storeId);
    try {
        await runCommand(`helm upgrade ${storeId} "${CHART_PATH}" -f "${VALUES_PATH}" --namespace ${storeId}`);
        await applyHardening(storeId);
        logSystemEvent('SUCCESS', `✅ Upgrade Complete (Revision Bumped)`, storeId);
        res.json({ status: 'upgraded', storeId });
    } catch (err) {
        logSystemEvent('ERROR', `Upgrade Failed: ${err}`, storeId);
        res.status(500).json({ error: err });
    }
});

app.put('/api/stores/:id/rollback', async (req, res) => {
    const storeId = req.params.id;
    logSystemEvent('INFO', `Rewinding Time (Rollback): ${storeId}...`, storeId);
    try {
        await runCommand(`helm rollback ${storeId} 0 --namespace ${storeId}`);
        logSystemEvent('WARNING', `↩️ Rollback Successful. Reverted to previous version.`, storeId);
        res.json({ status: 'rolled_back', storeId });
    } catch (err) {
        logSystemEvent('ERROR', `Rollback Failed: ${err}`, storeId);
        res.status(500).json({ error: err });
    }
});

app.post('/api/stores/:id/domain', async (req, res) => {
    const storeId = req.params.id;
    const { domain } = req.body;
    
    logSystemEvent('INFO', `🔗 Linking Custom Domain: ${domain} to ${storeId}...`, storeId);
    
    try {
        await runCommand(`kubectl label namespace ${storeId} custom-domain=${domain} --overwrite`);
        logSystemEvent('SUCCESS', `✅ Domain Linked: https://${domain} -> ${storeId}`, storeId);
        res.json({ status: 'linked', domain });
    } catch (err) {
        logSystemEvent('ERROR', `Link Failed: ${err}`, storeId);
        res.status(500).json({ error: err });
    }
});

app.listen(PORT, () => console.log(`Cloud Orchestrator running on http://localhost:${PORT}`));