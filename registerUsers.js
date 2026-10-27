const { Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const fs = require('fs');
const path = require('path');

async function main() {
    try {
        // 1. 解析 test-network 的網路設定檔，連線至 Org1 CA
        const ccpPath = path.resolve(__dirname, '..', 'test-network', 'organizations', 'peerOrganizations', 'org1.example.com', 'connection-org1.json');
        const ccp = JSON.parse(fs.readFileSync(ccpPath, 'utf8'));
        const caURL = ccp.certificateAuthorities['ca.org1.example.com'].url;
        const ca = new FabricCAServices(caURL);

        // 2. 建立本地錢包目錄 (存放憑證用)
        const walletPath = path.join(__dirname, 'wallet');
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        console.log(`錢包路徑設定為: ${walletPath}`);

        // 3. 註冊系統管理員 (Admin) 作為發證人
        const enrollment = await ca.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
        const x509Identity = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() },
            mspId: 'Org1MSP',
            type: 'X.509',
        };
        await wallet.put('admin', x509Identity);
        
        // 取得 Admin 操作物件
        const adminUser = await wallet.get('admin');
        const provider = wallet.getProviderRegistry().getProvider(adminUser.type);
        const adminIdentity = await provider.getUserContext(adminUser, 'admin');
        console.log('✅ Admin 憑證領取成功');

        // 4. 核發學生憑證 (帶有 role=student 屬性，ecert: true 代表將屬性寫入憑證內)
        const studentSecret = await ca.register({
            enrollmentID: 'S1110001',
            role: 'client',
            attrs: [{ name: 'role', value: 'student', ecert: true }]
        }, adminIdentity);
        const studentEnrollment = await ca.enroll({ enrollmentID: 'S1110001', enrollmentSecret: studentSecret });
        await wallet.put('S1110001', {
            credentials: { certificate: studentEnrollment.certificate, privateKey: studentEnrollment.key.toBytes() },
            mspId: 'Org1MSP', type: 'X.509',
        });
        console.log('✅ 學生 S1110001 憑證核發成功');

        // 5. 核發教授憑證 (帶有 role=professor 屬性)
        const profSecret = await ca.register({
            enrollmentID: 'P99001',
            role: 'client',
            attrs: [{ name: 'role', value: 'professor', ecert: true }]
        }, adminIdentity);
        const profEnrollment = await ca.enroll({ enrollmentID: 'P99001', enrollmentSecret: profSecret });
        await wallet.put('P99001', {
            credentials: { certificate: profEnrollment.certificate, privateKey: profEnrollment.key.toBytes() },
            mspId: 'Org1MSP', type: 'X.509',
        });
        console.log('✅ 教授 P99001 憑證核發成功');

    } catch (error) {
        console.error(`❌ 發生錯誤: ${error}`);
    }
}

main();
