
'use strict';

const { Contract } = require('fabric-contract-api');

class ThesisGateContract extends Contract {
  // 新增交易：查詢系統內所有論文 (供 Director 或前端列表使用)
    async GetAllTheses(ctx) {
        const allResults = [];
        const iterator = await ctx.stub.getStateByRange('', '');
        let result = await iterator.next()

        while (!result.done) {
            const strValue = Buffer.from(result.value.value.toString('utf8')).toString('utf8');
            let record;
            try {
                record = JSON.parse(strValue);
                if (record.docType === 'thesis') {
                    allResults.push(record);
                }
            } catch (err) {
                console.log(err);
            }
            result = await iterator.next();
        }
        return JSON.stringify(allResults);
    }

    async function CreateThesis(ctx, id, title, studentId, advisorId, directorId, fileHash) {
    // 檢查論文是否已存在
    const exists = await this.ThesisExists(ctx, id);
    if (exists) {
        throw new Error(`論文 ${id} 已經存在`);
    }

    const thesis = {
        id,
        title,
        studentId,
        advisorId,
        directorId,
        fileHash: fileHash, // 👈 記錄檔案的 SHA-256 數位指紋
        status: "DRAFT",    // 初始狀態為草稿
        workReport: ""
    };

    // 寫入區塊鏈世界狀態
    await ctx.stub.PutState(id, Buffer.from(JSON.stringify(thesis)));
}

    // 新增交易：查詢單筆論文的完整變更歷史 (發揮區塊鏈稽核特性)
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

    // 輔助函式：從 Fabric Gateway / gRPC 錯誤中萃取合約拋出的真實原因
    function getDetailedErrorMessage(error) {
    let message = error.message;
    // 如果 gRPC 錯誤帶有詳細的 peer 拒絕資訊
    if (error.details && Array.isArray(error.details)) {
        const details = error.details.map(d => d.message || JSON.stringify(d)).join('; ');
        if (details) {
            message = `${message}\n合約防護網細節：${details}`;
        }
    }
    return message;
}
    // 輔助函式：取得並解析論文
    async _getThesis(ctx, thesisId) {
        const thesisJSON = await ctx.stub.getState(thesisId);

        if (!thesisJSON || thesisJSON.length === 0) {
            throw new Error(`論文 ${thesisId} 不存在。`);
        }

        return JSON.parse(thesisJSON.toString());
    }

    // 輔助函式：身分驗證（ABAC）
    _checkRole(ctx, requiredRole) {
        const role = ctx.clientIdentity.getAttributeValue('role');

        if (role !== requiredRole) {
            throw new Error(`權限不足：需要 ${requiredRole} 身份。`);
        }
    }

    // 交易：讀取單筆論文狀態
    async ReadThesis(ctx, thesisId) {
        const thesis = await this._getThesis(ctx, thesisId);

        // === 實作 ACL：StudentReadOwnThesis ===
        const role = ctx.clientIdentity.getAttributeValue('role');
        const clientId = ctx.clientIdentity.getID();

        if (role === 'Student' && thesis.Student !== clientId) {
            throw new Error('權限不足：學生只能讀取自己的論文。');
        }

        return JSON.stringify(thesis);
    }

    // 初始化／創建一篇新論文
    async CreateThesis(
        ctx,
        thesisId,
        title,
        studentId,
        advisorId,
        directorId
    ) {
        // 避免覆蓋既有論文
        const existing = await ctx.stub.getState(thesisId);
        if (existing && existing.length > 0) {
            throw new Error(`論文 ${thesisId} 已存在，無法重複建立。`);
        }

        const thesis = {
            ID: thesisId,
            Title: title,
            CurrentStage: 1,
            IsGatePhase: false,
            CurrentGate: 0,
            StageReports: ['', '', '', '', '', ''],
            GateComments: ['', '', '', '', ''],
            GateApprovals: [false, false, false, false, false],
            IsCompleted: false,
            Student: studentId,
            Advisor: advisorId,
            Director: directorId,
            docType: 'thesis'
        };

        await ctx.stub.putState(
            thesisId,
            Buffer.from(JSON.stringify(thesis))
        );

        return JSON.stringify(thesis);
    }

    // 交易：UpdateThesisWork
    async UpdateThesisWork(ctx, thesisId, report) {
        // 正式部署時應啟用角色及資源擁有權驗證
        // this._checkRole(ctx, 'Student');

        const thesis = await this._getThesis(ctx, thesisId);

        if (thesis.IsCompleted) {
            throw new Error('論文已完成全流程，無法再更新。');
        }

        if (thesis.IsGatePhase) {
            throw new Error('論文目前處於 Gate 審查階段，無法更新 Stage 報告。');
        }

        const stageIdx = thesis.CurrentStage - 1;
        thesis.StageReports[stageIdx] = report;

        await ctx.stub.putState(
            thesisId,
            Buffer.from(JSON.stringify(thesis))
        );

        const eventPayload = {
            thesisId,
            stage: thesis.CurrentStage,
            updatedBy: ctx.clientIdentity.getID()
        };

        ctx.stub.setEvent(
            'StageUpdated',
            Buffer.from(JSON.stringify(eventPayload))
        );
    }

