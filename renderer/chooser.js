'use strict';
// chooser 页：Studio 自带 dsh 不可用时列出全部可用安装，由用户挑选
const list = document.getElementById('list');
const err = document.getElementById('err');

async function load() {
  err.textContent = '';
  list.innerHTML = '<p class="stage">正在扫描…</p>';
  let choices;
  try {
    choices = await window.dshDesktop.listDshChoices();
  } catch (e) {
    list.innerHTML = '';
    err.textContent = '扫描失败：' + e.message;
    return;
  }
  if (!choices || choices.length === 0) {
    list.innerHTML = '';
    err.textContent = '未检测到任何完整可用的 dsh 安装。请检查日志后重试。';
    return;
  }
  list.innerHTML = '';
  for (const c of choices) {
    const el = document.createElement('div');
    el.className = 'choice';
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = c.label;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = c.entry;
    info.appendChild(name);
    info.appendChild(meta);
    const ver = document.createElement('span');
    ver.className = 'ver';
    ver.textContent = c.version;
    el.appendChild(info);
    el.appendChild(ver);
    el.onclick = () => {
      el.style.opacity = '0.6';
      window.dshDesktop.selectDshChoice(c.entry);
    };
    list.appendChild(el);
  }
}

document.getElementById('back').onclick = load;
load();
