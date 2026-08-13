// 桌宠前端主应用：live2d 渲染 + 聊天 UI + WS 事件联动
import { Application } from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display';
import { DesktopClient } from './desktop-client.js';

const CONFIG = {
  wsUrl: (() => {
    const params = new URLSearchParams(location.search);
    return params.get('ws') || 'ws://192.168.2.108:8010/ws/desktop';
  })(),
  token: (() => {
    const params = new URLSearchParams(location.search);
    return params.get('token') || '';
  })(),
  model: 'models/PurpleBird/PurpleBird.model3.json',
};

const statusEl = document.getElementById('status');
const chatBox = document.getElementById('chat-box');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');

function log(msg) {
  console.log('[pet]', msg);
  if (statusEl) statusEl.textContent += '\n' + msg;
}

function setConn(ok, label) {
  connDot.className = 'dot ' + (ok ? 'green' : 'red');
  connText.textContent = label;
}

function addMessage(role, content) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = content;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
  return div;
}

// ---- live2d 渲染 ----
const app = new Application({
  view: document.getElementById('l2d-canvas'),
  autoStart: true,
  resizeTo: document.getElementById('stage'),
  transparent: true,
  antialias: true,
  backgroundAlpha: 0,
  preserveDrawingBuffer: true,
});

let model = null;
let currentEmotionEl = document.getElementById('current-emotion');

async function loadModel() {
  try {
    model = await Live2DModel.from(CONFIG.model, { autoInteract: false });
    model.anchor.set(0.5, 0.5);
    model.scale.set(0.086);
    model.position.set(app.screen.width / 2, app.screen.height / 2);
    app.stage.addChild(model);
    log('✅ 模型加载成功');

    // 待机呼吸
    let t = 0;
    app.ticker.add(() => {
      t += 0.02;
      if (model) model.position.y = app.screen.height / 2 + Math.sin(t) * 4;
    });
    return true;
  } catch (e) {
    log('❌ 模型加载失败: ' + e.message);
    return false;
  }
}

// ---- live2d 标签事件处理 ----
function handleLive2dEvent(method, payload) {
  if (!model) return;
  try {
    if (method === 'live2d.emotion') {
      const name = payload.emotion;
      currentEmotionEl.textContent = '😊 ' + name;
      // 尝试映射到模型表达式（白名单机制：模型里没有的忽略）
      try {
        const exprs = model.internalModel.settings.expressions || [];
        const found = exprs.find(e => e.name === name);
        if (found) model.expression(found.name);
      } catch { /* 忽略 */ }
    } else if (method === 'live2d.motion') {
      try { model.motion(payload.motion); } catch { /* 忽略 */ }
    } else if (method === 'live2d.pose') {
      currentEmotionEl.textContent = '🧍 ' + payload.pose;
    } else if (method === 'live2d.prop') {
      currentEmotionEl.textContent = '✨ ' + payload.prop;
    }
  } catch (e) {
    console.warn('live2d event error:', e);
  }
}

// ---- 聊天 ----
const client = new DesktopClient({
  url: CONFIG.wsUrl,
  token: CONFIG.token,
  clientType: 'web-pet',
  version: '0.1.0',
});

let streamMsgEl = null;
let streamText = '';

client.on('chat.stream.start', () => {
  streamText = '';
  streamMsgEl = addMessage('assistant', '');
});

client.on('chat.stream.chunk', (p) => {
  streamText += p.delta || '';
  if (streamMsgEl) streamMsgEl.textContent = streamText;
  chatBox.scrollTop = chatBox.scrollHeight;
});

client.on('chat.stream.end', () => {
  // 不置空 streamMsgEl：chat.message 会紧随其后补全内容并清理
});

client.on('chat.message', (p) => {
  // 若流式已展示则同步完整内容，否则直接显示
  if (streamMsgEl) streamMsgEl.textContent = p.content || '';
  else addMessage('assistant', p.content || '');
  streamMsgEl = null;
});

client.on('chat.thinking', (p) => {
  if (p && p.reason === 'progress') {
    if (!streamMsgEl) streamMsgEl = addMessage('assistant', '…');
    else if (streamMsgEl.textContent === '') streamMsgEl.textContent = '…';
  }
});

client.on('media.show', (p) => {
  if (p && p.media_type === 'voice' && (p.url || p.path)) {
    // 优先用 gateway 提供的完整 URL（PUBLIC_FILE_BASE），否则退回本地 /media 静态路径
    const audio = new Audio();
    audio.src = p.url || ('/media/' + p.path.replace(/^generated\//, ''));
    audio.play().catch(() => log('音频播放失败：' + audio.src));
  }
});

// live2d 事件
['live2d.emotion', 'live2d.motion', 'live2d.pose', 'live2d.prop', 'live2d.expression']
  .forEach(m => client.on(m, (p) => handleLive2dEvent(m, p)));

client.onConnect(() => {
  setConn(true, '已连接');
  log('✅ 已连接 gateway');
});

client.onDisconnect(() => {
  setConn(false, '已断开');
  log('⚠️ 连接断开');
});

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  addMessage('user', text);
  chatInput.value = '';
  try {
    await client.request('chat.stream', { content: text });
  } catch (e) {
    addMessage('assistant', '⚠️ 发送失败: ' + e.message);
  }
}

sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

// ---- 启动 ----
(async function init() {
  setConn(false, '连接中…');
  await loadModel();
  try {
    await client.connect();
  } catch (e) {
    setConn(false, '连接失败');
    log('❌ ' + e.message);
  }
})();
