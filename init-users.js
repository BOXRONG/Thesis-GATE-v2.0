'use strict';

const FabricCAServices = require('fabric-ca-client');
const { Wallets } = require('fabric-network');
const fs = require('fs');
const path = require('path');

async function main() {
    try {
        // 1. 設定憑證路徑與連線資訊
        const ccpPath = path.resolve(__dirname, '..', 'test-network', 'organizations', 'peerOrganizations', 'org1.example.com', 'connection-org1.json');
        const ccp = JSON.parse(fs.readFileSync(ccpPath, 'utf8'));
        const caURL = ccp.certificateAuthorities['ca.org1.example.com'].url;
        const ca = new FabricCAServices(caURL);

        const walletPath = path.resolve(__dirname, 'wallet');
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        console.log(`📂 錢包路徑設定於: ${walletPath}`);

        // 2. 以管理員身分 (admin) 登入以取得註冊權限
        const adminEnrollment = await ca.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
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
        await wallet.put('admin_temp', adminUser);
        
        const provider = wallet.getProviderRegistry().getProvider('X.509');
        const retrievedAdmin = await wallet.get('admin_temp');
        const adminIdentity = await provider.getUserContext(retrievedAdmin, 'admin');

        // 3. 定義你想在每次重啟後自動建立的常用測試身分
        const testUsers = [
            { id: 'student1', role: 'student' },
            { id: 'professor1', role: 'professor' },
            { id: 'director1', role: 'director' }
        ];

        for (const user of testUsers) {
            // 檢查錢包是否已經存在該身分
            const userIdentity = await wallet.get(user.id);
            if (userIdentity) {
                console.log(`ℹ️ 身分 ${user.id} 已經存在於錢包中，跳過註冊。`);
                continue;
            }

            // 向 CA 註冊新用戶並指定 ABAC 屬性 (role)
            const secret = await ca.register({
                enrollmentID: user.id,
                role: 'client',
                attrs: [{ name: 'role', value: user.role, ecert: true }]
            }, adminIdentity);

            // 取得憑證並存入錢包
            const enrollment = await ca.enroll({ enrollmentID: user.id, enrollmentSecret: secret });
            const identity = {
                credentials: { 
                    certificate: enrollment.certificate, 
                    privateKey: enrollment.key.toBytes() 
                },
                mspId: 'Org1MSP',
                type: 'X.509'
            };
            await wallet.put(user.id, identity);
            console.log(`✅ 成功自動註冊並核發身分：${user.id} (角色: ${user.role})`);
        }

        // 清除暫存的管理員身分
        await wallet.remove('admin_temp');
        console.log('🎉 所有預設測試身分初始化完成！');

    } catch (error) {
        console.error(`❌ 初始化失敗: ${error}`);
        process.exit(1);
    }
}

main();