    // 交易：SubmitToGate
    async SubmitToGate(ctx, thesisId) {
        // this._checkRole(ctx, 'Student');

       const role = ctx.clientIdentity.getAttributeValue('role');
       if (role !== 'student') {
       throw new Error(`權限拒絕：只有學生可以送交審查。你的憑證角色是 ${role || '未定義'}`);
       }

        const thesis = await this._getThesis(ctx, thesisId);

        if (thesis.IsCompleted) {
            throw new Error('論文已完成全流程。');
        }

        if (thesis.IsGatePhase) {
            throw new Error('論文已在 Gate 審查中，無法重複送審。');
        }

        const stageIdx = thesis.CurrentStage - 1;

        if (
            !thesis.StageReports[stageIdx] ||
            thesis.StageReports[stageIdx].trim() === ''
        ) {
            throw new Error(
                `Stage ${thesis.CurrentStage} 的進度報告尚未填寫。`
            );
        }

        if (thesis.CurrentStage === 6) {
            thesis.IsCompleted = true;

            await ctx.stub.putState(
                thesisId,
                Buffer.from(JSON.stringify(thesis))
            );

            ctx.stub.setEvent(
                'ThesisCompleted',
                Buffer.from(JSON.stringify({ thesisId }))
            );
        } else {
            thesis.IsGatePhase = true;
            thesis.CurrentGate = thesis.CurrentStage;

            await ctx.stub.putState(
                thesisId,
                Buffer.from(JSON.stringify(thesis))
            );

            ctx.stub.setEvent(
                'ThesisAdvanced',
                Buffer.from(JSON.stringify({
                    thesisId,
                    newStage: thesis.CurrentStage,
                    isGatePhase: true
                }))
            );
        }
    }

    // 交易：ReviewGate
    async ReviewGate(ctx, thesisId, approvedStr, comments) {
        const role = ctx.clientIdentity.getAttributeValue('role');
        if (role !== 'professor') {
        throw new Error(`權限拒絕：只有教授可以執行審核。你的憑證角色是 ${role || '未定義'}`);
        }
        const thesis = await this._getThesis(ctx, thesisId);

        if (thesis.IsCompleted) {
            throw new Error('論文已完成，無需審查。');
        }

        if (!thesis.IsGatePhase) {
            throw new Error('論文目前不在 Gate 審查階段。');
        }

        const approved = approvedStr === 'true';

        const gateRoles = {
            1: 'Checker',
            2: 'Professor',
            3: 'Director',
            4: 'Professor',
            5: 'Director'
        };

        // 正式部署時應啟用角色驗證
        // this._checkRole(ctx, gateRoles[thesis.CurrentGate]);

        const gateIdx = thesis.CurrentGate - 1;

        thesis.GateComments[gateIdx] = comments;
        thesis.GateApprovals[gateIdx] = approved;

        let eventName = 'GateReviewed';
        let eventPayload = {
            thesisId,
            gate: thesis.CurrentGate,
            approved,
            reviewedBy: ctx.clientIdentity.getID()
        };

        if (approved) {
            thesis.IsGatePhase = false;
            thesis.CurrentStage = thesis.CurrentGate + 1;
            thesis.CurrentGate = 0;

            eventName = 'ThesisAdvanced';
            eventPayload = {
                thesisId,
                newStage: thesis.CurrentStage,
                isGatePhase: false
            };
        }

        await ctx.stub.putState(
            thesisId,
            Buffer.from(JSON.stringify(thesis))
        );

        ctx.stub.setEvent(
            eventName,
            Buffer.from(JSON.stringify(eventPayload))
        );
    }

    // 交易：AdvanceThesis
    async AdvanceThesis(ctx, thesisId) {
        // this._checkRole(ctx, 'Director');

        const thesis = await this._getThesis(ctx, thesisId);

        if (thesis.IsCompleted) {
            throw new Error('論文已完成，無需推進。');
        }

        if (thesis.IsGatePhase) {
            thesis.IsGatePhase = false;
            thesis.CurrentStage = thesis.CurrentGate + 1;
            thesis.CurrentGate = 0;
        } else {
            if (thesis.CurrentStage >= 6) {
                thesis.IsCompleted = true;

                await ctx.stub.putState(
                    thesisId,
                    Buffer.from(JSON.stringify(thesis))
                );

                ctx.stub.setEvent(
                    'ThesisCompleted',
                    Buffer.from(JSON.stringify({ thesisId }))
                );

                return;
            } else {
                thesis.IsGatePhase = true;
                thesis.CurrentGate = thesis.CurrentStage;
            }
        }

        await ctx.stub.putState(
            thesisId,
            Buffer.from(JSON.stringify(thesis))
        );

        ctx.stub.setEvent(
            'ThesisAdvanced',
            Buffer.from(JSON.stringify({
                thesisId,
                newStage: thesis.CurrentStage,
                isGatePhase: thesis.IsGatePhase
            }))
        );
    }
}

module.exports = ThesisGateContract;

