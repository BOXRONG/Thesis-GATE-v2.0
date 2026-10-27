'use strict';

const { Contract } = require('fabric-contract-api');

class ThesisGateContract extends Contract {
    
    // 1. 創建新論文（已修正：移除錯誤的 function 關鍵字）
    async CreateThesis(ctx, id, title, studentId, advisorId, directorId, fileHash) {
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
            fileHash: fileHash,
            status: "DRAFT",
            workReport: ""
        };
        await ctx.stub.putState(id, Buffer.from(JSON.stringify(thesis)));
    }

    // 2. 檢查論文是否存在
    async ThesisExists(ctx, id) {
        const thesisJSON = await ctx.stub.getState(id);
        return thesisJSON && thesisJSON.length > 0;
    }

    // 3. 查詢系統內所有論文
    async GetAllTheses(ctx) {
        const allResults = [];
        const iterator = await ctx.stub.getStateByRange('', '');
        let result = await iterator.next();

        while (!result.done) {
            const strValue = Buffer.from(result.value.value.toString('utf8')).toString('utf8');
            let record;
            try {
                record = JSON.parse(strValue);
                allResults.push(record);
            } catch (err) {
                console.log(err);
            }
            result = await iterator.next();
        }
        return JSON.stringify(allResults);
    }

    // 4. 查詢單筆論文的完整變更歷史
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

    // 5. 輔助函式：取得並解析論文
    async _getThesis(ctx, thesisId) {
        const thesisJSON = await ctx.stub.getState(thesisId);

        if (!thesisJSON || thesisJSON.length === 0) {
            throw new Error(`論文 ${thesisId} 不存在。`);
        }

        return JSON.parse(thesisJSON.toString());
    }

    // 6. 交易：讀取單筆論文狀態
    async ReadThesis(ctx, thesisId) {
        const thesis = await this._getThesis(ctx, thesisId);
        return JSON.stringify(thesis);
    }

    // 7. 交易：UpdateThesisWork
    async UpdateThesisWork(ctx, thesisId, report) {
        const thesis = await this._getThesis(ctx, thesisId);
        thesis.workReport = report;

        await ctx.stub.putState(
            thesisId,
            Buffer.from(JSON.stringify(thesis))
        );
    }

    // 8. 交易：SubmitToGate
    async SubmitToGate(ctx, thesisId) {
        const role = ctx.clientIdentity.getAttributeValue('role');
        if (role !== 'student') {
            throw new Error(`權限拒絕：只有學生可以送交審查。你的憑證角色是 ${role || '未定義'}`);
        }

        const thesis = await this._getThesis(ctx, thesisId);
        thesis.status = "SUBMITTED";

        await ctx.stub.putState(
            thesisId,
            Buffer.from(JSON.stringify(thesis))
        );
    }

    // 9. 交易：ReviewGate
    async ReviewGate(ctx, thesisId, approvedStr, comments) {
        const role = ctx.clientIdentity.getAttributeValue('role');
        if (role !== 'professor') {
            throw new Error(`權限拒絕：只有教授可以執行審核。你的憑證角色是 ${role || '未定義'}`);
        }

        const thesis = await this._getThesis(ctx, thesisId);
        const approved = approvedStr === 'true';

        thesis.status = approved ? "APPROVED" : "REJECTED";
        thesis.reviewComments = comments;

        await ctx.stub.putState(
            thesisId,
            Buffer.from(JSON.stringify(thesis))
        );
    }
}

module.exports = ThesisGateContract;
