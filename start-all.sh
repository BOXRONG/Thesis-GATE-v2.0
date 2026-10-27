#!/bin/bash
set -e

# 設定顏色輸出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

# 設定路徑與參數變數 (若你的合約資料夾名稱不同，請修改 CC_PATH)
FABRIC_DIR="$HOME/fabric-samples/test-network"
API_DIR="$HOME/fabric-samples/thesis-gate-api"
CC_NAME="thesis-gate"
CC_PATH="../thesis-gate-chaincode"
CC_LANG="javascript"
CHANNEL_NAME="mychannel"

echo -e "${CYAN}======================================================${NC}"
echo -e "${CYAN}       🎓 Thesis-GATE v2.0 自動化啟動腳本             ${NC}"
echo -e "${CYAN}======================================================${NC}"

# 判斷是否帶入 --reset 參數，或者目前沒有正在運行的 Fabric 節點
if [ "$1" == "--reset" ] || [ -z "$(docker ps -q -f name=peer0.org1.example.com)" ]; then
    echo -e "\n${YELLOW}🔄 [模式：完整重置與部署] 準備重啟區塊鏈網路與智慧合約...${NC}"
    
    echo -e "\n${GREEN}[1/5] 關閉舊有區塊鏈網路並清理殘留容器...${NC}"
    cd "$FABRIC_DIR"
    ./network.sh down

    echo -e "\n${GREEN}[2/5] 啟動 Hyperledger Fabric 網路與 CA 憑證中心 (Channel: $CHANNEL_NAME)...${NC}"
    ./network.sh up createChannel -c "$CHANNEL_NAME" -ca

    echo -e "\n${GREEN}[3/5] 部署智慧合約 ($CC_NAME)...${NC}"
    if [ -d "$CC_PATH" ]; then
        ./network.sh deployCC -ccn "$CC_NAME" -ccp "$CC_PATH" -ccl "$CC_LANG"
    else
        echo -e "${RED}⚠️ 找不到智慧合約路徑：$CC_PATH${NC}"
        echo -e "${YELLOW}請確認你的合約資料夾名稱，並用 nano start-all.sh 修改 CC_PATH 變數！${NC}"
        exit 1
    fi

    echo -e "\n${GREEN}[4/5] 清空本地舊錢包憑證 (確保與新 CA 同步)...${NC}"
    rm -rf "$API_DIR/wallet/"*
    echo "✅ 舊錢包已清空，稍後啟動伺服器時將自動向 CA 註冊新憑證。"
else
    echo -e "\n${GREEN}⚡ [模式：快速啟動] 偵測到底層區塊鏈網路已在運行中，跳過重建步驟！${NC}"
    echo -e "${YELLOW}(提示：若想強制清空帳本並重新部署，請改用 ./start-all.sh --reset)${NC}"
fi

echo -e "\n${GREEN}[5/5] 準備啟動 Thesis-GATE API 伺服器...${NC}"
cd "$API_DIR"

# 自動釋放可能卡住的 3000 埠口
fuser -k 3000/tcp >/dev/null 2>&1 || true

# 自動抓取 172 開頭的 WSL 內部 IP (若無則取第一個 IP)
WSL_IP=$(hostname -I | tr ' ' '\n' | grep '^172\.' | head -n 1)
if [ -z "$WSL_IP" ]; then
    WSL_IP=$(hostname -I | awk '{print $1}')
fi

echo -e "${CYAN}======================================================${NC}"
echo -e "🌐 請在 Windows 瀏覽器輸入以下網址進入系統："
echo -e "👉 ${GREEN}http://${WSL_IP}:3000${NC}"
echo -e "${CYAN}======================================================${NC}\n"

# 啟動 Node.js 伺服器
node app.js
