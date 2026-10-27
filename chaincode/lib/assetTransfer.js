'use strict';

const { Contract } = require('fabric-contract-api');

class ThesisGateContract extends Contract {

    // ==================== 內部輔助與權限驗證函式 ====================

    // 1. 從 X.509 憑證中提取真實使用者帳號 (Common Name, CN)
    _getCallerId(ctx) {
        const fullId = ctx.clientIdentity.getID();
        const match = fullId.match(/CN=([^,/:]+)/);
        return match ? match[1] : fullId;
    }

    // 2. 取得呼叫者的憑證角色屬性 (role)
    _getCallerRole(ctx) {
        const role = ctx.clientIdentity.getAttributeValue('role');
        if (role) return role.toLowerCase();
        // 若為預設管理員憑證 (CN=admin)，自動識別為 admin 角色
        const callerId = this._getCallerId(ctx);
        if (callerId === 'admin') return 'admin';
        return '';
    }

    // 3. 讀取並解析論文資料
    async _getThesis(ctx, thesisId) {
        const thesisJSON = await ctx.stub.getState(thesisId);
        if (!thesisJSON || thesisJSON.length === 0) {
            throw new Error(`找不到論文 ${thesisId}，請確認論文 ID 是否正確。`);
        }
        return JSON.parse(thesisJSON.toString());
    }

    // 4. 檢查論文是否存在
    async ThesisExists(ctx, id) {
        const thesisJSON = await ctx.stub.getState(id);
        return thesisJSON && thesisJSON.length > 0;
    }

    // ==================== 核心交易函式 (NPD 6-Stage / 5-Gate) ====================

    // 交易 1：創建新論文（初始化 6-Stage / 5-Gate 結構 + SHA-256 指紋 + 綁定本人學號）
    async CreateThesis(ctx, id, title, studentId, advisorId, directorId, fileHash) {
        const callerId = this._getCallerId(ctx);
        const role = this._getCallerRole(ctx);

        if (role !== 'student') {
            throw new Error(`[ACL 權限拒絕] 只有學生可以建立論文（您目前的角色為：${role || '未定義'}，帳號：${callerId}）`);
        }

        if (callerId !== studentId) {
            throw new Error(`[ACL 身分不符] 您登入的憑證帳號 (${callerId}) 與表單填寫的學生學號 (${studentId}) 不一致，禁止代他人建立論文！`);
        }

        const exists = await this.ThesisExists(ctx, id);
        if (exists) {
            throw new Error(`論文 ${id} 已經存在，無法重複建立。`);
        }

        const thesis = {
            id,
            title,
            studentId,
            advisorId,
            directorId,
            fileHash: fileHash,
            currentStage: 1,
            isGatePhase: false,
            currentGate: 0,
            status: "STAGE_1_IN_PROGRESS",
            workReport: "",
            reviewComments: "",
            stageReports: ["", "", "", "", "", ""],
            gateComments: ["", "", "", "", ""],
            gateApprovals: [false, false, false, false, false],
            reassignmentLogs: [],
            isCompleted: false,
            lastUpdatedBy: callerId,
            docType: "thesis"
        };

        await ctx.stub.putState(id, Buffer.from(JSON.stringify(thesis)));
        return JSON.stringify(thesis);
    }

    // 交易 2：更新階段進度報告（嚴格限制：該論文綁定之學生本人 + 非審查期間）
    async UpdateThesisWork(ctx, thesisId, report) {
        const callerId = this._getCallerId(ctx);
        const role = this._getCallerRole(ctx);
        const thesis = await this._getThesis(ctx, thesisId);

        if (role !== 'student') {
            throw new Error(`[ACL 權限拒絕] 只有學生可以更新論文進度報告（教授與主任無權修改論文內容，您目前的角色為：${role}）`);
        }

        if (thesis.studentId !== callerId) {
            throw new Error(`[ACL 越權攔截] 權限不足！您 (${callerId}) 不是本篇論文 (${thesisId}) 的擁有者 (${thesis.studentId})，禁止修改他人論文進度！`);
        }

        if (thesis.isCompleted) {
            throw new Error(`論文已完成全數 6 個階段與 5 道關卡，無法再進行修改。`);
        }
        if (thesis.isGatePhase) {
            throw new Error(`論文目前正處於 Gate ${thesis.currentGate} 審查鎖定階段，請等待審查結果出爐後再更新報告。`);
        }

        const stageIdx = thesis.currentStage - 1;
        thesis.stageReports[stageIdx] = report;
        thesis.workReport = `[Stage ${thesis.currentStage}] ${report}`;
        thesis.status = `STAGE_${thesis.currentStage}_UPDATED`;
        thesis.lastUpdatedBy = callerId;

        await ctx.stub.putState(thesisId, Buffer.from(JSON.stringify(thesis)));
        return JSON.stringify(thesis);
    }

