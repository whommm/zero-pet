// Desktop WS 客户端：照 live2dagent client.py 协议（request/response + 事件订阅）
// 本地工具能力（Tauri 版才有；浏览器预览返回"仅桌面版支持"）
export const LOCAL_TOOL_CAPABILITIES = [
  'desktop.open_app',
  'desktop.screenshot',
  'desktop.file',
  'desktop.clipboard',
  'desktop.notify',
];

export class DesktopClient {
  constructor({ url, token, clientType = 'web', version = '0.1.0' }) {
    this.url = url;
    this.token = token;
    this.clientType = clientType;
    this.version = version;
    this.ws = null;
    this._responseFutures = new Map(); // id -> {resolve, reject, timer}
    this._handlers = new Map();         // method -> [fn]
    this._onConnect = [];
    this._onDisconnect = [];
    this._requestSeq = 0;
    this._connected = false;
    this._heartbeatTimer = null;
  }

  // ---- 事件订阅 ----
  on(method, fn) {
    if (!this._handlers.has(method)) this._handlers.set(method, []);
    this._handlers.get(method).push(fn);
    return this;
  }

  onConnect(fn) { this._onConnect.push(fn); return this; }
  onDisconnect(fn) { this._onDisconnect.push(fn); return this; }

  get connected() { return this._connected; }

  // ---- 连接（含自动重连）----
  async connect() {
    this._manualClose = false;
    this._reconnectAttempt = 0;
    this._openSocket();
  }

  _openSocket() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = async () => {
      this._reconnectAttempt = 0;
      // 握手
      try {
        await this.request('client.hello', {
          token: this.token,
          protocol_version: 1,
          client_type: this.clientType,
          version: this.version,
          capabilities: LOCAL_TOOL_CAPABILITIES,
        }, 5000);
        this._connected = true;
        this._startHeartbeat();
        this._onConnect.forEach(fn => fn());
      } catch (e) {
        console.error('hello failed:', e);
        this.ws.close();
      }
    };
    this.ws.onmessage = (ev) => this._handleMessage(ev.data);
    this.ws.onclose = () => {
      this._connected = false;
      this._stopHeartbeat();
      // reject 所有挂起的请求
      this._responseFutures.forEach((f) => f.reject(new Error('connection closed')));
      this._responseFutures.clear();
      this._onDisconnect.forEach(fn => fn());
      this._scheduleReconnect();
    };
    this.ws.onerror = (e) => {
      console.error('ws error:', e);
      // 让 onclose 统一处理重连
      try { this.ws.close(); } catch { /* ignore */ }
    };
  }

  _scheduleReconnect() {
    if (this._manualClose) return;
    const delay = Math.min(30000, 1000 * Math.pow(2, this._reconnectAttempt));
    this._reconnectAttempt += 1;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (this._manualClose) return;
      try {
        this._openSocket();
      } catch (e) {
        console.error('reconnect failed:', e);
        this._scheduleReconnect();
      }
    }, delay);
  }

  // ---- 请求/响应 ----
  request(method, payload = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('not connected'));
        return;
      }
      const id = `req_${++this._requestSeq}_${Date.now()}`;
      const timer = setTimeout(() => {
        this._responseFutures.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeout);
      this._responseFutures.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ type: 'request', id, method, payload }));
    });
  }

  sendEvent(method, payload = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'event', method, payload }));
    }
  }

  // ---- 本地工具调用（服务器 → 桌宠）----
  async _handleToolCall(data) {
    const callId = data.id;
    const { tool, args } = data.payload || {};
    let result;
    try {
      result = await this._runLocalTool(tool, args || {});
      this._sendFrame({ type: 'response', id: callId, payload: result });
    } catch (e) {
      this._sendFrame({
        type: 'response', id: callId,
        payload: { ok: false, error: e.message || String(e) },
      });
    }
  }

  async _runLocalTool(tool, args) {
    // 写文件类操作先确认（安全策略）
    if (tool === 'desktop.file' && args.action === 'write') {
      const ok = window.confirm(`零想写入文件：\n${args.path}\n\n${(args.content || '').slice(0, 80)}…\n允许吗？`);
      if (!ok) return { ok: false, error: '用户拒绝了文件写入' };
    }
    const tauriInvoke = window.__TAURI__ && window.__TAURI__.invoke;
    if (!tauriInvoke) {
      // 浏览器预览模式：只有通知可用
      if (tool === 'desktop.notify') {
        try {
          // eslint-disable-next-line no-new
          new Notification(args.title || '零的桌宠', { body: args.body || '' });
          return { ok: true, note: '浏览器模式：通知已发送' };
        } catch (e) {
          return { ok: false, error: '浏览器模式通知失败（需授权）: ' + e.message };
        }
      }
      return { ok: false, error: '此工具仅桌面版（Tauri）支持，浏览器预览不可用' };
    }
    const map = {
      'desktop.open_app': ['local_open_app', { target: args.target, args: args.args || undefined }],
      'desktop.screenshot': ['local_screenshot', { full: args.full || false }],
      'desktop.file': ['local_file', { action: args.action, path: args.path, content: args.content ?? null }],
      'desktop.clipboard': ['local_clipboard', { action: args.action, content: args.content ?? null }],
      'desktop.notify': ['local_notify', { title: args.title || null, body: args.body || '' }],
    };
    const entry = map[tool];
    if (!entry) return { ok: false, error: '未知本地工具: ' + tool };
    return await tauriInvoke(entry[0], entry[1]);
  }

  _sendFrame(frame) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  // ---- 内部 ----
  _handleMessage(raw) {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (data.type === 'response' && data.id && this._responseFutures.has(data.id)) {
      const f = this._responseFutures.get(data.id);
      clearTimeout(f.timer);
      this._responseFutures.delete(data.id);
      if (data.payload && data.payload.error) {
        f.reject(new Error(data.payload.error));
      } else {
        f.resolve(data.payload || {});
      }
      return;
    }
    if (data.type === 'request' && data.method === 'desktop.tool_call') {
      // 服务器发来的本地工具调用：执行并回传结果
      this._handleToolCall(data);
      return;
    }
    if (data.type === 'event' && data.method) {
      (this._handlers.get(data.method) || []).forEach((fn) => {
        try { fn(data.payload || {}); } catch (e) { console.error('handler error:', e); }
      });
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      }
    }, 15000);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }

  close() {
    this._manualClose = true;
    clearTimeout(this._reconnectTimer);
    this._stopHeartbeat();
    if (this.ws) this.ws.close();
  }
}
