# 零的桌宠 · Zero Pet

**Live2D 桌宠 + AI 聊天**。桌面端（Tauri + Web 前端）通过 WebSocket 连接 QQ Bot Gateway，复用全部 AI 能力（模型、记忆、工具、TTS）。

## 架构

```
┌─────────────────┐   ws://<服务器IP>:8010/ws/desktop   ┌──────────────────┐
│  ZeroPet (Tauri)│ ───────────────────────────────────▶ │  pi-gateway       │
│  - live2d 渲染   │                                     │  - /ws/desktop 渠道│
│  - 聊天 UI       │  ◀───────────────────────────────────  - ConversationWorker
│  - WS 客户端     │    chat.stream.* / live2d.* / 语音     │  - 模型/记忆/工具/TTS
└─────────────────┘                                     └──────────────────┘
```

前端是纯 Web 应用（`index.html` + `src/`），浏览器直接可跑；`src-tauri/` 是 Windows 桌面壳。

## 快速开始

### 1. 浏览器预览（开发用）

```bash
npm install
npx vite --port 18791 --strictPort
# 打开 http://localhost:18791/?token=<PI_DESKTOP_TOKEN>
```

### 2. Windows 桌面应用（Tauri）

```bash
npm install
npx tauri dev    # 开发模式
npx tauri build  # 打包 exe/msi
```

### 3. 配置

| 配置 | 说明 |
| --- | --- |
| `PI_DESKTOP_TOKEN` | gateway `.env` 中的预共享 token（握手鉴权） |
| `ws` URL 参数 | 覆盖默认连接地址（默认 `ws://192.168.2.108:8010/ws/desktop`） |
| `token` URL 参数 | 覆盖默认 token |

## 通信协议

照 live2dagent 的 WS 协议：

- **请求**：`{"type":"request","method":"xxx","payload":{...}}` → 响应 `{"type":"response","id":...,"payload":{...}}`
- **事件**：服务器推送 `{"type":"event","method":"xxx","payload":{...}}`
- **握手**：连接后首帧发 `client.hello`（带 token + protocol_version）

### 方法

| 方法 | 方向 | 说明 |
| --- | --- | --- |
| `client.hello` | 客户端→服务器 | 握手鉴权 |
| `chat.stream` | 客户端→服务器 | 发消息（payload: content） |
| `live2d.state_report` | 客户端→服务器 | 状态上报（只读遥测） |

### 事件

| 事件 | 说明 |
| --- | --- |
| `chat.stream.start/chunk/end` | 流式回复 |
| `chat.message` | 完整回复 |
| `chat.thinking` | 思考/进度状态 |
| `live2d.emotion/motion/pose/prop/expression` | 桌宠表演控制（AI 回复带 `[emotion:x]` 等标签触发） |
| `media.show` | 语音/图片展示 |

## 模型

- 模型放 `models/` 目录（不入库，需手动放置）
- PurpleBird（紫羽）：标准 Cubism 5 格式（model3.json + moc3 + 4096 纹理）
- 必须使用 **Live2D 官方 Cubism 5 Core**（`public/assets/live2dcubismcore.min.js`），npm 旧包不支持 Cubism 5

## 状态

- ✅ M0：Web live2d 渲染验证（PurpleBird + 官方 Core）
- ✅ M1a：gateway `/ws/desktop` 渠道（握手/鉴权/管道/流式/标签/TTS）
- ✅ M1b：Web 前端（聊天 UI + live2d + 表情联动 + 语音）
- 🔨 M2：Tauri 壳（代码就绪，待 Windows 编译验证）
