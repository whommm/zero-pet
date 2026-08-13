// Desktop WS 客户端：照 live2dagent client.py 协议（request/response + 事件订阅）
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

  // ---- 连接 ----
  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = async () => {
      // 握手
      try {
        await this.request('client.hello', {
          token: this.token,
          protocol_version: 1,
          client_type: this.clientType,
          version: this.version,
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
    };
    this.ws.onerror = (e) => console.error('ws error:', e);
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
    this._stopHeartbeat();
    if (this.ws) this.ws.close();
  }
}