    // 交易 3：送交 Gate 關卡審查（嚴格限制：該論文綁定之學生本人 + 已填寫當前 Stage 報告）
    async SubmitToGate(ctx, thesisId) {
        const callerId = this._getCallerId(ctx);
        const role = this._getCallerRole(ctx);
        const thesis = await this._getThesis(ctx, thesisId);

        if (role !== 'student') {
            throw new Error(`[ACL 權限拒絕] 只有學生本人可以將論文送交關卡審查（您目前的角色為：${role}）`);
        }
        if (thesis.studentId !== callerId) {
            throw new Error(`[ACL 越權攔截] 您 (${callerId}) 不是本篇論文的作者 (${thesis.studentId})，無權將他人論文送審！`);
        }

        if (thesis.isCompleted) {
            throw new Error(`論文已完成全流程，無需重複送審。`);
        }
        if (thesis.isGatePhase) {
            throw new Error(`論文目前已在 Gate ${thesis.currentGate} 審查佇列中，請勿重複送審。`);
        }

        const stageIdx = thesis.currentStage - 1;
        if (!thesis.stageReports[stageIdx] || thesis.stageReports[stageIdx].trim() === '') {
            throw new Error(`[流程攔截] Stage ${thesis.currentStage} 的階段進度報告尚未填寫，請先執行步驟 2 更新進度後再送審！`);
        }

        if (thesis.currentStage === 6) {
            thesis.isCompleted = true;
            thesis.status = "COMPLETED (通過 6-Stage / 5-Gate 全流程)";
            thesis.lastUpdatedBy = callerId;
        } else {
            thesis.isGatePhase = true;
            thesis.currentGate = thesis.currentStage;
            thesis.status = `GATE_${thesis.currentGate}_PENDING_REVIEW`;
            thesis.lastUpdatedBy = callerId;
        }

        await ctx.stub.putState(thesisId, Buffer.from(JSON.stringify(thesis)));
        return JSON.stringify(thesis);
    }

    // 交易 4：執行關卡審查（依 Gate 1~5 動態區分指導教授與系主任權限，並驗證綁定名單）
    async ReviewGate(ctx, thesisId, approvedStr, comments) {
        const callerId = this._getCallerId(ctx);
        const role = this._getCallerRole(ctx);
        const thesis = await this._getThesis(ctx, thesisId);

        if (thesis.isCompleted) {
            throw new Error(`論文已完成全流程，無需再進行審查。`);
        }
        if (!thesis.isGatePhase) {
            throw new Error(`[流程攔截] 論文目前位於 Stage ${thesis.currentStage} 學生撰寫階段，尚未送交 Gate 審查。`);
        }

        const currentGate = thesis.currentGate;

        const gatePolicy = {
            1: { requiredRole: 'professor', expectedId: thesis.advisorId, title: '指導教授' },
            2: { requiredRole: 'professor', expectedId: thesis.advisorId, title: '指導教授' },
            3: { requiredRole: 'director',  expectedId: thesis.directorId, title: '系所主任' },
            4: { requiredRole: 'professor', expectedId: thesis.advisorId, title: '指導教授' },
            5: { requiredRole: 'director',  expectedId: thesis.directorId, title: '系所主任' }
        };

        const policy = gatePolicy[currentGate];

        if (role !== policy.requiredRole) {
            throw new Error(`[ACL 關卡權責攔截] Gate ${currentGate} 必須由「${policy.title} (${policy.requiredRole})」執行審核！您目前的角色為：${role}`);
        }

        if (callerId !== policy.expectedId) {
            throw new Error(`[ACL 指定委員攔截] Gate ${currentGate} 僅限本論文指定之${policy.title} (${policy.expectedId}) 審核，您 (${callerId}) 無權越權審批！`);
        }

        const approved = approvedStr === 'true';
        const gateIdx = currentGate - 1;

        thesis.gateComments[gateIdx] = `[${callerId}] ${comments}`;
        thesis.gateApprovals[gateIdx] = approved;
        thesis.reviewComments = `[Gate ${currentGate} - ${approved ? '通過' : '退回'} by ${callerId}] ${comments}`;
        thesis.lastUpdatedBy = callerId;

        if (approved) {
            thesis.isGatePhase = false;
            thesis.currentStage = currentGate + 1;
            thesis.currentGate = 0;
            thesis.status = `GATE_${currentGate}_APPROVED -> STAGE_${thesis.currentStage}_IN_PROGRESS`;
        } else {
            thesis.isGatePhase = false;
            thesis.status = `GATE_${currentGate}_REJECTED (退回 Stage ${thesis.currentStage} 修正)`;
        }

        await ctx.stub.putState(thesisId, Buffer.from(JSON.stringify(thesis)));
        return JSON.stringify(thesis);
    }

