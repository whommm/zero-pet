import { Application } from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display';

const statusEl = document.getElementById('status');
function log(msg) {
  console.log('[spike]', msg);
  statusEl.textContent += '\n' + msg;
}

const app = new Application({
  view: document.createElement('canvas'),
  autoStart: true,
  resizeTo: document.getElementById('container'),
  resolution: window.devicePixelRatio || 1,
  transparent: true,
  antialias: true,
  backgroundAlpha: 0,
  preserveDrawingBuffer: true,
});
document.getElementById('container').appendChild(app.view);

log('PIXI ' + app.renderer.type + ' 初始化完成');

try {
  log('对照测试：加载官方 shizuku 模型');
  try {
    const ref = await Live2DModel.from(
      'https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display/test/assets/shizuku/shizuku.model.json',
      { autoInteract: false }
    );
    log('✅ 官方模型加载成功（core 正常）');
    ref.destroy();
  } catch (e) {
    log('❌ 官方模型也失败: ' + e.message);
  }

  log('开始加载 PurpleBird.model3.json');
  const model = await Live2DModel.from(
    '/models/PurpleBird/PurpleBird.model3.json',
    { autoInteract: false }
  );
  log('✅ 模型加载成功');

  model.anchor.set(0.5, 0.5);
  // 模型原始 7200x8400，完整显示在 1280x720 内 → scale ≈ 720/8400 ≈ 0.086
  model.scale.set(0.086);
  log('缩放: 0.086 (模型原始 ' + model.width.toFixed(0) + 'x' + model.height.toFixed(0) + ')');
  model.position.set(app.screen.width / 2, app.screen.height / 2);
  app.stage.addChild(model);

  // 呼吸动画
  let t = 0;
  app.ticker.add(() => {
    t += 0.02;
    model.position.y = app.screen.height / 2 + Math.sin(t) * 6;
  });

  // 触发动作
  try {
    const motions = model.internalModel.settings.motions;
    log('可用动作组: ' + (motions ? Object.keys(motions).join(', ') : '无'));
    if (motions && Object.keys(motions).length > 0) {
      const firstGroup = Object.keys(motions)[0];
      model.motion(firstGroup);
      log('已触发动作: ' + firstGroup);
    }
  } catch (e) {
    log('动作测试: ' + e.message);
  }

  // 触发表情
  try {
    const exprs = model.internalModel.settings.expressions;
    log('可用表情: ' + (exprs ? exprs.map(e => e.name).join(', ') : '无'));
    if (exprs && exprs.length > 0) {
      model.expression(exprs[0].name);
      log('已触发表情: ' + exprs[0].name);
    }
  } catch (e) {
    log('表情测试: ' + e.message);
  }

  log('✅ 渲染完成，等待截图');
} catch (err) {
  log('❌ 加载失败: ' + err.message);
  log('堆栈: ' + (err.stack || '').split('\n').slice(0, 5).join('\n'));
}

// 截图导出：把 canvas 转 PNG base64 POST 到本地接收服务
window.__exportShot = async function () {
  try {
    const c = document.querySelector('canvas');
    if (!c) return 'no canvas';
    const dataUrl = c.toDataURL('image/png');
    const res = await fetch('/save', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: dataUrl,
    });
    return 'export: ' + res.status;
  } catch (e) {
    return 'export fail: ' + e.message;
  }
};
