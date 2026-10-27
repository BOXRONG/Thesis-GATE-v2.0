'use strict';

const express = require('express');
const app = express();
const path = require('path');

// 讓 public 資料夾成為靜態網頁伺服器，直接透過 http://localhost:3000 存取前端網頁
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const FabricCAServices = require('fabric-ca-client');
const cors = require('cors');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const { Wallets } = require('fabric-network');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');

const channelName = 'mychannel';
const chaincodeName = 'thesis-gate';

// 保留 TLS 憑證路徑，用於建立與 Peer 的安全連線
const cryptoPath = path.resolve(__dirname, '..', 'test-network', 'organizations', 'peerOrganizations', 'org1.example.com');
const tlsCertPath = path.resolve(cryptoPath, 'peers', 'peer0.org1.example.com', 'tls', 'ca.crt');
const peerEndpoint = 'localhost:7051';
const peerHostAlias = 'peer0.org1.example.com';

// 設定本地錢包資料夾路徑
const walletPath = path.resolve(__dirname, 'wallet');

let grpcClient;
const upload = multer({ storage: multer.memoryStorage() });

// 動態取得錢包內所有可用身分的 API
app.get('/api/users', async (req, res) => {
    try {
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        const identities = await wallet.list(); // 列出錢包裡所有的身分名稱
        res.json(identities);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/register-user', async (req, res) => {
    let gateway;
    try {
        const { enrollmentId, role, adminPassword } = req.body; 
        if (!enrollmentId || !role || !adminPassword) {
            return res.status(400).json({ error: '請完整填寫新成員 ID、角色以及管理員密碼' });
        }

        // 1. 取得 Org1 CA 連線資訊
        const ccpPath = path.resolve(__dirname, '..', 'test-network', 'organizations', 'peerOrganizations', 'org1.example.com', 'connection-org1.json');
        const ccp = JSON.parse(fs.readFileSync(ccpPath, 'utf8'));
        const caURL = ccp.certificateAuthorities['ca.org1.example.com'].url;
        const ca = new FabricCAServices(caURL);

        // 2. 嚴格資安驗證：直接向 CA 驗證管理員密碼是否正確！
        let adminEnrollment;
        try {
            adminEnrollment = await ca.enroll({ enrollmentID: 'admin', enrollmentSecret: adminPassword });
        } catch (err) {
            return res.status(403).json({ error: '發卡失敗：管理員密碼錯誤，拒絕授權。' });
        }

        // 3. 取得經過 CA 驗證的 admin 身分 context 并存入錢包
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        
        const privKeyBytes = typeof adminEnrollment.key.toBytes === 'function' 
            ? adminEnrollment.key.toBytes() 
            : Buffer.from(adminEnrollment.key.toString());

        const adminUser = {
            credentials: { 
                certificate: adminEnrollment.certificate, 
                privateKey: privKeyBytes 
            },
            mspId: 'Org1MSP',
            type: 'X.509'
        };
        await wallet.put('admin', adminUser);
        
        const provider = wallet.getProviderRegistry().getProvider('X.509');
        const retrievedAdmin = await wallet.get('admin');
        const adminIdentity = await provider.getUserContext(retrievedAdmin, 'admin');

        // 4. 向 CA 註冊新用戶並指定屬性 (ABAC)
        const secret = await ca.register({
            enrollmentID: enrollmentId,
            role: 'client',
            attrs: [{ name: 'role', value: role, ecert: true }]
        }, adminIdentity);

        // 5. 替新用戶進行 enrollment 取得憑證並存入錢包
        const enrollment = await ca.enroll({ enrollmentID: enrollmentId, enrollmentSecret: secret });
        const userIdentity = {
            credentials: { 
                certificate: enrollment.certificate, 
                privateKey: enrollment.key.toBytes() 
            },
            mspId: 'Org1MSP',
            type: 'X.509'
        };
        await wallet.put(enrollmentId, userIdentity);

        res.json({ message: `成功為 ${enrollmentId} 核發憑證！角色屬性：${role}` });
    } catch (error) {
        res.status(500).json({ error: formatError(error) });
    }
});

// 1. 初始化共用的底層 gRPC 連線通道
async function initGrpcClient() {
    const tlsRootCert = await fs.promises.readFile(tlsCertPath);
    const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
    grpcClient = new grpc.Client(peerEndpoint, tlsCredentials, {
        'grpc.ssl_target_name_override': peerHostAlias,
    });
    console.log('✅ gRPC 連線通道已建立');
}

// 2. 核心功能：依據傳入的 userId，動態讀取錢包並建立專屬合約操作物件
async function getContractByUser(userId) {
    const identityPath = path.join(walletPath, `${userId}.id`);
    if (!fs.existsSync(identityPath)) {
        throw new Error(`找不到使用者 ${userId} 的憑證，請先確認是否已執行核發腳本。`);
    }

    const idData = JSON.parse(await fs.promises.readFile(identityPath, 'utf8'));
    const cert = Buffer.from(idData.credentials.certificate);
    const key = crypto.createPrivateKey(idData.credentials.privateKey);

    const identity = { mspId: idData.mspId, credentials: cert };
    const signer = signers.newPrivateKeySigner(key);

    const gateway = connect({
        client: grpcClient,
        identity: identity,
        signer: signer
    });

    const network = gateway.getNetwork(channelName);
    return { gateway, contract: network.getContract(chaincodeName) };
}

function getUserId(req) {
    return req.headers['x-user-id'] || 'admin';
}

function formatError(error) {
    if (error.details && Array.isArray(error.details) && error.details.length > 0) {
        const detailMsgs = error.details.map(d => d.message || JSON.stringify(d)).join(' | ');
        return `區塊鏈拒絕執行 (Endorsement Failed):\n${detailMsgs}`;
    }
    return error.message || String(error);
}

const utf8Decoder = new TextDecoder();

app.get('/api/thesis/:id', async (req, res) => {
    let gateway;
    try {
        const conn = await getContractByUser(getUserId(req));
        gateway = conn.gateway;
        const resultBytes = await conn.contract.evaluateTransaction('ReadThesis', req.params.id);
        res.json(JSON.parse(utf8Decoder.decode(resultBytes)));
    } catch (error) {
        res.status(500).json({ error: formatError(error) });
    } finally {
        if (gateway) gateway.close();
    }
});

app.get('/api/thesis/:id/history', async (req, res) => {
    let gateway;
    try {
        const conn = await getContractByUser(getUserId(req));
        gateway = conn.gateway;
        const resultBytes = await conn.contract.evaluateTransaction('GetThesisHistory', req.params.id);
        res.json(JSON.parse(utf8Decoder.decode(resultBytes)));
    } catch (error) {
        res.status(500).json({ error: formatError(error) });
    } finally {
        if (gateway) gateway.close();
    }
});

// 支援檔案上傳與自動計算 SHA-256 雜湊值的創建論文 API
app.post('/api/thesis', upload.single('thesisFile'), async (req, res) => {
    let gateway;
    try {
        const conn = await getContractByUser(getUserId(req));
        gateway = conn.gateway;
        
        const { id, title, studentId, advisorId, directorId } = req.body;
        
        if (!req.file) {
            return res.status(400).json({ error: '請上傳論文 Word 檔案以產生數位指紋' });
        }

        const fileBuffer = req.file.buffer;
        const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

        await conn.contract.submitTransaction('CreateThesis', id, title, studentId, advisorId, directorId, fileHash);
        
        res.json({ 
            message: `論文 ${id} 創建成功！`, 
            fileHash: fileHash 
        });
    } catch (error) {
        res.status(500).json({ error: formatError(error) });
    } finally {
        if (gateway) gateway.close();
    }
});

app.put('/api/thesis/:id/work', async (req, res) => {
    let gateway;
    try {
        const conn = await getContractByUser(getUserId(req));
        gateway = conn.gateway;
        const { report } = req.body;
        await conn.contract.submitTransaction('UpdateThesisWork', req.params.id, report);
        res.json({ message: `論文 ${req.params.id} 進度更新成功` });
    } catch (error) {
        res.status(500).json({ error: formatError(error) });
    } finally {
        if (gateway) gateway.close();
    }
});

app.post('/api/thesis/:id/submit', async (req, res) => {
    let gateway;
    try {
        const conn = await getContractByUser(getUserId(req));
        gateway = conn.gateway;
        await conn.contract.submitTransaction('SubmitToGate', req.params.id);
        res.json({ message: `論文 ${req.params.id} 已送交審查` });
    } catch (error) {
        res.status(500).json({ error: formatError(error) });
    } finally {
        if (gateway) gateway.close();
    }
});

app.post('/api/thesis/:id/review', async (req, res) => {
    let gateway;
    try {
        const conn = await getContractByUser(getUserId(req));
        gateway = conn.gateway;
        const { approved, comments } = req.body;
        await conn.contract.submitTransaction('ReviewGate', req.params.id, String(approved), comments);
        res.json({ message: `論文 ${req.params.id} 審查完成` });
    } catch (error) {
        res.status(500).json({ error: formatError(error) });
    } finally {
        if (gateway) gateway.close();
    }
});

// 自動檢查並建立預設測試身分的函式
async function ensureDefaultUsers() {
    try {
        const ccpPath = path.resolve(__dirname, '..', 'test-network', 'organizations', 'peerOrganizations', 'org1.example.com', 'connection-org1.json');
        if (!fs.existsSync(ccpPath)) return;

        const ccp = JSON.parse(fs.readFileSync(ccpPath, 'utf8'));
        const caURL = ccp.certificateAuthorities['ca.org1.example.com'].url;
        const ca = new FabricCAServices(caURL);

        const wallet = await Wallets.newFileSystemWallet(walletPath);

        const adminEnrollment = await ca.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
        const privKeyBytes = typeof adminEnrollment.key.toBytes === 'function' 
            ? adminEnrollment.key.toBytes() 
            : Buffer.from(adminEnrollment.key.toString());

        // 永久將 admin 憑證存入錢包，供前端選單與發卡中心使用
        await wallet.put('admin', {
            credentials: { certificate: adminEnrollment.certificate, privateKey: privKeyBytes },
            mspId: 'Org1MSP',
            type: 'X.509'
        });
        
        const provider = wallet.getProviderRegistry().getProvider('X.509');
        const retrievedAdmin = await wallet.get('admin');
        const adminIdentity = await provider.getUserContext(retrievedAdmin, 'admin');

        const testUsers = [
            { id: 'student1', role: 'student' },
            { id: 'S1129915', role: 'student' },
            { id: 'professor1', role: 'professor' },
            { id: 'director1', role: 'director' }
        ];

        for (const user of testUsers) {
            const exists = await wallet.get(user.id);
            if (!exists) {
                let secret;
                try {
                    secret = await ca.register({
                        enrollmentID: user.id,
                        role: 'client',
                        attrs: [{ name: 'role', value: user.role, ecert: true }]
                    }, adminIdentity);
                } catch (regErr) {
                    if (regErr.message && regErr.message.includes('already registered')) {
                        console.log(`ℹ️ [自動初始化] 身分 ${user.id} 在 CA 端已存在，略過註冊。`);
                        continue;
                    }
                    throw regErr;
                }

                const enrollment = await ca.enroll({ enrollmentID: user.id, enrollmentSecret: secret });
                await wallet.put(user.id, {
                    credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() },
                    mspId: 'Org1MSP',
                    type: 'X.509'
                });
                console.log(`✨ [自動初始化] 已建立預設身分：${user.id} (${user.role})`);
            }
        }
    } catch (err) {
        console.log('ℹ️ 區塊鏈網路尚未啟動或身分已存在，略過自動初始化。', err.message);
    }
}

const PORT = 3000;
app.listen(PORT, '0.0.0.0', async () => {
    await initGrpcClient();
    await ensureDefaultUsers();
    console.log(`🚀 Thesis-GATE API 伺服器已啟動於 http://localhost:${PORT}`);
});