    // 交易 5：管理員例外介入 — 更換審查委員綁定 (ReassignReviewer)
    // 僅限 Admin 執行，解決委員缺席或綁定錯誤問題，同時保留完整稽核軌跡與後續委員簽章責任
    async ReassignReviewer(ctx, thesisId, newAdvisorId, newDirectorId, reason) {
        const callerId = this._getCallerId(ctx);
        const role = this._getCallerRole(ctx);

        if (role !== 'admin' && callerId !== 'admin') {
            throw new Error(`[ACL 權限拒絕] 只有系統管理員 (admin) 可以執行審查委員變更作業！您目前身分為：${callerId} (${role || '無角色'})`);
        }

        const thesis = await this._getThesis(ctx, thesisId);

        if (thesis.isCompleted) {
            throw new Error(`論文已完成全流程，無法再變更審查委員。`);
        }

        const oldAdvisor = thesis.advisorId;
        const oldDirector = thesis.directorId;

        const trimmedAdvisor = newAdvisorId ? newAdvisorId.trim() : '';
        const trimmedDirector = newDirectorId ? newDirectorId.trim() : '';

        if (!trimmedAdvisor && !trimmedDirector) {
            throw new Error(`請至少輸入一位新的指導教授 ID 或新的系所主任 ID！`);
        }

        if (trimmedAdvisor) {
            thesis.advisorId = trimmedAdvisor;
        }
        if (trimmedDirector) {
            thesis.directorId = trimmedDirector;
        }

        if (!thesis.reassignmentLogs) {
            thesis.reassignmentLogs = [];
        }

        const logEntry = `[Admin: ${callerId}] 變更委員 (指導教授: ${oldAdvisor}->${thesis.advisorId}, 主任: ${oldDirector}->${thesis.directorId}) | 原因: ${reason || '行政權限轉移'}`;
        thesis.reassignmentLogs.push(logEntry);
        thesis.reviewComments = logEntry;
        thesis.lastUpdatedBy = callerId;

        await ctx.stub.putState(thesisId, Buffer.from(JSON.stringify(thesis)));
        return JSON.stringify(thesis);
    }

    // ==================== 查詢與稽核函式 ====================

    async ReadThesis(ctx, thesisId) {
        const callerId = this._getCallerId(ctx);
        const role = this._getCallerRole(ctx);
        const thesis = await this._getThesis(ctx, thesisId);

        if (role === 'student' && thesis.studentId !== callerId) {
            throw new Error(`[ACL 隱私保護] 學生僅能查詢自己名下的論文！本篇論文屬於 ${thesis.studentId}，您 (${callerId}) 無權調閱。`);
        }

        return JSON.stringify(thesis);
    }

    async GetAllTheses(ctx) {
        const allResults = [];
        const iterator = await ctx.stub.getStateByRange('', '');
        let result = await iterator.next();

        while (!result.done) {
            const strValue = Buffer.from(result.value.value.toString('utf8')).toString('utf8');
            try {
                const record = JSON.parse(strValue);
                allResults.push(record);
            } catch (err) {
                console.log(err);
            }
            result = await iterator.next();
        }
        return JSON.stringify(allResults);
    }

    async GetThesisHistory(ctx, thesisId) {
        const allResults = [];
        const iterator = await ctx.stub.getHistoryForKey(thesisId);
        let result = await iterator.next();

        while (!result.done) {
            const strValue = Buffer.from(result.value.value.toString('utf8')).toString('utf8');
            let record;
            try {
                record = JSON.parse(strValue);
            } catch (err) {
                record = strValue;
            }
            allResults.push({
                TxId: result.value.txId,
                Timestamp: result.value.timestamp,
                IsDelete: result.value.isDelete,
                Record: record
            });
            result = await iterator.next();
        }
        return JSON.stringify(allResults);
    }
}

module.exports = ThesisGateContract;
